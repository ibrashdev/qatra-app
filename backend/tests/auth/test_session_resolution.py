"""``require_session`` and its variants (API-spec §1.3, O-10, O-14): the cookie is resolved through
the restricted role; a missing, revoked, expired or epoch-stale session is ``401 unauthenticated``
(and the response clears the cookie); the Supabase access token is refreshed server-side; the
re-consent gate answers ``400 terms_required`` for everything but E05, E10 and E11."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import fields
from typing import Annotated, Any
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.dependencies import (
    SessionContext,
    require_session,
    require_session_allow_reconsent,
    require_valid_origin,
)
from app.providers.supabase_auth import AuthProviderUnavailable, AuthTokens, FakeSupabaseAuth
from app.repositories.accounts import ProfileUnavailable, RepositoryUnavailable
from app.services.session_crypto import TokenBundle
from tests.auth.auth_support import (
    FakeClock,
    FlakyStore,
    Harness,
    build_harness,
    error_of,
    login,
    register,
    user_id_of,
)

CLEARED_PREFIX = "qatra_session=; "


def add_probes(app: FastAPI) -> None:
    @app.get("/api/_test/whoami")
    def whoami(context: Annotated[SessionContext, Depends(require_session)]) -> dict[str, Any]:
        return describe(context)

    @app.get("/api/_test/whoami-reconsent")
    def whoami_reconsent(
        context: Annotated[SessionContext, Depends(require_session_allow_reconsent)],
    ) -> dict[str, Any]:
        return describe(context)

    @app.post(
        "/api/_test/mutate",
        dependencies=[Depends(require_valid_origin), Depends(require_session)],
    )
    def mutate() -> dict[str, bool]:
        return {"ok": True}


def describe(context: SessionContext) -> dict[str, Any]:
    return {
        "userId": str(context.user_id),
        "isDemo": context.is_demo,
        "epoch": context.auth_epoch,
        "sessionId": str(context.session_id),
        "token": context.access_token.get_secret_value() if context.access_token else None,
    }


@pytest.fixture
def probed(signed_in: Harness) -> Harness:
    add_probes(signed_in.app)
    return signed_in


def stored_tokens(harness: Harness) -> TokenBundle:
    user_id = user_id_of(harness)
    (blob,) = harness.store.stored_tokens(user_id)[-1:]
    return harness.auth._crypto.decrypt_tokens(blob, user_id)


# --- the session itself ---------------------------------------------------------------------------


def test_a_live_session_yields_the_identity_of_the_account(probed: Harness) -> None:
    response = probed.client.get("/api/_test/whoami")
    assert response.status_code == 200
    body = response.json()
    assert body["userId"] == str(user_id_of(probed))
    assert (body["isDemo"], body["epoch"]) == (False, 0)
    assert UUID(body["sessionId"])
    assert body["token"] is None  # memory mode: no Supabase token is exposed


@pytest.mark.parametrize(
    "value",
    [None, "", "garbage", "A" * 43, "A" * 42 + "=", "x" * 3000],
    ids=["missing", "empty", "garbage", "unknown", "padded", "huge"],
)
def test_a_missing_or_invalid_cookie_is_401_and_clears_the_cookie(
    probed: Harness, value: str | None
) -> None:
    client = probed.new_client()
    if value is not None:
        client.cookies.set("qatra_session", value)
    response = client.get("/api/_test/whoami")
    assert response.status_code == 401
    assert error_of(response)["code"] == "unauthenticated"
    assert response.headers["set-cookie"].startswith(CLEARED_PREFIX)
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert response.headers["cache-control"] == "no-store"


def test_an_expired_session_is_401(probed: Harness) -> None:
    probed.clock.advance(days=29)
    assert probed.client.get("/api/_test/whoami").status_code == 200
    probed.clock.advance(days=1, seconds=1)
    response = probed.client.get("/api/_test/whoami")
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"


def test_a_revoked_session_is_401(probed: Harness) -> None:
    assert probed.client.post("/api/auth/logout").status_code == 204
    assert probed.client.get("/api/_test/whoami").status_code == 401


def test_a_session_of_a_stale_epoch_is_401_even_if_it_was_never_revoked(probed: Harness) -> None:
    user_id = user_id_of(probed)
    probed.store._handles[user_id].epoch += 1  # the epoch moves; the session row is untouched
    assert probed.store.session_count(user_id) == 1
    response = probed.client.get("/api/_test/whoami")
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"


def test_a_password_change_or_reset_ends_other_sessions_through_the_epoch(probed: Harness) -> None:
    other = probed.new_client()
    login(other)
    assert other.get("/api/_test/whoami").status_code == 200
    probed.store.bump_auth_epoch(user_id_of(probed))
    assert other.get("/api/_test/whoami").status_code == 401


def test_identity_comes_from_the_cookie_only(probed: Harness) -> None:
    other = probed.new_client()
    other_id = uuid4()
    anonymous = other.get(
        "/api/_test/whoami",
        params={"userId": str(other_id), "isDemo": "true"},
        headers={
            "Authorization": "Bearer abc.def.ghi",
            "X-User-Id": str(other_id),
            "X-Forwarded-User": "someone",
        },
    )
    assert anonymous.status_code == 401
    forged = probed.client.get(
        "/api/_test/whoami",
        params={"userId": str(other_id), "isDemo": "true"},
        headers={"X-User-Id": str(other_id), "Authorization": "Bearer x"},
    )
    assert forged.status_code == 200
    assert forged.json()["userId"] == str(user_id_of(probed)) and forged.json()["isDemo"] is False


def test_each_cookie_resolves_to_its_own_account(harness: Harness) -> None:
    add_probes(harness.app)
    register(harness.client, username="first_user")
    second = harness.new_client()
    register(second, username="second_user")
    first_id = harness.client.get("/api/_test/whoami").json()["userId"]
    second_id = second.get("/api/_test/whoami").json()["userId"]
    assert first_id != second_id


def test_a_mutation_checks_the_origin_before_the_session(probed: Harness) -> None:
    client = probed.new_client()
    bad = client.post("/api/_test/mutate", headers={"Origin": "https://evil.example"})
    assert bad.status_code == 403 and error_of(bad)["code"] == "forbidden_origin"
    good = client.post("/api/_test/mutate")  # no cookie
    assert good.status_code == 401 and error_of(good)["code"] == "unauthenticated"
    assert probed.client.post("/api/_test/mutate").status_code == 200


def test_without_an_installed_resolver_the_dependency_still_always_denies() -> None:
    from app.main import create_app
    from tests.support import make_settings

    app = create_app(make_settings())
    del app.state.session_resolver  # create_app installs one; this is the B0 state
    add_probes(app)
    with TestClient(app) as client:
        client.cookies.set("qatra_session", "A" * 43)
        response = client.get("/api/_test/whoami")
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"
    assert "set-cookie" not in response.headers  # the B0 behaviour is unchanged


def test_the_session_context_keeps_its_documented_fields() -> None:
    assert [f.name for f in fields(SessionContext)] == [
        "user_id",
        "is_demo",
        "auth_epoch",
        "session_id",
        "access_token",
    ]


# --- supabase mode exposes the learner's token to repositories ------------------------------------


def test_in_supabase_mode_the_context_carries_the_current_access_token() -> None:
    harness = build_harness(QATRA_DATA_BACKEND="supabase")
    add_probes(harness.app)
    with harness.client:
        register(harness.client)
        body = harness.client.get("/api/_test/whoami").json()
        tokens = stored_tokens(harness)
        assert body["token"] == tokens.access and tokens.access.startswith("fake-access-")
        # the token is excluded from repr and from comparisons
        context = harness.sessions.resolve(
            harness.client.cookies.get("qatra_session"), enforce_terms=False
        ).context
        assert tokens.access not in repr(context)
        assert context.access_token is not None
        clone = SessionContext(
            context.user_id, context.is_demo, context.auth_epoch, context.session_id
        )
        assert clone == context


# --- refresh --------------------------------------------------------------------------------------


def test_a_token_that_is_valid_for_longer_than_a_minute_is_not_refreshed(probed: Harness) -> None:
    probed.clock.advance(minutes=58)
    assert probed.client.get("/api/_test/whoami").status_code == 200
    assert "refresh" not in probed.provider.calls


def test_a_token_expiring_within_a_minute_is_refreshed_and_the_rotation_is_stored(
    probed: Harness,
) -> None:
    before = stored_tokens(probed)
    probed.clock.advance(minutes=59, seconds=1)  # 59 s left
    assert probed.client.get("/api/_test/whoami").status_code == 200
    assert probed.provider.calls.count("refresh") == 1
    after = stored_tokens(probed)
    assert (after.access, after.refresh) != (before.access, before.refresh)
    assert after.exp == int(probed.clock.seconds()) + 3600
    assert probed.client.get("/api/_test/whoami").status_code == 200
    assert probed.provider.calls.count("refresh") == 1  # the new token is good for an hour


def test_the_refresh_margin_is_sixty_seconds_inclusive(probed: Harness) -> None:
    probed.clock.advance(minutes=59)  # exactly 60 s left
    probed.client.get("/api/_test/whoami")
    assert probed.provider.calls.count("refresh") == 1


def test_an_expired_token_is_refreshed_too(probed: Harness) -> None:
    probed.clock.advance(hours=3)
    assert probed.client.get("/api/_test/whoami").status_code == 200
    assert probed.provider.calls.count("refresh") == 1


def test_in_supabase_mode_the_request_after_a_refresh_sees_the_rotated_token() -> None:
    harness = build_harness(QATRA_DATA_BACKEND="supabase")
    add_probes(harness.app)
    with harness.client:
        register(harness.client)
        first = harness.client.get("/api/_test/whoami").json()["token"]
        harness.clock.advance(minutes=59, seconds=30)
        second = harness.client.get("/api/_test/whoami").json()["token"]
        assert second != first and second == stored_tokens(harness).access


def test_a_refresh_the_provider_rejects_ends_the_session(probed: Harness) -> None:
    probed.provider.revoke_refresh_tokens()
    probed.clock.advance(minutes=59, seconds=30)
    response = probed.client.get("/api/_test/whoami")
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"
    assert response.headers["set-cookie"].startswith(CLEARED_PREFIX)
    assert probed.store.live_session_count(user_id_of(probed)) == 0  # revoked, not just refused
    assert probed.client.get("/api/me").status_code == 401


def test_a_provider_outage_during_refresh_is_503_and_does_not_end_the_session(
    probed: Harness,
) -> None:
    probed.clock.advance(minutes=59, seconds=30)
    probed.provider.script_failure("refresh", AuthProviderUnavailable())
    response = probed.client.get("/api/_test/whoami")
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    assert "set-cookie" not in response.headers  # a connectivity state is never a log-out
    assert probed.store.live_session_count(user_id_of(probed)) == 1
    assert probed.client.get("/api/_test/whoami").status_code == 200  # the provider is back


def test_the_rotated_tokens_are_written_twice_if_the_first_write_fails() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    add_probes(harness.app)
    with harness.client:
        register(harness.client)
        clock.advance(minutes=59, seconds=30)
        store.script("update_session_tokens", RepositoryUnavailable())
        assert harness.client.get("/api/_test/whoami").status_code == 200
        clock.advance(minutes=59, seconds=30)
        store.script("update_session_tokens", RepositoryUnavailable(), times=2)
        response = harness.client.get("/api/_test/whoami")
        assert response.status_code == 503 and error_of(response)["code"] == "unavailable"


class SlowRefresh(FakeSupabaseAuth):
    """A provider whose refresh takes a while, so that every request arrives while the first
    one is still refreshing (a fast fake would let the requests run one after the other)."""

    def refresh(self, refresh_token: str) -> AuthTokens:
        time.sleep(0.15)
        return super().refresh(refresh_token)


def test_simultaneous_requests_refresh_the_token_once() -> None:
    clock = FakeClock()
    provider = SlowRefresh(clock=clock.seconds)
    harness = build_harness(clock=clock, provider=provider)
    with harness.client:
        register(harness.client)
        cookie = harness.client.cookies.get("qatra_session")
        clock.advance(minutes=59, seconds=30)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(
                pool.map(
                    lambda _: harness.sessions.resolve(cookie, enforce_terms=False).tokens.access,
                    range(8),
                )
            )
        # one refresh token was spent, not eight; every request got the rotated token
        assert provider.calls.count("refresh") == 1
        assert len(set(results)) == 1
        assert results[0] == stored_tokens(harness).access


# --- stored tokens --------------------------------------------------------------------------------


def test_a_blob_that_does_not_decrypt_ends_the_session(probed: Harness) -> None:
    user_id = user_id_of(probed)
    (session,) = probed.store._sessions.values()
    blob = bytearray(session.blob)
    blob[20] ^= 0x01
    session.blob = bytes(blob)
    response = probed.client.get("/api/_test/whoami")
    assert response.status_code == 401 and response.headers["set-cookie"].startswith(CLEARED_PREFIX)
    assert probed.store.live_session_count(user_id) == 0


def test_a_blob_copied_to_another_accounts_session_does_not_decrypt(harness: Harness) -> None:
    add_probes(harness.app)
    register(harness.client, username="first_user")
    second = harness.new_client()
    register(second, username="second_user")
    first_id, second_id = user_id_of(harness, "first_user"), user_id_of(harness, "second_user")
    sessions = {s.user_id: s for s in harness.store._sessions.values()}
    sessions[second_id].blob = sessions[first_id].blob  # an attacker with database write access
    assert second.get("/api/_test/whoami").status_code == 401
    assert harness.client.get("/api/_test/whoami").status_code == 200  # the original is fine


def test_the_database_holds_no_token_in_the_clear(probed: Harness) -> None:
    tokens = stored_tokens(probed)
    for blob in probed.store.stored_tokens(user_id_of(probed)):
        assert tokens.access.encode() not in blob and tokens.refresh.encode() not in blob


# --- the re-consent gate --------------------------------------------------------------------------


def outdated(harness: Harness) -> tuple[Harness, TestClient]:
    changed = harness.restart(TERMS_VERSION="2026-12-01")
    add_probes(changed.app)
    client = changed.new_client()
    assert login(client).json()["reconsentRequired"] is True
    return changed, client


def test_while_the_terms_are_outdated_session_operations_answer_terms_required(
    signed_in: Harness,
) -> None:
    changed, client = outdated(signed_in)
    for method, path in [
        ("GET", "/api/_test/whoami"),
        ("POST", "/api/_test/mutate"),
        ("PATCH", "/api/me"),
        ("POST", "/api/auth/recovery/rotate"),
        ("POST", "/api/auth/password"),
        ("POST", "/api/account/delete"),
    ]:
        response = client.request(method, path, json={})
        assert response.status_code == 400, path
        assert error_of(response)["code"] == "terms_required", path
        assert error_of(response)["details"] == {"requiredVersion": "2026-12-01"}, path
        assert "set-cookie" not in response.headers


def test_the_exceptions_are_consent_logout_and_the_profile_read(signed_in: Harness) -> None:
    changed, client = outdated(signed_in)
    assert client.get("/api/me").status_code == 200  # E11
    assert client.get("/api/_test/whoami-reconsent").status_code == 200  # the variant
    consented = client.post("/api/auth/consent", json={"termsVersion": "2026-12-01"})
    assert consented.status_code == 200  # E05
    assert client.get("/api/_test/whoami").status_code == 200  # the gate is open now
    assert client.post("/api/auth/logout").status_code == 204  # E10 (tolerant, never gated)


def test_logout_works_while_gated(signed_in: Harness) -> None:
    changed, client = outdated(signed_in)
    assert client.post("/api/auth/logout").status_code == 204


def test_an_invalid_session_is_401_not_terms_required(signed_in: Harness) -> None:
    changed, _ = outdated(signed_in)
    response = changed.new_client().get("/api/_test/whoami")
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"


def test_the_gate_reads_the_profile_once_per_account_while_the_account_is_current(
    signed_in: Harness,
) -> None:
    reads: list[UUID] = []
    original = signed_in.store.read_terms_version
    signed_in.store.read_terms_version = (  # type: ignore[method-assign]
        lambda **kwargs: (reads.append(kwargs["user_id"]), original(**kwargs))[1]
    )
    add_probes(signed_in.app)
    for _ in range(3):
        assert signed_in.client.get("/api/_test/whoami").status_code == 200
    assert reads == []  # registration already showed the account to be current

    restarted = signed_in.restart()  # a new process: the memo starts empty
    add_probes(restarted.app)
    client = restarted.new_client()
    login(client)  # reading the profile at login also shows it to be current
    for _ in range(3):
        assert client.get("/api/_test/whoami").status_code == 200
    assert reads == []


def test_a_fresh_process_checks_the_terms_version_once_then_remembers() -> None:
    first = build_harness()
    with first.client:
        register(first.client)
        cookie = first.client.cookies.get("qatra_session")
    second = first.restart()
    add_probes(second.app)
    reads: list[Any] = []
    original = second.store.read_terms_version
    second.store.read_terms_version = (  # type: ignore[method-assign]
        lambda **kwargs: (reads.append(1), original(**kwargs))[1]
    )
    client = second.new_client()
    client.cookies.set("qatra_session", cookie)
    for _ in range(4):
        assert client.get("/api/_test/whoami").status_code == 200
    assert len(reads) == 1


def test_an_account_that_has_not_consented_is_checked_on_every_request(signed_in: Harness) -> None:
    changed, client = outdated(signed_in)
    reads: list[Any] = []
    original = changed.store.read_terms_version
    changed.store.read_terms_version = (  # type: ignore[method-assign]
        lambda **kwargs: (reads.append(1), original(**kwargs))[1]
    )
    for _ in range(3):
        assert client.get("/api/_test/whoami").status_code == 400
    assert len(reads) == 3
    client.post("/api/auth/consent", json={"termsVersion": "2026-12-01"})
    reads.clear()
    for _ in range(3):
        assert client.get("/api/_test/whoami").status_code == 200
    assert reads == []  # once current, always current for this process


def test_a_profile_that_cannot_be_read_makes_the_gate_503_not_open() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    first = build_harness(store=store, clock=clock)
    with first.client:
        register(first.client)
        cookie = first.client.cookies.get("qatra_session")
    second = first.restart()  # a new process: the memo is empty, so the gate must read
    add_probes(second.app)
    store.script("read_terms_version", ProfileUnavailable())
    client = second.new_client()
    client.cookies.set("qatra_session", cookie)
    response = client.get("/api/_test/whoami")
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    assert client.get("/api/_test/whoami").status_code == 200  # and it opens once it can read
