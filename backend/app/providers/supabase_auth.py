"""Supabase Auth provider (GoTrue REST): the only identity operations the backend performs.

Allowed uses (contract §3.2, §6; API-spec §1.4): with the ``service_role`` key only the Admin API
operations create user (registration), set password by recovery (E07) and delete user (E13); with
the learner's OWN access token the password change of E09 (API-spec O-14); with the anon key the
password grant (login and the re-checks of E08, E09, E13) and the refresh grant. ``service_role``
never serves a learner request and never touches the ``srv_*`` functions.

Every failure is reduced to one of four exception types without detail: request and response
bodies, tokens, passwords, aliases and library messages are never logged, echoed or chained. The
classes redact themselves in ``repr``. All HTTP calls carry explicit timeouts.

``FakeSupabaseAuth`` is the in-memory stand-in for memory mode (development and tests); it
mirrors the observable behaviour used by the services (single-use refresh tokens, password
grant, idempotent delete) and can be scripted to fail.
"""

from __future__ import annotations

import hmac
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID, uuid4

import httpx

from app.config import Settings, StartupConfigError

INTERNAL_ALIAS_DOMAIN = "qatra.invalid"
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
RETRY_PAUSE_SEC = 0.25


def new_internal_alias() -> str:
    """The technical Auth address ``u.<uuid4>@qatra.invalid`` (never a learner email)."""
    return f"u.{uuid4()}@{INTERNAL_ALIAS_DOMAIN}"


class AuthProviderError(Exception):
    """Base of every provider failure. Carries no message, no body and no cause."""


class AuthProviderUnavailable(AuthProviderError):
    """Network failure, timeout, rate limit, 5xx or an answer that cannot be understood: the
    outcome is not known to be a rejection. Maps to 503 ``unavailable``."""


class AuthInvalidCredentials(AuthProviderError):
    """The password grant was rejected: the alias or password is wrong."""


class AuthRefreshRejected(AuthProviderError):
    """The refresh token is invalid, expired or already used: the session cannot continue."""


class AuthRequestRejected(AuthProviderError):
    """A definite 4xx rejection of an admin or user operation (not a credentials failure)."""


@dataclass(frozen=True, slots=True)
class AuthTokens:
    """Tokens of one Supabase session. ``expires_at`` is the access token's expiry in unix
    seconds."""

    access: str
    refresh: str
    expires_at: int

    def __repr__(self) -> str:
        return "AuthTokens(<redacted>)"


class SupabaseAuth(Protocol):
    def create_user(self, alias: str, password: str) -> UUID:
        """Admin API: create a confirmed user with the internal alias; returns its id."""

    def password_grant(self, alias: str, password: str) -> AuthTokens:
        """Password grant. ``AuthInvalidCredentials`` for a wrong alias or password."""

    def refresh(self, refresh_token: str) -> AuthTokens:
        """Refresh grant. ``AuthRefreshRejected`` when the token is no longer valid."""

    def admin_set_password(self, user_id: UUID, new_password: str) -> None:
        """Admin API: set a password (recovery, E07). Idempotent; retried once."""

    def change_password(self, access_token: str, new_password: str) -> None:
        """The user's own token changes the password (E09, O-14). Idempotent; retried once."""

    def admin_delete_user(self, user_id: UUID) -> None:
        """Admin API: delete a user. An already deleted user counts as success; retried once."""


class HttpSupabaseAuth:
    """GoTrue over HTTPS. ``transport`` is injected by tests (``httpx.MockTransport``)."""

    def __init__(
        self,
        base_url: str,
        anon_key: str,
        service_role_key: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._base = base_url.rstrip("/") + "/auth/v1"
        self._anon_key = anon_key
        self._service_key = service_role_key
        self._transport = transport
        self._timeout = timeout
        self._sleep = sleep
        self._clock = clock

    def __repr__(self) -> str:
        return "HttpSupabaseAuth(<redacted>)"

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs: Any) -> HttpSupabaseAuth:
        missing = [
            name
            for name in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY")
            if settings.is_missing(name)
        ]
        if missing:
            raise StartupConfigError([f"{name} is required" for name in missing])
        assert settings.SUPABASE_URL and settings.SUPABASE_ANON_KEY
        assert settings.SUPABASE_SERVICE_ROLE_KEY
        return cls(
            settings.SUPABASE_URL,
            settings.SUPABASE_ANON_KEY.get_secret_value(),
            settings.SUPABASE_SERVICE_ROLE_KEY.get_secret_value(),
            **kwargs,
        )

    # -- transport -----------------------------------------------------------------------------

    def _send(
        self,
        method: str,
        path: str,
        *,
        key: str,
        bearer: str | None = None,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        headers = {"apikey": key, "Authorization": f"Bearer {bearer or key}"}
        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout) as client:
                return client.request(
                    method, self._base + path, params=params, json=body, headers=headers
                )
        except Exception:
            # Library messages can contain the URL, headers or body fragments.
            raise AuthProviderUnavailable() from None

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        try:
            data = response.json()
        except ValueError:
            raise AuthProviderUnavailable() from None
        if not isinstance(data, dict):
            raise AuthProviderUnavailable()
        return data

    def _tokens(self, response: httpx.Response) -> AuthTokens:
        data = self._json(response)
        access, refresh = data.get("access_token"), data.get("refresh_token")
        if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
            raise AuthProviderUnavailable()
        expires_at = data.get("expires_at")
        if isinstance(expires_at, int | float) and not isinstance(expires_at, bool):
            return AuthTokens(access, refresh, int(expires_at))
        expires_in = data.get("expires_in")
        if isinstance(expires_in, int | float) and not isinstance(expires_in, bool):
            return AuthTokens(access, refresh, int(self._clock()) + int(expires_in))
        raise AuthProviderUnavailable()

    def _idempotent(self, operation: Callable[[], None]) -> None:
        """Run an idempotent write; one repeat after a pause when the first try was unavailable."""
        try:
            operation()
            return
        except AuthProviderUnavailable:
            self._sleep(RETRY_PAUSE_SEC)
        operation()

    # -- operations ----------------------------------------------------------------------------

    def create_user(self, alias: str, password: str) -> UUID:
        response = self._send(
            "POST",
            "/admin/users",
            key=self._service_key,
            body={"email": alias, "password": password, "email_confirm": True},
        )
        if response.status_code in (200, 201):
            raw = self._json(response).get("id")
            try:
                return UUID(str(raw))
            except ValueError:
                raise AuthProviderUnavailable() from None
        if 400 <= response.status_code < 500 and response.status_code != 429:
            raise AuthRequestRejected()
        raise AuthProviderUnavailable()

    def password_grant(self, alias: str, password: str) -> AuthTokens:
        response = self._send(
            "POST",
            "/token",
            key=self._anon_key,
            params={"grant_type": "password"},
            body={"email": alias, "password": password},
        )
        if response.status_code == 200:
            return self._tokens(response)
        if response.status_code in (400, 401):
            raise AuthInvalidCredentials()
        raise AuthProviderUnavailable()

    def refresh(self, refresh_token: str) -> AuthTokens:
        response = self._send(
            "POST",
            "/token",
            key=self._anon_key,
            params={"grant_type": "refresh_token"},
            body={"refresh_token": refresh_token},
        )
        if response.status_code == 200:
            return self._tokens(response)
        if response.status_code in (400, 401):
            raise AuthRefreshRejected()
        raise AuthProviderUnavailable()

    def admin_set_password(self, user_id: UUID, new_password: str) -> None:
        def attempt() -> None:
            response = self._send(
                "PUT",
                f"/admin/users/{user_id}",
                key=self._service_key,
                body={"password": new_password},
            )
            self._expect_update(response)

        self._idempotent(attempt)

    def change_password(self, access_token: str, new_password: str) -> None:
        def attempt() -> None:
            response = self._send(
                "PUT",
                "/user",
                key=self._anon_key,
                bearer=access_token,
                body={"password": new_password},
            )
            self._expect_update(response)

        self._idempotent(attempt)

    @staticmethod
    def _expect_update(response: httpx.Response) -> None:
        if response.status_code == 200:
            return
        if 400 <= response.status_code < 500 and response.status_code != 429:
            raise AuthRequestRejected()
        raise AuthProviderUnavailable()

    def admin_delete_user(self, user_id: UUID) -> None:
        def attempt() -> None:
            response = self._send("DELETE", f"/admin/users/{user_id}", key=self._service_key)
            if response.status_code in (200, 204, 404):  # 404: already deleted
                return
            raise AuthProviderUnavailable()

        self._idempotent(attempt)


# --- memory mode ----------------------------------------------------------------------------------


@dataclass
class _FakeUser:
    user_id: UUID
    alias: str
    password: str


class FakeSupabaseAuth:
    """In-memory identity provider for memory mode and tests.

    Tokens are random opaque strings. A refresh token works once (rotation). ``calls`` records
    the operation names in order; ``script_failure`` makes the next calls of one operation raise
    the given error (to test compensation and retries)."""

    def __init__(
        self, *, clock: Callable[[], float] = time.time, token_lifetime_sec: int = 3600
    ) -> None:
        self._clock = clock
        self._lifetime = token_lifetime_sec
        self._users: dict[UUID, _FakeUser] = {}
        self._by_alias: dict[str, UUID] = {}
        self._access: dict[str, UUID] = {}
        self._refresh: dict[str, UUID] = {}
        self._scripted: dict[str, list[Exception]] = {}
        self.calls: list[str] = []

    def __repr__(self) -> str:
        return "FakeSupabaseAuth(<redacted>)"

    # -- test controls -------------------------------------------------------------------------

    def script_failure(self, operation: str, error: Exception, times: int = 1) -> None:
        self._scripted.setdefault(operation, []).extend([error] * times)

    def has_user(self, user_id: UUID) -> bool:
        return user_id in self._users

    def user_count(self) -> int:
        return len(self._users)

    def alias_of(self, user_id: UUID) -> str:
        return self._users[user_id].alias

    def password_matches(self, user_id: UUID, password: str) -> bool:
        return user_id in self._users and hmac.compare_digest(
            self._users[user_id].password.encode("utf-8", "surrogatepass"),
            password.encode("utf-8", "surrogatepass"),
        )

    def expire_access_tokens(self) -> None:
        """Forget every access token (as if all had expired); refresh tokens keep working."""
        self._access.clear()

    def revoke_refresh_tokens(self) -> None:
        """Forget every refresh token (as if the provider had ended all sessions)."""
        self._refresh.clear()

    # -- operations ----------------------------------------------------------------------------

    def _enter(self, operation: str) -> None:
        self.calls.append(operation)
        pending = self._scripted.get(operation)
        if pending:
            raise pending.pop(0)

    def _issue(self, user_id: UUID) -> AuthTokens:
        access = "fake-access-" + secrets.token_hex(12)
        refresh = "fake-refresh-" + secrets.token_hex(12)
        self._access[access] = user_id
        self._refresh[refresh] = user_id
        return AuthTokens(access, refresh, int(self._clock()) + self._lifetime)

    def create_user(self, alias: str, password: str) -> UUID:
        self._enter("create_user")
        if alias in self._by_alias:
            raise AuthRequestRejected()
        user_id = uuid4()
        self._users[user_id] = _FakeUser(user_id, alias, password)
        self._by_alias[alias] = user_id
        return user_id

    def password_grant(self, alias: str, password: str) -> AuthTokens:
        self._enter("password_grant")
        user_id = self._by_alias.get(alias)
        if user_id is None or not self.password_matches(user_id, password):
            raise AuthInvalidCredentials()
        return self._issue(user_id)

    def refresh(self, refresh_token: str) -> AuthTokens:
        self._enter("refresh")
        user_id = self._refresh.pop(refresh_token, None)
        if user_id is None or user_id not in self._users:
            raise AuthRefreshRejected()
        return self._issue(user_id)

    def admin_set_password(self, user_id: UUID, new_password: str) -> None:
        self._enter("admin_set_password")
        if user_id not in self._users:
            raise AuthRequestRejected()
        self._users[user_id].password = new_password

    def change_password(self, access_token: str, new_password: str) -> None:
        self._enter("change_password")
        user_id = self._access.get(access_token)
        if user_id is None or user_id not in self._users:
            raise AuthRequestRejected()
        self._users[user_id].password = new_password

    def admin_delete_user(self, user_id: UUID) -> None:
        self._enter("admin_delete_user")
        user = self._users.pop(user_id, None)
        if user is not None:
            self._by_alias.pop(user.alias, None)
        for registry in (self._access, self._refresh):
            for token in [t for t, owner in registry.items() if owner == user_id]:
                del registry[token]
