"""Rules that hold for every operation E03-E13: the Origin check on each mutation, ``no-store`` on
each response, nothing personal in the logs, and the production cookie (API-spec §1.3, §1.9,
§1.12)."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers.supabase_auth import FakeSupabaseAuth
from app.repositories.accounts import InMemoryAccounts
from app.routers.auth import RateLimits, install_auth
from tests.auth.auth_support import (
    NEW_PASSWORD,
    PASSWORD,
    USERNAME,
    FakeClock,
    Harness,
    build_harness,
    change_password,
    login,
    register,
    registration,
    reset_password,
    rotate_recovery,
    verify_recovery,
)
from tests.support import production_values
from tests.test_origin import unguarded_mutations

MUTATIONS: list[tuple[str, str, dict[str, Any]]] = [
    ("POST", "/api/auth/register", registration(username="origin_probe")),
    ("POST", "/api/auth/login", {"username": USERNAME, "password": PASSWORD}),
    ("POST", "/api/auth/consent", {"termsVersion": "2026-10-04"}),
    ("POST", "/api/auth/recovery/verify", {"username": USERNAME, "recoveryCode": "0" * 32}),
    ("POST", "/api/auth/recovery/reset", {"resetGrant": "g", "newPassword": NEW_PASSWORD}),
    ("POST", "/api/auth/recovery/rotate", {"password": PASSWORD}),
    ("POST", "/api/auth/password", {"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD}),
    ("POST", "/api/auth/logout", {}),
    ("PATCH", "/api/me", {"language": "en"}),
    ("POST", "/api/account/delete", {"password": PASSWORD, "confirm": "DELETE"}),
]


def test_the_application_exposes_exactly_the_operations_e03_to_e13(harness: Harness) -> None:
    operations = {
        (method.upper(), path)
        for path, item in harness.app.openapi()["paths"].items()
        for method in item
        if path.startswith("/api/auth") or path in ("/api/me", "/api/account/delete")
    }
    assert operations == {(method, path) for method, path, _ in MUTATIONS} | {("GET", "/api/me")}


# --- Origin on every mutation ---------------------------------------------------------------------


def test_every_state_changing_route_checks_origin_before_anything_else(harness: Harness) -> None:
    """The framework-wide black-box check of ``tests/test_origin.py`` run over the application
    with authentication installed: it removes the ASGI guard and proves that each route's own
    dependency answers ``403 forbidden_origin`` first, before authentication and the body."""
    assert unguarded_mutations(harness.app) == []


@pytest.mark.parametrize(("method", "path", "body"), MUTATIONS, ids=[m[1] for m in MUTATIONS])
@pytest.mark.parametrize("origin", [None, "https://evil.example", "http://localhost:3001", ""])
def test_a_wrong_or_missing_origin_is_403_and_changes_nothing(
    signed_in: Harness, method: str, path: str, body: dict[str, Any], origin: str | None
) -> None:
    before = (
        signed_in.provider.user_count(),
        signed_in.store.session_count(),
        signed_in.store.throttle_rows(),
    )
    headers = {"Origin": origin} if origin is not None else {}
    client = signed_in.new_client()
    client.cookies.set("qatra_session", signed_in.client.cookies.get("qatra_session"))
    client.headers.pop("Origin")
    response = client.request(method, path, json=body, headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_origin"
    assert "set-cookie" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    after = (
        signed_in.provider.user_count(),
        signed_in.store.session_count(),
        signed_in.store.throttle_rows(),
    )
    assert after == before
    assert signed_in.client.get("/api/me").status_code == 200  # the account is untouched


# --- no-store on every response -------------------------------------------------------------------


def test_every_response_of_the_operations_is_no_store(signed_in: Harness) -> None:
    other = signed_in.new_client()
    responses = [
        # successes
        register(signed_in.new_client(), username="second_user"),
        login(other),
        signed_in.client.get("/api/me"),
        signed_in.client.patch("/api/me", json={"language": "en"}),
        signed_in.client.post("/api/auth/consent", json={"termsVersion": "2026-10-04"}),
        verify_recovery(signed_in.new_client(), signed_in.recovery_code),
        rotate_recovery(signed_in.client),
        # failures
        register(signed_in.new_client(), password="x"),
        register(signed_in.new_client(), termsAccepted=False),
        register(signed_in.new_client(), username=USERNAME),
        login(signed_in.new_client(address="198.51.100.1"), password="wrong passphrase value"),
        signed_in.new_client().get("/api/me"),
        reset_password(signed_in.new_client(), "unknown"),
        change_password(signed_in.client, current="wrong passphrase value"),
        signed_in.client.patch("/api/me", json={}),
        signed_in.client.post("/api/account/delete", json={"password": PASSWORD, "confirm": "no"}),
        signed_in.client.post("/api/auth/password", content=b"{broken"),
        # logout last
        other.post("/api/auth/logout"),
        signed_in.client.post(
            "/api/account/delete", json={"password": PASSWORD, "confirm": "DELETE"}
        ),
    ]
    assert len(responses) == 19
    for response in responses:
        assert response.headers["cache-control"] == "no-store", response.request.url


def test_a_throttled_response_is_no_store_and_carries_retry_after() -> None:
    harness = build_harness(rate_limits=RateLimits(anonymous_entry_per_min=1))
    with harness.client:
        register(harness.client)
        limited = register(harness.client, username="another_user")
        assert limited.status_code == 429
        assert limited.headers["cache-control"] == "no-store" and "retry-after" in limited.headers


# --- nothing personal in the logs -----------------------------------------------------------------


def test_no_secret_or_personal_value_reaches_any_log(
    all_logs: Callable[[], list[str]], capsys: pytest.CaptureFixture[str]
) -> None:
    harness = build_harness()
    secrets: list[str] = []
    with harness.client:
        created = register(
            harness.client, username="Sentinel_Name_77", password="sentinel pass 1 xyz"
        )
        assert created.status_code == 201
        code = created.json()["recoveryCode"]
        secrets += [
            "Sentinel_Name_77",
            "sentinel_name_77",
            "sentinel pass 1 xyz",
            code,
            code.replace("-", ""),
            harness.client.cookies.get("qatra_session"),
            "203.0.113.9",
            "203.0.113.0",
        ]
        tokens = harness.auth._sessions._crypto.decrypt_tokens(  # the Supabase tokens
            harness.store.stored_tokens(next(iter(harness.store._handles)))[0],
            next(iter(harness.store._handles)),
        )
        secrets += [tokens.access, tokens.refresh]
        # a representative run of every operation, successes and failures
        login(harness.new_client(), username="Sentinel_Name_77", password="sentinel wrong 2 xyz")
        login(harness.new_client(), username="Sentinel_Name_77", password="sentinel pass 1 xyz")
        harness.client.patch("/api/me", json={"language": "en", "timeZone": "Europe/London"})
        rotated = rotate_recovery(harness.client, "sentinel pass 1 xyz").json()["recoveryCode"]
        grant = verify_recovery(harness.new_client(), rotated, "Sentinel_Name_77").json()[
            "resetGrant"
        ]
        secrets += [rotated, grant, "sentinel pass 3 xyz"]
        reset_password(harness.new_client(), grant, "sentinel pass 3 xyz")
        login(harness.new_client(), username="Sentinel_Name_77", password="sentinel pass 3 xyz")
        harness.client.post("/api/auth/logout")
        harness.client.post(
            "/api/account/delete", json={"password": "sentinel wrong 4 xyz", "confirm": "DELETE"}
        )
        secrets += ["sentinel wrong 2 xyz", "sentinel wrong 4 xyz"]
    output = "\n".join(all_logs()) + capsys.readouterr().out
    assert output.strip()  # the access log did run
    for secret in secrets:
        assert secret not in output, secret
    for line in output.splitlines():
        if line.startswith("{"):
            event = json.loads(line)
            assert set(event) <= {
                "event",
                "method",
                "route",
                "status",
                "latency_ms",
                "error_code",
                "xff_entries",
                "via_vercel",
            }


def test_password_hashes_and_tokens_are_never_part_of_a_repr(signed_in: Harness) -> None:
    for obj in (signed_in.store, signed_in.provider, signed_in.auth._crypto, signed_in.app.state):
        text = repr(obj)
        assert PASSWORD not in text and signed_in.recovery_code not in text


# --- production cookie ----------------------------------------------------------------------------


def production_client() -> tuple[TestClient, InMemoryAccounts]:
    settings = Settings(_env_file=None, **production_values())  # type: ignore[call-arg]
    clock = FakeClock()
    store = InMemoryAccounts(clock=clock)
    app = create_app(settings)
    install_auth(
        app,
        settings,
        repository=store,
        profiles=store,
        provider=FakeSupabaseAuth(clock=clock.seconds),
        clock=clock,
        rate_limits=RateLimits(1000, 1000, 1000),
    )
    client = TestClient(
        app, base_url="https://qatra.example", headers={"Origin": "https://qatra.example"}
    )
    return client, store


def test_the_production_cookie_has_the_host_prefix_and_every_attribute() -> None:
    client, _ = production_client()
    with client:
        response = client.post("/api/auth/register", json=registration())
        assert response.status_code == 201
        header = response.headers["set-cookie"]
        assert header.startswith("__Host-qatra_session=")
        attributes = [part.strip() for part in header.split(";")[1:]]
        assert attributes == ["Secure", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]
        assert "Domain" not in header
        assert client.get("/api/me").status_code == 200  # the browser returns it over https


def test_production_clears_the_cookie_with_the_same_attributes_on_logout_and_on_401() -> None:
    client, _ = production_client()
    expected = "__Host-qatra_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    with client:
        client.post("/api/auth/register", json=registration())
        assert client.post("/api/auth/logout").headers["set-cookie"] == expected
        unauthenticated = client.get("/api/me")
        assert unauthenticated.status_code == 401
        assert unauthenticated.headers["set-cookie"] == expected


def test_production_disables_the_interactive_docs_with_authentication_installed() -> None:
    client, _ = production_client()
    with client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404


def test_the_development_cookie_is_not_secure_and_has_no_prefix(harness: Harness) -> None:
    response = register(harness.client)
    header = response.headers["set-cookie"]
    assert header.startswith("qatra_session=") and "Secure" not in header
