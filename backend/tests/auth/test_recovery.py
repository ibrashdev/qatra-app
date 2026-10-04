"""E06 verify, E07 reset and E08 rotate (API-spec §4.2; Authentication-and-privacy "recovery"):
a recovery code becomes a short single-use grant, the grant sets a new password, and the old code,
the old sessions and the old password all end; every failure is the same generic 401."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any

import pytest

from app.domain import auth_policy as policy
from app.providers.supabase_auth import AuthProviderUnavailable, AuthRequestRejected
from app.repositories.accounts import (
    InvalidStateError,
    RepositoryUnavailable,
)
from tests.auth.auth_support import (
    NEW_PASSWORD,
    PASSWORD,
    USERNAME,
    FakeClock,
    FlakyStore,
    Harness,
    build_harness,
    error_of,
    fields_of,
    login,
    register,
    reset_password,
    rotate_recovery,
    user_id_of,
    verify_recovery,
)

WRONG_CODE = "ffff-ffff-ffff-ffff-ffff-ffff-ffff-ffff"


def grant_for(harness: Harness, code: str | None = None, client: Any = None) -> str:
    response = verify_recovery(client or harness.new_client(), code or harness.recovery_code)
    assert response.status_code == 200, response.text
    grant: str = response.json()["resetGrant"]
    return grant


# --- E06 verify -----------------------------------------------------------------------------------


def test_a_right_code_returns_a_ten_minute_grant(signed_in: Harness) -> None:
    response = verify_recovery(signed_in.new_client(), signed_in.recovery_code)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"resetGrant", "expiresInSec"} and body["expiresInSec"] == 600
    assert len(body["resetGrant"]) == 43
    assert "set-cookie" not in response.headers  # no login, no session
    user_id = user_id_of(signed_in)
    assert signed_in.store.grant_statuses(user_id) == ["active"]
    assert signed_in.store.live_session_count(user_id) == 1  # only the registration session


def test_the_grant_is_stored_only_as_a_hash_and_expires_after_ten_minutes(
    signed_in: Harness,
) -> None:
    grant = grant_for(signed_in)
    user_id = user_id_of(signed_in)
    ticket_hash = signed_in.auth._crypto.grant_fingerprint(grant)
    row = signed_in.store._grants[next(iter(signed_in.store._grants))]  # the single grant row
    assert row.grant_hash == ticket_hash and grant.encode() not in row.grant_hash
    assert row.expires_at == signed_in.clock.now + timedelta(minutes=10)
    assert row.user_id == user_id and row.status == "active"


@pytest.mark.parametrize(
    "typed",
    [
        lambda code: code,
        lambda code: code.replace("-", ""),
        lambda code: code.upper(),
        lambda code: code.replace("0", "٠").replace("1", "١").replace("9", "٩"),
    ],
    ids=["as shown", "without separators", "upper case", "arabic-indic digits"],
)
def test_the_code_is_normalized_before_the_check(signed_in: Harness, typed: Any) -> None:
    assert (
        verify_recovery(signed_in.new_client(), typed(signed_in.recovery_code)).status_code == 200
    )


def test_the_username_is_normalized_like_at_login(signed_in: Harness) -> None:
    client = signed_in.new_client()
    assert verify_recovery(client, signed_in.recovery_code, "SAMPLE_USER_01").status_code == 200


def failures(harness: Harness) -> list[Any]:
    """Six different ways to fail, each from its own address prefix so that the address
    throttle does not interfere with the comparison."""
    code = harness.recovery_code
    counter = iter(range(100))

    def user() -> Any:
        return harness.new_client(address=f"198.51.{next(counter)}.9")

    return [
        verify_recovery(user(), WRONG_CODE),  # wrong code
        verify_recovery(user(), code, "nobody_here"),  # unknown username
        verify_recovery(user(), "not a code at all"),  # malformed
        verify_recovery(user(), code[:-1]),  # too short
        verify_recovery(user(), " " + code),  # a space is not a display separator
        verify_recovery(user(), "۰" + code[1:]),  # an extended Arabic-Indic digit is not mapped
    ]


def test_every_failure_is_the_same_generic_401(signed_in: Harness) -> None:
    responses = failures(signed_in)
    assert {r.status_code for r in responses} == {401}
    assert len({r.text for r in responses}) == 1
    assert error_of(responses[0]) == {
        "code": "invalid_credentials",
        "message": "The credentials are not valid.",
        "details": {},
    }
    assert all("set-cookie" not in r.headers for r in responses)


def test_a_code_that_was_already_used_is_just_wrong(signed_in: Harness) -> None:
    grant = grant_for(signed_in)
    assert reset_password(signed_in.new_client(), grant).status_code == 200
    again = verify_recovery(signed_in.new_client(), signed_in.recovery_code)
    assert again.status_code == 401 and error_of(again)["code"] == "invalid_credentials"


def test_failures_count_against_the_username_and_the_address(signed_in: Harness) -> None:
    for _ in range(3):
        verify_recovery(signed_in.new_client(), WRONG_CODE)
    crypto = signed_in.auth._crypto
    keys = [
        crypto.throttle_key_username(USERNAME),
        crypto.throttle_key_ip(policy.ip_prefix("203.0.113.9")),
    ]
    assert signed_in.store.throttle_check(keys) == {keys[0]: 3, keys[1]: 3}


def test_the_throttle_is_checked_before_the_code(signed_in: Harness) -> None:
    client = signed_in.new_client()
    for _ in range(5):
        verify_recovery(client, WRONG_CODE)
    blocked = verify_recovery(client, signed_in.recovery_code)  # the right code, key in delay
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"
    assert signed_in.store.grant_statuses(user_id_of(signed_in)) == []  # nothing was reserved
    signed_in.advance(seconds=1)
    assert verify_recovery(client, signed_in.recovery_code).status_code == 200


def test_twenty_failures_lock_recovery_for_fifteen_minutes(signed_in: Harness) -> None:
    done = 0
    while done < 20:
        response = verify_recovery(signed_in.client, WRONG_CODE)
        if response.status_code == 429:
            signed_in.advance(seconds=int(response.headers["retry-after"]))
        else:
            done += 1
    locked = verify_recovery(signed_in.client, signed_in.recovery_code)
    assert locked.status_code == 429 and locked.headers["retry-after"] == "900"
    assert error_of(locked)["details"] == {"retryAfterSec": 900}


def test_a_successful_verification_does_not_clear_the_failure_counters(signed_in: Harness) -> None:
    for _ in range(2):
        verify_recovery(signed_in.new_client(), WRONG_CODE)
    grant_for(signed_in)
    crypto = signed_in.auth._crypto
    key = crypto.throttle_key_username(USERNAME)
    assert signed_in.store.throttle_check([key])[key] == 2  # only a login clears the key


def test_an_unknown_name_costs_the_same_lookups_as_a_known_one(signed_in: Harness) -> None:
    seen: list[Any] = []
    original = signed_in.store.recovery_active_code
    signed_in.store.recovery_active_code = lambda uid: (seen.append(uid), original(uid))[1]  # type: ignore[method-assign]
    verify_recovery(signed_in.new_client(), WRONG_CODE, "nobody_here")
    verify_recovery(signed_in.new_client(), WRONG_CODE)
    assert len(seen) == 2 and seen[0] != seen[1]  # one lookup each; the first for a made-up id


def test_only_one_of_several_simultaneous_requests_gets_a_grant(signed_in: Harness) -> None:
    clients = [signed_in.new_client() for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(lambda c: verify_recovery(c, signed_in.recovery_code).status_code, clients)
        )
    assert sorted(results) == [200, 401, 401, 401]
    assert signed_in.store.grant_statuses(user_id_of(signed_in)) == ["active"]


def test_while_a_grant_is_active_the_same_code_cannot_get_a_second_one(signed_in: Harness) -> None:
    grant_for(signed_in)
    second = verify_recovery(signed_in.new_client(), signed_in.recovery_code)
    assert second.status_code == 401 and error_of(second)["code"] == "invalid_credentials"
    assert signed_in.store.grant_statuses(user_id_of(signed_in)) == ["active"]


def test_an_unused_grant_expires_and_the_code_can_be_verified_again(signed_in: Harness) -> None:
    old = grant_for(signed_in)
    signed_in.advance(minutes=10, seconds=1)
    expired = reset_password(signed_in.new_client(), old)
    assert expired.status_code == 401 and error_of(expired)["code"] == "invalid_credentials"
    fresh = grant_for(signed_in)
    assert fresh != old
    assert reset_password(signed_in.new_client(), fresh).status_code == 200


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"recoveryCode": WRONG_CODE}, [("username", "required")]),
        ({"username": USERNAME}, [("recoveryCode", "required")]),
        ({"username": 5, "recoveryCode": "x"}, [("username", "string_type")]),
        ({"username": USERNAME, "recoveryCode": None}, [("recoveryCode", "string_type")]),
        ({"username": USERNAME, "recoveryCode": "x", "extra": 1}, [("extra", "forbidden_field")]),
    ],
)
def test_verify_body_is_strict(
    harness: Harness, body: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    response = harness.client.post("/api/auth/recovery/verify", json=body)
    assert response.status_code == 422 and fields_of(response) == expected


def test_verify_needs_the_frontend_origin(signed_in: Harness) -> None:
    response = signed_in.new_client().post(
        "/api/auth/recovery/verify",
        json={"username": USERNAME, "recoveryCode": signed_in.recovery_code},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403 and error_of(response)["code"] == "forbidden_origin"
    assert signed_in.store.grant_statuses(user_id_of(signed_in)) == []


def test_a_storage_failure_while_verifying_is_503() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        code = register(harness.client).json()["recoveryCode"]
        for method in ("find_handle", "recovery_active_code", "recovery_reserve"):
            store.script(method, RepositoryUnavailable())
            response = verify_recovery(harness.new_client(), code)
            assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
        assert verify_recovery(harness.new_client(), code).status_code in (200, 429)


# --- E07 reset ------------------------------------------------------------------------------------


def test_a_reset_sets_the_password_ends_every_session_and_issues_a_new_code(
    signed_in: Harness,
) -> None:
    old_session = signed_in.client  # signed in since registration
    other = signed_in.new_client()
    login(other)
    grant = grant_for(signed_in)
    client = signed_in.new_client()
    response = reset_password(client, grant)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert set(response.json()) == {"recoveryCode"}
    assert "set-cookie" not in response.headers  # no automatic login
    new_code = response.json()["recoveryCode"]
    assert new_code != signed_in.recovery_code
    assert policy.normalize_recovery_code(new_code) is not None
    user_id = user_id_of(signed_in)
    assert signed_in.store.epoch_of(user_id) == 1
    assert signed_in.store.live_session_count(user_id) == 0
    for cookie_holder in (old_session, other):
        expired = cookie_holder.get("/api/me")
        assert expired.status_code == 401 and error_of(expired)["code"] == "unauthenticated"
    assert login(signed_in.new_client(), password=PASSWORD).status_code == 401  # the old password
    assert login(signed_in.new_client(), password=NEW_PASSWORD).status_code == 200
    assert signed_in.store.grant_statuses(user_id) == ["consumed"]


def test_the_old_code_is_consumed_and_the_new_one_works(signed_in: Harness) -> None:
    grant = grant_for(signed_in)
    new_code = reset_password(signed_in.new_client(), grant).json()["recoveryCode"]
    assert verify_recovery(signed_in.new_client(), signed_in.recovery_code).status_code == 401
    user_id = user_id_of(signed_in)
    assert signed_in.store.code_count(user_id) == 2
    assert signed_in.store.code_count(user_id, active_only=True) == 1
    assert verify_recovery(signed_in.new_client(), new_code).status_code == 200


def test_new_sessions_after_a_reset_use_the_new_epoch(signed_in: Harness) -> None:
    reset_password(signed_in.new_client(), grant_for(signed_in))
    client = signed_in.new_client()
    login(client, password=NEW_PASSWORD)
    assert client.get("/api/me").status_code == 200


def test_a_grant_works_exactly_once(signed_in: Harness) -> None:
    grant = grant_for(signed_in)
    assert reset_password(signed_in.new_client(), grant).status_code == 200
    again = reset_password(signed_in.new_client(), grant, "yet another synthetic passphrase")
    assert again.status_code == 401 and error_of(again)["code"] == "invalid_credentials"
    assert login(signed_in.new_client(), password=NEW_PASSWORD).status_code == 200


def test_only_one_of_several_simultaneous_resets_with_the_same_grant_runs(
    signed_in: Harness,
) -> None:
    grant = grant_for(signed_in)
    clients = [signed_in.new_client() for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        codes = list(pool.map(lambda c: reset_password(c, grant).status_code, clients))
    assert sorted(codes) == [200, 401, 401, 401]
    assert signed_in.store.epoch_of(user_id_of(signed_in)) == 1  # the epoch moved once


@pytest.mark.parametrize(
    ("password", "rules"),
    [
        ("short", ["password_min_chars"]),
        ("x" * 14, ["password_min_chars"]),
        ("x" * 73, ["password_max_bytes"]),
        ("ب" * 37, ["password_max_bytes"]),
    ],
)
def test_the_new_password_follows_the_registration_policy(
    signed_in: Harness, password: str, rules: list[str]
) -> None:
    grant = grant_for(signed_in)
    response = reset_password(signed_in.new_client(), grant, password)
    assert response.status_code == 422
    assert fields_of(response) == [("newPassword", rule) for rule in rules]
    # a rejected password consumes nothing: the same grant still works
    assert reset_password(signed_in.new_client(), grant).status_code == 200


@pytest.mark.parametrize("grant", ["", "unknown", "g" * 43, "g" * 129, "  ", "0" * 32])
def test_an_unknown_or_malformed_grant_is_the_generic_401(signed_in: Harness, grant: str) -> None:
    response = reset_password(signed_in.new_client(), grant)
    assert response.status_code == 401
    assert error_of(response)["code"] == "invalid_credentials"
    assert signed_in.store.epoch_of(user_id_of(signed_in)) == 0


def test_a_recovery_code_is_not_accepted_as_a_grant(signed_in: Harness) -> None:
    response = reset_password(signed_in.new_client(), signed_in.recovery_code.replace("-", ""))
    assert response.status_code == 401


@pytest.mark.parametrize("failure", [AuthProviderUnavailable(), AuthRequestRejected()])
def test_when_the_provider_fails_nothing_is_consumed_and_recovery_can_start_again(
    signed_in: Harness, failure: Exception
) -> None:
    grant = grant_for(signed_in)
    signed_in.provider.script_failure("admin_set_password", failure)
    response = reset_password(signed_in.new_client(), grant)
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    user_id = user_id_of(signed_in)
    assert signed_in.store.grant_statuses(user_id) == ["cancelled"]  # released, not consumed
    assert (
        signed_in.store.epoch_of(user_id) == 0 and signed_in.store.live_session_count(user_id) == 1
    )
    assert login(signed_in.new_client(), password=PASSWORD).status_code == 200  # unchanged
    retry = grant_for(signed_in)  # the same, still active code
    assert reset_password(signed_in.new_client(), retry).status_code == 200


def test_the_consume_step_is_repeated_once_and_gives_up_after_that() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        code = register(harness.client).json()["recoveryCode"]
        grant = grant_for(harness, code)
        store.script("recovery_consume", RepositoryUnavailable())
        ok = reset_password(harness.new_client(), grant)
        assert ok.status_code == 200
        assert login(harness.new_client(), password=NEW_PASSWORD).status_code == 200

        grant = grant_for(harness, ok.json()["recoveryCode"])
        store.script("recovery_consume", RepositoryUnavailable(), times=2)
        failed = reset_password(harness.new_client(), grant, "a third synthetic passphrase")
        assert failed.status_code == 503 and error_of(failed)["code"] == "unavailable"
        # the grant is released, not left "executing" (which would block recovery for good)
        assert store.grant_statuses(user_id_of(harness)) == ["consumed", "cancelled"]
        again = grant_for(harness, ok.json()["recoveryCode"])  # the same code can start again
        retried = reset_password(harness.new_client(), again, "a fourth synthetic passphrase")
        assert retried.status_code == 200


def test_a_lost_reservation_is_the_generic_401() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        code = register(harness.client).json()["recoveryCode"]
        grant = grant_for(harness, code)
        store.script("recovery_consume", InvalidStateError())
        response = reset_password(harness.new_client(), grant)
        assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"


class LostAnswerStore(FlakyStore):
    """The first consume commits but its answer is lost (a timeout after the commit)."""

    lose_next = True

    def recovery_consume(self, grant_id: Any, new_code_hash: bytes) -> int:
        epoch = super().recovery_consume(grant_id, new_code_hash)
        if self.lose_next:
            self.lose_next = False
            raise RepositoryUnavailable()
        return epoch


def test_a_consume_whose_answer_was_lost_is_recognised_by_the_stored_code() -> None:
    clock = FakeClock()
    store = LostAnswerStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        code = register(harness.client).json()["recoveryCode"]
        grant = grant_for(harness, code)
        response = reset_password(harness.new_client(), grant)
        assert response.status_code == 200  # the committed result is reported, not lost
        new_code = response.json()["recoveryCode"]
        assert verify_recovery(harness.new_client(), new_code).status_code == 200
        assert store.epoch_of(user_id_of(harness)) == 1  # bumped once, not twice


def test_invalid_grants_count_against_the_address_only(signed_in: Harness) -> None:
    for _ in range(3):
        reset_password(signed_in.new_client(), "unknown-grant")
    crypto = signed_in.auth._crypto
    ip_key = crypto.throttle_key_ip(policy.ip_prefix("203.0.113.9"))
    user_key = crypto.throttle_key_username(USERNAME)
    assert signed_in.store.throttle_check([ip_key, user_key]) == {ip_key: 3, user_key: 0}


def test_the_reset_is_throttled_by_address_before_the_grant_is_looked_at(
    signed_in: Harness,
) -> None:
    grant = grant_for(signed_in)
    client = signed_in.new_client()
    for _ in range(5):
        reset_password(client, "unknown-grant")
    blocked = reset_password(client, grant)
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"
    signed_in.advance(seconds=1)
    assert reset_password(client, grant).status_code == 200


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"newPassword": NEW_PASSWORD}, [("resetGrant", "required")]),
        ({"resetGrant": "g"}, [("newPassword", "required")]),
        ({"resetGrant": 1, "newPassword": NEW_PASSWORD}, [("resetGrant", "string_type")]),
        ({"resetGrant": "g", "newPassword": None}, [("newPassword", "string_type")]),
        ({"resetGrant": "g", "newPassword": NEW_PASSWORD, "x": 1}, [("x", "forbidden_field")]),
    ],
)
def test_reset_body_is_strict(
    harness: Harness, body: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    response = harness.client.post("/api/auth/recovery/reset", json=body)
    assert response.status_code == 422 and fields_of(response) == expected


def test_reset_needs_the_frontend_origin(signed_in: Harness) -> None:
    grant = grant_for(signed_in)
    response = signed_in.new_client().post(
        "/api/auth/recovery/reset",
        json={"resetGrant": grant, "newPassword": NEW_PASSWORD},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert reset_password(signed_in.new_client(), grant).status_code == 200  # the grant is intact


# --- E08 rotate -----------------------------------------------------------------------------------


def test_rotation_replaces_the_code_and_keeps_sessions_and_epoch(signed_in: Harness) -> None:
    response = rotate_recovery(signed_in.client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert set(response.json()) == {"recoveryCode"}
    new_code = response.json()["recoveryCode"]
    assert new_code != signed_in.recovery_code and policy.normalize_recovery_code(new_code)
    assert verify_recovery(signed_in.new_client(), signed_in.recovery_code).status_code == 401
    assert verify_recovery(signed_in.new_client(), new_code).status_code == 200
    user_id = user_id_of(signed_in)
    assert signed_in.store.epoch_of(user_id) == 0
    assert signed_in.client.get("/api/me").status_code == 200  # the session is untouched


def test_rotation_cancels_a_pending_reset_grant(signed_in: Harness) -> None:
    grant = grant_for(signed_in)
    assert rotate_recovery(signed_in.client).status_code == 200
    stale = reset_password(signed_in.new_client(), grant)
    assert stale.status_code == 401
    assert signed_in.store.grant_statuses(user_id_of(signed_in)) == ["cancelled"]


def test_rotation_needs_the_current_password_and_counts_a_wrong_one(signed_in: Harness) -> None:
    response = rotate_recovery(signed_in.client, "a wrong passphrase of enough length")
    assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"
    assert verify_recovery(signed_in.new_client(), signed_in.recovery_code).status_code == 200
    crypto = signed_in.auth._crypto
    key = crypto.throttle_key_username(USERNAME)
    assert signed_in.store.throttle_check([key])[key] == 1  # under the same username key


def test_rotation_is_throttled_before_the_password_is_checked(signed_in: Harness) -> None:
    for _ in range(5):
        rotate_recovery(signed_in.client, "a wrong passphrase of enough length")
    blocked = rotate_recovery(signed_in.client, PASSWORD)
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"
    assert verify_recovery(signed_in.new_client(), signed_in.recovery_code).status_code in (
        200,
        429,
    )


def test_rotation_needs_a_session_the_origin_and_a_string(signed_in: Harness) -> None:
    anonymous = rotate_recovery(signed_in.new_client())
    assert anonymous.status_code == 401 and error_of(anonymous)["code"] == "unauthenticated"
    forged = signed_in.client.post(
        "/api/auth/recovery/rotate",
        json={"password": PASSWORD},
        headers={"Origin": "http://x.test"},
    )
    assert forged.status_code == 403
    for body in ({}, {"password": 5}, {"password": PASSWORD, "x": 1}):
        assert signed_in.client.post("/api/auth/recovery/rotate", json=body).status_code == 422
    assert verify_recovery(signed_in.new_client(), signed_in.recovery_code).status_code == 200


def test_rotation_is_not_available_while_the_terms_are_outdated(signed_in: Harness) -> None:
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    login(client)
    response = rotate_recovery(client)
    assert response.status_code == 400 and error_of(response)["code"] == "terms_required"
    assert verify_recovery(changed.new_client(), signed_in.recovery_code).status_code == 200


def test_a_demo_account_can_rotate_its_code(harness: Harness) -> None:
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
    response = rotate_recovery(client)
    assert response.status_code == 200 and response.json()["recoveryCode"] != demo.recovery_code
