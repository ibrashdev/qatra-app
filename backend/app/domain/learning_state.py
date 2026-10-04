"""Learning-state value objects (pure): the rows of ``target_mastery``, ``target_part_evidence``,
``attempts``, ``session_activity_intervals`` and ``daily_progress`` as frozen dataclasses.

Package B5 only READS this state (session composition, Implementation-contract §5). Package B6
(the mastery engine and event intake, contract §4) writes it, so the shapes here follow the
documented payload of ``app_apply_events`` (``supabase/migrations/0005_rls_functions.sql``,
section 7.4) field for field, and ``PassageMastery.violations`` mirrors the CHECK constraints of
``target_mastery`` (Database-schema §6.3). This module holds no transition logic: how a status or
a streak changes belongs to B6.

Pure module: standard library only (no FastAPI, no database client).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Final
from uuid import UUID

MASTERY_STATUSES: Final[tuple[str, ...]] = (
    "new",
    "learning",
    "reviewing",
    "confirmed",
    "needs_refresh",
)
# Statuses that have an initial success behind them and therefore a review or maintenance date.
LADDER_STATUSES: Final[frozenset[str]] = frozenset({"reviewing", "confirmed", "needs_refresh"})

# D41: the first time a passage has this many consecutive correct, unassisted answers it has its
# initial evidence (contract §4.2).
STREAK_TARGET: Final = 3
MAX_REVIEW_STAGE: Final = 3


def parse_datetime(value: Any) -> datetime | None:
    """A PostgREST ``timestamptz`` (ISO 8601 text) or ``None``."""
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


def parse_date(value: Any) -> date | None:
    """A PostgREST ``date`` (``YYYY-MM-DD``) or ``None``."""
    if value is None or (isinstance(value, date) and not isinstance(value, datetime)):
        return value
    return date.fromisoformat(str(value)[:10])


def require_datetime(value: Any) -> datetime:
    """Like ``parse_datetime`` for a ``not null`` column: a missing value is a ``ValueError``."""
    parsed = parse_datetime(value)
    if parsed is None:
        raise ValueError("a required timestamp is missing")
    return parsed


def require_date(value: Any) -> date:
    """Like ``parse_date`` for a ``not null`` column: a missing value is a ``ValueError``."""
    parsed = parse_date(value)
    if parsed is None:
        raise ValueError("a required date is missing")
    return parsed


def _iso(value: date | datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _uuids(value: Any) -> tuple[UUID, ...]:
    return tuple(item if isinstance(item, UUID) else UUID(str(item)) for item in value or ())


@dataclass(frozen=True, slots=True)
class PassageMastery:
    """One ``target_mastery`` row without ``user_id`` and ``edition_id`` (the edition comes from the
    session). ``status`` starts as ``new``; a passage without a row is ``new`` as well."""

    plan_id: UUID
    passage_id: UUID
    status: str = "new"
    consecutive_correct: int = 0
    initial_success_at: datetime | None = None
    initial_learning_date: date | None = None
    review_stage: int = 0
    next_review_due: date | None = None
    last_review_date: date | None = None
    confirmed_at: datetime | None = None
    first_confirmed_at: datetime | None = None
    maintenance_stage: int = 0
    lapse_count: int = 0
    error_part_ids: tuple[UUID, ...] = ()

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> PassageMastery:
        """Build from a PostgREST row of ``target_mastery`` (JSON text values are parsed)."""
        return cls(
            plan_id=UUID(str(row["plan_id"])),
            passage_id=UUID(str(row["passage_id"])),
            status=str(row.get("status", "new")),
            consecutive_correct=int(row.get("consecutive_correct", 0)),
            initial_success_at=parse_datetime(row.get("initial_success_at")),
            initial_learning_date=parse_date(row.get("initial_learning_date")),
            review_stage=int(row.get("review_stage", 0)),
            next_review_due=parse_date(row.get("next_review_due")),
            last_review_date=parse_date(row.get("last_review_date")),
            confirmed_at=parse_datetime(row.get("confirmed_at")),
            first_confirmed_at=parse_datetime(row.get("first_confirmed_at")),
            maintenance_stage=int(row.get("maintenance_stage", 0)),
            lapse_count=int(row.get("lapse_count", 0)),
            error_part_ids=_uuids(row.get("error_part_ids")),
        )

    def to_payload(self) -> dict[str, Any]:
        """The ``mastery`` object of an ``app_apply_events`` element (all 14 documented keys)."""
        return {
            "plan_id": str(self.plan_id),
            "passage_id": str(self.passage_id),
            "status": self.status,
            "consecutive_correct": self.consecutive_correct,
            "initial_success_at": _iso(self.initial_success_at),
            "initial_learning_date": _iso(self.initial_learning_date),
            "review_stage": self.review_stage,
            "next_review_due": _iso(self.next_review_due),
            "last_review_date": _iso(self.last_review_date),
            "confirmed_at": _iso(self.confirmed_at),
            "first_confirmed_at": _iso(self.first_confirmed_at),
            "maintenance_stage": self.maintenance_stage,
            "lapse_count": self.lapse_count,
            "error_part_ids": [str(part_id) for part_id in self.error_part_ids],
        }

    def violations(self) -> tuple[str, ...]:
        """Names of the ``target_mastery`` CHECK constraints this state would break (empty when
        consistent). A store may use it to refuse what the database would refuse."""
        found: list[str] = []
        if self.status not in MASTERY_STATUSES:
            found.append("status_value")
        if self.consecutive_correct < 0:
            found.append("consecutive_correct_range")
        if not 0 <= self.review_stage <= MAX_REVIEW_STAGE:
            found.append("review_stage_range")
        if self.maintenance_stage < 0:
            found.append("maintenance_stage_range")
        if self.lapse_count < 0:
            found.append("lapse_count_range")
        if (self.status == "confirmed") != (self.confirmed_at is not None):
            found.append("confirmed_at_matches_status")
        if self.confirmed_at is not None and self.first_confirmed_at is None:
            found.append("first_confirmed_at_required")
        if self.status == "needs_refresh" and self.first_confirmed_at is None:
            found.append("needs_refresh_requires_first_confirmation")
        if self.status in ("reviewing", "needs_refresh") and not (
            1 <= self.review_stage <= MAX_REVIEW_STAGE
        ):
            found.append("review_stage_for_status")
        if (self.initial_success_at is None) != (self.initial_learning_date is None):
            found.append("initial_success_pair")
        if self.status in LADDER_STATUSES and self.initial_success_at is None:
            found.append("initial_success_required")
        return tuple(found)

    def is_due(self, on: date) -> bool:
        """A review or maintenance round is due on ``on``; missed rounds stay due (§4.6)."""
        return (
            self.status in LADDER_STATUSES
            and self.next_review_due is not None
            and self.next_review_due <= on
        )


@dataclass(frozen=True, slots=True)
class PartEvidence:
    """One ``target_part_evidence`` row without ``user_id``: the first correct, unassisted attempt
    that covered the part. Displayed context is never evidence (D64, D66)."""

    plan_id: UUID
    passage_id: UUID
    part_id: UUID
    attempt_id: UUID
    learning_date: date

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> PartEvidence:
        return cls(
            plan_id=UUID(str(row["plan_id"])),
            passage_id=UUID(str(row["passage_id"])),
            part_id=UUID(str(row["part_id"])),
            attempt_id=UUID(str(row["attempt_id"])),
            learning_date=require_date(row["learning_date"]),
        )

    def to_payload(self) -> dict[str, Any]:
        """One element of the ``evidence`` array of an ``app_apply_events`` attempt element (the
        covering attempt is the element's own attempt)."""
        return {
            "plan_id": str(self.plan_id),
            "passage_id": str(self.passage_id),
            "part_id": str(self.part_id),
            "learning_date": self.learning_date.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class AttemptRecord:
    """One ``attempts`` row. The free-text answer is never stored: only ``wrong_token_ref``, a
    reference into the edition (Database-schema §6.3)."""

    id: UUID
    user_id: UUID
    session_id: UUID
    edition_id: UUID
    client_event_id: UUID
    question_id: UUID
    passage_id: UUID
    correct: bool
    assisted: bool
    duration_ms: int
    occurred_at: datetime
    created_at: datetime
    error_kind: str | None = None
    wrong_token_ref: str | None = None
    review_round_id: UUID | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any], *, user_id: UUID | None = None) -> AttemptRecord:
        """From a PostgREST row of ``attempts`` (``user_id`` may be omitted from the select)."""
        occurred_at = require_datetime(row["occurred_at"])
        created_at = require_datetime(row["created_at"])
        raw_owner = row.get("user_id")
        owner = UUID(str(raw_owner)) if raw_owner else user_id
        if owner is None:
            raise KeyError("user_id")
        round_id = row.get("review_round_id")
        return cls(
            id=UUID(str(row["id"])),
            user_id=owner,
            session_id=UUID(str(row["session_id"])),
            edition_id=UUID(str(row["edition_id"])),
            client_event_id=UUID(str(row["client_event_id"])),
            question_id=UUID(str(row["question_id"])),
            passage_id=UUID(str(row["passage_id"])),
            correct=bool(row["correct"]),
            assisted=bool(row.get("assisted", False)),
            duration_ms=int(row.get("duration_ms", 0)),
            occurred_at=occurred_at,
            created_at=created_at,
            error_kind=row.get("error_kind"),
            wrong_token_ref=row.get("wrong_token_ref"),
            review_round_id=None if round_id is None else UUID(str(round_id)),
        )


@dataclass(frozen=True, slots=True)
class ActivityInterval:
    """One ``session_activity_intervals`` row: a server-validated stretch of active time."""

    id: UUID
    user_id: UUID
    session_id: UUID
    client_event_id: UUID
    started_at: datetime
    ended_at: datetime
    active_ms: int
    learning_date: date
    created_at: datetime


@dataclass(frozen=True, slots=True)
class DailyProgressRow:
    """One ``daily_progress`` row: ``active_ms`` is the union of validated intervals of the date."""

    user_id: UUID
    learning_date: date
    active_ms: int
    goal_ms: int
