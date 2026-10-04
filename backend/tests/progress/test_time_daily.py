"""D40 and D57: the daily goal, the percentage, the single completion, the streak and the history
window (pure, no I/O)."""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest

from app.domain.time_policy import (
    HISTORY_DAYS,
    DailySummary,
    daily_goal_ms,
    history_range,
    resolve_goal_ms,
    should_record_completion,
    streak_days,
    summarize_day,
)

TODAY = date(2026, 10, 5)
MINUTE = 60_000

# --- the goal -----------------------------------------------------------------------------------


@pytest.mark.parametrize(("minutes", "goal"), [(5, 300_000), (10, 600_000), (15, 900_000)])
def test_the_daily_goal_is_the_plans_session_minutes_times_60000(minutes: int, goal: int) -> None:
    assert daily_goal_ms(minutes) == goal


@pytest.mark.parametrize("minutes", [0, -5])
def test_a_goal_needs_positive_minutes(minutes: int) -> None:
    with pytest.raises(ValueError):
        daily_goal_ms(minutes)


def test_d57_a_date_that_already_has_a_goal_keeps_it_when_the_plan_minutes_change() -> None:
    """The change of minutes takes effect the next learning day: today's row is never rewritten."""
    assert resolve_goal_ms(stored_goal_ms=10 * MINUTE, session_minutes=5) == 10 * MINUTE
    assert resolve_goal_ms(stored_goal_ms=5 * MINUTE, session_minutes=15) == 5 * MINUTE


def test_d57_a_new_date_takes_the_goal_of_the_minutes_in_force() -> None:
    assert resolve_goal_ms(stored_goal_ms=None, session_minutes=15) == 15 * MINUTE
    assert resolve_goal_ms(stored_goal_ms=0, session_minutes=10) == 10 * MINUTE


def test_without_a_stored_goal_and_without_a_plan_there_is_no_goal() -> None:
    assert resolve_goal_ms(None, None) == 0
    assert resolve_goal_ms(None, 0) == 0


# --- the percentage -----------------------------------------------------------------------------


def test_d40_seven_of_ten_minutes_is_seventy_percent() -> None:
    summary = summarize_day(TODAY, 7 * MINUTE, 10 * MINUTE, completed=False)
    assert summary == DailySummary(TODAY, 420_000, 600_000, 70, False, 0)


def test_d40_the_percentage_is_floored() -> None:
    assert summarize_day(TODAY, 199_999, 600_000, completed=False).percent == 33
    assert summarize_day(TODAY, 1, 3, completed=False).percent == 33
    assert summarize_day(TODAY, 1, 1_000_000, completed=False).percent == 0
    assert summarize_day(TODAY, 599_999, 600_000, completed=False).percent == 99


def test_d40_the_percentage_never_passes_one_hundred_and_the_surplus_is_shown_apart() -> None:
    summary = summarize_day(TODAY, 12 * MINUTE, 10 * MINUTE, completed=True)
    assert summary.percent == 100
    assert summary.extra_ms == 2 * MINUTE
    assert summary.active_ms == 12 * MINUTE


def test_d40_reaching_the_goal_exactly_is_one_hundred_percent_with_no_surplus() -> None:
    summary = summarize_day(TODAY, 10 * MINUTE, 10 * MINUTE, completed=True)
    assert (summary.percent, summary.extra_ms) == (100, 0)


def test_d40_below_the_goal_has_no_surplus() -> None:
    assert summarize_day(TODAY, 1, 600_000, completed=False).extra_ms == 0


def test_d40_the_completed_flag_is_the_recorded_completion_not_a_guess_from_the_time() -> None:
    assert summarize_day(TODAY, 10 * MINUTE, 10 * MINUTE, completed=False).completed is False
    assert summarize_day(TODAY, 0, 10 * MINUTE, completed=True).completed is True


def test_a_day_without_a_goal_has_no_percentage_and_no_surplus() -> None:
    summary = summarize_day(TODAY, 0, 0, completed=False)
    assert (summary.percent, summary.goal_ms, summary.extra_ms) == (0, 0, 0)


def test_durations_cannot_be_negative() -> None:
    with pytest.raises(ValueError):
        summarize_day(TODAY, -1, 600_000, completed=False)
    with pytest.raises(ValueError):
        summarize_day(TODAY, 0, -1, completed=False)


@pytest.mark.parametrize("seed", range(20))
def test_d40_more_active_time_never_lowers_the_percentage(seed: int) -> None:
    rng = random.Random(seed)
    goal = rng.choice([5, 10, 15]) * MINUTE
    previous = -1
    for active in sorted(rng.randrange(0, 3 * goal) for _ in range(30)):
        percent = summarize_day(TODAY, active, goal, completed=False).percent
        assert 0 <= percent <= 100
        assert percent >= previous
        previous = percent


# --- the single completion -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("active", "goal", "done", "record"),
    [
        (0, 600_000, False, False),
        (599_999, 600_000, False, False),
        (600_000, 600_000, False, True),
        (900_000, 600_000, False, True),
        (600_000, 600_000, True, False),
        (900_000, 600_000, True, False),
        (0, 0, False, False),
        (5, 0, False, False),
    ],
)
def test_d40_the_completion_is_written_once_when_active_time_reaches_the_goal(
    active: int, goal: int, done: bool, record: bool
) -> None:
    assert should_record_completion(active, goal, already_completed=done) is record


def test_d40_a_later_replay_or_game_cannot_write_a_second_completion() -> None:
    recorded = False
    writes = 0
    for active in (590_000, 600_000, 650_000, 900_000, 900_000):
        if should_record_completion(active, 600_000, already_completed=recorded):
            writes += 1
            recorded = True
    assert writes == 1


def test_d40_the_completion_depends_on_time_only_not_on_how_the_answers_went() -> None:
    """The decision takes durations only: a day of games with wrong answers completes like any."""
    assert should_record_completion(10 * MINUTE, 10 * MINUTE, already_completed=False)


# --- the streak ----------------------------------------------------------------------------------


def days(*offsets: int) -> set[date]:
    return {TODAY + timedelta(days=offset) for offset in offsets}


@pytest.mark.parametrize(
    ("completed", "streak"),
    [
        (days(), 0),
        (days(0), 1),
        (days(0, -1, -2), 3),
        (days(-1, -2), 2),  # today is not done yet: the streak that ends yesterday still counts
        (days(-1), 1),
        (days(-2, -3), 0),  # yesterday was missed
        (days(0, -1, -3), 2),  # a gap ends the streak
        (days(0, -2), 1),
        (days(1, 2), 0),  # dates that have not happened do not count
        (days(0, -1, -2, -3, -4, -5, -6), 7),
    ],
)
def test_streak_counts_consecutive_completed_days_ending_today_or_yesterday(
    completed: set[date], streak: int
) -> None:
    assert streak_days(completed, TODAY) == streak


# --- the history window --------------------------------------------------------------------------


def test_history_is_the_last_thirty_learning_days_before_today() -> None:
    first, last = history_range(TODAY)
    assert HISTORY_DAYS == 30
    assert last == date(2026, 10, 4)
    assert first == date(2026, 9, 5)
    assert (last - first).days + 1 == 30


def test_history_ends_the_day_before_today_so_today_is_only_in_daily() -> None:
    assert history_range(date(2026, 3, 1))[1] == date(2026, 2, 28)
    assert history_range(date(2027, 1, 1))[1] == date(2026, 12, 31)
