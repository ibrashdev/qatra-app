"""Helpers for the authentication tests (B3). Synthetic data only: every name, password, code
and key below is made up or generated for the test run; nothing is a real secret.

``build_harness`` wires ``create_app`` + ``install_auth`` in memory mode with a controllable
clock: the in-memory store plays the database ``now()``, the fake identity provider shares the
same clock, and the throttle's monotonic clock is a separate fake. ``Harness.client`` carries the
frontend ``Origin`` header like a browser; ``Harness.new_client`` gives another browser (its own
cookie jar) against the same application; ``Harness.restart`` is a new process over the same
data (what a deployment is: sessions survive, memory-only state starts empty).

Testing personas (Role 6 verification; they invent no production role and grant no permission:
the only roles of B3 are the approved access levels of API-spec §2.1)

=====================  ============  ===========================  ===============================
Persona                Level         Account ownership            Precondition
=====================  ============  ===========================  ===============================
Visitor                A (anonymous) none                         no cookie
Learner                S (session)   ``sample_user_01`` only      registered, cookie on a client
Second learner         S (session)   ``second_user`` only         registered on another client
Demo account           S (session)   ``demo_learner``, is_demo    ``AuthService.register_account``
                                                                  with ``is_demo=True`` (E26 is
                                                                  another package)
Learner, terms         S, gated      ``sample_user_01``           ``Harness.restart`` with a new
outdated                                                          ``TERMS_VERSION``, then login
Locked-out caller      A (anonymous) a username and/or an         20 failed attempts inside 15 min
                                     address prefix
Holder of an ended     none          n/a                          cookie of a revoked, expired,
session                                                           epoch-stale or garbled session
=====================  ============  ===========================  ===============================

Allowed and denied, with the expected outcome (every other test file exercises the details):

- Visitor: allowed E03, E04, E06, E07 and the tolerant E10 (204). Denied E05, E08, E09, E11, E12
  and E13: ``401 unauthenticated`` with the cookie cleared.
- Learner and demo account: allowed E05, E08-E13 on their OWN account only; no operation accepts
  an account identifier, so another account cannot even be addressed. A wrong current password on
  E08, E09 and E13 is ``401 invalid_credentials`` and counts against the throttle.
- Second learner: every operation of the learner leaves this account untouched (test_isolation).
- Learner with outdated terms: allowed E05, E10 and E11; every other session operation is
  ``400 terms_required`` with ``details.requiredVersion``.
- Locked-out caller: ``429 throttled`` with ``Retry-After`` even for a correct password.
- Holder of an ended session: ``401`` everywhere except E10, which still answers 204.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers.supabase_auth import FakeSupabaseAuth
from app.repositories.accounts import InMemoryAccounts
from app.routers.auth import RateLimits, install_auth
from app.services.auth import AuthService, SessionService
from tests.support import FRONTEND_ORIGIN, make_settings, random_key_b64

ORIGIN = FRONTEND_ORIGIN
TERMS = "2026-10-04"
USERNAME = "sample_user_01"
PASSWORD = "synthetic passphrase for tests only"
NEW_PASSWORD = "another synthetic passphrase for tests"
CLIENT_ADDRESS = "203.0.113.9"
START = datetime(2026, 10, 4, 8, 15, tzinfo=UTC)
UNLIMITED = RateLimits(100_000, 100_000, 100_000)


class FakeClock:
    """A settable wall clock (database ``now()`` and the provider's token clock)."""

    def __init__(self, start: datetime = START) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def seconds(self) -> float:
        return self.now.timestamp()

    def advance(self, **kwargs: float) -> None:
        self.now += timedelta(**kwargs)


class FakeMonotonic:
    """The throttle's monotonic clock."""

    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class FlakyStore(InMemoryAccounts):
    """The in-memory store with scripted failures: ``script("register_account", error)`` makes
    the next call of that method raise ``error`` (several times with ``times``)."""

    def __init__(self, **kwargs: Any) -> None:
        self._scripted: dict[str, list[Exception]] = {}
        super().__init__(**kwargs)

    def script(self, method: str, error: Exception, times: int = 1) -> None:
        self._scripted.setdefault(method, []).extend([error] * times)

    def __getattribute__(self, name: str) -> Any:
        attribute = super().__getattribute__(name)
        if name.startswith("_") or not callable(attribute):
            return attribute
        scripted = super().__getattribute__("_scripted")
        if scripted.get(name):
            error = scripted[name].pop(0)

            def fail(*args: Any, **kwargs: Any) -> Any:
                raise error

            return fail
        return attribute


@dataclass
class Harness:
    app: FastAPI
    client: TestClient
    store: InMemoryAccounts
    provider: FakeSupabaseAuth
    clock: FakeClock
    monotonic: FakeMonotonic
    settings: Settings
    overrides: dict[str, Any]
    address: str = CLIENT_ADDRESS
    recovery_code: str = ""

    def restart(self, **new_overrides: Any) -> Harness:
        """A new application process over the SAME store, identity provider, clock and keys:
        what survives a restart survives (sessions, accounts); what lives in process memory
        (throttle delays, the consent memo, rate-limit windows) starts empty. Overrides replace
        settings, e.g. ``TERMS_VERSION`` after a terms change."""
        return build_harness(
            store=self.store,
            provider=self.provider,
            clock=self.clock,
            address=self.address,
            **{**self.overrides, **new_overrides},
        )

    @property
    def cookie_name(self) -> str:
        return "__Host-qatra_session" if self.settings.APP_ENV == "production" else "qatra_session"

    @property
    def auth(self) -> AuthService:
        service: AuthService = self.app.state.auth_service
        return service

    @property
    def sessions(self) -> SessionService:
        service: SessionService = self.app.state.session_resolver
        return service

    def new_client(self, address: str = CLIENT_ADDRESS) -> TestClient:
        return TestClient(self.app, headers={"Origin": ORIGIN}, client=(address, 50000))

    def advance(self, **kwargs: float) -> None:
        """Move the database clock and the throttle clock by the same time."""
        self.clock.advance(**kwargs)
        seconds = timedelta(**kwargs).total_seconds()
        self.monotonic.advance(seconds)


def registration(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "username": USERNAME,
        "password": PASSWORD,
        "timeZone": "Asia/Dubai",
        "language": "ar",
        "termsAccepted": True,
        "termsVersion": TERMS,
    }
    body.update(overrides)
    return body


def post_raw_json(client: TestClient, path: str, raw: bytes) -> httpx.Response:
    """POST bytes as JSON: for bodies the ``json=`` encoder of httpx refuses to produce (a lone
    surrogate written as a ``\\ud800`` escape), which a hostile client can still send."""
    return client.post(path, content=raw, headers={"Content-Type": "application/json"})


def register(client: TestClient, **overrides: Any) -> httpx.Response:
    return client.post("/api/auth/register", json=registration(**overrides))


def login(client: TestClient, username: str = USERNAME, password: str = PASSWORD) -> httpx.Response:
    return client.post("/api/auth/login", json={"username": username, "password": password})


def verify_recovery(client: TestClient, code: str, username: str = USERNAME) -> httpx.Response:
    return client.post(
        "/api/auth/recovery/verify", json={"username": username, "recoveryCode": code}
    )


def reset_password(
    client: TestClient, grant: str, new_password: str = NEW_PASSWORD
) -> httpx.Response:
    return client.post(
        "/api/auth/recovery/reset", json={"resetGrant": grant, "newPassword": new_password}
    )


def rotate_recovery(client: TestClient, password: str = PASSWORD) -> httpx.Response:
    return client.post("/api/auth/recovery/rotate", json={"password": password})


def change_password(
    client: TestClient, current: str = PASSWORD, new: str = NEW_PASSWORD
) -> httpx.Response:
    return client.post("/api/auth/password", json={"currentPassword": current, "newPassword": new})


def session_cookie(response: httpx.Response) -> str:
    """The raw ``Set-Cookie`` header (the single cookie of a response)."""
    headers = response.headers.get_list("set-cookie")
    assert len(headers) == 1, headers
    return headers[0]


def cookie_value(response: httpx.Response) -> str:
    return session_cookie(response).split(";", 1)[0].split("=", 1)[1]


def error_of(response: httpx.Response) -> dict[str, Any]:
    body: dict[str, Any] = response.json()["error"]
    return body


def fields_of(response: httpx.Response) -> list[tuple[str, str]]:
    """``(field, rule)`` pairs of a ``validation_error`` response."""
    return [(item["field"], item["rule"]) for item in error_of(response)["details"]["fields"]]


def build_harness(
    *,
    rate_limits: RateLimits = UNLIMITED,
    address: str = CLIENT_ADDRESS,
    store: InMemoryAccounts | None = None,
    provider: FakeSupabaseAuth | None = None,
    clock: FakeClock | None = None,
    **setting_overrides: Any,
) -> Harness:
    for name in (
        "QATRA_SESSION_KEY",
        "QATRA_SESSION_HMAC_KEY",
        "QATRA_RECOVERY_HMAC_KEY",
        "QATRA_THROTTLE_HMAC_KEY",
    ):
        setting_overrides.setdefault(name, random_key_b64())
    settings = make_settings(**setting_overrides)
    app = create_app(settings)
    fake_clock = clock or FakeClock()
    monotonic = FakeMonotonic()
    memory = store or InMemoryAccounts(clock=fake_clock)
    identity = provider or FakeSupabaseAuth(clock=fake_clock.seconds)
    install_auth(
        app,
        settings,
        repository=memory,
        profiles=memory,
        provider=identity,
        clock=fake_clock,
        monotonic=monotonic,
        rate_limits=rate_limits,
    )
    client = TestClient(app, headers={"Origin": ORIGIN}, client=(address, 50000))
    return Harness(
        app,
        client,
        memory,
        identity,
        fake_clock,
        monotonic,
        settings,
        dict(setting_overrides),
        address,
    )


def user_id_of(harness: Harness, username: str = USERNAME) -> Any:
    from app.domain.auth_policy import normalize_username

    handle = harness.store.find_handle(normalize_username(username))
    assert handle is not None
    return handle.user_id


def jwt_like(payload: dict[str, Any]) -> str:
    """An unsigned token shaped like a JWT, for the PostgREST tests."""

    def part(data: dict[str, Any]) -> str:
        raw = json.dumps(data).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{part({'alg': 'none'})}.{part(payload)}.signature"
