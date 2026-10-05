"""Time policy (pure): active time, the daily goal and the learning date (Implementation-contract §7
"Activity events", API-spec §3 S-7 and E18, D40, D57).

Daily progress is time, not answers (D40): the sum of verified active time of the learning date
divided by the goal, capped at 100 % with the surplus shown apart, and one completion per date
(reached by games alone too). The server clock is the only clock it trusts (D59), so every activity
event is checked against the server time and the session before it is credited.

**Credited time.** An activity event ``(startedAt, endedAt, activeMs)`` is credited as the interval
``[startedAt, startedAt + min(activeMs, endedAt - startedAt)]``: never more than the client says
was active and never more than the span. Overlapping credited intervals of the same account and
date are merged (union) before they are summed, so one stretch of time is never credited twice, not
across sessions, devices or replays. Decision: the contract says "union of overlapping intervals"
without saying how a span longer than ``activeMs`` is credited; the shorter figure is used so that
paused time is not credited (D40). An honest client sends ``activeMs`` equal to the span, and then
this is the plain union of the spans.

Pure module: standard library only (``zoneinfo`` needs the ``tzdata`` package on some systems).
"""

from __future__ import annotations

from collections.abc import Collection, Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Final
from zoneinfo import ZoneInfo

# --- numbers of Implementation-contract §7 and API-spec §1.7 -------------------------------------

# endedAt <= server now + 60 s and startedAt >= session.createdAt - 60 s
CLOCK_SKEW: Final = timedelta(seconds=60)
SPAN_SLACK_MS: Final = 1000  # activeMs <= endedAt - startedAt + 1000
MAX_EVENT_MS: Final = 30 * 60 * 1000  # at most 30 minutes per event
HISTORY_DAYS: Final = 30  # E19 lists the last 30 learning days
MS_PER_MINUTE: Final = 60_000
_MS: Final = timedelta(milliseconds=1)

PLACEMENT: Final = "placement"

# Reasons an activity event is out of bounds (the API code is ``activity_out_of_bounds`` for all).
ENDED_BEFORE_STARTED: Final = "ended_before_started"
NEGATIVE_ACTIVE_TIME: Final = "negative_active_time"
ENDS_IN_THE_FUTURE: Final = "ends_in_the_future"
STARTS_BEFORE_THE_SESSION: Final = "starts_before_the_session"
ACTIVE_EXCEEDS_SPAN: Final = "active_exceeds_span"
EVENT_TOO_LONG: Final = "event_too_long"


# --- learning date (D57) -------------------------------------------------------------------------


def learning_date_at(
    instant: datetime,
    time_zone: str,
    pending_time_zone: str | None = None,
    pending_effective: date | None = None,
) -> date:
    """The learning date of ``instant`` in the account time zone effective that day (local
    midnight starts a new day). A time-zone change takes effect from its effective date, the next
    learning day (D57): until then the current zone is in force. Raises ``ValueError`` for an
    unknown zone name.

    The same rule as ``plan_policy.learning_date`` (which serves "today"); it is repeated here so
    that this module does not import the plan modules.
    """
    if instant.tzinfo is None:
        raise ValueError("an instant needs a time zone")
    try:
        local = instant.astimezone(ZoneInfo(time_zone)).date()
        if pending_time_zone and pending_effective is not None and local >= pending_effective:
            local = instant.astimezone(ZoneInfo(pending_time_zone)).date()
    except (KeyError, OSError) as exc:  # ZoneInfoNotFoundError is a KeyError
        raise ValueError("unknown time zone") from exc
    return local


# --- intervals and their union -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Interval:
    """A stretch of credited active time; both ends are timezone-aware."""

    start: datetime
    end: datetime

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("an interval needs timezone-aware ends")
        if self.end < self.start:
            raise ValueError("an interval cannot end before it starts")

    @property
    def length_ms(self) -> int:
        return (self.end - self.start) // _MS


def credited_interval(started_at: datetime, ended_at: datetime, active_ms: int) -> Interval:
    """The interval an activity event is credited with (see the module note)."""
    if active_ms < 0:
        raise ValueError("active time cannot be negative")
    span = ended_at - started_at
    return Interval(started_at, started_at + min(timedelta(milliseconds=active_ms), span))


def merge_activity_intervals(intervals: Iterable[Interval]) -> tuple[Interval, ...]:
    """Overlapping or touching intervals merged into disjoint ones, in ascending order."""
    merged: list[Interval] = []
    for item in sorted(intervals, key=lambda i: (i.start, i.end)):
        if merged and item.start <= merged[-1].end:
            if item.end > merged[-1].end:
                merged[-1] = Interval(merged[-1].start, item.end)
        else:
            merged.append(item)
    return tuple(merged)


def union_ms(intervals: Iterable[Interval]) -> int:
    """Total length of the union, in whole milliseconds (the sum of exact lengths, then floored)."""
    total = sum((i.end - i.start for i in merge_activity_intervals(intervals)), timedelta())
    return total // _MS


def added_ms(existing: Iterable[Interval], new: Interval) -> int:
    """Time ``new`` adds to the credited total: 0 when it lies inside what is already credited."""
    kept = list(existing)
    return union_ms([*kept, new]) - union_ms(kept)


def session_active_ms(session_intervals: Iterable[Interval]) -> int:
    """Verified active time attributed to one session (``CompleteResponse.summary.activeMs``): the
    union of that session's own credited intervals. Completing a session adds no time."""
    return union_ms(session_intervals)


# --- activity events -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ActivityAccepted:
    """A valid activity event: the credited interval and the learning date it belongs to."""

    interval: Interval
    learning_date: date
    active_ms: int  # as reported, already within the bounds


@dataclass(frozen=True, slots=True)
class ActivityRejected:
    """Out of bounds (``activity_out_of_bounds``): no credit, final. ``reason`` is one of the
    constants above and is safe to log (it carries no value)."""

    reason: str


@dataclass(frozen=True, slots=True)
class ActivityIgnored:
    """Valid but never counted: placement sessions are excluded from daily totals (D40). The event
    is acknowledged so that the client can drop it, and nothing is recorded."""

    reason: str = "placement_session"


ActivityVerdict = ActivityAccepted | ActivityRejected | ActivityIgnored


def validate_activity(
    *,
    started_at: datetime,
    ended_at: datetime,
    active_ms: int,
    server_now: datetime,
    session_created_at: datetime,
    session_kind: str,
    time_zone: str | None = None,
    pending_time_zone: str | None = None,
    pending_effective: date | None = None,
    learning_date: date | None = None,
) -> ActivityVerdict:
    """Check one activity event against the server clock and the session (contract §7).

    ``endedAt <= serverNow + 60 s``; ``startedAt >= session.createdAt - 60 s``;
    ``activeMs <= endedAt - startedAt + 1000``; at most 30 minutes per event (the span and the
    active time both); a placement session is never counted. The learning date comes from
    ``startedAt`` in the account time zone effective that day, or is given as ``learning_date`` by a
    caller that already resolved it (then no zone is needed). The device clock is never proof: only
    these bounds relative to the server's own time decide.
    """
    for value in (started_at, ended_at, server_now, session_created_at):
        if value.tzinfo is None:
            raise ValueError("every instant needs a time zone")
    if ended_at < started_at:
        return ActivityRejected(ENDED_BEFORE_STARTED)
    if active_ms < 0:
        return ActivityRejected(NEGATIVE_ACTIVE_TIME)
    if ended_at > server_now + CLOCK_SKEW:
        return ActivityRejected(ENDS_IN_THE_FUTURE)
    if started_at < session_created_at - CLOCK_SKEW:
        return ActivityRejected(STARTS_BEFORE_THE_SESSION)
    span_ms = (ended_at - started_at) // _MS
    if active_ms > span_ms + SPAN_SLACK_MS:
        return ActivityRejected(ACTIVE_EXCEEDS_SPAN)
    if span_ms > MAX_EVENT_MS or active_ms > MAX_EVENT_MS:
        return ActivityRejected(EVENT_TOO_LONG)
    if session_kind == PLACEMENT:
        return ActivityIgnored()
    if learning_date is None:
        if time_zone is None:
            raise ValueError("a time zone or a learning date is needed")
        learning_date = learning_date_at(
            started_at, time_zone, pending_time_zone, pending_effective
        )
    return ActivityAccepted(
        interval=credited_interval(started_at, ended_at, active_ms),
        learning_date=learning_date,
        active_ms=active_ms,
    )


# --- the daily goal and its completion (D40, D57) ------------------------------------------------


def daily_goal_ms(session_minutes: int) -> int:
    """The daily goal: the plan's session minutes times 60 000 (API-spec E18, A-07)."""
    if session_minutes <= 0:
        raise ValueError("session minutes must be positive")
    return session_minutes * MS_PER_MINUTE


def resolve_goal_ms(stored_goal_ms: int | None, session_minutes: int | None) -> int:
    """The goal of a learning date. A ``daily_progress`` row keeps the goal it was created with, so
    a change of minutes takes effect the next learning day and never rewrites today (D57); without
    a row the plan's minutes in force give it; with neither there is no goal (0)."""
    if stored_goal_ms is not None and stored_goal_ms > 0:
        return stored_goal_ms
    if session_minutes is not None and session_minutes > 0:
        return daily_goal_ms(session_minutes)
    return 0


@dataclass(frozen=True, slots=True)
class DailySummary:
    """The ``DailyProgress`` of one learning date."""

    learning_date: date
    active_ms: int
    goal_ms: int
    percent: int
    completed: bool
    extra_ms: int


def summarize_day(
    learning_date: date, active_ms: int, goal_ms: int, *, completed: bool
) -> DailySummary:
    """``percent = floor(100 * active / goal)`` never above 100; the surplus time is ``extra_ms``
    (``max(0, active - goal)``) with no second completion and no carry-over. Without a goal both are
    0. ``completed`` is true once the single completion of the date exists."""
    if active_ms < 0 or goal_ms < 0:
        raise ValueError("durations cannot be negative")
    if goal_ms == 0:
        return DailySummary(learning_date, active_ms, 0, 0, completed, 0)
    return DailySummary(
        learning_date=learning_date,
        active_ms=active_ms,
        goal_ms=goal_ms,
        percent=min(100, 100 * active_ms // goal_ms),
        completed=completed,
        extra_ms=max(0, active_ms - goal_ms),
    )


def should_record_completion(active_ms: int, goal_ms: int, *, already_completed: bool) -> bool:
    """The completion of a date is written once, when verified active time reaches the goal; games
    alone and wrong answers reach it too, and a later replay or game cannot write a second one."""
    return goal_ms > 0 and active_ms >= goal_ms and not already_completed


# --- streak and history --------------------------------------------------------------------------


def streak_days(completed_dates: Collection[date], today: date) -> int:
    """Consecutive learning dates with the daily goal met, up to and including today or yesterday:
    a streak that ends yesterday still counts while today is not done yet."""
    day = today if today in completed_dates else today - timedelta(days=1)
    count = 0
    while day in completed_dates:
        count += 1
        day -= timedelta(days=1)
    return count


def history_range(today: date) -> tuple[date, date]:
    """The learning days E19 lists: the last 30 days before today, oldest first."""
    return today - timedelta(days=HISTORY_DAYS), today - timedelta(days=1)
