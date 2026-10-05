"""E21 review rounds (contract §4.3 to §4.5, D66): a round is judged when its last question has its
first attempt, the ladder moves one stage per learning date, and the coordinator decisions 3, 5 and
6 hold through the service. Every scenario runs over the memory repositories and over the PostgREST
adapters."""

from __future__ import annotations

from collections.abc import Collection
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from uuid import UUID

import pytest

from tests.sessions.ss_events_support import (
    BASE,
    FIRST_PASSAGE,
    MODES,
    PART_IDS,
    Opened,
    World,
    answer_event,
    due_row,
    envelope_of,
    parts_covered_by,
)
from tests.sessions.ss_support import TODAY

DAY = timedelta(days=1)
PARTS = PART_IDS[str(FIRST_PASSAGE)]  # four parts: the review round tests two of them
CONFIRMED_AT = datetime(2026, 9, 21, 9, tzinfo=UTC)


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    return World(request.param)


def due_session(world: World, **mastery: Any) -> Opened:
    """A daily session with the review round of the first passage, due since the given state."""
    world.seed_mastery(due_row(FIRST_PASSAGE, **mastery))
    return world.open("daily")


def round_of(session: Opened) -> list[dict[str, Any]]:
    questions = session.of(role="review", passage=FIRST_PASSAGE)
    assert len(questions) == 2
    return questions


def answers(
    questions: list[dict[str, Any]], *, wrong: Collection[int] = (), hinted: Collection[int] = ()
) -> list[dict[str, Any]]:
    """Events for the questions of a round: right unless the index is listed as wrong or hinted."""
    return [answer_event(q, ok=i not in wrong, hint=i in hinted) for i, q in enumerate(questions)]


def go_to(world: World, day: date) -> None:
    """Move the calendar and the clock to 07:00 UTC (11:00 in Dubai) of a learning date."""
    world.calendar.today = day
    world.clock.now = datetime.combine(day, time(7), UTC)


def move_to_next_day(world: World) -> None:
    go_to(world, world.calendar.today + DAY)


def state(world: World):
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None
    return row


# --- the round is judged when it is complete (§4.3) ----------------------------------------------


@pytest.mark.parametrize(
    ("stage", "days"), [(1, 2), (2, 4)], ids=["stage 1 to 2 after 2 days", "stage 2 to 3 after 4"]
)
def test_a_passed_round_moves_the_passage_up_one_stage(world: World, stage: int, days: int) -> None:
    last = TODAY - DAY * (stage - 1) if stage > 1 else None
    session = due_session(world, review_stage=stage, last_review_date=last)
    body = world.post(session, answers(round_of(session)))
    assert [r["passage"]["status"] for r in body["results"]] == ["reviewing", "reviewing"]
    row = state(world)
    assert (row.status, row.review_stage, row.lapse_count) == ("reviewing", stage + 1, 0)
    assert row.last_review_date == TODAY and row.next_review_due == TODAY + DAY * days
    assert row.error_part_ids == ()


def test_the_clean_answers_of_a_round_give_the_parts_their_evidence(world: World) -> None:
    session = due_session(world)
    questions = round_of(session)
    world.post(session, answers(questions))
    assert world.covered() == {p for q in questions for p in parts_covered_by(q)}


def test_an_unfinished_round_is_not_judged_and_the_passage_stays_due(world: World) -> None:
    session = due_session(world)
    first, _ = round_of(session)
    world.post(session, [answer_event(first)])
    row = state(world)
    assert (row.review_stage, row.next_review_due, row.last_review_date) == (1, TODAY, None)
    assert row.is_due(TODAY)


def test_a_round_is_judged_by_the_request_that_completes_it(world: World) -> None:
    session = due_session(world)
    first, second = round_of(session)
    world.post(session, [answer_event(first)])
    world.post(session, [answer_event(second)])
    assert state(world).review_stage == 2


def test_a_wrong_answer_fails_the_round(world: World) -> None:
    session = due_session(world)
    questions = round_of(session)
    world.post(session, answers(questions, wrong={0}))
    row = state(world)
    assert (row.review_stage, row.lapse_count) == (1, 1)
    assert (row.last_review_date, row.next_review_due) == (TODAY, TODAY + DAY)
    assert row.error_part_ids == tuple(parts_covered_by(questions[0]))


def test_a_hint_fails_the_round_and_its_parts_join_the_error_parts(world: World) -> None:
    session = due_session(world)
    questions = round_of(session)
    world.post(session, answers(questions, hinted={0}))
    row = state(world)
    assert (row.review_stage, row.lapse_count) == (1, 1)
    assert row.error_part_ids == tuple(parts_covered_by(questions[0]))
    assert world.covered() == set(parts_covered_by(questions[1]))  # the hinted answer gave none


def test_a_failed_round_at_a_higher_stage_goes_back_to_stage_one(world: World) -> None:
    session = due_session(world, review_stage=2, last_review_date=TODAY - 2 * DAY)
    world.post(session, answers(round_of(session), wrong={1}))
    row = state(world)
    assert (row.review_stage, row.lapse_count, row.next_review_due) == (1, 1, TODAY + DAY)


def test_a_failed_round_keeps_the_evidence_and_the_initial_success(world: World) -> None:
    world.seed_evidence(FIRST_PASSAGE, PARTS[2:])
    session = due_session(world)
    before = state(world)
    world.post(session, answers(round_of(session), wrong={0, 1}))
    row = state(world)
    assert set(PARTS[2:]) <= world.covered()
    assert (row.initial_success_at, row.initial_learning_date) == (
        before.initial_success_at,
        before.initial_learning_date,
    )


def test_only_the_first_attempt_of_a_review_question_counts(world: World) -> None:
    session = due_session(world)
    first, second = round_of(session)
    body = world.post(
        session,
        [
            answer_event(first, ok=False),
            answer_event(first, at=BASE + timedelta(minutes=2)),  # the second attempt
            answer_event(second),
        ],
    )
    assert [r["passage"]["consecutiveCorrect"] for r in body["results"]] == [0, 0, 1]
    row = state(world)
    assert (row.review_stage, row.lapse_count) == (1, 1)  # the first attempt failed the round
    assert len(world.attempts(session)) == 3  # every attempt is recorded


def test_the_first_recorded_attempt_of_a_question_decides_the_round_across_requests(
    world: World,
) -> None:
    """The ids are chosen so that ordering by id alone would put the second attempt first."""
    session = due_session(world)
    first, second = round_of(session)
    early_id = UUID("ffffffff-ffff-4fff-8fff-ffffffffffff")
    late_id = UUID("00000000-0000-4000-8000-000000000001")
    world.post(session, [answer_event(first, ok=False, event_id=early_id)])
    world.post(session, [answer_event(first, event_id=late_id, at=BASE + timedelta(minutes=2))])
    world.post(session, [answer_event(second)])
    row = state(world)
    assert (row.review_stage, row.lapse_count) == (1, 1)


def test_a_judged_round_is_not_judged_again_by_a_later_attempt(world: World) -> None:
    session = due_session(world)
    questions = round_of(session)
    world.post(session, answers(questions))
    after = state(world)
    world.post(session, [answer_event(questions[0], ok=False)])
    row = state(world)
    assert (row.review_stage, row.next_review_due, row.lapse_count) == (
        after.review_stage,
        after.next_review_due,
        after.lapse_count,
    )
    assert row.consecutive_correct == after.consecutive_correct


# --- one stage per learning date (§4.3) ---------------------------------------------------------


def test_a_second_round_of_the_same_date_does_not_move_the_ladder_again(world: World) -> None:
    first = due_session(world)
    world.make_offline(first)  # a prepared session is replayed later, with its envelope
    second = world.open("daily")  # the passage is still due: a round of its own, same date
    world.post(second, answers(round_of(second)))
    assert state(world).review_stage == 2
    envelope = envelope_of(first)
    events = [answer_event(q, **envelope) for q in round_of(first)]
    assert len(world.post(first, events)["acknowledged"]) == 2
    row = state(world)
    assert (row.review_stage, row.next_review_due) == (2, TODAY + 2 * DAY)


def test_a_failed_round_of_the_date_of_the_last_round_still_resets_the_ladder(world: World) -> None:
    first = due_session(world)
    world.make_offline(first)
    second = world.open("daily")
    world.post(second, answers(round_of(second)))
    envelope = envelope_of(first)
    world.post(first, [answer_event(q, ok=False, **envelope) for q in round_of(first)])
    row = state(world)
    assert (row.review_stage, row.lapse_count, row.next_review_due) == (1, 1, TODAY + DAY)


# --- decision 5: a stale replay has no effect, and an early pass still advances ------------------


@pytest.mark.parametrize("passes", [True, False], ids=["a replayed pass", "a replayed failure"])
def test_decision5_a_replayed_round_of_an_earlier_date_has_no_effect_on_the_ladder(
    world: World, passes: bool
) -> None:
    first = due_session(world)  # the session of day 1 stays unplayed on a device
    world.make_offline(first)
    move_to_next_day(world)
    second = world.open("daily")  # day 2: the round is overdue and is taken now
    world.post(second, answers(round_of(second)))
    moved = state(world)
    assert (moved.review_stage, moved.last_review_date) == (2, TODAY + DAY)
    envelope = envelope_of(first)
    events = [
        answer_event(q, ok=passes or i != 0, **envelope) for i, q in enumerate(round_of(first))
    ]
    assert len(world.post(first, events)["acknowledged"]) == 2  # recorded in the history
    row = state(world)
    ladder = ("status", "review_stage", "next_review_due", "last_review_date", "lapse_count")
    assert [getattr(row, f) for f in ladder] == [getattr(moved, f) for f in ladder]


def test_decision5_a_pass_before_the_due_date_still_advances_one_stage(world: World) -> None:
    session = due_session(world)
    world.seed_mastery(
        due_row(
            FIRST_PASSAGE,
            review_stage=2,
            last_review_date=TODAY - DAY,
            next_review_due=TODAY + 2 * DAY,  # moved on by another round since the session
        )
    )
    world.post(session, answers(round_of(session)))
    row = state(world)
    assert (row.review_stage, row.next_review_due) == (3, TODAY + 4 * DAY)


# --- decision 3: stage 3 with an uncovered part stays at stage 3 ---------------------------------


def test_decision3_stage_three_with_uncovered_parts_stays_there_without_a_lapse(
    world: World,
) -> None:
    session = due_session(world, review_stage=3, last_review_date=TODAY - 4 * DAY)
    world.post(session, answers(round_of(session)))
    row = state(world)
    assert (row.status, row.review_stage, row.lapse_count) == ("reviewing", 3, 0)
    assert (row.last_review_date, row.next_review_due) == (TODAY, TODAY + DAY)
    assert row.confirmed_at is None and row.maintenance_stage == 0
    assert len(world.covered()) == 2 and len(PARTS) == 4


def test_decision3_the_next_round_takes_the_uncovered_parts_first_and_confirms(
    world: World,
) -> None:
    session = due_session(world, review_stage=3, last_review_date=TODAY - 4 * DAY)
    world.post(session, answers(round_of(session)))
    uncovered = set(PARTS) - world.covered()
    move_to_next_day(world)
    second = world.open("daily")
    questions = round_of(second)
    assert {p for q in questions for p in parts_covered_by(q)} == uncovered
    body = world.post(second, answers(questions))
    assert body["results"][-1]["passage"]["status"] == "confirmed"
    assert body["results"][-1]["passage"]["coveredParts"] == 4
    row = state(world)
    assert (row.status, row.maintenance_stage) == ("confirmed", 1)
    assert row.next_review_due == TODAY + DAY + 14 * DAY and row.lapse_count == 0
    assert row.confirmed_at == row.first_confirmed_at == world.clock.now


def test_decision3_a_round_that_completes_coverage_confirms_in_that_round(world: World) -> None:
    world.seed_evidence(FIRST_PASSAGE, PARTS[2:])  # the round covers the other two parts
    session = due_session(world, review_stage=3, last_review_date=TODAY - 4 * DAY)
    world.post(session, answers(round_of(session)))
    row = state(world)
    assert (row.status, row.maintenance_stage) == ("confirmed", 1)
    assert row.next_review_due == TODAY + 14 * DAY and row.last_review_date == TODAY


def test_decision3_a_failed_stage_three_round_is_a_lapse_not_a_stay(world: World) -> None:
    session = due_session(world, review_stage=3, last_review_date=TODAY - 4 * DAY)
    world.post(session, answers(round_of(session), wrong={0}))
    row = state(world)
    assert (row.review_stage, row.lapse_count, row.next_review_due) == (1, 1, TODAY + DAY)


# --- maintenance (§4.5) -----------------------------------------------------------------------


def maintenance(stage: int, **more: Any) -> dict[str, Any]:
    return {
        "status": "confirmed",
        "review_stage": 3,
        "maintenance_stage": stage,
        "confirmed_at": CONFIRMED_AT,
        "first_confirmed_at": CONFIRMED_AT,
        "last_review_date": TODAY - 14 * DAY,
        "next_review_due": TODAY,
        **more,
    }


@pytest.mark.parametrize(("stage", "days"), [(1, 30), (2, 60), (3, 60)])
def test_a_passed_maintenance_round_schedules_the_next_one(
    world: World, stage: int, days: int
) -> None:
    session = due_session(world, **maintenance(stage))
    world.post(session, answers(round_of(session)))
    row = state(world)
    assert (row.status, row.maintenance_stage) == ("confirmed", stage + 1)
    assert row.next_review_due == TODAY + days * DAY and row.confirmed_at == CONFIRMED_AT


def test_a_failed_maintenance_round_needs_a_refresh_and_keeps_the_first_confirmation(
    world: World,
) -> None:
    session = due_session(world, **maintenance(2))
    questions = round_of(session)
    world.post(session, answers(questions, wrong={0}))
    row = state(world)
    assert (row.status, row.review_stage, row.maintenance_stage) == ("needs_refresh", 1, 0)
    assert row.error_part_ids == tuple(parts_covered_by(questions[0]))
    assert (row.lapse_count, row.next_review_due) == (1, TODAY + DAY)
    assert row.confirmed_at is None and row.first_confirmed_at == CONFIRMED_AT


def test_a_refreshed_passage_climbs_the_ladder_again_and_is_confirmed_again(world: World) -> None:
    world.seed_evidence(FIRST_PASSAGE, PARTS)  # every part has its evidence from before
    session = due_session(world, **maintenance(1))
    world.post(session, answers(round_of(session), wrong={0}))
    assert state(world).status == "needs_refresh"
    for stage in (2, 3):
        go_to(world, state(world).next_review_due)  # type: ignore[arg-type]
        again = world.open("daily")
        world.post(again, answers(round_of(again)))
        row = state(world)
        assert (row.status, row.review_stage) == ("needs_refresh", stage)
    go_to(world, state(world).next_review_due)  # type: ignore[arg-type]
    last = world.open("daily")
    world.post(last, answers(round_of(last)))
    final = state(world)
    assert (final.status, final.maintenance_stage) == ("confirmed", 1)
    assert final.first_confirmed_at == CONFIRMED_AT  # the first confirmation is kept
    assert final.confirmed_at == world.clock.now and final.confirmed_at != CONFIRMED_AT


# --- decision 6: a part leaves the error parts on a later correct answer -------------------------


def same_part_pair(questions: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Two questions that test the same single part."""
    seen: dict[UUID, dict[str, Any]] = {}
    for question in questions:
        parts = parts_covered_by(question)
        if len(parts) != 1:
            continue
        if parts[0] in seen:
            return seen[parts[0]], question
        seen[parts[0]] = question
    raise AssertionError("no two questions test the same part")


def test_decision6_a_later_correct_answer_of_another_question_clears_the_part(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    first, second = same_part_pair(game.questions)
    world.post(game, [answer_event(first, ok=False)])
    assert state(world).error_part_ids == tuple(parts_covered_by(first))
    world.post(game, [answer_event(second)])
    assert state(world).error_part_ids == ()


def test_decision6_a_wrong_answer_puts_a_cleared_part_back(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    first, second = same_part_pair(game.questions)
    world.post(game, [answer_event(first, ok=False), answer_event(second)])
    assert state(world).error_part_ids == ()
    world.post(game, [answer_event(first, ok=False)])
    assert state(world).error_part_ids == tuple(parts_covered_by(first))


def test_decision6_an_assisted_correct_answer_does_not_clear_the_part(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    first, second = same_part_pair(game.questions)
    world.post(game, [answer_event(first, ok=False), answer_event(second, hint=True)])
    assert state(world).error_part_ids == tuple(parts_covered_by(first))


def test_decision6_a_clean_round_clears_the_error_parts_of_its_questions(world: World) -> None:
    first_part = PARTS[0]
    session = due_session(world, error_part_ids=(first_part,))
    questions = round_of(session)
    assert first_part in parts_covered_by(questions[0])
    world.post(session, answers(questions))
    assert state(world).error_part_ids == ()


def test_decision6_the_failing_parts_of_a_failed_round_are_added_after_a_correct_answer(
    world: World,
) -> None:
    """Review question 1 is wrong on its part, a test question on the same part is right (it clears
    the part), then review question 2 completes the round: the failed round puts the part back."""
    session = due_session(world)
    first, second = round_of(session)
    part = parts_covered_by(first)[0]
    clearing = next(
        q
        for q in session.of(passage=FIRST_PASSAGE)
        if q["role"] != "review" and parts_covered_by(q) == [part]
    )
    events = [answer_event(first, ok=False), answer_event(clearing), answer_event(second)]
    body = world.post(session, events)
    assert [r["correct"] for r in body["results"]] == [False, True, True]
    row = state(world)
    assert row.error_part_ids == (part,)
    assert (row.review_stage, row.lapse_count) == (1, 1)


def test_decision6_the_parts_of_a_clean_question_of_a_failed_round_stay_cleared(
    world: World,
) -> None:
    session = due_session(world)
    first, second = round_of(session)
    world.seed_mastery(due_row(FIRST_PASSAGE, error_part_ids=tuple(parts_covered_by(second))))
    world.post(session, [answer_event(first, ok=False), answer_event(second)])
    assert state(world).error_part_ids == tuple(parts_covered_by(first))
