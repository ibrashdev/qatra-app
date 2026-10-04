"""The wiring of the learning core: shared stores, ports, plan states, ownership and failures.

Each behaviour runs in memory and supabase mode where both can show it.
"""

from __future__ import annotations

import warnings
from datetime import timedelta
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import AppError, ErrorCode
from app.main import create_app
from app.repositories.learning import InMemoryLearningStore
from app.routers.sessions import install_sessions
from app.services.plan_access import (
    UNKNOWN_BANK_VERSION,
    PlanServiceAccess,
    PlanServiceCalendar,
    snapshot_of,
)
from tests.integration.core_support import (
    BUNDLES,
    NOW,
    PLACEMENT,
    TOKEN,
    Mode,
    daily,
    memory_mode,
    placement_attempt,
    questions,
    supabase_mode,
)
from tests.plans.plans_support import Clock, login_as, session_context
from tests.sessions.ss_support import HADITH_EDITION, OTHER_USER, QURAN_EDITION, USER
from tests.support import FRONTEND_ORIGIN, make_settings

GAME = {"kind": "game", "expectedPlanVersion": 1}


def code(response) -> str:
    return response.json()["error"]["code"]


def details(response) -> dict:
    return response.json()["error"]["details"]


@pytest.fixture(params=["memory", "supabase"])
def mode(request: pytest.FixtureRequest) -> Mode:
    return memory_mode() if request.param == "memory" else supabase_mode()[0]


def test_memory_mode_shares_one_store_between_sessions_and_the_placement_reader() -> None:
    app = create_app(make_settings(QATRA_CONTENT_BUNDLES=BUNDLES))
    store = app.state.learning_repository
    assert isinstance(store, InMemoryLearningStore)
    assert app.state.plan_service._placements is store
    assert app.state.sessions_service.learning is store


def test_the_state_of_the_plan_service_is_what_the_plan_routes_use() -> None:
    app = create_app(make_settings(QATRA_CONTENT_BUNDLES=BUNDLES))
    assert app.state.catalog_service is not None and app.state.plan_service is not None
    assert app.state.sessions_service is not None
    assert not hasattr(app.state, "plan_access") and not hasattr(app.state, "learning_calendar")


def test_one_session_route_however_often_the_sessions_are_installed() -> None:
    settings = make_settings()
    app = create_app(settings)
    install_sessions(app, settings)
    install_sessions(app, settings)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        paths = app.openapi()["paths"]
    assert set(paths["/api/sessions"]) == {"post"}
    assert [w for w in caught if "Duplicate" in str(w.message)] == []


def test_supabase_mode_builds_one_client_for_plans_and_sessions() -> None:
    mode_, project = supabase_mode()
    app = mode_.app
    plans = app.state.plan_service
    assert plans is not None and app.state.sessions_service is not None
    assert plans._plans._client is app.state.bank_repository._rest._client
    assert plans._plans._client is app.state.learning_repository._rest._client
    assert project.requests == []  # building the wiring reads nothing


def test_supabase_mode_without_a_project_answers_503_for_every_learning_endpoint() -> None:
    app = create_app(make_settings(QATRA_DATA_BACKEND="supabase"))
    assert app.state.sessions_service is None and app.state.plan_service is None
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    login_as(app, USER, token="t")
    estimate = {
        "editionId": str(QURAN_EDITION),
        "targetScope": {"sectionOrdinals": [1]},
        "paths": ["quran"],
        "sessionMinutes": 5,
    }
    assert client.get("/api/catalog").status_code == 503
    assert client.post("/api/plans/estimate", json=estimate).status_code == 503
    assert client.post("/api/sessions", json=PLACEMENT).status_code == 503


def test_the_calendar_follows_the_clock_and_the_profile_zone() -> None:
    clock = Clock(NOW)
    app = create_app(make_settings(QATRA_CONTENT_BUNDLES=BUNDLES), clock=clock)
    calendar = PlanServiceCalendar(app.state.plan_service)
    context = session_context(USER)
    assert calendar.learning_date(context).isoformat() == "2026-10-05"
    clock.now = NOW.replace(hour=19, minute=59)  # 23:59 in Asia/Dubai
    assert calendar.learning_date(context).isoformat() == "2026-10-05"
    clock.now += timedelta(minutes=1)  # local midnight starts a new learning day
    assert calendar.learning_date(context).isoformat() == "2026-10-06"


def test_the_plan_access_answers_not_found_for_an_unknown_or_foreign_plan() -> None:
    mode_ = memory_mode()
    plan = mode_.create_plan()
    access = PlanServiceAccess(mode_.app.state.plan_service)
    snapshot = access.load_for_session(session_context(USER), UUID(plan["planId"]))
    assert snapshot.plan_id == UUID(plan["planId"])
    for who, plan_id in ((OTHER_USER, UUID(plan["planId"])), (USER, UUID(int=5))):
        with pytest.raises(AppError) as raised:
            access.load_for_session(session_context(who), plan_id)
        assert raised.value.code is ErrorCode.not_found


def test_the_snapshot_carries_the_values_in_force_and_the_current_version_row() -> None:
    mode_ = memory_mode()
    plan = mode_.create_plan(minutes=5)
    mode_.post(f"/api/plans/{plan['planId']}/revise", {"expectedVersion": 1, "sessionMinutes": 15})
    access = PlanServiceAccess(mode_.app.state.plan_service)
    snapshot = access.load_for_session(session_context(USER), UUID(plan["planId"]))
    assert (snapshot.current_version, snapshot.session_minutes) == (2, 5)
    assert str(snapshot.plan_version_id) == mode_.version_id(plan["planId"], 2)
    assert snapshot.section_ordinals == (1, 2, 3) and snapshot.paths == ("quran",)
    assert snapshot.order == "book" and snapshot.status == "active"
    assert (snapshot.edition_id, snapshot.bank_version) == (QURAN_EDITION, 1)
    mode_.clock.now += timedelta(days=1)
    assert (
        access.load_for_session(session_context(USER), UUID(plan["planId"])).session_minutes == 15
    )


def test_an_edition_the_learner_can_no_longer_read_has_a_bank_version_nothing_matches() -> None:
    mode_, project = supabase_mode()
    plan = mode_.create_plan()
    project.plans.unreadable_editions.add(str(QURAN_EDITION))
    state = mode_.app.state.plan_service.plan_in_force(
        session_context(USER, token=TOKEN), UUID(plan["planId"])
    )
    assert state is not None and state.bank_version is None
    assert snapshot_of(state).bank_version == UNKNOWN_BANK_VERSION == 0


def test_an_unknown_plan_and_a_foreign_plan_are_the_same_404(mode: Mode) -> None:
    plan = mode.create_plan()
    mode.login(OTHER_USER)
    foreign = mode.post("/api/sessions", daily(plan["planId"], 1))
    unknown = mode.post("/api/sessions", daily(str(UUID(int=5)), 1))
    assert (foreign.status_code, code(foreign)) == (404, "not_found")
    assert foreign.json() == unknown.json()
    mode.login(USER)
    assert mode.post("/api/sessions", daily(plan["planId"], 1)).status_code == 201


def test_a_paused_plan_accepts_no_session_until_it_is_resumed(mode: Mode) -> None:
    first = mode.create_plan()
    mode.create_plan(sections=(1,))  # the newer plan pauses the first
    for body in (daily(first["planId"], 1), {**GAME, "kind": "game", "planId": first["planId"]}):
        response = mode.post("/api/sessions", body)
        assert (response.status_code, code(response)) == (409, "version_conflict")
        assert details(response) == {"reason": "plan_not_active"}
    assert mode.post(f"/api/plans/{first['planId']}/resume").status_code == 200
    assert mode.post("/api/sessions", daily(first["planId"], 1)).status_code == 201


def test_a_completed_plan_serves_no_game_session(mode: Mode) -> None:
    plan = mode.create_plan()
    mode.complete_plan(plan["planId"])
    game = mode.post("/api/sessions", {**GAME, "kind": "game", "planId": plan["planId"]})
    assert (game.status_code, code(game)) == (409, "version_conflict")
    assert details(game) == {"reason": "plan_not_active"}
    maintenance = mode.post("/api/sessions", daily(plan["planId"], 1))
    assert maintenance.status_code == 201 and questions(maintenance.json()) == []


def test_a_revoked_edition_is_not_served_to_an_existing_plan(mode: Mode) -> None:
    plan = mode.create_plan()
    mode.revoke_edition()
    response = mode.post("/api/sessions", daily(plan["planId"], 1))
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert details(response) == {"fields": [{"field": "planId", "rule": "edition_not_available"}]}
    placement = mode.post("/api/sessions", PLACEMENT)
    assert details(placement)["fields"][0]["field"] == "editionId"


def test_a_placement_session_of_another_edition_is_not_found_by_the_estimate(mode: Mode) -> None:
    session = mode.post("/api/sessions", PLACEMENT).json()
    body = {
        "editionId": str(HADITH_EDITION),
        "targetScope": {"sectionOrdinals": [1]},
        "paths": ["matn"],
        "sessionMinutes": 5,
        "placementSessionId": session["sessionId"],
    }
    response = mode.post("/api/plans/estimate", body)
    assert (response.status_code, code(response)) == (404, "not_found")


def test_the_estimate_of_a_second_learner_does_not_see_the_first_ones_placement() -> None:
    """Memory mode; in supabase mode the read filters by ``user_id`` (B4's tests pin that)."""
    mode = memory_mode()
    session = mode.post("/api/sessions", PLACEMENT).json()
    by_passage = {q["passageId"]: q for q in questions(session)}
    mode.seed_attempt(placement_attempt(session, next(iter(by_passage.values())), correct=True))
    body = {
        "editionId": str(QURAN_EDITION),
        "targetScope": {"sectionOrdinals": [1, 2, 3]},
        "paths": ["quran"],
        "sessionMinutes": 5,
        "placementSessionId": session["sessionId"],
    }
    assert mode.post("/api/plans/estimate", body).status_code == 200
    mode.login(OTHER_USER)
    assert mode.post("/api/plans/estimate", body).status_code == 404


def test_without_a_session_the_endpoint_is_unauthenticated() -> None:
    app: FastAPI = create_app(make_settings(QATRA_CONTENT_BUNDLES=BUNDLES))
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    response = client.post("/api/sessions", json=PLACEMENT)
    assert (response.status_code, code(response)) == (401, "unauthenticated")
