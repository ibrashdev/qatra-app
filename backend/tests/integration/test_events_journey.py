"""The learner's days through one ``create_app()``, in memory and in supabase mode (package B6).

``journey`` is one account's path: a placement test whose attempts E21 records and E15 then reads,
a plan, the first day (E18, E20, E21, E22 and E19 around it), and the next day's review round. Both
modes run the same steps and must give the same answers. The identity is the fake of
``login_as`` (authentication is another package); everything else is the production wiring.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import pytest

from tests.integration import core_support
from tests.integration.b6_support import B6Project
from tests.integration.core_support import (
    ANON,
    PLACEMENT,
    SCOPE,
    TOKEN,
    Mode,
    daily,
    memory_mode,
    questions,
    supabase_mode,
)
from tests.sessions.ss_events_support import activity_event, answer_event
from tests.sessions.ss_support import OTHER_USER, QURAN_PASSAGES

FIRST, SECOND, THIRD, FOURTH = QURAN_PASSAGES


def events(mode: Mode, session: dict[str, Any], batch: list[dict[str, Any]]) -> dict[str, Any]:
    response = mode.post(f"/api/sessions/{session['sessionId']}/events", {"events": batch})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body: dict[str, Any] = response.json()
    return body


def complete(mode: Mode, session: dict[str, Any]) -> dict[str, Any]:
    response = mode.post(f"/api/sessions/{session['sessionId']}/complete")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def get(mode: Mode, path: str) -> dict[str, Any]:
    response = mode.client.get(path)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def journey(mode: Mode) -> None:
    client = mode.client

    # -- a placement test: E21 records its attempts, E15 reads them ------------------------------
    placement = mode.post("/api/sessions", PLACEMENT).json()
    by_passage = {q["passageId"]: q for q in questions(placement)}
    mode.clock.now += timedelta(minutes=5)
    batch = [
        answer_event(by_passage[str(FOURTH)]),  # correct: a known passage
        answer_event(by_passage[str(THIRD)], ok=False),
        answer_event(by_passage[str(SECOND)], hint=True),  # a hint is never known
        activity_event(5, 65),  # acknowledged, never counted
    ]
    body = events(mode, placement, batch)
    assert len(body["acknowledged"]) == 4 and body["rejected"] == []
    assert [r["correct"] for r in body["results"]] == [True, False, True]
    assert body["daily"]["dailyActiveMs"] == 0
    resent = events(mode, placement, batch)
    assert resent["duplicate"] == body["acknowledged"][:3]  # the three recorded answers
    assert resent["acknowledged"] == body["acknowledged"][3:]  # placement time is not kept
    estimate_body = {**SCOPE, "paths": ["quran"], "sessionMinutes": 5}
    estimate_body["placementSessionId"] = placement["sessionId"]
    estimate = client.post("/api/plans/estimate", json=estimate_body).json()["estimate"]
    assert (estimate["totalWords"], estimate["knownWords"], estimate["days"]) == (100, 32, 7)
    assert complete(mode, placement)["summary"]["answered"] == 3

    # -- the plan and the day before any session ------------------------------------------------
    created = mode.post(
        "/api/plans", {**estimate_body, "order": "book", "confirmedEstimate": estimate}
    )
    assert created.status_code == 201
    plan = created.json()
    today = get(mode, "/api/today")
    assert today["plan"]["planId"] == plan["planId"] and today["learningDate"] == "2026-10-05"
    assert (today["dailyGoalMs"], today["dailyActiveMs"], today["dailyPercent"]) == (300_000, 0, 0)
    assert (today["dueReviews"], today["streakDays"], today["openSessionId"]) == (0, 0, None)
    assert today["nextNewPassage"]["reference"] == "112:1-4"  # the known passage is skipped

    # -- the first day ---------------------------------------------------------------------------
    first_day = mode.post("/api/sessions", daily(plan["planId"], 1)).json()
    assert get(mode, "/api/today")["openSessionId"] == first_day["sessionId"]
    mode.clock.now += timedelta(minutes=10)
    opened = datetime.fromisoformat(first_day["createdAt"])
    answers = [answer_event(q, at=mode.clock.now) for q in questions(first_day)]
    body = events(mode, first_day, [*answers, activity_event(5, 305, base=opened)])
    assert len(body["acknowledged"]) == len(answers) + 1
    assert body["results"][-1]["passage"]["status"] == "reviewing"  # three correct in a row
    assert body["daily"] == {
        "learningDate": "2026-10-05",
        "dailyActiveMs": 300_000,
        "dailyGoalMs": 300_000,
        "dailyPercent": 100,
        "dailyCompleted": True,
        "extraActiveMs": 0,
    }
    done = complete(mode, first_day)
    assert done["summary"] == {
        "answered": len(answers),
        "correct": len(answers),
        "newPassages": 1,
        "reviewsPassed": 0,
        "reviewsFailed": 0,
        "activeMs": 300_000,
    }
    assert complete(mode, first_day) == done  # completion is idempotent
    late = events(mode, first_day, [activity_event(10, 20)])  # a closed session takes no events
    assert [r["code"] for r in late["rejected"]] == ["session_closed"]

    today = get(mode, "/api/today")
    assert (today["openSessionId"], today["streakDays"], today["dailyCompleted"]) == (None, 1, True)
    assert today["dueReviews"] == 0  # the first review is due tomorrow
    assert today["nextNewPassage"]["reference"] == "113:1-5"
    progress = get(mode, "/api/progress")
    assert progress["history"] == [] and progress["daily"]["dailyPercent"] == 100
    [shown] = progress["plans"]
    assert shown["counts"] == {  # the new passage and the known one that was practised
        "new": 2,
        "learning": 0,
        "reviewing": 2,
        "confirmed": 0,
        "needsRefresh": 0,
    }
    assert (shown["overallPercent"], shown["nextReviewDate"]) == (0, "2026-10-06")

    # -- the next day: a review round -----------------------------------------------------------
    mode.clock.now += timedelta(days=1)
    today = get(mode, "/api/today")
    assert today["learningDate"] == "2026-10-06" and today["dueReviews"] == 2
    assert (today["streakDays"], today["dailyActiveMs"]) == (1, 0)  # yesterday still counts
    second_day = mode.post("/api/sessions", daily(plan["planId"], 1)).json()
    mode.clock.now += timedelta(minutes=10)
    round_questions = [q for q in questions(second_day) if q["role"] == "review"]
    assert {q["passageId"] for q in round_questions} == {str(FIRST), str(FOURTH)}
    body = events(mode, second_day, [answer_event(q, at=mode.clock.now) for q in round_questions])
    assert len(body["acknowledged"]) == len(round_questions)
    assert complete(mode, second_day)["summary"]["reviewsPassed"] == 2
    progress = get(mode, "/api/progress")
    [yesterday] = progress["history"]
    assert yesterday == {
        "date": "2026-10-05",
        "activeMs": 300_000,
        "goalMs": 300_000,
        "completed": True,
    }
    assert progress["plans"][0]["nextReviewDate"] == "2026-10-08"  # stage 2: due in two days
    assert get(mode, "/api/today")["dueReviews"] == 0


@pytest.fixture
def memory() -> Mode:
    return memory_mode()


def test_the_journey_in_memory_mode(memory: Mode) -> None:
    journey(memory)
    other_session = memory.post("/api/sessions", PLACEMENT).json()
    memory.login(OTHER_USER)  # another account: nothing of the first one is reachable
    assert memory.post(f"/api/sessions/{other_session['sessionId']}/complete").status_code == 404
    today = get(memory, "/api/today")
    assert (today["plan"], today["dueReviews"], today["streakDays"]) == (None, 0, 0)
    assert get(memory, "/api/progress")["plans"] == []
    body = memory.post(
        f"/api/sessions/{other_session['sessionId']}/events", {"events": [activity_event(0, 1)]}
    )
    assert body.status_code == 404


def test_the_journey_in_supabase_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core_support, "FakeProject", B6Project)
    mode, project = supabase_mode()
    journey(mode)
    token = f"Bearer {TOKEN}"
    for request in project.requests:
        assert request.headers["apikey"] == ANON
        if request.url.path.endswith(("/catalog_editions", "/catalog_sections")):
            assert "authorization" not in request.headers  # E14 is public: the anon role only
        else:
            assert request.headers["authorization"] == token
    writes = {(r.method, r.url.path) for r in project.requests if r.method != "GET"}
    assert writes == {
        ("POST", "/rest/v1/rpc/app_create_plan"),
        ("POST", "/rest/v1/rpc/app_open_session"),
        ("POST", "/rest/v1/rpc/app_apply_events"),
        ("POST", "/rest/v1/rpc/app_complete_session"),
    }  # learner state changes only through the functions, never through a table write


def test_the_two_modes_end_in_the_same_learner_state(monkeypatch: pytest.MonkeyPatch) -> None:
    memory = memory_mode()
    journey(memory)
    monkeypatch.setattr(core_support, "FakeProject", B6Project)
    supabase, _ = supabase_mode()
    journey(supabase)
    for path in ("/api/today", "/api/progress"):
        a, b = get(memory, path), get(supabase, path)
        for body in (a, b):  # ids and stamps differ by backend; the rest must not
            if "plan" in body and body["plan"]:
                body["plan"].pop("planId"), body["plan"].pop("createdAt")
                body["plan"].pop("editionId", None)
            body.pop("openSessionId", None)
            for entry in body.get("plans", []):
                entry.pop("planId")
        assert a == b
