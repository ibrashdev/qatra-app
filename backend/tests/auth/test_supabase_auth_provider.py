"""Supabase Auth provider over ``httpx.MockTransport`` (no network), plus the in-memory fake.

Checks which key each call uses (service role only for the three Admin operations, the learner's
own token for the password change, the anon key otherwise), the retry policy, the mapping of every
status to one of four typed failures, and that nothing secret leaks into errors, ``repr`` or
logs."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from uuid import UUID, uuid4

import httpx
import pytest

from app.config import StartupConfigError
from app.providers.supabase_auth import (
    DEFAULT_TIMEOUT,
    INTERNAL_ALIAS_DOMAIN,
    AuthInvalidCredentials,
    AuthProviderUnavailable,
    AuthRefreshRejected,
    AuthRequestRejected,
    AuthTokens,
    FakeSupabaseAuth,
    HttpSupabaseAuth,
    new_internal_alias,
)
from tests.support import make_settings

BASE = "https://project.example"
ANON = "anon-key-sentinel"
SERVICE = "service-role-key-sentinel"
USER = UUID("11111111-1111-4111-8111-111111111111")
ALIAS = "u.00000000-0000-4000-8000-000000000001@qatra.invalid"
SECRET_PASSWORD = "synthetic passphrase sentinel"

Responder = Callable[[httpx.Request], httpx.Response]


class Wire:
    """Records every request and answers with a scripted sequence of responders."""

    def __init__(self, *responders: Responder) -> None:
        self.requests: list[httpx.Request] = []
        self._responders = list(responders)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        responder = self._responders.pop(0) if len(self._responders) > 1 else self._responders[0]
        return responder(request)

    def body(self, index: int = 0) -> dict[str, object]:
        return json.loads(self.requests[index].content)


def reply(status: int, body: object | None = None) -> Responder:
    return lambda request: httpx.Response(status, json=body if body is not None else {})


def provider(*responders: Responder) -> tuple[HttpSupabaseAuth, Wire, list[float]]:
    wire = Wire(*responders)
    pauses: list[float] = []
    client = HttpSupabaseAuth(
        BASE,
        ANON,
        SERVICE,
        transport=httpx.MockTransport(wire),
        sleep=pauses.append,
        clock=lambda: 1_000_000.0,
    )
    return client, wire, pauses


TOKEN_BODY = {
    "access_token": "access-sentinel",
    "refresh_token": "refresh-sentinel",
    "expires_at": 1_790_000_000,
    "expires_in": 3600,
    "token_type": "bearer",
}


def auth_header(request: httpx.Request) -> tuple[str, str]:
    return request.headers["apikey"], request.headers["authorization"]


# --- create user (Admin API, service role) --------------------------------------------------------


def test_create_user_uses_the_service_role_and_confirms_the_alias() -> None:
    auth, wire, _ = provider(reply(200, {"id": str(USER), "email": ALIAS}))
    assert auth.create_user(ALIAS, SECRET_PASSWORD) == USER
    request = wire.requests[0]
    assert (request.method, str(request.url)) == ("POST", f"{BASE}/auth/v1/admin/users")
    assert auth_header(request) == (SERVICE, f"Bearer {SERVICE}")
    assert wire.body() == {"email": ALIAS, "password": SECRET_PASSWORD, "email_confirm": True}


def test_create_user_accepts_201() -> None:
    auth, _, _ = provider(reply(201, {"id": str(USER)}))
    assert auth.create_user(ALIAS, SECRET_PASSWORD) == USER


@pytest.mark.parametrize(
    ("status", "body", "error"),
    [
        (422, {"msg": "weak"}, AuthRequestRejected),
        (400, {}, AuthRequestRejected),
        (403, {}, AuthRequestRejected),
        (429, {}, AuthProviderUnavailable),
        (500, {}, AuthProviderUnavailable),
        (503, {}, AuthProviderUnavailable),
        (200, {"no": "id"}, AuthProviderUnavailable),
        (200, {"id": "not-a-uuid"}, AuthProviderUnavailable),
        (200, ["list"], AuthProviderUnavailable),
    ],
)
def test_create_user_failures_are_typed(status: int, body: object, error: type[Exception]) -> None:
    auth, wire, _ = provider(reply(status, body))
    with pytest.raises(error):
        auth.create_user(ALIAS, SECRET_PASSWORD)
    assert len(wire.requests) == 1  # creating a user is not retried


def test_create_user_with_an_unparsable_answer_is_unavailable() -> None:
    auth, _, _ = provider(lambda request: httpx.Response(200, content=b"<html>"))
    with pytest.raises(AuthProviderUnavailable):
        auth.create_user(ALIAS, SECRET_PASSWORD)


# --- password grant and refresh (anon key) --------------------------------------------------------


def test_password_grant_uses_the_anon_key_and_parses_tokens() -> None:
    auth, wire, _ = provider(reply(200, TOKEN_BODY))
    tokens = auth.password_grant(ALIAS, SECRET_PASSWORD)
    assert tokens == AuthTokens("access-sentinel", "refresh-sentinel", 1_790_000_000)
    request = wire.requests[0]
    assert (request.method, request.url.path) == ("POST", "/auth/v1/token")
    assert dict(request.url.params) == {"grant_type": "password"}
    assert auth_header(request) == (ANON, f"Bearer {ANON}")
    assert wire.body() == {"email": ALIAS, "password": SECRET_PASSWORD}
    assert SERVICE not in request.headers["authorization"]


def test_expiry_falls_back_to_expires_in_and_accepts_floats() -> None:
    body = {k: v for k, v in TOKEN_BODY.items() if k != "expires_at"}
    auth, _, _ = provider(reply(200, body))
    assert auth.password_grant(ALIAS, SECRET_PASSWORD).expires_at == 1_000_000 + 3600
    auth, _, _ = provider(reply(200, {**TOKEN_BODY, "expires_at": 1_790_000_000.9}))
    assert auth.password_grant(ALIAS, SECRET_PASSWORD).expires_at == 1_790_000_000


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"access_token": "a", "refresh_token": "r"},
        {"access_token": "", "refresh_token": "r", "expires_at": 1},
        {"access_token": "a", "refresh_token": 5, "expires_at": 1},
        {"access_token": "a", "refresh_token": "r", "expires_at": True},
        {"access_token": "a", "refresh_token": "r", "expires_at": "tomorrow"},
    ],
)
def test_an_incomplete_token_answer_is_unavailable(body: dict[str, object]) -> None:
    auth, _, _ = provider(reply(200, body))
    with pytest.raises(AuthProviderUnavailable):
        auth.password_grant(ALIAS, SECRET_PASSWORD)


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (400, AuthInvalidCredentials),
        (401, AuthInvalidCredentials),
        (403, AuthProviderUnavailable),
        (422, AuthProviderUnavailable),
        (429, AuthProviderUnavailable),
        (500, AuthProviderUnavailable),
    ],
)
def test_password_grant_failures(status: int, error: type[Exception]) -> None:
    auth, wire, _ = provider(reply(status, {"error": "invalid_grant"}))
    with pytest.raises(error):
        auth.password_grant(ALIAS, SECRET_PASSWORD)
    assert len(wire.requests) == 1


def test_refresh_grant_request_and_rotation() -> None:
    auth, wire, _ = provider(reply(200, {**TOKEN_BODY, "access_token": "new-access"}))
    tokens = auth.refresh("old-refresh-sentinel")
    assert tokens.access == "new-access"
    request = wire.requests[0]
    assert dict(request.url.params) == {"grant_type": "refresh_token"}
    assert auth_header(request) == (ANON, f"Bearer {ANON}")
    assert wire.body() == {"refresh_token": "old-refresh-sentinel"}


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (400, AuthRefreshRejected),
        (401, AuthRefreshRejected),
        (429, AuthProviderUnavailable),
        (500, AuthProviderUnavailable),
        (502, AuthProviderUnavailable),
    ],
)
def test_refresh_failures(status: int, error: type[Exception]) -> None:
    auth, _, _ = provider(reply(status))
    with pytest.raises(error):
        auth.refresh("r")


# --- password changes -----------------------------------------------------------------------------


def test_recovery_reset_uses_the_admin_api() -> None:
    auth, wire, _ = provider(reply(200, {"id": str(USER)}))
    auth.admin_set_password(USER, SECRET_PASSWORD)
    request = wire.requests[0]
    assert (request.method, str(request.url)) == ("PUT", f"{BASE}/auth/v1/admin/users/{USER}")
    assert auth_header(request) == (SERVICE, f"Bearer {SERVICE}")
    assert wire.body() == {"password": SECRET_PASSWORD}


def test_the_settings_password_change_uses_the_learners_own_token_never_the_service_role() -> None:
    auth, wire, _ = provider(reply(200, {"id": str(USER)}))
    auth.change_password("learner-access-token-sentinel", SECRET_PASSWORD)
    request = wire.requests[0]
    assert (request.method, str(request.url)) == ("PUT", f"{BASE}/auth/v1/user")
    assert auth_header(request) == (ANON, "Bearer learner-access-token-sentinel")
    assert SERVICE not in str(request.headers)
    assert wire.body() == {"password": SECRET_PASSWORD}


@pytest.mark.parametrize("operation", ["admin_set_password", "change_password"])
def test_password_writes_are_repeated_once_after_a_transient_failure(operation: str) -> None:
    auth, wire, pauses = provider(reply(500), reply(200, {}))
    call = getattr(auth, operation)
    call(USER if operation == "admin_set_password" else "token", SECRET_PASSWORD)
    assert len(wire.requests) == 2 and len(pauses) == 1


@pytest.mark.parametrize("operation", ["admin_set_password", "change_password"])
def test_a_second_transient_failure_is_unavailable(operation: str) -> None:
    auth, wire, _ = provider(reply(503))
    call = getattr(auth, operation)
    with pytest.raises(AuthProviderUnavailable):
        call(USER if operation == "admin_set_password" else "token", SECRET_PASSWORD)
    assert len(wire.requests) == 2  # one repeat, no more


@pytest.mark.parametrize("status", [401, 403, 404, 422])
def test_a_definite_rejection_is_not_repeated(status: int) -> None:
    auth, wire, pauses = provider(reply(status))
    with pytest.raises(AuthRequestRejected):
        auth.admin_set_password(USER, SECRET_PASSWORD)
    assert len(wire.requests) == 1 and pauses == []


# --- delete user (Admin API) ----------------------------------------------------------------------


@pytest.mark.parametrize("status", [200, 204, 404])
def test_delete_is_idempotent_an_already_deleted_user_counts_as_success(status: int) -> None:
    auth, wire, pauses = provider(reply(status))
    auth.admin_delete_user(USER)
    request = wire.requests[0]
    assert (request.method, str(request.url)) == ("DELETE", f"{BASE}/auth/v1/admin/users/{USER}")
    assert auth_header(request) == (SERVICE, f"Bearer {SERVICE}")
    assert len(wire.requests) == 1 and pauses == []


def test_delete_is_retried_once() -> None:
    auth, wire, pauses = provider(reply(500), reply(200))
    auth.admin_delete_user(USER)
    assert len(wire.requests) == 2 and pauses == [0.25]
    auth, wire, _ = provider(reply(502))
    with pytest.raises(AuthProviderUnavailable):
        auth.admin_delete_user(USER)
    assert len(wire.requests) == 2


def test_a_retry_that_finds_the_user_already_gone_succeeds() -> None:
    auth, wire, _ = provider(reply(500), reply(404))
    auth.admin_delete_user(USER)
    assert len(wire.requests) == 2


# --- transport failures and secrecy ---------------------------------------------------------------


def raising(exc: Exception) -> Responder:
    def responder(request: httpx.Request) -> httpx.Response:
        raise exc

    return responder


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectTimeout(f"timed out reaching {BASE} with {SECRET_PASSWORD}"),
        httpx.ReadTimeout("read"),
        httpx.ConnectError(f"{ANON} refused"),
        RuntimeError(f"unexpected {SECRET_PASSWORD}"),
    ],
)
def test_transport_errors_become_unavailable_without_leaking_anything(exc: Exception) -> None:
    auth, _, _ = provider(raising(exc))
    with pytest.raises(AuthProviderUnavailable) as raised:
        auth.password_grant(ALIAS, SECRET_PASSWORD)
    assert str(raised.value) == ""
    assert raised.value.__cause__ is None and raised.value.__suppress_context__
    assert SECRET_PASSWORD not in repr(raised.value) and ANON not in repr(raised.value)


def test_repr_redacts_keys_and_tokens() -> None:
    auth, _, _ = provider(reply(200, TOKEN_BODY))
    assert ANON not in repr(auth) and SERVICE not in repr(auth) and "redacted" in repr(auth)
    tokens = auth.password_grant(ALIAS, SECRET_PASSWORD)
    assert "access-sentinel" not in repr(tokens) and "refresh-sentinel" not in repr(tokens)


def test_nothing_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    auth, _, _ = provider(reply(200, TOKEN_BODY), reply(401), reply(500))
    auth.password_grant(ALIAS, SECRET_PASSWORD)
    with pytest.raises(AuthInvalidCredentials):
        auth.password_grant(ALIAS, SECRET_PASSWORD)
    with pytest.raises(AuthProviderUnavailable):
        auth.refresh("refresh-sentinel")
    text = "\n".join(caplog.messages)
    for secret in (SECRET_PASSWORD, "access-sentinel", "refresh-sentinel", ANON, ALIAS):
        assert secret not in text


def test_timeouts_are_explicit() -> None:
    assert DEFAULT_TIMEOUT.connect == 5.0 and DEFAULT_TIMEOUT.read == 10.0
    assert DEFAULT_TIMEOUT.write == 10.0 and DEFAULT_TIMEOUT.pool == 10.0
    auth, _, _ = provider(reply(200, TOKEN_BODY))
    assert auth._timeout is DEFAULT_TIMEOUT


def test_from_settings_reads_the_urls_and_keys() -> None:
    settings = make_settings(
        SUPABASE_URL=f"{BASE}/", SUPABASE_ANON_KEY=ANON, SUPABASE_SERVICE_ROLE_KEY=SERVICE
    )
    wire = Wire(reply(200, TOKEN_BODY))
    auth = HttpSupabaseAuth.from_settings(settings, transport=httpx.MockTransport(wire))
    auth.password_grant(ALIAS, SECRET_PASSWORD)
    assert str(wire.requests[0].url).startswith(f"{BASE}/auth/v1/token")  # no double slash


def test_from_settings_without_configuration_names_the_variables() -> None:
    with pytest.raises(StartupConfigError) as raised:
        HttpSupabaseAuth.from_settings(make_settings(SUPABASE_URL=BASE))
    assert "SUPABASE_ANON_KEY" in str(raised.value) and "SUPABASE_SERVICE_ROLE_KEY" in str(
        raised.value
    )
    assert BASE not in str(raised.value)


def test_internal_aliases_match_the_database_check() -> None:
    pattern = re.compile(
        r"^u\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@qatra\.invalid$"
    )
    aliases = {new_internal_alias() for _ in range(50)}
    assert len(aliases) == 50 and all(pattern.match(a) for a in aliases)
    assert INTERNAL_ALIAS_DOMAIN == "qatra.invalid"


# --- the in-memory fake ---------------------------------------------------------------------------


@pytest.fixture
def fake() -> FakeSupabaseAuth:
    now = [1_000_000.0]
    instance = FakeSupabaseAuth(clock=lambda: now[0], token_lifetime_sec=3600)
    instance.now = now  # type: ignore[attr-defined]
    return instance


def test_fake_creates_users_and_grants_tokens(fake: FakeSupabaseAuth) -> None:
    user = fake.create_user(ALIAS, SECRET_PASSWORD)
    assert fake.has_user(user) and fake.user_count() == 1 and fake.alias_of(user) == ALIAS
    tokens = fake.password_grant(ALIAS, SECRET_PASSWORD)
    assert tokens.expires_at == 1_003_600 and tokens.access != tokens.refresh
    with pytest.raises(AuthInvalidCredentials):
        fake.password_grant(ALIAS, "wrong password value")
    with pytest.raises(AuthInvalidCredentials):
        fake.password_grant("u.other@qatra.invalid", SECRET_PASSWORD)
    with pytest.raises(AuthRequestRejected):
        fake.create_user(ALIAS, SECRET_PASSWORD)  # the alias is unique


def test_fake_refresh_tokens_rotate_and_work_once(fake: FakeSupabaseAuth) -> None:
    fake.create_user(ALIAS, SECRET_PASSWORD)
    first = fake.password_grant(ALIAS, SECRET_PASSWORD)
    second = fake.refresh(first.refresh)
    assert second.refresh != first.refresh and second.access != first.access
    with pytest.raises(AuthRefreshRejected):
        fake.refresh(first.refresh)  # reuse of a rotated token
    fake.revoke_refresh_tokens()
    with pytest.raises(AuthRefreshRejected):
        fake.refresh(second.refresh)


def test_fake_password_changes(fake: FakeSupabaseAuth) -> None:
    user = fake.create_user(ALIAS, SECRET_PASSWORD)
    tokens = fake.password_grant(ALIAS, SECRET_PASSWORD)
    fake.change_password(tokens.access, "changed with the learner's own token")
    assert fake.password_matches(user, "changed with the learner's own token")
    fake.admin_set_password(user, "set by recovery")
    assert fake.password_matches(user, "set by recovery")
    fake.expire_access_tokens()
    with pytest.raises(AuthRequestRejected):
        fake.change_password(tokens.access, "x" * 20)
    with pytest.raises(AuthRequestRejected):
        fake.admin_set_password(uuid4(), "y" * 20)


def test_fake_delete_is_idempotent_and_removes_tokens(fake: FakeSupabaseAuth) -> None:
    user = fake.create_user(ALIAS, SECRET_PASSWORD)
    tokens = fake.password_grant(ALIAS, SECRET_PASSWORD)
    fake.admin_delete_user(user)
    fake.admin_delete_user(user)
    assert not fake.has_user(user)
    with pytest.raises(AuthRefreshRejected):
        fake.refresh(tokens.refresh)
    fake.create_user(ALIAS, SECRET_PASSWORD)  # the alias is free again


def test_fake_can_be_scripted_to_fail_and_records_calls(fake: FakeSupabaseAuth) -> None:
    fake.script_failure("create_user", AuthProviderUnavailable(), times=2)
    for _ in range(2):
        with pytest.raises(AuthProviderUnavailable):
            fake.create_user(ALIAS, SECRET_PASSWORD)
    fake.create_user(ALIAS, SECRET_PASSWORD)
    assert fake.calls == ["create_user"] * 3
    assert "redacted" in repr(fake)
