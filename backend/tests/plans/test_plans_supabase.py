"""Supabase mode end to end through a fake PostgREST (``httpx.MockTransport``; no network).

The catalog is read with the anon key over the two views only; everything of the learner is read
and written with the learner's access token (row-level security) and plan writes go through
``app_create_plan``, ``app_revise_plan`` and ``app_resume_plan`` only. Nothing here was run against
a real Supabase project: the fake replays the documented signatures and error codes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.domain.planning_port import PlanNotActive
from app.main import create_app
from app.providers.postgrest import PostgrestClient
from app.repositories.catalog import MemoryContent
from app.repositories.plans import PostgrestPlanRepository
from app.services.plans import PlanningServices, build_planning_services
from tests.plans.fake_postgrest import (
    ACTIVE_KEY_MESSAGE,
    ANON_KEY,
    SECRET_TEXT,
    SERVICE_ROLE_KEY,
    FakePostgrest,
    db_error,
)
from tests.plans.plans_support import (
    EXAMPLE_ALTERNATIVES,
    EXAMPLE_ESTIMATE,
    HADITH_ID,
    OTHER_USER_ID,
    PLACEMENT_ID,
    QURAN_ID,
    UNKNOWN_ID,
    USER_ID,
    Clock,
    browser,
    code,
    create_body,
    details,
    estimate_body,
    hadith_bundle,
    login_as,
    make_env,
    pid,
    quran_bundle,
    session_context,
)
from tests.support import make_settings

TOKEN = "learner-access-token-value"
OTHER_TOKEN = "other-learner-access-token"
PROJECT = "https://project.example"
CATALOG_PATHS = {"/catalog_editions", "/catalog_sections"}


@dataclass
class Supa:
    app: Any
    fake: FakePostgrest
    services: PlanningServices
    clock: Clock

    def client(self, user: UUID = USER_ID, token: str | None = TOKEN, *, demo: bool = False):
        login_as(self.app, user, demo=demo, token=token)
        return browser(self.app)

    def plan_id(self, plan: dict[str, Any]) -> str:
        return plan["planId"]


@pytest.fixture
def supa() -> Supa:
    content = MemoryContent.from_bundles([quran_bundle(), hadith_bundle()])
    entries = [
        (content.edition(edition.edition_id), content.passages(edition.edition_id))
        for edition in content.editions()
    ]
    fake = FakePostgrest(entries)
    fake.add_user(USER_ID, TOKEN)
    fake.add_user(OTHER_USER_ID, OTHER_TOKEN)
    # pid(1): correct and unassisted (known); pid(2): wrong; pid(3): correct but with a hint
    fake.add_placement(
        USER_ID,
        PLACEMENT_ID,
        QURAN_ID,
        [(pid(1), True, False), (pid(2), False, False), (pid(3), True, True)],
    )
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL=PROJECT,
        SUPABASE_ANON_KEY=ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY=SERVICE_ROLE_KEY,
    )
    clock = Clock()
    services = build_planning_services(settings, clock=clock, transport=fake.transport())
    app = create_app(settings)
    app.state.catalog_service = services.catalog
    app.state.plan_service = services.plans
    return Supa(app, fake, services, clock)


def post_plan(client: TestClient, body: dict[str, Any] | None = None) -> dict[str, Any]:
    response = client.post("/api/plans", json=body or create_body())
    assert response.status_code == 201, response.text
    return response.json()


# --- reads ---------------------------------------------------------------------------------------


def test_e15_over_postgrest_reproduces_the_example(supa: Supa) -> None:
    response = supa.client().post("/api/plans/estimate", json=estimate_body())
    assert response.status_code == 200
    assert response.json() == {
        "estimate": EXAMPLE_ESTIMATE,
        "alternatives": EXAMPLE_ALTERNATIVES,
        "reasonCode": "fits_preferred_date",
    }


def test_a_known_passage_is_one_answered_correctly_and_without_a_hint(supa: Supa) -> None:
    supa.client().post("/api/plans/estimate", json=estimate_body())
    attempts = supa.fake.calls_to("/attempts")[0]
    assert attempts.params["correct"] == "eq.true" and attempts.params["assisted"] == "eq.false"
    assert attempts.params["session_id"] == f"eq.{PLACEMENT_ID}"
    assert attempts.params["user_id"] == f"eq.{USER_ID}"


def test_the_learner_reads_use_the_token_and_the_catalog_reads_use_none(supa: Supa) -> None:
    client = supa.client()
    client.post("/api/plans/estimate", json=estimate_body())
    post_plan(client)
    paths = {call.path for call in supa.fake.calls}
    assert {
        "/profiles",
        "/passages",
        "/learning_sessions",
        "/attempts",
        "/rpc/app_create_plan",
    } <= paths
    assert CATALOG_PATHS <= paths
    for call in supa.fake.calls:
        assert call.headers["apikey"] == ANON_KEY
        if call.path in CATALOG_PATHS:
            assert "authorization" not in call.headers  # E14's anon role, no session
        else:
            assert call.headers["authorization"] == f"Bearer {TOKEN}"
        assert SERVICE_ROLE_KEY not in call.headers.values() and SERVICE_ROLE_KEY not in str(
            call.body
        )


def test_the_profile_passage_and_plan_reads_are_scoped_to_the_session_user(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    assert supa.fake.calls_to("/profiles")[0].params["user_id"] == f"eq.{USER_ID}"
    passages = supa.fake.calls_to("/passages")[0]
    assert (
        passages.params["edition_id"] == f"eq.{QURAN_ID}"
        and passages.params["bank_version"] == "eq.1"
    )
    read = supa.fake.calls_to("/master_plans")[0]
    assert read.params["id"] == f"eq.{plan['planId']}" and read.params["user_id"] == f"eq.{USER_ID}"
    assert "book_editions(books(title_ar,title_en))" in read.params["select"]


def test_a_pending_time_zone_applies_from_its_effective_date(supa: Supa) -> None:
    supa.fake.add_user(
        USER_ID,
        TOKEN,
        time_zone="Asia/Dubai",
        pending={"timeZone": "Pacific/Honolulu", "effectiveDate": "2026-10-05"},
    )
    supa.clock.now = datetime(2026, 10, 4, 21, 0, tzinfo=UTC)  # 5 October in Dubai
    response = supa.client().post(
        "/api/plans/estimate", json=estimate_body(placementSessionId=None)
    )
    assert response.json()["estimate"]["endDate"] == "2026-10-22"  # 4 October (Honolulu) + 18 days


@pytest.mark.parametrize("kind", ["unknown", "foreign", "game", "other_edition"])
def test_a_placement_that_is_not_usable_is_404_over_postgrest(supa: Supa, kind: str) -> None:
    session = UUID("33333333-3333-4333-8333-0000000000a1")
    if kind == "foreign":
        supa.fake.add_placement(OTHER_USER_ID, session, QURAN_ID, [(pid(1), True, False)])
    elif kind == "game":
        supa.fake.add_placement(USER_ID, session, QURAN_ID, [(pid(1), True, False)], kind="game")
    elif kind == "other_edition":
        supa.fake.add_placement(USER_ID, session, HADITH_ID, [(pid(11), True, False)])
    else:
        session = UNKNOWN_ID
    response = supa.client().post(
        "/api/plans/estimate", json=estimate_body(placementSessionId=str(session))
    )
    assert (response.status_code, code(response)) == (404, "not_found")
    assert (
        response.json()
        == supa.client()
        .post("/api/plans/estimate", json=estimate_body(placementSessionId=str(UNKNOWN_ID)))
        .json()
    )


# --- E16 -----------------------------------------------------------------------------------------


def test_e16_calls_app_create_plan_with_the_documented_arguments(supa: Supa) -> None:
    plan = post_plan(supa.client())
    [call] = supa.fake.calls_to("/rpc/app_create_plan")
    assert call.method == "POST"
    arguments = call.body
    assert set(arguments) == {
        "p_edition_id",
        "p_target_scope",
        "p_paths",
        "p_plan_order",
        "p_session_minutes",
        "p_preferred_date",
        "p_agreed_estimate",
        "p_reason_code",
        "p_policy_json",
        "p_effective_learning_date",
        "p_phases",
        "p_sessions",
        "p_plan_id",
    }
    assert arguments["p_edition_id"] == str(QURAN_ID)
    assert arguments["p_target_scope"] == {"sectionOrdinals": [1, 2]}
    assert (arguments["p_paths"], arguments["p_plan_order"]) == (["quran"], "book")
    assert (arguments["p_session_minutes"], arguments["p_preferred_date"]) == (5, "2026-10-20")
    assert arguments["p_agreed_estimate"] == EXAMPLE_ESTIMATE
    assert arguments["p_reason_code"] == "plan_created"
    assert arguments["p_effective_learning_date"] == "2026-10-04"
    assert arguments["p_sessions"] is None and arguments["p_plan_id"] is None
    assert arguments["p_policy_json"]["knownPassages"] == {
        "placementSessionId": str(PLACEMENT_ID),
        "passageIds": [str(pid(1))],
    }
    assert [row["estimated_window"] for row in arguments["p_phases"]] == [
        "[2026-10-04,2026-10-12)",
        "[2026-10-12,2026-10-20)",
    ]
    assert [row["goal_size"] for row in arguments["p_phases"]] == [100, 80]
    assert plan["currentVersion"] == 1 and plan["status"] == "active"
    assert (plan["titleAr"], plan["titleEn"]) == ("«عنوان الكتاب»", "Book title placeholder")
    assert plan["agreedEstimate"] == EXAMPLE_ESTIMATE and plan["planner"] == {"source": "rules"}
    assert plan["createdAt"] == "2026-10-04T09:00:00Z"  # microseconds dropped


def test_e16_over_postgrest_pauses_the_previous_plan_in_the_database_function(supa: Supa) -> None:
    client = supa.client()
    first = post_plan(client)
    estimate = client.post(
        "/api/plans/estimate",
        json=estimate_body(targetScope={"sectionOrdinals": [3]}, placementSessionId=None),
    ).json()["estimate"]
    second = post_plan(
        client,
        estimate_body(targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
        | {"confirmedEstimate": estimate},
    )
    statuses = {row["id"]: row["status"] for row in supa.fake.plans.values()}
    assert statuses == {first["planId"]: "paused", second["planId"]: "active"}


def test_e16_a_changed_estimate_never_reaches_the_database(supa: Supa) -> None:
    response = supa.client().post(
        "/api/plans", json=create_body(confirmedEstimate=dict(EXAMPLE_ESTIMATE, days=3))
    )
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response)["reason"] == "estimate_changed"
    assert supa.fake.calls_to("/rpc/app_create_plan") == [] and supa.fake.plans == {}


def test_e16_demo_account_is_refused_before_any_database_call(supa: Supa) -> None:
    response = supa.client(demo=True).post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (403, "forbidden")
    assert supa.fake.calls == []


def test_e16_race_on_the_one_active_plan_index_is_409_active_plan_conflict(supa: Supa) -> None:
    supa.fake.fail("rpc/app_create_plan", db_error(409, "23505", ACTIVE_KEY_MESSAGE))
    response = supa.client().post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "active_plan_conflict"}
    assert SECRET_TEXT not in response.text


def test_another_unique_violation_is_an_internal_error(supa: Supa) -> None:
    other = 'duplicate key value violates unique constraint "master_plans_pkey"'
    supa.fake.fail("rpc/app_create_plan", db_error(409, "23505", other))
    response = supa.client().post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (500, "internal")
    assert SECRET_TEXT not in response.text


@pytest.mark.parametrize(
    "answer,status,error",
    [
        (db_error(400, "QT002"), 500, "internal"),
        (db_error(400, "23514"), 500, "internal"),
        (db_error(404, "PGRST202"), 500, "internal"),
        (db_error(401, "PGRST301", "JWT expired"), 401, "unauthenticated"),
        (db_error(403, "42501", "not authenticated"), 401, "unauthenticated"),
        (httpx.Response(503, text="gateway"), 503, "unavailable"),
        (db_error(500, "57014"), 503, "unavailable"),
        (httpx.ReadTimeout("slow"), 503, "unavailable"),
        (httpx.ConnectError("refused"), 503, "unavailable"),
    ],
)
def test_e16_database_failures_map_to_the_error_envelope(
    supa: Supa, answer: httpx.Response | Exception, status: int, error: str
) -> None:
    supa.fake.fail("rpc/app_create_plan", answer)
    response = supa.client().post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (status, error)
    for private in (SECRET_TEXT, "refused", "slow", "gateway", TOKEN, ANON_KEY):
        assert private not in response.text
    assert supa.fake.plans == {}  # a failed write left nothing behind
    assert len(supa.fake.calls_to("/rpc/app_create_plan")) == 1  # never retried


def test_a_missing_access_token_is_unauthenticated_and_calls_nothing(supa: Supa) -> None:
    client = supa.client(token=None)
    for path, body in (("/api/plans/estimate", estimate_body()), ("/api/plans", create_body())):
        response = client.post(path, json=body)
        assert (response.status_code, code(response)) == (401, "unauthenticated")
    assert client.post(f"/api/plans/{UNKNOWN_ID}/resume").status_code == 401
    assert supa.fake.calls == []


def test_an_expired_access_token_is_unauthenticated(supa: Supa) -> None:
    response = supa.client(token="expired-token").post("/api/plans/estimate", json=estimate_body())
    assert (response.status_code, code(response)) == (401, "unauthenticated")


def test_a_database_outage_on_a_read_is_503(supa: Supa) -> None:
    supa.fake.fail("profiles", httpx.ReadTimeout("slow"))
    response = supa.client().post("/api/plans/estimate", json=estimate_body())
    assert (response.status_code, code(response)) == (503, "unavailable")
    supa.fake.fail("catalog_sections", httpx.ConnectError("refused"))
    response = supa.client().post("/api/plans/estimate", json=estimate_body())
    assert (response.status_code, code(response)) == (503, "unavailable")


def test_phases_that_would_not_cover_the_scope_are_never_saved(supa: Supa) -> None:
    """The catalog says 180 words but the passage table shows less (a drifted bank, or a passage
    the learner may not read): the plan is refused instead of saved with a hole."""
    rows = [
        row
        for row in supa.fake._select_rows("passages")
        if row["id"] != str(pid(2))  # the 80-word passage of section 1 is missing
    ]
    supa.fake.fail("passages", httpx.Response(200, json=rows))
    response = supa.client().post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (500, "internal")
    assert supa.fake.calls_to("/rpc/app_create_plan") == [] and supa.fake.plans == {}


def test_a_plan_row_of_the_wrong_shape_is_an_internal_error(supa: Supa) -> None:
    client = supa.client()
    supa.fake.fail("master_plans", httpx.Response(200, json=[{"id": "x"}]))
    response = client.post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (500, "internal")


# --- E17 -----------------------------------------------------------------------------------------


def test_e17_calls_app_revise_plan_with_the_documented_arguments(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    response = client.post(
        f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
    )
    assert response.status_code == 200 and response.json()["currentVersion"] == 2
    [call] = supa.fake.calls_to("/rpc/app_revise_plan")
    arguments = call.body
    assert set(arguments) == {
        "p_plan_id",
        "p_expected_version",
        "p_target_scope",
        "p_paths",
        "p_plan_order",
        "p_session_minutes",
        "p_preferred_date",
        "p_agreed_estimate",
        "p_reason_code",
        "p_policy_json",
        "p_effective_learning_date",
        "p_phases",
    }
    assert arguments["p_plan_id"] == plan["planId"] and arguments["p_expected_version"] == 1
    assert arguments["p_session_minutes"] == 10
    assert arguments["p_agreed_estimate"] == EXAMPLE_ESTIMATE  # unchanged without confirmation
    assert arguments["p_reason_code"] == "plan_revised"
    assert arguments["p_effective_learning_date"] == "2026-10-05"
    assert arguments["p_target_scope"] == {"sectionOrdinals": [1, 2]}
    assert call.headers["authorization"] == f"Bearer {TOKEN}"
    # the placement is read again, so the proposal and the commit agree on the known words
    assert len(supa.fake.calls_to("/attempts")) == 1 + 1


def test_e17_a_stale_version_is_caught_before_the_database(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    response = client.post(
        f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 3, "sessionMinutes": 10}
    )
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_version", "currentVersion": 1}
    assert supa.fake.calls_to("/rpc/app_revise_plan") == []


def test_e17_a_version_conflict_signalled_by_the_function_reports_the_current_version(
    supa: Supa,
) -> None:
    client = supa.client()
    plan = post_plan(client)

    def another_request_revised_the_plan() -> httpx.Response:
        supa.fake.plans[plan["planId"]]["current_version"] = 5  # between our read and our write
        return db_error(400, "QT002", "version_conflict")

    supa.fake.fail("rpc/app_revise_plan", another_request_revised_the_plan)
    response = client.post(
        f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
    )
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_version", "currentVersion": 5}
    assert SECRET_TEXT not in response.text
    assert len(supa.fake.calls_to("/rpc/app_revise_plan")) == 1  # never retried


def test_e17_a_plan_that_vanishes_between_read_and_write_is_404(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    supa.fake.fail("rpc/app_revise_plan", db_error(500, "P0002", "plan_not_found"))
    response = client.post(
        f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
    )
    assert (response.status_code, code(response)) == (404, "not_found")


def test_e17_a_completed_plan_is_409_before_the_database(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    supa.fake.plans[plan["planId"]]["status"] = "completed"
    response = client.post(
        f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
    )
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_not_active"}
    assert supa.fake.calls_to("/rpc/app_revise_plan") == []


def test_e17_a_plan_completed_between_read_and_write_is_409_from_the_function(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)

    def another_request_completed_the_plan() -> httpx.Response:
        supa.fake.plans[plan["planId"]]["status"] = "completed"  # between our read and our write
        return db_error(400, "QT003", "plan_not_active")

    supa.fake.fail("rpc/app_revise_plan", another_request_completed_the_plan)
    response = client.post(
        f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
    )
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_not_active"}
    assert SECRET_TEXT not in response.text
    assert len(supa.fake.calls_to("/rpc/app_revise_plan")) == 1  # never retried


def test_the_repository_maps_the_functions_completed_plan_signal(supa: Supa) -> None:
    plan = post_plan(supa.client())
    ctx = session_context(token=TOKEN)
    commit = supa.services.plans.prepare_revision(
        ctx, UUID(plan["planId"]), expected_version=1, session_minutes=10
    )
    supa.fake.plans[plan["planId"]]["status"] = "completed"
    repository = PostgrestPlanRepository(
        PostgrestClient(PROJECT, ANON_KEY, transport=supa.fake.transport())
    )
    for expected_version in (1, 9):  # the function tests the status before the version
        with pytest.raises(PlanNotActive):
            repository.revise_plan(ctx, UUID(plan["planId"]), expected_version, commit)
    assert len(supa.fake.versions) == 1  # nothing was written


def test_e17_unknown_and_foreign_plans_are_404_without_a_write(supa: Supa) -> None:
    plan = post_plan(supa.client())
    body = {"expectedVersion": 1, "sessionMinutes": 10}
    foreign = supa.client(OTHER_USER_ID, OTHER_TOKEN).post(
        f"/api/plans/{plan['planId']}/revise", json=body
    )
    unknown = supa.client().post(f"/api/plans/{UNKNOWN_ID}/revise", json=body)
    assert (foreign.status_code, code(foreign)) == (404, "not_found")
    assert foreign.json() == unknown.json()
    assert supa.fake.calls_to("/rpc/app_revise_plan") == []


def test_e17_a_paused_plan_stays_paused(supa: Supa) -> None:
    client = supa.client()
    first = post_plan(client)
    estimate = client.post(
        "/api/plans/estimate",
        json=estimate_body(targetScope={"sectionOrdinals": [3]}, placementSessionId=None),
    ).json()["estimate"]
    post_plan(
        client,
        estimate_body(targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
        | {"confirmedEstimate": estimate},
    )
    response = client.post(
        f"/api/plans/{first['planId']}/revise", json={"expectedVersion": 1, "order": "reverse"}
    )
    assert response.status_code == 200
    assert (response.json()["status"], response.json()["order"]) == ("paused", "reverse")


def test_e17_the_estimate_is_checked_against_the_stored_placement(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    fresh = client.post("/api/plans/estimate", json=estimate_body(sessionMinutes=10)).json()[
        "estimate"
    ]
    ok = client.post(
        f"/api/plans/{plan['planId']}/revise",
        json={"expectedVersion": 1, "sessionMinutes": 10, "confirmedEstimate": fresh},
    )
    assert ok.status_code == 200 and ok.json()["agreedEstimate"] == fresh
    stale = client.post(
        f"/api/plans/{plan['planId']}/revise",
        json={"expectedVersion": 2, "sessionMinutes": 15, "confirmedEstimate": fresh},
    )
    assert (stale.status_code, code(stale)) == (409, "version_conflict")
    assert details(stale)["reason"] == "estimate_changed"


# --- E30 -----------------------------------------------------------------------------------------


def test_e30_calls_app_resume_plan(supa: Supa) -> None:
    client = supa.client()
    first = post_plan(client)
    estimate = client.post(
        "/api/plans/estimate",
        json=estimate_body(targetScope={"sectionOrdinals": [3]}, placementSessionId=None),
    ).json()["estimate"]
    second = post_plan(
        client,
        estimate_body(targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
        | {"confirmedEstimate": estimate},
    )
    response = client.post(f"/api/plans/{first['planId']}/resume")
    assert response.status_code == 200 and response.json()["status"] == "active"
    [call] = supa.fake.calls_to("/rpc/app_resume_plan")
    assert call.body == {"p_plan": first["planId"]}
    assert call.headers["authorization"] == f"Bearer {TOKEN}"
    statuses = {row["id"]: row["status"] for row in supa.fake.plans.values()}
    assert statuses == {first["planId"]: "active", second["planId"]: "paused"}


def test_e30_an_active_plan_is_returned_unchanged(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    response = client.post(f"/api/plans/{plan['planId']}/resume")
    assert response.status_code == 200 and response.json() == plan


@pytest.mark.parametrize(
    "answer,status,error,reason",
    [
        (db_error(500, "P0002", "plan_not_found"), 404, "not_found", None),
        (db_error(400, "QT003", "invalid_state"), 409, "version_conflict", "plan_not_active"),
        (
            db_error(409, "23505", ACTIVE_KEY_MESSAGE),
            409,
            "version_conflict",
            "active_plan_conflict",
        ),
        (db_error(400, "22023"), 500, "internal", None),
        (httpx.ConnectError("refused"), 503, "unavailable", None),
    ],
)
def test_e30_database_signals(
    supa: Supa, answer: httpx.Response | Exception, status: int, error: str, reason: str | None
) -> None:
    client = supa.client()
    plan = post_plan(client)
    supa.fake.fail("rpc/app_resume_plan", answer)
    response = client.post(f"/api/plans/{plan['planId']}/resume")
    assert (response.status_code, code(response)) == (status, error)
    if reason:
        assert details(response) == {"reason": reason}
    assert SECRET_TEXT not in response.text and "refused" not in response.text


def test_e30_a_completed_plan_is_409_from_the_function(supa: Supa) -> None:
    client = supa.client()
    plan = post_plan(client)
    supa.fake.plans[plan["planId"]]["status"] = "completed"
    response = client.post(f"/api/plans/{plan['planId']}/resume")
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_not_active"}


def test_e30_demo_account_is_refused_before_any_database_call(supa: Supa) -> None:
    response = supa.client(demo=True).post(f"/api/plans/{UNKNOWN_ID}/resume")
    assert (response.status_code, code(response)) == (403, "forbidden")
    assert supa.fake.calls == []


# --- the two modes answer alike ------------------------------------------------------------------


def test_memory_and_supabase_modes_give_the_same_answers(supa: Supa, tmp_path: Path) -> None:
    memory = make_env(tmp_path, quran_bundle(), hadith_bundle())
    memory.seed_placement(known=(pid(1),))
    login_as(memory.app)
    memory_client = browser(memory.app)
    supa_client = supa.client()
    body = estimate_body()
    assert (
        memory_client.post("/api/plans/estimate", json=body).json()
        == supa_client.post("/api/plans/estimate", json=body).json()
    )
    created_memory = memory_client.post("/api/plans", json=create_body()).json()
    created_supa = supa_client.post("/api/plans", json=create_body()).json()
    assert {k: v for k, v in created_memory.items() if k != "planId"} == {
        k: v for k, v in created_supa.items() if k != "planId"
    }
    change = {"expectedVersion": 1, "sessionMinutes": 10, "preferredDate": None}
    revised_memory = memory_client.post(
        f"/api/plans/{created_memory['planId']}/revise", json=change
    )
    revised_supa = supa_client.post(f"/api/plans/{created_supa['planId']}/revise", json=change)
    assert {k: v for k, v in revised_memory.json().items() if k != "planId"} == {
        k: v for k, v in revised_supa.json().items() if k != "planId"
    }
    assert memory_client.get("/api/catalog").json() == supa_client.get("/api/catalog").json()
