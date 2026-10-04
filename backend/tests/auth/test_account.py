"""E11 ``GET /api/me``, E12 ``PATCH /api/me`` (D57 pending settings) and E13
``POST /api/account/delete`` (Database-schema §12.1) — API-spec §4.3."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.providers.supabase_auth import AuthProviderUnavailable
from app.repositories.accounts import (
    ProfileUnavailable,
    ProfileValueRejected,
    RepositoryUnavailable,
)
from app.routers.auth import RateLimits
from tests.auth.auth_support import (
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
    user_id_of,
)

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
WRONG = "a wrong passphrase of enough length"


def patch(client: TestClient, body: dict[str, Any]) -> Any:
    return client.patch("/api/me", json=body)


def stored(harness: Harness) -> Any:
    return harness.store.read_profile(user_id=user_id_of(harness), access_token=None)


def delete(client: TestClient, password: str = PASSWORD, confirm: str = "DELETE") -> Any:
    return client.post("/api/account/delete", json={"password": password, "confirm": confirm})


# --- E11 ------------------------------------------------------------------------------------------


def test_the_profile_is_returned_as_the_contract_dto(signed_in: Harness) -> None:
    response = signed_in.client.get("/api/me")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert set(response.json()) == PROFILE_KEYS
    assert response.json() == {
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


def test_the_profile_needs_a_session_and_the_failure_clears_the_cookie(signed_in: Harness) -> None:
    response = signed_in.new_client().get("/api/me")
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"
    assert response.headers["set-cookie"].startswith("qatra_session=; ")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_a_get_needs_no_origin(signed_in: Harness) -> None:
    for origin in ("https://evil.example", None):
        headers = {"Origin": origin} if origin else {}
        client = signed_in.new_client()
        client.cookies.set("qatra_session", signed_in.client.cookies.get("qatra_session"))
        client.headers.pop("Origin")
        assert client.get("/api/me", headers=headers).status_code == 200


def test_a_session_ends_after_its_thirty_days(signed_in: Harness) -> None:
    signed_in.clock.advance(days=30, seconds=1)
    assert signed_in.client.get("/api/me").status_code == 401


def test_the_profile_is_readable_while_the_terms_are_outdated(signed_in: Harness) -> None:
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    login(client)
    response = client.get("/api/me")
    assert response.status_code == 200 and response.json()["termsVersion"] == "2026-10-04"


def test_reading_the_profile_is_a_session_read_for_the_per_ip_limit() -> None:
    harness = build_harness(rate_limits=RateLimits(session_read_per_min=2))
    with harness.client:
        register(harness.client)
        assert harness.client.get("/api/me").status_code == 200
        assert harness.client.get("/api/me").status_code == 200
        limited = harness.client.get("/api/me")
        assert limited.status_code == 429 and "retry-after" in limited.headers


def test_a_storage_failure_is_503() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        store.script("read_profile", ProfileUnavailable())
        response = harness.client.get("/api/me")
        assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
        assert harness.client.get("/api/me").status_code == 200


# --- E12 ------------------------------------------------------------------------------------------


def test_language_and_the_reminder_change_at_once(signed_in: Harness) -> None:
    response = patch(signed_in.client, {"language": "en", "reminderSettings": {"inApp": False}})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == PROFILE_KEYS  # the Profile itself, not an envelope
    assert (body["language"], body["reminderSettings"], body["pendingSettings"]) == (
        "en",
        {"inApp": False},
        None,
    )
    row = stored(signed_in)
    assert (row.language, row.reminder_settings, row.pending_settings) == (
        "en",
        {"inApp": False},
        None,
    )
    assert signed_in.client.get("/api/me").json() == body


def test_minutes_and_zone_wait_for_the_next_learning_day(signed_in: Harness) -> None:
    response = patch(signed_in.client, {"sessionMinutes": 15, "timeZone": "Europe/London"})
    body = response.json()
    assert (body["sessionMinutes"], body["timeZone"]) == (10, "Asia/Dubai")  # still in force
    assert body["pendingSettings"] == {
        "sessionMinutes": 15,
        "timeZone": "Europe/London",
        "effectiveDate": "2026-10-05",
    }
    row = stored(signed_in)
    assert (row.session_minutes, row.time_zone) == (10, "Asia/Dubai")
    assert row.pending_settings == body["pendingSettings"]
    assert signed_in.client.get("/api/me").json()["pendingSettings"] == body["pendingSettings"]


def test_the_effective_date_is_the_next_local_day_of_the_zone_in_force() -> None:
    late = FakeClock(datetime(2026, 10, 4, 20, 30, tzinfo=UTC))  # 00:30 on the 5th in Dubai
    harness = build_harness(clock=late)
    with harness.client:
        register(harness.client)
        body = patch(harness.client, {"sessionMinutes": 5}).json()
        assert body["pendingSettings"]["effectiveDate"] == "2026-10-06"


def test_a_later_request_replaces_the_pending_value_of_the_same_field(signed_in: Harness) -> None:
    patch(signed_in.client, {"sessionMinutes": 15, "timeZone": "Europe/London"})
    body = patch(signed_in.client, {"sessionMinutes": 5}).json()
    assert body["pendingSettings"] == {
        "sessionMinutes": 5,
        "timeZone": "Europe/London",
        "effectiveDate": "2026-10-05",
    }


def test_asking_for_the_value_in_force_withdraws_the_pending_change(signed_in: Harness) -> None:
    patch(signed_in.client, {"sessionMinutes": 15})
    body = patch(signed_in.client, {"sessionMinutes": 10}).json()
    assert body["pendingSettings"] is None and stored(signed_in).pending_settings is None


def test_repeating_a_request_gives_the_same_state(signed_in: Harness) -> None:
    first = patch(signed_in.client, {"language": "en", "sessionMinutes": 15}).json()
    second = patch(signed_in.client, {"language": "en", "sessionMinutes": 15}).json()
    assert first == second


def test_a_pending_change_takes_effect_on_its_day_without_a_get_writing_anything(
    signed_in: Harness,
) -> None:
    patch(signed_in.client, {"sessionMinutes": 15, "timeZone": "Europe/London"})
    waiting = stored(signed_in)
    signed_in.clock.advance(hours=11, minutes=44)  # 19:59 UTC: still the 4th in Dubai
    assert signed_in.client.get("/api/me").json()["sessionMinutes"] == 10
    signed_in.clock.advance(minutes=1)  # 20:00 UTC: Dubai midnight, the 5th begins
    body = signed_in.client.get("/api/me").json()
    assert (body["sessionMinutes"], body["timeZone"], body["pendingSettings"]) == (
        15,
        "Europe/London",
        None,
    )
    assert stored(signed_in) == waiting  # E11 never writes (API-spec E11)


def test_the_promotion_is_stored_by_the_next_successful_update(signed_in: Harness) -> None:
    patch(signed_in.client, {"sessionMinutes": 15})
    signed_in.clock.advance(days=1)
    body = patch(signed_in.client, {"language": "en"}).json()
    assert (body["sessionMinutes"], body["pendingSettings"]) == (15, None)
    row = stored(signed_in)
    assert (row.session_minutes, row.pending_settings, row.language) == (15, None, "en")


def test_a_new_pending_change_after_a_promotion_uses_the_zone_now_in_force(
    signed_in: Harness,
) -> None:
    patch(signed_in.client, {"timeZone": "Pacific/Kiritimati"})  # UTC+14
    signed_in.clock.advance(days=1)
    body = patch(signed_in.client, {"sessionMinutes": 5}).json()
    assert body["timeZone"] == "Pacific/Kiritimati"
    assert body["pendingSettings"] == {"sessionMinutes": 5, "effectiveDate": "2026-10-06"}


def test_the_other_fields_are_not_touched(signed_in: Harness) -> None:
    before = signed_in.client.get("/api/me").json()
    after = patch(signed_in.client, {"language": "en"}).json()
    unchanged = {k: v for k, v in after.items() if k != "language"}
    assert unchanged == {k: v for k, v in before.items() if k != "language"}
    assert stored(signed_in).terms_accepted_at == signed_in.clock.now


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({}, [("body", "no_fields")]),
        ({"language": "fr"}, [("language", "language_invalid")]),
        ({"language": "AR"}, [("language", "language_invalid")]),
        ({"language": ""}, [("language", "language_invalid")]),
        ({"timeZone": "Mars/Olympus"}, [("timeZone", "time_zone_invalid")]),
        ({"timeZone": ""}, [("timeZone", "time_zone_invalid")]),
        ({"sessionMinutes": 7}, [("sessionMinutes", "session_minutes_invalid")]),
        ({"sessionMinutes": 0}, [("sessionMinutes", "session_minutes_invalid")]),
        ({"sessionMinutes": -5}, [("sessionMinutes", "session_minutes_invalid")]),
        ({"reminderSettings": {}}, [("reminderSettings", "reminder_settings_invalid")]),
        (
            {"reminderSettings": {"inApp": "yes"}},
            [("reminderSettings", "reminder_settings_invalid")],
        ),
        (
            {"reminderSettings": {"inApp": True, "push": True}},
            [("reminderSettings", "reminder_settings_invalid")],
        ),
        ({"reminderSettings": {"push": True}}, [("reminderSettings", "reminder_settings_invalid")]),
        (
            {"language": "fr", "timeZone": "Q/Q", "sessionMinutes": 7, "reminderSettings": {}},
            [
                ("language", "language_invalid"),
                ("timeZone", "time_zone_invalid"),
                ("sessionMinutes", "session_minutes_invalid"),
                ("reminderSettings", "reminder_settings_invalid"),
            ],
        ),
    ],
)
def test_each_rule_of_the_update_is_named(
    signed_in: Harness, body: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    before = stored(signed_in)
    response = patch(signed_in.client, body)
    assert response.status_code == 422 and error_of(response)["code"] == "validation_error"
    assert fields_of(response) == expected
    assert stored(signed_in) == before  # nothing is applied when anything is wrong


def test_a_valid_field_next_to_an_invalid_one_is_not_applied(signed_in: Harness) -> None:
    response = patch(signed_in.client, {"language": "en", "sessionMinutes": 7})
    assert response.status_code == 422 and stored(signed_in).language == "ar"


@pytest.mark.parametrize(
    "field",
    [
        "username",
        "isDemo",
        "termsVersion",
        "termsAcceptedAt",
        "createdAt",
        "pendingSettings",
        "userId",
    ],
)
def test_fields_that_belong_to_the_server_are_forbidden(signed_in: Harness, field: str) -> None:
    before = stored(signed_in)
    response = patch(signed_in.client, {"language": "en", field: "x"})
    assert response.status_code == 422
    assert fields_of(response) == [(field, "forbidden_field")]
    assert stored(signed_in) == before and signed_in.store.find_handle("sample_user_01")


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"language": None}, [("language", "string_type")]),
        ({"language": 5}, [("language", "string_type")]),
        ({"timeZone": 5}, [("timeZone", "string_type")]),
        ({"sessionMinutes": "10"}, [("sessionMinutes", "int_type")]),
        ({"sessionMinutes": 15.0}, [("sessionMinutes", "int_type")]),
        ({"sessionMinutes": True}, [("sessionMinutes", "int_type")]),
        ({"sessionMinutes": None}, [("sessionMinutes", "int_type")]),
        ({"reminderSettings": None}, [("reminderSettings", "dict_type")]),
        ({"reminderSettings": "inApp"}, [("reminderSettings", "dict_type")]),
        ({"reminderSettings": [True]}, [("reminderSettings", "dict_type")]),
    ],
)
def test_a_wrong_json_type_is_a_validation_error(
    signed_in: Harness, body: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    response = patch(signed_in.client, body)
    assert response.status_code == 422 and fields_of(response) == expected


def test_submitted_values_are_not_echoed(signed_in: Harness) -> None:
    response = patch(signed_in.client, {"timeZone": "Sentinel/Zone", "language": "sentinel"})
    assert "Sentinel" not in response.text and "sentinel" not in response.text


def test_update_needs_a_session_the_origin_and_a_clear_terms_state(signed_in: Harness) -> None:
    anonymous = patch(signed_in.new_client(), {"language": "en"})
    assert anonymous.status_code == 401 and error_of(anonymous)["code"] == "unauthenticated"
    forged = signed_in.client.patch(
        "/api/me", json={"language": "en"}, headers={"Origin": "https://evil.example"}
    )
    assert forged.status_code == 403 and error_of(forged)["code"] == "forbidden_origin"
    assert stored(signed_in).language == "ar"
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    login(client)
    gated = patch(client, {"language": "en"})
    assert gated.status_code == 400 and error_of(gated)["code"] == "terms_required"
    assert stored(signed_in).language == "ar"


def test_a_storage_failure_is_503_and_a_rejected_zone_is_422() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        store.script("update_profile", ProfileUnavailable())
        failed = patch(harness.client, {"language": "en"})
        assert failed.status_code == 503 and error_of(failed)["code"] == "unavailable"
        store.script("update_profile", ProfileValueRejected())  # the database trigger said no
        rejected = patch(harness.client, {"timeZone": "Europe/London"})
        assert rejected.status_code == 422
        assert fields_of(rejected) == [("timeZone", "time_zone_invalid")]
        store.script("update_profile", ProfileValueRejected())
        assert patch(harness.client, {"language": "en"}).status_code == 500  # cannot be a zone
        assert patch(harness.client, {"language": "en"}).status_code == 200


def test_a_demo_account_may_change_its_settings_but_not_its_demo_flag(harness: Harness) -> None:
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
    assert patch(client, {"language": "ar"}).json()["isDemo"] is True
    assert patch(client, {"isDemo": False}).status_code == 422


def test_update_is_a_session_write_for_the_per_ip_limit() -> None:
    harness = build_harness(rate_limits=RateLimits(session_write_per_min=1))
    with harness.client:
        register(harness.client)
        assert patch(harness.client, {"language": "en"}).status_code == 200
        assert patch(harness.client, {"language": "ar"}).status_code == 429


# --- E13 ------------------------------------------------------------------------------------------


def test_the_account_and_every_personal_row_are_deleted_at_once(signed_in: Harness) -> None:
    user_id = user_id_of(signed_in)
    other = signed_in.new_client()
    login(other)
    login(signed_in.new_client(), password=WRONG)  # leaves throttle rows behind
    response = delete(signed_in.client)
    assert response.status_code == 204 and response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["set-cookie"] == (
        "qatra_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    )
    store = signed_in.store
    assert not store.account_exists(user_id) and store.find_handle("sample_user_01") is None
    assert store.session_count(user_id) == 0 and store.code_count(user_id) == 0
    assert store.grant_statuses(user_id) == []
    assert not signed_in.provider.has_user(user_id)  # the Auth user is gone too
    assert signed_in.client.get("/api/me").status_code == 401
    assert other.get("/api/me").status_code == 401  # every session ended with the rows
    assert login(signed_in.new_client()).status_code == 401


def test_the_username_key_of_the_throttle_goes_with_the_account_the_address_key_stays(
    signed_in: Harness,
) -> None:
    for _ in range(2):
        login(signed_in.new_client(), password=WRONG)
    crypto = signed_in.auth._crypto
    keys = [crypto.throttle_key_username(USERNAME), crypto.throttle_key_ip("203.0.113.0/24")]
    assert signed_in.store.throttle_check(keys) == {keys[0]: 2, keys[1]: 2}
    delete(signed_in.client)
    assert signed_in.store.throttle_check(keys) == {keys[0]: 0, keys[1]: 2}


def test_the_name_is_free_again_after_the_deletion(signed_in: Harness) -> None:
    first = user_id_of(signed_in)
    delete(signed_in.client)
    assert register(signed_in.new_client()).status_code == 201
    assert user_id_of(signed_in) != first


def test_a_wrong_password_deletes_nothing_and_counts_as_a_failure(signed_in: Harness) -> None:
    response = delete(signed_in.client, WRONG)
    assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"
    assert "set-cookie" not in response.headers
    assert signed_in.store.account_exists(user_id_of(signed_in))
    crypto = signed_in.auth._crypto
    key = crypto.throttle_key_username(USERNAME)
    assert signed_in.store.throttle_check([key])[key] == 1
    assert signed_in.client.get("/api/me").status_code == 200


def test_the_throttle_is_checked_before_the_password(signed_in: Harness) -> None:
    for _ in range(5):
        delete(signed_in.client, WRONG)
    blocked = delete(signed_in.client)  # the right password, key in delay
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "1"
    assert signed_in.store.account_exists(user_id_of(signed_in))


@pytest.mark.parametrize("confirm", ["delete", "Delete", "DELETE ", " DELETE", "", "YES"])
def test_the_confirmation_must_be_exactly_delete_and_is_checked_first(
    signed_in: Harness, confirm: str
) -> None:
    calls = signed_in.provider.calls.count("password_grant")
    response = delete(signed_in.client, PASSWORD, confirm)
    assert response.status_code == 422
    assert fields_of(response) == [("confirm", "confirm_literal")]
    assert signed_in.provider.calls.count("password_grant") == calls  # nothing was verified
    assert signed_in.store.throttle_rows() == {}
    assert signed_in.store.account_exists(user_id_of(signed_in))


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"confirm": "DELETE"}, [("password", "required")]),
        ({"password": PASSWORD}, [("confirm", "required")]),
        ({"password": None, "confirm": "DELETE"}, [("password", "string_type")]),
        ({"password": PASSWORD, "confirm": True}, [("confirm", "string_type")]),
        ({"password": PASSWORD, "confirm": "DELETE", "x": 1}, [("x", "forbidden_field")]),
    ],
)
def test_delete_body_is_strict(
    signed_in: Harness, body: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    response = signed_in.client.post("/api/account/delete", json=body)
    assert response.status_code == 422 and fields_of(response) == expected
    assert signed_in.store.account_exists(user_id_of(signed_in))


def test_a_password_above_72_bytes_cannot_match(signed_in: Harness) -> None:
    response = delete(signed_in.client, "p" * 73)
    assert response.status_code == 401 and signed_in.store.account_exists(user_id_of(signed_in))


def test_a_failed_auth_deletion_afterwards_still_answers_204(
    signed_in: Harness, all_logs: Any
) -> None:
    user_id = user_id_of(signed_in)
    signed_in.provider.script_failure("admin_delete_user", AuthProviderUnavailable())
    response = delete(signed_in.client)
    assert response.status_code == 204
    assert not signed_in.store.account_exists(user_id)  # the personal rows are gone
    assert signed_in.provider.has_user(user_id)  # the alias-only Auth record is the residue
    assert signed_in.client.get("/api/me").status_code == 401
    joined = "\n".join(all_logs())
    assert "identity_delete_failed" in joined and "sample_user_01" not in joined


def test_a_database_failure_leaves_the_account_intact_and_the_request_repeatable() -> None:
    clock = FakeClock()
    store = FlakyStore(clock=clock)
    harness = build_harness(store=store, clock=clock)
    with harness.client:
        register(harness.client)
        store.script("delete_personal_rows", RepositoryUnavailable())
        failed = delete(harness.client)
        assert failed.status_code == 503 and error_of(failed)["code"] == "unavailable"
        assert store.account_exists(user_id_of(harness))
        assert harness.client.get("/api/me").status_code == 200
        assert delete(harness.client).status_code == 204


def test_a_repeat_after_success_is_a_401(signed_in: Harness) -> None:
    cookie = signed_in.client.cookies.get("qatra_session")
    assert delete(signed_in.client).status_code == 204
    replay = signed_in.new_client()
    replay.cookies.set("qatra_session", cookie)
    again = delete(replay)
    assert again.status_code == 401 and error_of(again)["code"] == "unauthenticated"


def test_delete_needs_a_session_the_origin_and_clear_terms(signed_in: Harness) -> None:
    anonymous = delete(signed_in.new_client())
    assert anonymous.status_code == 401 and error_of(anonymous)["code"] == "unauthenticated"
    forged = signed_in.client.post(
        "/api/account/delete",
        json={"password": PASSWORD, "confirm": "DELETE"},
        headers={"Origin": "https://evil.example"},
    )
    assert forged.status_code == 403 and error_of(forged)["code"] == "forbidden_origin"
    assert signed_in.store.account_exists(user_id_of(signed_in))
    changed = signed_in.restart(TERMS_VERSION="2026-12-01")
    client = changed.new_client()
    login(client)
    gated = delete(client)  # API-spec O-10: every Session operation except E05, E10, E11
    assert gated.status_code == 400 and error_of(gated)["code"] == "terms_required"
    assert signed_in.store.account_exists(user_id_of(signed_in))


def test_a_demo_account_may_be_deleted(harness: Harness) -> None:
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
    assert delete(client).status_code == 204
    assert harness.provider.user_count() == 0


def test_delete_is_a_session_write_for_the_per_ip_limit() -> None:
    harness = build_harness(rate_limits=RateLimits(session_write_per_min=1))
    with harness.client:
        register(harness.client)
        assert delete(harness.client, WRONG).status_code == 401
        assert delete(harness.client).status_code == 429
