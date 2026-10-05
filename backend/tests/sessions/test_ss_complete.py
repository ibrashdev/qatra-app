"""E22: closing a session and the summary of its acknowledged events (API-spec E22, D40). Every
scenario runs over the memory repositories and over the PostgREST adapters."""

from __future__ import annotations

import uuid
from datetime import timedelta
from uuid import UUID

import pytest

from app.errors import ErrorCode
from tests.sessions.ss_events_support import (
    BASE,
    FIRST_PASSAGE,
    MODES,
    SECOND_PASSAGE,
    World,
    activity_event,
    answer_event,
    due_row,
    envelope_of,
)
from tests.sessions.ss_support import PLAN_ID, TODAY, error_of

EMPTY = {
    "answered": 0,
    "correct": 0,
    "newPassages": 0,
    "reviewsPassed": 0,
    "reviewsFailed": 0,
    "activeMs": 0,
}


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    return World(request.param)


def test_completing_closes_the_session_and_records_its_verified_time(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    qs = game.questions
    world.post(game, [answer_event(qs[0]), answer_event(qs[1], ok=False), activity_event(5, 185)])
    body = world.complete(game)
    assert body["summary"] == {
        "answered": 2,
        "correct": 1,
        "newPassages": 1,
        "reviewsPassed": 0,
        "reviewsFailed": 0,
        "activeMs": 180_000,
    }
    assert body["daily"] == {
        "learningDate": "2026-10-05",
        "dailyActiveMs": 180_000,
        "dailyGoalMs": 600_000,
        "dailyPercent": 30,
        "dailyCompleted": False,
        "extraActiveMs": 0,
    }
    row = world.session_row(game)
    assert row is not None and (row.status, row.elapsed_ms) == ("completed", 180_000)
    if world.fake is not None:
        assert world.fake.complete_bodies == [
            {"p_session_id": str(game.id), "p_elapsed_ms": 180_000}
        ]


def test_a_session_without_events_completes_with_an_empty_summary(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.complete(game)
    assert body["summary"] == EMPTY
    assert body["daily"]["dailyActiveMs"] == 0 and body["daily"]["dailyGoalMs"] == 600_000
    assert world.session_row(game).status == "completed"  # type: ignore[union-attr]


def test_completing_twice_returns_the_same_result_with_no_second_effect(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(game.questions[0]), activity_event(5, 185)])
    first = world.complete(game)
    world.clock.advance(minutes=30)
    second = world.complete(game)
    assert second == first
    if world.fake is not None:
        assert len(world.fake.complete_bodies) == 1  # the repeat never reaches the database


def test_a_repeated_completion_returns_the_stored_time_and_not_a_new_computation(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(5, 185)])
    assert world.learning.complete_session(world.ctx, game.id, 12_345) is True  # an earlier call
    assert world.complete(game)["summary"]["activeMs"] == 12_345


def test_completing_adds_no_time_and_no_completion_of_the_day(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(0, 599)])
    before = (world.daily_row(TODAY), world.completed_days(TODAY, TODAY), world.intervals(TODAY))
    body = world.complete(game)
    assert body["daily"]["dailyCompleted"] is False and body["daily"]["dailyPercent"] == 99
    assert (world.daily_row(TODAY), world.completed_days(TODAY, TODAY), world.intervals(TODAY)) == (
        before
    )


def test_the_completion_of_the_day_written_from_events_is_reported(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(0, 600)])
    body = world.complete(game)
    assert body["daily"]["dailyCompleted"] is True and body["daily"]["dailyPercent"] == 100


def test_the_active_time_of_the_summary_is_the_sessions_own_not_the_days(world: World) -> None:
    first = world.game(FIRST_PASSAGE, advance_minutes=0)
    second = world.game(FIRST_PASSAGE)
    world.post(first, [activity_event(5, 185)])
    world.post(second, [activity_event(100, 200)])
    body = world.complete(second)
    assert body["summary"]["activeMs"] == 100_000 and body["daily"]["dailyActiveMs"] == 195_000
    assert world.complete(first)["summary"]["activeMs"] == 180_000


def test_overlapping_intervals_of_one_session_count_once(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(5, 125), activity_event(65, 185)])
    assert world.complete(game)["summary"]["activeMs"] == 180_000


def test_the_summary_counts_only_acknowledged_attempts(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    choice = game.of(type="word_choice")[0]
    bad = answer_event(choice)
    bad["answer"] = {"text": "x"}  # the wrong shape for a choice question: rejected
    good = answer_event(game.of(type="word_order")[0])
    body = world.post(game, [good, bad, good])
    assert len(body["acknowledged"]) == 1 and len(body["rejected"]) == 1
    assert world.complete(game)["summary"]["answered"] == 1


def test_new_passages_are_the_ones_first_attempted_in_this_session(world: World) -> None:
    first = world.game(FIRST_PASSAGE)
    world.post(first, [answer_event(first.questions[0], at=world.clock.now)])
    assert world.complete(first)["summary"]["newPassages"] == 1
    world.clock.advance(minutes=1)
    both = world.open("game", passageIds=[str(FIRST_PASSAGE), str(SECOND_PASSAGE)])
    events = [
        answer_event(both.of(passage=FIRST_PASSAGE)[0], at=world.clock.now),
        answer_event(both.of(passage=SECOND_PASSAGE)[0], at=world.clock.now),
    ]
    world.post(both, events)
    assert world.complete(both)["summary"]["newPassages"] == 1  # only the second passage is new


def test_the_session_with_the_earliest_attempt_introduced_the_passage_even_if_replayed_last(
    world: World,
) -> None:
    """Replay order is ``occurredAt`` (A-12): a session whose events arrive after a later session's
    still counts the passage as new, and the later session does not."""
    earlier = world.game(FIRST_PASSAGE, advance_minutes=0)
    later = world.game(FIRST_PASSAGE)
    at = world.clock.now
    world.post(later, [answer_event(later.questions[0], at=at)])  # arrives first, happened second
    world.post(earlier, [answer_event(earlier.questions[0], at=at - timedelta(minutes=5))])
    assert world.complete(later)["summary"]["newPassages"] == 0
    assert world.complete(earlier)["summary"]["newPassages"] == 1


def test_a_passage_seen_in_the_placement_test_is_not_new_in_the_first_daily_session(
    world: World,
) -> None:
    """API-spec O-24: ``newPassages`` is the passages first attempted in the session, and a
    placement attempt is an attempt, so a passage that the placement test already asked about is
    not new when the learner meets it on day one (an open point for the coordinator)."""
    placement = world.open("placement")
    seen = placement.of(passage=FIRST_PASSAGE)[0]
    world.post(placement, [answer_event(seen, ok=False, at=world.clock.now)])
    world.clock.advance(minutes=1)
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(game.questions[0], at=world.clock.now)])
    assert world.complete(game)["summary"]["newPassages"] == 0
    assert world.complete(placement)["summary"]["newPassages"] == 1


# --- review rounds of the session (A-12) ------------------------------------------------------


def two_rounds(world: World):
    world.seed_mastery(due_row(FIRST_PASSAGE))
    world.seed_mastery(due_row(SECOND_PASSAGE))
    daily = world.open("daily")
    one = daily.of(role="review", passage=FIRST_PASSAGE)
    two = daily.of(role="review", passage=SECOND_PASSAGE)
    assert len(one) == 2 and len(two) == 3
    return daily, one, two


def test_reviews_passed_and_failed_count_the_rounds_judged_in_the_session(world: World) -> None:
    daily, one, two = two_rounds(world)
    world.post(daily, [answer_event(q) for q in one])
    world.post(daily, [answer_event(two[0]), answer_event(two[1], ok=False), answer_event(two[2])])
    summary = world.complete(daily)["summary"]
    assert (summary["reviewsPassed"], summary["reviewsFailed"]) == (1, 1)
    assert summary["answered"] == 5 and summary["correct"] == 4


def test_a_round_that_is_not_finished_is_not_evaluated(world: World) -> None:
    daily, one, two = two_rounds(world)
    world.post(daily, [answer_event(q) for q in one])
    world.post(daily, [answer_event(two[0], ok=False), answer_event(two[1])])  # one question short
    summary = world.complete(daily)["summary"]
    assert (summary["reviewsPassed"], summary["reviewsFailed"]) == (1, 0)
    assert world.mastery(SECOND_PASSAGE).review_stage == 1  # type: ignore[union-attr]


def test_a_hinted_question_fails_the_round_in_the_summary_too(world: World) -> None:
    daily, one, _ = two_rounds(world)
    world.post(daily, [answer_event(one[0], hint=True), answer_event(one[1])])
    summary = world.complete(daily)["summary"]
    assert (summary["reviewsPassed"], summary["reviewsFailed"]) == (0, 1)


def test_a_second_attempt_does_not_change_the_verdict_of_a_round(world: World) -> None:
    daily, one, _ = two_rounds(world)
    later = BASE + timedelta(minutes=2)  # the second attempt happened later: it is the second
    early_id = UUID(
        "ffffffff-ffff-4fff-8fff-ffffffffffff"
    )  # ordering by id alone would invert them
    late_id = UUID("00000000-0000-4000-8000-000000000001")
    events = [
        answer_event(one[0], ok=False, event_id=early_id),
        answer_event(one[0], at=later, event_id=late_id),
        answer_event(one[1]),
    ]
    world.post(daily, events)
    summary = world.complete(daily)["summary"]
    assert (summary["reviewsPassed"], summary["reviewsFailed"]) == (0, 1)
    assert summary["answered"] == 3


# --- errors and edge cases -----------------------------------------------------------------------


def test_an_unknown_session_is_not_found(world: World) -> None:
    error = error_of(lambda: world.complete(uuid.uuid4()))
    assert error.code is ErrorCode.not_found


def test_another_accounts_session_is_not_found(world: World) -> None:
    foreign = uuid.uuid4()
    world.seed_foreign_session(foreign)
    assert error_of(lambda: world.complete(foreign)).code is ErrorCode.not_found


def test_a_prepared_session_can_be_completed(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.make_offline(game)
    world.post(game, [answer_event(game.questions[0], **envelope_of(game))])
    assert world.complete(game)["summary"]["answered"] == 1
    assert world.session_row(game).status == "completed"  # type: ignore[union-attr]


def test_a_placement_session_completes_without_time_or_goal_effect(world: World) -> None:
    placement = world.open("placement")
    world.post(placement, [answer_event(q) for q in placement.questions])
    body = world.complete(placement)
    assert body["summary"]["answered"] == len(placement.questions)
    assert body["summary"]["activeMs"] == 0 and body["daily"]["dailyActiveMs"] == 0
    assert world.daily_row(TODAY) is None


def test_a_day_whose_plan_is_gone_reports_the_stored_figure(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(5, 185)])
    world.plans._plans.pop(PLAN_ID)  # type: ignore[attr-defined]
    body = world.complete(game)
    assert body["daily"]["dailyActiveMs"] == 180_000 and body["daily"]["dailyGoalMs"] == 600_000


def test_a_day_without_a_row_and_without_a_plan_has_no_goal(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.plans._plans.pop(PLAN_ID)  # type: ignore[attr-defined]
    daily = world.complete(game)["daily"]
    assert (daily["dailyGoalMs"], daily["dailyPercent"], daily["dailyCompleted"]) == (0, 0, False)
