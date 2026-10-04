"""E09 ``POST /api/auth/password`` (API-spec §4.2, C-02, O-14): the password changes with the
learner's OWN Supabase token, ``auth_epoch`` increments, every other session ends, and the caller
gets a new session bound to the new epoch (no re-login)."""

from __future__ import annotations

from typing import Any

import pytest

from app.providers.supabase_auth import AuthProviderUnavailable
from app.repositories.accounts import ProfileUnavailable, RepositoryUnavailable
from app.routers.auth import RateLimits
from tests.auth.auth_support import (
    NEW_PASSWORD,
    PASSWORD,
    USERNAME,
    FakeClock,
    FlakyStore,
    Harness,
    build_harness,
    change_password,
    cookie_value,
    error_of,
    fields_of,
    login,
    register,
    session_cookie,
    user_id_of,
)

WRONG = "a wrong passphrase of enough length"


def test_the_password_changes_and_the_caller_keeps_a_working_session(signed_in: Harness) -> None:
    client = signed_in.client
    before = client.cookies.get("qatra_session")
    response = change_password(client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"profile"} and body["profile"]["username"] == "sample_user_01"
    assert cookie_value(response) != before  # a NEW cookie
    assert "Max-Age=2592000" in session_cookie(response)
    assert client.get("/api/me").status_code == 200  # the new cookie works at once
    assert login(signed_in.new_client(), password=PASSWORD).status_code == 401
    assert login(signed_in.new_client(), password=NEW_PASSWORD).status_code == 200


def test_the_epoch_increments_and_only_the_new_session_survives(signed_in: Harness) -> None:
    other = signed_in.new_client()
    login(other)
    stale = signed_in.client.cookies.get("qatra_session")
    user_id = user_id_of(signed_in)
    assert signed_in.store.live_session_count(user_id) == 2
    change_password(signed_in.client)
    assert signed_in.store.epoch_of(user_id) == 1
    assert signed_in.store.live_session_count(user_id) == 1
    unauthenticated = other.get("/api/me")  # the other device is out
    assert unauthenticated.status_code == 401
    assert error_of(unauthenticated)["code"] == "unauthenticated"
    replay = signed_in.new_client()
    replay.cookies.set("qatra_session", stale)  # the old cookie of the caller is dead too
    assert replay.get("/api/me").status_code == 401
    assert signed_in.client.get("/api/me").status_code == 200


def test_the_change_is_made_with_the_learners_own_token_not_the_admin_api(
    signed_in: Harness,
) -> None:
    change_password(signed_in.client)
    assert "change_password" in signed_in.provider.calls
    assert "admin_set_password" not in signed_in.provider.calls
    assert signed_in.provider.password_matches(user_id_of(signed_in), NEW_PASSWORD)


def test_an_expired_access_token_is_refreshed_before_the_change(signed_in: Harness) -> None:
    signed_in.provider.expire_access_tokens()  # the stored access token is no longer valid there
    signed_in.clock.advance(minutes=59, seconds=30)  # ... and is about to expire here
    assert change_password(signed_in.client).status_code == 200
    calls = signed_in.provider.calls
    assert calls.index("refresh") < calls.index("change_password")


def test_the_new_session_keeps_working_across_token_refreshes(signed_in: Harness) -> None:
    change_password(signed_in.client)
    signed_in.clock.advance(minutes=59, seconds=30)
    assert signed_in.client.get("/api/me").status_code == 200
    assert signed_in.provider.calls.count("refresh") == 1


def test_a_wrong_current_password_is_invalid_credentials_and_counts_as_a_failure(
    signed_in: Harness,
) -> None:
    response = change_password(signed_in.client, current=WRONG)
    assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"
    assert "set-cookie" not in response.headers
    user_id = user_id_of(signed_in)
    assert signed_in.store.epoch_of(user_id) == 0
    assert signed_in.provider.password_matches(user_id, PASSWORD)
    crypto = signed_in.auth._crypto
    key = crypto.throttle_key_username(USERNAME)
    assert signed_in.store.throttle_check([key])[key] == 1  # the same key as login failures
    assert signed_in.client.get("/api/me").status_code == 200  # the session is untouched


def test_the_throttle_is_checked_before_the_current_password(signed_in: Harness) -> None:
    for _ in range(5):
        change_password(signed_in.client, current=WRONG)
    blocked = change_password(signed_in.client)  # the right password, key in delay
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"
    assert signed_in.provider.password_matches(user_id_of(signed_in), PASSWORD)


def test_login_failures_and_password_check_failures_share_one_counter(signed_in: Harness) -> None:
    for _ in range(3):
        login(signed_in.new_client(address="198.51.100.1"), password=WRONG)
    for _ in range(2):
        change_password(signed_in.client, current=WRONG)
    blocked = login(signed_in.new_client(address="192.0.2.1"), password=PASSWORD)
    assert blocked.status_code == 429  # five failures in all, whichever door they came through


def test_a_current_password_above_72_bytes_cannot_match(signed_in: Harness) -> None:
    calls = signed_in.provider.calls.count("password_grant")
    response = change_password(signed_in.client, current="p" * 73)
    assert response.status_code == 401
    assert signed_in.provider.calls.count("password_grant") == calls


@pytest.mark.parametrize(
    ("new_password", "rules"),
    [
        ("short", ["password_min_chars"]),
        ("x" * 14, ["password_min_chars"]),
        ("x" * 73, ["password_max_bytes"]),
        ("\U0001f600" * 19, ["password_max_bytes"]),
    ],
)
def test_the_new_password_follows_the_registration_policy_and_nothing_happens_on_failure(
    signed_in: Harness, new_password: str, rules: list[str]
) -> None:
    calls = list(signed_in.provider.calls)
    response = change_password(signed_in.client, new=new_password)
    assert response.status_code == 422
    assert fields_of(response) == [("newPassword", rule) for rule in rules]
    assert signed_in.provider.calls == calls  # the provider was never called
    assert signed_in.store.epoch_of(user_id_of(signed_in)) == 0
    assert signed_in.store.throttle_rows() == {}  # a policy failure is not a failed login


def test_a_73_byte_new_password_is_rejected_not_truncated(signed_in: Harness) -> None:
    assert change_password(signed_in.client, new="n" * 72 + "x").status_code == 422
    assert change_password(signed_in.client, new="n" * 72).status_code == 200
    assert login(signed_in.new_client(), password="n" * 72).status_code == 200


def test_the_same_password_changes_nothing_at_the_provider_but_still_ends_other_sessions(
    signed_in: Harness,
) -> None:
    other = signed_in.new_client()
    login(other)
    response = change_password(signed_in.client, new=PASSWORD)
    assert response.status_code == 200
    assert "change_password" not in signed_in.provider.calls
    assert other.get("/api/me").status_code == 401
    assert signed_in.client.get("/api/me").status_code == 200


def test_a_provider_failure_leaves_everything_as_it_was(signed_in: Harness) -> None:
    signed_in.provider.script_failure("change_password", AuthProviderUnavailable())
    response = change_password(signed_in.client)
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    user_id = user_id_of(signed_in)
    assert signed_in.store.epoch_of(user_id) == 0
    assert signed_in.provider.password_matches(user_id, PASSWORD)
    assert signed_in.client.get("/api/me").status_code == 200
    assert change_password(signed_in.client).status_code == 200  # simply repeat it


def failing(method: str) -> tuple[Harness, FlakyStore]:
    """A harness whose next call of ``method`` on the store fails with that layer's error."""
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    assert register(harness.client).status_code == 201
    error = ProfileUnavailable() if method == "read_profile" else RepositoryUnavailable()
    store.script(method, error)
    return harness, store


def test_a_profile_that_cannot_be_read_stops_the_change_before_it_starts() -> None:
    harness, _ = failing("read_profile")
    with harness.client:
        response = change_password(harness.client)
        assert response.status_code == 503
        assert "change_password" not in harness.provider.calls
        assert harness.provider.password_matches(user_id_of(harness), PASSWORD)


def test_a_failure_after_the_provider_changed_the_password_ends_the_sessions_safely() -> None:
    harness, _ = failing("bump_auth_epoch")
    with harness.client:
        response = change_password(harness.client)
        assert response.status_code == 503
        user_id = user_id_of(harness)
        assert harness.provider.password_matches(user_id, NEW_PASSWORD)  # it did change
        assert login(harness.new_client(), password=NEW_PASSWORD).status_code == 200


def test_a_failed_session_insert_after_the_bump_means_logging_in_again() -> None:
    harness, _ = failing("create_app_session")
    with harness.client:
        response = change_password(harness.client)
        assert response.status_code == 503
        assert harness.store.epoch_of(user_id_of(harness)) == 1
        assert harness.client.get("/api/me").status_code == 401  # signed out, nothing worse
        assert login(harness.new_client(), password=NEW_PASSWORD).status_code == 200


def test_the_endpoint_needs_a_session_the_origin_and_a_strict_body(signed_in: Harness) -> None:
    anonymous = change_password(signed_in.new_client())
    assert anonymous.status_code == 401 and error_of(anonymous)["code"] == "unauthenticated"
    forged = signed_in.client.post(
        "/api/auth/password",
        json={"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD},
        headers={"Origin": "https://evil.example"},
    )
    assert forged.status_code == 403 and error_of(forged)["code"] == "forbidden_origin"
    cases: list[tuple[dict[str, Any], list[tuple[str, str]]]] = [
        ({"newPassword": NEW_PASSWORD}, [("currentPassword", "required")]),
        ({"currentPassword": PASSWORD}, [("newPassword", "required")]),
        ({"currentPassword": 1, "newPassword": NEW_PASSWORD}, [("currentPassword", "string_type")]),
        (
            {"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD, "x": 1},
            [("x", "forbidden_field")],
        ),
    ]
    for body, expected in cases:
        response = signed_in.client.post("/api/auth/password", json=body)
        assert response.status_code == 422 and fields_of(response) == expected
    assert signed_in.provider.password_matches(user_id_of(signed_in), PASSWORD)


def test_a_password_change_is_not_available_while_the_terms_are_outdated(
    signed_in: Harness,
) -> None:
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    login(client)
    response = change_password(client)
    assert response.status_code == 400 and error_of(response)["code"] == "terms_required"
    assert error_of(response)["details"] == {"requiredVersion": "2026-12-01"}


def test_a_demo_account_may_change_its_password(harness: Harness) -> None:
    demo = harness.auth.register_account(
        username="demo_learner",
        password=PASSWORD,
        time_zone="Asia/Dubai",
        language="en",
        terms_accepted=True,
        terms_version="2026-10-04",
        is_demo=True,
    )
    client = harness.new_client()
    client.cookies.set("qatra_session", demo.cookie_value)
    response = change_password(client)
    assert response.status_code == 200 and response.json()["profile"]["isDemo"] is True
    assert (
        login(harness.new_client(), username="demo_learner", password=NEW_PASSWORD).status_code
        == 200
    )


def test_password_change_is_a_session_write_for_the_per_ip_limit() -> None:
    harness = build_harness(rate_limits=RateLimits(session_write_per_min=1))
    with harness.client:
        register(harness.client)
        assert change_password(harness.client).status_code == 200
        limited = change_password(harness.client, current=NEW_PASSWORD, new=PASSWORD)
        assert limited.status_code == 429 and "retry-after" in limited.headers
