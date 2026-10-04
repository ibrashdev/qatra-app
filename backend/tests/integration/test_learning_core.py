"""Catalog, estimate, plan and sessions served by one ``create_app()``, in memory and supabase mode.

``journey`` is one learner's path through E14, E20, E15, E16, E17 and E20 again; both modes run it
and must give the same answers.
"""

from __future__ import annotations

from datetime import timedelta

from tests.integration.core_support import (
    ANON,
    PLACEMENT,
    QURAN_EDITION,
    SCOPE,
    TOKEN,
    Mode,
    daily,
    learned,
    memory_mode,
    placement_attempt,
    questions,
    supabase_mode,
)
from tests.sessions.ss_support import QURAN_PASSAGES


def journey(mode: Mode) -> None:
    client = mode.client
    catalog = client.get("/api/catalog").json()["editions"]
    quran = next(e for e in catalog if e["editionKey"] == "quran-hafs-quranenc")
    assert quran["editionId"] == str(QURAN_EDITION)
    assert [s["ordinal"] for s in quran["sections"]] == [1, 2, 3]

    response = mode.post("/api/sessions", PLACEMENT)
    assert response.status_code == 201
    placement = response.json()
    assert placement["kind"] == "placement" and placement["planId"] is None
    by_passage = {q["passageId"]: q for q in questions(placement)}
    assert set(by_passage) == {str(p) for p in QURAN_PASSAGES}

    # B6 will record placement attempts; only the last passage counts as known here.
    first, second, third, last = (by_passage[str(p)] for p in QURAN_PASSAGES)
    mode.seed_attempt(placement_attempt(placement, last, correct=True))
    mode.seed_attempt(placement_attempt(placement, first, correct=False))
    mode.seed_attempt(placement_attempt(placement, second, correct=True, assisted=True))

    # A hinted or wrong answer adds no known words.
    body = {**SCOPE, "paths": ["quran"], "sessionMinutes": 5}
    without = client.post("/api/plans/estimate", json=body).json()["estimate"]
    assert (without["totalWords"], without["knownWords"], without["days"]) == (100, 0, 10)
    estimate_body = {**body, "placementSessionId": placement["sessionId"]}
    response = client.post("/api/plans/estimate", json=estimate_body)
    assert response.status_code == 200
    estimate = response.json()["estimate"]
    assert (estimate["totalWords"], estimate["knownWords"], estimate["days"]) == (100, 32, 7)
    assert estimate["endDate"] == "2026-10-12"

    response = mode.post(
        "/api/plans", {**estimate_body, "order": "book", "confirmedEstimate": estimate}
    )
    assert response.status_code == 201
    plan = response.json()
    plan_id = plan["planId"]
    assert (plan["currentVersion"], plan["status"], plan["sessionMinutes"]) == (1, "active", 5)

    response = mode.post("/api/sessions", daily(plan_id, 1))
    assert response.status_code == 201
    first_day = response.json()
    assert (first_day["planVersion"], first_day["learningDate"]) == (1, "2026-10-05")
    assert first_day["bankVersion"] == 1 and first_day["status"] == "open"
    assert learned(first_day) == [
        str(QURAN_PASSAGES[0])
    ]  # 5 minutes: 12 words, the known one skipped
    repeat = mode.post("/api/sessions", daily(plan_id, 1))
    assert repeat.status_code == 200 and repeat.json() == first_day

    response = mode.post(
        "/api/sessions", {"kind": "game", "planId": plan_id, "expectedPlanVersion": 1}
    )
    assert response.status_code == 201
    game = response.json()
    assert game["kind"] == "game" and learned(game) == [] and 0 < len(questions(game)) <= 10
    assert game["sessionId"] != first_day["sessionId"]

    # A revision applies from the next learning day (D57).
    response = mode.post(
        f"/api/plans/{plan_id}/revise", {"expectedVersion": 1, "sessionMinutes": 15}
    )
    assert response.status_code == 200
    assert (response.json()["currentVersion"], response.json()["sessionMinutes"]) == (2, 15)

    stale = mode.post("/api/sessions", daily(plan_id, 1))
    assert stale.status_code == 409
    assert stale.json()["error"]["details"] == {"reason": "plan_version", "currentVersion": 2}
    open_still = mode.post("/api/sessions", daily(plan_id, 2))
    assert open_still.status_code == 200 and open_still.json() == first_day

    # The values in force are still the old ones, but app_open_session wants the current row.
    mode.complete(first_day["sessionId"])
    response = mode.post("/api/sessions", daily(plan_id, 2))
    assert response.status_code == 201
    same_day = response.json()
    assert same_day["sessionId"] != first_day["sessionId"]
    assert (same_day["planVersion"], same_day["learningDate"]) == (2, "2026-10-05")
    assert learned(same_day) == [str(QURAN_PASSAGES[0])]
    assert mode.session_version_id(same_day["sessionId"]) == mode.version_id(plan_id, 2)

    # 15 minutes allow 40 words a day: two passages.
    mode.clock.now += timedelta(days=1)
    response = mode.post("/api/sessions", daily(plan_id, 2))
    assert response.status_code == 201
    next_day = response.json()
    assert next_day["learningDate"] == "2026-10-06"
    assert learned(next_day) == [str(QURAN_PASSAGES[0]), str(QURAN_PASSAGES[1])]
    assert mode.session_version_id(next_day["sessionId"]) == mode.version_id(plan_id, 2)


def test_the_journey_in_memory_mode() -> None:
    journey(memory_mode())


def test_the_journey_in_supabase_mode() -> None:
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
        ("POST", "/rest/v1/rpc/app_revise_plan"),
        ("POST", "/rest/v1/rpc/app_open_session"),
    }
