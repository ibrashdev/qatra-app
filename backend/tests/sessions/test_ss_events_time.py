"""E21 activity events: bounds, the credited interval, the union of time, the daily goal and its
single completion, the learning date of an event (contract §7, API-spec S-7, D40, D57). Every
scenario runs over the memory repositories and over the PostgREST adapters."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

import pytest

from app.errors import ErrorCode
from app.repositories.plans import LearningZone
from tests.sessions.ss_events_support import (
    BASE,
    FIRST_PASSAGE,
    GOAL_MS,
    MODES,
    World,
    activity_event,
    answer_event,
    envelope_of,
)
from tests.sessions.ss_support import PLAN_ID, TODAY, USER, error_of

TOMORROW = TODAY + timedelta(days=1)


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    return World(request.param)


# --- the credited interval -----------------------------------------------------------------------


def test_an_activity_event_credits_its_span_to_the_learning_date(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    event = activity_event(5, 185)
    body = world.post(game, [event])
    assert body["acknowledged"] == [event["clientEventId"]] and body["results"] == []
    assert body["daily"] == {
        "learningDate": "2026-10-05",
        "dailyActiveMs": 180_000,
        "dailyGoalMs": GOAL_MS,
        "dailyPercent": 30,
        "dailyCompleted": False,
        "extraActiveMs": 0,
    }
    row = world.daily_row(TODAY)
    assert row is not None and (row.active_ms, row.goal_ms) == (180_000, GOAL_MS)
    [interval] = world.intervals(TODAY)
    assert (interval.started_at, interval.ended_at) == (
        BASE + timedelta(seconds=5),
        BASE + timedelta(seconds=185),
    )
    assert (interval.active_ms, interval.session_id) == (180_000, game.id)


def test_paused_time_is_not_credited(world: World) -> None:
    """The client says 100 s of the 180 s were active: only that much is credited."""
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(5, 185, active_ms=100_000)])
    assert body["daily"]["dailyActiveMs"] == 100_000
    assert world.daily_row(TODAY).active_ms == 100_000  # type: ignore[union-attr]


def test_time_is_the_union_of_the_intervals_never_their_sum(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(5, 125), activity_event(65, 185)])
    assert body["daily"]["dailyActiveMs"] == 180_000
    body = world.post(game, [activity_event(100, 200)])  # 15 s beyond what is credited
    assert body["daily"]["dailyActiveMs"] == 195_000
    assert len(world.intervals(TODAY)) == 3


def test_an_event_inside_credited_time_adds_nothing(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(5, 185)])
    body = world.post(game, [activity_event(20, 60)])
    assert len(body["acknowledged"]) == 1 and body["daily"]["dailyActiveMs"] == 180_000


def test_two_sessions_of_the_account_share_one_day_without_double_counting(world: World) -> None:
    first = world.game(FIRST_PASSAGE, advance_minutes=0)  # both start at the same moment
    second = world.game(FIRST_PASSAGE)
    world.post(first, [activity_event(5, 185)])
    body = world.post(second, [activity_event(100, 200)])
    assert body["daily"]["dailyActiveMs"] == 195_000


def test_an_event_of_zero_length_is_acknowledged_and_credits_nothing(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(5, 5)])
    assert len(body["acknowledged"]) == 1 and body["daily"]["dailyActiveMs"] == 0


def test_the_stored_figure_never_goes_down(world: World) -> None:
    world.seed_daily(TODAY, 900_000)  # more than the intervals can account for
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(5, 185)])
    assert body["daily"]["dailyActiveMs"] == 900_000
    assert world.daily_row(TODAY).active_ms == 900_000  # type: ignore[union-attr]
    assert body["daily"]["dailyCompleted"] is True  # the stored figure is past the goal
    assert world.completed_days(TODAY, TODAY) == {TODAY}


# --- bounds (S-7) --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("event", "accepted"),
    [
        (activity_event(5, 660), True),  # ends exactly 60 s after the server clock
        (activity_event(5, 661), False),  # one second further
        (activity_event(-60, 5), True),  # starts exactly 60 s before the session was created
        (activity_event(-61, 5), False),
        (activity_event(5, 65, active_ms=61_000), True),  # active time may exceed the span by 1 s
        (activity_event(5, 65, active_ms=61_001), False),
        (activity_event(65, 5, active_ms=0), False),  # ends before it starts
    ],
    ids=[
        "ends at the skew limit",
        "ends in the future",
        "starts at the skew limit",
        "starts before the session",
        "active time exceeds the span by 1 s",
        "active time exceeds the span by more",
        "ends before it starts",
    ],
)
def test_the_bounds_of_an_activity_event(
    world: World, event: dict[str, Any], accepted: bool
) -> None:
    game = world.game(FIRST_PASSAGE)  # the clock stands 600 s after the session was created
    body = world.post(game, [event])
    if accepted:
        assert body["acknowledged"] == [event["clientEventId"]] and body["rejected"] == []
    else:
        assert body["acknowledged"] == [] and world.intervals(TODAY) == []
        assert body["rejected"] == [
            {"clientEventId": event["clientEventId"], "code": "activity_out_of_bounds"}
        ]
        assert body["daily"]["dailyActiveMs"] == 0


def test_an_event_may_last_at_most_thirty_minutes(world: World) -> None:
    game = world.game(FIRST_PASSAGE, advance_minutes=40)
    ok = activity_event(0, 1800)
    too_long = activity_event(0, 1801)
    body = world.post(game, [ok, too_long])
    assert body["acknowledged"] == [ok["clientEventId"]]
    assert [r["code"] for r in body["rejected"]] == ["activity_out_of_bounds"]
    assert body["daily"]["dailyActiveMs"] == 1_800_000


def test_negative_or_non_integer_active_time_fails_the_request(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    for bad in (-1, 1.5, "5"):
        event = activity_event(5, 65)
        event["activeMs"] = bad
        assert error_of(lambda e=event: world.post(game, [e])).code is ErrorCode.validation_error
    assert world.intervals(TODAY) == []


def test_a_rejected_event_does_not_stop_the_others(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    bad, good = activity_event(65, 5, active_ms=0), activity_event(5, 65)
    body = world.post(game, [bad, good])
    assert body["acknowledged"] == [good["clientEventId"]]
    assert [r["clientEventId"] for r in body["rejected"]] == [bad["clientEventId"]]
    assert body["daily"]["dailyActiveMs"] == 60_000


# --- the daily goal and its single completion (D40, D57) -----------------------------------------


def test_the_goal_comes_from_the_session_minutes_of_the_plan(world: World) -> None:
    world.plans.update(PLAN_ID, session_minutes=25)
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(5, 185)])
    assert body["daily"]["dailyGoalMs"] == 1_500_000 and body["daily"]["dailyPercent"] == 12


def test_a_change_of_minutes_does_not_rewrite_the_goal_of_a_day_already_started(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(5, 185)])
    world.plans.update(PLAN_ID, session_minutes=25)
    body = world.post(game, [activity_event(185, 245)])
    assert body["daily"]["dailyGoalMs"] == GOAL_MS  # the row keeps the goal it began with
    assert world.daily_row(TODAY).goal_ms == GOAL_MS  # type: ignore[union-attr]


def test_reaching_the_goal_completes_the_day_once(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(0, 600)])
    assert body["daily"]["dailyPercent"] == 100 and body["daily"]["dailyCompleted"] is True
    assert body["daily"]["extraActiveMs"] == 0
    assert world.completed_days(TODAY, TODAY) == {TODAY}
    body = world.post(game, [activity_event(600, 650)])  # 50 s of surplus
    assert body["daily"]["dailyPercent"] == 100 and body["daily"]["dailyCompleted"] is True
    assert body["daily"]["extraActiveMs"] == 50_000
    assert world.completed_days(TODAY, TODAY) == {TODAY}
    if world.fake is not None:
        assert len(world.fake.tables["daily_completions"]) == 1
        assert world.fake.tables["daily_completions"][0]["reached_in_plan_id"] == str(PLAN_ID)
    else:
        assert world.store is not None and world.store.completions == {(USER, TODAY): PLAN_ID}


def test_a_day_just_below_the_goal_is_not_complete(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(0, 599)])
    assert body["daily"]["dailyPercent"] == 99 and body["daily"]["dailyCompleted"] is False
    assert world.completed_days(TODAY, TODAY) == frozenset()


def test_a_completion_that_exists_already_is_not_written_again(world: World) -> None:
    world.seed_completion(TODAY)
    world.seed_daily(TODAY, 600_000)
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [activity_event(5, 185)])
    assert body["daily"]["dailyCompleted"] is True
    if world.fake is not None:
        assert len(world.fake.tables["daily_completions"]) == 1


def test_answers_alone_never_add_time(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [answer_event(q) for q in game.questions[:3]])
    assert body["daily"]["dailyActiveMs"] == 0 and world.daily_row(TODAY) is None


# --- the learning date of an event (D57) ---------------------------------------------------------


def test_an_event_belongs_to_the_learning_date_of_its_start(world: World) -> None:
    """The session starts on 5 October at 11:00 (Dubai). The learner works across local midnight:
    the stretch that starts at 23:59:30 belongs to the 5th, the one at 00:00:40 to the 6th."""
    game = world.game(FIRST_PASSAGE, advance_minutes=13 * 60 + 2)  # now 20:02 UTC, 00:02 on the 6th
    world.calendar.today = TOMORROW
    midnight = datetime.fromisoformat("2026-10-05T20:00:00+00:00")
    before = activity_event(-30, 30, base=midnight)  # 23:59:30 to 00:00:30 local
    after = activity_event(40, 100, base=midnight)  # 00:00:40 to 00:01:40 local
    body = world.post(game, [before, after])
    assert len(body["acknowledged"]) == 2 and body["rejected"] == []
    assert world.daily_row(TODAY).active_ms == 60_000  # type: ignore[union-attr]
    assert world.daily_row(TOMORROW).active_ms == 60_000  # type: ignore[union-attr]
    assert (
        body["daily"]["learningDate"] == "2026-10-06" and body["daily"]["dailyActiveMs"] == 60_000
    )
    assert [i.learning_date for i in world.intervals(TODAY)] == [TODAY]
    assert [i.learning_date for i in world.intervals(TOMORROW)] == [TOMORROW]


def test_without_an_instant_calendar_an_event_is_credited_to_the_date_of_its_session(
    world: World,
) -> None:
    """The calendar of the application cannot yet name the zone of the account (B4's
    ``PlanServiceCalendar`` has ``learning_date`` only), so the date of the session is used. The
    calendar of this world can, and the tests above rely on it."""
    world.calendar.learning_zone = None  # type: ignore[assignment]
    game = world.game(FIRST_PASSAGE, advance_minutes=13 * 60 + 2)
    world.calendar.today = TOMORROW
    midnight = datetime.fromisoformat("2026-10-05T20:00:00+00:00")
    world.post(game, [activity_event(40, 100, base=midnight)])  # 00:00:40 on the 6th in Dubai
    assert world.daily_row(TODAY).active_ms == 60_000  # type: ignore[union-attr]
    assert world.daily_row(TOMORROW) is None


def test_the_zone_is_read_once_per_request_and_only_for_activity(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(q) for q in game.questions[:3]])
    assert world.calendar.zone_reads == 0
    events = [activity_event(5 + 10 * n, 12 + 10 * n) for n in range(6)]
    world.post(game, events)
    assert world.calendar.zone_reads == 1


def test_a_pending_zone_change_dates_the_events_from_its_effective_date(world: World) -> None:
    """Dubai (UTC+4) until the 5th, Auckland (UTC+13) from the 6th on (D57). 16:00 on the 5th in
    Dubai is the 5th; 16:00 on the 6th in Dubai is already 01:00 on the 7th in Auckland, and the
    new zone rules from its effective date, so that instant belongs to the 7th."""
    world.calendar.zone = LearningZone("Asia/Dubai", "Pacific/Auckland", TOMORROW)
    game = world.game(FIRST_PASSAGE, advance_minutes=30 * 60)  # now 13:00 UTC on the 6th
    before = datetime.fromisoformat("2026-10-05T12:00:00+00:00")
    after = datetime.fromisoformat("2026-10-06T12:00:00+00:00")
    world.post(game, [activity_event(0, 60, base=before), activity_event(0, 60, base=after)])
    assert world.daily_row(TODAY).active_ms == 60_000  # type: ignore[union-attr]
    assert world.daily_row(TOMORROW) is None  # Dubai's 6th is not used once the change is in force
    assert world.daily_row(date(2026, 10, 7)).active_ms == 60_000  # type: ignore[union-attr]


def test_an_unknown_zone_in_the_profile_is_an_internal_error_and_records_nothing(
    world: World,
) -> None:
    world.calendar.zone = LearningZone("Nowhere/Land")
    game = world.game(FIRST_PASSAGE)
    error = error_of(lambda: world.post(game, [activity_event(5, 65)]))
    assert error.code is ErrorCode.internal
    assert world.intervals(TODAY) == [] and world.daily_row(TODAY) is None


def test_each_learning_date_of_a_request_is_written_with_its_own_goal(world: World) -> None:
    game = world.game(FIRST_PASSAGE, advance_minutes=13 * 60 + 2)
    world.calendar.today = TOMORROW
    midnight = datetime.fromisoformat("2026-10-05T20:00:00+00:00")
    world.post(
        game, [activity_event(-90, -30, base=midnight), activity_event(40, 100, base=midnight)]
    )
    for day in (TODAY, TOMORROW):
        row = world.daily_row(day)
        assert row is not None and row.goal_ms == GOAL_MS


def test_an_offline_replay_credits_the_day_the_time_was_spent_not_the_day_of_the_replay(
    world: World,
) -> None:
    session = world.game(FIRST_PASSAGE)
    world.make_offline(session)
    world.clock.advance(days=1)  # the replay arrives the next morning
    world.calendar.today = TOMORROW
    envelope = envelope_of(session)
    body = world.post(session, [activity_event(5, 185, **envelope)])
    assert len(body["acknowledged"]) == 1
    assert world.daily_row(TODAY).active_ms == 180_000  # type: ignore[union-attr]
    assert body["daily"]["learningDate"] == "2026-10-06" and body["daily"]["dailyActiveMs"] == 0


def test_an_offline_replay_of_a_day_that_met_the_goal_records_that_days_completion(
    world: World,
) -> None:
    session = world.game(FIRST_PASSAGE)
    world.make_offline(session)
    world.clock.advance(days=1)
    world.calendar.today = TOMORROW
    world.post(session, [activity_event(0, 600, **envelope_of(session))])
    assert world.completed_days(TODAY, TODAY) == {TODAY}
    assert world.completed_days(TOMORROW, TOMORROW) == frozenset()
