"""E03 ``POST /api/auth/register`` (API-spec §4.2): the account, its first session, the one-time
recovery code, the validation order, the rule names, uniqueness and the compensation."""

from __future__ import annotations

import re
from typing import Any

import pytest

from app.domain import auth_policy as policy
from app.providers.supabase_auth import AuthProviderUnavailable
from app.repositories.accounts import (
    ProfileUnavailable,
    RepositoryUnavailable,
    UsernameTakenError,
)
from app.routers.auth import RateLimits
from tests.auth.auth_support import (
    FakeClock,
    FlakyStore,
    Harness,
    build_harness,
    cookie_value,
    error_of,
    fields_of,
    login,
    register,
    registration,
    session_cookie,
    user_id_of,
)

CODE_SHAPE = re.compile(r"^([0-9a-f]{4}-){7}[0-9a-f]{4}$")
PROFILE_KEYS = {
    "username",
    "language",
    "timeZone",
    "sessionMinutes",
    "reminderSettings",
    "isDemo",
    "termsVersion",
    "termsAcceptedAt",
    "createdAt",
    "pendingSettings",
}


def nothing_was_created(harness: Harness) -> bool:
    return harness.provider.user_count() == 0 and harness.store.session_count() == 0


# --- success --------------------------------------------------------------------------------------


def test_registration_creates_the_account_and_the_first_session(harness: Harness) -> None:
    response = register(harness.client)
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"profile", "recoveryCode"}
    assert set(body["profile"]) == PROFILE_KEYS
    assert body["profile"] == {
        "username": "sample_user_01",
        "language": "ar",
        "timeZone": "Asia/Dubai",
        "sessionMinutes": 10,
        "reminderSettings": {"inApp": True},
        "isDemo": False,
        "termsVersion": "2026-10-04",
        "termsAcceptedAt": "2026-10-04T08:15:00Z",
        "createdAt": "2026-10-04T08:15:00Z",
        "pendingSettings": None,
    }
    assert CODE_SHAPE.match(body["recoveryCode"])
    assert harness.client.get("/api/me").json()["username"] == "sample_user_01"


def test_the_cookie_is_the_documented_development_cookie(harness: Harness) -> None:
    response = register(harness.client)
    header = session_cookie(response)
    assert re.fullmatch(
        r"qatra_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000",
        header,
    )
    assert "Secure" not in header and "Domain" not in header


def test_the_stored_rows_follow_the_schema(harness: Harness) -> None:
    code = register(harness.client, username="Sample_User_01").json()["recoveryCode"]
    user_id = user_id_of(harness)
    handle = harness.store.find_handle("sample_user_01")
    assert handle is not None
    assert handle.username_display == "Sample_User_01" and handle.auth_epoch == 0
    assert handle.is_demo is False
    assert (
        re.fullmatch(r"u\.[0-9a-f-]{36}@qatra\.invalid", handle.internal_auth_alias)
        and harness.provider.alias_of(user_id) == handle.internal_auth_alias
    )
    profile = harness.store.read_profile(user_id=user_id, access_token=None)
    assert (profile.language, profile.time_zone, profile.session_minutes) == (
        "ar",
        "Asia/Dubai",
        10,
    )
    assert (profile.terms_version, profile.is_demo) == ("2026-10-04", False)
    active = harness.store.recovery_active_code(user_id)
    assert active is not None
    normalized = policy.normalize_recovery_code(code)
    assert normalized is not None
    assert active.code_hash == harness.auth._crypto.recovery_fingerprint(normalized)
    assert normalized.encode() not in active.code_hash  # only the fingerprint is stored
    assert harness.provider.password_matches(user_id, "synthetic passphrase for tests only")


def test_the_first_session_is_bound_to_epoch_zero_and_lasts_thirty_days(harness: Harness) -> None:
    register(harness.client)
    user_id = user_id_of(harness)
    assert harness.store.epoch_of(user_id) == 0 and harness.store.live_session_count(user_id) == 1
    harness.clock.advance(days=29, hours=23)
    assert harness.client.get("/api/me").status_code == 200  # no sliding renewal is defined...
    harness.clock.advance(hours=2)
    assert harness.client.get("/api/me").status_code == 401  # ...so it ends after 30 days


def test_each_registration_gets_its_own_recovery_code_and_cookie(harness: Harness) -> None:
    first = register(harness.client, username="first_user")
    second = register(harness.new_client(), username="second_user")
    assert first.json()["recoveryCode"] != second.json()["recoveryCode"]
    assert cookie_value(first) != cookie_value(second)


def test_arabic_names_and_arabic_indic_digits_are_stored_as_ascii_digits(harness: Harness) -> None:
    response = register(harness.client, username="اسم_٢٠٢٦")
    assert response.status_code == 201
    assert response.json()["profile"]["username"] == "اسم_2026"
    assert harness.store.find_handle("اسم_2026") is not None


def test_unicode_compatibility_forms_are_stored_normalized(harness: Harness) -> None:
    response = register(harness.client, username="ＵＳＥＲ_１")
    assert response.json()["profile"]["username"] == "USER_1"
    assert harness.store.find_handle("user_1") is not None


def test_the_password_is_used_as_typed_never_trimmed_or_normalized(harness: Harness) -> None:
    typed = "  café passphrase with spaces  "
    assert register(harness.client, password=typed).status_code == 201
    assert harness.provider.password_matches(user_id_of(harness), typed)


# --- validation order -----------------------------------------------------------------------------


def test_origin_is_checked_before_everything_else(harness: Harness) -> None:
    client = harness.new_client()
    response = client.post(
        "/api/auth/register", json={"nonsense": 1}, headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403 and error_of(response)["code"] == "forbidden_origin"
    assert "set-cookie" not in response.headers and nothing_was_created(harness)


def test_the_schema_is_checked_before_the_terms(harness: Harness) -> None:
    body = registration(termsAccepted=False)
    del body["username"]
    response = harness.client.post("/api/auth/register", json=body)
    assert response.status_code == 422
    assert fields_of(response) == [("username", "required")]


def test_the_terms_are_checked_before_the_field_rules(harness: Harness) -> None:
    response = register(
        harness.client, termsAccepted=False, username="x", password="short", language="fr"
    )
    assert response.status_code == 400 and error_of(response)["code"] == "terms_required"


def test_the_field_rules_are_checked_before_uniqueness(harness: Harness) -> None:
    register(harness.client)
    response = register(harness.new_client(), password="short")
    assert response.status_code == 422  # not 409: the rules come first


def test_uniqueness_is_checked_last(harness: Harness) -> None:
    register(harness.client)
    response = register(harness.new_client())
    assert response.status_code == 409 and error_of(response)["code"] == "username_taken"


# --- terms ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {"termsAccepted": False},
        {"termsVersion": "2026-01-01"},
        {"termsVersion": ""},
        {"termsVersion": "2026-10-04 "},
        {"termsAccepted": False, "termsVersion": "2026-01-01"},
    ],
)
def test_registration_needs_the_current_terms_accepted(
    harness: Harness, overrides: dict[str, Any]
) -> None:
    response = register(harness.client, **overrides)
    assert response.status_code == 400
    error = error_of(response)
    assert error["code"] == "terms_required"
    assert error["details"] == {"requiredVersion": "2026-10-04"}
    assert nothing_was_created(harness)


# --- strict schema --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field", ["username", "password", "timeZone", "language", "termsAccepted", "termsVersion"]
)
def test_every_field_is_required(harness: Harness, field: str) -> None:
    body = registration()
    del body[field]
    response = harness.client.post("/api/auth/register", json=body)
    assert response.status_code == 422
    assert fields_of(response) == [(field, "required")]
    assert nothing_was_created(harness)


@pytest.mark.parametrize(
    ("field", "value", "rule"),
    [
        ("username", 5, "string_type"),
        ("username", None, "string_type"),
        ("password", ["x"], "string_type"),
        ("timeZone", 5, "string_type"),
        ("language", True, "string_type"),
        ("termsAccepted", "true", "bool_type"),
        ("termsAccepted", 1, "bool_type"),
        ("termsAccepted", None, "bool_type"),
        ("termsVersion", 20261004, "string_type"),
    ],
)
def test_a_wrong_json_type_is_a_validation_error(
    harness: Harness, field: str, value: object, rule: str
) -> None:
    response = register(harness.client, **{field: value})
    assert response.status_code == 422 and fields_of(response) == [(field, rule)]


@pytest.mark.parametrize("extra", ["isDemo", "userId", "mode", "auth_epoch", "username2"])
def test_an_unknown_property_is_forbidden(harness: Harness, extra: str) -> None:
    response = register(harness.client, **{extra: True})
    assert response.status_code == 422
    assert fields_of(response) == [(extra, "forbidden_field")]
    assert nothing_was_created(harness)


def test_only_camel_case_names_are_accepted(harness: Harness) -> None:
    body = registration()
    body["time_zone"] = body.pop("timeZone")
    response = harness.client.post("/api/auth/register", json=body)
    assert sorted(fields_of(response)) == [
        ("timeZone", "required"),
        ("time_zone", "forbidden_field"),
    ]


@pytest.mark.parametrize("payload", [[], "text", 5, None])
def test_the_body_must_be_a_json_object(harness: Harness, payload: object) -> None:
    response = harness.client.post("/api/auth/register", json=payload)
    assert response.status_code == 422 and error_of(response)["code"] == "validation_error"


def test_unparsable_json_and_wrong_content_types_are_validation_errors(harness: Harness) -> None:
    broken = harness.client.post(
        "/api/auth/register", content=b"{nope", headers={"Content-Type": "application/json"}
    )
    assert broken.status_code == 422 and fields_of(broken) == [("body", "json_invalid")]
    plain = harness.client.post(
        "/api/auth/register", content=b"username=a", headers={"Content-Type": "text/plain"}
    )
    assert plain.status_code == 422 and error_of(plain)["code"] == "validation_error"


# --- field rules ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"username": "ab"}, [("username", "username_length")]),
        ({"username": "a" * 25}, [("username", "username_length")]),
        ({"username": "user-name"}, [("username", "username_chars")]),
        ({"username": "user name"}, [("username", "username_invisible_or_space")]),
        ({"username": "user\u200bname"}, [("username", "username_invisible_or_space")]),
        ({"password": "short passphrase"[:14]}, [("password", "password_min_chars")]),
        ({"password": "x" * 73}, [("password", "password_max_bytes")]),
        ({"password": "ب" * 37}, [("password", "password_max_bytes")]),
        ({"timeZone": "Mars/Olympus"}, [("timeZone", "time_zone_invalid")]),
        ({"timeZone": ""}, [("timeZone", "time_zone_invalid")]),
        ({"timeZone": "asia/dubai"}, [("timeZone", "time_zone_invalid")]),
        ({"language": "fr"}, [("language", "language_invalid")]),
        ({"language": "AR"}, [("language", "language_invalid")]),
        ({"language": ""}, [("language", "language_invalid")]),
        (
            {"username": "a-", "password": "x", "timeZone": "Nope", "language": "zz"},
            [
                ("username", "username_length"),
                ("username", "username_chars"),
                ("password", "password_min_chars"),
                ("timeZone", "time_zone_invalid"),
                ("language", "language_invalid"),
            ],
        ),
    ],
)
def test_each_field_rule_is_named_in_the_details(
    harness: Harness, overrides: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    response = register(harness.client, **overrides)
    assert response.status_code == 422
    assert error_of(response)["code"] == "validation_error"
    assert fields_of(response) == expected
    assert nothing_was_created(harness)


def test_submitted_values_are_never_echoed(harness: Harness) -> None:
    secret = "a short sentinel"
    response = register(harness.client, username="bad name!", password=secret, timeZone="Q/Q")
    text = response.text
    assert secret not in text and "bad name" not in text and "Q/Q" not in text


def test_a_73_byte_password_is_rejected_not_truncated_to_72(harness: Harness) -> None:
    long_password = "a" * 72 + "b"
    assert register(harness.client, password=long_password).status_code == 422
    assert register(harness.client, password="a" * 72).status_code == 201
    assert login(harness.new_client(), password="a" * 72).status_code == 200


# --- uniqueness -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "variant",
    ["Sample_User_01", "SAMPLE_USER_01", "ｓａｍｐｌｅ_user_01", "sample_user_٠١"],
)
def test_a_name_that_normalizes_to_an_existing_one_is_taken(harness: Harness, variant: str) -> None:
    register(harness.client)
    response = register(harness.new_client(), username=variant)
    assert response.status_code == 409
    assert error_of(response)["code"] == "username_taken"
    assert harness.provider.user_count() == 1  # no Auth user was created for the loser


def test_arabic_letters_are_not_folded_so_these_names_are_distinct(harness: Harness) -> None:
    assert register(harness.client, username="أحمد_أ").status_code == 201
    assert register(harness.new_client(), username="احمد_ا").status_code == 201
    assert register(harness.new_client(), username="أحمد_أ").status_code == 409


# --- compensation ---------------------------------------------------------------------------------


def flaky_harness() -> tuple[Harness, FlakyStore]:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    return build_harness(store=store, clock=clock), store


def test_a_lost_race_for_the_name_deletes_the_auth_user_and_answers_409() -> None:
    harness, store = flaky_harness()
    store.script("register_account", UsernameTakenError())
    response = register(harness.client)
    assert response.status_code == 409 and error_of(response)["code"] == "username_taken"
    assert nothing_was_created(harness)
    assert "admin_delete_user" in harness.provider.calls


def test_a_database_failure_after_the_auth_user_deletes_it() -> None:
    harness, store = flaky_harness()
    store.script("register_account", RepositoryUnavailable())
    response = register(harness.client)
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    assert nothing_was_created(harness) and store.find_handle("sample_user_01") is None
    assert register(harness.client).status_code == 201  # the learner may simply try again


def test_a_failed_first_login_at_the_provider_deletes_the_auth_user() -> None:
    harness, _ = flaky_harness()
    harness.provider.script_failure("password_grant", AuthProviderUnavailable())
    response = register(harness.client)
    assert response.status_code == 503 and nothing_was_created(harness)
    assert harness.store.find_handle("sample_user_01") is None


def test_a_failed_session_insert_rolls_back_the_rows_and_the_auth_user() -> None:
    harness, store = flaky_harness()
    store.script("create_app_session", RepositoryUnavailable())
    response = register(harness.client)
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    assert nothing_was_created(harness)
    assert store.find_handle("sample_user_01") is None  # the account rows are gone as well
    assert register(harness.client).status_code == 201


def test_a_provider_that_is_down_creates_nothing() -> None:
    harness, store = flaky_harness()
    harness.provider.script_failure("create_user", AuthProviderUnavailable())
    response = register(harness.client)
    assert response.status_code == 503 and store.find_handle("sample_user_01") is None
    assert "admin_delete_user" not in harness.provider.calls


def test_a_failed_cleanup_does_not_change_the_answer_and_is_logged_without_details(
    all_logs: Any,
) -> None:
    harness, store = flaky_harness()
    store.script("register_account", RepositoryUnavailable())
    harness.provider.script_failure("admin_delete_user", AuthProviderUnavailable())
    response = register(harness.client)
    assert response.status_code == 503
    joined = "\n".join(all_logs())
    assert "identity_cleanup_failed" in joined
    assert "sample_user_01" not in joined


def test_the_profile_read_back_is_best_effort() -> None:
    harness, store = flaky_harness()
    store.script("read_profile", ProfileUnavailable())
    response = register(harness.client)
    assert response.status_code == 201  # the account is complete; the answer is built locally
    assert response.json()["profile"]["username"] == "sample_user_01"
    assert harness.client.get("/api/me").status_code == 200


# --- throttle and limits --------------------------------------------------------------------------


def test_registrations_never_count_against_the_throttle(harness: Harness) -> None:
    for index in range(8):
        assert register(harness.new_client(), username=f"learner_{index:02d}").status_code == 201
    for _ in range(3):
        assert register(harness.new_client(), username="learner_00").status_code == 409
        assert register(harness.new_client(), username="x").status_code == 422
    assert harness.store.throttle_rows() == {}


def test_anonymous_entry_is_limited_per_client_ip_with_retry_after() -> None:
    harness = build_harness(rate_limits=RateLimits(anonymous_entry_per_min=3))
    with harness.client:
        for index in range(3):
            assert register(harness.client, username=f"learner_{index:02d}").status_code == 201
        blocked = register(harness.client, username="learner_99")
        assert blocked.status_code == 429
        error = error_of(blocked)
        assert error["code"] == "throttled"
        assert 1 <= int(blocked.headers["retry-after"]) <= 60
        assert error["details"] == {"retryAfterSec": int(blocked.headers["retry-after"])}
        other = harness.new_client(address="198.51.100.77")
        assert register(other, username="learner_98").status_code == 201
    assert harness.provider.user_count() == 4  # the blocked request reached nothing


def test_the_per_ip_limit_is_applied_before_the_body_is_read() -> None:
    harness = build_harness(rate_limits=RateLimits(anonymous_entry_per_min=1))
    with harness.client:
        assert register(harness.client).status_code == 201
        response = harness.client.post("/api/auth/register", json={"nonsense": True})
        assert response.status_code == 429  # not 422


def test_the_default_per_ip_limits_are_the_documented_classes() -> None:
    assert RateLimits().anonymous_entry_per_min == 10
    assert (RateLimits().session_write_per_min, RateLimits().session_read_per_min) == (60, 120)
