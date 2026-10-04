"""Model-usage ledger: ``ai_usage`` rows plus the counters that enforce the caps (NFR-18).

``ai_usage`` (migration 0004) holds provider, model, prompt version, token counts, cost (null =
unknown), status and a quota record, and deliberately NO account, plan or text (D17). The
per-account daily counter therefore cannot live in that table: this in-memory ledger keeps it
in a separate private structure that is never part of a row. The Supabase implementation writes
rows through ``srv_record_ai_usage`` and derives the global counters from ``ai_usage``; the
per-account counter stays in process memory (single Render instance, D48/D72) unless a later
package adds a store for it.

Requests that count against the caps are those that reached the provider's completion endpoint
(statuses ``succeeded``, ``failed``, ``timed_out``); ``rules_fallback`` rows do not.
"""

from __future__ import annotations

import threading
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

COUNTED_STATUSES = frozenset({"succeeded", "failed", "timed_out"})
VALID_STATUSES = COUNTED_STATUSES | {"rules_fallback"}


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
