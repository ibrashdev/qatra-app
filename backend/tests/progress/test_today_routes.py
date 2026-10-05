"""E18 ``GET /api/today`` and E19 ``GET /api/progress`` over HTTP: the session guard, the read
limiter, the headers, the shape of the answers and privacy. Every scenario runs over the memory
repositories and over the PostgREST adapters."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.dependencies import require_session
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import AppError, ErrorCode
from app.main import create_app
from app.routers.sessions import install_sessions
from tests.sessions.ss_events_support import (
    FIRST_PASSAGE,
    MODES,
    World,
    activity_event,
    answer_event,
)
from tests.sessions.ss_support import PLAN_B_ID, PLAN_ID, QURAN
from tests.support import FRONTEND_ORIGIN, make_settings

PATHS = ("/api/today", "/api/progress")


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    """The Quran plan is the only active plan (the hadith plan is paused)."""
    world = World(request.param)
    world.plans.update(PLAN_B_ID, status="paused")
    return world


def error_body(response) -> dict[str, Any]:
    assert response.headers["cache-control"] == "no-store"
    return response.json()["error"]


# --- guards --------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", PATHS)
def test_without_a_session_the_answer_is_unauthenticated(world: World, path: str) -> None:
    response = world.client(login=False).get(path)
    assert response.status_code == 401 and error_body(response)["code"] == "unauthenticated"


@pytest.mark.parametrize("path", PATHS)
def test_a_read_needs_no_origin_header(world: World, path: str) -> None:
    with TestClient(world.app()) as bare:  # a plain GET, as a browser navigation or a monitor
        assert bare.get(path).status_code == 200


@pytest.mark.parametrize("path", PATHS)
def test_the_operations_are_get_only_with_the_documented_responses(world: World, path: str) -> None:
    operations = world.app().openapi()["paths"][path]
    assert set(operations) == {"get"}
    assert set(operations["get"]["responses"]) == {"200", "401", "429", "503"}
    assert "parameters" not in operations["get"]  # the contract has no query parameters


# --- answers -------------------------------------------------------------------------------------


def test_today_has_the_shape_of_the_contract_and_is_never_cached(world: World) -> None:
    response = world.client().get("/api/today")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body) == {
        "learningDate",
        "dailyActiveMs",
        "dailyGoalMs",
        "dailyPercent",
        "dailyCompleted",
        "extraActiveMs",
        "plan",
        "dueReviews",
        "nextNewPassage",
        "openSessionId",
        "streakDays",
        "openPlanChatId",
    }
    assert set(body["nextNewPassage"]) == {"reference", "sectionTitleAr"}
    assert body["plan"]["planId"] == str(PLAN_ID)


def test_progress_has_the_shape_of_the_contract_and_is_never_cached(world: World) -> None:
    world.seed_daily(world.calendar.today.replace(day=1), 1000)
    response = world.client().get("/api/progress")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"daily", "history", "plans"}
    assert set(body["history"][0]) == {"date", "activeMs", "goalMs", "completed"}
    assert set(body["plans"][0]) == {
        "planId",
        "titleAr",
        "titleEn",
        "status",
        "currentVersion",
        "overallPercent",
        "confirmedWords",
        "totalWords",
        "confirmedSections",
        "totalSections",
        "counts",
        "nextReviewDate",
        "sections",
    }
    assert set(body["plans"][0]["counts"]) == {
        "new",
        "learning",
        "reviewing",
        "confirmed",
        "needsRefresh",
    }
    assert set(body["plans"][0]["sections"][0]) == {
        "ordinal",
        "reference",
        "titleAr",
        "titleEn",
        "percent",
        "status",
    }


def test_the_figures_follow_what_the_events_recorded(world: World) -> None:
    client = world.client()
    game = world.game(FIRST_PASSAGE)
    events = [activity_event(0, 300), answer_event(game.questions[0])]
    assert (
        client.post(f"/api/sessions/{game.id}/events", json={"events": events}).status_code == 200
    )
    today = client.get("/api/today").json()
    assert (today["dailyActiveMs"], today["dailyPercent"]) == (300_000, 50)
    assert client.get("/api/progress").json()["daily"]["dailyActiveMs"] == 300_000
    assert client.get("/api/progress").json()["plans"][0]["counts"]["learning"] == 1


def test_unknown_query_parameters_change_nothing(world: World) -> None:
    client = world.client()
    assert client.get("/api/today?x=1").json() == client.get("/api/today").json()
    assert client.get("/api/progress?limit=1&x=2").json() == client.get("/api/progress").json()


def test_a_post_to_a_read_route_is_answered_like_an_unknown_route(world: World) -> None:
    client = world.client()
    for path in PATHS:  # the application answers a wrong method as not_found (errors.py)
        response = client.post(path, json={})
        assert response.status_code == 404 and error_body(response)["code"] == "not_found"


def test_the_open_plan_chat_seam_given_to_the_installer_reaches_the_answer(world: World) -> None:
    chat = uuid.uuid4()
    seen: list[Any] = []

    def lookup(ctx: Any) -> uuid.UUID | None:
        seen.append(ctx.user_id)
        return chat

    client = world.client(open_chat_lookup=lookup)
    assert client.get("/api/today").json()["openPlanChatId"] == str(chat)
    assert seen == [world.ctx.user_id]  # asked for the caller of the request, nobody else
    assert "openPlanChatId" not in client.get("/api/progress").json()


# --- rate limit ----------------------------------------------------------------------------------


def test_the_read_limiter_is_shared_by_both_routes_and_answers_429_with_retry_after(
    world: World,
) -> None:
    client = world.client()
    limit = make_settings().QATRA_RATE_SESSION_READ_PER_MIN
    for index in range(limit):
        assert client.get(PATHS[index % 2]).status_code == 200
    limited = client.get("/api/today")
    assert limited.status_code == 429
    error = error_body(limited)
    assert error["code"] == "throttled" and int(limited.headers["retry-after"]) >= 1
    assert error["details"]["retryAfterSec"] == int(limited.headers["retry-after"])
    assert client.get("/api/progress").status_code == 429


def test_the_read_limiter_is_not_the_write_limiter(world: World) -> None:
    client = world.client()
    app = client.app
    assert client.get("/api/today").status_code == 200
    reads = app.state.session_read_limiter
    assert isinstance(reads, SlidingWindowLimiter)
    assert not hasattr(app.state, "session_write_limiter")
    app.state.session_read_limiter = SlidingWindowLimiter(1)
    game = world.game(FIRST_PASSAGE)
    ok = client.post(f"/api/sessions/{game.id}/events", json={"events": [activity_event(5, 65)]})
    assert ok.status_code == 200  # writes are counted apart
    assert client.get("/api/today").status_code == 200
    assert client.get("/api/progress").status_code == 429


# --- wiring and failures -------------------------------------------------------------------------


@pytest.mark.parametrize("path", PATHS)
def test_without_the_service_the_endpoints_are_unavailable(world: World, path: str) -> None:
    client = world.client()
    client.app.state.progress_service = None
    response = client.get(path)
    assert response.status_code == 503 and error_body(response)["code"] == "unavailable"


def test_without_a_plan_directory_the_reads_are_unavailable_and_the_events_still_work(
    world: World,
) -> None:
    settings = make_settings()
    app = create_app(settings)
    app.state.plan_service = None  # the wiring sets it; here nothing provides the plans
    install_sessions(
        app,
        settings,
        plans=world.plans,
        calendar=world.calendar,
        bank=world.bank,
        learning=world.learning,
        clock=world.clock,
    )
    app.dependency_overrides[require_session] = lambda: world.ctx
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    for path in PATHS:
        response = client.get(path)
        assert response.status_code == 503 and error_body(response)["code"] == "unavailable"
    game = world.game(FIRST_PASSAGE)
    posted = client.post(
        f"/api/sessions/{game.id}/events", json={"events": [activity_event(5, 65)]}
    )
    assert posted.status_code == 200


@pytest.mark.parametrize("path", PATHS)
def test_a_failing_plan_directory_is_answered_without_details(world: World, path: str) -> None:
    client = world.client()

    def broken(ctx: Any) -> Any:
        raise AppError(ErrorCode.unavailable)

    world.directory.list_plans = broken  # type: ignore[method-assign]
    response = client.get(path)
    assert response.status_code == 503
    error = error_body(response)
    assert error["code"] == "unavailable" and not error.get("details")


@pytest.mark.parametrize("path", PATHS)
def test_an_unexpected_failure_is_a_500_with_nothing_of_the_cause(world: World, path: str) -> None:
    client = TestClient(
        world.app(), headers={"Origin": "http://localhost:3000"}, raise_server_exceptions=False
    )

    def explode(ctx: Any) -> Any:
        raise RuntimeError("secret internal detail")

    world.directory.list_plans = explode  # type: ignore[method-assign]
    response = client.get(path)
    assert response.status_code == 500
    assert error_body(response)["code"] == "internal"
    assert "secret internal detail" not in response.text


# --- privacy -------------------------------------------------------------------------------------


def test_nothing_of_the_learner_reaches_the_logs(world: World, log_lines: list[str]) -> None:
    client = world.client()
    game = world.game(FIRST_PASSAGE)
    client.post(f"/api/sessions/{game.id}/events", json={"events": [activity_event(5, 65)]})
    assert client.get("/api/today").status_code == 200
    assert client.get("/api/progress").status_code == 200
    text = "\n".join(log_lines)
    assert '"route":"/api/today"' in text and '"route":"/api/progress"' in text
    for secret in (
        str(game.id),
        str(PLAN_ID),
        QURAN["sections"][0]["titleAr"],
        "112:1-4",
    ):
        assert secret not in text
    assert "127.0.0.1" not in text and "testclient" not in text
