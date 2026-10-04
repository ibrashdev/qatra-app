"""``PostgrestProfileStore`` over ``httpx.MockTransport``: profile reads and writes go to PostgREST
with the learner's OWN access token (row-level security), select only the caller's row, send only
the five updatable columns, and never leak tokens, bodies or library messages."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest

from app.config import StartupConfigError
from app.repositories.accounts import (
    PROFILE_COLUMNS,
    PostgrestProfileStore,
    ProfileMissing,
    ProfileRow,
    ProfileUnavailable,
    ProfileValueRejected,
)
from tests.support import make_settings

BASE = "https://project.example"
ANON = "anon-key-sentinel"
TOKEN = "learner-access-token-sentinel"
USER = UUID("11111111-1111-4111-8111-111111111111")

ROW = {
    "language": "en",
    "time_zone": "Asia/Dubai",
    "session_minutes": 15,
    "reminder_settings": {"inApp": False},
    "pending_settings": {"sessionMinutes": 5, "effectiveDate": "2026-10-05"},
    "terms_version": "2026-10-04",
    "terms_accepted_at": "2026-10-04T08:15:00.123456+00:00",
    "is_demo": False,
    "created_at": "2026-10-04T08:15:00+00:00",
}

Responder = Callable[[httpx.Request], httpx.Response]


def store(responder: Responder) -> tuple[PostgrestProfileStore, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return responder(request)

    return PostgrestProfileStore(BASE, ANON, transport=httpx.MockTransport(handler)), seen


def reply(status: int, body: object) -> Responder:
    return lambda request: httpx.Response(status, json=body)


def test_read_asks_for_the_callers_row_with_the_learners_token() -> None:
    profiles, seen = store(reply(200, [ROW]))
    row = profiles.read_profile(user_id=USER, access_token=TOKEN)
    request = seen[0]
    assert request.method == "GET" and request.url.path == "/rest/v1/profiles"
    assert dict(request.url.params) == {"select": PROFILE_COLUMNS, "user_id": f"eq.{USER}"}
    assert request.headers["apikey"] == ANON
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert row == ProfileRow(
        language="en",
        time_zone="Asia/Dubai",
        session_minutes=15,
        reminder_settings={"inApp": False},
        pending_settings={"sessionMinutes": 5, "effectiveDate": "2026-10-05"},
        terms_version="2026-10-04",
        terms_accepted_at=datetime(2026, 10, 4, 8, 15, 0, 123456, tzinfo=UTC),
        is_demo=False,
        created_at=datetime(2026, 10, 4, 8, 15, tzinfo=UTC),
    )


def test_the_selected_columns_are_exactly_the_profile_fields() -> None:
    assert PROFILE_COLUMNS.split(",") == [
        "language",
        "time_zone",
        "session_minutes",
        "reminder_settings",
        "pending_settings",
        "terms_version",
        "terms_accepted_at",
        "is_demo",
        "created_at",
    ]


def test_null_pending_settings_and_a_missing_reminder_object_read_as_none_and_empty() -> None:
    profiles, _ = store(reply(200, [{**ROW, "pending_settings": None, "reminder_settings": None}]))
    row = profiles.read_profile(user_id=USER, access_token=TOKEN)
    assert row.pending_settings is None and row.reminder_settings == {}


def test_a_timestamp_without_an_offset_is_read_as_utc() -> None:
    profiles, _ = store(reply(200, [{**ROW, "created_at": "2026-10-04T08:15:00"}]))
    assert profiles.read_profile(user_id=USER, access_token=TOKEN).created_at.tzinfo is UTC


def test_no_visible_row_is_a_missing_profile() -> None:
    profiles, _ = store(reply(200, []))
    with pytest.raises(ProfileMissing):
        profiles.read_profile(user_id=USER, access_token=TOKEN)
    with pytest.raises(ProfileMissing):
        profiles.read_terms_version(user_id=USER, access_token=TOKEN)


def test_the_terms_gate_reads_one_column() -> None:
    profiles, seen = store(reply(200, [{"terms_version": "2026-10-04"}]))
    assert profiles.read_terms_version(user_id=USER, access_token=TOKEN) == "2026-10-04"
    assert dict(seen[0].url.params)["select"] == "terms_version"


def test_update_patches_only_the_given_columns_and_asks_for_the_row_back() -> None:
    profiles, seen = store(reply(200, [ROW]))
    changes = {"language": "en", "pending_settings": None}
    row = profiles.update_profile(user_id=USER, access_token=TOKEN, changes=changes)
    request = seen[0]
    assert request.method == "PATCH" and request.url.path == "/rest/v1/profiles"
    assert dict(request.url.params)["user_id"] == f"eq.{USER}"
    assert request.headers["prefer"] == "return=representation"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert json.loads(request.content) == changes
    assert row.language == "en"


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"terms_version": "x"},
        {"terms_accepted_at": "2026-01-01T00:00:00Z"},
        {"is_demo": True},
        {"user_id": str(USER)},
        {"created_at": "2026-01-01T00:00:00Z"},
        {"language": "en", "is_demo": True},
    ],
)
def test_update_refuses_columns_a_learner_may_not_change_without_calling_the_service(
    changes: dict[str, object],
) -> None:
    profiles, seen = store(reply(200, [ROW]))
    with pytest.raises(ProfileUnavailable):
        profiles.update_profile(user_id=USER, access_token=TOKEN, changes=changes)
    assert seen == []


def test_the_time_zone_trigger_is_reported_as_a_rejected_value() -> None:
    profiles, _ = store(reply(400, {"code": "23514", "message": "profiles.time_zone ..."}))
    with pytest.raises(ProfileValueRejected):
        profiles.update_profile(user_id=USER, access_token=TOKEN, changes={"time_zone": "X/Y"})


def test_an_update_that_touches_no_visible_row_is_a_missing_profile() -> None:
    profiles, _ = store(reply(200, []))
    with pytest.raises(ProfileMissing):
        profiles.update_profile(user_id=USER, access_token=TOKEN, changes={"language": "en"})


@pytest.mark.parametrize("status", [400, 401, 403, 404, 406, 429, 500, 503])
def test_other_failures_are_unavailable(status: int) -> None:
    profiles, _ = store(reply(status, {"message": "nope", "code": "PGRST301"}))
    with pytest.raises(ProfileUnavailable):
        profiles.read_profile(user_id=USER, access_token=TOKEN)
    with pytest.raises(ProfileUnavailable):
        profiles.update_profile(user_id=USER, access_token=TOKEN, changes={"language": "en"})


@pytest.mark.parametrize(
    "answer",
    [
        {"not": "a list"},
        [{"language": "en"}],  # fields missing
        [{**ROW, "session_minutes": "ten"}],
        [{**ROW, "terms_accepted_at": "yesterday"}],
    ],
)
def test_a_malformed_answer_is_unavailable(answer: object) -> None:
    profiles, _ = store(reply(200, answer))
    with pytest.raises(ProfileUnavailable):
        profiles.read_profile(user_id=USER, access_token=TOKEN)


def test_an_unparsable_body_is_unavailable() -> None:
    profiles, _ = store(lambda request: httpx.Response(200, content=b"<html>"))
    with pytest.raises(ProfileUnavailable):
        profiles.read_profile(user_id=USER, access_token=TOKEN)


@pytest.mark.parametrize("token", [None, ""])
def test_without_a_token_nothing_is_sent(token: str | None) -> None:
    profiles, seen = store(reply(200, [ROW]))
    with pytest.raises(ProfileUnavailable):
        profiles.read_profile(user_id=USER, access_token=token)
    assert seen == []


def test_transport_failures_leak_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {BASE} with {TOKEN}")

    profiles, _ = store(boom)
    with pytest.raises(ProfileUnavailable) as raised:
        profiles.read_profile(user_id=USER, access_token=TOKEN)
    assert TOKEN not in str(raised.value) + repr(raised.value)
    assert raised.value.__cause__ is None and raised.value.__suppress_context__
    assert TOKEN not in "\n".join(caplog.messages)
    assert ANON not in repr(profiles) and TOKEN not in repr(profiles)


def test_from_settings() -> None:
    profiles = PostgrestProfileStore.from_settings(
        make_settings(SUPABASE_URL=f"{BASE}/", SUPABASE_ANON_KEY=ANON),
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[ROW])),
    )
    profiles.read_profile(user_id=USER, access_token=TOKEN)
    with pytest.raises(StartupConfigError) as raised:
        PostgrestProfileStore.from_settings(make_settings())
    assert "SUPABASE_URL" in str(raised.value) and "SUPABASE_ANON_KEY" in str(raised.value)
