"""E05 ``POST /api/auth/consent`` (API-spec §4.2): recording acceptance of the current terms after a
change, idempotently, with nothing but the version and the server time stored (D52)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.routers.auth import RateLimits
from tests.auth.auth_support import (
    USERNAME,
    Harness,
    build_harness,
    error_of,
    login,
    register,
)

NEW_TERMS = "2026-12-01"


def consent(client: TestClient, version: str = NEW_TERMS) -> Any:
    return client.post("/api/auth/consent", json={"termsVersion": version})


def after_a_terms_change(harness: Harness) -> tuple[Harness, TestClient]:
    """A new deployment with a new ``TERMS_VERSION``; the learner signs in and must re-consent."""
    changed = harness.restart(TERMS_VERSION=NEW_TERMS)
    client = changed.new_client()
    assert login(client).json()["reconsentRequired"] is True
    return changed, client


def test_consent_records_the_new_version_and_the_server_time(signed_in: Harness) -> None:
    changed, client = after_a_terms_change(signed_in)
    changed.clock.advance(hours=1)
    response = consent(client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    profile = response.json()["profile"]
    assert set(response.json()) == {"profile"}
    assert profile["termsVersion"] == NEW_TERMS
    assert profile["termsAcceptedAt"] == "2026-10-04T09:15:00Z"  # the server clock, not the client
    assert profile["createdAt"] == "2026-10-04T08:15:00Z"  # untouched
    row = changed.store.read_profile(user_id=_user(changed), access_token=None)
    assert (row.terms_version, row.terms_accepted_at) == (NEW_TERMS, changed.clock.now)


def _user(harness: Harness) -> Any:
    from tests.auth.auth_support import user_id_of

    return user_id_of(harness)


def test_after_consent_the_gated_operations_work_again(signed_in: Harness) -> None:
    changed, client = after_a_terms_change(signed_in)
    assert client.patch("/api/me", json={"language": "en"}).status_code == 400
    assert consent(client).status_code == 200
    assert client.patch("/api/me", json={"language": "en"}).status_code == 200
    assert login(changed.new_client()).json()["reconsentRequired"] is False


def test_repeating_the_consent_returns_the_unchanged_profile_without_a_write(
    signed_in: Harness,
) -> None:
    changed, client = after_a_terms_change(signed_in)
    first = consent(client).json()
    changed.clock.advance(days=3)
    second = consent(client).json()
    assert second == first  # the acceptance time did not move
    assert second["profile"]["termsAcceptedAt"] == "2026-10-04T08:15:00Z"


def test_consenting_to_the_version_already_accepted_changes_nothing(signed_in: Harness) -> None:
    signed_in.clock.advance(hours=5)
    response = consent(signed_in.client, "2026-10-04")
    assert response.status_code == 200
    assert response.json()["profile"]["termsAcceptedAt"] == "2026-10-04T08:15:00Z"


@pytest.mark.parametrize("version", ["2026-10-04", "", "2027-01-01", " 2026-12-01", "latest"])
def test_only_the_current_version_can_be_accepted(signed_in: Harness, version: str) -> None:
    changed, client = after_a_terms_change(signed_in)
    response = consent(client, version)
    assert response.status_code == 400
    assert error_of(response)["code"] == "terms_required"
    assert error_of(response)["details"] == {"requiredVersion": NEW_TERMS}
    row = changed.store.read_profile(user_id=_user(changed), access_token=None)
    assert row.terms_version == "2026-10-04"  # nothing was recorded


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({}, [("termsVersion", "required")]),
        ({"termsVersion": 20261201}, [("termsVersion", "string_type")]),
        ({"termsVersion": None}, [("termsVersion", "string_type")]),
        ({"termsVersion": NEW_TERMS, "isDemo": True}, [("isDemo", "forbidden_field")]),
    ],
)
def test_the_body_is_strict(
    signed_in: Harness, body: dict[str, Any], expected: list[tuple[str, str]]
) -> None:
    response = signed_in.client.post("/api/auth/consent", json=body)
    assert response.status_code == 422
    fields = [(f["field"], f["rule"]) for f in error_of(response)["details"]["fields"]]
    assert fields == expected


def test_consent_needs_a_session_and_the_frontend_origin(signed_in: Harness) -> None:
    stranger = signed_in.new_client()
    unauthenticated = consent(stranger, "2026-10-04")
    assert unauthenticated.status_code == 401
    assert error_of(unauthenticated)["code"] == "unauthenticated"
    wrong = signed_in.client.post(
        "/api/auth/consent",
        json={"termsVersion": "2026-10-04"},
        headers={"Origin": "https://evil.example"},
    )
    assert wrong.status_code == 403 and error_of(wrong)["code"] == "forbidden_origin"


def test_a_demo_account_consents_like_any_other(harness: Harness) -> None:
    demo = harness.auth.register_account(
        username="demo_learner",
        password="synthetic passphrase for tests only",
        time_zone="Asia/Dubai",
        language="en",
        terms_accepted=True,
        terms_version="2026-10-04",
        is_demo=True,
    )
    changed = harness.restart(TERMS_VERSION=NEW_TERMS)
    client = changed.new_client()
    client.cookies.set("qatra_session", demo.cookie_value)
    response = consent(client)
    assert response.status_code == 200 and response.json()["profile"]["isDemo"] is True


def test_nothing_but_the_version_and_the_time_is_recorded(signed_in: Harness) -> None:
    changed, client = after_a_terms_change(signed_in)
    before = changed.store.read_profile(user_id=_user(changed), access_token=None)
    changed.clock.advance(minutes=5)
    consent(client)
    after = changed.store.read_profile(user_id=_user(changed), access_token=None)
    differing = {name for name in before.__slots__ if getattr(before, name) != getattr(after, name)}
    assert differing == {"terms_version", "terms_accepted_at"}


def test_consent_is_a_session_write_for_the_per_ip_limit() -> None:
    harness = build_harness(rate_limits=RateLimits(session_write_per_min=2))
    with harness.client:
        register(harness.client)
        assert consent(harness.client, "2026-10-04").status_code == 200
        assert consent(harness.client, "2026-10-04").status_code == 200
        limited = consent(harness.client, "2026-10-04")
        assert limited.status_code == 429 and "retry-after" in limited.headers
        assert USERNAME  # the account itself is untouched
