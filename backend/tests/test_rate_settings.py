"""The per-client-IP limits are settings (API-spec §1.7, §1.8): defaults, validation by name, and
every router class reads its limit from them."""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import StartupConfigError, load_settings
from app.main import create_app
from tests.auth.auth_support import registration
from tests.plans.plans_support import login_as
from tests.support import FRONTEND_ORIGIN, make_settings

DEFAULTS = {
    "QATRA_RATE_PUBLIC_READ_PER_MIN": 60,
    "QATRA_RATE_ANONYMOUS_ENTRY_PER_MIN": 10,
    "QATRA_RATE_SESSION_READ_PER_MIN": 120,
    "QATRA_RATE_SESSION_WRITE_PER_MIN": 60,
    "QATRA_RATE_CHAT_WRITE_PER_MIN": 20,
}


def test_the_defaults_are_the_configuration_values_of_api_spec_1_8() -> None:
    settings = make_settings()
    assert {name: getattr(settings, name) for name in DEFAULTS} == DEFAULTS
    assert settings.QATRA_READY_RATE_PER_MIN == 6


@pytest.mark.parametrize("name", [*DEFAULTS, "QATRA_TRUSTED_XFF_DEPTH"])
def test_an_unusable_value_stops_startup_naming_the_variable_only(
    name: str, clean_env: pytest.MonkeyPatch
) -> None:
    bad = "-1" if name == "QATRA_TRUSTED_XFF_DEPTH" else "0"
    clean_env.setenv("FRONTEND_ORIGIN", "http://localhost:3000")
    clean_env.setenv("TERMS_VERSION", "2026-10-04")
    clean_env.setenv(name, bad)
    with pytest.raises(StartupConfigError) as raised:
        load_settings()
    assert name in str(raised.value)
    assert f"={bad}" not in str(raised.value)


def test_a_value_that_is_not_a_number_never_appears_in_the_error(
    clean_env: pytest.MonkeyPatch,
) -> None:
    clean_env.setenv("FRONTEND_ORIGIN", "http://localhost:3000")
    clean_env.setenv("TERMS_VERSION", "2026-10-04")
    clean_env.setenv("QATRA_RATE_SESSION_READ_PER_MIN", "SENTINEL-not-int")
    with pytest.raises(StartupConfigError) as raised:
        load_settings()
    assert "QATRA_RATE_SESSION_READ_PER_MIN" in str(raised.value)
    assert "SENTINEL" not in str(raised.value)


def test_the_proxy_depth_may_be_zero_and_is_read_from_the_environment(
    clean_env: pytest.MonkeyPatch,
) -> None:
    clean_env.setenv("FRONTEND_ORIGIN", "http://localhost:3000")
    clean_env.setenv("TERMS_VERSION", "2026-10-04")
    assert load_settings().QATRA_TRUSTED_XFF_DEPTH == 0
    clean_env.setenv("QATRA_TRUSTED_XFF_DEPTH", "2")
    assert load_settings().QATRA_TRUSTED_XFF_DEPTH == 2


def browser(app: FastAPI) -> TestClient:
    return TestClient(app, headers={"Origin": FRONTEND_ORIGIN})


def statuses(
    client: TestClient, send: Callable[[TestClient], httpx.Response], count: int
) -> list[int]:
    return [send(client).status_code for _ in range(count)]


def test_public_read_follows_its_setting() -> None:
    app = create_app(make_settings(QATRA_RATE_PUBLIC_READ_PER_MIN=2))
    assert statuses(browser(app), lambda c: c.get("/api/catalog"), 3) == [200, 200, 429]
    assert app.state.public_read_limiter._limit == 2


def test_session_read_follows_its_setting_for_plans_and_account() -> None:
    app = create_app(make_settings(QATRA_RATE_SESSION_READ_PER_MIN=2))
    login_as(app)
    client = browser(app)
    # An empty body is a 422, which still counts: the limiter runs before the body check.
    assert statuses(client, lambda c: c.post("/api/plans/estimate", json={}), 3) == [422, 422, 429]
    assert app.state.session_read_limiter._limit == 2
    assert app.state.auth_limiters["session_read"]._limit == 2


def test_session_write_follows_its_setting_for_plans_sessions_and_account() -> None:
    app = create_app(make_settings(QATRA_RATE_SESSION_WRITE_PER_MIN=2))
    login_as(app)
    client = browser(app)
    assert statuses(client, lambda c: c.post("/api/sessions", json={}), 3) == [422, 422, 429]
    assert app.state.session_write_limiter._limit == 2
    assert app.state.auth_limiters["session_write"]._limit == 2


def test_chat_write_follows_its_setting() -> None:
    app = create_app(make_settings(QATRA_RATE_CHAT_WRITE_PER_MIN=2))
    login_as(app)
    client = browser(app)
    # An empty body is a 422, which still counts: the limiter runs before the body check.
    assert statuses(client, lambda c: c.post("/api/plan-chats", json={}), 3) == [422, 422, 429]
    assert app.state.chat_write_limiter._limit == 2


def test_anonymous_entry_follows_its_setting() -> None:
    app = create_app(make_settings(QATRA_RATE_ANONYMOUS_ENTRY_PER_MIN=2))
    client = browser(app)
    names = ["first_user", "second_user", "third_user"]
    result = [
        client.post("/api/auth/register", json=registration(username=name)).status_code
        for name in names
    ]
    assert result == [201, 201, 429]
    assert app.state.auth_limiters["anonymous_entry"]._limit == 2


def test_the_defaults_reach_every_limiter() -> None:
    app = create_app(make_settings())
    login_as(app)
    client = browser(app)
    client.get("/api/catalog")
    client.post("/api/plans/estimate", json={})
    client.post("/api/sessions", json={})
    client.post("/api/plan-chats", json={})
    state = app.state
    assert state.public_read_limiter._limit == 60
    assert state.session_read_limiter._limit == 120
    assert state.session_write_limiter._limit == 60
    assert state.chat_write_limiter._limit == 20
    assert {k: v._limit for k, v in state.auth_limiters.items()} == {
        "anonymous_entry": 10,
        "session_write": 60,
        "session_read": 120,
    }
