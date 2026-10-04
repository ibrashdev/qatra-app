"""E04 ``POST /api/auth/login`` (API-spec §4.2) and the auth throttle (§1.7, §1.8; A-03):
generic failures, the throttle checked BEFORE the credentials, the progressive delay, the lock at
20 failures with ``Retry-After``, success clearing the username key, and re-consent."""

from __future__ import annotations

from typing import Any

import pytest

from app.domain import auth_policy as policy
from app.providers.supabase_auth import AuthProviderUnavailable
from app.repositories.accounts import (
    EpochMismatchError,
    ProfileUnavailable,
    RepositoryUnavailable,
)
from app.services.auth import AuthThrottle
from tests.auth.auth_support import (
    PASSWORD,
    USERNAME,
    FakeClock,
    FakeMonotonic,
    FlakyStore,
    Harness,
    build_harness,
    cookie_value,
    error_of,
    login,
    post_raw_json,
    register,
    session_cookie,
    user_id_of,
)

WRONG = "a wrong passphrase of enough length"


def throttle_counts(harness: Harness, *, username: str = USERNAME, address: str = "203.0.113.9"):
    crypto = harness.auth._crypto
    keys = [
        crypto.throttle_key_username(policy.normalize_username(username)),
        crypto.throttle_key_ip(policy.ip_prefix(address)),
    ]
    counts = harness.store.throttle_check(keys)
    return counts[keys[0]], counts[keys[1]]


# --- success --------------------------------------------------------------------------------------


def test_login_opens_a_session_and_returns_the_profile(signed_in: Harness) -> None:
    client = signed_in.new_client()
    response = login(client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"profile", "reconsentRequired"}
    assert body["reconsentRequired"] is False
    assert body["profile"]["username"] == "sample_user_01" and body["profile"]["isDemo"] is False
    assert client.get("/api/me").status_code == 200


def test_login_sets_a_fresh_cookie_and_replaces_the_one_presented(signed_in: Harness) -> None:
    old = cookie_value(login(signed_in.new_client()))  # a second session exists
    client = signed_in.client  # holds the cookie of the registration
    registration_cookie = client.cookies.get("qatra_session")
    response = login(client)
    new = cookie_value(response)
    assert new not in (old, registration_cookie)
    assert client.cookies.get("qatra_session") == new
    # the session that the browser presented is revoked, the other device's session is not
    assert signed_in.new_client().get("/api/me").status_code == 401
    other = signed_in.new_client()
    other.cookies.set("qatra_session", registration_cookie)
    assert other.get("/api/me").status_code == 401
    other.cookies.set("qatra_session", old)
    assert other.get("/api/me").status_code == 200


def test_the_session_is_bound_to_the_accounts_current_epoch(signed_in: Harness) -> None:
    user_id = user_id_of(signed_in)
    signed_in.store.bump_auth_epoch(user_id)
    client = signed_in.new_client()
    assert login(client).status_code == 200
    assert client.get("/api/me").status_code == 200
    stored = signed_in.store.read_app_session(
        signed_in.auth._crypto.session_hash(
            signed_in.auth._crypto.decode_cookie_value(client.cookies.get("qatra_session"))  # type: ignore[arg-type]
        )
    )
    assert stored is not None and stored.auth_epoch == 1


@pytest.mark.parametrize(
    "name", ["SAMPLE_USER_01", "Sample_User_01", "ｓａｍｐｌｅ＿ｕｓｅｒ_０１"]
)
def test_the_username_is_normalized_for_lookup(signed_in: Harness, name: str) -> None:
    assert login(signed_in.new_client(), username=name).status_code == 200


def test_arabic_indic_digits_are_accepted_at_login(harness: Harness) -> None:
    register(harness.client, username="اسم_٢٠٢٦")
    assert login(harness.new_client(), username="اسم_2026").status_code == 200
    assert login(harness.new_client(), username="اسم_٢٠٢٦").status_code == 200


# --- generic failures -----------------------------------------------------------------------------


def test_unknown_user_and_wrong_password_are_indistinguishable(signed_in: Harness) -> None:
    wrong = login(signed_in.new_client(), password=WRONG)
    unknown = login(signed_in.new_client(), username="nobody_here")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert error_of(wrong) == {
        "code": "invalid_credentials",
        "message": "The credentials are not valid.",
        "details": {},
    }
    assert "set-cookie" not in wrong.headers and "set-cookie" not in unknown.headers
    assert wrong.headers["cache-control"] == unknown.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("username", "password"),
    [("a", "x"), ("", ""), ("bad name!", "short"), ("ab", "y" * 14), ("x" * 500, "z" * 500)],
)
def test_the_registration_rules_are_not_applied_at_login(
    signed_in: Harness, username: str, password: str
) -> None:
    response = login(signed_in.new_client(), username=username, password=password)
    assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"


def test_a_password_above_72_bytes_cannot_match_and_never_reaches_the_provider(
    signed_in: Harness,
) -> None:
    calls = signed_in.provider.calls.count("password_grant")
    for username in (USERNAME, "nobody_here"):
        response = login(signed_in.new_client(), username=username, password="p" * 73)
        assert response.status_code == 401
    assert signed_in.provider.calls.count("password_grant") == calls
    assert throttle_counts(signed_in)[0] == 1  # it counts as a failure
    # a lone surrogate cannot even be encoded as UTF-8: it cannot match either
    raw = b'{"username":"sample_user_01","password":"' + b"\\ud800" * 20 + b'"}'
    assert post_raw_json(signed_in.new_client(), "/api/auth/login", raw).status_code == 401
    assert signed_in.provider.calls.count("password_grant") == calls


def test_an_unknown_name_costs_the_same_provider_call_as_a_known_one(signed_in: Harness) -> None:
    def grants(username: str, password: str) -> int:
        before = signed_in.provider.calls.count("password_grant")
        login(signed_in.new_client(address="198.51.100.5"), username=username, password=password)
        return signed_in.provider.calls.count("password_grant") - before

    assert (
        grants("nobody_here", WRONG) == grants(USERNAME, WRONG) == grants(USERNAME, PASSWORD) == 1
    )


def test_a_lookup_key_that_cannot_be_stored_is_just_unknown(signed_in: Harness) -> None:
    bodies = [
        b'{"username":"a\\u0000b","password":"synthetic passphrase for tests only"}',
        b'{"username":"\\ud800\\ud800\\ud800","password":"synthetic passphrase for tests only"}',
    ]
    for raw in bodies:
        response = post_raw_json(signed_in.new_client(), "/api/auth/login", raw)
        assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"


@pytest.mark.parametrize(
    ("body", "rule"),
    [
        ({"password": PASSWORD}, ("username", "required")),
        ({"username": USERNAME}, ("password", "required")),
        ({"username": 5, "password": PASSWORD}, ("username", "string_type")),
        ({"username": USERNAME, "password": None}, ("password", "string_type")),
        (
            {"username": USERNAME, "password": PASSWORD, "isDemo": True},
            ("isDemo", "forbidden_field"),
        ),
    ],
)
def test_the_body_is_strict(harness: Harness, body: dict[str, Any], rule: tuple[str, str]) -> None:
    response = harness.client.post("/api/auth/login", json=body)
    assert response.status_code == 422
    assert (
        error_of(response)["details"]["fields"][0]["field"],
        error_of(response)["details"]["fields"][0]["rule"],
    ) == rule


def test_login_needs_the_frontend_origin(signed_in: Harness) -> None:
    client = signed_in.new_client()
    response = client.post(
        "/api/auth/login",
        json={"username": USERNAME, "password": PASSWORD},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403 and error_of(response)["code"] == "forbidden_origin"
    assert throttle_counts(signed_in) == (0, 0)  # the request never reached the credentials


# --- the throttle ---------------------------------------------------------------------------------


def wrong_attempt(harness: Harness, *, username: str = USERNAME, client: Any = None) -> Any:
    return login(client or harness.client, username=username, password=WRONG)


def fail_following_the_schedule(
    harness: Harness, count: int, *, name_of: Any = None, client: Any = None
) -> None:
    """``count`` failed logins, each one made only after the wait the throttle demanded (as an
    attacker who respects the delay would): a 429 is waited out and is not a failure."""
    done = 0
    while done < count:
        username = name_of(done) if name_of else USERNAME
        response = login(client or harness.client, username=username, password=WRONG)
        if response.status_code == 429:
            wait = int(response.headers["retry-after"])
            assert wait < 900, "locked before the expected number of failures"
            harness.advance(seconds=wait)
            continue
        assert response.status_code == 401
        done += 1


def test_four_failures_cost_nothing_the_fifth_starts_the_delay(signed_in: Harness) -> None:
    for _ in range(5):
        assert wrong_attempt(signed_in).status_code == 401  # failures 1..5 need no waiting
    blocked = wrong_attempt(signed_in)
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"


def test_the_delay_grows_as_documented_and_the_attempt_after_it_is_judged(
    signed_in: Harness,
) -> None:
    for _ in range(5):
        wrong_attempt(signed_in)
    for failures, delay in zip(
        range(5, 20), [1, 2, 4, 8, 10, 20, 30, 40, 50, 60, 60, 60, 60, 60, 60], strict=True
    ):
        assert policy.throttle_delay_sec(failures) == delay
        early = wrong_attempt(signed_in)
        assert early.status_code == 429
        assert early.headers["retry-after"] == str(delay)
        assert error_of(early)["details"] == {"retryAfterSec": delay}
        assert error_of(early)["code"] == "throttled"
        signed_in.advance(seconds=delay - 1)
        assert wrong_attempt(signed_in).status_code == 429  # one second still to wait
        signed_in.advance(seconds=1)
        assert wrong_attempt(signed_in).status_code == 401  # judged normally: a new failure
    assert throttle_counts(signed_in)[0] == 20


def test_twenty_failures_lock_the_key_for_fifteen_minutes_even_for_the_right_password(
    signed_in: Harness,
) -> None:
    fail_following_the_schedule(signed_in, 20)
    assert throttle_counts(signed_in)[0] == 20
    locked = login(signed_in.new_client(address="198.51.100.40"), password=PASSWORD)  # new IP
    assert locked.status_code == 429
    assert locked.headers["retry-after"] == "900"
    assert error_of(locked)["details"] == {"retryAfterSec": 900}
    assert "set-cookie" not in locked.headers  # no oracle: not even the correct password gets in


def test_the_lock_survives_a_restart_and_is_not_extended_by_locked_attempts(
    signed_in: Harness,
) -> None:
    fail_following_the_schedule(signed_in, 20)
    restarted = signed_in.restart()  # the in-process delay memory is gone, the database remains
    client = restarted.new_client()
    for _ in range(5):
        assert login(client, password=PASSWORD).status_code == 429
    assert throttle_counts(restarted)[0] == 20  # locked attempts are not recorded
    restarted.clock.advance(minutes=16)  # the buckets age out of the window
    assert login(client, password=PASSWORD).status_code == 200


def test_a_success_clears_the_username_key_but_not_the_address_key(signed_in: Harness) -> None:
    for _ in range(6):
        wrong_attempt(signed_in)
        signed_in.advance(seconds=10)
    assert throttle_counts(signed_in) == (6, 6)
    assert login(signed_in.client, password=PASSWORD).status_code == 200
    assert throttle_counts(signed_in) == (0, 6)
    # the username is free again: a failure from another address starts at 1
    other = signed_in.new_client(address="198.51.100.9")
    assert wrong_attempt(signed_in, client=other).status_code == 401
    assert throttle_counts(signed_in, address="198.51.100.9")[0] == 1


def test_failures_from_every_address_count_against_the_username(signed_in: Harness) -> None:
    for index in range(5):
        client = signed_in.new_client(address=f"198.51.{index}.7")  # five different /24 prefixes
        assert wrong_attempt(signed_in, client=client).status_code == 401
    elsewhere = signed_in.new_client(address="192.0.2.77")
    blocked = wrong_attempt(signed_in, client=elsewhere)
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"


def test_failures_from_one_prefix_slow_every_username_from_that_prefix(signed_in: Harness) -> None:
    for index in range(5):
        login(signed_in.client, username=f"nobody_{index}", password=WRONG)
    mate = signed_in.new_client(address="203.0.113.200")  # the same /24
    blocked = login(mate, username=USERNAME, password=PASSWORD)
    assert blocked.status_code == 429  # a different name, the same address prefix
    signed_in.advance(seconds=1)
    assert login(mate, username=USERNAME, password=PASSWORD).status_code == 200
    stranger = signed_in.new_client(address="198.51.100.9")
    assert login(stranger, username=USERNAME, password=PASSWORD).status_code == 200


def test_twenty_failures_from_one_prefix_lock_it_for_every_username(signed_in: Harness) -> None:
    fail_following_the_schedule(signed_in, 20, name_of=lambda index: f"nobody_{index}")
    locked = login(signed_in.client, username=USERNAME, password=PASSWORD)
    assert locked.status_code == 429 and locked.headers["retry-after"] == "900"
    assert login(signed_in.new_client(address="198.51.100.9")).status_code == 200


def test_the_throttle_is_checked_before_the_credentials(signed_in: Harness) -> None:
    for _ in range(5):
        wrong_attempt(signed_in)
    calls = signed_in.provider.calls.count("password_grant")
    blocked = login(signed_in.client, password=PASSWORD)  # right password, key in delay
    assert blocked.status_code == 429
    assert signed_in.provider.calls.count("password_grant") == calls  # no provider call at all


def test_a_service_that_does_not_remember_the_last_failure_still_enforces_the_lock() -> None:
    clock, mono = FakeClock(), FakeMonotonic()
    from app.repositories.accounts import InMemoryAccounts
    from app.services.session_crypto import SessionCrypto
    from tests.support import make_settings

    store = InMemoryAccounts(clock=clock)
    crypto = SessionCrypto.from_settings(make_settings(), allow_ephemeral=True)
    throttle = AuthThrottle(store, crypto, monotonic=mono)
    key = crypto.throttle_key_username("someone")
    store.throttle_record([key] * 1, "failure")
    for _ in range(4):
        store.throttle_record([key], "failure")  # 5 failures the process never saw
    throttle.check(username="someone", ip_prefix="198.51.100.0/24")  # the soft delay is skipped
    for _ in range(15):
        store.throttle_record([key], "failure")
    with pytest.raises(Exception) as raised:
        throttle.check(username="someone", ip_prefix="198.51.100.0/24")
    assert getattr(raised.value, "retry_after", None) == 900


def test_the_throttle_stores_only_hashes() -> None:
    harness = build_harness()
    with harness.client:
        register(harness.client)
        login(harness.client, password=WRONG)
        rows = harness.store.throttle_rows()
    assert rows
    for (key, _), _count in rows.items():
        assert isinstance(key, bytes) and len(key) == 32
        assert USERNAME.encode() not in key and b"203.0.113" not in key


# --- re-consent -----------------------------------------------------------------------------------


def test_login_reports_that_re_consent_is_required_but_still_opens_the_session(
    signed_in: Harness,
) -> None:
    """The terms change by deploying a new ``TERMS_VERSION``: a new process over the same data."""
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    response = login(client)
    assert response.status_code == 200
    assert response.json()["reconsentRequired"] is True
    assert response.json()["profile"]["termsVersion"] == "2026-10-04"  # what was accepted
    assert session_cookie(response).startswith("qatra_session=")
    assert client.get("/api/me").status_code == 200  # E11 is allowed
    gated = client.patch("/api/me", json={"language": "en"})
    assert gated.status_code == 400 and error_of(gated)["code"] == "terms_required"
    assert error_of(gated)["details"] == {"requiredVersion": "2026-12-01"}


# --- failures of the services behind ------------------------------------------------------------


def test_an_unavailable_identity_provider_is_503_and_not_a_failed_attempt(
    signed_in: Harness,
) -> None:
    signed_in.provider.script_failure("password_grant", AuthProviderUnavailable())
    response = login(signed_in.new_client())
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    assert throttle_counts(signed_in) == (0, 0)
    assert login(signed_in.new_client()).status_code == 200


def test_an_unavailable_database_is_503() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        for method in ("find_handle", "throttle_check"):
            store.script(method, RepositoryUnavailable())
            response = login(harness.new_client())
            assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
        assert login(harness.new_client()).status_code == 200


def test_a_profile_that_cannot_be_read_leaves_no_session_behind() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        before = store.session_count()
        store.script("read_profile", ProfileUnavailable())
        response = login(harness.new_client())
        assert response.status_code == 503
        assert store.session_count() == before


def test_an_epoch_that_moves_during_login_is_retried_once() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        store.script("create_app_session", EpochMismatchError())
        assert login(harness.new_client()).status_code == 200
        store.script("create_app_session", EpochMismatchError(), times=2)
        assert login(harness.new_client()).status_code == 503


def test_a_failure_to_clear_the_counters_does_not_undo_the_login(all_logs: Any) -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        store.script("throttle_record", RepositoryUnavailable())  # the success call fails
        assert login(harness.new_client()).status_code == 200
    assert "throttle_clear_failed" in "\n".join(all_logs())


def test_logging_in_with_a_stale_cookie_of_another_account_just_replaces_it(
    harness: Harness,
) -> None:
    register(harness.client, username="first_user")
    register(harness.new_client(), username="second_user")
    client = harness.client  # holds first_user's cookie
    assert login(client, username="second_user").status_code == 200
    assert client.get("/api/me").json()["username"] == "second_user"
