"""Learner-state access for session preparation (package B5): open and read sessions, and read the
mastery, coverage evidence, attempt history and activity that composition needs.

``LearningRepository`` has two implementations:

- ``InMemoryLearningStore`` (memory mode): one thread-safe object holding sessions, attempts,
  activity intervals, mastery, part evidence and daily progress. It mirrors ``app_open_session``
  (an atomic get-or-create for the daily session) and is written so that package B6 can add its
  ``apply_events`` to the same store: the row types and the ``put_*`` helpers are the shapes of
  ``app_apply_events``.
- ``PostgrestLearningRepository`` (supabase mode): PostgREST as the learner (the access token as
  ``Authorization: Bearer``, so row-level security applies). A new session is committed through the
  ``app_open_session`` function (Database-schema §8.3); everything else is a read, except
  ``mark_completed``, which sets ``status`` (a column the learner may update, §5.2 item 5).

Every method takes the caller's ``SessionContext`` and returns only the caller's rows. Errors are
mapped as in ``repositories/bank.py`` (``unavailable``, ``unauthenticated``, ``not_found``, and
``version_conflict`` for the function's ``QT002``).

Time-based reads: ``last_active_date`` is the latest learning date with verified activity
(``daily_progress.active_ms > 0``), the input of the absence rule (R07).
"""

from __future__ import annotations

import copy
import threading
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime
from typing import Any, Final, Protocol
from uuid import UUID

import httpx

from app.config import Settings
from app.dependencies import SessionContext
from app.domain.learning_state import (
    ActivityInterval,
    AttemptRecord,
    DailyProgressRow,
    PartEvidence,
    PassageMastery,
    require_date,
    require_datetime,
)
from app.errors import AppError, ErrorCode
from app.repositories.bank import PostgrestGateway, chunks, in_filter, parse_or_internal

# The newest attempts of a set of passages that composition looks at (recency and last type).
ATTEMPT_LIMIT: Final = 500
OPEN_STATUSES: Final = ("prepared", "open")


@dataclass(frozen=True, slots=True)
class NewSession:
    """A session to persist. ``steps`` is the snapshot as JSON (camelCase, as served) and is never
    changed afterwards; ``plan_version`` is kept next to ``plan_version_id`` for memory mode."""

    session_id: UUID
    kind: str
    plan_id: UUID | None
    plan_version_id: UUID | None
    plan_version: int | None
    edition_id: UUID
    learning_date: date
    lesson_refs: tuple[UUID, ...]
    question_refs: tuple[UUID, ...]
    steps: list[dict[str, Any]]
    bank_version: int
    created_at: datetime
    self_rating: str | None = None


@dataclass(frozen=True, slots=True)
class StoredSession:
    """One ``learning_sessions`` row (plus the plan version's number)."""

    id: UUID
    user_id: UUID
    plan_id: UUID | None
    plan_version_id: UUID | None
    plan_version: int | None
    edition_id: UUID
    kind: str
    learning_date: date
    lesson_refs: tuple[UUID, ...]
    question_refs: tuple[UUID, ...]
    steps: list[dict[str, Any]]
    bank_version: int
    status: str
    created_at: datetime
    self_rating: str | None = None
    elapsed_ms: int = 0
    offline_snapshot_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class OpenedSession:
    """Result of ``open_session``: ``created`` is false when an open daily session of the date
    already existed and is returned instead (E20 answers 200)."""

    session_id: UUID
    created: bool


class LearningRepository(Protocol):
    def open_session(self, ctx: SessionContext, new: NewSession) -> OpenedSession:
        """Insert an ``open`` session. For ``kind = daily`` this is an atomic get-or-create over
        ``(user, learning date)`` among open server-side daily sessions; ``game`` and ``placement``
        always insert. May raise ``version_conflict`` (the plan moved) or ``not_found``."""

    def read_session(self, ctx: SessionContext, session_id: UUID) -> StoredSession | None:
        """The caller's session, or ``None`` (unknown and foreign are indistinguishable)."""

    def find_open_daily(self, ctx: SessionContext, learning_date: date) -> StoredSession | None:
        """The caller's open server-side daily session of that date, if any."""

    def mark_completed(self, ctx: SessionContext, session_id: UUID) -> None:
        """Set ``completed`` on an owned prepared or open session. E20 uses it only to retire the
        leftover daily session of another plan; completing a session for the learner is E22 (B6)."""

    def mastery_for_plan(self, ctx: SessionContext, plan_id: UUID) -> dict[UUID, PassageMastery]:
        """The plan's ``target_mastery`` rows by passage id."""

    def covered_parts(self, ctx: SessionContext, plan_id: UUID) -> frozenset[UUID]:
        """Ids of the parts with coverage evidence in the plan."""

    def attempts_for_passages(
        self, ctx: SessionContext, passage_ids: Sequence[UUID]
    ) -> list[AttemptRecord]:
        """The newest attempts on those passages (at most ``ATTEMPT_LIMIT``), newest first."""

    def last_active_date(self, ctx: SessionContext, on_or_before: date) -> date | None:
        """The latest learning date up to ``on_or_before`` with verified activity."""


# --- memory mode ----------------------------------------------------------------------------------


class InMemoryLearningStore:
    """Thread-safe memory-mode store. Data lives for the process only. Public attributes hold the
    raw rows for tests and for B6's ``apply_events``; the ``put_*`` helpers seed them."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.sessions: dict[UUID, StoredSession] = {}
        self.attempts: list[AttemptRecord] = []
        self.intervals: list[ActivityInterval] = []
        self.mastery: dict[tuple[UUID, UUID, UUID], PassageMastery] = {}  # user, plan, passage
        self.evidence: dict[tuple[UUID, UUID, UUID], PartEvidence] = {}  # user, plan, part
        self.daily_progress: dict[tuple[UUID, date], DailyProgressRow] = {}

    @property
    def lock(self) -> threading.RLock:
        """Held by writers (B6) for a whole multi-row change, as the database does in one call."""
        return self._lock

    # -- writes used by B6 and by tests ------------------------------------------------------

    def put_mastery(self, user_id: UUID, row: PassageMastery) -> None:
        if row.violations():  # the database would refuse these rows too
            raise ValueError("mastery row breaks a CHECK constraint")
        with self._lock:
            self.mastery[(user_id, row.plan_id, row.passage_id)] = row

    def put_evidence(self, user_id: UUID, evidence: PartEvidence) -> None:
        with self._lock:
            self.evidence.setdefault((user_id, evidence.plan_id, evidence.part_id), evidence)

    def put_attempt(self, attempt: AttemptRecord) -> None:
        with self._lock:
            self.attempts.append(attempt)

    def put_daily_progress(self, row: DailyProgressRow) -> None:
        with self._lock:
            self.daily_progress[(row.user_id, row.learning_date)] = row

    # -- LearningRepository ------------------------------------------------------------------

    def open_session(self, ctx: SessionContext, new: NewSession) -> OpenedSession:
        with self._lock:
            if new.kind == "daily":
                existing = self._open_daily(ctx.user_id, new.learning_date)
                if existing is not None:
                    return OpenedSession(existing.id, False)
            if new.session_id in self.sessions:
                raise AppError(ErrorCode.unavailable)  # a repeated id is a caller bug
            self.sessions[new.session_id] = StoredSession(
                id=new.session_id,
                user_id=ctx.user_id,
                plan_id=new.plan_id,
                plan_version_id=new.plan_version_id,
                plan_version=new.plan_version,
                edition_id=new.edition_id,
                kind=new.kind,
                learning_date=new.learning_date,
                lesson_refs=new.lesson_refs,
                question_refs=new.question_refs,
                steps=copy.deepcopy(new.steps),
                bank_version=new.bank_version,
                status="open",
                created_at=new.created_at,
                self_rating=new.self_rating,
            )
            return OpenedSession(new.session_id, True)

    def _open_daily(self, user_id: UUID, learning_date: date) -> StoredSession | None:
        found = [
            s
            for s in self.sessions.values()
            if s.user_id == user_id
            and s.kind == "daily"
            and s.learning_date == learning_date
            and s.status in OPEN_STATUSES
            and s.offline_snapshot_id is None
        ]
        return max(found, key=lambda s: s.created_at, default=None)

    def read_session(self, ctx: SessionContext, session_id: UUID) -> StoredSession | None:
        with self._lock:
            session = self.sessions.get(session_id)
            if session is None or session.user_id != ctx.user_id:
                return None
            return replace(session, steps=copy.deepcopy(session.steps))

    def find_open_daily(self, ctx: SessionContext, learning_date: date) -> StoredSession | None:
        with self._lock:
            session = self._open_daily(ctx.user_id, learning_date)
            return None if session is None else replace(session, steps=copy.deepcopy(session.steps))

    def mark_completed(self, ctx: SessionContext, session_id: UUID) -> None:
        with self._lock:
            session = self.sessions.get(session_id)
            if session is not None and session.user_id == ctx.user_id:
                if session.status in OPEN_STATUSES:
                    self.sessions[session_id] = replace(session, status="completed")

    def mastery_for_plan(self, ctx: SessionContext, plan_id: UUID) -> dict[UUID, PassageMastery]:
        with self._lock:
            return {
                row.passage_id: row
                for (user, plan, _), row in self.mastery.items()
                if user == ctx.user_id and plan == plan_id
            }

    def covered_parts(self, ctx: SessionContext, plan_id: UUID) -> frozenset[UUID]:
        with self._lock:
            return frozenset(
                part
                for (user, plan, part) in self.evidence
                if user == ctx.user_id and plan == plan_id
            )

    def attempts_for_passages(
        self, ctx: SessionContext, passage_ids: Sequence[UUID]
    ) -> list[AttemptRecord]:
        wanted = set(passage_ids)
        with self._lock:
            mine = [a for a in self.attempts if a.user_id == ctx.user_id and a.passage_id in wanted]
        return sorted(mine, key=lambda a: a.created_at, reverse=True)[:ATTEMPT_LIMIT]

    def last_active_date(self, ctx: SessionContext, on_or_before: date) -> date | None:
        with self._lock:
            return max(
                (
                    row.learning_date
                    for (user, _), row in self.daily_progress.items()
                    if user == ctx.user_id
                    and row.active_ms > 0
                    and row.learning_date <= on_or_before
                ),
                default=None,
            )


# --- PostgREST ------------------------------------------------------------------------------------

_SESSION_COLUMNS = (
    "id,user_id,plan_id,plan_version_id,edition_id,kind,learning_date,lesson_refs,question_refs,"
    "steps,bank_version,self_rating,status,elapsed_ms,offline_snapshot_id,created_at"
)
_MASTERY_COLUMNS = (
    "plan_id,passage_id,status,consecutive_correct,initial_success_at,initial_learning_date,"
    "review_stage,next_review_due,last_review_date,confirmed_at,first_confirmed_at,"
    "maintenance_stage,lapse_count,error_part_ids"
)
_ATTEMPT_COLUMNS = (
    "id,session_id,edition_id,client_event_id,question_id,passage_id,correct,assisted,error_kind,"
    "wrong_token_ref,review_round_id,duration_ms,occurred_at,created_at"
)


def _uuid_or_none(value: Any) -> UUID | None:
    return None if value is None else UUID(str(value))


class PostgrestLearningRepository:
    """Supabase-mode learner state through PostgREST as the learner (row-level security)."""

    def __init__(self, gateway: PostgrestGateway, *, in_chunk: int = 40) -> None:
        self._rest = gateway
        self._chunk = max(1, in_chunk)  # ids per ``in.(...)`` filter

    @classmethod
    def from_settings(
        cls, settings: Settings, *, client: httpx.Client | None = None
    ) -> PostgrestLearningRepository:
        return cls(PostgrestGateway.from_settings(settings, client=client))

    def __repr__(self) -> str:
        return "PostgrestLearningRepository(<redacted>)"

    def open_session(self, ctx: SessionContext, new: NewSession) -> OpenedSession:
        result = self._rest.rpc(
            ctx,
            "app_open_session",
            {
                "p_kind": new.kind,
                "p_plan_id": None if new.plan_id is None else str(new.plan_id),
                "p_plan_version_id": (
                    None if new.plan_version_id is None else str(new.plan_version_id)
                ),
                "p_phase_id": None,
                "p_edition_id": str(new.edition_id),
                "p_learning_date": new.learning_date.isoformat(),
                "p_lesson_refs": [str(ref) for ref in new.lesson_refs],
                "p_question_refs": [str(ref) for ref in new.question_refs],
                "p_steps": new.steps,
                "p_bank_version": new.bank_version,
                "p_self_rating": new.self_rating,
                "p_session_id": str(new.session_id),
            },
        )
        # ``returns table`` comes back as a one-element array (an object is tolerated).
        row = result[0] if isinstance(result, list) and result else result
        return parse_or_internal(
            lambda: OpenedSession(
                session_id=UUID(str(row["session_id"])), created=bool(row["created"])
            )
        )

    def _session(self, ctx: SessionContext, row: dict[str, Any]) -> StoredSession:
        plan_version: int | None = None
        if row.get("plan_version_id") is not None:
            versions = self._rest.get(
                ctx,
                "plan_versions",
                {"id": f"eq.{row['plan_version_id']}", "select": "version_no"},
            )
            plan_version = (
                parse_or_internal(lambda: int(versions[0]["version_no"])) if versions else None
            )

        def build() -> StoredSession:
            created_at = require_datetime(row["created_at"])
            learning_date = require_date(row["learning_date"])
            steps = row["steps"]
            if not isinstance(steps, list):
                raise ValueError("steps must be an array")
            return StoredSession(
                id=UUID(str(row["id"])),
                user_id=UUID(str(row["user_id"])),
                plan_id=_uuid_or_none(row.get("plan_id")),
                plan_version_id=_uuid_or_none(row.get("plan_version_id")),
                plan_version=plan_version,
                edition_id=UUID(str(row["edition_id"])),
                kind=str(row["kind"]),
                learning_date=learning_date,
                lesson_refs=tuple(UUID(str(r)) for r in row.get("lesson_refs") or ()),
                question_refs=tuple(UUID(str(r)) for r in row.get("question_refs") or ()),
                steps=steps,
                bank_version=int(row["bank_version"]),
                status=str(row["status"]),
                created_at=created_at,
                self_rating=row.get("self_rating"),
                elapsed_ms=int(row.get("elapsed_ms") or 0),
                offline_snapshot_id=_uuid_or_none(row.get("offline_snapshot_id")),
            )

        return parse_or_internal(build)

    def read_session(self, ctx: SessionContext, session_id: UUID) -> StoredSession | None:
        rows = self._rest.get(
            ctx,
            "learning_sessions",
            {
                "id": f"eq.{session_id}",
                "user_id": f"eq.{ctx.user_id}",
                "select": _SESSION_COLUMNS,
            },
        )
        return self._session(ctx, rows[0]) if rows else None

    def find_open_daily(self, ctx: SessionContext, learning_date: date) -> StoredSession | None:
        rows = self._rest.get(
            ctx,
            "learning_sessions",
            {
                "user_id": f"eq.{ctx.user_id}",
                "kind": "eq.daily",
                "learning_date": f"eq.{learning_date.isoformat()}",
                "status": in_filter(OPEN_STATUSES),
                "offline_snapshot_id": "is.null",
                "order": "created_at.desc",
                "limit": "1",
                "select": _SESSION_COLUMNS,
            },
        )
        return self._session(ctx, rows[0]) if rows else None

    def mark_completed(self, ctx: SessionContext, session_id: UUID) -> None:
        self._rest.patch(
            ctx,
            "learning_sessions",
            {
                "id": f"eq.{session_id}",
                "user_id": f"eq.{ctx.user_id}",
                "status": in_filter(OPEN_STATUSES),
            },
            {"status": "completed"},
        )

    def mastery_for_plan(self, ctx: SessionContext, plan_id: UUID) -> dict[UUID, PassageMastery]:
        rows = self._rest.get_all(
            ctx,
            "target_mastery",
            {"plan_id": f"eq.{plan_id}", "select": _MASTERY_COLUMNS, "order": "passage_id.asc"},
        )
        found = [parse_or_internal(lambda row=row: PassageMastery.from_row(row)) for row in rows]
        return {row.passage_id: row for row in found}

    def covered_parts(self, ctx: SessionContext, plan_id: UUID) -> frozenset[UUID]:
        rows = self._rest.get_all(
            ctx,
            "target_part_evidence",
            {"plan_id": f"eq.{plan_id}", "select": "part_id", "order": "part_id.asc"},
        )
        return frozenset(
            parse_or_internal(lambda row=row: UUID(str(row["part_id"]))) for row in rows
        )

    def attempts_for_passages(
        self, ctx: SessionContext, passage_ids: Sequence[UUID]
    ) -> list[AttemptRecord]:
        found: list[AttemptRecord] = []
        for chunk in chunks(list(passage_ids), self._chunk):
            rows = self._rest.get(
                ctx,
                "attempts",
                {
                    "passage_id": in_filter(chunk),
                    "select": _ATTEMPT_COLUMNS,
                    "order": "created_at.desc",
                    "limit": str(ATTEMPT_LIMIT),
                },
            )
            found.extend(
                parse_or_internal(lambda row=row: AttemptRecord.from_row(row, user_id=ctx.user_id))
                for row in rows
            )
        return sorted(found, key=lambda a: a.created_at, reverse=True)[:ATTEMPT_LIMIT]

    def last_active_date(self, ctx: SessionContext, on_or_before: date) -> date | None:
        rows = self._rest.get(
            ctx,
            "daily_progress",
            {
                "active_ms": "gt.0",
                "learning_date": f"lte.{on_or_before.isoformat()}",
                "order": "learning_date.desc",
                "limit": "1",
                "select": "learning_date",
            },
        )
        if not rows:
            return None
        return parse_or_internal(lambda: date.fromisoformat(str(rows[0]["learning_date"])[:10]))
