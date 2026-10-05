"""Learner-state access for session preparation (package B5): open and read sessions, and read the
mastery, coverage evidence, attempt history and activity that composition needs.

``LearningRepository`` has two implementations:

- ``InMemoryLearningStore`` (memory mode): one thread-safe object holding sessions, attempts,
  activity intervals, mastery, part evidence and daily progress. It mirrors ``app_open_session``
  (an atomic get-or-create for the daily session) and is written so that package B6 can add its
  ``apply_events`` to the same store: the row types and the ``put_*`` helpers are the shapes of
  ``app_apply_events``. The same instance is package B4's placement reader
  (``known_passage_ids``), so E15 and E16 count the attempts of the placement sessions E20 opened.
- ``PostgrestLearningRepository`` (supabase mode): the shared ``PostgrestClient`` as the learner
  (the access token as ``Authorization: Bearer``, so row-level security applies). A new session is
  committed through the ``app_open_session`` function (Database-schema §8.3); everything else is a
  read, except ``mark_completed``, which sets ``status`` (a column the learner may update, §5.2
  item 5).

Every method takes the caller's ``SessionContext`` and returns only the caller's rows. Errors are
mapped as in ``repositories/bank.py`` (``unavailable``, ``unauthenticated``, ``not_found``, and
``version_conflict`` for the function's ``QT002``).

Time-based reads: ``last_active_date`` is the latest learning date with verified activity
(``daily_progress.active_ms > 0``), the input of the absence rule (R07).

Package B6 adds, without touching the methods above: ``daily_progress_between`` and
``completion_dates`` (E18, E19), ``attempts_for_session``, ``acknowledged_event_ids``,
``intervals_for_date`` and ``intervals_for_session`` (E21, E22), and the two writes
``apply_events`` (the function ``app_apply_events``: every element once per ``client_event_id``,
mastery upserted, evidence once per part, one ``daily_progress`` row and its single completion) and
``complete_session`` (``app_complete_session``). The memory store mirrors both functions under its
lock; the supabase repository only calls them, so row-level security stays in force.
"""

from __future__ import annotations

import copy
import threading
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final, Protocol
from uuid import UUID

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
from app.domain.planning_port import PlacementNotFound
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.bank import LearnerClient, chunks, in_filter, parse_or_internal

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


@dataclass(frozen=True, slots=True)
class EvidenceWrite:
    """A part that gains evidence; the covering attempt is the attempt element it belongs to."""

    plan_id: UUID
    passage_id: UUID
    part_id: UUID
    learning_date: date

    def to_payload(self) -> dict[str, Any]:
        return {
            "plan_id": str(self.plan_id),
            "passage_id": str(self.passage_id),
            "part_id": str(self.part_id),
            "learning_date": self.learning_date.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class AttemptWrite:
    """The ``attempt`` element of ``app_apply_events``: one graded answer with, when it counts for
    mastery, the passage state after it and the parts that gained evidence. The free-text answer is
    never part of it."""

    client_event_id: UUID
    question_id: UUID
    passage_id: UUID
    correct: bool
    assisted: bool
    error_kind: str
    duration_ms: int
    occurred_at: datetime
    wrong_token_ref: str | None = None
    review_round_id: UUID | None = None
    mastery: PassageMastery | None = None
    evidence: tuple[EvidenceWrite, ...] = ()

    def to_payload(self) -> dict[str, Any]:
        element: dict[str, Any] = {
            "attempt": {
                "client_event_id": str(self.client_event_id),
                "question_id": str(self.question_id),
                "passage_id": str(self.passage_id),
                "correct": self.correct,
                "assisted": self.assisted,
                "error_kind": self.error_kind,
                "wrong_token_ref": self.wrong_token_ref,
                "review_round_id": None
                if self.review_round_id is None
                else str(self.review_round_id),
                "duration_ms": self.duration_ms,
                "occurred_at": self.occurred_at.isoformat(),
            }
        }
        if self.mastery is not None:
            element["mastery"] = self.mastery.to_payload()
            element["evidence"] = [item.to_payload() for item in self.evidence]
        return element


@dataclass(frozen=True, slots=True)
class IntervalWrite:
    """The ``interval`` element of ``app_apply_events``: one validated activity event."""

    client_event_id: UUID
    started_at: datetime
    ended_at: datetime
    active_ms: int
    learning_date: date

    def to_payload(self) -> dict[str, Any]:
        return {
            "interval": {
                "client_event_id": str(self.client_event_id),
                "started_at": self.started_at.isoformat(),
                "ended_at": self.ended_at.isoformat(),
                "active_ms": self.active_ms,
                "learning_date": self.learning_date.isoformat(),
            }
        }


EventWrite = AttemptWrite | IntervalWrite


@dataclass(frozen=True, slots=True)
class DailyWrite:
    """The ``p_daily`` argument: one account-date. ``active_ms`` never decreases in the store;
    ``completed`` asks for the single completion of the date (written once)."""

    learning_date: date
    active_ms: int
    goal_ms: int
    completed: bool = False
    reached_in_plan_id: UUID | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "learning_date": self.learning_date.isoformat(),
            "active_ms": self.active_ms,
            "goal_ms": self.goal_ms,
            "completed": self.completed,
            "reached_in_plan_id": None
            if self.reached_in_plan_id is None
            else str(self.reached_in_plan_id),
        }


@dataclass(frozen=True, slots=True)
class ApplyResult:
    """What ``apply_events`` answers: ``acknowledged`` or ``duplicate`` for every element, in order,
    and whether this call wrote the completion of the date."""

    outcomes: tuple[str, ...]
    completion_inserted: bool = False


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

    # -- package B6 -----------------------------------------------------------------------------

    def daily_progress_between(
        self, ctx: SessionContext, start: date, end: date
    ) -> list[DailyProgressRow]:
        """The caller's ``daily_progress`` rows with ``start <= learning_date <= end``, ascending
        by date."""

    def completion_dates(self, ctx: SessionContext, start: date, end: date) -> frozenset[date]:
        """Learning dates in ``[start, end]`` that have their single ``daily_completions`` row."""

    def attempts_for_session(self, ctx: SessionContext, session_id: UUID) -> list[AttemptRecord]:
        """Every attempt of the caller's session, oldest first."""

    def acknowledged_event_ids(
        self, ctx: SessionContext, event_ids: Sequence[UUID]
    ) -> frozenset[UUID]:
        """The ids among ``event_ids`` already recorded for the caller in ``attempts`` or in
        ``session_activity_intervals`` (``unique(user_id, client_event_id)`` on both)."""

    def intervals_for_date(
        self, ctx: SessionContext, learning_date: date
    ) -> list[ActivityInterval]:
        """The caller's validated intervals of one learning date, across sessions and devices,
        oldest start first."""

    def intervals_for_session(
        self, ctx: SessionContext, session_id: UUID
    ) -> list[ActivityInterval]:
        """The validated intervals recorded for one of the caller's sessions, oldest start first."""

    def apply_events(
        self,
        ctx: SessionContext,
        session_id: UUID,
        events: Sequence[EventWrite],
        daily: DailyWrite | None,
        *,
        open_session: bool,
    ) -> ApplyResult:
        """Persist the elements in one transaction (``app_apply_events``). An element whose
        ``client_event_id`` is already recorded is a ``duplicate`` and writes nothing. Raises
        ``not_found`` for an unknown or foreign session."""

    def complete_session(self, ctx: SessionContext, session_id: UUID, elapsed_ms: int) -> bool:
        """Set ``completed`` and ``elapsed_ms`` (``app_complete_session``). ``True`` when this call
        completed the session, ``False`` when it already was (nothing changes). Raises
        ``not_found`` for an unknown or foreign session."""


# --- memory mode ---------------------------------------------------------------------------------


def _by_start(row: ActivityInterval) -> tuple[datetime, str]:
    """The order of the PostgREST read: ``started_at.asc,id.asc``."""
    return row.started_at, str(row.id)


class InMemoryLearningStore:
    """Thread-safe memory-mode store. Data lives for the process only. Public attributes hold the
    raw rows for tests and for B6's ``apply_events``; the ``put_*`` helpers seed them."""

    def __init__(self, *, clock: Callable[[], datetime] | None = None) -> None:
        self._lock = threading.RLock()
        self._clock = clock or (lambda: datetime.now(UTC))  # stamps ``created_at`` of new rows
        self.sessions: dict[UUID, StoredSession] = {}
        self.attempts: list[AttemptRecord] = []
        self.intervals: list[ActivityInterval] = []
        self.mastery: dict[tuple[UUID, UUID, UUID], PassageMastery] = {}  # user, plan, passage
        self.evidence: dict[tuple[UUID, UUID, UUID], PartEvidence] = {}  # user, plan, part
        self.daily_progress: dict[tuple[UUID, date], DailyProgressRow] = {}
        self.completions: dict[tuple[UUID, date], UUID] = {}  # user, date -> reached in plan

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

    def put_interval(self, row: ActivityInterval) -> None:
        with self._lock:
            self.intervals.append(row)

    def put_completion(self, user_id: UUID, learning_date: date, plan_id: UUID) -> None:
        with self._lock:
            self.completions.setdefault((user_id, learning_date), plan_id)

    def known_passage_ids(
        self, ctx: SessionContext, placement_session_id: UUID, edition_id: UUID
    ) -> frozenset[UUID]:
        """Passages answered correctly and unassisted in the caller's placement session of this
        edition (the supabase reader's rule, [O-17]). Raises ``PlacementNotFound`` for an unknown,
        foreign, other-edition or non-placement session."""
        with self._lock:
            session = self.sessions.get(placement_session_id)
            if (
                session is None
                or session.user_id != ctx.user_id
                or session.kind != "placement"
                or session.edition_id != edition_id
            ):
                raise PlacementNotFound
            return frozenset(
                attempt.passage_id
                for attempt in self.attempts
                if attempt.session_id == placement_session_id
                and attempt.user_id == ctx.user_id
                and attempt.correct
                and not attempt.assisted
            )

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

    # -- package B6 -----------------------------------------------------------------------------

    def daily_progress_between(
        self, ctx: SessionContext, start: date, end: date
    ) -> list[DailyProgressRow]:
        with self._lock:
            rows = [
                row
                for (user, day), row in self.daily_progress.items()
                if user == ctx.user_id and start <= day <= end
            ]
        return sorted(rows, key=lambda row: row.learning_date)

    def completion_dates(self, ctx: SessionContext, start: date, end: date) -> frozenset[date]:
        with self._lock:
            return frozenset(
                day
                for (user, day) in self.completions
                if user == ctx.user_id and start <= day <= end
            )

    def attempts_for_session(self, ctx: SessionContext, session_id: UUID) -> list[AttemptRecord]:
        with self._lock:
            mine = [
                a for a in self.attempts if a.user_id == ctx.user_id and a.session_id == session_id
            ]
        return sorted(mine, key=lambda a: a.created_at)  # stable: insertion order inside a tie

    def acknowledged_event_ids(
        self, ctx: SessionContext, event_ids: Sequence[UUID]
    ) -> frozenset[UUID]:
        wanted = set(event_ids)
        with self._lock:
            known = {a.client_event_id for a in self.attempts if a.user_id == ctx.user_id}
            known |= {i.client_event_id for i in self.intervals if i.user_id == ctx.user_id}
        return frozenset(wanted & known)

    def intervals_for_date(
        self, ctx: SessionContext, learning_date: date
    ) -> list[ActivityInterval]:
        with self._lock:
            found = [
                i
                for i in self.intervals
                if i.user_id == ctx.user_id and i.learning_date == learning_date
            ]
        return sorted(found, key=_by_start)

    def intervals_for_session(
        self, ctx: SessionContext, session_id: UUID
    ) -> list[ActivityInterval]:
        with self._lock:
            found = [
                i for i in self.intervals if i.user_id == ctx.user_id and i.session_id == session_id
            ]
        return sorted(found, key=_by_start)

    def apply_events(
        self,
        ctx: SessionContext,
        session_id: UUID,
        events: Sequence[EventWrite],
        daily: DailyWrite | None,
        *,
        open_session: bool,
    ) -> ApplyResult:
        """The semantics of ``app_apply_events``. Everything is computed on copies and committed at
        the end, so a refused element leaves nothing behind, as a rolled back transaction would."""
        user = ctx.user_id
        with self._lock:
            session = self.sessions.get(session_id)
            if session is None or session.user_id != user:
                raise AppError(ErrorCode.not_found)
            attempts, intervals = list(self.attempts), list(self.intervals)
            mastery, evidence = dict(self.mastery), dict(self.evidence)
            recorded = {a.client_event_id for a in attempts if a.user_id == user}
            recorded_intervals = {i.client_event_id for i in intervals if i.user_id == user}
            outcomes: list[str] = []
            now = self._clock()
            for event in events:
                if isinstance(event, AttemptWrite):
                    if event.client_event_id in recorded:
                        outcomes.append("duplicate")
                        continue
                    attempt_id = uuid.uuid4()
                    attempts.append(
                        AttemptRecord(
                            id=attempt_id,
                            user_id=user,
                            session_id=session_id,
                            edition_id=session.edition_id,
                            client_event_id=event.client_event_id,
                            question_id=event.question_id,
                            passage_id=event.passage_id,
                            correct=event.correct,
                            assisted=event.assisted,
                            duration_ms=event.duration_ms,
                            occurred_at=event.occurred_at,
                            created_at=now,
                            error_kind=event.error_kind,
                            wrong_token_ref=event.wrong_token_ref,
                            review_round_id=event.review_round_id,
                        )
                    )
                    recorded.add(event.client_event_id)
                    if event.mastery is not None:
                        if event.mastery.violations():  # the database would refuse this row
                            raise AppError(ErrorCode.unavailable)
                        key = (user, event.mastery.plan_id, event.mastery.passage_id)
                        mastery[key] = event.mastery
                        for item in event.evidence:
                            evidence.setdefault(
                                (user, item.plan_id, item.part_id),
                                PartEvidence(
                                    item.plan_id,
                                    item.passage_id,
                                    item.part_id,
                                    attempt_id,
                                    item.learning_date,
                                ),
                            )
                    outcomes.append("acknowledged")
                else:
                    if event.client_event_id in recorded_intervals:
                        outcomes.append("duplicate")
                        continue
                    span = event.ended_at - event.started_at
                    within = event.active_ms <= span // timedelta(milliseconds=1) + 1000
                    if not (timedelta(0) <= span and 0 <= event.active_ms <= 1_800_000 and within):
                        raise AppError(ErrorCode.unavailable)  # the CHECKs of the interval table
                    intervals.append(
                        ActivityInterval(
                            id=uuid.uuid4(),
                            user_id=user,
                            session_id=session_id,
                            client_event_id=event.client_event_id,
                            started_at=event.started_at,
                            ended_at=event.ended_at,
                            active_ms=event.active_ms,
                            learning_date=event.learning_date,
                            created_at=now,
                        )
                    )
                    recorded_intervals.add(event.client_event_id)
                    outcomes.append("acknowledged")
            inserted = False
            progress = dict(self.daily_progress)
            completions = dict(self.completions)
            if daily is not None:
                if daily.goal_ms <= 0 or daily.active_ms < 0:
                    raise AppError(ErrorCode.unavailable)
                day_key = (user, daily.learning_date)
                before = progress.get(day_key)
                kept = daily.active_ms if before is None else max(before.active_ms, daily.active_ms)
                progress[day_key] = DailyProgressRow(user, daily.learning_date, kept, daily.goal_ms)
                if daily.completed:
                    if daily.reached_in_plan_id is None:
                        raise AppError(ErrorCode.unavailable)
                    if day_key not in completions:
                        completions[day_key] = daily.reached_in_plan_id
                        inserted = True
            self.attempts[:] = attempts
            self.intervals[:] = intervals
            self.mastery.clear()
            self.mastery.update(mastery)
            self.evidence.clear()
            self.evidence.update(evidence)
            self.daily_progress.clear()
            self.daily_progress.update(progress)
            self.completions.clear()
            self.completions.update(completions)
            if open_session and session.status == "prepared":
                self.sessions[session_id] = replace(session, status="open")
            return ApplyResult(tuple(outcomes), inserted)

    def complete_session(self, ctx: SessionContext, session_id: UUID, elapsed_ms: int) -> bool:
        with self._lock:
            session = self.sessions.get(session_id)
            if session is None or session.user_id != ctx.user_id:
                raise AppError(ErrorCode.not_found)
            if session.status == "completed":
                return False
            if elapsed_ms < 0:  # CHECK (elapsed_ms >= 0)
                raise AppError(ErrorCode.unavailable)
            self.sessions[session_id] = replace(session, status="completed", elapsed_ms=elapsed_ms)
            return True


# --- PostgREST -----------------------------------------------------------------------------------

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
_INTERVAL_COLUMNS = (
    "id,session_id,client_event_id,started_at,ended_at,active_ms,learning_date,created_at"
)


def _uuid_or_none(value: Any) -> UUID | None:
    return None if value is None else UUID(str(value))


class PostgrestLearningRepository:
    """Supabase-mode learner state through PostgREST as the learner (row-level security)."""

    def __init__(self, client: PostgrestClient, *, in_chunk: int = 40) -> None:
        self._rest = LearnerClient(client)
        self._chunk = max(1, in_chunk)  # ids per ``in.(...)`` filter

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
            versions = self._rest.select(
                ctx,
                "plan_versions",
                columns="version_no",
                filters={"id": f"eq.{row['plan_version_id']}"},
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
        rows = self._rest.select(
            ctx,
            "learning_sessions",
            columns=_SESSION_COLUMNS,
            filters={"id": f"eq.{session_id}", "user_id": f"eq.{ctx.user_id}"},
        )
        return self._session(ctx, rows[0]) if rows else None

    def find_open_daily(self, ctx: SessionContext, learning_date: date) -> StoredSession | None:
        rows = self._rest.select(
            ctx,
            "learning_sessions",
            columns=_SESSION_COLUMNS,
            filters={
                "user_id": f"eq.{ctx.user_id}",
                "kind": "eq.daily",
                "learning_date": f"eq.{learning_date.isoformat()}",
                "status": in_filter(OPEN_STATUSES),
                "offline_snapshot_id": "is.null",
            },
            order="created_at.desc",
            limit=1,
        )
        return self._session(ctx, rows[0]) if rows else None

    def mark_completed(self, ctx: SessionContext, session_id: UUID) -> None:
        self._rest.patch(
            ctx,
            "learning_sessions",
            filters={
                "id": f"eq.{session_id}",
                "user_id": f"eq.{ctx.user_id}",
                "status": in_filter(OPEN_STATUSES),
            },
            values={"status": "completed"},
        )

    def mastery_for_plan(self, ctx: SessionContext, plan_id: UUID) -> dict[UUID, PassageMastery]:
        rows = self._rest.select_all(
            ctx,
            "target_mastery",
            columns=_MASTERY_COLUMNS,
            filters={"plan_id": f"eq.{plan_id}"},
            order="passage_id.asc",
        )
        found = [parse_or_internal(lambda row=row: PassageMastery.from_row(row)) for row in rows]
        return {row.passage_id: row for row in found}

    def covered_parts(self, ctx: SessionContext, plan_id: UUID) -> frozenset[UUID]:
        rows = self._rest.select_all(
            ctx,
            "target_part_evidence",
            columns="part_id",
            filters={"plan_id": f"eq.{plan_id}"},
            order="part_id.asc",
        )
        return frozenset(
            parse_or_internal(lambda row=row: UUID(str(row["part_id"]))) for row in rows
        )

    def attempts_for_passages(
        self, ctx: SessionContext, passage_ids: Sequence[UUID]
    ) -> list[AttemptRecord]:
        found: list[AttemptRecord] = []
        for chunk in chunks(list(passage_ids), self._chunk):
            rows = self._rest.select(
                ctx,
                "attempts",
                columns=_ATTEMPT_COLUMNS,
                filters={"passage_id": in_filter(chunk)},
                order="created_at.desc",
                limit=ATTEMPT_LIMIT,
            )
            found.extend(
                parse_or_internal(lambda row=row: AttemptRecord.from_row(row, user_id=ctx.user_id))
                for row in rows
            )
        return sorted(found, key=lambda a: a.created_at, reverse=True)[:ATTEMPT_LIMIT]

    def last_active_date(self, ctx: SessionContext, on_or_before: date) -> date | None:
        rows = self._rest.select(
            ctx,
            "daily_progress",
            columns="learning_date",
            filters={"active_ms": "gt.0", "learning_date": f"lte.{on_or_before.isoformat()}"},
            order="learning_date.desc",
            limit=1,
        )
        if not rows:
            return None
        return parse_or_internal(lambda: date.fromisoformat(str(rows[0]["learning_date"])[:10]))

    # -- package B6 -----------------------------------------------------------------------------

    @staticmethod
    def _window(start: date, end: date) -> dict[str, str]:
        """Both ends of a date range on one column need PostgREST's ``and``."""
        return {
            "and": f"(learning_date.gte.{start.isoformat()},learning_date.lte.{end.isoformat()})"
        }

    def daily_progress_between(
        self, ctx: SessionContext, start: date, end: date
    ) -> list[DailyProgressRow]:
        if start > end:
            return []
        rows = self._rest.select_all(
            ctx,
            "daily_progress",
            columns="learning_date,active_ms,goal_ms",
            filters={**self._window(start, end), "user_id": f"eq.{ctx.user_id}"},
            order="learning_date.asc",
        )
        return [
            parse_or_internal(
                lambda row=row: DailyProgressRow(
                    user_id=ctx.user_id,
                    learning_date=require_date(row["learning_date"]),
                    active_ms=int(row["active_ms"]),
                    goal_ms=int(row["goal_ms"]),
                )
            )
            for row in rows
        ]

    def completion_dates(self, ctx: SessionContext, start: date, end: date) -> frozenset[date]:
        if start > end:
            return frozenset()
        rows = self._rest.select_all(
            ctx,
            "daily_completions",
            columns="learning_date",
            filters={**self._window(start, end), "user_id": f"eq.{ctx.user_id}"},
            order="learning_date.asc",
        )
        return frozenset(
            parse_or_internal(lambda row=row: require_date(row["learning_date"])) for row in rows
        )

    def attempts_for_session(self, ctx: SessionContext, session_id: UUID) -> list[AttemptRecord]:
        rows = self._rest.select_all(
            ctx,
            "attempts",
            columns=_ATTEMPT_COLUMNS,
            filters={"session_id": f"eq.{session_id}", "user_id": f"eq.{ctx.user_id}"},
            order="created_at.asc,id.asc",
        )
        return [
            parse_or_internal(lambda row=row: AttemptRecord.from_row(row, user_id=ctx.user_id))
            for row in rows
        ]

    def acknowledged_event_ids(
        self, ctx: SessionContext, event_ids: Sequence[UUID]
    ) -> frozenset[UUID]:
        found: set[UUID] = set()
        ids = list(dict.fromkeys(event_ids))
        for table in ("attempts", "session_activity_intervals"):
            for chunk in chunks(ids, self._chunk):
                rows = self._rest.select(
                    ctx,
                    table,
                    columns="client_event_id",
                    filters={
                        "client_event_id": in_filter(chunk),
                        "user_id": f"eq.{ctx.user_id}",
                    },
                )
                found.update(
                    parse_or_internal(lambda row=row: UUID(str(row["client_event_id"])))
                    for row in rows
                )
        return frozenset(found)

    def _intervals(self, ctx: SessionContext, filters: dict[str, str]) -> list[ActivityInterval]:
        rows = self._rest.select_all(
            ctx,
            "session_activity_intervals",
            columns=_INTERVAL_COLUMNS,
            filters={**filters, "user_id": f"eq.{ctx.user_id}"},
            order="started_at.asc,id.asc",
        )
        return [
            parse_or_internal(
                lambda row=row: ActivityInterval(
                    id=UUID(str(row["id"])),
                    user_id=ctx.user_id,
                    session_id=UUID(str(row["session_id"])),
                    client_event_id=UUID(str(row["client_event_id"])),
                    started_at=require_datetime(row["started_at"]),
                    ended_at=require_datetime(row["ended_at"]),
                    active_ms=int(row["active_ms"]),
                    learning_date=require_date(row["learning_date"]),
                    created_at=require_datetime(row["created_at"]),
                )
            )
            for row in rows
        ]

    def intervals_for_date(
        self, ctx: SessionContext, learning_date: date
    ) -> list[ActivityInterval]:
        return self._intervals(ctx, {"learning_date": f"eq.{learning_date.isoformat()}"})

    def intervals_for_session(
        self, ctx: SessionContext, session_id: UUID
    ) -> list[ActivityInterval]:
        return self._intervals(ctx, {"session_id": f"eq.{session_id}"})

    def apply_events(
        self,
        ctx: SessionContext,
        session_id: UUID,
        events: Sequence[EventWrite],
        daily: DailyWrite | None,
        *,
        open_session: bool,
    ) -> ApplyResult:
        result = self._rest.rpc(
            ctx,
            "app_apply_events",
            {
                "p_session_id": str(session_id),
                "p_events": [event.to_payload() for event in events],
                "p_daily": None if daily is None else daily.to_payload(),
                "p_open_session": open_session,
            },
        )

        def parse() -> ApplyResult:
            outcomes = tuple(str(item) for item in result["outcomes"])
            if len(outcomes) != len(events) or not set(outcomes) <= {"acknowledged", "duplicate"}:
                raise ValueError("outcomes")
            return ApplyResult(outcomes, bool(result.get("daily_completion_inserted", False)))

        return parse_or_internal(parse)

    def complete_session(self, ctx: SessionContext, session_id: UUID, elapsed_ms: int) -> bool:
        result = self._rest.rpc(
            ctx,
            "app_complete_session",
            {"p_session_id": str(session_id), "p_elapsed_ms": elapsed_ms},
        )

        def parse() -> bool:
            if not isinstance(result, bool):
                raise ValueError("completed")
            return result

        return parse_or_internal(parse)
