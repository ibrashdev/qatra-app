"""E10 ``POST /api/auth/logout`` (API-spec §4.2, O-14): ends the current session, answers 204 and
clears the cookie, and is TOLERANT: a missing, malformed, unknown or revoked session still gets
204, so that a logout that was pending offline can finish."""

from __future__ import annotations

import pytest

from app.repositories.accounts import RepositoryUnavailable
from app.routers.auth import RateLimits
from tests.auth.auth_support import (
    USERNAME,
    FakeClock,
    FlakyStore,
    Harness,
    build_harness,
    error_of,
    login,
    register,
    session_cookie,
    user_id_of,
)

CLEARED = "qatra_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"


def logout(client, **kwargs):  # type: ignore[no-untyped-def]
    return client.post("/api/auth/logout", **kwargs)


def test_logout_ends_the_session_clears_the_cookie_and_answers_204(signed_in: Harness) -> None:
    cookie = signed_in.client.cookies.get("qatra_session")
    response = logout(signed_in.client)
    assert response.status_code == 204 and response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert session_cookie(response) == CLEARED
    assert signed_in.store.live_session_count(user_id_of(signed_in)) == 0
    replay = signed_in.new_client()
    replay.cookies.set("qatra_session", cookie)  # the cookie value itself is dead now
    assert replay.get("/api/me").status_code == 401


def test_other_sessions_of_the_account_are_not_touched(signed_in: Harness) -> None:
    other = signed_in.new_client()
    login(other)
    assert logout(signed_in.client).status_code == 204
    assert other.get("/api/me").status_code == 200
    assert signed_in.store.live_session_count(user_id_of(signed_in)) == 1


def test_logout_is_idempotent(signed_in: Harness) -> None:
    for _ in range(3):
        response = logout(signed_in.client)
        assert response.status_code == 204 and session_cookie(response) == CLEARED


@pytest.mark.parametrize(
    "cookie",
    [None, "", "garbage", "A" * 43, "A" * 42 + "=", "x" * 5000],
    ids=["none", "empty", "garbage", "unknown but well formed", "padded", "huge"],
)
def test_a_missing_or_invalid_session_still_gets_204_and_a_cleared_cookie(
    harness: Harness, cookie: str | None
) -> None:
    client = harness.new_client()
    if cookie is not None:
        client.cookies.set("qatra_session", cookie)
    response = logout(client)
    assert response.status_code == 204 and response.content == b""
    assert session_cookie(response) == CLEARED


def test_an_expired_or_revoked_session_still_gets_204(signed_in: Harness) -> None:
    signed_in.clock.advance(days=31)
    assert logout(signed_in.client).status_code == 204
    other = build_harness()
    with other.client:
        register(other.client)
        other.store.bump_auth_epoch(user_id_of(other))  # every session revoked
        assert logout(other.client).status_code == 204


def test_a_body_is_ignored(signed_in: Harness) -> None:
    for kwargs in ({"json": {}}, {"json": {"anything": 1}}, {"content": b"not even json"}):
        assert logout(signed_in.new_client(), **kwargs).status_code == 204


def test_logout_needs_the_frontend_origin_and_revokes_nothing_without_it(
    signed_in: Harness,
) -> None:
    for headers in ({"Origin": "https://evil.example"}, {"Origin": ""}):
        response = logout(signed_in.client, headers=headers)
        assert response.status_code == 403 and error_of(response)["code"] == "forbidden_origin"
        assert "set-cookie" not in response.headers
    stranger = signed_in.new_client()
    stranger.headers.pop("Origin")
    assert logout(stranger).status_code == 403
    assert signed_in.store.live_session_count(user_id_of(signed_in)) == 1


def test_a_storage_failure_is_503_and_the_logout_can_be_repeated() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        store.script("revoke_app_session", RepositoryUnavailable())
        failed = logout(harness.client)
        assert failed.status_code == 503 and error_of(failed)["code"] == "unavailable"
        assert store.live_session_count(user_id_of(harness)) == 1  # not revoked yet
        assert logout(harness.client).status_code == 204
        assert store.live_session_count(user_id_of(harness)) == 0


def test_logout_stays_available_when_the_terms_are_outdated(signed_in: Harness) -> None:
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    assert login(client, USERNAME).json()["reconsentRequired"] is True
    gated = client.patch("/api/me", json={"language": "en"})
    assert gated.status_code == 400 and error_of(gated)["code"] == "terms_required"
    assert logout(client).status_code == 204
    assert client.get("/api/me").status_code == 401


def test_logout_is_a_session_write_for_the_per_ip_limit() -> None:
    harness = build_harness(rate_limits=RateLimits(session_write_per_min=2))
    with harness.client:
        assert logout(harness.client).status_code == 204
        assert logout(harness.client).status_code == 204
        limited = logout(harness.client)
        assert limited.status_code == 429 and error_of(limited)["code"] == "throttled"
