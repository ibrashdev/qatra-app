"""The learning repositories of package B6: one behaviour, two implementations (memory and PostgREST
through the fake of ``app_apply_events`` and ``app_complete_session``). The reads that E18 to E22
need, the atomic write of an E21 request and the completion of a session."""

from __future__ import annotations

import copy
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from app.domain.learning_state import ActivityInterval, PassageMastery
from app.errors import AppError, ErrorCode
from app.repositories.learning import (
    ApplyResult,
    AttemptWrite,
    DailyWrite,
    EvidenceWrite,
    InMemoryLearningStore,
    IntervalWrite,
    PostgrestLearningRepository,
    StoredSession,
)
from tests.sessions.ss_learning_support import (
    LEARNER,
    PART,
    PASSAGE,
    Harness,
    attempt,
    mastery,
    new_session,
)
from tests.sessions.ss_postgrest import FakePostgrest
from tests.sessions.ss_support import (
    NOW,
    OTHER_USER,
    PLAN_ID,
    QURAN_EDITION,
    TODAY,
    USER,
)

DAY = timedelta(days=1)
STAMP = datetime(2026, 10, 5, 8, tzinfo=UTC)


@pytest.fixture(params=["memory", "postgrest"])
def harness(request: pytest.FixtureRequest) -> Harness:
    if request.param == "memory":
        store = InMemoryLearningStore(clock=lambda: STAMP)
        return Harness("memory", store, store=store)
    fake = FakePostgrest()
    return Harness("postgrest", PostgrestLearningRepository(fake.client(), in_chunk=2), fake=fake)


# --- seeding that the shared harness does not offer ----------------------------------------------


def interval(n: int, *, session: UUID, day: date = TODAY, user: UUID = USER) -> ActivityInterval:
    return ActivityInterval(
        id=UUID(f"aaaaaaaa-0000-4000-8000-{n:012d}"),
        user_id=user,
        session_id=session,
        client_event_id=UUID(f"bbbbbbbb-0000-4000-8000-{n:012d}"),
        started_at=NOW + timedelta(seconds=10 * n),
        ended_at=NOW + timedelta(seconds=10 * n + 5),
        active_ms=5000,
        learning_date=day,
        created_at=NOW + timedelta(seconds=n),
    )


def seed_interval(harness: Harness, row: ActivityInterval) -> None:
    if harness.store is not None:
        harness.store.put_interval(row)
        return
    assert harness.fake is not None
    harness.fake.tables["session_activity_intervals"].append(
        {
            "id": str(row.id),
            "user_id": str(row.user_id),
            "session_id": str(row.session_id),
            "client_event_id": str(row.client_event_id),
            "started_at": row.started_at.isoformat(),
            "ended_at": row.ended_at.isoformat(),
            "active_ms": row.active_ms,
            "learning_date": row.learning_date.isoformat(),
            "created_at": row.created_at.isoformat(),
        }
    )


def seed_completion(harness: Harness, day: date, *, user: UUID = USER) -> None:
    if harness.store is not None:
        harness.store.put_completion(user, day, PLAN_ID)
        return
    assert harness.fake is not None
    harness.fake.tables["daily_completions"].append(
        {
            "user_id": str(user),
            "learning_date": day.isoformat(),
            "reached_in_plan_id": str(PLAN_ID),
            "completed_at": NOW.isoformat(),
        }
    )


def seed_foreign_session(harness: Harness, session_id: UUID) -> None:
    if harness.store is not None:
        harness.store.sessions[session_id] = StoredSession(
            id=session_id,
            user_id=OTHER_USER,
            plan_id=None,
            plan_version_id=None,
            plan_version=None,
            edition_id=QURAN_EDITION,
            kind="game",
            learning_date=TODAY,
            lesson_refs=(),
            question_refs=(),
            steps=[],
            bank_version=1,
            status="open",
            created_at=NOW,
        )
        return
    assert harness.fake is not None
    harness.fake.tables["learning_sessions"].append(
        {
            "id": str(session_id),
            "user_id": str(OTHER_USER),
            "plan_id": None,
            "plan_version_id": None,
            "edition_id": str(QURAN_EDITION),
            "kind": "game",
            "learning_date": TODAY.isoformat(),
            "lesson_refs": [],
            "question_refs": [],
            "steps": [],
            "bank_version": 1,
            "self_rating": None,
            "status": "open",
            "elapsed_ms": 0,
            "offline_snapshot_id": None,
            "created_at": NOW.isoformat(),
        }
    )


def open_game(harness: Harness, n: int = 1) -> UUID:
    return harness.repo.open_session(LEARNER, new_session(n, kind="game")).session_id


def attempt_write(
    n: int,
    *,
    passage: UUID = PASSAGE,
    correct: bool = True,
    assisted: bool = False,
    state: PassageMastery | None = None,
    evidence: tuple[EvidenceWrite, ...] = (),
) -> AttemptWrite:
    return AttemptWrite(
        client_event_id=UUID(f"99999999-9999-4999-8999-{n:012d}"),
        question_id=UUID(f"77777777-7777-4777-8777-{n:012d}"),
        passage_id=passage,
        correct=correct,
        assisted=assisted,
        error_kind="none" if correct else "wrong_choice",
        duration_ms=2500,
        occurred_at=NOW + timedelta(seconds=n),
        wrong_token_ref=None if correct else "3:1",
        mastery=state,
        evidence=evidence,
    )


def interval_write(n: int, *, seconds: int = 60, day: date = TODAY) -> IntervalWrite:
    start = NOW + timedelta(seconds=1000 * n)
    return IntervalWrite(
        client_event_id=UUID(f"cccccccc-0000-4000-8000-{n:012d}"),
        started_at=start,
        ended_at=start + timedelta(seconds=seconds),
        active_ms=seconds * 1000,
        learning_date=day,
    )


def evidence_for(*parts: UUID, day: date = TODAY) -> tuple[EvidenceWrite, ...]:
    return tuple(EvidenceWrite(PLAN_ID, PASSAGE, part, day) for part in parts)


def refused(call) -> AppError:
    with pytest.raises(AppError) as raised:
        call()
    return raised.value


def state_of(harness: Harness) -> dict[str, Any]:
    """Every learner table, to compare before and after a refused call."""
    if harness.store is not None:
        store = harness.store
        return copy.deepcopy(
            {
                "sessions": store.sessions,
                "attempts": store.attempts,
                "intervals": store.intervals,
                "mastery": store.mastery,
                "evidence": store.evidence,
                "daily": store.daily_progress,
                "completions": store.completions,
            }
        )
    assert harness.fake is not None
    return copy.deepcopy(harness.fake.tables)


# --- reads ---------------------------------------------------------------------------------------


def test_daily_progress_between_is_inclusive_ascending_and_the_callers_own(
    harness: Harness,
) -> None:
    for offset, active in ((6, 600), (5, 500), (3, 300), (0, 100), (-1, 99)):
        harness.seed_daily(USER, TODAY - offset * DAY, active)
    harness.seed_daily(OTHER_USER, TODAY - 3 * DAY, 9999)
    rows = harness.repo.daily_progress_between(LEARNER, TODAY - 5 * DAY, TODAY)
    assert [(r.learning_date, r.active_ms, r.goal_ms) for r in rows] == [
        (TODAY - 5 * DAY, 500, 600_000),
        (TODAY - 3 * DAY, 300, 600_000),
        (TODAY, 100, 600_000),
    ]
    assert all(r.user_id == USER for r in rows)


def test_a_single_day_window_and_an_empty_or_inverted_one(harness: Harness) -> None:
    harness.seed_daily(USER, TODAY, 100)
    assert [r.active_ms for r in harness.repo.daily_progress_between(LEARNER, TODAY, TODAY)] == [
        100
    ]
    assert harness.repo.daily_progress_between(LEARNER, TODAY + DAY, TODAY + DAY) == []
    sent = len(harness.fake.requests) if harness.fake is not None else 0
    assert harness.repo.daily_progress_between(LEARNER, TODAY, TODAY - DAY) == []
    if harness.fake is not None:
        assert len(harness.fake.requests) == sent  # an inverted window never reaches the database


def test_daily_progress_between_reads_more_rows_than_one_page(harness: Harness) -> None:
    for offset in range(1, 151):
        harness.seed_daily(USER, TODAY - offset * DAY, offset)
    rows = harness.repo.daily_progress_between(LEARNER, TODAY - 150 * DAY, TODAY - DAY)
    assert len(rows) == 150 and rows[0].learning_date == TODAY - 150 * DAY
    assert [r.learning_date for r in rows] == sorted(r.learning_date for r in rows)


def test_completion_dates_by_window_and_owner(harness: Harness) -> None:
    for offset in (0, 1, 2, 9):
        seed_completion(harness, TODAY - offset * DAY)
    seed_completion(harness, TODAY - 3 * DAY, user=OTHER_USER)
    assert harness.repo.completion_dates(LEARNER, TODAY - 2 * DAY, TODAY) == {
        TODAY,
        TODAY - DAY,
        TODAY - 2 * DAY,
    }
    assert harness.repo.completion_dates(LEARNER, TODAY - 3 * DAY, TODAY - 3 * DAY) == frozenset()
    sent = len(harness.fake.requests) if harness.fake is not None else 0
    assert harness.repo.completion_dates(LEARNER, TODAY, TODAY - DAY) == frozenset()
    if harness.fake is not None:
        assert len(harness.fake.requests) == sent


def test_attempts_for_session_are_the_sessions_own_oldest_first(harness: Harness) -> None:
    session = open_game(harness)
    other = open_game(harness, 2)
    for n, owner in ((3, session), (1, session), (2, other), (4, session)):
        harness.seed_attempt(replace(attempt(n), session_id=owner))
    harness.seed_attempt(replace(attempt(5, user=OTHER_USER), session_id=session))
    found = harness.repo.attempts_for_session(LEARNER, session)
    assert [a.client_event_id.int & 0xFFFF for a in found] == [1, 3, 4]
    assert all(a.session_id == session and a.user_id == USER for a in found)
    assert found[0].correct is True and found[1].correct is True  # attempts 1 and 3 are odd


def test_acknowledged_event_ids_cover_attempts_and_intervals_of_the_caller_only(
    harness: Harness,
) -> None:
    session = open_game(harness)
    for n in (1, 2, 3):
        harness.seed_attempt(replace(attempt(n), session_id=session))
    seed_interval(harness, interval(4, session=session))
    seed_interval(harness, interval(5, session=session, user=OTHER_USER))
    harness.seed_attempt(attempt(6, user=OTHER_USER))
    ids = [UUID(f"99999999-9999-4999-8999-{n:012d}") for n in (1, 2, 3, 6, 7)] + [
        UUID("bbbbbbbb-0000-4000-8000-000000000004"),
        UUID("bbbbbbbb-0000-4000-8000-000000000005"),
    ]
    known = harness.repo.acknowledged_event_ids(LEARNER, ids + ids[:2])  # a repeated id is fine
    assert known == {ids[0], ids[1], ids[2], ids[5]}
    assert harness.repo.acknowledged_event_ids(LEARNER, []) == frozenset()


def test_intervals_by_date_and_by_session(harness: Harness) -> None:
    one, two = open_game(harness), open_game(harness, 2)
    seed_interval(harness, interval(2, session=one))
    seed_interval(harness, interval(1, session=one))
    seed_interval(harness, interval(3, session=two, day=TODAY + DAY))
    seed_interval(harness, interval(4, session=one, user=OTHER_USER))
    by_day = harness.repo.intervals_for_date(LEARNER, TODAY)
    assert sorted(i.active_ms for i in by_day) == [5000, 5000] and len(by_day) == 2
    assert {i.session_id for i in by_day} == {one}
    assert [i.session_id for i in harness.repo.intervals_for_date(LEARNER, TODAY + DAY)] == [two]
    mine = harness.repo.intervals_for_session(LEARNER, one)
    assert [i.client_event_id.int & 0xFFFF for i in mine] == [1, 2]  # oldest start first
    assert all(i.user_id == USER and i.learning_date == TODAY for i in mine)
    assert harness.repo.intervals_for_date(LEARNER, TODAY - DAY) == []


# --- apply_events --------------------------------------------------------------------------------


def test_an_attempt_is_recorded_with_its_mastery_and_its_evidence(harness: Harness) -> None:
    session = open_game(harness)
    state = mastery(
        status="learning",
        consecutive_correct=1,
        initial_success_at=None,
        initial_learning_date=None,
        review_stage=0,
        next_review_due=None,
        error_part_ids=(),
    )
    write = attempt_write(1, state=state, evidence=evidence_for(PART))
    result = harness.repo.apply_events(LEARNER, session, [write], None, open_session=False)
    assert result == ApplyResult(("acknowledged",), False)
    [row] = harness.repo.attempts_for_session(LEARNER, session)
    assert (row.client_event_id, row.question_id, row.passage_id) == (
        write.client_event_id,
        write.question_id,
        write.passage_id,
    )
    assert (row.correct, row.assisted, row.error_kind, row.duration_ms) == (
        True,
        False,
        "none",
        2500,
    )
    assert row.occurred_at == write.occurred_at and row.wrong_token_ref is None
    assert harness.repo.mastery_for_plan(LEARNER, PLAN_ID) == {PASSAGE: state}
    assert harness.repo.covered_parts(LEARNER, PLAN_ID) == {PART}


def test_a_wrong_answer_keeps_its_error_kind_and_token_reference(harness: Harness) -> None:
    session = open_game(harness)
    write = attempt_write(1, correct=False)
    harness.repo.apply_events(LEARNER, session, [write], None, open_session=False)
    [row] = harness.repo.attempts_for_session(LEARNER, session)
    assert (row.correct, row.error_kind, row.wrong_token_ref) == (False, "wrong_choice", "3:1")


def test_an_element_without_mastery_leaves_the_state_alone(harness: Harness) -> None:
    session = open_game(harness)
    harness.seed_mastery(USER, mastery())
    harness.repo.apply_events(LEARNER, session, [attempt_write(1)], None, open_session=False)
    assert harness.repo.mastery_for_plan(LEARNER, PLAN_ID) == {PASSAGE: mastery()}
    assert harness.repo.covered_parts(LEARNER, PLAN_ID) == frozenset()


def test_an_event_id_that_is_recorded_is_a_duplicate_and_writes_nothing(harness: Harness) -> None:
    session = open_game(harness)
    write, again = attempt_write(1, state=mastery()), attempt_write(1, correct=False)
    harness.repo.apply_events(LEARNER, session, [write], None, open_session=False)
    before = state_of(harness)
    result = harness.repo.apply_events(LEARNER, session, [again], None, open_session=False)
    assert result.outcomes == ("duplicate",)
    assert state_of(harness) == before  # the second payload is ignored whatever it says
    [row] = harness.repo.attempts_for_session(LEARNER, session)
    assert row.correct is True


def test_a_repeated_id_inside_one_call_is_acknowledged_once(harness: Harness) -> None:
    session = open_game(harness)
    write = attempt_write(1)
    both = [write, interval_write(1), write, interval_write(1)]
    result = harness.repo.apply_events(LEARNER, session, both, None, open_session=False)
    assert result.outcomes == ("acknowledged", "acknowledged", "duplicate", "duplicate")
    assert len(harness.repo.attempts_for_session(LEARNER, session)) == 1
    assert len(harness.repo.intervals_for_session(LEARNER, session)) == 1


def test_an_id_recorded_in_another_session_of_the_account_is_a_duplicate(harness: Harness) -> None:
    one, two = open_game(harness), open_game(harness, 2)
    harness.repo.apply_events(LEARNER, one, [attempt_write(1)], None, open_session=False)
    result = harness.repo.apply_events(LEARNER, two, [attempt_write(1)], None, open_session=False)
    assert result.outcomes == ("duplicate",)
    assert harness.repo.attempts_for_session(LEARNER, two) == []


def test_the_mastery_row_is_replaced_by_the_latest_element(harness: Harness) -> None:
    session = open_game(harness)
    first = mastery(
        consecutive_correct=1,
        status="learning",
        initial_success_at=None,
        initial_learning_date=None,
        review_stage=0,
        next_review_due=None,
        error_part_ids=(),
    )
    second = mastery(
        consecutive_correct=2,
        status="learning",
        initial_success_at=None,
        initial_learning_date=None,
        review_stage=0,
        next_review_due=None,
        error_part_ids=(PART,),
    )
    harness.repo.apply_events(
        LEARNER,
        session,
        [attempt_write(1, state=first), attempt_write(2, state=second)],
        None,
        open_session=False,
    )
    assert harness.repo.mastery_for_plan(LEARNER, PLAN_ID) == {PASSAGE: second}


def test_a_part_has_evidence_once_per_plan_and_keeps_the_first_attempt(harness: Harness) -> None:
    session = open_game(harness)
    other_part = UUID("77777777-7777-4777-8777-000000000002")
    first = attempt_write(1, state=mastery(), evidence=evidence_for(PART))
    second = attempt_write(
        2, state=mastery(), evidence=evidence_for(PART, other_part, day=TODAY + DAY)
    )
    harness.repo.apply_events(LEARNER, session, [first, second], None, open_session=False)
    assert harness.repo.covered_parts(LEARNER, PLAN_ID) == {PART, other_part}
    rows = (
        list(harness.store.evidence.values())
        if harness.store is not None
        else harness.fake.tables["target_part_evidence"]  # type: ignore[union-attr]
    )
    assert len(rows) == 2
    by_part = {str(r.part_id if hasattr(r, "part_id") else r["part_id"]): r for r in rows}
    kept = by_part[str(PART)]
    day = kept.learning_date if hasattr(kept, "learning_date") else kept["learning_date"]
    assert str(day) == TODAY.isoformat()  # the first evidence of the part is kept as it was


def test_an_interval_is_recorded_with_its_day(harness: Harness) -> None:
    session = open_game(harness)
    write = interval_write(1, seconds=90, day=TODAY + DAY)
    result = harness.repo.apply_events(LEARNER, session, [write], None, open_session=False)
    assert result.outcomes == ("acknowledged",)
    [row] = harness.repo.intervals_for_session(LEARNER, session)
    assert (row.client_event_id, row.started_at, row.ended_at) == (
        write.client_event_id,
        write.started_at,
        write.ended_at,
    )
    assert (row.active_ms, row.learning_date, row.session_id) == (90_000, TODAY + DAY, session)


def test_the_daily_row_never_decreases_and_takes_the_goal_of_the_last_write(
    harness: Harness,
) -> None:
    session = open_game(harness)
    apply = harness.repo.apply_events
    apply(LEARNER, session, [], DailyWrite(TODAY, 300_000, 600_000), open_session=False)
    apply(LEARNER, session, [], DailyWrite(TODAY, 100_000, 900_000), open_session=False)  # stale
    [row] = harness.repo.daily_progress_between(LEARNER, TODAY, TODAY)
    assert (row.active_ms, row.goal_ms) == (300_000, 900_000)
    apply(LEARNER, session, [], DailyWrite(TODAY, 450_000, 900_000), open_session=False)
    assert harness.repo.daily_progress_between(LEARNER, TODAY, TODAY)[0].active_ms == 450_000


def test_the_completion_of_a_date_is_written_once_and_reported_once(harness: Harness) -> None:
    session = open_game(harness)
    reached = DailyWrite(TODAY, 600_000, 600_000, completed=True, reached_in_plan_id=PLAN_ID)
    first = harness.repo.apply_events(LEARNER, session, [], reached, open_session=False)
    again = harness.repo.apply_events(LEARNER, session, [], reached, open_session=False)
    assert (first.completion_inserted, again.completion_inserted) == (True, False)
    assert harness.repo.completion_dates(LEARNER, TODAY, TODAY) == {TODAY}


def test_a_daily_write_without_a_completion_request_writes_none(harness: Harness) -> None:
    session = open_game(harness)
    result = harness.repo.apply_events(
        LEARNER, session, [], DailyWrite(TODAY, 700_000, 600_000), open_session=False
    )
    assert result.completion_inserted is False
    assert harness.repo.completion_dates(LEARNER, TODAY, TODAY) == frozenset()


def prepared(harness: Harness) -> UUID:
    session = open_game(harness)
    if harness.store is not None:
        harness.store.sessions[session] = replace(
            harness.store.sessions[session], status="prepared"
        )
    else:
        assert harness.fake is not None
        row = next(r for r in harness.fake.tables["learning_sessions"] if r["id"] == str(session))
        row["status"] = "prepared"
    return session


def test_open_session_opens_a_prepared_session_and_only_when_asked(harness: Harness) -> None:
    session = prepared(harness)
    harness.repo.apply_events(LEARNER, session, [attempt_write(1)], None, open_session=False)
    assert harness.repo.read_session(LEARNER, session).status == "prepared"  # type: ignore[union-attr]
    harness.repo.apply_events(LEARNER, session, [attempt_write(2)], None, open_session=True)
    assert harness.repo.read_session(LEARNER, session).status == "open"  # type: ignore[union-attr]


def test_open_session_does_not_reopen_a_completed_session(harness: Harness) -> None:
    session = open_game(harness)
    harness.repo.complete_session(LEARNER, session, 1000)
    harness.repo.apply_events(LEARNER, session, [attempt_write(1)], None, open_session=True)
    assert harness.repo.read_session(LEARNER, session).status == "completed"  # type: ignore[union-attr]


def test_an_unknown_or_foreign_session_is_not_found_and_nothing_is_written(
    harness: Harness,
) -> None:
    foreign = UUID(int=424242)
    seed_foreign_session(harness, foreign)
    before = state_of(harness)
    for target in (UUID(int=777), foreign):
        error = refused(
            lambda t=target: harness.repo.apply_events(
                LEARNER, t, [attempt_write(1)], DailyWrite(TODAY, 1, 600_000), open_session=False
            )
        )
        assert error.code is ErrorCode.not_found
    assert state_of(harness) == before


def test_an_empty_call_with_a_daily_row_writes_just_the_row(harness: Harness) -> None:
    session = open_game(harness)
    result = harness.repo.apply_events(
        LEARNER, session, [], DailyWrite(TODAY, 5000, 600_000), open_session=False
    )
    assert result == ApplyResult((), False)
    assert harness.repo.daily_progress_between(LEARNER, TODAY, TODAY)[0].active_ms == 5000


# --- a refused element rolls the whole call back (one transaction) -------------------------------

BAD_STATE = mastery(status="confirmed", confirmed_at=None)  # breaks a CHECK of target_mastery


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(lambda: attempt_write(9, state=BAD_STATE), id="mastery check"),
        pytest.param(
            lambda: replace(
                interval_write(9), active_ms=1_800_001, ended_at=NOW + timedelta(hours=1)
            ),
            id="interval longer than 30 minutes",
        ),
        pytest.param(
            lambda: replace(interval_write(9, seconds=10), active_ms=12_000),
            id="active time above the span",
        ),
        pytest.param(
            lambda: replace(interval_write(9, seconds=10), active_ms=-1), id="negative active time"
        ),
    ],
)
def test_a_refused_element_leaves_nothing_behind(harness: Harness, bad: Any) -> None:
    session = open_game(harness)
    before = state_of(harness)
    error = refused(
        lambda: harness.repo.apply_events(
            LEARNER,
            session,
            [
                attempt_write(1, state=mastery(), evidence=evidence_for(PART)),
                interval_write(1),
                bad(),
            ],
            DailyWrite(TODAY, 60_000, 600_000, completed=True, reached_in_plan_id=PLAN_ID),
            open_session=False,
        )
    )
    assert error.code is ErrorCode.unavailable
    assert state_of(harness) == before
    assert harness.repo.attempts_for_session(LEARNER, session) == []


def test_a_refused_daily_row_rolls_the_events_back_too(harness: Harness) -> None:
    session = open_game(harness)
    before = state_of(harness)
    error = refused(
        lambda: harness.repo.apply_events(
            LEARNER, session, [attempt_write(1)], DailyWrite(TODAY, 10, 0), open_session=False
        )
    )
    assert error.code is ErrorCode.unavailable and state_of(harness) == before


def test_a_completion_without_the_plan_that_reached_it_is_refused(harness: Harness) -> None:
    session = open_game(harness)
    before = state_of(harness)
    bad = DailyWrite(TODAY, 600_000, 600_000, completed=True, reached_in_plan_id=None)
    error = refused(
        lambda: harness.repo.apply_events(LEARNER, session, [], bad, open_session=False)
    )
    assert error.code is ErrorCode.unavailable and state_of(harness) == before


# --- complete_session ----------------------------------------------------------------------------


def test_complete_session_is_true_once_and_stores_the_time(harness: Harness) -> None:
    session = open_game(harness)
    assert harness.repo.complete_session(LEARNER, session, 123_000) is True
    stored = harness.repo.read_session(LEARNER, session)
    assert stored is not None and (stored.status, stored.elapsed_ms) == ("completed", 123_000)
    assert harness.repo.complete_session(LEARNER, session, 999_000) is False  # nothing changes
    again = harness.repo.read_session(LEARNER, session)
    assert again is not None and again.elapsed_ms == 123_000


def test_a_prepared_session_can_be_completed(harness: Harness) -> None:
    session = prepared(harness)
    assert harness.repo.complete_session(LEARNER, session, 0) is True
    assert harness.repo.read_session(LEARNER, session).status == "completed"  # type: ignore[union-attr]


def test_complete_session_of_an_unknown_or_foreign_session_is_not_found(harness: Harness) -> None:
    foreign = UUID(int=424243)
    seed_foreign_session(harness, foreign)
    for target in (UUID(int=778), foreign):
        error = refused(lambda t=target: harness.repo.complete_session(LEARNER, t, 1))
        assert error.code is ErrorCode.not_found


def test_a_negative_elapsed_time_is_refused(harness: Harness) -> None:
    session = open_game(harness)
    error = refused(lambda: harness.repo.complete_session(LEARNER, session, -1))
    assert error.code is ErrorCode.unavailable
    assert harness.repo.read_session(LEARNER, session).status == "open"  # type: ignore[union-attr]
