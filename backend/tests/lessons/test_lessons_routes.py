"""The lessons reader over HTTP (D92, owner approval of 5 Oct 2026): ``GET /api/lessons`` and
``GET /api/lessons/{sectionId}``. Every scenario runs over the memory repositories and over the
PostgREST adapters. Synthetic bundles only; no network, no database."""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.dependencies import require_session
from app.domain.rate_limit import SlidingWindowLimiter
from app.routers.lessons import install_lessons
from tests.sessions.ss_events_support import MODES, World
from tests.sessions.ss_support import (
    HADITH,
    OTHER_USER,
    PLAN_B_ID,
    PLAN_ID,
    QURAN,
    QURAN_EDITION,
    QURAN_PASSAGES,
    ctx,
)
from tests.support import FRONTEND_ORIGIN, make_settings

QURAN_TEXT = {unit["ordinal"]: unit["canonicalText"] for unit in QURAN["units"]}
HADITH_TEXT = {unit["ordinal"]: unit["canonicalText"] for unit in HADITH["units"]}
SURAH = "سورة"  # the word «سورة»


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    """The Quran plan (sections 1 to 3, path quran) is the only active plan; the hadith plan is
    paused until a test activates it."""
    world = World(request.param)
    world.plans.update(PLAN_B_ID, status="paused")
    return world


def client_of(world: World, *, login: bool = True, **settings: Any) -> TestClient:
    app = world.app(login=login, **settings)
    install_lessons(app, bank=world.bank, plans=world.directory)
    return TestClient(app, headers={"Origin": FRONTEND_ORIGIN})


def use_hadith_plan(world: World, **changes: Any) -> None:
    world.plans.update(PLAN_ID, status="paused")
    world.plans.update(PLAN_B_ID, status="active", **changes)


def error_of(response: Any) -> dict[str, Any]:
    assert response.headers["cache-control"] == "no-store"
    return response.json()["error"]


def spanned_texts(texts: dict[int, str], first: int, last: int) -> list[str]:
    return [texts[ordinal] for ordinal in range(first, last + 1)]


# --- guards --------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/api/lessons", "/api/lessons/1"])
def test_without_a_session_the_answer_is_unauthenticated(world: World, path: str) -> None:
    response = client_of(world, login=False).get(path)
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"


@pytest.mark.parametrize("path", ["/api/lessons", "/api/lessons/1"])
def test_a_read_needs_no_origin_header_and_is_never_cached(world: World, path: str) -> None:
    app = world.app()
    install_lessons(app, bank=world.bank, plans=world.directory)
    with TestClient(app) as bare:  # a plain GET, as a browser navigation
        response = bare.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_the_operations_are_get_only_with_the_documented_responses(world: World) -> None:
    paths = world.app().openapi()["paths"]
    assert set(paths["/api/lessons"]) == {"get"}
    assert set(paths["/api/lessons"]["get"]["responses"]) == {"200", "401", "409", "429", "503"}
    assert set(paths["/api/lessons/{section_id}"]) == {"get"}
    assert set(paths["/api/lessons/{section_id}"]["get"]["responses"]) == {
        "200",
        "401",
        "404",
        "409",
        "422",
        "429",
        "503",
    }


def test_a_post_to_a_lessons_route_is_answered_like_an_unknown_route(world: World) -> None:
    client = client_of(world)
    for path in ("/api/lessons", "/api/lessons/1"):
        response = client.post(path, json={})
        assert response.status_code == 404 and error_of(response)["code"] == "not_found"


def test_the_read_limiter_is_the_shared_session_read_limiter(world: World) -> None:
    client = client_of(world)
    limit = make_settings().QATRA_RATE_SESSION_READ_PER_MIN
    for _ in range(limit):
        assert client.get("/api/lessons").status_code == 200
    limited = client.get("/api/lessons/1")
    assert limited.status_code == 429
    assert error_of(limited)["code"] == "throttled" and int(limited.headers["retry-after"]) >= 1
    assert isinstance(client.app.state.session_read_limiter, SlidingWindowLimiter)


def test_without_the_service_the_endpoints_answer_unavailable(world: World) -> None:
    app = world.app()
    install_lessons(app, bank=None, plans=None)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    for path in ("/api/lessons", "/api/lessons/1"):
        response = client.get(path)
        assert response.status_code == 503 and error_of(response)["code"] == "unavailable"


# --- the list ------------------------------------------------------------------------------------


def test_the_list_holds_the_plans_sections_in_book_order(world: World) -> None:
    response = client_of(world).get("/api/lessons")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"planId", "planVersion", "sections"}
    assert (body["planId"], body["planVersion"]) == (str(PLAN_ID), 2)
    assert [(s["sectionId"], s["kind"], s["passageCount"]) for s in body["sections"]] == [
        (1, "surah", 1),
        (2, "surah", 1),
        (3, "surah", 2),
    ]
    for section, meta in zip(body["sections"], QURAN["sections"], strict=True):
        assert set(section) == {"sectionId", "kind", "referenceAr", "passageCount"}
        assert section["referenceAr"].startswith(SURAH)
        assert meta["titleAr"].replace(SURAH, "").strip() in section["referenceAr"]


def test_a_reverse_plan_lists_the_last_section_first(world: World) -> None:
    world.plans.update(PLAN_ID, order="reverse")
    body = client_of(world).get("/api/lessons").json()
    assert [s["sectionId"] for s in body["sections"]] == [3, 2, 1]


def test_only_the_sections_of_the_plans_scope_are_listed(world: World) -> None:
    world.plans.update(PLAN_ID, section_ordinals=(1, 3))
    body = client_of(world).get("/api/lessons").json()
    assert [(s["sectionId"], s["passageCount"]) for s in body["sections"]] == [(1, 1), (3, 2)]


def test_only_passages_on_the_selected_paths_are_counted(world: World) -> None:
    use_hadith_plan(world, paths=("matn",))
    body = client_of(world).get("/api/lessons").json()
    assert [(s["sectionId"], s["kind"], s["passageCount"]) for s in body["sections"]] == [
        (1, "hadith", 1),
        (2, "hadith", 2),
        (3, "hadith", 1),
        (4, "hadith", 1),
    ]
    use_hadith_plan(world, paths=("grade",))  # sections 1, 2 and 4 have a grade passage
    body = client_of(world).get("/api/lessons").json()
    assert [s["sectionId"] for s in body["sections"]] == [1, 2, 4]


def test_a_hadith_section_is_listed_by_its_title(world: World) -> None:
    use_hadith_plan(world)
    body = client_of(world).get("/api/lessons").json()
    assert [s["referenceAr"] for s in body["sections"]] == [
        s["titleAr"] for s in HADITH["sections"]
    ]


def test_an_account_without_an_active_plan_has_no_lessons(world: World) -> None:
    for status in ("paused", "completed"):
        world.plans.update(PLAN_ID, status=status)
        client = client_of(world)
        for path in ("/api/lessons", "/api/lessons/1"):
            response = client.get(path)
            assert response.status_code == 409, (status, path)
            error = error_of(response)
            assert error["code"] == "version_conflict"
            assert error["details"] == {"reason": "plan_not_active"}


def test_another_account_never_sees_the_plan_of_the_caller(world: World) -> None:
    client = client_of(world)
    client.app.dependency_overrides[require_session] = lambda: ctx(OTHER_USER)
    for path in ("/api/lessons", "/api/lessons/1"):
        response = client.get(path)
        assert response.status_code == 409 and error_of(response)["details"] == {
            "reason": "plan_not_active"
        }


# --- one section ---------------------------------------------------------------------------------


def test_a_section_holds_its_passages_in_book_order_with_the_verbatim_text(world: World) -> None:
    response = client_of(world).get("/api/lessons/3")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"sectionId", "kind", "referenceAr", "bookTitleAr", "sourceUrl", "passages"}
    assert (body["sectionId"], body["kind"]) == (3, "surah")
    assert body["referenceAr"].startswith(SURAH)
    assert body["bookTitleAr"] and body["sourceUrl"]
    assert [p["reference"] for p in body["passages"]] == ["114:1-3", "114:4-6"]
    assert [p["passageId"] for p in body["passages"]] == [
        str(QURAN_PASSAGES[2]),
        str(QURAN_PASSAGES[3]),
    ]
    expected = [spanned_texts(QURAN_TEXT, 10, 12), spanned_texts(QURAN_TEXT, 13, 15)]
    assert [[u["text"] for u in p["units"]] for p in body["passages"]] == expected


def test_a_reverse_plan_still_reads_a_section_in_book_order(world: World) -> None:
    world.plans.update(PLAN_ID, order="reverse")
    body = client_of(world).get("/api/lessons/3").json()
    assert [p["reference"] for p in body["passages"]] == ["114:1-3", "114:4-6"]


def test_a_section_passage_is_the_learn_step_passage_of_a_session(world: World) -> None:
    opened = world.open("daily")
    learn = [s["passage"] for s in opened.json["steps"] if s["type"] == "learn"]
    assert learn
    for passage in learn:
        section = int(passage["reference"].split(":")[0]) - 111  # 112 is section 1 of the bundle
        listed = client_of(world).get(f"/api/lessons/{section}").json()["passages"]
        assert passage in listed  # the same view, field by field


def test_the_hadith_section_carries_its_takhrij_and_grade_like_a_learn_step(world: World) -> None:
    use_hadith_plan(world)
    opened = world.open("daily", plan_id=PLAN_B_ID)
    learn = [s["passage"] for s in opened.json["steps"] if s["type"] == "learn"]
    assert learn and all(p["takhrij"] is not None for p in learn)
    client = client_of(world)
    for passage in learn:
        section = int(passage["reference"].rpartition(":")[2])
        listed = client.get(f"/api/lessons/{section}").json()["passages"]
        assert passage in listed
    first = client.get("/api/lessons/1").json()
    assert first["kind"] == "hadith" and first["referenceAr"] == HADITH["sections"][0]["titleAr"]
    assert {p["takhrij"] for p in first["passages"]} == {HADITH_TEXT[2]}
    assert {p["grade"] for p in first["passages"]} == {HADITH_TEXT[3]}


def test_only_the_selected_paths_of_a_hadith_section_are_read(world: World) -> None:
    use_hadith_plan(world, paths=("matn",))
    body = client_of(world).get("/api/lessons/2").json()
    assert [p["path"] for p in body["passages"]] == ["matn", "matn"]
    assert [p["reference"] for p in body["passages"]] == ["nawawi40:2", "nawawi40:2"]


@pytest.mark.parametrize("section", [4, 99])
def test_a_section_outside_the_plans_scope_is_not_found(world: World, section: int) -> None:
    response = client_of(world).get(f"/api/lessons/{section}")  # the Quran plan has 1 to 3
    assert response.status_code == 404 and error_of(response)["code"] == "not_found"


def test_a_section_left_out_by_the_selected_paths_is_not_found(world: World) -> None:
    use_hadith_plan(world, paths=("grade",))  # section 3 has no grade passage
    response = client_of(world).get("/api/lessons/3")
    assert response.status_code == 404 and error_of(response)["code"] == "not_found"


def test_a_section_outside_the_scope_stays_hidden_when_the_scope_is_narrowed(world: World) -> None:
    world.plans.update(PLAN_ID, section_ordinals=(1,))
    client = client_of(world)
    assert client.get("/api/lessons/1").status_code == 200
    assert client.get("/api/lessons/2").status_code == 404


@pytest.mark.parametrize("section", ["0", "-1", "abc", str(uuid.uuid4())])
def test_a_section_id_that_is_not_a_positive_number_is_a_validation_error(
    world: World, section: str
) -> None:
    response = client_of(world).get(f"/api/lessons/{section}")
    assert response.status_code == 422 and error_of(response)["code"] == "validation_error"


def test_a_revoked_edition_is_not_served(world: World) -> None:
    if world.mode != "memory":
        pytest.skip("the edition lifecycle is simulated on the memory bank")
    world.bank.set_status(QURAN_EDITION, "revoked")
    client = client_of(world)
    for path in ("/api/lessons", "/api/lessons/1"):
        assert client.get(path).status_code == 404


# --- privacy and shape ---------------------------------------------------------------------------


def test_the_reader_carries_no_question_answer_key_or_game(world: World) -> None:
    client = client_of(world)
    texts = [
        client.get("/api/lessons").text,
        *(client.get(f"/api/lessons/{n}").text for n in (1, 2, 3)),
    ]
    for text in texts:
        for forbidden in ("answerKey", "questionId", "options", "hintFirstLetter", "context"):
            assert forbidden not in text
    detail = json.loads(texts[1])
    assert set(detail["passages"][0]) == {
        "passageId",
        "path",
        "reference",
        "referenceAr",
        "sectionTitleAr",
        "units",
        "highlight",
        "takhrij",
        "grade",
        "showD50Notice",
        "source",
    }


def test_reading_creates_nothing(world: World) -> None:
    client = client_of(world)
    before = client.get("/api/today").json()
    client.get("/api/lessons")
    client.get("/api/lessons/1")
    after = client.get("/api/today").json()
    assert after["openSessionId"] is None and before["openSessionId"] is None
    assert world.intervals(world.calendar.today) == []
