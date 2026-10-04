"""The anonymized learning record of a revision conversation (``PlanChatLearningSummary``).

Real in-memory repositories over the synthetic bundle; the only fakes are the plan lookup and a
learning store that has the optional ``daily_progress_between`` method (W-B6 adds it to the real
repository) next to the plain store that does not have it.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

import pytest

from app.contracts_plan_chat import Estimate, LearningSummary, TargetScope
from app.domain.learning_state import AttemptRecord, DailyProgressRow, PassageMastery
from app.errors import AppError, ErrorCode
from app.repositories.bank import InMemoryBankRepository
from app.repositories.learning import InMemoryLearningStore
from app.repositories.plans import StoredPlan
from app.services import plan_chat_learning as module
from app.services.plan_chat_learning import (
    DailyProgressSource,
    EmptyLearningSummary,
    PlanChatLearningSummary,
)
from tests.sessions.ss_support import QURAN, QURAN_EDITION, USER, ctx

TODAY = date(2026, 10, 5)
PLAN_ID = UUID("44444444-4444-4444-8444-000000000001")
SESSION_ID = UUID("55555555-5555-4555-8555-000000000001")
CONTEXT = ctx(USER)
PASSAGES = QURAN[
    "passages"
]  # four synthetic passages: references 112:1-4, 113:1-5, 114:1-3, 114:4-6


def passage_id(index: int) -> UUID:
    return UUID(PASSAGES[index]["id"])


def part_id(passage: int, part: int) -> UUID:
    return UUID(PASSAGES[passage]["parts"][part]["id"])


def question_covering(passage: int, part: int) -> dict[str, Any]:
    wanted = PASSAGES[passage]["parts"][part]["id"]
    return next(
        q
        for q in QURAN["questions"]
        if q["passageId"] == PASSAGES[passage]["id"] and q["coveredPartIds"] == [wanted]
    )


class Plans:
    def __init__(self, scope: tuple[int, ...] = (1, 2, 3)) -> None:
        estimate = Estimate(
            days=5,
            end_date=TODAY,
            new_words_per_day=12,
            total_words=10,
            known_words=0,
            passage_count=4,
            session_minutes=5,
            scope=TargetScope(section_ordinals=list(scope)),
            paths=["quran"],
        )
        self.plan = StoredPlan(
            plan_id=PLAN_ID,
            edition_id=QURAN_EDITION,
            title_ar="",
            title_en="",
            target_scope=scope,
            paths=("quran",),
            order="book",
            session_minutes=5,
            preferred_date=None,
            agreed_estimate=estimate,
            current_version=1,
            status="active",
            created_at=datetime(2026, 10, 1, tzinfo=UTC),
            policy={},
        )

    def read_plan(self, context: Any, plan_id: UUID) -> StoredPlan | None:
        return self.plan if plan_id == PLAN_ID and context.user_id == USER else None

    def learning_date(self, context: Any) -> date:
        return TODAY


class StoreWithDailyProgress(InMemoryLearningStore):
    """The learning store with the optional method (the signature W-B6 adds)."""

    def daily_progress_between(
        self, context: Any, start: date, end: date
    ) -> list[DailyProgressRow]:
        return [
            row
            for (user, day), row in self.daily_progress.items()
            if user == context.user_id and start <= day <= end
        ]


def summary(
    store: InMemoryLearningStore | None = None,
    plans: Plans | None = None,
    bank: InMemoryBankRepository | None = None,
) -> tuple[PlanChatLearningSummary, InMemoryLearningStore]:
    store = store if store is not None else InMemoryLearningStore()
    adapter = PlanChatLearningSummary(
        CONTEXT,
        plans=plans or Plans(),
        learning=store,
        bank=bank or InMemoryBankRepository([QURAN]),
    )
    return adapter, store


def read(adapter: PlanChatLearningSummary, *, is_demo: bool = False) -> LearningSummary:
    return adapter.summary_for(USER, PLAN_ID, is_demo=is_demo)


def row(passage: int, status: str, **fields: Any) -> PassageMastery:
    seen = datetime(2026, 9, 30, 8, 15, tzinfo=UTC)
    values: dict[str, Any] = {
        "plan_id": PLAN_ID,
        "passage_id": passage_id(passage),
        "status": status,
    }
    if status in ("reviewing", "needs_refresh", "confirmed"):
        values.update(initial_success_at=seen, initial_learning_date=seen.date(), review_stage=1)
    if status in ("confirmed", "needs_refresh"):
        values.update(first_confirmed_at=seen)
    if status == "confirmed":
        values.update(confirmed_at=seen, review_stage=0)
    values.update(fields)
    return PassageMastery(**values)


def attempt(
    n: int,
    passage: int = 0,
    question: str | None = None,
    *,
    correct: bool = True,
    when: datetime | None = None,
    **fields: Any,
) -> AttemptRecord:
    stamp = when or datetime(2026, 10, 4, 6, 0, tzinfo=UTC) + timedelta(minutes=n)
    return AttemptRecord(
        id=uuid.UUID(int=1000 + n),
        user_id=USER,
        session_id=SESSION_ID,
        edition_id=QURAN_EDITION,
        client_event_id=uuid.UUID(int=2000 + n),
        question_id=UUID(question or QURAN["questions"][0]["id"]),
        passage_id=passage_id(passage),
        correct=correct,
        assisted=fields.pop("assisted", False),
        duration_ms=1500,
        occurred_at=stamp,
        created_at=stamp,
        **fields,
    )


def test_a_plan_without_learning_state_has_an_empty_record() -> None:
    adapter, _ = summary()
    assert read(adapter) == LearningSummary()


def test_passages_carry_their_state_and_latest_review_most_urgent_first() -> None:
    adapter, store = summary()
    store.put_mastery(USER, row(0, "learning", consecutive_correct=1))
    store.put_mastery(
        USER, row(1, "needs_refresh", last_review_date=date(2026, 10, 3), lapse_count=1)
    )
    store.put_mastery(USER, row(2, "reviewing", last_review_date=date(2026, 10, 2)))
    store.put_mastery(USER, row(3, "confirmed"))
    record = read(adapter)
    assert [(p.reference, p.state) for p in record.passages] == [
        ("113:1-5", "needs_refresh"),
        ("112:1-4", "learning"),
        ("114:1-3", "reviewing"),
        ("114:4-6", "confirmed"),
    ]
    outcomes = {
        p.reference: [(o.date, o.passed) for o in p.review_outcomes] for p in record.passages
    }
    assert outcomes == {
        "113:1-5": [(date(2026, 10, 3), False)],  # the latest review failed
        "112:1-4": [],
        "114:1-3": [(date(2026, 10, 2), True)],
        "114:4-6": [],
    }


def test_a_passage_outside_the_scope_of_the_plan_is_not_in_the_record() -> None:
    adapter, store = summary(plans=Plans(scope=(1,)))  # section 1 only: passage 0
    store.put_mastery(USER, row(0, "learning", consecutive_correct=1))
    store.put_mastery(USER, row(3, "learning", consecutive_correct=1))
    store.put_attempt(attempt(1, passage=3))
    record = read(adapter)
    assert [p.reference for p in record.passages] == ["112:1-4"] and record.attempts == []


def test_error_parts_are_part_references_counted_from_wrong_answers() -> None:
    adapter, store = summary()
    first, second = part_id(0, 0), part_id(0, 1)
    store.put_mastery(
        USER, row(0, "learning", consecutive_correct=0, error_part_ids=(first, second))
    )
    wrong = question_covering(0, 0)["id"]
    store.put_attempt(attempt(1, 0, wrong, correct=False, error_kind="wrong_word"))
    store.put_attempt(attempt(2, 0, wrong, correct=False, error_kind="wrong_word"))
    store.put_attempt(attempt(3, 0, wrong, correct=True))  # a right answer is no error
    record = read(adapter)
    assert [(e.reference, e.error_count) for e in record.error_parts] == [
        ("112:1-4 (part 1)", 2),
        ("112:1-4 (part 2)", 1),  # listed with errors, none among the attempts: at least 1
    ]


def test_recent_attempts_keep_the_type_the_reference_and_the_utc_date() -> None:
    adapter, store = summary()
    ordered = question_covering(1, 0)
    dubai_after_midnight = datetime(2026, 10, 4, 1, 30, tzinfo=timezone(timedelta(hours=4)))
    store.put_attempt(
        attempt(
            1, 1, ordered["id"], correct=False, assisted=True, error_kind="wrong_word",
            when=dubai_after_midnight,
        )
    )  # fmt: skip
    store.put_attempt(
        attempt(2, 0, str(uuid.UUID(int=5)), when=datetime(2026, 10, 4, 6, tzinfo=UTC))
    )
    record = read(adapter)
    seen = [
        (a.question_type, a.reference, a.correct, a.assisted, a.error_kind, a.date)
        for a in record.attempts
    ]
    assert seen == [
        ("unknown", "112:1-4", True, False, None, date(2026, 10, 4)),  # a question the bank lost
        # 01:30 on 4 October in Dubai is 21:30 UTC on 3 October: the date is the UTC one
        (ordered["type"], "113:1-5", False, True, "wrong_word", date(2026, 10, 3)),
    ]


def test_only_the_newest_fifty_attempts_are_kept() -> None:
    adapter, store = summary()
    for n in range(60):
        store.put_attempt(attempt(n, error_kind=f"kind-{n}"))
    record = read(adapter)
    assert {a.error_kind for a in record.attempts} == {f"kind-{n}" for n in range(10, 60)}


def test_daily_time_is_filled_when_the_repository_has_the_method() -> None:
    store = StoreWithDailyProgress()
    assert isinstance(store, DailyProgressSource)
    first_day = TODAY - timedelta(days=29)
    for day, minutes in [
        (first_day - timedelta(days=1), 12),  # before the 30-day window
        (first_day, 7),
        (TODAY - timedelta(days=3), 10),
        (TODAY - timedelta(days=2), 0.4),  # under half a minute: not a day of study
        (TODAY - timedelta(days=1), 2.5),
        (TODAY, 25),
        (TODAY + timedelta(days=1), 9),  # a day that has not happened
    ]:
        store.put_daily_progress(
            DailyProgressRow(USER, day, active_ms=int(minutes * 60_000), goal_ms=300_000)
        )
    adapter, _ = summary(store)
    record = read(adapter)
    assert [(d.date, d.active_minutes) for d in record.daily_time] == [
        (first_day, 7),
        (TODAY - timedelta(days=3), 10),
        (TODAY - timedelta(days=1), 3),  # 2.5 minutes round up
        (TODAY, 25),
    ]


class LearningWithoutDailyProgress:
    """A learning repository that offers only what the record always needs (no optional method)."""

    def __init__(self, store: InMemoryLearningStore) -> None:
        self._store = store

    def mastery_for_plan(self, context: Any, plan_id: UUID) -> dict[UUID, PassageMastery]:
        return self._store.mastery_for_plan(context, plan_id)

    def attempts_for_passages(self, context: Any, passage_ids: Any) -> list[AttemptRecord]:
        return self._store.attempts_for_passages(context, passage_ids)


def test_daily_time_is_empty_when_the_repository_lacks_the_method() -> None:
    store = StoreWithDailyProgress()
    store.put_daily_progress(DailyProgressRow(USER, TODAY, active_ms=600_000, goal_ms=300_000))
    store.put_mastery(USER, row(0, "learning", consecutive_correct=1))
    plain = LearningWithoutDailyProgress(store)
    assert not isinstance(plain, DailyProgressSource)
    adapter = PlanChatLearningSummary(
        CONTEXT,
        plans=Plans(),
        learning=plain,  # type: ignore[arg-type]
        bank=InMemoryBankRepository([QURAN]),
    )
    record = read(adapter)
    assert record.daily_time == []
    assert [p.reference for p in record.passages] == ["112:1-4"]  # the rest is unaffected


def test_another_learners_progress_is_never_read() -> None:
    store = StoreWithDailyProgress()
    stranger = uuid.UUID(int=77)
    store.put_daily_progress(DailyProgressRow(stranger, TODAY, active_ms=600_000, goal_ms=1))
    adapter, _ = summary(store)
    assert read(adapter).daily_time == []


def test_a_demo_account_sends_nothing_of_its_own_record_and_reads_nothing() -> None:
    class Forbidden:
        def __getattr__(self, name: str) -> Any:
            raise AssertionError(f"the demo record must not touch the repositories: {name}")

    adapter = PlanChatLearningSummary(
        CONTEXT,
        plans=Forbidden(),
        learning=Forbidden(),
        bank=Forbidden(),  # type: ignore[arg-type]
    )
    assert adapter.summary_for(USER, PLAN_ID, is_demo=True) == LearningSummary()


def test_the_user_must_be_the_one_of_the_session() -> None:
    adapter, _ = summary()
    with pytest.raises(AppError) as caught:
        adapter.summary_for(uuid.UUID(int=9), PLAN_ID, is_demo=False)
    assert caught.value.code is ErrorCode.internal


def test_an_unknown_plan_has_an_empty_record() -> None:
    adapter, _ = summary()
    assert adapter.summary_for(USER, uuid.UUID(int=3), is_demo=False) == LearningSummary()


def test_an_edition_that_is_no_longer_readable_leaves_only_the_daily_time() -> None:
    bank = InMemoryBankRepository([QURAN])
    store = StoreWithDailyProgress()
    store.put_daily_progress(DailyProgressRow(USER, TODAY, active_ms=300_000, goal_ms=300_000))
    store.put_mastery(USER, row(0, "learning", consecutive_correct=1))
    store.put_attempt(attempt(1))
    bank.set_status(QURAN_EDITION, "revoked")
    adapter, _ = summary(store, bank=bank)
    record = read(adapter)
    assert (record.passages, record.error_parts, record.attempts) == ([], [], [])
    assert [(d.date, d.active_minutes) for d in record.daily_time] == [(TODAY, 5)]


def test_the_passage_and_error_part_lists_are_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "MAX_PASSAGE_ITEMS", 2)
    monkeypatch.setattr(module, "MAX_ERROR_PART_ITEMS", 1)
    adapter, store = summary()
    parts = (part_id(0, 0), part_id(1, 0))
    store.put_mastery(USER, row(0, "learning", error_part_ids=(parts[0],)))
    store.put_mastery(USER, row(1, "needs_refresh", error_part_ids=(parts[1],)))
    store.put_mastery(USER, row(2, "reviewing"))
    store.put_mastery(USER, row(3, "confirmed"))
    wrong = question_covering(1, 0)["id"]
    store.put_attempt(attempt(1, 1, wrong, correct=False))
    store.put_attempt(attempt(2, 1, wrong, correct=False))  # two errors against one
    record = read(adapter)
    assert [p.state for p in record.passages] == ["needs_refresh", "learning"]  # the urgent ones
    assert [e.reference for e in record.error_parts] == ["113:1-5 (part 1)"]  # the highest count


def test_the_record_holds_references_and_dates_only() -> None:
    store = StoreWithDailyProgress()
    adapter, _ = summary(store)
    store.put_mastery(USER, row(0, "learning", error_part_ids=(part_id(0, 0),)))
    store.put_attempt(attempt(1, 0, question_covering(0, 0)["id"], correct=False))
    store.put_daily_progress(DailyProgressRow(USER, TODAY, active_ms=300_000, goal_ms=300_000))
    record = read(adapter)
    assert record.passages and record.error_parts and record.attempts and record.daily_time
    dumped = record.model_dump_json(by_alias=True)
    assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", dumped)
    assert str(USER) not in dumped and str(SESSION_ID) not in dumped
    assert set(record.model_dump(by_alias=True)) == {
        "passages",
        "errorParts",
        "dailyTime",
        "attempts",
    }


def test_the_empty_summary_is_an_empty_record() -> None:
    assert EmptyLearningSummary().summary_for(USER, PLAN_ID, is_demo=False) == LearningSummary()
