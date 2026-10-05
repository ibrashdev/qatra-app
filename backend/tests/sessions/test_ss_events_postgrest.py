"""E21 and E22 on the PostgREST adapters (``httpx.MockTransport``, no network): what is sent to
``app_apply_events`` and ``app_complete_session``, what is read, and how a failure of either call
reaches the caller. The scenarios that both modes share are in the other ``test_ss_events_*``
files; here only the wire is looked at."""

from __future__ import annotations

import json
import threading
import uuid
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.errors import ErrorCode
from tests.sessions.ss_events_support import (
    BASE,
    FIRST_PASSAGE,
    World,
    activity_event,
    answer_event,
    due_row,
    envelope_of,
)
from tests.sessions.ss_support import PLAN_ID, TODAY, error_of


@pytest.fixture
def world() -> World:
    return World("postgrest")


def fake_of(world: World):
    assert world.fake is not None
    return world.fake


def respond(status: int, **body: Any):
    return lambda request: httpx.Response(status, json=body)


def sqlstate(status: int, code: str, message: str = "refused"):
    return respond(status, code=code, message=message, details=None, hint=None)


ATTEMPT_KEYS = {
    "client_event_id",
    "question_id",
    "passage_id",
    "correct",
    "assisted",
    "error_kind",
    "wrong_token_ref",
    "review_round_id",
    "duration_ms",
    "occurred_at",
}
MASTERY_KEYS = {
    "plan_id",
    "passage_id",
    "status",
    "consecutive_correct",
    "initial_success_at",
    "initial_learning_date",
    "review_stage",
    "next_review_due",
    "last_review_date",
    "confirmed_at",
    "first_confirmed_at",
    "maintenance_stage",
    "lapse_count",
    "error_part_ids",
}


# --- what is sent --------------------------------------------------------------------------------


def test_an_answer_is_sent_as_one_attempt_element_with_its_mastery_and_evidence(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    question = game.questions[0]
    event = answer_event(question)
    world.post(game, [event])
    (call,) = fake_of(world).calls_to("rpc/app_apply_events")
    body = json.loads(call.content)
    assert set(body) == {"p_session_id", "p_events", "p_daily", "p_open_session"}
    assert body["p_session_id"] == str(game.id)
    assert body["p_daily"] is None and body["p_open_session"] is False
    [element] = body["p_events"]
    assert set(element) == {"attempt", "mastery", "evidence"}
    assert set(element["attempt"]) == ATTEMPT_KEYS
    assert element["attempt"]["client_event_id"] == event["clientEventId"]
    assert element["attempt"]["question_id"] == question["questionId"]
    assert element["attempt"]["error_kind"] == "none" and element["attempt"]["correct"] is True
    assert set(element["mastery"]) == MASTERY_KEYS
    assert element["mastery"]["plan_id"] == str(PLAN_ID)
    assert element["mastery"]["consecutive_correct"] == 1
    assert element["evidence"] and all(
        set(item) == {"plan_id", "passage_id", "part_id", "learning_date"}
        for item in element["evidence"]
    )


def test_the_typed_text_of_a_recall_answer_is_never_sent(world: World) -> None:
    game = world.game(FIRST_PASSAGE, gameType="word_recall")
    event = answer_event(game.questions[0], ok=False)
    typed = "typed-text-that-must-not-travel"
    event["answer"] = {"text": typed}
    world.post(game, [event])
    assert typed not in json.dumps(fake_of(world).apply_bodies)


def test_an_assisted_answer_is_sent_with_no_evidence_and_no_streak(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(game.questions[0], hint=True)])
    [element] = fake_of(world).apply_bodies[0]["p_events"]
    assert element["attempt"]["assisted"] is True and element["evidence"] == []
    assert element["mastery"]["status"] == "learning"  # the passage was started
    assert element["mastery"]["consecutive_correct"] == 0


def test_a_review_question_answered_again_is_recorded_without_mastery(world: World) -> None:
    world.seed_mastery(due_row(FIRST_PASSAGE))
    session = world.open("daily")
    first = session.of(role="review", passage=FIRST_PASSAGE)[0]
    world.post(session, [answer_event(first)])
    world.post(session, [answer_event(first, at=BASE.replace(minute=5))])
    second_call = fake_of(world).apply_bodies[1]["p_events"]
    assert set(second_call[0]) == {"attempt"}


def test_a_wrong_choice_sends_the_reference_of_the_picked_option_never_its_text(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    choice = game.of(type="word_choice")[0]
    event = answer_event(choice, ok=False)
    world.post(game, [event])
    attempt = fake_of(world).apply_bodies[0]["p_events"][0]["attempt"]
    assert attempt["error_kind"] == "wrong_choice"
    assert attempt["wrong_token_ref"] == event["answer"]["optionId"].split(",")[0]


def test_an_activity_event_is_sent_as_an_interval_with_the_day_of_the_session(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    event = activity_event(5, 185)
    world.post(game, [event])
    (body,) = fake_of(world).apply_bodies
    [element] = body["p_events"]
    assert element == {
        "interval": {
            "client_event_id": event["clientEventId"],
            "started_at": event["startedAt"],
            "ended_at": event["endedAt"],
            "active_ms": 180_000,
            "learning_date": "2026-10-05",
        }
    }
    assert body["p_daily"] == {
        "learning_date": "2026-10-05",
        "active_ms": 180_000,
        "goal_ms": 600_000,
        "completed": False,
        "reached_in_plan_id": None,
    }


def test_the_goal_reaching_request_asks_for_the_single_completion(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(0, 600)])
    daily = fake_of(world).apply_bodies[0]["p_daily"]
    assert daily["completed"] is True and daily["reached_in_plan_id"] == str(PLAN_ID)


def test_a_request_is_one_call_and_every_further_learning_date_one_more(world: World) -> None:
    game = world.game(FIRST_PASSAGE, advance_minutes=13 * 60 + 2)  # 00:02 on the 6th in Dubai
    world.calendar.today = TODAY.replace(day=6)
    midnight = datetime(2026, 10, 5, 20, 0, tzinfo=UTC)
    before = activity_event(-30, 30, base=midnight)
    after = activity_event(40, 100, base=midnight)
    answer = answer_event(game.questions[0], at=midnight)
    world.post(game, [before, after, answer])
    first, second = fake_of(world).apply_bodies
    assert [list(element) for element in first["p_events"]][:2] == [["interval"], ["interval"]]
    assert len(first["p_events"]) == 3 and first["p_daily"]["learning_date"] == "2026-10-06"
    assert second["p_events"] == [] and second["p_daily"]["learning_date"] == "2026-10-05"
    assert second["p_open_session"] is False


def test_a_prepared_session_is_opened_by_the_call_that_records_its_first_event(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    world.make_offline(game)
    world.post(game, [answer_event(game.questions[0], **envelope_of(game, protocolVersion=2))])
    assert fake_of(world).apply_bodies == []  # nothing accepted: nothing sent
    world.post(game, [answer_event(game.questions[0], **envelope_of(game))])
    assert [b["p_open_session"] for b in fake_of(world).apply_bodies] == [True]
    world.post(game, [answer_event(game.questions[1], **envelope_of(game))])
    assert [b["p_open_session"] for b in fake_of(world).apply_bodies] == [True, False]


def test_a_request_without_anything_to_write_makes_no_apply_call(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    event = answer_event(game.questions[0])
    world.post(game, [event])
    bad = answer_event(game.questions[1])
    bad["questionId"] = str(uuid.uuid4())
    world.post(game, [event, bad])  # a duplicate and a rejected event
    assert len(fake_of(world).apply_bodies) == 1


def test_a_batch_of_duplicates_reads_only_the_event_ledger(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    event = answer_event(game.questions[0])
    world.post(game, [event])
    fake = fake_of(world)
    before = len(fake.requests)
    world.post(game, [event])
    paths = [r.url.path.removeprefix("/rest/v1/") for r in fake.requests[before:]]
    assert set(paths) <= {
        "learning_sessions",
        "plan_versions",
        "attempts",
        "session_activity_intervals",
        "daily_progress",
        "daily_completions",
    }
    assert "target_mastery" not in paths and "book_editions" not in paths
    assert not any(p.startswith("rpc/") for p in paths)


def test_every_request_of_the_flow_is_made_as_the_learner(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(game.questions[0]), activity_event(5, 65)])
    world.complete(game)
    requests = fake_of(world).requests
    assert requests and all(r.headers["authorization"].startswith("Bearer ") for r in requests)
    assert all(r.headers["apikey"] for r in requests)
    assert all(world.ctx.access_token.get_secret_value() not in str(r.url) for r in requests)  # type: ignore[union-attr]


def test_two_requests_can_be_in_flight_at_once(world: World) -> None:
    """Nothing in the service serialises requests by itself (``functools.cached_property`` would in
    Python 3.11). On the adapters two requests therefore overlap, which is the reason for the known
    limitation of the fixed function interface (a lost streak update)."""
    game = world.game(FIRST_PASSAGE)
    barrier = threading.Barrier(2)
    real = world.learning.mastery_for_plan
    met: list[bool] = []

    def meet_in_the_middle(ctx: Any, plan_id: UUID) -> Any:
        found = real(ctx, plan_id)
        try:
            barrier.wait(timeout=3)
            met.append(True)
        except threading.BrokenBarrierError:
            met.append(False)
        return found

    world.learning.mastery_for_plan = meet_in_the_middle
    questions = game.questions[:2]
    threads = [
        threading.Thread(target=world.post, args=(game, [answer_event(question)]))
        for question in questions
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert met == [True, True]


# --- what is answered with when a call fails -----------------------------------------------------


@pytest.mark.parametrize(
    ("answer", "code"),
    [
        (sqlstate(500, "P0002", "session_not_found"), ErrorCode.not_found),
        (sqlstate(400, "23514", "new row violates check constraint"), ErrorCode.unavailable),
        (sqlstate(400, "22023", "p_events must be a JSON array"), ErrorCode.unavailable),
        (sqlstate(403, "42501", "permission denied"), ErrorCode.unavailable),
        (sqlstate(404, "PGRST202", "no such function"), ErrorCode.unavailable),
        (respond(503, message="down"), ErrorCode.unavailable),
        (respond(401, code="PGRST301", message="JWT expired"), ErrorCode.unauthenticated),
    ],
    ids=["session vanished", "check", "bad argument", "grant", "no function", "down", "expired"],
)
def test_a_refused_apply_reaches_the_caller_as_the_right_error(world: World, answer, code) -> None:
    game = world.game(FIRST_PASSAGE)
    fake_of(world).fail("rpc/app_apply_events", answer)
    error = error_of(lambda: world.post(game, [answer_event(game.questions[0])]))
    assert error.code is code
    assert "violates" not in str(error.details) and "permission" not in str(error.details)


def test_a_network_failure_of_apply_is_unavailable_and_nothing_is_acknowledged(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)

    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    fake_of(world).fail("rpc/app_apply_events", broken)
    assert error_of(lambda: world.post(game, [answer_event(game.questions[0])])).code is (
        ErrorCode.unavailable
    )
    assert world.attempts(game) == []


@pytest.mark.parametrize(
    "result",
    [
        {"outcomes": "x"},
        {"outcomes": []},
        {"outcomes": ["acknowledged", "acknowledged"]},
        {"outcomes": ["maybe"]},
        {},
        [],
    ],
    ids=["text", "too few", "too many", "unknown outcome", "no outcomes", "list"],
)
def test_an_answer_of_apply_that_does_not_fit_is_an_internal_error(world: World, result) -> None:
    game = world.game(FIRST_PASSAGE)
    fake_of(world).fail("rpc/app_apply_events", lambda request: httpx.Response(200, json=result))
    error = error_of(lambda: world.post(game, [answer_event(game.questions[0])]))
    assert error.code is ErrorCode.internal


def test_a_refused_apply_leaves_the_state_as_it_was_and_the_events_may_be_sent_again(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    event = answer_event(game.questions[0])
    fake_of(world).fail("rpc/app_apply_events", sqlstate(503, "08006"))
    assert error_of(lambda: world.post(game, [event])).code is ErrorCode.unavailable
    assert world.attempts(game) == [] and world.mastery(FIRST_PASSAGE) is None
    body = world.post(game, [event])  # the same id is not a duplicate: nothing was stored
    assert body["acknowledged"] == [event["clientEventId"]]


def test_a_session_that_vanishes_between_the_read_and_the_apply_is_not_found(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    rows = fake_of(world).tables["learning_sessions"]
    original = world.learning.read_session

    def read_then_lose(ctx, session_id):
        found = original(ctx, session_id)
        rows[:] = []
        return found

    world.learning.read_session = read_then_lose  # type: ignore[method-assign]
    error = error_of(lambda: world.post(game, [answer_event(game.questions[0])]))
    assert error.code is ErrorCode.not_found


@pytest.mark.parametrize(
    ("answer", "code"),
    [
        (sqlstate(500, "P0002", "session_not_found"), ErrorCode.not_found),
        (sqlstate(400, "23514", "elapsed"), ErrorCode.unavailable),
        (respond(503, message="down"), ErrorCode.unavailable),
        (respond(401, code="PGRST301", message="JWT expired"), ErrorCode.unauthenticated),
    ],
    ids=["session vanished", "check", "down", "expired"],
)
def test_a_refused_completion_reaches_the_caller_as_the_right_error(
    world: World, answer, code
) -> None:
    game = world.game(FIRST_PASSAGE)
    fake_of(world).fail("rpc/app_complete_session", answer)
    assert error_of(lambda: world.complete(game)).code is code
    assert world.session_row(game).status == "open"  # type: ignore[union-attr]


@pytest.mark.parametrize("result", ["yes", 1, None, {"completed": True}], ids=str)
def test_an_answer_of_complete_that_is_not_a_boolean_is_an_error(world: World, result) -> None:
    game = world.game(FIRST_PASSAGE)
    fake_of(world).fail(
        "rpc/app_complete_session", lambda request: httpx.Response(200, json=result)
    )
    assert error_of(lambda: world.complete(game)).code is ErrorCode.internal


def test_a_completion_that_was_already_done_by_another_call_is_reported_not_repeated(
    world: World,
) -> None:
    """The database answers ``false`` when another request completed the session first."""
    game = world.game(FIRST_PASSAGE)
    fake_of(world).fail("rpc/app_complete_session", lambda request: httpx.Response(200, json=False))
    body = world.complete(game)
    assert body["summary"]["answered"] == 0


def test_the_completion_call_carries_the_verified_time_of_the_session(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(5, 125), activity_event(65, 185)])
    world.complete(game)
    assert fake_of(world).complete_bodies == [
        {"p_session_id": str(game.id), "p_elapsed_ms": 180_000}
    ]
