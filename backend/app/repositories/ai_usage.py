"""Model-usage ledger: ``ai_usage`` rows plus the counters that enforce the caps (NFR-18).

``ai_usage`` (migration 0004) holds provider, model, prompt version, token counts, cost (null =
unknown), status and a quota record, and deliberately NO account, plan or text (D17). The
per-account daily counter therefore cannot live in that table: the ledger keeps it in a separate
private structure that is never part of a row.

Two implementations:

- ``InMemoryUsageLedger`` (memory mode): rows and counters in process memory.
- ``PostgresUsageLedger`` (supabase mode): every row is written through ``srv_record_ai_usage``
  over the restricted login role ``QATRA_SERVER_DB`` (``qatra_server`` may execute that function
  and read no table). No database function reads ``ai_usage`` back, so the counters of the caps
  (whole deployment per day and per minute, and per account per day) are kept in process memory
  as in memory mode: one Render instance (D48, D72), reset by a restart. A failed write is logged
  by event name only and never fails the learner's turn; the in-process counters still count it.

Requests that count against the caps are those that reached the provider's completion endpoint
(statuses ``succeeded``, ``failed``, ``timed_out``); ``rules_fallback`` rows do not.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID

import psycopg

from app.logging_config import log_event

logger = logging.getLogger("qatra.ai_usage")

COUNTED_STATUSES = frozenset({"succeeded", "failed", "timed_out"})
VALID_STATUSES = COUNTED_STATUSES | {"rules_fallback"}
CONNECT_TIMEOUT_SEC = 5
STATEMENT_TIMEOUT = "5s"


@dataclass(frozen=True, slots=True)
class UsageRecord:
    """One ``ai_usage`` row. No learner text, no account id."""

    provider: str
    model: str
    prompt_version: str
    status: str
    created_at: datetime
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    quota_record: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class UsageCounts:
    global_day: int
    global_minute: int
    account_day: int


class UsageLedger(Protocol):
    def record(self, entry: UsageRecord, *, account: UUID | None = None) -> None:
        """Write one row. ``account`` feeds the private per-account counter only."""

    def counts(self, account: UUID, now: datetime) -> UsageCounts:
        """Counted requests: today (UTC) and last minute overall, and today for ``account``."""


class InMemoryUsageLedger:
    def __init__(self) -> None:
        self.rows: list[UsageRecord] = []
        self._account_hits: dict[UUID, deque[datetime]] = defaultdict(deque)
        self._lock = threading.Lock()

    def record(self, entry: UsageRecord, *, account: UUID | None = None) -> None:
        if entry.status not in VALID_STATUSES:
            raise ValueError("invalid ai_usage status")
        with self._lock:
            self.rows.append(entry)
            if account is not None and entry.status in COUNTED_STATUSES:
                self._account_hits[account].append(entry.created_at)
            self._purge(entry.created_at)

    def _purge(self, now: datetime) -> None:
        cutoff = now - timedelta(days=2)
        while self.rows and self.rows[0].created_at < cutoff:
            self.rows.pop(0)
        for hits in self._account_hits.values():
            while hits and hits[0] < cutoff:
                hits.popleft()

    def counts(self, account: UUID, now: datetime) -> UsageCounts:
        now = now.astimezone(UTC)
        day = now.date()
        minute_start = now - timedelta(minutes=1)
        with self._lock:
            counted = [r for r in self.rows if r.status in COUNTED_STATUSES]
            global_day = sum(1 for r in counted if r.created_at.astimezone(UTC).date() == day)
            global_minute = sum(1 for r in counted if minute_start < r.created_at <= now)
            account_day = sum(
                1 for t in self._account_hits.get(account, ()) if t.astimezone(UTC).date() == day
            )
        return UsageCounts(global_day, global_minute, account_day)


class PostgresUsageLedger:
    """Rows through ``srv_record_ai_usage``; counters in process memory (see the module note)."""

    def __init__(self, dsn: str | None, *, counters: InMemoryUsageLedger | None = None) -> None:
        self._dsn = dsn
        self._counters = counters or InMemoryUsageLedger()

    def __repr__(self) -> str:
        return "PostgresUsageLedger(<redacted>)"

    def record(self, entry: UsageRecord, *, account: UUID | None = None) -> None:
        # The counters first: a cap must hold even when the database write fails.
        self._counters.record(entry, account=account)
        self._store(entry)

    def counts(self, account: UUID, now: datetime) -> UsageCounts:
        return self._counters.counts(account, now)

    def _store(self, entry: UsageRecord) -> None:
        if not self._dsn:
            log_event(logger, "ai_usage_not_stored", level=logging.WARNING, kind="not_configured")
            return
        quota = None if entry.quota_record is None else json.dumps(entry.quota_record)
        cost = None if entry.cost_usd is None else Decimal(str(entry.cost_usd))
        try:
            # ``set local`` keeps the timeout inside this transaction (works behind a pooler);
            # ``prepare_threshold=None`` keeps statements unprepared for the same reason.
            with psycopg.connect(
                self._dsn, connect_timeout=CONNECT_TIMEOUT_SEC, prepare_threshold=None
            ) as connection:
                connection.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
                connection.execute(
                    "select public.srv_record_ai_usage(%s::text, %s::text, %s::text, %s::integer, "
                    "%s::integer, %s::numeric, %s::text, %s::jsonb)",
                    (
                        entry.provider,
                        entry.model,
                        entry.prompt_version,
                        entry.input_tokens,
                        entry.output_tokens,
                        cost,
                        entry.status,
                        quota,
                    ),
                )
        except Exception:
            # The library error is dropped: its text can include the host or the user name.
            log_event(logger, "ai_usage_write_failed", level=logging.WARNING)
