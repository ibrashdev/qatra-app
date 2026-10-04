"""Seeding helpers shared by the learning-repository and the PostgREST flow tests.

``Harness`` seeds what a learner has already done into either the in-memory store or the fake
PostgREST tables, so one test body can check both implementations.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

from app.domain.learning_state import (
    AttemptRecord,
    DailyProgressRow,
    PartEvidence,
    PassageMastery,
)
from app.repositories.learning import (
    InMemoryLearningStore,
    LearningRepository,
    NewSession,
)
from tests.sessions.ss_postgrest import TOKEN, FakePostgrest
from tests.sessions.ss_support import (
    NOW,
    OTHER_USER,
    PLAN_ID,
    PLAN_VERSION_ID,
    QURAN_EDITION,
    TODAY,
    USER,
    ctx,
)

PASSAGE = UUID("66666666-6666-4666-8666-000000000001")
PART = UUID("77777777-7777-4777-8777-000000000001")
OTHER_PLAN = UUID("44444444-4444-4444-8444-0000000000ff")
LEARNER = ctx(token=TOKEN)
STRANGER = ctx(OTHER_USER, token=TOKEN)


def new_session(n: int, *, kind: str = "daily", day: date = TODAY, plan: bool = True) -> NewSession:
    return NewSession(
        session_id=UUID(f"55555555-5555-4555-8555-{n:012d}"),
        kind=kind,
        plan_id=PLAN_ID if plan else None,
        plan_version_id=PLAN_VERSION_ID if plan else None,
        plan_version=2 if plan else None,
        edition_id=QURAN_EDITION,
        learning_date=day,
        lesson_refs=(UUID(int=7),),
        question_refs=(UUID(int=8), UUID(int=9)),
        steps=[{"type": "learn", "passage": {"passageId": str(PASSAGE), "text": "كلمة"}}],
        bank_version=1,
        created_at=NOW + timedelta(minutes=n),
        self_rating="some" if kind == "placement" else None,
    )


def mastery(passage: UUID = PASSAGE, plan: UUID = PLAN_ID, **fields: Any) -> PassageMastery:
    values: dict[str, Any] = {
        "plan_id": plan,
        "passage_id": passage,
        "status": "reviewing",
        "consecutive_correct": 3,
        "initial_success_at": datetime(2026, 9, 30, 8, 15, tzinfo=UTC),
        "initial_learning_date": date(2026, 9, 30),
        "review_stage": 1,
        "next_review_due": date(2026, 10, 1),
        "error_part_ids": (PART,),
    }
    values.update(fields)
    return PassageMastery(**values)


def attempt(n: int, *, user: UUID = USER, passage: UUID = PASSAGE) -> AttemptRecord:
    return AttemptRecord(
        id=UUID(f"88888888-8888-4888-8888-{n:012d}"),
        user_id=user,
        session_id=UUID(int=1),
        edition_id=QURAN_EDITION,
        client_event_id=UUID(f"99999999-9999-4999-8999-{n:012d}"),
        question_id=UUID(f"77777777-7777-4777-8777-{n:012d}"),
        passage_id=passage,
        correct=bool(n % 2),
        assisted=False,
        duration_ms=1000 + n,
        occurred_at=NOW + timedelta(seconds=n),
        created_at=NOW + timedelta(seconds=n, milliseconds=5),
        error_kind=None if n % 2 else "wrong_choice",
        wrong_token_ref=None if n % 2 else "3:1",
        review_round_id=None,
    )


@dataclass
class Harness:
    """A repository plus the means to seed what a learner has already done."""

    kind: str
    repo: LearningRepository
    store: InMemoryLearningStore | None = None
    fake: FakePostgrest | None = None

    def seed_mastery(self, user: UUID, row: PassageMastery) -> None:
        if self.store is not None:
            self.store.put_mastery(user, row)
        else:
            assert self.fake is not None
            self.fake.tables["target_mastery"].append(
                {"user_id": str(user), "edition_id": str(QURAN_EDITION), **row.to_payload()}
            )

    def seed_evidence(self, user: UUID, evidence: PartEvidence) -> None:
        if self.store is not None:
            self.store.put_evidence(user, evidence)
        else:
            assert self.fake is not None
            self.fake.tables["target_part_evidence"].append(
                {
                    "user_id": str(user),
                    "attempt_id": str(evidence.attempt_id),
                    **evidence.to_payload(),
                }
            )

    def seed_attempt(self, row: AttemptRecord) -> None:
        if self.store is not None:
            self.store.put_attempt(row)
        else:
            assert self.fake is not None
            self.fake.tables["attempts"].append(
                {
                    "id": str(row.id),
                    "user_id": str(row.user_id),
                    "session_id": str(row.session_id),
                    "edition_id": str(row.edition_id),
                    "client_event_id": str(row.client_event_id),
                    "question_id": str(row.question_id),
                    "passage_id": str(row.passage_id),
                    "correct": row.correct,
                    "assisted": row.assisted,
                    "error_kind": row.error_kind,
                    "wrong_token_ref": row.wrong_token_ref,
                    "review_round_id": None,
                    "duration_ms": row.duration_ms,
                    "occurred_at": row.occurred_at.isoformat(),
                    "created_at": row.created_at.isoformat(),
                }
            )

    def seed_daily(self, user: UUID, day: date, active_ms: int) -> None:
        if self.store is not None:
            self.store.put_daily_progress(DailyProgressRow(user, day, active_ms, 600_000))
        else:
            assert self.fake is not None
            self.fake.tables["daily_progress"].append(
                {
                    "user_id": str(user),
                    "learning_date": day.isoformat(),
                    "active_ms": active_ms,
                    "goal_ms": 600_000,
                }
            )
