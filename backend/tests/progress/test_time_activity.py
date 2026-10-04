"""Contract §7 "Activity events", API-spec S-7: bounds, placement, learning date, credited
interval (pure, no I/O)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from app.domain import plan_policy, time_policy
from app.domain.time_policy import (
    ActivityAccepted,
    ActivityIgnored,
    ActivityRejected,
    credited_interval,
    learning_date_at,
)
from tests.progress.time_support import BASE, CREATED, SERVER_NOW, check, ms, sec

# --- the bounds ----------------------------------------------------------------------------------


def test_activity_may_end_at_most_60_seconds_after_the_server_time() -> None:
    started = SERVER_NOW - timedelta(seconds=30)
    limit = SERVER_NOW + timedelta(seconds=60)
    assert isinstance(check(started, limit, 90_000), ActivityAccepted)
    late = check(started, limit + ms(1), 90_001)
    assert late == ActivityRejected(time_policy.ENDS_IN_THE_FUTURE)


def test_activity_may_start_at_most_60_seconds_before_the_session_was_created() -> None:
    limit = CREATED - timedelta(seconds=60)
    assert isinstance(check(limit, limit + timedelta(seconds=30), 30_000), ActivityAccepted)
    early = check(limit - ms(1), limit + timedelta(seconds=30), 30_000)
    assert early == ActivityRejected(time_policy.STARTS_BEFORE_THE_SESSION)


def test_active_time_may_exceed_the_span_by_at_most_one_second() -> None:
    started, ended = sec(10), sec(70)  # a span of 60 000 ms
    assert isinstance(check(started, ended, 61_000), ActivityAccepted)
    assert check(started, ended, 61_001) == ActivityRejected(time_policy.ACTIVE_EXCEEDS_SPAN)


def test_one_event_is_at_most_30_minutes_long() -> None:
    thirty = timedelta(minutes=30)
    now = BASE + timedelta(hours=1)
    assert isinstance(check(sec(0), sec(0) + thirty, 1_800_000, now=now), ActivityAccepted)
    longer = check(sec(0), sec(0) + thirty + ms(1), 1_800_000, now=now)
    assert longer == ActivityRejected(time_policy.EVENT_TOO_LONG)


def test_one_event_never_reports_more_than_30_minutes_of_active_time() -> None:
    """The span allows one second of slack, but the stored column stops at 30 minutes."""
    now = BASE + timedelta(hours=1)
    verdict = check(sec(0), sec(0) + timedelta(minutes=30), 1_800_500, now=now)
    assert verdict == ActivityRejected(time_policy.EVENT_TOO_LONG)


def test_an_event_cannot_end_before_it_starts() -> None:
    assert check(sec(60), sec(30), 0) == ActivityRejected(time_policy.ENDED_BEFORE_STARTED)


def test_active_time_cannot_be_negative() -> None:
    assert check(sec(0), sec(30), -1) == ActivityRejected(time_policy.NEGATIVE_ACTIVE_TIME)


def test_a_zero_length_event_is_valid_and_credits_nothing() -> None:
    verdict = check(sec(30), sec(30), 0)
    assert isinstance(verdict, ActivityAccepted)
    assert verdict.interval.length_ms == 0


def test_a_future_event_is_rejected_whatever_its_length_the_device_clock_is_no_proof() -> None:
    far = SERVER_NOW + timedelta(days=2)
    assert isinstance(check(far, far + timedelta(seconds=10), 10_000), ActivityRejected)


def test_a_valid_event_reports_what_it_was_given() -> None:
    verdict = check(sec(5), sec(185), 180_000)
    assert isinstance(verdict, ActivityAccepted)
    assert verdict.active_ms == 180_000
    assert verdict.learning_date == date(2026, 10, 5)
    assert (verdict.interval.start, verdict.interval.end) == (sec(5), sec(185))


def test_every_instant_needs_a_time_zone() -> None:
    naive = datetime(2026, 10, 5, 7, 5)
    with pytest.raises(ValueError):
        check(naive, sec(60), 1_000)


# --- placement sessions are excluded -------------------------------------------------------------


def test_a_placement_session_acknowledges_activity_but_never_counts_it() -> None:
    assert check(sec(5), sec(185), 180_000, kind="placement") == ActivityIgnored()


@pytest.mark.parametrize("kind", ["daily", "game"])
def test_daily_and_game_sessions_count_their_activity(kind: str) -> None:
    assert isinstance(check(sec(5), sec(185), 180_000, kind=kind), ActivityAccepted)


def test_activity_out_of_bounds_is_rejected_in_a_placement_session_too() -> None:
    assert isinstance(check(sec(60), sec(30), 0, kind="placement"), ActivityRejected)


# --- the learning date ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("instant", "zone", "expected"),
    [
        (datetime(2026, 10, 5, 19, 59, 59, tzinfo=UTC), "Asia/Dubai", date(2026, 10, 5)),
        (datetime(2026, 10, 5, 20, 0, 0, tzinfo=UTC), "Asia/Dubai", date(2026, 10, 6)),
        (datetime(2026, 10, 5, 20, 0, 0, tzinfo=UTC), "UTC", date(2026, 10, 5)),
        (datetime(2026, 10, 5, 2, 0, 0, tzinfo=UTC), "America/Los_Angeles", date(2026, 10, 4)),
        (datetime(2026, 10, 5, 23, 30, 0, tzinfo=UTC), "Pacific/Auckland", date(2026, 10, 6)),
        (datetime(2026, 12, 31, 21, 0, 0, tzinfo=UTC), "Asia/Dubai", date(2027, 1, 1)),
    ],
)
def test_learning_date_is_the_local_date_of_the_start_in_the_account_time_zone(
    instant: datetime, zone: str, expected: date
) -> None:
    assert learning_date_at(instant, zone) == expected


def test_an_event_that_runs_past_local_midnight_belongs_to_the_date_it_started_on() -> None:
    started = datetime(2026, 10, 5, 19, 58, tzinfo=UTC)  # 23:58 in Dubai
    ended = started + timedelta(minutes=5)  # 00:03 the next day
    verdict = check(
        started,
        ended,
        300_000,
        now=ended + timedelta(seconds=5),
        created=started - timedelta(minutes=1),
    )
    assert isinstance(verdict, ActivityAccepted)
    assert verdict.learning_date == date(2026, 10, 5)


def test_a_pending_time_zone_takes_effect_from_its_effective_date_not_before() -> None:
    """D57: until the effective date the current zone stays in force."""
    pending = {"pending_time_zone": "Pacific/Kiritimati", "pending_effective": date(2026, 10, 6)}
    before = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)  # 5 October in Dubai
    on_the_day = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)  # 6 October in Dubai, 7 in Kiritimati
    assert learning_date_at(before, "Asia/Dubai", **pending) == date(2026, 10, 5)
    assert learning_date_at(on_the_day, "Asia/Dubai", **pending) == date(2026, 10, 7)
    assert learning_date_at(on_the_day, "Asia/Dubai") == date(2026, 10, 6)


def test_the_pending_time_zone_reaches_the_learning_date_of_an_activity_event() -> None:
    started = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    now = started + timedelta(minutes=3)
    pending = {"pending_time_zone": "Pacific/Kiritimati", "pending_effective": date(2026, 10, 6)}
    verdict = check(
        started, started + timedelta(minutes=1), 60_000, now=now, created=started, **pending
    )
    assert isinstance(verdict, ActivityAccepted)
    assert verdict.learning_date == date(2026, 10, 7)


def test_an_unknown_time_zone_is_a_value_error_never_a_guess() -> None:
    with pytest.raises(ValueError):
        learning_date_at(BASE, "Mars/Olympus_Mons")
    with pytest.raises(ValueError):
        learning_date_at(BASE, "Asia/Dubai", "Mars/Olympus_Mons", date(2026, 1, 1))


def test_a_learning_date_needs_an_instant_with_a_time_zone() -> None:
    with pytest.raises(ValueError):
        learning_date_at(datetime(2026, 10, 5, 7, 0), "Asia/Dubai")


def test_learning_date_agrees_with_the_plan_policy_rule_for_today() -> None:
    """``plan_policy.learning_date`` serves today; this module repeats the rule without importing
    the plan modules, so the two are compared over a grid of instants and zones."""
    zones = ("Asia/Dubai", "UTC", "America/New_York", "Pacific/Kiritimati", "Europe/London")
    pendings = (
        None,
        ("Pacific/Auckland", date(2026, 10, 6)),
        ("America/Los_Angeles", date(2026, 10, 5)),
    )
    for hour in range(0, 24 * 4, 5):
        instant = datetime(2026, 10, 4, 0, 0, tzinfo=UTC) + timedelta(hours=hour)
        for zone in zones:
            for pending in pendings:
                extra = () if pending is None else pending
                assert learning_date_at(instant, zone, *extra) == plan_policy.learning_date(
                    instant, zone, *extra
                )


# --- the credited interval -----------------------------------------------------------------------


def test_an_honest_event_is_credited_as_its_plain_span() -> None:
    interval = credited_interval(sec(5), sec(185), 180_000)
    assert (interval.start, interval.end) == (sec(5), sec(185))
    assert interval.length_ms == 180_000


def test_active_time_shorter_than_the_span_credits_only_the_active_time() -> None:
    interval = credited_interval(sec(0), sec(60), 45_000)
    assert (interval.start, interval.end) == (sec(0), sec(45))


def test_active_time_slightly_above_the_span_credits_no_more_than_the_span() -> None:
    interval = credited_interval(sec(0), sec(60), 60_900)
    assert interval.length_ms == 60_000


def test_credited_time_is_never_negative() -> None:
    with pytest.raises(ValueError):
        credited_interval(sec(0), sec(60), -1)
