"""E28 ``POST /api/demo/plans`` (API-spec §4.9): a demo plan from a trusted scenario, the restricted
planner with its rules fallback, the per-account daily limit, placement input, and the errors.

The catalog is the synthetic bundle pair (surah 112-114 with 12, 23, 33 and 32 words in sections 1
to 3; hadith 1-4), the clock is fixed at 2026-10-04 13:00 Asia/Dubai, and the model is a fake."""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from app.domain.planning_port import ActivePlanConflict
from app.providers.openrouter import OpenRouterProvider
from app.repositories.ai_usage import InMemoryUsageLedger
from app.repositories.plans import StoredPlan
from app.wiring import install_plan_chat
from tests.demo.demo_support import (
    UNSET,
    Env,
    FakeJsonProvider,
    FakeJsonReply,
    Persona,
    advice_reply,
    build_env,
    error_of,
    fields_of,
    good_advice,
    unavailable,
)
from tests.support import make_settings

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
    "pendingSessionMinutes",
    "planner",
}


def post_plan(persona: Persona, scenario_id: str = "scenario-07", **extra: Any):
    return persona.client.post("/api/demo/plans", json={"scenarioId": scenario_id, **extra})


def plans_of(env: Env, persona: Persona) -> list[StoredPlan]:
    return env.plan_repository.plans_of(persona.user_id)


def edition_id(env: Env, key: str) -> UUID:
    editions = env.app.state.catalog_service.list_editions()
    return UUID(next(e.edition_id for e in editions if e.edition_key == key))


def passage_ids(env: Env, key: str) -> list[UUID]:
    content = env.services.content
    assert content is not None
    return [row.passage_id for row in content.passages(edition_id(env, key))]


# --- the rules plan ------------------------------------------------------------------------------


def test_a_demo_plan_is_built_by_the_rules_engine_when_there_is_no_model(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    response = post_plan(demo)
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    plan = response.json()
    assert set(plan) == PLAN_KEYS
    assert plan["planner"] == {"source": "rules"}
    assert plan["targetScope"] == {"sectionOrdinals": [1]}
    assert (plan["paths"], plan["order"], plan["sessionMinutes"]) == (["quran"], "book", 10)
    assert plan["preferredDate"] is None
    assert (plan["status"], plan["currentVersion"]) == ("active", 1)
    assert plan["editionId"] == str(edition_id(env, "quran-hafs-quranenc"))
    assert plan["agreedEstimate"] == {
        "days": 1,
        "endDate": "2026-10-05",
        "newWordsPerDay": 25,
        "totalWords": 12,
        "knownWords": 0,
        "passageCount": 1,
        "sessionMinutes": 10,
        "scope": {"sectionOrdinals": [1]},
        "paths": ["quran"],
        # D92: the 4 ayat of the section over the single estimated day
        "dailyNew": {"unit": "ayah", "perDay": 4, "everyDays": None},
    }


def test_the_scenario_decides_the_plan_parameters(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    deadline = post_plan(demo, "scenario-02").json()  # 5 minutes, a deadline two days away
    assert deadline["targetScope"] == {"sectionOrdinals": [1, 2, 3]}
    assert deadline["sessionMinutes"] == 5 and deadline["preferredDate"] == "2026-10-06"
    assert deadline["agreedEstimate"]["days"] == 10  # longer than the deadline: still a plan
    assert deadline["agreedEstimate"]["endDate"] == "2026-10-14"
    large = post_plan(demo, "scenario-06").json()  # every published section, 15 minutes
    assert large["targetScope"] == {"sectionOrdinals": [1, 2, 3]}
    assert large["agreedEstimate"]["newWordsPerDay"] == 40 and large["agreedEstimate"]["days"] == 3
    hadith = post_plan(demo, "scenario-09").json()  # matn and sanad of three hadiths
    assert hadith["paths"] == ["matn", "sanad"] and hadith["order"] == "book"
    assert hadith["targetScope"] == {"sectionOrdinals": [1, 2, 3]}
    assert hadith["editionId"] == str(edition_id(env, "nawawi40-hadeethenc"))


def test_the_plan_is_saved_for_the_demo_account_only(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    first, second = env.demo("demo_one"), env.demo("demo_two", "203.0.113.10")
    plan = post_plan(first).json()
    saved = plans_of(env, first)
    assert [str(p.plan_id) for p in saved] == [plan["planId"]]
    assert plans_of(env, second) == []
    versions = env.plan_repository.versions_of(UUID(plan["planId"]))
    assert len(versions) == 1 and versions[0]["reasonCode"] == "plan_created"
    assert versions[0]["policy"]["planner"] == {"source": "rules"}
    assert versions[0]["phases"], "the phases cover the scope"


def test_a_new_demo_plan_pauses_the_previous_active_plan(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    first = post_plan(demo, "scenario-07").json()
    second = post_plan(demo, "scenario-08").json()
    assert second["status"] == "active"
    by_id = {str(p.plan_id): p.status for p in plans_of(env, demo)}
    assert by_id == {first["planId"]: "paused", second["planId"]: "active"}


def test_the_demo_account_still_cannot_use_e16(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    response = env.demo().client.post("/api/plans", json={"editionId": "x"})
    assert response.status_code == 403 and error_of(response)["code"] == "forbidden"


# --- the Teaching Agent --------------------------------------------------------------------------


def test_valid_advice_sets_the_pace_and_is_labelled_teaching_agent(tmp_path: Path) -> None:
    provider = FakeJsonProvider(advice_reply(newWordsPerDay=5))
    env = build_env(tmp_path, provider=provider)
    plan = post_plan(env.demo()).json()
    assert plan["planner"] == {"source": "teaching_agent", "model": "free-model-x"}
    estimate = plan["agreedEstimate"]
    assert estimate["newWordsPerDay"] == 5
    assert estimate["days"] == 3 and estimate["endDate"] == "2026-10-07"  # ceil(12 / 5 * 1.15)
    assert estimate["totalWords"] == 12 and estimate["passageCount"] == 1
    assert len(provider.calls) == 1
    [row] = env.ledger.rows
    assert (row.status, row.model, row.prompt_version) == (
        "succeeded",
        "free-model-x",
        "demo-planner-v1",
    )


def test_an_advised_pace_changes_the_days_and_the_daily_amount_together(tmp_path: Path) -> None:
    """D92: ``dailyNew`` is derived from the estimated days, so advice that stretches the days
    must restate the daily amount for the new days, never keep the rules engine's amount."""
    rules_env = build_env(tmp_path / "rules", provider=None)
    agent_env = build_env(
        tmp_path / "agent", provider=FakeJsonProvider(advice_reply(newWordsPerDay=3))
    )
    rules = post_plan(rules_env.demo(), "scenario-02").json()["agreedEstimate"]
    agent_plan = post_plan(agent_env.demo(), "scenario-02").json()
    agent = agent_plan["agreedEstimate"]
    assert agent_plan["planner"]["source"] == "teaching_agent"
    # 15 ayat (100 words): the rules pace gives 10 days, two ayat a day ...
    assert (rules["days"], rules["newWordsPerDay"]) == (10, 12)
    assert rules["dailyNew"] == {"unit": "ayah", "perDay": 2, "everyDays": None}
    # ... the advised pace of 3 words a day gives 39 days: fewer ayat than days, one every 3 days.
    assert (agent["days"], agent["newWordsPerDay"]) == (39, 3)
    assert agent["dailyNew"] == {"unit": "ayah", "perDay": None, "everyDays": 3}
    assert (agent["totalWords"], agent["knownWords"]) == (rules["totalWords"], rules["knownWords"])
    stored = agent_env.plan_repository.versions_of(UUID(agent_plan["planId"]))[0]
    assert stored["policy"]["agreedEstimate"]["dailyNew"] == agent["dailyNew"]
    assert stored["policy"]["agreedEstimate"]["days"] == 39


def test_an_advised_pace_restates_the_daily_amount_of_a_single_section(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=FakeJsonProvider(advice_reply(newWordsPerDay=5)))
    estimate = post_plan(env.demo()).json()["agreedEstimate"]
    assert estimate["days"] == 3  # the rules engine's single day became three
    assert estimate["dailyNew"] == {"unit": "ayah", "perDay": 1, "everyDays": None}  # not 4


def test_the_advised_offsets_and_priority_are_recorded_with_the_plan_version(
    tmp_path: Path,
) -> None:
    provider = FakeJsonProvider(advice_reply(reviewOffsetsDays=[2, 5]))
    env = build_env(tmp_path, provider=provider)
    plan = post_plan(env.demo()).json()
    [version] = env.plan_repository.versions_of(UUID(plan["planId"]))
    recorded = version["policy"]["planner"]
    assert recorded["source"] == "teaching_agent" and recorded["model"] == "free-model-x"
    assert recorded["advice"]["newWordsPerDay"] == 5
    assert recorded["advice"]["reviewOffsetsDays"] == [2, 5]
    assert recorded["advice"]["priorityReviewPassageIds"] == [
        provider.calls[0]["passages"][0]["id"]
    ]
    assert recorded["advice"]["promptVersion"] == "demo-planner-v1"
    assert version["policy"]["agreedEstimate"]["newWordsPerDay"] == 5


def test_the_agent_never_changes_the_passages_or_their_order(tmp_path: Path) -> None:
    rules_env = build_env(tmp_path / "rules", provider=None)
    agent_env = build_env(
        tmp_path / "agent", provider=FakeJsonProvider(advice_reply(newWordsPerDay=3))
    )
    rules = post_plan(rules_env.demo(), "scenario-02").json()
    agent = post_plan(agent_env.demo(), "scenario-02").json()
    assert agent["planner"]["source"] == "teaching_agent" and rules["planner"]["source"] == "rules"
    assert agent["agreedEstimate"]["newWordsPerDay"] == 3
    rules_phases = rules_env.plan_repository.versions_of(UUID(rules["planId"]))[0]["phases"]
    agent_phases = agent_env.plan_repository.versions_of(UUID(agent["planId"]))[0]["phases"]
    assert [p["section_refs"] for p in agent_phases] == [p["section_refs"] for p in rules_phases]
    assert [p["unit_range"] for p in agent_phases] == [p["unit_range"] for p in rules_phases]
    assert [p["goal_size"] for p in agent_phases] == [p["goal_size"] for p in rules_phases]
    assert sum(p["goal_size"] for p in agent_phases) == agent["agreedEstimate"]["totalWords"]


def test_the_model_sees_only_the_allowed_payload(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider)
    demo = env.demo()
    post_plan(demo, "scenario-05")
    [payload] = provider.calls
    assert set(payload) == {"scenarioId", "passages", "placement", "maxNewWordsPerDay"}
    assert payload["scenarioId"] == "scenario-05"
    assert payload["maxNewWordsPerDay"] == 25
    assert payload["placement"] == {"correct": 2, "incorrect": 2}  # the fixture's synthetic summary
    assert [set(p) for p in payload["passages"]] == [{"id", "wordCount"}] * 2
    assert [p["wordCount"] for p in payload["passages"]] == [12, 23]  # surah 112 and 113, in order
    dumped = json.dumps(payload)
    for private in (demo.username, str(demo.user_id), "203.0.113", "Origin", "qatra_session"):
        assert private not in dumped


@pytest.mark.parametrize(
    "script, status, reason",
    [
        (unavailable("timeout", model="m"), "timed_out", "timeout"),
        (unavailable("error", model="m"), "failed", "error"),
        (unavailable("ineligible", model="m"), "rules_fallback", "ineligible"),
        (unavailable("invalid_output", model="m"), "failed", "invalid_output"),
        (RuntimeError("provider exploded"), "failed", "error"),
        (lambda payload: FakeJsonReply("not an object"), "failed", "invalid_advice"),
        (advice_reply(newWordsPerDay=0), "failed", "invalid_advice"),
        (
            advice_reply(newWordsPerDay=26),
            "failed",
            "invalid_advice",
        ),  # above the 10-minute capacity
        (advice_reply(reviewOffsetsDays=[3, 1]), "failed", "invalid_advice"),
        (advice_reply(priorityReviewPassageIds=["not-a-passage"]), "failed", "invalid_advice"),
    ],
    ids=[
        "timeout",
        "error",
        "ineligible",
        "invalid-output",
        "exception",
        "not-json-object",
        "pace-zero",
        "pace-over-capacity",
        "offsets-descending",
        "invented-id",
    ],
)
def test_every_model_failure_is_a_rules_plan_and_not_an_error(
    tmp_path: Path, script: Any, status: str, reason: str
) -> None:
    env = build_env(tmp_path, provider=FakeJsonProvider(script))
    response = post_plan(env.demo())
    assert response.status_code == 201
    plan = response.json()
    assert plan["planner"] == {"source": "rules"}
    assert plan["agreedEstimate"]["newWordsPerDay"] == 25  # the rules engine's pace
    [row] = env.ledger.rows
    assert (row.status, row.quota_record) == (status, {"reason": reason})
    assert row.cost_usd is None
    [version] = env.plan_repository.versions_of(UUID(plan["planId"]))
    assert "advice" not in version["policy"]["planner"]


@pytest.mark.parametrize(
    "provider",
    [
        None,
        FakeJsonProvider(enabled=False),
        FakeJsonProvider(unavailable("disabled")),
    ],
    ids=["no-provider", "disabled", "raises-disabled"],
)
def test_without_a_usable_model_no_usage_row_is_written(tmp_path: Path, provider: Any) -> None:
    env = build_env(tmp_path, provider=provider)
    response = post_plan(env.demo())
    assert response.status_code == 201 and response.json()["planner"] == {"source": "rules"}
    assert env.ledger.rows == []


def test_the_exhausted_free_budget_falls_back_to_rules_and_is_not_a_429(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider, QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY=1)
    demo = env.demo()
    assert post_plan(demo).json()["planner"]["source"] == "teaching_agent"
    second = post_plan(demo, "scenario-08")
    assert second.status_code == 201 and second.json()["planner"] == {"source": "rules"}
    assert len(provider.calls) == 1 and len(env.ledger.rows) == 1


def test_the_account_model_cap_is_shared_with_the_ledger(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider, QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY=1)
    first, second = env.demo("demo_one"), env.demo("demo_two", "203.0.113.10")
    assert post_plan(first).json()["planner"]["source"] == "teaching_agent"
    assert post_plan(first, "scenario-08").json()["planner"]["source"] == "rules"
    assert post_plan(second).json()["planner"]["source"] == "teaching_agent"


def test_a_provider_with_only_the_chat_completion_means_rules(tmp_path: Path) -> None:
    from tests.demo.demo_support import ChatOnlyProvider

    chat_only = ChatOnlyProvider()
    env = build_env(tmp_path, provider=chat_only)
    response = post_plan(env.demo())
    assert response.status_code == 201 and response.json()["planner"] == {"source": "rules"}
    assert chat_only.calls == 0 and env.ledger.rows == []


def test_the_real_openrouter_provider_never_breaks_the_endpoint(tmp_path: Path) -> None:
    import httpx

    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    settings = make_settings(OPENROUTER_API_KEY="test-key-not-real", OPENROUTER_MODELS="free/model")
    provider = OpenRouterProvider(settings, httpx.MockTransport(refuse))
    env = build_env(tmp_path, provider=provider)
    response = post_plan(env.demo())
    assert response.status_code == 201 and response.json()["planner"] == {"source": "rules"}


def test_the_planner_takes_the_plan_conversations_provider_and_ledger_lazily(
    tmp_path: Path,
) -> None:
    env = build_env(tmp_path, provider=UNSET)
    demo = env.demo()
    assert post_plan(demo).json()["planner"] == {"source": "rules"}  # nothing to ask yet
    ledger = InMemoryUsageLedger()
    first = FakeJsonProvider(advice_reply(newWordsPerDay=6))
    install_plan_chat(env.app, env.settings, provider=first, ledger=ledger)
    assert post_plan(demo, "scenario-08").json()["planner"]["source"] == "teaching_agent"
    assert env.app.state.plan_chat_service.ledger is ledger and len(ledger.rows) == 1
    second = FakeJsonProvider(unavailable("timeout", model="m2"))
    install_plan_chat(env.app, env.settings, provider=second, ledger=ledger)  # replaced later
    assert post_plan(demo).json()["planner"] == {"source": "rules"}
    assert len(first.calls) == 1 and len(second.calls) == 1
    assert [r.status for r in ledger.rows] == ["succeeded", "timed_out"]


# --- placement -----------------------------------------------------------------------------------


def seeded_placement(
    env: Env,
    persona: Persona,
    placement_id: UUID,
    *,
    known: list[int],
    incorrect: list[int],
    key: str = "quran-hafs-quranenc",
    owner: UUID | None = None,
) -> None:
    ids = passage_ids(env, key)
    assert env.services.placements is not None
    env.services.placements.add_session(
        owner or persona.user_id,
        placement_id,
        edition_id(env, key),
        {ids[i] for i in known},
        {ids[i] for i in incorrect},
    )


PLACEMENT = UUID("33333333-3333-4333-8333-000000000001")


def test_a_placement_session_shortens_the_plan_and_feeds_the_counts(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider)
    demo = env.demo()
    seeded_placement(env, demo, PLACEMENT, known=[0], incorrect=[1])
    response = post_plan(demo, "scenario-02", placementSessionId=str(PLACEMENT))
    assert response.status_code == 201
    estimate = response.json()["agreedEstimate"]
    assert estimate["knownWords"] == 12  # surah 112 was answered correctly
    [payload] = provider.calls
    assert payload["placement"] == {"correct": 1, "incorrect": 1}  # the session, not the fixture
    [version] = env.plan_repository.versions_of(UUID(response.json()["planId"]))
    assert version["policy"]["knownPassages"]["placementSessionId"] == str(PLACEMENT)


def test_only_the_passages_of_the_scope_are_counted(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider)
    demo = env.demo()
    seeded_placement(env, demo, PLACEMENT, known=[0, 2], incorrect=[1, 3])
    response = post_plan(demo, "scenario-01", placementSessionId=str(PLACEMENT))  # surah 112 only
    assert response.status_code == 201
    assert provider.calls[0]["placement"] == {"correct": 1, "incorrect": 0}


def test_an_unknown_foreign_or_other_edition_placement_is_404(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider)
    first, second = env.demo("demo_one"), env.demo("demo_two", "203.0.113.10")
    seeded_placement(env, first, PLACEMENT, known=[0], incorrect=[])
    unknown = post_plan(first, placementSessionId="99999999-9999-4999-8999-999999999999")
    foreign = post_plan(second, placementSessionId=str(PLACEMENT))
    other_edition = post_plan(first, "scenario-08", placementSessionId=str(PLACEMENT))
    for response in (unknown, foreign, other_edition):
        assert response.status_code == 404 and error_of(response)["code"] == "not_found"
    assert provider.calls == [] and env.ledger.rows == []
    assert plans_of(env, first) == [] and plans_of(env, second) == []


def test_a_malformed_placement_id_is_a_validation_error(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    response = post_plan(env.demo(), placementSessionId="not-a-uuid")
    assert response.status_code == 422
    assert fields_of(response)[0][0] == "placementSessionId"


# --- roles, origin and the body ------------------------------------------------------------------


def test_a_visitor_is_unauthenticated(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    response = env.visitor().post("/api/demo/plans", json={"scenarioId": "scenario-07"})
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"


def test_a_learner_is_forbidden_before_the_body_is_looked_at(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=FakeJsonProvider())
    learner = env.learner()
    for body in ({"scenarioId": "scenario-07"}, {"bogus": 1}, {}):
        response = learner.client.post("/api/demo/plans", json=body)
        assert response.status_code == 403 and error_of(response)["code"] == "forbidden"
    assert plans_of(env, learner) == []


def test_the_origin_is_required(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    bare = env.client(origin=False)
    bare.cookies = demo.client.cookies  # type: ignore[assignment]
    response = bare.post("/api/demo/plans", json={"scenarioId": "scenario-07"})
    assert response.status_code == 403 and error_of(response)["code"] == "forbidden_origin"


@pytest.mark.parametrize(
    "scenario_id", ["scenario-99", "", "SCENARIO-07", " scenario-07", "x" * 100]
)
def test_an_unknown_scenario_id_is_unknown_scenario(tmp_path: Path, scenario_id: str) -> None:
    env = build_env(tmp_path, provider=FakeJsonProvider())
    response = post_plan(env.demo(), scenario_id)
    assert response.status_code == 422
    assert fields_of(response) == [("scenarioId", "unknown_scenario")]


def test_a_scenario_whose_edition_is_not_published_is_unknown_scenario(tmp_path: Path) -> None:
    from tests.demo.demo_support import DATA

    env = build_env(
        tmp_path, provider=FakeJsonProvider(), bundles=str(DATA / "synthetic_bundle.json")
    )
    demo = env.demo()
    assert post_plan(demo, "scenario-07").status_code == 201
    response = post_plan(demo, "scenario-08")  # a hadith, and no hadith edition is published
    assert response.status_code == 422 and fields_of(response) == [
        ("scenarioId", "unknown_scenario")
    ]


@pytest.mark.parametrize(
    "extra",
    ["isDemo", "mode", "userId", "goal", "goalText", "editionId", "targetScope", "sessionMinutes"],
)
def test_nothing_but_the_scenario_and_the_placement_may_be_sent(tmp_path: Path, extra: str) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider)
    demo = env.demo()
    response = post_plan(demo, **{extra: "x"})
    assert response.status_code == 422
    assert fields_of(response) == [(extra, "forbidden_field")]
    assert provider.calls == [] and plans_of(env, demo) == []


def test_the_scenario_id_is_required_and_must_be_text(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    assert fields_of(demo.client.post("/api/demo/plans", json={})) == [("scenarioId", "required")]
    assert demo.client.post("/api/demo/plans", json={"scenarioId": 7}).status_code == 422
    assert demo.client.post("/api/demo/plans", json={"scenarioId": "x" * 101}).status_code == 422
    assert demo.client.post("/api/demo/plans", content=b"{").status_code == 422


# --- the daily limit and failures ----------------------------------------------------------------


def test_the_eleventh_plan_of_a_day_is_throttled(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    for _ in range(10):
        assert post_plan(demo).status_code == 201
    response = post_plan(demo)
    assert response.status_code == 429
    error = error_of(response)
    assert error["code"] == "throttled"
    assert response.headers["retry-after"] == str(error["details"]["retryAfterSec"]) == "54000"
    assert len(plans_of(env, demo)) == 10
    other = env.demo("demo_two", "203.0.113.10")
    assert post_plan(other).status_code == 201  # another account is not affected


def test_the_plan_limit_resets_with_the_utc_day(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None, QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY=2)
    demo = env.demo()
    assert post_plan(demo).status_code == 201 and post_plan(demo).status_code == 201
    assert post_plan(demo).status_code == 429
    env.clock.now += timedelta(hours=15, seconds=1)
    assert post_plan(demo).status_code == 201


def test_a_throttled_request_makes_no_model_call(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider, QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY=1)
    demo = env.demo()
    assert post_plan(demo).status_code == 201
    assert post_plan(demo).status_code == 429
    assert len(provider.calls) == 1


def test_only_created_plans_count_against_the_daily_limit(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None, QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY=2)
    demo = env.demo()
    seeded_placement(env, demo, PLACEMENT, known=[0], incorrect=[])
    refused = [
        post_plan(demo, "scenario-99"),  # unknown scenario
        post_plan(demo, placementSessionId="99999999-9999-4999-8999-999999999999"),  # 404
        post_plan(demo, isDemo=True),  # forbidden field
    ]
    assert [r.status_code for r in refused] == [422, 404, 422]
    assert post_plan(demo).status_code == 201
    assert post_plan(demo, placementSessionId=str(PLACEMENT)).status_code == 201
    assert post_plan(demo).status_code == 429


def test_an_active_plan_race_is_a_409_and_gives_the_reservation_back(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None, QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY=1)
    demo = env.demo()
    repository = env.plan_repository
    original = repository.create_plan
    raised: list[int] = []

    def racing(ctx: Any, commit: Any) -> Any:
        if not raised:
            raised.append(1)
            raise ActivePlanConflict
        return original(ctx, commit)

    repository.create_plan = racing
    response = post_plan(demo)
    assert response.status_code == 409
    error = error_of(response)
    assert (
        error["code"] == "version_conflict" and error["details"]["reason"] == "active_plan_conflict"
    )
    assert plans_of(env, demo) == []
    assert post_plan(demo).status_code == 201  # the failed attempt did not use up the day's plan


def test_missing_plan_services_are_unavailable(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    env.app.state.plan_service = None
    response = post_plan(demo)
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"


def test_a_failing_provider_response_is_still_deterministic_in_the_plan_numbers(
    tmp_path: Path,
) -> None:
    ok = build_env(tmp_path / "a", provider=None)
    failing = build_env(
        tmp_path / "b", provider=FakeJsonProvider(unavailable("timeout", model="m"))
    )
    plan_ok = post_plan(ok.demo()).json()["agreedEstimate"]
    plan_failing = post_plan(failing.demo()).json()["agreedEstimate"]
    assert plan_ok == plan_failing


def test_good_advice_helper_builds_from_the_payload() -> None:
    payload = {"passages": [{"id": "abc", "wordCount": 3}]}
    assert good_advice(payload).data["priorityReviewPassageIds"] == ["abc"]
