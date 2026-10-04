"""E20 over HTTP: ordering of the guards, status codes, strict bodies, limits and privacy."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.domain.rate_limit import SlidingWindowLimiter
from app.main import create_app
from app.routers.sessions import SESSION_WRITE_RATE_PER_MIN, install_sessions, router
from tests.sessions.ss_support import (
    HADITH,
    PLAN_B_ID,
    PLAN_ID,
    QURAN,
    QURAN_EDITION,
    QURAN_PASSAGES,
    Env,
    hadith_plan,
    login_as,
    make_app,
    quran_plan,
)
from tests.support import FRONTEND_ORIGIN, make_settings
from tests.test_origin import unguarded_mutations

DAILY = {"kind": "daily", "planId": str(PLAN_ID), "expectedPlanVersion": 2}


def client_for(env: Env | None = None, *, login: bool = True, **settings: Any):
    env = env or Env()
    app = make_app(env, **settings)
    if login:
        login_as(app)
    return env, app, TestClient(app, headers={"Origin": FRONTEND_ORIGIN})


def post(client: TestClient, body: Any, **kwargs: Any):
    return client.post("/api/sessions", json=body, **kwargs)


def error_body(response) -> dict[str, Any]:
    assert response.headers["cache-control"] == "no-store"
    return response.json()["error"]


# --- guards, in order -----------------------------------------------------------------------------


def test_without_a_session_the_answer_is_unauthenticated_and_never_reaches_the_body() -> None:
    _, _, client = client_for(login=False)
    response = post(client, DAILY)
    assert response.status_code == 401
    assert error_body(response)["code"] == "unauthenticated"
    assert error_body(post(client, {"kind": "nonsense"}))["code"] == "unauthenticated"


@pytest.mark.parametrize("origin", [None, "http://evil.example", "http://localhost:3000/"])
def test_the_origin_is_checked_before_the_session(origin: str | None) -> None:
    _, app, _ = client_for(login=False)
    headers = {"Origin": origin} if origin else {}
    with TestClient(app) as bare:
        response = post(bare, DAILY, headers=headers)
    assert response.status_code == 403
    assert error_body(response)["code"] == "forbidden_origin"


def test_a_missing_origin_is_refused_even_for_a_logged_in_caller() -> None:
    _, app, _ = client_for()
    with TestClient(app) as bare:
        assert post(bare, DAILY).status_code == 403


def test_every_state_changing_route_still_checks_origin_first_with_sessions_installed() -> None:
    app = make_app(Env())
    assert unguarded_mutations(app) == []


def test_the_route_is_registered_once_with_the_documented_responses() -> None:
    app = make_app(Env())
    operations = app.openapi()["paths"]["/api/sessions"]
    assert set(operations) == {"post"}  # one operation: E20 creates, there is no GET or DELETE
    responses = operations["post"]["responses"]
    assert set(responses) >= {"200", "201", "401", "403", "404", "409", "422", "429", "503"}
    assert router.prefix == "/api"


# --- success: 201 and 200 ------------------------------------------------------------------------


def test_a_new_daily_session_is_201_and_a_repeat_is_200_with_the_same_body() -> None:
    _, _, client = client_for()
    first = post(client, DAILY)
    assert first.status_code == 201
    assert first.headers["cache-control"] == "no-store"
    assert first.headers["content-type"].startswith("application/json")
    second = post(client, DAILY)
    assert second.status_code == 200
    assert second.headers["cache-control"] == "no-store"
    assert second.json() == first.json()


def test_the_snapshot_has_the_camel_case_shape_of_the_contract() -> None:
    _, _, client = client_for()
    body = post(client, DAILY).json()
    assert set(body) == {
        "sessionId",
        "kind",
        "planId",
        "planVersion",
        "editionId",
        "bankVersion",
        "learningDate",
        "status",
        "steps",
        "createdAt",
    }
    assert body["kind"] == "daily" and body["status"] == "open" and body["planVersion"] == 2
    assert body["planId"] == str(PLAN_ID) and body["editionId"] == str(QURAN_EDITION)
    assert body["learningDate"] == "2026-10-05" and body["createdAt"] == "2026-10-05T07:00:00Z"
    learn = body["steps"][0]
    assert (
        learn["type"] == "learn"
        and learn["passage"]["units"][0]["text"] == (QURAN["units"][0]["canonicalText"])
    )
    questions = [s["question"] for s in body["steps"] if s["type"] == "question"]
    assert questions and all(
        "answerKey" in q and "policy" in q and "source" in q for q in questions
    )


def test_a_game_and_a_placement_are_always_201() -> None:
    _, _, client = client_for()
    game = {"kind": "game", "planId": str(PLAN_ID), "expectedPlanVersion": 2}
    assert [post(client, game).status_code for _ in range(2)] == [201, 201]
    placement = {
        "kind": "placement",
        "editionId": str(QURAN_EDITION),
        "targetScope": {"sectionOrdinals": [1, 2, 3]},
        "selfRating": "most",
    }
    first, second = post(client, placement), post(client, placement)
    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json()["sessionId"] != second.json()["sessionId"]
    assert first.json()["planId"] is None and first.json()["planVersion"] is None
    assert {s["type"] for s in first.json()["steps"]} == {"question"}


def test_a_demo_account_may_open_sessions() -> None:
    _, app, client = client_for(login=False)
    login_as(app, demo=True)
    assert post(client, DAILY).status_code == 201


# --- errors --------------------------------------------------------------------------------------


def test_an_unknown_or_foreign_plan_is_404() -> None:
    env, app, client = client_for()
    unknown = dict(DAILY, planId="00000000-0000-4000-8000-0000000000ff")
    response = post(client, unknown)
    assert response.status_code == 404 and error_body(response)["code"] == "not_found"
    env.plans.add(quran_plan(plan_id=PLAN_B_ID), owner=uuid4())
    assert post(client, dict(DAILY, planId=str(PLAN_B_ID))).status_code == 404


def test_a_stale_version_is_409_with_the_current_version() -> None:
    _, _, client = client_for()
    response = post(client, dict(DAILY, expectedPlanVersion=1))
    assert response.status_code == 409
    error = error_body(response)
    assert error["code"] == "version_conflict"
    assert error["details"] == {"reason": "plan_version", "currentVersion": 2}


def test_a_paused_plan_is_409_plan_not_active() -> None:
    env, _, client = client_for()
    env.plans.update(PLAN_ID, status="paused")
    response = post(client, DAILY)
    assert response.status_code == 409
    assert error_body(response)["details"] == {"reason": "plan_not_active"}


def test_a_revoked_edition_is_422_edition_not_available() -> None:
    env, _, client = client_for()
    env.bank.set_status(QURAN_EDITION, "revoked")
    response = post(client, DAILY)
    assert response.status_code == 422
    error = error_body(response)
    assert error["code"] == "validation_error"
    assert error["details"] == {"fields": [{"field": "planId", "rule": "edition_not_available"}]}
    assert QURAN["units"][0]["canonicalText"] not in response.text


def test_a_game_passage_outside_the_scope_is_422_out_of_scope() -> None:
    env, _, client = client_for()
    env.plans.update(PLAN_ID, section_ordinals=(1,))
    body = {
        "kind": "game",
        "planId": str(PLAN_ID),
        "expectedPlanVersion": 2,
        "passageIds": [str(QURAN_PASSAGES[0]), str(QURAN_PASSAGES[3])],
    }
    response = post(client, body)
    assert response.status_code == 422
    assert error_body(response)["details"]["fields"] == [
        {"field": "passageIds[1]", "rule": "out_of_scope"}
    ]


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({}, [("kind", "kind_invalid")]),
        ({"kind": "weekly"}, [("kind", "kind_invalid")]),
        (dict(DAILY, userId="x"), [("userId", "forbidden_field")]),
        (dict(DAILY, isDemo=True), [("isDemo", "forbidden_field")]),
        (dict(DAILY, correct=True), [("correct", "forbidden_field")]),
        (dict(DAILY, mode="synthetic_demo"), [("mode", "forbidden_field")]),
        (dict(DAILY, expectedPlanVersion="2"), [("expectedPlanVersion", "int_type")]),
        (dict(DAILY, planId="nope"), [("planId", "uuid_parsing")]),
        (
            {"kind": "game", "planId": str(PLAN_ID), "expectedPlanVersion": 2, "gameType": "x"},
            [("gameType", "game_type_invalid")],
        ),
        (
            {
                "kind": "placement",
                "editionId": str(QURAN_EDITION),
                "targetScope": {"sectionOrdinals": [1]},
                "selfRating": "lots",
            },
            [("selfRating", "self_rating_invalid")],
        ),
        (
            {
                "kind": "placement",
                "editionId": str(QURAN_EDITION),
                "targetScope": {"sectionOrdinals": []},
            },
            [("targetScope.sectionOrdinals", "scope_invalid")],
        ),
        (
            {
                "kind": "placement",
                "editionId": str(QURAN_EDITION),
                "targetScope": {"sectionOrdinals": [1, 99]},
            },
            [("targetScope.sectionOrdinals", "scope_invalid")],
        ),
        (
            {
                "kind": "placement",
                "editionId": "11111111-1111-4111-8111-0000000000ee",
                "targetScope": {"sectionOrdinals": [1]},
            },
            [("editionId", "edition_not_available")],
        ),
    ],
)
def test_validation_errors_use_the_rule_names_of_the_specification(
    body: dict[str, Any], fields: list[tuple[str, str]]
) -> None:
    _, _, client = client_for()
    response = post(client, body)
    assert response.status_code == 422
    error = error_body(response)
    assert error["code"] == "validation_error"
    assert [(f["field"], f["rule"]) for f in error["details"]["fields"]] == fields


def test_a_body_that_is_not_an_object_or_not_json_is_422() -> None:
    _, _, client = client_for()
    assert post(client, [1, 2]).status_code == 422
    assert client.post("/api/sessions").status_code == 422  # no body at all
    plain = client.post("/api/sessions", content=b"daily", headers={"Content-Type": "text/plain"})
    assert plain.status_code == 422
    broken = client.post(
        "/api/sessions", content=b'{"kind": ', headers={"Content-Type": "application/json"}
    )
    assert broken.status_code == 422 and error_body(broken)["code"] == "validation_error"


def test_a_body_above_the_cap_is_413() -> None:
    _, _, client = client_for()
    response = client.post(
        "/api/sessions", content=b"x" * 70_000, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert error_body(response)["code"] == "payload_too_large"


# --- rate limit ----------------------------------------------------------------------------------


def test_the_sixty_first_request_in_a_minute_is_429_with_retry_after() -> None:
    _, _, client = client_for()
    statuses = [
        post(client, {"kind": "nope"}).status_code for _ in range(SESSION_WRITE_RATE_PER_MIN)
    ]
    assert set(statuses) == {422}  # invalid bodies count as well
    limited = post(client, DAILY)
    assert limited.status_code == 429
    error = error_body(limited)
    assert error["code"] == "throttled"
    assert int(limited.headers["retry-after"]) >= 1
    assert error["details"]["retryAfterSec"] == int(limited.headers["retry-after"])
    assert SESSION_WRITE_RATE_PER_MIN == 60


def test_the_limiter_is_shared_by_name_with_other_session_write_operations() -> None:
    _, app, client = client_for()
    assert not hasattr(app.state, "session_write_limiter")  # built on the first request
    assert post(client, DAILY).status_code == 201
    created = app.state.session_write_limiter
    assert isinstance(created, SlidingWindowLimiter)
    assert post(client, DAILY).status_code == 200
    assert app.state.session_write_limiter is created  # never replaced afterwards

    # a package that owns another operation of the class installs its own instance by name
    app.state.session_write_limiter = SlidingWindowLimiter(2)
    statuses = [post(client, DAILY).status_code for _ in range(3)]
    assert statuses == [200, 200, 429]
    assert app.state.session_write_limiter is not created


# --- wiring --------------------------------------------------------------------------------------


def test_without_the_service_the_endpoint_is_unavailable() -> None:
    app = create_app(make_settings())
    app.state.sessions_service = None  # create_app builds it; the router stays installed
    login_as(app)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    response = post(client, DAILY)
    assert response.status_code == 503 and error_body(response)["code"] == "unavailable"


def test_with_unbound_plan_and_calendar_ports_nothing_is_faked() -> None:
    placement = {
        "kind": "placement",
        "editionId": str(QURAN_EDITION),
        "targetScope": {"sectionOrdinals": [1]},
    }
    settings = make_settings()
    app = create_app(settings)
    install_sessions(app, settings)  # neither port of B3 and B4 is bound, and the bank is empty
    login_as(app)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    assert post(client, DAILY).status_code == 503  # no plan port: never guessed
    assert post(client, placement).status_code == 422  # no content: the edition is not available
    # With content but no calendar a placement cannot know the learning date either.
    with_bank = create_app(settings)
    install_sessions(with_bank, settings, bank=Env().bank)
    login_as(with_bank)
    other = TestClient(with_bank, headers={"Origin": FRONTEND_ORIGIN})
    assert post(other, placement).status_code == 503


def test_ports_left_on_app_state_are_picked_up_and_the_repositories_are_shared() -> None:
    env = Env()
    settings = make_settings()
    app = create_app(settings)
    app.state.plan_access = env.plans
    app.state.learning_calendar = env.calendar
    install_sessions(app, settings, bank=env.bank, learning=env.store)
    login_as(app)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    assert post(client, DAILY).status_code == 201
    assert app.state.bank_repository is env.bank and app.state.learning_repository is env.store
    assert len(env.store.sessions) == 1


def test_memory_mode_builds_the_bank_from_the_configured_bundles(tmp_path) -> None:
    path = tmp_path / "bundle.json"
    path.write_text(json.dumps(QURAN, ensure_ascii=False), encoding="utf-8")
    env = Env(bundles=())
    settings = make_settings(QATRA_CONTENT_BUNDLES=str(path))
    app = create_app(settings)
    install_sessions(app, settings, plans=env.plans, calendar=env.calendar)
    login_as(app)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    assert post(client, DAILY).status_code == 201


# --- privacy -------------------------------------------------------------------------------------


def test_nothing_of_the_request_or_the_session_reaches_the_logs(log_lines: list[str]) -> None:
    _, _, client = client_for()
    assert post(client, DAILY).status_code == 201
    assert post(client, dict(DAILY, expectedPlanVersion=9)).status_code == 409
    text = "\n".join(log_lines)
    assert '"route":"/api/sessions"' in text and '"status":201' in text
    for secret in (
        str(PLAN_ID),
        str(QURAN_EDITION),
        QURAN["units"][0]["canonicalText"],
        "answerKey",
    ):
        assert secret not in text
    assert "127.0.0.1" not in text and "testclient" not in text


def test_the_hadith_plan_flows_through_http_too() -> None:
    env, _, client = client_for()
    body = {"kind": "daily", "planId": str(PLAN_B_ID), "expectedPlanVersion": 2}
    response = post(client, body)
    assert response.status_code == 201
    learn = [s["passage"] for s in response.json()["steps"] if s["type"] == "learn"]
    assert (
        learn[0]["path"] == "sanad" and learn[0]["takhrij"] == HADITH["units"][1]["canonicalText"]
    )
    assert hadith_plan().plan_id == PLAN_B_ID
    assert env.store.sessions
