"""The offline round trip, in memory and PostgREST mode: E23 prepares sessions, the device plays
them offline and replays the events (E21) with the full offline envelope, E22 closes a session,
and a plan revision leaves the old events pending without credit (D58, D59; API-spec E21 steps 4
and 5)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest

from tests.offline.off_support import MODES, OfflineWorld, questions_of
from tests.sessions.ss_events_support import activity_event, answer_event
from tests.sessions.ss_support import NOW, PLAN_ID, error_of


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> OfflineWorld:
    world = OfflineWorld(request.param)
    return world


@pytest.fixture
def snapshot(world: OfflineWorld) -> dict[str, Any]:
    made, _ = world.create()
    world.clock.advance(minutes=10)  # the device plays later and syncs later
    return made


def play(
    world: OfflineWorld,
    snapshot: dict[str, Any],
    session: dict[str, Any],
    count: int,
    *,
    ok: bool = True,
    run: UUID | None = None,
    skip: int = 0,
) -> list[dict[str, Any]]:
    """Answer ``count`` questions of the prepared session (after the first ``skip``) as one run."""
    run = run or uuid.uuid4()
    chosen = questions_of(session)[skip : skip + count]
    return [
        answer_event(
            question,
            ok=ok,
            at=NOW + timedelta(seconds=30 + 10 * index),
            **world.envelope(snapshot, skip + index, run),
        )
        for index, question in enumerate(chosen)
    ]


def ids_of(events: list[dict[str, Any]]) -> list[str]:
    return [event["clientEventId"] for event in events]


def session_id(session: dict[str, Any]) -> UUID:
    return UUID(session["sessionId"])


def status_of(world: OfflineWorld, session: dict[str, Any]) -> str:
    stored = world.learning.read_session(world.ctx, session_id(session))
    assert stored is not None
    return stored.status


# --- the main journey ----------------------------------------------------------------------------


def test_offline_replay_is_acknowledged_then_duplicate_then_pending_after_a_plan_revision(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    run = uuid.uuid4()
    events = play(world, snapshot, daily, 3, run=run)
    events.append(activity_event(10, 70, **world.envelope(snapshot, 3, run)))
    assert status_of(world, daily) == "prepared"

    first = world.post(session_id(daily), events)
    assert first["acknowledged"] == ids_of(events)
    assert first["duplicate"] == first["pending"] == first["rejected"] == []
    assert [r["correct"] for r in first["results"]] == [True, True, True]
    assert first["daily"]["dailyActiveMs"] == 60_000
    assert status_of(world, daily) == "open", "the first accepted event opens the prepared session"
    assert len(world.attempts(session_id(daily))) == 3

    again = world.post(session_id(daily), events)  # the response was lost: resend the same ids
    assert again["duplicate"] == ids_of(events)
    assert again["acknowledged"] == again["pending"] == again["rejected"] == []
    assert len(world.attempts(session_id(daily))) == 3, "no double credit"
    assert world.daily_row(NOW.date()).active_ms == 60_000

    world.set_plan_version(3)  # the plan was revised while the device was offline
    late = play(world, snapshot, daily, 1, run=run, skip=3)
    pending = world.post(session_id(daily), late)
    assert pending["acknowledged"] == [] and pending["rejected"] == []
    assert pending["pending"] == [
        {"clientEventId": late[0]["clientEventId"], "reasonCode": "plan_changed_unverifiable"}
    ]
    assert len(world.attempts(session_id(daily))) == 3, "pending events earn no credit"
    assert world.post(session_id(daily), events)["duplicate"] == ids_of(events)
    assert world.revalidate(snapshot)["status"] == "stale"


def test_a_prepared_session_can_be_played_again_with_a_new_run(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    first = play(world, snapshot, daily, 2)
    second = play(world, snapshot, daily, 2)  # a new clientRunId and new clientEventIds
    assert world.post(session_id(daily), first)["acknowledged"] == ids_of(first)
    result = world.post(session_id(daily), second)
    assert result["acknowledged"] == ids_of(second) and result["rejected"] == []
    assert world.revalidate(snapshot)["allowedSessionRefs"].count(daily["sessionId"]) == 1


def test_every_prepared_session_can_be_replayed(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    for session in snapshot["preparedSessions"]:
        events = play(world, snapshot, session, 2)
        result = world.post(session_id(session), events)
        assert result["acknowledged"] == ids_of(events), session["kind"]
        assert status_of(world, session) == "open"
    allowed = world.revalidate(snapshot)["allowedSessionRefs"]
    assert allowed == [s["sessionId"] for s in snapshot["preparedSessions"]]


def test_the_offline_daily_session_coexists_with_the_online_one(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    online = world.open("daily")
    assert str(online.id) not in {s["sessionId"] for s in snapshot["preparedSessions"]}
    (daily,) = world.sessions_of(snapshot, "daily")
    events = play(world, snapshot, daily, 1)
    assert world.post(session_id(daily), events)["acknowledged"] == ids_of(events)


# --- the envelope --------------------------------------------------------------------------------


def test_an_event_without_the_envelope_is_rejected_on_a_prepared_session(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    event = answer_event(questions_of(daily)[0])
    result = world.post(session_id(daily), [event])
    assert result["rejected"] == [
        {"clientEventId": event["clientEventId"], "code": "envelope_mismatch"}
    ]
    assert status_of(world, daily) == "prepared"


@pytest.mark.parametrize(
    "change",
    [
        {"snapshotId": str(uuid.uuid4())},
        {"planVersion": 9},
        {"editionId": str(uuid.uuid4())},
        {"bankVersion": 9},
        {"protocolVersion": 2},
    ],
)
def test_an_envelope_that_does_not_match_the_session_is_rejected(
    world: OfflineWorld, snapshot: dict[str, Any], change: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    event = answer_event(questions_of(daily)[0], **{**world.envelope(snapshot), **change})
    result = world.post(session_id(daily), [event])
    assert result["rejected"] == [
        {"clientEventId": event["clientEventId"], "code": "envelope_mismatch"}
    ]
    assert world.attempts(session_id(daily)) == []


def test_the_events_of_another_account_cannot_reach_the_session(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    events = play(world, snapshot, daily, 1)
    error = error_of(
        lambda: world.service.record_events(world.foreign(), session_id(daily), {"events": events})
    )
    assert error.status == 404
    assert world.attempts(session_id(daily)) == []


# --- closing, revocation -------------------------------------------------------------------------


def test_closing_a_prepared_session_ends_its_reuse(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    events = play(world, snapshot, daily, 2)
    world.post(session_id(daily), events)
    summary = world.complete(session_id(daily))["summary"]
    assert summary["answered"] == 2 and summary["correct"] == 2
    assert world.complete(session_id(daily))["summary"] == summary, "completion is idempotent"

    more = play(world, snapshot, daily, 1, skip=2)
    result = world.post(session_id(daily), more)
    assert result["rejected"] == [
        {"clientEventId": more[0]["clientEventId"], "code": "session_closed"}
    ]
    allowed = world.revalidate(snapshot)["allowedSessionRefs"]
    assert (
        daily["sessionId"] not in allowed and len(allowed) == len(snapshot["preparedSessions"]) - 1
    )


def test_events_of_a_revoked_edition_are_rejected_without_credit(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    (daily,) = world.sessions_of(snapshot, "daily")
    events = play(world, snapshot, daily, 2)
    world.set_edition_status("revoked")
    result = world.post(session_id(daily), events)
    assert [r["code"] for r in result["rejected"]] == ["edition_mismatch"] * 2
    assert result["acknowledged"] == []
    assert world.attempts(session_id(daily)) == []
    assert world.revalidate(snapshot)["status"] == "revoked"


def test_a_plan_id_is_part_of_the_session_the_snapshot_prepared(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    for session in snapshot["preparedSessions"]:
        stored = world.learning.read_session(world.ctx, session_id(session))
        assert stored is not None and stored.plan_id == PLAN_ID
