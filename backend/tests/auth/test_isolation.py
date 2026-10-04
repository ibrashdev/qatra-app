"""Cross-account isolation (API-spec §1.4; Role 6 verification): no operation of one account
touches another account's sessions, codes, settings, throttle state or data, and no operation
accepts an account identifier — identity comes from the cookie alone."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from tests.auth.auth_support import (
    NEW_PASSWORD,
    PASSWORD,
    Harness,
    change_password,
    error_of,
    login,
    register,
    reset_password,
    rotate_recovery,
    user_id_of,
    verify_recovery,
)

SECOND = "second_user"
WRONG = "a wrong passphrase of enough length"


def two_learners(harness: Harness) -> tuple[TestClient, TestClient, str, str]:
    """The learner on ``harness.client`` and a second learner on a client of their own, each
    with the recovery code shown at registration."""
    first = register(harness.client)
    second_client = harness.new_client(address="198.51.100.20")
    second = register(second_client, username=SECOND)
    assert first.status_code == second.status_code == 201
    return (
        harness.client,
        second_client,
        first.json()["recoveryCode"],
        second.json()["recoveryCode"],
    )


def test_changing_a_password_ends_only_the_sessions_of_that_account(harness: Harness) -> None:
    one, two, _, _ = two_learners(harness)
    assert change_password(one).status_code == 200
    assert two.get("/api/me").status_code == 200
    assert two.get("/api/me").json()["username"] == SECOND
    assert login(harness.new_client(), username=SECOND, password=PASSWORD).status_code == 200


def test_deleting_one_account_leaves_the_other_intact(harness: Harness) -> None:
    one, two, _, second_code = two_learners(harness)
    deletion = one.post("/api/account/delete", json={"password": PASSWORD, "confirm": "DELETE"})
    assert deletion.status_code == 204
    assert two.get("/api/me").json()["username"] == SECOND
    assert harness.provider.user_count() == 1
    assert verify_recovery(harness.new_client(), second_code, SECOND).status_code == 200


def test_a_reset_revokes_the_sessions_of_the_reset_account_only(harness: Harness) -> None:
    one, two, first_code, _ = two_learners(harness)
    grant = verify_recovery(harness.new_client(), first_code).json()["resetGrant"]
    assert reset_password(harness.new_client(), grant).status_code == 200
    assert one.get("/api/me").status_code == 401
    assert two.get("/api/me").status_code == 200
    assert harness.store.epoch_of(user_id_of(harness)) == 1
    assert harness.store.epoch_of(user_id_of(harness, SECOND)) == 0


def test_rotating_one_code_leaves_the_other_codes_valid(harness: Harness) -> None:
    one, _, first_code, second_code = two_learners(harness)
    assert rotate_recovery(one).status_code == 200
    assert verify_recovery(harness.new_client(), first_code).status_code == 401
    assert verify_recovery(harness.new_client(), second_code, SECOND).status_code == 200


def test_a_code_does_not_work_for_another_username(harness: Harness) -> None:
    _, _, first_code, second_code = two_learners(harness)
    crossed = verify_recovery(harness.new_client(address="192.0.2.5"), first_code, SECOND)
    assert crossed.status_code == 401 and error_of(crossed)["code"] == "invalid_credentials"
    crossed = verify_recovery(harness.new_client(address="192.0.2.6"), second_code)
    assert crossed.status_code == 401
    assert verify_recovery(harness.new_client(address="192.0.2.7"), first_code).status_code == 200


def test_a_reset_grant_only_resets_the_account_it_was_issued_for(harness: Harness) -> None:
    _, _, first_code, _ = two_learners(harness)
    grant = verify_recovery(harness.new_client(), first_code).json()["resetGrant"]
    assert reset_password(harness.new_client(), grant, NEW_PASSWORD).status_code == 200
    assert harness.provider.password_matches(user_id_of(harness), NEW_PASSWORD)
    assert harness.provider.password_matches(user_id_of(harness, SECOND), PASSWORD)


def test_settings_and_consent_apply_to_the_session_account_only(harness: Harness) -> None:
    one, two, _, _ = two_learners(harness)
    assert one.patch("/api/me", json={"language": "en", "sessionMinutes": 15}).status_code == 200
    body = two.get("/api/me").json()
    assert (body["language"], body["sessionMinutes"], body["pendingSettings"]) == ("ar", 10, None)
    assert one.post("/api/auth/consent", json={"termsVersion": "2026-10-04"}).status_code == 200


def test_a_password_check_uses_the_account_of_the_session_not_the_one_named_elsewhere(
    harness: Harness,
) -> None:
    one, _, _, _ = two_learners(harness)
    # the first learner's cookie with the SECOND learner's password: the check is against the
    # first account, so it fails, and the failure is counted under the first account's key
    for path, body in (
        ("/api/auth/password", {"currentPassword": WRONG, "newPassword": NEW_PASSWORD}),
        ("/api/auth/recovery/rotate", {"password": WRONG}),
        ("/api/account/delete", {"password": WRONG, "confirm": "DELETE"}),
    ):
        response = one.post(path, json=body)
        assert response.status_code == 401 and error_of(response)["code"] == "invalid_credentials"
    assert harness.store.account_exists(user_id_of(harness, SECOND))
    assert harness.store.account_exists(user_id_of(harness))


def test_failures_against_one_name_do_not_slow_another_name_from_another_prefix(
    harness: Harness,
) -> None:
    two_learners(harness)
    for _ in range(6):
        login(harness.new_client(address="192.0.2.99"), username="sample_user_01", password=WRONG)
    other_prefix = harness.new_client(address="203.0.114.9")
    assert login(other_prefix, username=SECOND, password=PASSWORD).status_code == 200


def test_no_operation_accepts_an_account_identifier(harness: Harness) -> None:
    one, two, _, _ = two_learners(harness)
    second_id = str(user_id_of(harness, SECOND))
    # the path, the query, a header and the body are all ignored or refused
    assert one.get("/api/me", params={"userId": second_id}).json()["username"] == "sample_user_01"
    assert (
        one.get("/api/me", headers={"X-User-Id": second_id}).json()["username"] == "sample_user_01"
    )
    for body in ({"userId": second_id}, {"language": "en", "user_id": second_id}):
        refused = one.patch("/api/me", json=body)
        assert refused.status_code == 422
        assert {item["rule"] for item in error_of(refused)["details"]["fields"]} == {
            "forbidden_field"
        }
    for path in ("/api/auth/password", "/api/auth/recovery/rotate", "/api/account/delete"):
        body: dict[str, Any] = {"password": PASSWORD, "userId": second_id, "confirm": "DELETE"}
        if path == "/api/auth/password":
            body = {"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD, "userId": second_id}
        assert one.post(path, json=body).status_code == 422
    assert two.get("/api/me").json()["username"] == SECOND  # untouched
    assert harness.provider.password_matches(user_id_of(harness, SECOND), PASSWORD)


def test_a_made_up_session_cookie_never_resolves_to_an_account(harness: Harness) -> None:
    two_learners(harness)
    stranger = harness.new_client()
    for value in (str(uuid4()).replace("-", "")[:43].ljust(43, "A"), "A" * 43, "_" * 43):
        stranger.cookies.set("qatra_session", value)
        assert stranger.get("/api/me").status_code == 401


def test_two_accounts_with_the_same_password_are_not_linked(harness: Harness) -> None:
    one, two, _, _ = two_learners(harness)
    assert change_password(one, new="a shared synthetic passphrase").status_code == 200
    assert change_password(two, new="a shared synthetic passphrase").status_code == 200
    one_id, two_id = user_id_of(harness), user_id_of(harness, SECOND)
    assert one_id != two_id
    shared = login(harness.new_client(), username=SECOND, password="a shared synthetic passphrase")
    assert shared.status_code == 200
    assert harness.provider.alias_of(one_id) != harness.provider.alias_of(two_id)
