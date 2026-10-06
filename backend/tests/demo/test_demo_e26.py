"""E26 ``POST /api/demo/accounts`` (API-spec §4.9): E03's registration with ``is_demo`` set by the
server, and the per-address limit of five demo accounts a day (successful creations only)."""

from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from app.errors import AppError, ErrorCode
from tests.demo.demo_support import (
    PASSWORD,
    TERMS,
    Env,
    build_env,
    error_of,
    fields_of,
    registration,
)

CODE_SHAPE = re.compile(r"^([0-9a-f]{4}-){7}[0-9a-f]{4}$")
PROFILE_KEYS = {
    "username",
    "language",
    "timeZone",
    "sessionMinutes",
    "reminderSettings",
    "isDemo",
    "termsVersion",
    "termsAcceptedAt",
    "createdAt",
    "pendingSettings",
}


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return build_env(tmp_path)


def post(env: Env, body: dict[str, Any], address: str = "203.0.113.9"):
    return env.client(address).post("/api/demo/accounts", json=body)


# --- success -------------------------------------------------------------------------------------


def test_a_demo_account_is_created_with_the_demo_flag_and_a_session(env: Env) -> None:
    client = env.client()
    response = client.post("/api/demo/accounts", json=registration("demo_one"))
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"profile", "recoveryCode"}
    assert set(body["profile"]) == PROFILE_KEYS
    assert body["profile"]["isDemo"] is True
    assert body["profile"]["username"] == "demo_one"
    assert CODE_SHAPE.match(body["recoveryCode"])
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("qatra_session=") and "HttpOnly" in cookie
    assert "SameSite=Strict" in cookie and "Path=/" in cookie and "Max-Age=2592000" in cookie
    # the cookie is a live session of a demo account
    me = client.get("/api/me")
    assert me.status_code == 200 and me.json()["isDemo"] is True
    assert client.get("/api/demo/scenarios").status_code == 200


def test_the_demo_flag_is_stored_by_the_server_on_the_handle(env: Env) -> None:
    persona = env.demo("demo_one")
    handle = env.app.state.account_repository.find_handle("demo_one")
    assert handle is not None and handle.is_demo is True and handle.user_id == persona.user_id


def test_a_learner_registered_with_e03_is_not_a_demo_account(env: Env) -> None:
    learner = env.learner()
    assert learner.client.get("/api/me").json()["isDemo"] is False
    assert learner.client.get("/api/demo/scenarios").status_code == 403


def test_the_demo_account_has_the_password_and_recovery_code_of_a_learner(env: Env) -> None:
    persona = env.demo("demo_one")
    login = env.client("203.0.113.77").post(
        "/api/auth/login", json={"username": "demo_one", "password": PASSWORD}
    )
    assert login.status_code == 200 and login.json()["profile"]["isDemo"] is True
    verify = env.client("203.0.113.78").post(
        "/api/auth/recovery/verify",
        json={"username": "demo_one", "recoveryCode": persona.recovery_code},
    )
    assert verify.status_code == 200


# --- the rules of E03 ----------------------------------------------------------------------------


def test_the_origin_is_checked_before_anything_else(env: Env) -> None:
    no_origin = env.client(origin=False).post("/api/demo/accounts", json=registration("demo_one"))
    assert no_origin.status_code == 403 and error_of(no_origin)["code"] == "forbidden_origin"
    wrong = env.client().post(
        "/api/demo/accounts",
        json=registration("demo_one"),
        headers={"Origin": "https://elsewhere.example"},
    )
    assert wrong.status_code == 403 and error_of(wrong)["code"] == "forbidden_origin"
    assert env.app.state.account_repository.find_handle("demo_one") is None


@pytest.mark.parametrize(
    "overrides",
    [{"termsAccepted": False}, {"termsVersion": "1999-01-01"}],
)
def test_the_consent_box_is_mandatory(env: Env, overrides: dict[str, Any]) -> None:
    response = post(env, registration("demo_one", **overrides))
    assert response.status_code == 400
    assert error_of(response)["code"] == "terms_required"
    assert error_of(response)["details"]["requiredVersion"] == TERMS


@pytest.mark.parametrize("field", ["isDemo", "mode", "userId", "role", "anything"])
def test_a_demo_flag_or_any_unknown_property_is_forbidden(env: Env, field: str) -> None:
    response = post(env, {**registration("demo_one"), field: True})
    assert response.status_code == 422
    assert fields_of(response) == [(field, "forbidden_field")]
    assert env.app.state.account_repository.find_handle("demo_one") is None


def test_the_field_rules_of_e03_apply(env: Env) -> None:
    response = post(env, registration("x", password="short"))
    assert response.status_code == 422
    assert {name for name, _ in fields_of(response)} == {"username", "password"}
    bad_zone = post(env, registration("demo_one", timeZone="Nowhere/Atlantis"))
    assert fields_of(bad_zone) == [("timeZone", "time_zone_invalid")]
    bad_language = post(env, registration("demo_one", language="fr"))
    assert fields_of(bad_language) == [("language", "language_invalid")]


def test_a_taken_username_is_409_whoever_holds_it(env: Env) -> None:
    env.learner("learner_one")
    response = post(env, registration("Learner_One"))
    assert response.status_code == 409 and error_of(response)["code"] == "username_taken"
    env.demo("demo_one")
    again = post(env, registration("demo_one"), "203.0.113.44")
    assert again.status_code == 409


def test_a_wrong_type_is_refused_not_coerced(env: Env) -> None:
    assert post(env, registration("demo_one", termsAccepted="yes")).status_code == 422
    assert post(env, {**registration("demo_one"), "username": 7}).status_code == 422


def test_the_password_and_the_recovery_code_are_never_logged(
    env: Env, log_lines: list[str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    persona = env.demo("demo_one")
    text = " ".join([*log_lines, *caplog.messages])
    assert "demo_account_created" in text
    for secret in (PASSWORD, persona.recovery_code, "demo_one", "203.0.113.9"):
        assert secret not in text


# --- the daily limit per client address -----------------------------------------------------------


def test_the_sixth_demo_account_of_an_address_is_throttled_with_retry_after(env: Env) -> None:
    for number in range(5):
        assert post(env, registration(f"demo_user_{number}")).status_code == 201
    response = post(env, registration("demo_user_5"))
    assert response.status_code == 429
    error = error_of(response)
    assert error["code"] == "throttled"
    assert response.headers["retry-after"] == str(error["details"]["retryAfterSec"]) == "86400"
    assert env.app.state.account_repository.find_handle("demo_user_5") is None
    # another address is not affected
    assert post(env, registration("demo_user_5"), "198.51.100.7").status_code == 201


def test_the_limit_is_released_after_twenty_four_hours(env: Env) -> None:
    for number in range(5):
        assert post(env, registration(f"demo_user_{number}")).status_code == 201
    assert post(env, registration("late_user")).status_code == 429
    env.clock.now += timedelta(hours=24, seconds=1)
    assert post(env, registration("late_user")).status_code == 201


def test_the_daily_limit_is_a_setting(tmp_path: Path) -> None:
    env = build_env(tmp_path, QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY=1)
    assert post(env, registration("demo_user_0")).status_code == 201
    assert post(env, registration("demo_user_1")).status_code == 429


def test_only_successful_creations_count(tmp_path: Path) -> None:
    env = build_env(tmp_path, QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY=2)
    env.learner("taken_name", "203.0.113.50")
    refused = [
        post(env, registration("demo_user_0", termsAccepted=False)),  # 400
        post(env, registration("x", password="short")),  # 422
        post(env, {**registration("demo_user_0"), "isDemo": True}),  # 422 forbidden_field
        post(env, registration("taken_name")),  # 409
        env.client(origin=False).post(
            "/api/demo/accounts", json=registration("demo_user_0")
        ),  # 403
    ]
    assert [r.status_code for r in refused] == [400, 422, 422, 409, 403]
    assert post(env, registration("demo_user_0")).status_code == 201
    assert post(env, registration("demo_user_1")).status_code == 201
    assert post(env, registration("demo_user_2")).status_code == 429


def test_a_server_failure_gives_the_reservation_back(tmp_path: Path) -> None:
    env = build_env(tmp_path, QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY=1)
    service = env.app.state.auth_service
    original = service.register_account
    calls: list[int] = []

    def failing_once(**kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            raise AppError(ErrorCode.unavailable)
        return original(**kwargs)

    service.register_account = failing_once
    first = post(env, registration("demo_user_0"))
    assert first.status_code == 503 and error_of(first)["code"] == "unavailable"
    assert post(env, registration("demo_user_0")).status_code == 201
    assert post(env, registration("demo_user_1")).status_code == 429


def test_the_anonymous_entry_class_is_shared_with_e03(tmp_path: Path) -> None:
    env = build_env(tmp_path, QATRA_RATE_ANONYMOUS_ENTRY_PER_MIN=2)
    client = env.client()
    assert client.post("/api/auth/register", json=registration("learner_one")).status_code == 201
    assert client.post("/api/demo/accounts", json=registration("demo_one")).status_code == 201
    third = client.post("/api/demo/accounts", json=registration("demo_two"))
    assert third.status_code == 429 and "retry-after" in third.headers


def test_without_the_authentication_service_the_endpoint_is_unavailable(env: Env) -> None:
    env.app.state.auth_service = None
    response = post(env, registration("demo_one"))
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
