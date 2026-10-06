"""The lessons reader through the production wiring of ``create_app()``, in memory and supabase
mode: the plan is created by E15 and E16, the learn step comes from E20, and the reader must show
the same passage. Test doubles only; nothing here ran against a Supabase project."""

from __future__ import annotations

from typing import Any

import pytest

from tests.integration.core_support import Mode, daily, learned, memory_mode, supabase_mode
from tests.sessions.ss_support import QURAN_PASSAGES


@pytest.fixture(params=["memory", "supabase"])
def mode(request: pytest.FixtureRequest) -> Mode:
    return memory_mode() if request.param == "memory" else supabase_mode()[0]


def get(mode: Mode, path: str, status: int = 200) -> dict[str, Any]:
    response = mode.client.get(path)
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    body: dict[str, Any] = response.json()
    return body


def test_an_account_without_a_plan_has_no_lessons(mode: Mode) -> None:
    error = get(mode, "/api/lessons", 409)["error"]
    assert (error["code"], error["details"]) == ("version_conflict", {"reason": "plan_not_active"})
    assert get(mode, "/api/lessons/1", 409)["error"]["code"] == "version_conflict"


def test_the_list_follows_the_plan_created_through_the_api(mode: Mode) -> None:
    plan = mode.create_plan(sections=(1, 3))
    body = get(mode, "/api/lessons")
    assert (body["planId"], body["planVersion"]) == (plan["planId"], plan["currentVersion"])
    assert [(s["sectionId"], s["kind"], s["passageCount"]) for s in body["sections"]] == [
        (1, "surah", 1),
        (3, "surah", 2),
    ]
    assert get(mode, "/api/lessons/2", 404)["error"]["code"] == "not_found"  # not in this plan


def test_the_reader_shows_the_passage_of_the_learn_step(mode: Mode) -> None:
    plan = mode.create_plan()
    session = mode.post("/api/sessions", daily(plan["planId"], plan["currentVersion"])).json()
    assert learned(session) == [str(QURAN_PASSAGES[0])]
    learn = next(s["passage"] for s in session["steps"] if s["type"] == "learn")
    detail = get(mode, "/api/lessons/1")
    assert learn in detail["passages"]
    assert detail["referenceAr"].startswith("سورة")
    assert detail["bookTitleAr"] == learn["source"]["bookTitleAr"]


def test_reading_opens_no_session_and_credits_no_time(mode: Mode) -> None:
    mode.create_plan()
    get(mode, "/api/lessons")
    get(mode, "/api/lessons/1")
    today = get(mode, "/api/today")
    assert today["openSessionId"] is None and today["dailyActiveMs"] == 0
