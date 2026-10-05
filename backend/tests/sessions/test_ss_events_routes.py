"""E21 and E22 over HTTP: the order of the guards, status codes, strict bodies, limits and privacy.
Every scenario runs over the memory repositories and over the PostgREST adapters."""

from __future__ import annotations

import uuid
from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.rate_limit import SlidingWindowLimiter
from tests.sessions.ss_events_support import (
    FIRST_PASSAGE,
    MODES,
    Opened,
    World,
    activity_event,
    answer_event,
    envelope_of,
)
from tests.sessions.ss_support import PLAN_ID, QURAN
from tests.support import make_settings
from tests.test_origin import unguarded_mutations


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    return World(request.param)


@pytest.fixture
def web(world: World) -> tuple[World, TestClient, Opened]:
    """The world, a logged-in browser-like client and an open game session of the account."""
    return world, world.client(), world.game(FIRST_PASSAGE)


def events_url(session: Opened | uuid.UUID) -> str:
    return f"/api/sessions/{session.id if isinstance(session, Opened) else session}/events"


def complete_url(session: Opened | uuid.UUID) -> str:
    return f"/api/sessions/{session.id if isinstance(session, Opened) else session}/complete"


def error_body(response) -> dict[str, Any]:
    assert response.headers["cache-control"] == "no-store"
    return response.json()["error"]


def fields_of(response) -> list[tuple[str, str]]:
    return [(f["field"], f["rule"]) for f in error_body(response)["details"]["fields"]]


# --- guards, in order ----------------------------------------------------------------------------


def test_without_a_session_both_routes_are_unauthenticated_and_never_read_the_body(
    world: World,
) -> None:
    client = world.client(login=False)
    target = uuid.uuid4()
    for response in (
        client.post(events_url(target), json={"events": []}),
        client.post(events_url(target), json=[1]),
        client.post(complete_url(target)),
    ):
        assert response.status_code == 401
        assert error_body(response)["code"] == "unauthenticated"


@pytest.mark.parametrize("origin", [None, "http://evil.example", "http://localhost:3000/"])
def test_the_origin_is_checked_before_the_session(world: World, origin: str | None) -> None:
    game = world.game(FIRST_PASSAGE)
    headers = {"Origin": origin} if origin else {}
    with TestClient(world.app()) as bare:
        for response in (
            bare.post(events_url(game), json={"events": [activity_event(5, 65)]}, headers=headers),
            bare.post(complete_url(game), headers=headers),
        ):
            assert response.status_code == 403
            assert error_body(response)["code"] == "forbidden_origin"
    assert world.attempts(game) == [] and world.intervals(world.calendar.today) == []


def test_every_state_changing_route_still_checks_origin_first(world: World) -> None:
    assert unguarded_mutations(world.app()) == []


def test_the_operations_are_registered_once_with_the_documented_responses(world: World) -> None:
    paths = world.app().openapi()["paths"]
    events = paths["/api/sessions/{session_id}/events"]["post"]["responses"]
    complete = paths["/api/sessions/{session_id}/complete"]["post"]["responses"]
    assert set(events) == {"200", "401", "403", "404", "413", "422", "429", "503"}
    assert set(complete) == {"200", "401", "403", "404", "422", "429", "503"}  # no 409 in E21/E22
    assert set(paths["/api/sessions/{session_id}/events"]) == {"post"}
    assert set(paths["/api/sessions/{session_id}/complete"]) == {"post"}


def test_the_session_is_found_before_the_body_is_validated(web) -> None:
    world, client, _ = web
    unknown = client.post(events_url(uuid.uuid4()), json={"events": []})
    assert unknown.status_code == 404 and error_body(unknown)["code"] == "not_found"
    foreign = uuid.uuid4()
    world.seed_foreign_session(foreign)
    other = client.post(events_url(foreign), json={"nonsense": True})
    assert other.status_code == 404 and error_body(other)["code"] == "not_found"


def test_a_session_id_that_is_not_a_uuid_is_422(web) -> None:
    _, client, _ = web
    response = client.post("/api/sessions/not-a-uuid/events", json={"events": []})
    assert response.status_code == 422
    assert fields_of(response) == [("path.session_id", "uuid_parsing")]
    assert client.post("/api/sessions/not-a-uuid/complete").status_code == 422


# --- success -------------------------------------------------------------------------------------


def test_the_events_response_has_the_shape_of_the_contract(web) -> None:
    _, client, game = web
    event = answer_event(game.questions[0])
    response = client.post(events_url(game), json={"events": [event, activity_event(5, 65)]})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body) == {"acknowledged", "duplicate", "pending", "rejected", "results", "daily"}
    assert body["acknowledged"][0] == event["clientEventId"] and len(body["acknowledged"]) == 2
    assert set(body["results"][0]) == {
        "clientEventId",
        "questionId",
        "correct",
        "assisted",
        "expected",
        "passage",
    }
    assert set(body["daily"]) == {
        "learningDate",
        "dailyActiveMs",
        "dailyGoalMs",
        "dailyPercent",
        "dailyCompleted",
        "extraActiveMs",
    }


def test_a_resent_request_is_200_with_every_event_a_duplicate(web) -> None:
    _, client, game = web
    payload = {"events": [answer_event(game.questions[0]), activity_event(5, 65)]}
    first = client.post(events_url(game), json=payload).json()
    again = client.post(events_url(game), json=payload)
    assert again.status_code == 200
    assert again.json()["duplicate"] == first["acknowledged"] and again.json()["results"] == []


def test_the_complete_response_has_the_shape_of_the_contract(web) -> None:
    _, client, game = web
    client.post(events_url(game), json={"events": [answer_event(game.questions[0])]})
    response = client.post(complete_url(game))
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"summary", "daily"}
    assert set(body["summary"]) == {
        "answered",
        "correct",
        "newPassages",
        "reviewsPassed",
        "reviewsFailed",
        "activeMs",
    }
    assert client.post(complete_url(game)).json() == body  # a repeat gives the stored result


def test_a_demo_account_may_send_events_and_complete(world: World) -> None:
    world.ctx = replace(world.ctx, is_demo=True)
    client = world.client()
    game = world.game(FIRST_PASSAGE)
    assert (
        client.post(events_url(game), json={"events": [activity_event(5, 65)]}).status_code == 200
    )
    assert client.post(complete_url(game)).status_code == 200


def test_an_offline_replay_is_accepted_over_http_with_its_envelope(web) -> None:
    world, client, game = web
    world.make_offline(game)
    envelope = envelope_of(game)
    events = [answer_event(game.questions[0], **envelope), activity_event(5, 65, **envelope)]
    body = client.post(events_url(game), json={"events": events}).json()
    assert len(body["acknowledged"]) == 2 and body["rejected"] == [] and body["pending"] == []


# --- validation (422): the rule names of API-spec E21 -----------------------------------------


def bad_event(question: dict[str, Any], **changes: Any) -> dict[str, Any]:
    event = answer_event(question)
    event.update(changes)
    return event


@pytest.mark.parametrize(
    ("make", "expected"),
    [
        (lambda q: {}, [("events", "required")]),
        (lambda q: {"events": []}, [("events", "events_empty")]),
        (lambda q: {"events": [activity_event(5, 6)] * 101}, [("events", "events_too_many")]),
        (lambda q: {"events": [activity_event(5, 6)], "x": 1}, [("x", "forbidden_field")]),
        (lambda q: {"events": "x"}, [("events", "list_type")]),
        (
            lambda q: {"events": [{"clientEventId": str(uuid.uuid4()), "type": "nope"}]},
            [("events[0]", "union_tag_invalid")],
        ),
        (
            lambda q: {"events": [activity_event(5, 6), bad_event(q, correct=True)]},
            [("events[1].correct", "forbidden_field")],
        ),
        (
            lambda q: {"events": [bad_event(q, userId="x")]},
            [("events[0].userId", "forbidden_field")],
        ),
        (
            lambda q: {"events": [bad_event(q, durationMs=1_800_001)]},
            [("events[0].durationMs", "less_than_equal")],
        ),
        (
            lambda q: {"events": [bad_event(q, durationMs=-1)]},
            [("events[0].durationMs", "greater_than_equal")],
        ),
        (
            lambda q: {"events": [bad_event(q, hintUsed="yes")]},
            [("events[0].hintUsed", "bool_type")],
        ),
        (
            lambda q: {"events": [bad_event(q, occurredAt="2026-10-05T07:01:00")]},
            [("events[0].occurredAt", "timezone_aware")],
        ),
        (
            lambda q: {"events": [bad_event(q, clientEventId="nope")]},
            [("events[0].clientEventId", "uuid_parsing")],
        ),
        (
            lambda q: {"events": [bad_event(q, questionId="nope")]},
            [("events[0].questionId", "uuid_parsing")],
        ),
        (
            lambda q: {"events": [bad_event(q, clientRunId=str(uuid.uuid4()))]},
            [("events[0]", "envelope_incomplete")],
        ),
        (
            lambda q: {"events": [{**activity_event(5, 65), "activeMs": -1}]},
            [("events[0].activeMs", "greater_than_equal")],
        ),
        (
            lambda q: {"events": [{**activity_event(5, 65), "activeMs": 1.5}]},
            [("events[0].activeMs", "int_type")],
        ),
        (
            lambda q: {"events": [{k: v for k, v in answer_event(q).items() if k != "answer"}]},
            [("events[0].answer", "required")],
        ),
    ],
    ids=[
        "no events property",
        "empty list",
        "more than 100",
        "unknown top-level property",
        "events not a list",
        "unknown event type",
        "forbidden property (the server grades)",
        "forbidden user id",
        "duration above 30 minutes",
        "negative duration",
        "hint not a boolean",
        "time without zone",
        "event id not a uuid",
        "question id not a uuid",
        "partial envelope",
        "negative active time",
        "active time not an integer",
        "answer missing",
    ],
)
def test_validation_errors_use_the_rule_names_of_the_specification(
    web, make: Any, expected: list[tuple[str, str]]
) -> None:
    _, client, game = web
    response = client.post(events_url(game), json=make(game.questions[0]))
    assert response.status_code == 422
    assert error_body(response)["code"] == "validation_error"
    assert fields_of(response) == expected


@pytest.mark.parametrize(
    "answer",
    [{}, {"optionId": "1:0", "order": ["1:0"]}, {"order": ["1:0"], "text": "x"}],
    ids=["empty", "two shapes at once", "another mix"],
)
def test_an_answer_that_fits_no_shape_names_each_field_and_rule_once(
    web, answer: dict[str, Any]
) -> None:
    _, client, game = web
    response = client.post(
        events_url(game), json={"events": [bad_event(game.questions[0], answer=answer)]}
    )
    assert response.status_code == 422
    found = fields_of(response)
    assert found and len(found) == len(set(found))
    assert all(field.startswith("events[0].answer.") for field, _ in found)  # no class names leak


@pytest.mark.parametrize(
    ("override", "rule"),
    [
        ({"protocolVersion": "1"}, ("events[0].protocolVersion", "int_type")),
        ({"localSequence": -1}, ("events[0].localSequence", "greater_than_equal")),
        ({"scoringPolicyVersion": 5}, ("events[0].scoringPolicyVersion", "string_type")),
        ({"clientRunId": "nope"}, ("events[0].clientRunId", "uuid_parsing")),
    ],
)
def test_envelope_fields_are_checked_by_type_only(
    web, override: dict[str, Any], rule: tuple[str, str]
) -> None:
    _, client, game = web
    event = answer_event(game.questions[0], **envelope_of(game, **override))
    response = client.post(events_url(game), json={"events": [event]})
    assert response.status_code == 422 and fields_of(response) == [rule]


def test_a_failed_request_records_nothing_at_all(web) -> None:
    world, client, game = web
    events = [answer_event(game.questions[0]), bad_event(game.questions[1], hintUsed="yes")]
    assert client.post(events_url(game), json={"events": events}).status_code == 422
    assert world.attempts(game) == [] and world.mastery(FIRST_PASSAGE) is None


def test_a_body_that_is_not_an_object_or_not_json_is_422(web) -> None:
    _, client, game = web
    assert client.post(events_url(game), json=[1, 2]).status_code == 422
    assert client.post(events_url(game)).status_code == 422  # no body at all
    plain = client.post(events_url(game), content=b"x", headers={"Content-Type": "text/plain"})
    assert plain.status_code == 422
    broken = client.post(
        events_url(game), content=b'{"events": ', headers={"Content-Type": "application/json"}
    )
    assert broken.status_code == 422 and error_body(broken)["code"] == "validation_error"


def test_a_body_above_the_cap_is_413(web) -> None:
    _, client, game = web
    response = client.post(
        events_url(game), content=b"x" * 70_000, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert error_body(response)["code"] == "payload_too_large"


# --- E22: the idempotency key and the body -------------------------------------------------------


def test_a_well_formed_idempotency_key_is_accepted_and_adds_nothing(web) -> None:
    _, client, game = web
    first = client.post(complete_url(game), headers={"Idempotency-Key": str(uuid.uuid4())})
    second = client.post(complete_url(game), headers={"Idempotency-Key": str(uuid.uuid4())})
    assert first.status_code == second.status_code == 200 and first.json() == second.json()


@pytest.mark.parametrize("key", ["nope", "", "123", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"])
def test_a_malformed_idempotency_key_is_422(web, key: str) -> None:
    world, client, game = web
    response = client.post(complete_url(game), headers={"Idempotency-Key": key})
    assert response.status_code == 422
    assert fields_of(response) == [("Idempotency-Key", "uuid_parsing")]
    assert world.session_row(game).status == "open"  # type: ignore[union-attr]


def test_completion_ignores_any_body(web) -> None:
    _, client, game = web
    assert client.post(complete_url(game), json={"anything": 1}).status_code == 200
    junk = client.post(
        complete_url(game), content=b"{", headers={"Content-Type": "application/json"}
    )
    assert junk.status_code == 200


def parameter_names(operation: dict[str, Any]) -> list[str]:
    return [p["name"] for p in operation.get("parameters", [])]


def test_the_idempotency_key_is_not_part_of_the_events_route(world: World) -> None:
    operations = world.app().openapi()["paths"]
    events = operations["/api/sessions/{session_id}/events"]["post"]
    complete = operations["/api/sessions/{session_id}/complete"]["post"]
    assert "Idempotency-Key" in parameter_names(complete)
    assert "Idempotency-Key" not in parameter_names(events)


# --- rate limit ----------------------------------------------------------------------------------


def test_the_sixty_first_write_in_a_minute_is_429_with_retry_after(web) -> None:
    world, client, game = web
    limit = make_settings().QATRA_RATE_SESSION_WRITE_PER_MIN
    statuses = [client.post(events_url(game), json={}).status_code for _ in range(limit)]
    assert set(statuses) == {422} and limit == 60  # invalid bodies count as well
    limited = client.post(events_url(game), json={"events": [activity_event(5, 65)]})
    assert limited.status_code == 429
    error = error_body(limited)
    assert error["code"] == "throttled"
    assert int(limited.headers["retry-after"]) >= 1
    assert error["details"]["retryAfterSec"] == int(limited.headers["retry-after"])
    assert world.intervals(world.calendar.today) == []


def test_the_limiter_is_the_one_shared_with_the_other_session_writes(web) -> None:
    world, client, game = web
    app = client.app
    assert (
        client.post(events_url(game), json={"events": [activity_event(5, 65)]}).status_code == 200
    )
    created = app.state.session_write_limiter
    assert isinstance(created, SlidingWindowLimiter)
    assert client.post(complete_url(game)).status_code == 200
    assert app.state.session_write_limiter is created
    app.state.session_write_limiter = SlidingWindowLimiter(2)  # E20, E21 and E22 count together
    body = {"kind": "game", "planId": str(PLAN_ID), "expectedPlanVersion": 2}
    assert client.post("/api/sessions", json=body).status_code == 201
    assert (
        client.post(events_url(game), json={"events": [activity_event(5, 65)]}).status_code == 200
    )
    assert client.post(complete_url(game)).status_code == 429


# --- wiring --------------------------------------------------------------------------------------


def test_without_the_service_the_endpoints_are_unavailable(web) -> None:
    _, client, game = web
    client.app.state.sessions_service = None
    for response in (
        client.post(events_url(game), json={"events": [activity_event(5, 65)]}),
        client.post(complete_url(game)),
    ):
        assert response.status_code == 503 and error_body(response)["code"] == "unavailable"


# --- privacy -------------------------------------------------------------------------------------


def test_nothing_of_the_events_reaches_the_logs(web, log_lines: list[str]) -> None:
    world, client, game = web
    recall = next(q for q in game.questions if q["type"] == "word_recall")
    typed = "private-typed-answer"
    event = answer_event(recall)
    event["answer"] = {"text": typed}
    body = {"events": [event, activity_event(5, 65), answer_event(game.questions[1], ok=False)]}
    assert client.post(events_url(game), json=body).status_code == 200
    assert client.post(complete_url(game)).status_code == 200
    assert client.post(events_url(game), json={"events": []}).status_code == 422
    text = "\n".join(log_lines)
    assert '"route":"/api/sessions/{session_id}/events"' in text
    assert '"route":"/api/sessions/{session_id}/complete"' in text
    for secret in (
        str(game.id),
        str(PLAN_ID),
        typed,
        recall["questionId"],
        event["clientEventId"],
        QURAN["units"][0]["canonicalText"],
        "answerKey",
        "hintUsed",
    ):
        assert secret not in text
    assert "127.0.0.1" not in text and "testclient" not in text
    if world.fake is not None:
        assert typed not in str(world.fake.apply_bodies)
