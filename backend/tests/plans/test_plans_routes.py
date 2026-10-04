"""E15, E16, E17 and E30 over HTTP in memory mode: rules, errors, ownership, roles, Origin and
session, strict bodies. Synthetic data only."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.dependencies import require_session
from app.domain.rate_limit import SlidingWindowLimiter
from app.routers import plans as plans_router
from tests.plans.plans_support import (
    EXAMPLE_ALTERNATIVES,
    EXAMPLE_ESTIMATE,
    HADITH_ID,
    OTHER_USER_ID,
    PLACEMENT_ID,
    QURAN_ID,
    UNKNOWN_ID,
    USER_ID,
    Env,
    browser,
    code,
    create_body,
    details,
    estimate_body,
    fields,
    login_as,
    make_env,
    pid,
)

PLAN_KEYS = {
    "planId",
    "editionId",
    "titleAr",
    "titleEn",
    "targetScope",
    "paths",
    "order",
    "sessionMinutes",
    "preferredDate",
    "agreedEstimate",
    "currentVersion",
    "status",
    "createdAt",
    "planner",
}


@pytest.fixture
def env(tmp_path: Path) -> Env:
    environment = make_env(tmp_path)
    environment.seed_placement()
    return environment


@pytest.fixture
def client(env: Env) -> Iterator[TestClient]:
    login_as(env.app)  # TEST ONLY: a fake SessionContext instead of a real cookie
    with browser(env.app) as test_client:
        yield test_client


def hadith_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "editionId": str(HADITH_ID),
        "targetScope": {"sectionOrdinals": [1, 3]},
        "paths": ["matn", "sanad"],
        "sessionMinutes": 5,
    }
    body.update(overrides)
    return {key: value for key, value in body.items() if value is not None}


def make_plan(client: TestClient, **overrides: Any) -> dict[str, Any]:
    """Estimate, then save exactly the estimate E15 returned (the flow of the client)."""
    body = estimate_body(**overrides)
    estimated = client.post("/api/plans/estimate", json=body)
    assert estimated.status_code == 200, estimated.text
    created = client.post(
        "/api/plans", json={**body, "confirmedEstimate": estimated.json()["estimate"]}
    )
    assert created.status_code == 201, created.text
    return created.json()


# --- Origin first, then the session --------------------------------------------------------------

MUTATIONS = [
    ("/api/plans/estimate", {"x": 1}),
    ("/api/plans", {"x": 1}),
    (f"/api/plans/{UNKNOWN_ID}/revise", {"expectedVersion": 1, "sessionMinutes": 10}),
    (f"/api/plans/{UNKNOWN_ID}/resume", None),
]


@pytest.mark.parametrize("path,body", MUTATIONS)
def test_every_mutation_requires_the_frontend_origin_before_anything_else(env, path, body) -> None:
    with TestClient(env.app) as anonymous:  # no Origin and no session
        response = anonymous.post(path, json=body)
        assert (response.status_code, code(response)) == (403, "forbidden_origin")
        wrong = anonymous.post(path, json=body, headers={"Origin": "http://evil.example"})
        assert (wrong.status_code, code(wrong)) == (403, "forbidden_origin")


@pytest.mark.parametrize("path,body", MUTATIONS)
def test_every_route_requires_a_session(env, path, body) -> None:
    """No override: the B0 ``require_session`` denies, so identity cannot be faked."""
    assert require_session not in env.app.dependency_overrides
    with browser(env.app) as anonymous:
        response = anonymous.post(path, json=body)
        assert (response.status_code, code(response)) == (401, "unauthenticated")


@pytest.mark.parametrize("path,body", MUTATIONS)
def test_the_service_must_be_installed(env, path, body) -> None:
    env.app.state.plan_service = None
    login_as(env.app)
    with browser(env.app) as test_client:
        response = test_client.post(path, json=body)
        assert (response.status_code, code(response)) == (503, "unavailable")


# --- E15 -----------------------------------------------------------------------------------------


def test_e15_reproduces_the_api_spec_example_exactly(client: TestClient) -> None:
    response = client.post("/api/plans/estimate", json=estimate_body())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "estimate": EXAMPLE_ESTIMATE,
        "alternatives": EXAMPLE_ALTERNATIVES,
        "reasonCode": "fits_preferred_date",
    }


def test_e15_without_a_placement_session_knows_no_words(client: TestClient) -> None:
    body = client.post("/api/plans/estimate", json=estimate_body(placementSessionId=None)).json()
    assert body["estimate"]["knownWords"] == 0
    assert body["estimate"]["days"] == 18  # ceil(180 / 12 * 1.15)
    assert body["reasonCode"] == "exceeds_preferred_date"  # 4 October + 18 days > 20 October


def test_e15_without_a_preferred_date_says_so(client: TestClient) -> None:
    body = client.post("/api/plans/estimate", json=estimate_body(preferredDate=None)).json()
    assert body["reasonCode"] == "no_preferred_date"
    explicit = client.post("/api/plans/estimate", json=estimate_body() | {"preferredDate": None})
    assert explicit.json()["reasonCode"] == "no_preferred_date"


def test_e15_never_writes(client: TestClient, env: Env) -> None:
    client.post("/api/plans/estimate", json=estimate_body())
    assert env.repository.plans_of(USER_ID) == []


def test_e15_is_open_to_demo_accounts(env: Env) -> None:
    login_as(env.app, USER_ID, demo=True)
    with browser(env.app) as demo:
        response = demo.post("/api/plans/estimate", json=estimate_body())
    assert response.status_code == 200 and response.json()["estimate"] == EXAMPLE_ESTIMATE


RULE_CASES = [
    ({"editionId": str(UNKNOWN_ID)}, [("editionId", "edition_not_available")]),
    ({"targetScope": {"sectionOrdinals": []}}, [("targetScope", "scope_invalid")]),
    ({"targetScope": {"sectionOrdinals": [1, 1]}}, [("targetScope", "scope_invalid")]),
    ({"targetScope": {"sectionOrdinals": [1, 99]}}, [("targetScope", "scope_invalid")]),
    ({"targetScope": {"sectionOrdinals": list(range(1, 62))}}, [("targetScope", "scope_invalid")]),
    ({"paths": []}, [("paths", "paths_invalid")]),
    ({"paths": ["quran", "quran"]}, [("paths", "paths_invalid")]),
    ({"paths": ["matn"]}, [("paths", "paths_invalid")]),
    ({"paths": ["takhrij"]}, [("paths", "paths_invalid")]),
    ({"sessionMinutes": 7}, [("sessionMinutes", "session_minutes_invalid")]),
    ({"sessionMinutes": 0}, [("sessionMinutes", "session_minutes_invalid")]),
    ({"preferredDate": "2026-10-03"}, [("preferredDate", "date_invalid")]),
    ({"order": "sideways"}, [("order", "order_invalid")]),
]


@pytest.mark.parametrize("override,expected", RULE_CASES)
def test_e15_shared_rules_and_their_rule_names(client: TestClient, override, expected) -> None:
    response = client.post("/api/plans/estimate", json=estimate_body(**override))
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == expected


@pytest.mark.parametrize("override,expected", RULE_CASES)
def test_e16_applies_the_same_rules(client: TestClient, override, expected) -> None:
    response = client.post("/api/plans", json=create_body(**override))
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == expected


def test_a_past_date_is_refused_but_today_is_allowed(client: TestClient) -> None:
    ok = client.post("/api/plans/estimate", json=estimate_body(preferredDate="2026-10-04"))
    assert ok.status_code == 200 and ok.json()["reasonCode"] == "exceeds_preferred_date"


def test_the_learning_date_follows_the_account_time_zone(env: Env, client: TestClient) -> None:
    """01:00 on 5 October in Dubai is still 4 October in UTC: a date of 4 October is past there."""
    env.clock.now = datetime(2026, 10, 4, 21, 0, tzinfo=UTC)
    refused = client.post("/api/plans/estimate", json=estimate_body(preferredDate="2026-10-04"))
    assert fields(refused) == [("preferredDate", "date_invalid")]
    assert client.post("/api/plans/estimate", json=estimate_body()).json()["estimate"][
        "endDate"
    ] == ("2026-10-21")


def test_reverse_order_is_refused_for_a_hadith_edition(client: TestClient) -> None:
    for path in ("/api/plans/estimate", "/api/plans"):
        body = hadith_body(order="reverse")
        if path == "/api/plans":
            body["confirmedEstimate"] = dict(EXAMPLE_ESTIMATE)
        response = client.post(path, json=body)
        assert (response.status_code, code(response)) == (422, "validation_error")
        assert fields(response) == [("order", "order_not_available")]


def test_reverse_halves_the_scope_from_the_end(client: TestClient) -> None:
    base = estimate_body(placementSessionId=None, targetScope={"sectionOrdinals": [1, 2, 3, 4]})
    book = client.post("/api/plans/estimate", json=base).json()
    reverse = client.post("/api/plans/estimate", json=base | {"order": "reverse"}).json()
    assert book["alternatives"][-1]["scope"] == {"sectionOrdinals": [1, 2]}
    assert reverse["alternatives"][-1]["scope"] == {"sectionOrdinals": [3, 4]}
    assert book["estimate"] == reverse["estimate"]  # the order changes the plan, not the totals


def test_the_hadith_estimate_sums_the_selected_paths(client: TestClient) -> None:
    body = client.post("/api/plans/estimate", json=hadith_body()).json()
    estimate = body["estimate"]
    assert (estimate["totalWords"], estimate["passageCount"], estimate["days"]) == (41, 4, 4)
    assert estimate["paths"] == ["matn", "sanad"] and estimate["scope"] == {
        "sectionOrdinals": [1, 3]
    }


UNKNOWN_PLACEMENT = str(UNKNOWN_ID)


def test_a_placement_session_that_is_not_the_callers_is_404_like_an_unknown_one(
    env: Env, client: TestClient
) -> None:
    foreign = UUID("33333333-3333-4333-8333-000000000002")
    env.seed_placement(OTHER_USER_ID, placement_id=foreign, known=(pid(2),))
    other_edition = UUID("33333333-3333-4333-8333-000000000003")
    env.seed_placement(USER_ID, placement_id=other_edition, edition_id=HADITH_ID, known=(pid(11),))
    answers = []
    for placement in (UNKNOWN_PLACEMENT, str(foreign), str(other_edition)):
        for path, extra in (
            ("/api/plans/estimate", {}),
            ("/api/plans", {"confirmedEstimate": EXAMPLE_ESTIMATE}),
        ):
            response = client.post(path, json=estimate_body(placementSessionId=placement) | extra)
            assert (response.status_code, code(response)) == (404, "not_found")
            answers.append(response.json())
    assert all(answer == answers[0] for answer in answers)  # indistinguishable


@pytest.mark.parametrize(
    "extra",
    ["userId", "isDemo", "mode", "correct", "confirmedEstimate", "goalText", "unknownThing"],
)
def test_e15_refuses_unknown_properties(client: TestClient, extra: str) -> None:
    body = estimate_body() | {extra: "x"}
    response = client.post("/api/plans/estimate", json=body)
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == [(extra, "forbidden_field")]


def test_e15_refuses_unknown_properties_inside_the_scope(client: TestClient) -> None:
    body = estimate_body(targetScope={"sectionOrdinals": [1], "userId": "x"})
    response = client.post("/api/plans/estimate", json=body)
    assert fields(response) == [("targetScope.userId", "forbidden_field")]


@pytest.mark.parametrize(
    "override",
    [
        {"sessionMinutes": "5"},
        {"sessionMinutes": True},
        {"sessionMinutes": 5.0},
        {"paths": "quran"},
        {"paths": [1]},
        {"editionId": 5},
        {"editionId": "not-a-uuid"},
        {"targetScope": [1, 2]},
        {"targetScope": {"sectionOrdinals": ["1"]}},
        {"targetScope": {"sectionOrdinals": [1.5]}},
        {"preferredDate": "next week"},
        {"placementSessionId": "x"},
        {"order": 1},
    ],
)
def test_e15_refuses_wrong_types(client: TestClient, override: dict[str, Any]) -> None:
    response = client.post("/api/plans/estimate", json=estimate_body() | override)
    assert (response.status_code, code(response)) == (422, "validation_error")


def test_e15_requires_its_fields_and_json(client: TestClient) -> None:
    missing = client.post("/api/plans/estimate", json={})
    assert {item[1] for item in fields(missing)} == {"required"}
    assert {item[0] for item in fields(missing)} == {
        "editionId",
        "targetScope",
        "paths",
        "sessionMinutes",
    }
    broken = client.post(
        "/api/plans/estimate", content="{nope", headers={"Content-Type": "application/json"}
    )
    assert (broken.status_code, code(broken)) == (422, "validation_error")


# --- E16 -----------------------------------------------------------------------------------------


def test_e16_creates_the_plan_exactly_as_confirmed(client: TestClient, env: Env) -> None:
    response = client.post("/api/plans", json=create_body())
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) - {"pendingSessionMinutes"} == PLAN_KEYS
    assert body["editionId"] == str(QURAN_ID)
    assert (body["titleAr"], body["titleEn"]) == ("«عنوان الكتاب»", "Book title placeholder")
    assert body["targetScope"] == {"sectionOrdinals": [1, 2]} and body["paths"] == ["quran"]
    assert (body["order"], body["sessionMinutes"], body["preferredDate"]) == (
        "book",
        5,
        "2026-10-20",
    )
    assert body["agreedEstimate"] == EXAMPLE_ESTIMATE
    assert (body["currentVersion"], body["status"]) == (1, "active")
    assert body["createdAt"] == "2026-10-04T09:00:00Z"
    assert body["planner"] == {"source": "rules"}
    [stored] = env.repository.plans_of(USER_ID)
    assert str(stored.plan_id) == body["planId"]


def test_e16_stores_version_one_with_phases_and_the_known_passages(
    client: TestClient, env: Env
) -> None:
    plan = client.post("/api/plans", json=create_body()).json()
    [version] = env.repository.versions_of(UUID(plan["planId"]))
    assert version["versionNo"] == 1 and version["reasonCode"] == "plan_created"
    assert version["effectiveLearningDate"] == date(2026, 10, 4)
    assert version["policy"]["knownPassages"] == {
        "placementSessionId": str(PLACEMENT_ID),
        "passageIds": [str(pid(1))],
    }
    assert version["policy"]["planner"] == {"source": "rules"}
    assert [phase["ordinal"] for phase in version["phases"]] == [1, 2]
    assert [phase["goal_size"] for phase in version["phases"]] == [100, 80]


def test_e16_creates_no_session_and_no_second_plan_on_its_own(client: TestClient, env: Env) -> None:
    client.post("/api/plans", json=create_body())
    assert len(env.repository.plans_of(USER_ID)) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"days": 15},
        {"endDate": "2026-10-19"},
        {"newWordsPerDay": 25},
        {"totalWords": 181},
        {"knownWords": 0},
        {"passageCount": 5},
        {"sessionMinutes": 10},
        {"scope": {"sectionOrdinals": [1]}},
        {"paths": ["quran", "matn"]},
    ],
)
def test_e16_a_changed_estimate_is_409_with_the_fresh_estimate_and_saves_nothing(
    client: TestClient, env: Env, change: dict[str, Any]
) -> None:
    confirmed = dict(EXAMPLE_ESTIMATE) | change
    response = client.post("/api/plans", json=create_body(confirmedEstimate=confirmed))
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "estimate_changed", "estimate": EXAMPLE_ESTIMATE}
    assert env.repository.plans_of(USER_ID) == []


def test_e16_the_confirmed_estimate_is_recomputed_when_the_day_changes(
    client: TestClient, env: Env
) -> None:
    env.clock.now = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)  # the next learning day
    response = client.post("/api/plans", json=create_body())
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response)["estimate"]["endDate"] == "2026-10-21"
    assert env.repository.plans_of(USER_ID) == []


def test_e16_saves_the_alternative_the_learner_picked(client: TestClient, env: Env) -> None:
    for alternative in EXAMPLE_ALTERNATIVES:
        body = create_body(
            targetScope=alternative["scope"],
            sessionMinutes=alternative["sessionMinutes"],
            confirmedEstimate=alternative,
        )
        response = client.post("/api/plans", json=body)
        assert response.status_code == 201, response.text
        assert response.json()["agreedEstimate"] == alternative
        assert response.json()["sessionMinutes"] == alternative["sessionMinutes"]
    assert len(env.repository.plans_of(USER_ID)) == 2


def test_e16_pauses_the_previous_active_plan(client: TestClient, env: Env) -> None:
    first = make_plan(client)
    second = make_plan(client, targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
    plans = {str(p.plan_id): p for p in env.repository.plans_of(USER_ID)}
    assert plans[first["planId"]].status == "paused"
    assert plans[first["planId"]].current_version == 1  # progress and version are kept
    assert plans[second["planId"]].status == "active"
    assert [p.status for p in plans.values()].count("active") == 1


def test_e16_each_account_has_its_own_active_plan(client: TestClient, env: Env) -> None:
    make_plan(client)
    login_as(env.app, OTHER_USER_ID)
    with browser(env.app) as other:
        make_plan(other, placementSessionId=None)
    assert [p.status for p in env.repository.plans_of(USER_ID)] == ["active"]
    assert [p.status for p in env.repository.plans_of(OTHER_USER_ID)] == ["active"]


def test_e16_reverse_order_is_stored_and_the_phases_run_backwards(
    client: TestClient, env: Env
) -> None:
    plan = make_plan(
        client,
        targetScope={"sectionOrdinals": [1, 2, 3, 4]},
        placementSessionId=None,
        order="reverse",
    )
    assert plan["order"] == "reverse"
    [version] = env.repository.versions_of(UUID(plan["planId"]))
    assert [phase["section_refs"][0]["ordinal"] for phase in version["phases"]] == [4, 3, 2, 1]
    second_surah = [item["ordinal"] for item in version["phases"][2]["unit_range"]["passages"]]
    assert second_surah == [3, 4]  # inside a surah the passages keep mushaf order


def test_e16_plans_a_hadith_edition_with_selected_paths(client: TestClient) -> None:
    body = hadith_body()
    estimate = client.post("/api/plans/estimate", json=body).json()["estimate"]
    created = client.post("/api/plans", json=body | {"confirmedEstimate": estimate})
    assert created.status_code == 201
    assert created.json()["paths"] == ["matn", "sanad"] and created.json()["order"] == "book"


def test_e16_defaults_the_order_to_book(client: TestClient) -> None:
    body = create_body()
    del body["order"]
    assert client.post("/api/plans", json=body).json()["order"] == "book"


def test_e16_the_confirmed_estimate_is_required_and_checked_as_a_whole(client: TestClient) -> None:
    missing = create_body()
    del missing["confirmedEstimate"]
    assert fields(client.post("/api/plans", json=missing)) == [("confirmedEstimate", "required")]
    incomplete = {k: v for k, v in EXAMPLE_ESTIMATE.items() if k != "days"}
    for bad in (
        incomplete,
        "x",
        None,
        [],
        dict(EXAMPLE_ESTIMATE, days="16"),
        dict(EXAMPLE_ESTIMATE, sessionMinutes=7),
    ):
        response = client.post("/api/plans", json=create_body() | {"confirmedEstimate": bad})
        assert (response.status_code, code(response)) == (422, "validation_error")
        assert fields(response) == [("confirmedEstimate", "confirmed_estimate_invalid")]


def test_e16_an_unknown_property_inside_the_confirmed_estimate_is_forbidden_field(
    client: TestClient,
) -> None:
    body = create_body() | {"confirmedEstimate": dict(EXAMPLE_ESTIMATE, userId="x")}
    response = client.post("/api/plans", json=body)
    assert fields(response) == [("confirmedEstimate", "forbidden_field")]


@pytest.mark.parametrize("extra", ["userId", "isDemo", "mode", "status", "plannerSource"])
def test_e16_refuses_unknown_properties(client: TestClient, env: Env, extra: str) -> None:
    response = client.post("/api/plans", json=create_body() | {extra: "x"})
    assert fields(response) == [(extra, "forbidden_field")]
    assert env.repository.plans_of(USER_ID) == []


def test_e16_demo_accounts_get_403_before_the_body_is_looked_at(env: Env) -> None:
    login_as(env.app, USER_ID, demo=True)
    with browser(env.app) as demo:
        for body in (create_body(), {"junk": 1}):
            response = demo.post("/api/plans", json=body)
            assert (response.status_code, code(response)) == (403, "forbidden")
    assert env.repository.plans_of(USER_ID) == []


# --- E17 -----------------------------------------------------------------------------------------


def revise(client: TestClient, plan: dict[str, Any], **changes: Any):
    body = {"expectedVersion": plan["currentVersion"]} | changes
    return client.post(f"/api/plans/{plan['planId']}/revise", json=body)


def test_e17_revises_into_a_new_immutable_version(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    response = revise(client, plan, sessionMinutes=10, order="reverse")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["currentVersion"], body["sessionMinutes"], body["order"]) == (2, 10, "reverse")
    assert body["status"] == "active" and body["planId"] == plan["planId"]
    # without a confirmedEstimate the stored agreedEstimate stays (API-spec example)
    assert body["agreedEstimate"] == plan["agreedEstimate"]
    versions = env.repository.versions_of(UUID(plan["planId"]))
    assert [v["versionNo"] for v in versions] == [1, 2]
    assert versions[1]["reasonCode"] == "plan_revised"
    assert versions[1]["effectiveLearningDate"] == date(2026, 10, 5)  # the next learning day (D57)
    assert versions[0]["effectiveLearningDate"] == date(2026, 10, 4)
    assert versions[0]["policy"]["sessionMinutes"] == 5  # history is never rewritten


def test_e17_versions_increment_one_by_one(client: TestClient) -> None:
    plan = make_plan(client)
    second = revise(client, plan, sessionMinutes=10).json()
    third = revise(client, second, sessionMinutes=15).json()
    assert (second["currentVersion"], third["currentVersion"]) == (2, 3)


def test_e17_needs_at_least_one_optional_field(client: TestClient) -> None:
    plan = make_plan(client)
    response = revise(client, plan)
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == [("body", "no_fields")]


def test_e17_requires_a_positive_expected_version(client: TestClient) -> None:
    plan = make_plan(client)
    for body in (
        {"sessionMinutes": 10},
        {"expectedVersion": 0, "sessionMinutes": 10},
        {"expectedVersion": "1", "sessionMinutes": 10},
    ):
        response = client.post(f"/api/plans/{plan['planId']}/revise", json=body)
        assert (response.status_code, code(response)) == (422, "validation_error")


def test_e17_a_stale_version_is_409_with_the_current_version(client: TestClient) -> None:
    plan = make_plan(client)
    revise(client, plan, sessionMinutes=10)
    response = revise(client, plan, sessionMinutes=15)  # still quotes version 1
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_version", "currentVersion": 2}


def test_e17_a_completed_plan_cannot_be_revised(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    env.repository.complete_plan(UUID(plan["planId"]))
    response = revise(client, plan, sessionMinutes=10)
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_not_active"}


def test_e17_a_paused_plan_can_be_revised_and_stays_paused(client: TestClient, env: Env) -> None:
    first = make_plan(client)
    second = make_plan(client, targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
    response = revise(client, first, sessionMinutes=10)
    assert response.status_code == 200
    assert (response.json()["status"], response.json()["currentVersion"]) == ("paused", 2)
    statuses = {str(p.plan_id): p.status for p in env.repository.plans_of(USER_ID)}
    assert statuses == {first["planId"]: "paused", second["planId"]: "active"}


@pytest.mark.parametrize(
    "extra",
    [
        {"targetScope": {"sectionOrdinals": [1]}},
        {"editionId": str(HADITH_ID)},
        {"userId": "x"},
        {"isDemo": True},
        {"mode": "synthetic_demo"},
        {"status": "completed"},
    ],
)
def test_e17_cannot_change_the_scope_or_the_edition_or_send_authority(
    client: TestClient, extra: dict[str, Any]
) -> None:
    plan = make_plan(client)
    response = revise(client, plan, sessionMinutes=10, **extra)
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == [(next(iter(extra)), "forbidden_field")]


def test_e17_an_unknown_plan_and_another_accounts_plan_are_both_404(
    client: TestClient, env: Env
) -> None:
    plan = make_plan(client)
    login_as(env.app, OTHER_USER_ID)
    with browser(env.app) as other:
        foreign = other.post(
            f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
        )
        unknown = other.post(
            f"/api/plans/{UNKNOWN_ID}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
        )
    assert (foreign.status_code, code(foreign)) == (404, "not_found")
    assert (unknown.status_code, code(unknown)) == (404, "not_found")
    assert foreign.json() == unknown.json()


E17_RULES = [
    ({"sessionMinutes": 7}, [("sessionMinutes", "session_minutes_invalid")]),
    ({"paths": ["matn"]}, [("paths", "paths_invalid")]),
    ({"paths": []}, [("paths", "paths_invalid")]),
    ({"order": "sideways"}, [("order", "order_invalid")]),
    ({"preferredDate": "2026-10-03"}, [("preferredDate", "date_invalid")]),
]


@pytest.mark.parametrize("change,expected", E17_RULES)
def test_e17_shared_rules(client: TestClient, change, expected) -> None:
    plan = make_plan(client)
    response = revise(client, plan, **change)
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == expected


def test_e17_reverse_is_refused_for_a_hadith_plan(client: TestClient) -> None:
    body = hadith_body()
    estimate = client.post("/api/plans/estimate", json=body).json()["estimate"]
    plan = client.post("/api/plans", json=body | {"confirmedEstimate": estimate}).json()
    response = revise(client, plan, order="reverse")
    assert fields(response) == [("order", "order_not_available")]


def test_e17_changes_the_paths_of_a_hadith_plan(client: TestClient) -> None:
    body = hadith_body()
    estimate = client.post("/api/plans/estimate", json=body).json()["estimate"]
    plan = client.post("/api/plans", json=body | {"confirmedEstimate": estimate}).json()
    response = revise(client, plan, paths=["matn", "sanad", "grade"])
    assert response.status_code == 200
    assert response.json()["paths"] == ["matn", "sanad", "grade"]


def test_e17_a_past_date_the_plan_already_had_does_not_block_a_revision(
    client: TestClient, env: Env
) -> None:
    plan = make_plan(client, preferredDate="2026-10-05")
    env.clock.now = datetime(2026, 10, 10, 9, 0, tzinfo=UTC)  # the stored date is now past
    assert revise(client, plan, sessionMinutes=10).status_code == 200
    refused = revise(client, plan | {"currentVersion": 2}, preferredDate="2026-10-06")
    assert fields(refused) == [("preferredDate", "date_invalid")]


def test_e17_the_preferred_date_can_be_set_changed_and_cleared(client: TestClient) -> None:
    plan = make_plan(client)
    assert revise(client, plan, sessionMinutes=10).json()["preferredDate"] == "2026-10-20"
    changed = revise(client, plan | {"currentVersion": 2}, preferredDate="2026-11-01").json()
    assert changed["preferredDate"] == "2026-11-01"
    cleared = revise(client, changed, preferredDate=None).json()
    assert cleared["preferredDate"] is None


@pytest.mark.parametrize("field", ["sessionMinutes", "paths", "order", "confirmedEstimate"])
def test_e17_other_optional_fields_do_not_accept_null(client: TestClient, field: str) -> None:
    plan = make_plan(client)
    response = revise(client, plan, **{field: None})
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert fields(response) == [(field, "null_not_allowed")]


def test_e17_a_matching_confirmed_estimate_replaces_the_agreed_estimate(client: TestClient) -> None:
    plan = make_plan(client)
    change = estimate_body(sessionMinutes=10)
    fresh = client.post("/api/plans/estimate", json=change).json()["estimate"]
    assert fresh["days"] == 8
    response = revise(client, plan, sessionMinutes=10, confirmedEstimate=fresh)
    assert response.status_code == 200
    assert response.json()["agreedEstimate"] == fresh
    assert response.json()["sessionMinutes"] == 10


def test_e17_a_confirmed_estimate_that_differs_is_409_with_the_fresh_one(
    client: TestClient, env: Env
) -> None:
    plan = make_plan(client)
    response = revise(client, plan, sessionMinutes=10, confirmedEstimate=EXAMPLE_ESTIMATE)
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response)["reason"] == "estimate_changed"
    assert details(response)["estimate"]["sessionMinutes"] == 10
    assert details(response)["estimate"]["days"] == 8
    assert [v["versionNo"] for v in env.repository.versions_of(UUID(plan["planId"]))] == [1]


def test_e17_a_malformed_confirmed_estimate_is_422(client: TestClient) -> None:
    plan = make_plan(client)
    response = revise(client, plan, sessionMinutes=10, confirmedEstimate={"days": 1})
    assert fields(response) == [("confirmedEstimate", "confirmed_estimate_invalid")]


def test_e17_demo_accounts_may_revise(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    login_as(env.app, USER_ID, demo=True)
    with browser(env.app) as demo:
        response = demo.post(
            f"/api/plans/{plan['planId']}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
        )
    assert response.status_code == 200 and response.json()["currentVersion"] == 2


def test_e17_phases_are_rebuilt_for_the_new_order(client: TestClient, env: Env) -> None:
    plan = make_plan(client, targetScope={"sectionOrdinals": [1, 2, 3]}, placementSessionId=None)
    revise(client, plan, order="reverse")
    first, second = env.repository.versions_of(UUID(plan["planId"]))
    assert [p["section_refs"][0]["ordinal"] for p in first["phases"]] == [1, 2, 3]
    assert [p["section_refs"][0]["ordinal"] for p in second["phases"]] == [3, 2, 1]


def test_e17_keeps_the_placement_known_passages_of_the_plan(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    revise(client, plan, sessionMinutes=10)
    versions = env.repository.versions_of(UUID(plan["planId"]))
    assert versions[1]["policy"]["knownPassages"] == versions[0]["policy"]["knownPassages"]
    fresh = client.post("/api/plans/estimate", json=estimate_body(sessionMinutes=10)).json()[
        "estimate"
    ]
    assert fresh["knownWords"] == 20
    ok = revise(
        client,
        plan | {"currentVersion": 2},
        sessionMinutes=15,
        confirmedEstimate=client.post(
            "/api/plans/estimate", json=estimate_body(sessionMinutes=15)
        ).json()["estimate"],
    )
    assert ok.status_code == 200


# --- E30 -----------------------------------------------------------------------------------------


def resume(client: TestClient, plan: dict[str, Any], **kwargs: Any):
    return client.post(f"/api/plans/{plan['planId']}/resume", **kwargs)


def test_e30_resumes_a_paused_plan_and_pauses_the_current_one(client: TestClient, env: Env) -> None:
    first = make_plan(client)
    second = make_plan(client, targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
    response = resume(client, first)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["status"] == "active" and body["currentVersion"] == first["currentVersion"]
    assert body["agreedEstimate"] == first["agreedEstimate"]
    statuses = {str(p.plan_id): p.status for p in env.repository.plans_of(USER_ID)}
    assert statuses == {first["planId"]: "active", second["planId"]: "paused"}
    assert len(env.repository.versions_of(UUID(first["planId"]))) == 1  # no new version row


def test_e30_an_active_plan_is_returned_unchanged(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    response = resume(client, plan)
    assert response.status_code == 200 and response.json() == plan
    again = resume(client, plan)
    assert again.json() == plan  # naturally idempotent
    assert [p.status for p in env.repository.plans_of(USER_ID)] == ["active"]


def test_e30_a_completed_plan_cannot_be_resumed(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    env.repository.complete_plan(UUID(plan["planId"]))
    response = resume(client, plan)
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert details(response) == {"reason": "plan_not_active"}


def test_e30_unknown_and_foreign_plans_are_indistinguishable_404s(
    client: TestClient, env: Env
) -> None:
    plan = make_plan(client)
    login_as(env.app, OTHER_USER_ID)
    with browser(env.app) as other:
        foreign = resume(other, plan)
        unknown = other.post(f"/api/plans/{UNKNOWN_ID}/resume")
    assert (foreign.status_code, code(foreign)) == (404, "not_found")
    assert foreign.json() == unknown.json()
    assert [p.status for p in env.repository.plans_of(USER_ID)] == ["active"]


def test_e30_demo_accounts_get_403(client: TestClient, env: Env) -> None:
    plan = make_plan(client)
    make_plan(client, targetScope={"sectionOrdinals": [3]}, placementSessionId=None)
    login_as(env.app, USER_ID, demo=True)
    with browser(env.app) as demo:
        response = resume(demo, plan)
    assert (response.status_code, code(response)) == (403, "forbidden")
    assert [p.status for p in env.repository.plans_of(USER_ID)].count("paused") == 1


def test_e30_takes_no_body_and_ignores_one(client: TestClient) -> None:
    plan = make_plan(client)
    assert resume(client, plan, json={"anything": 1}).status_code == 200
    assert resume(client, plan, content=b"").status_code == 200


def test_e30_a_malformed_plan_id_is_a_validation_error(client: TestClient) -> None:
    response = client.post("/api/plans/not-a-uuid/resume")
    assert (response.status_code, code(response)) == (422, "validation_error")


# --- rate limits, caching, privacy ---------------------------------------------------------------


def test_the_documented_limits() -> None:
    assert plans_router.SESSION_READ_RATE_PER_MIN == 120  # API-spec §1.8, E15
    assert plans_router.SESSION_WRITE_RATE_PER_MIN == 60  # E16, E17, E30


def test_e15_counts_against_the_session_read_class(client: TestClient, env: Env) -> None:
    env.app.state.session_read_limiter = SlidingWindowLimiter(2)
    statuses = [
        client.post("/api/plans/estimate", json=estimate_body()).status_code for _ in range(3)
    ]
    assert statuses == [200, 200, 429]
    blocked = client.post("/api/plans/estimate", json=estimate_body())
    assert code(blocked) == "throttled" and int(blocked.headers["retry-after"]) >= 1


def test_e16_e17_and_e30_share_the_session_write_class(client: TestClient, env: Env) -> None:
    env.app.state.session_write_limiter = SlidingWindowLimiter(3)
    plan = make_plan_without_limit(client)  # one write
    assert revise(client, plan, sessionMinutes=10).status_code == 200  # two
    assert resume(client, plan).status_code == 200  # three
    blocked = client.post("/api/plans", json=create_body())
    assert (blocked.status_code, code(blocked)) == (429, "throttled")


def make_plan_without_limit(client: TestClient) -> dict[str, Any]:
    body = estimate_body()
    estimate = client.post("/api/plans/estimate", json=body).json()["estimate"]
    return client.post("/api/plans", json=body | {"confirmedEstimate": estimate}).json()


def test_error_responses_are_never_cached_either(client: TestClient) -> None:
    response = client.post("/api/plans/estimate", json={})
    assert response.headers["cache-control"] == "no-store"


def test_failures_log_no_plan_data(client: TestClient, log_lines: list[str]) -> None:
    client.post("/api/plans", json=create_body(confirmedEstimate=dict(EXAMPLE_ESTIMATE, days=1)))
    client.post("/api/plans/estimate", json=estimate_body(editionId=str(UNKNOWN_ID)))
    joined = "\n".join(log_lines)
    for private in (str(QURAN_ID), str(PLACEMENT_ID), "2026-10-20", str(USER_ID)):
        assert private not in joined
    assert "estimate_changed" not in joined  # only the route template, status and error code
