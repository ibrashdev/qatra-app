"""Two seams between package B6 (E18 to E22) and the rest of the application, via ``create_app``.

1. **The account time zone dates an activity event (E21).** Implementation-contract §7: the
   learning date of an interval comes "from ``startedAt`` in the account time zone effective that
   day". The calendar that E21 reads (``PlanServiceCalendar``) names the zone, so an interval
   belongs to the learning date of its start, not of its session. The zone scenarios run in memory
   mode and in supabase mode (a fake PostgREST project, no network) and must give the same
   answers. The clock is injected: the account is in Asia/Dubai (UTC+4, no daylight saving), so
   20:00 UTC is local midnight.

2. **The learning record of a revision conversation holds the days E21 recorded.** B13 reads
   ``daily_progress_between`` when the learning repository has it, and B6's repositories now do.
   The observable is the one B13's own tests use: the payload that would reach the model.

The identity is the fake of ``login_as`` in the zone scenarios (TEST ONLY: authentication is another
package) and a real registered session in the revision scenario; everything else is the production
wiring. Synthetic data only.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from app.repositories.plans import LearningZone
from tests.integration import core_support
from tests.integration.b6_support import B6Project
from tests.integration.core_support import Mode, daily, memory_mode, supabase_mode
from tests.plan_chat.pc_e2e_support import FREE_GOAL, FakeOpenRouter, build_journey, with_model
from tests.plan_chat.pc_supabase_support import MODEL_SETTINGS
from tests.plans.plans_support import session_context
from tests.sessions.ss_events_support import activity_event
from tests.sessions.ss_support import OTHER_USER, USER

MIDNIGHT = datetime(2026, 10, 5, 20, 0, tzinfo=UTC)  # 00:00 on 2026-10-06 in Asia/Dubai
GOAL_MS = 300_000  # the plan of ``Mode.create_plan`` has five session minutes


# -- helpers --------------------------------------------------------------------------------------


def open_daily(mode: Mode, plan: dict[str, Any]) -> dict[str, Any]:
    """E20 for the daily session of the learning date the clock is in."""
    response = mode.post("/api/sessions", daily(plan["planId"], plan["currentVersion"]))
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def send(mode: Mode, session: dict[str, Any], *events: dict[str, Any]) -> dict[str, Any]:
    """E21 with events that must all be acknowledged."""
    response = mode.post(f"/api/sessions/{session['sessionId']}/events", {"events": list(events)})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert body["rejected"] == [] and body["pending"] == []
    assert len(body["acknowledged"]) == len(events)
    return body


def read(mode: Mode, path: str) -> dict[str, Any]:
    response = mode.client.get(path)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def day(learning_date: str, active_ms: int) -> dict[str, Any]:
    """The ``DailyProgress`` of a learning date with the goal of five minutes."""
    return {
        "learningDate": learning_date,
        "dailyActiveMs": active_ms,
        "dailyGoalMs": GOAL_MS,
        "dailyPercent": min(100, 100 * active_ms // GOAL_MS),
        "dailyCompleted": active_ms >= GOAL_MS,
        "extraActiveMs": max(0, active_ms - GOAL_MS),
    }


@dataclass
class Zoned:
    """One backend of the zone scenarios and the way it stores the zone of the profile."""

    mode: Mode
    set_zone: Callable[[LearningZone], None]


@pytest.fixture(params=["memory", "supabase"])
def zoned(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Zoned:
    if request.param == "memory":
        mode = memory_mode()
        profiles = mode.app.state.plan_service._profiles  # the synthetic profiles of memory mode
        return Zoned(mode, lambda zone: profiles.set_zone(USER, zone))
    monkeypatch.setattr(core_support, "FakeProject", B6Project)  # the fake that serves E21
    mode, project = supabase_mode()

    def set_zone(zone: LearningZone) -> None:
        pending = None
        if zone.pending_time_zone is not None and zone.pending_effective is not None:
            pending = {
                "timeZone": zone.pending_time_zone,
                "effectiveDate": zone.pending_effective.isoformat(),
            }
        project.plans.profiles[USER] = {"time_zone": zone.time_zone, "pending_settings": pending}

    return Zoned(mode, set_zone)


# -- 1. the time zone dates an activity event --------------------------------------------------


def test_an_event_that_starts_after_local_midnight_goes_to_the_next_learning_date(
    zoned: Zoned,
) -> None:
    """The session is prepared at 23:50 on the 5th. The learner works across midnight: a stretch
    from 00:01 to 00:03 on the 6th is time of the 6th, whatever session it belongs to."""
    mode = zoned.mode
    plan = mode.create_plan()
    mode.clock.now = MIDNIGHT - timedelta(minutes=10)
    session = open_daily(mode, plan)
    assert session["learningDate"] == "2026-10-05"

    mode.clock.now = MIDNIGHT + timedelta(minutes=5)
    body = send(mode, session, activity_event(60, 180, base=MIDNIGHT))
    assert body["daily"] == day("2026-10-06", 120_000)  # the figure of today, the 6th

    today = read(mode, "/api/today")
    assert (today["learningDate"], today["dailyActiveMs"], today["dailyPercent"]) == (
        "2026-10-06",
        120_000,
        40,
    )
    progress = read(mode, "/api/progress")
    assert progress["daily"] == day("2026-10-06", 120_000)
    assert progress["history"] == []  # nothing was credited to the 5th


def test_an_event_that_starts_before_local_midnight_keeps_the_date_it_started_on(
    zoned: Zoned,
) -> None:
    """A stretch before midnight is time of the 5th. One that started before midnight and arrives
    after it (the learner was offline for a moment) is still time of the 5th."""
    mode = zoned.mode
    plan = mode.create_plan()
    mode.clock.now = MIDNIGHT - timedelta(minutes=10)
    session = open_daily(mode, plan)

    mode.clock.now = MIDNIGHT - timedelta(seconds=30)  # 23:59:30
    body = send(mode, session, activity_event(-300, -120, base=MIDNIGHT))  # 23:55:00 to 23:58:00
    assert body["daily"] == day("2026-10-05", 180_000)

    mode.clock.now = MIDNIGHT + timedelta(minutes=30)  # 00:30 on the 6th
    late = send(mode, session, activity_event(-90, -30, base=MIDNIGHT))  # 23:58:30 to 23:59:30
    assert late["daily"] == day("2026-10-06", 0)  # today is the 6th and has no time yet

    progress = read(mode, "/api/progress")
    assert progress["daily"] == day("2026-10-06", 0)
    assert progress["history"] == [
        {"date": "2026-10-05", "activeMs": 240_000, "goalMs": GOAL_MS, "completed": False}
    ]  # 180 s and 60 s, both credited to the day they started on


def test_an_event_may_start_a_minute_before_its_session_and_keeps_its_own_date(
    zoned: Zoned,
) -> None:
    """The server allows an event to start up to 60 seconds before its session was created. A
    session prepared at 00:00:30 on the 6th (the 6th's session) can receive a stretch that began at
    23:59:45 on the 5th: that stretch is time of the 5th, and the whole of it is credited there."""
    mode = zoned.mode
    plan = mode.create_plan()
    mode.clock.now = MIDNIGHT + timedelta(seconds=30)
    session = open_daily(mode, plan)
    assert session["learningDate"] == "2026-10-06"

    mode.clock.now = MIDNIGHT + timedelta(minutes=2)
    body = send(mode, session, activity_event(-15, 45, base=MIDNIGHT))  # 23:59:45 to 00:00:45
    assert body["daily"] == day("2026-10-06", 0)
    progress = read(mode, "/api/progress")
    assert progress["history"] == [
        {"date": "2026-10-05", "activeMs": 60_000, "goalMs": GOAL_MS, "completed": False}
    ]


def test_a_pending_zone_change_is_honoured_from_its_effective_date(zoned: Zoned) -> None:
    """Dubai (UTC+4) until the 5th, Auckland (UTC+13) from the 6th (D57). 16:10 on the 5th in Dubai
    is already the 6th in Auckland, but the change is not in force yet, so it is the 5th. 16:00 on
    the 6th in Dubai is 01:00 on the 7th in Auckland, and the new zone rules from its effective
    date, so that stretch belongs to the 7th (the 6th is skipped, as it is for ``today``)."""
    mode = zoned.mode
    plan = mode.create_plan()
    zoned.set_zone(LearningZone("Asia/Dubai", "Pacific/Auckland", date(2026, 10, 6)))
    first_day = datetime(2026, 10, 5, 12, 0, tzinfo=UTC)
    mode.clock.now = first_day
    session = open_daily(mode, plan)
    assert session["learningDate"] == "2026-10-05"

    mode.clock.now = first_day + timedelta(minutes=15)
    before = send(mode, session, activity_event(600, 720, base=first_day))  # 12:10 to 12:12 UTC
    assert before["daily"] == day("2026-10-05", 120_000)

    second_day = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    mode.clock.now = second_day + timedelta(minutes=5)
    after = send(mode, session, activity_event(0, 120, base=second_day))  # 12:00 to 12:02 UTC
    assert after["daily"] == day("2026-10-07", 120_000)

    today = read(mode, "/api/today")
    assert (today["learningDate"], today["dailyActiveMs"]) == ("2026-10-07", 120_000)
    progress = read(mode, "/api/progress")
    assert progress["daily"] == day("2026-10-07", 120_000)
    assert progress["history"] == [
        {"date": "2026-10-05", "activeMs": 120_000, "goalMs": GOAL_MS, "completed": False}
    ]


def test_the_plan_service_and_its_calendar_name_the_zone_of_the_profile() -> None:
    mode = memory_mode()
    plans = mode.app.state.plan_service
    calendar = mode.app.state.sessions_service.calendar
    ctx, other = session_context(USER), session_context(OTHER_USER)
    assert plans.learning_zone(ctx) == calendar.learning_zone(ctx) == LearningZone("Asia/Dubai")

    zone = LearningZone("Asia/Dubai", "Pacific/Auckland", date(2026, 10, 6))
    plans._profiles.set_zone(USER, zone)
    assert plans.learning_zone(ctx) == calendar.learning_zone(ctx) == zone
    assert calendar.learning_zone(other) == LearningZone("Asia/Dubai")  # each profile is its own
    # "today" and the zone come from the same profile: the 6th in Dubai is the 7th in Auckland
    mode.clock.now = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    assert calendar.learning_date(ctx) == date(2026, 10, 7)
    assert calendar.learning_date(other) == date(2026, 10, 6)


# -- 2. the learning record of a revision conversation holds the days of E21 ------------------


def test_a_revision_conversation_is_given_the_days_that_e21_recorded() -> None:
    """Two days of activity are recorded with E21. A revision conversation (E31 with a plan id)
    sends the model the minutes of those two days, as the learning record of B13 reads them from
    the repositories that B6 fills."""
    fake = FakeOpenRouter()
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    client = journey.client
    first = journey.create_chat()  # a rules turn: the composed goal sentence makes no model call
    created = client.post(f"/api/plan-chats/{first['chatId']}/confirm", json={"proposalVersion": 1})
    assert created.status_code == 201
    plan = created.json()

    def activity_of_the_day(seconds: int) -> None:
        """E20 for the day the clock is in, then one stretch of ``seconds`` of verified time."""
        opened = client.post(
            "/api/sessions",
            json={
                "kind": "daily",
                "planId": plan["planId"],
                "expectedPlanVersion": plan["currentVersion"],
            },
        )
        assert opened.status_code == 201, opened.text
        session = opened.json()
        journey.clock.now += timedelta(minutes=10)
        started = datetime.fromisoformat(session["createdAt"])
        recorded = client.post(
            f"/api/sessions/{session['sessionId']}/events",
            json={"events": [activity_event(5, 5 + seconds, base=started)]},
        )
        assert recorded.status_code == 200, recorded.text
        assert len(recorded.json()["acknowledged"]) == 1 and recorded.json()["rejected"] == []

    activity_of_the_day(300)  # the 5th: five minutes
    journey.clock.now += timedelta(days=1)
    activity_of_the_day(250)  # the 6th: 4 minutes 10 seconds
    progress = client.get("/api/progress").json()
    assert progress["daily"]["learningDate"] == "2026-10-06"
    assert progress["daily"]["dailyActiveMs"] == 250_000
    assert [(row["date"], row["activeMs"]) for row in progress["history"]] == [
        ("2026-10-05", 300_000)
    ]

    revision = journey.create_chat(goal=FREE_GOAL, planId=plan["planId"])
    assert revision["planId"] == plan["planId"]
    (request,) = fake.completions
    payload = json.loads(json.loads(request.content)["messages"][1]["content"])
    assert payload["learningRecord"] == {
        "passages": [],
        "errorParts": [],
        "dailyTime": [
            {"date": "2026-10-05", "activeMinutes": 5},
            {"date": "2026-10-06", "activeMinutes": 4},  # 250 seconds, rounded to whole minutes
        ],
        "attempts": [],
    }
