"""``install_auth``: which components each mode wires, what it stores on ``app.state``, which routes
it adds, and how missing configuration is reported (names only)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings, StartupConfigError
from app.dependencies import SessionEndedError
from app.main import create_app
from app.providers.supabase_auth import FakeSupabaseAuth, HttpSupabaseAuth
from app.repositories import accounts as accounts_module
from app.repositories.accounts import (
    InMemoryAccounts,
    PostgresAccountRepository,
    PostgrestProfileStore,
)
from app.routers.auth import RateLimits, install_auth
from app.services.account import AccountService
from app.services.auth import AuthService, SessionService
from tests.auth.auth_support import ORIGIN, USERNAME, login, register
from tests.support import make_settings, production_values, random_key_b64

KEYS = {
    "QATRA_SESSION_KEY": random_key_b64(),
    "QATRA_SESSION_HMAC_KEY": random_key_b64(),
    "QATRA_RECOVERY_HMAC_KEY": random_key_b64(),
    "QATRA_THROTTLE_HMAC_KEY": random_key_b64(),
}


def test_memory_mode_wires_the_in_memory_store_the_fake_provider_and_ephemeral_keys() -> None:
    settings = make_settings()  # no keys configured
    app = create_app(settings)
    install_auth(app, settings)
    state = app.state
    assert isinstance(state.account_repository, InMemoryAccounts)
    assert isinstance(state.auth_provider, FakeSupabaseAuth)
    assert state.profile_store is state.account_repository
    assert isinstance(state.session_resolver, SessionService)
    assert isinstance(state.auth_service, AuthService)
    assert isinstance(state.account_service, AccountService)
    assert state.session_resolver.cookie_name == "qatra_session"
    assert set(state.auth_limiters) == {"anonymous_entry", "session_write", "session_read"}


def test_the_default_memory_application_works_end_to_end_in_real_time() -> None:
    settings = make_settings()
    app = create_app(settings)
    install_auth(app, settings)
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        assert register(client).status_code == 201
        assert client.get("/api/me").json()["username"] == USERNAME
        assert client.post("/api/auth/logout").status_code == 204
        assert client.get("/api/me").status_code == 401
        assert login(client).status_code == 200


def test_the_routes_of_e03_to_e13_are_added() -> None:
    settings = make_settings()
    app = create_app(settings)
    before = set(app.openapi()["paths"])
    install_auth(app, settings)
    app.openapi_schema = None
    added = set(app.openapi()["paths"]) - before
    assert added == {
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/consent",
        "/api/auth/recovery/verify",
        "/api/auth/recovery/reset",
        "/api/auth/recovery/rotate",
        "/api/auth/password",
        "/api/auth/logout",
        "/api/me",
        "/api/account/delete",
    }


def test_the_handler_that_clears_the_cookie_on_401_is_registered() -> None:
    settings = make_settings()
    app = create_app(settings)
    assert SessionEndedError not in app.exception_handlers
    install_auth(app, settings)
    assert SessionEndedError in app.exception_handlers


def test_default_per_ip_limits_are_the_documented_classes() -> None:
    settings = make_settings()
    app = create_app(settings)
    install_auth(app, settings)
    limiters = app.state.auth_limiters
    assert (limiters["anonymous_entry"]._limit, limiters["session_write"]._limit) == (10, 60)
    assert limiters["session_read"]._limit == 120
    other = create_app(settings)
    install_auth(other, settings, rate_limits=RateLimits(1, 2, 3))
    assert other.state.auth_limiters["session_read"]._limit == 3


def test_configured_keys_are_used_in_memory_mode_too() -> None:
    settings = make_settings(**KEYS)
    first, second = create_app(settings), create_app(settings)
    store, provider = InMemoryAccounts(), FakeSupabaseAuth()
    for app in (first, second):
        install_auth(app, settings, repository=store, profiles=store, provider=provider)
    with TestClient(first, headers={"Origin": ORIGIN}) as one:
        register(one)
        cookie = one.cookies.get("qatra_session")
    with TestClient(second, headers={"Origin": ORIGIN}) as two:
        two.cookies.set("qatra_session", cookie)
        assert two.get("/api/me").status_code == 200  # the same keys: the session survives


def test_without_configured_keys_two_processes_cannot_read_each_others_sessions() -> None:
    settings = make_settings()
    first, second = create_app(settings), create_app(settings)
    store, provider = InMemoryAccounts(), FakeSupabaseAuth()
    for app in (first, second):
        install_auth(app, settings, repository=store, profiles=store, provider=provider)
    with TestClient(first, headers={"Origin": ORIGIN}) as one:
        register(one)
        cookie = one.cookies.get("qatra_session")
    with TestClient(second, headers={"Origin": ORIGIN}) as two:
        two.cookies.set("qatra_session", cookie)
        assert two.get("/api/me").status_code == 401  # ephemeral keys: the blob does not decrypt


def test_supabase_mode_wires_the_restricted_role_postgrest_and_the_auth_api(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_connection(*args: object, **kwargs: object) -> None:
        raise AssertionError("installing must not touch the database")

    monkeypatch.setattr(accounts_module.psycopg, "connect", no_connection)
    settings = Settings(_env_file=None, **production_values())  # type: ignore[call-arg]
    app = create_app(settings)
    install_auth(app, settings)
    state = app.state
    assert isinstance(state.account_repository, PostgresAccountRepository)
    assert isinstance(state.profile_store, PostgrestProfileStore)
    assert isinstance(state.auth_provider, HttpSupabaseAuth)
    assert state.session_resolver.cookie_name == "__Host-qatra_session"
    for component in (state.account_repository, state.profile_store, state.auth_provider):
        assert "redacted" in repr(component)
    assert "dummy" not in repr(state.account_repository)


def broken_production(**blank: str) -> tuple[FastAPI, Settings]:
    """An application built from a valid production configuration, and a configuration of the
    same environment in which some variables are blank (``install_auth`` must refuse it)."""
    valid = Settings(_env_file=None, **production_values())  # type: ignore[call-arg]
    broken = Settings(_env_file=None, **production_values(**blank))  # type: ignore[call-arg]
    return create_app(valid), broken


def test_production_names_a_missing_database_credential() -> None:
    app, settings = broken_production(QATRA_SERVER_DB=" ")
    with pytest.raises(StartupConfigError) as raised:
        install_auth(app, settings)
    assert "QATRA_SERVER_DB" in str(raised.value)


def test_production_names_missing_project_settings_never_their_values() -> None:
    app, settings = broken_production(
        SUPABASE_URL=" ",
        SUPABASE_ANON_KEY=" ",
        QATRA_SERVER_DB="postgresql://x:SENTINEL@h/db",
    )
    with pytest.raises(StartupConfigError) as raised:
        install_auth(app, settings)
    message = str(raised.value)
    assert "SUPABASE_URL" in message and "SUPABASE_ANON_KEY" in message
    assert "SENTINEL" not in message


def test_production_never_falls_back_to_a_half_installed_application() -> None:
    app, settings = broken_production(QATRA_SESSION_KEY=" ")
    with pytest.raises(StartupConfigError) as raised:
        install_auth(app, settings)
    assert "QATRA_SESSION_KEY" in str(raised.value)
    assert not hasattr(app.state, "session_resolver")


def test_a_fully_configured_development_application_gets_the_real_components() -> None:
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        QATRA_SERVER_DB="postgresql://x:SENTINEL@h/db",
        SUPABASE_URL="https://project.example",
        SUPABASE_ANON_KEY="anon",
        SUPABASE_SERVICE_ROLE_KEY="service",
        **KEYS,
    )
    app = create_app(settings)
    install_auth(app, settings)
    assert isinstance(app.state.account_repository, PostgresAccountRepository)
    assert isinstance(app.state.auth_provider, HttpSupabaseAuth)


# --- development and test without supabase configuration ------------------------------------------


def test_a_development_application_without_supabase_configuration_still_starts(
    log_lines: list[str],
) -> None:
    """``create_app`` must keep working with only FRONTEND_ORIGIN and TERMS_VERSION (contract §8):
    the routes exist, answer 503 because nothing stands behind them, and session checks deny."""
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase", QATRA_SERVER_DB="postgresql://x:SENTINEL@h/db"
    )
    app = create_app(settings)
    install_auth(app, settings)
    assert not hasattr(app.state, "session_resolver")
    assert not hasattr(app.state, "auth_service")
    with TestClient(app, headers={"Origin": ORIGIN}) as client:
        for response in (register(client), login(client), client.post("/api/auth/logout")):
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "unavailable"
        me = client.get("/api/me")
        assert me.status_code == 401 and me.json()["error"]["code"] == "unauthenticated"
    joined = "\n".join(log_lines)
    assert "auth_not_configured" in joined
    for name in ("QATRA_SESSION_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        assert name in joined
    assert "QATRA_SERVER_DB" not in joined  # it is set, so it is not reported
    assert "SENTINEL" not in joined  # names only, never values


def test_the_unconfigured_routes_are_still_in_the_api_description() -> None:
    settings = make_settings(QATRA_DATA_BACKEND="supabase")
    app = create_app(settings)
    install_auth(app, settings)
    assert "/api/auth/register" in app.openapi()["paths"]
    assert "/api/me" in app.openapi()["paths"]


def test_a_value_that_is_set_but_invalid_still_fails_in_development() -> None:
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        QATRA_SERVER_DB="postgresql://x:y@h/db",
        SUPABASE_URL="https://project.example",
        SUPABASE_ANON_KEY="anon",
        SUPABASE_SERVICE_ROLE_KEY="service",
        **{**KEYS, "QATRA_SESSION_KEY": "not base64!"},
    )
    with pytest.raises(StartupConfigError) as raised:
        install_auth(create_app(settings), settings)
    assert "QATRA_SESSION_KEY must be base64" in str(raised.value)


def test_injected_components_do_not_need_the_variables_they_replace() -> None:
    settings = make_settings(QATRA_DATA_BACKEND="supabase", **KEYS)
    app = create_app(settings)
    store, provider = InMemoryAccounts(), FakeSupabaseAuth()
    install_auth(app, settings, repository=store, profiles=store, provider=provider)
    assert app.state.account_repository is store  # fully wired: no SUPABASE_* or DSN needed
    assert app.state.session_resolver.cookie_name == "qatra_session"


@pytest.mark.parametrize(
    ("name", "value", "expected"),
    [
        ("QATRA_SESSION_KEY", "not base64!", "QATRA_SESSION_KEY must be base64"),
        ("QATRA_SESSION_KEY", random_key_b64(16), "exactly 32 bytes"),
        ("QATRA_THROTTLE_HMAC_KEY", random_key_b64(8), "at least 32 bytes"),
    ],
)
def test_invalid_keys_stop_the_installation_by_name(name: str, value: str, expected: str) -> None:
    settings = make_settings(**{**KEYS, name: value})
    with pytest.raises(StartupConfigError) as raised:
        install_auth(create_app(settings), settings)
    assert expected in str(raised.value) and value not in str(raised.value)


def test_memory_mode_needs_no_keys_and_supabase_mode_in_development_waits_for_them() -> None:
    memory = make_settings()
    install_auth(create_app(memory), memory)  # ephemeral keys
    supabase = make_settings(QATRA_DATA_BACKEND="supabase")
    app = create_app(supabase)
    install_auth(app, supabase)  # development: not configured yet, so no services (503 routes)
    assert not hasattr(app.state, "auth_service")


def test_injected_components_replace_the_defaults() -> None:
    settings = make_settings()
    app = create_app(settings)
    store, provider = InMemoryAccounts(), FakeSupabaseAuth()
    install_auth(app, settings, repository=store, profiles=store, provider=provider)
    assert app.state.account_repository is store and app.state.auth_provider is provider
