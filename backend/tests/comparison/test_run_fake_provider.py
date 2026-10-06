"""Whole comparison runs against a fake model: results, fallback, Not run and payload hygiene."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

import pytest

from app.domain.plan_chat_policy import find_disallowed_keys
from scripts import ai_comparison as ai
from scripts import demo_catalog as catalog
from tests.comparison.cmp_support import (
    TODAY,
    Factory,
    Tick,
    World,
    build_world,
    entry,
    oracle,
    unavailable,
)

MODEL = "free/a:free"
APP_DIR = Path(__file__).resolve().parents[2] / "app"


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> World:
    return build_world(tmp_path_factory.mktemp("world"))


def run(
    world: World,
    responder: Any,
    *,
    models: tuple[str, ...] = (MODEL,),
    runs: int = 1,
    only: set[str] | None = None,
    placement_detail: str = ai.PLACEMENT_COUNTS,
    pause: float = 3.5,
    **provider_values: Any,
) -> tuple[ai.ComparisonResult, Factory, list[float]]:
    status, prepared = ai.plan_scenarios(
        world.scenarios, world.expectations, only, catalog.edition_list()
    )
    factory = Factory(responder, **provider_values)
    sleeps: list[float] = []
    result = ai.run_comparison(
        status,
        prepared,
        models=list(models),
        runs=runs,
        provider_factory=factory,
        kit=ai.default_kit(),
        language="en",
        placement_detail=placement_detail,
        max_tokens=400,
        timeout=8.0,
        pause=pause,
        sleep=sleeps.append,
        clock=Tick(0.5),
        today=TODAY,
    )
    return result, factory, sleeps


def cells(world: World, result: ai.ComparisonResult) -> dict[str, dict[str, str]]:
    table = ai.build_cells(result.records, result.columns, world.expectations)
    return {col: {m: cell.text() for m, cell in row.items()} for col, row in table.items()}


def ai_records(result: ai.ComparisonResult) -> list[ai.RunRecord]:
    return [r for r in result.records if r.alternative == "ai"]


# --- results --------------------------------------------------------------------------------------


def test_a_model_that_follows_the_pinned_answers_succeeds_everywhere(world: World) -> None:
    result, factory, _ = run(world, oracle(world))
    column = cells(world, result)[f"ai:{MODEL}"]
    assert column == {
        "goal_recognition": "6/6",
        "realism": "6/6",
        "coverage": "6/6",
        "error_priority": "3/3",
        "resume_reference": "6/6",
    }
    assert result.requests_sent == 12 and len(factory.calls) == 12
    assert all(not r.fallback and not r.timed_out for r in ai_records(result))


def test_the_baselines_are_scored_without_goal_recognition(world: World) -> None:
    result, _, _ = run(world, oracle(world))
    table = cells(world, result)
    for column in ("fixed", "rules"):
        assert table[column]["goal_recognition"] == "N/A"  # G-9: never counted as success
        assert table[column]["coverage"] == "6/6"
    assert table["rules"]["realism"] == "6/6" and table["rules"]["resume_reference"] == "6/6"
    assert table["fixed"]["realism"] != "6/6"  # too fast for 5 minutes and for the buffer
    assert table["fixed"]["resume_reference"] == "4/6"  # no light review after the two absences
    assert table["rules"]["error_priority"] == "1/3"
    assert table["fixed"]["error_priority"] == "1/3"
    assert table[f"ai:{MODEL}"]["error_priority"] == "3/3"  # the priority ids make the difference


def test_baselines_run_once_per_scenario_and_ai_runs_repeat(world: World) -> None:
    result, factory, _ = run(world, oracle(world), runs=3, only={"t-one", "t-little"})
    table = cells(world, result)
    assert table["rules"]["realism"] == "2/2" and table["fixed"]["coverage"] == "2/2"
    assert table[f"ai:{MODEL}"]["realism"] == "6/6"
    assert len(factory.calls) == 2 * 3 * 2


def test_two_models_get_their_own_columns_and_cost_rows(world: World) -> None:
    result, factory, _ = run(world, oracle(world), models=("free/a:free", "free/b:free"))
    assert result.columns == ["fixed", "rules", "ai:free/a:free", "ai:free/b:free"]
    assert set(factory.providers) == {"free/a:free", "free/b:free"}
    rows = ai.cost_rows(result.records, result.models)
    assert [r.model for r in rows] == ["free/a:free", "free/b:free"]
    assert all(r.calls == 12 and r.fallback == "0/6" for r in rows)


def test_a_wrong_goal_answer_fails_only_the_goal_metric(world: World) -> None:
    base = oracle(world)

    def respond(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        answer = base(kind, payload)
        if kind == "goal":
            answer = {**answer, "sectionOrdinals": [112]}
        return answer

    result, _, _ = run(world, respond, only={"t-little"})
    column = cells(world, result)[f"ai:{MODEL}"]
    assert column["goal_recognition"] == "0/1" and column["realism"] == "1/1"


# --- fallback and failures ------------------------------------------------------------------------


def test_an_invented_passage_id_is_refused_and_fails_the_reference_check(world: World) -> None:
    base = oracle(world)

    def respond(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        answer = base(kind, payload)
        if kind == "planner":
            answer = {**answer, "priorityReviewPassageIds": [str(uuid.uuid4())]}
        return answer

    result, _, _ = run(world, respond, only={"t-one"})
    (record,) = ai_records(result)
    assert record.fallback is True and record.metrics["resume_reference"] is False
    assert record.metrics["realism"] is True  # the delivered plan is the rules plan
    planner_call = record.calls[-1]
    assert planner_call.kind == "planner" and planner_call.outcome == "invalid_output"
    assert cells(world, result)[f"ai:{MODEL}"]["resume_reference"] == "0/1"
    overhead = ai.overhead_cells(result.records, result.columns)[f"ai:{MODEL}"]
    assert "fallback 1/1" in overhead and "timeout 0/1" in overhead


def test_a_pace_above_the_capacity_falls_back_without_a_reference_failure(world: World) -> None:
    base = oracle(world)

    def respond(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        answer = base(kind, payload)
        if kind == "planner":
            answer = {**answer, "newWordsPerDay": payload["maxNewWordsPerDay"] + 1}
        return answer

    result, _, _ = run(world, respond, only={"t-one"})
    (record,) = ai_records(result)
    assert record.fallback is True and record.metrics["resume_reference"] is True


def test_a_timeout_is_counted_and_the_run_still_executes_on_the_rules_plan(world: World) -> None:
    base = oracle(world)

    def respond(kind: str, payload: dict[str, Any]) -> Any:
        return unavailable("timeout") if kind == "planner" else base(kind, payload)

    result, _, _ = run(world, respond, only={"t-one"})
    (record,) = ai_records(result)
    assert record.status == "executed" and record.timed_out and record.fallback
    assert record.metrics["goal_recognition"] is True and record.metrics["realism"] is True
    assert "timeout 1/1" in ai.overhead_cells(result.records, result.columns)[f"ai:{MODEL}"]


def test_a_goal_call_that_fails_after_sending_fails_the_goal_metric(world: World) -> None:
    base = oracle(world)

    def respond(kind: str, payload: dict[str, Any]) -> Any:
        return unavailable("error") if kind == "goal" else base(kind, payload)

    result, _, _ = run(world, respond, only={"t-one"})
    (record,) = ai_records(result)
    assert record.status == "executed" and record.metrics["goal_recognition"] is False
    assert record.fallback is False and record.metrics["realism"] is True


def test_an_unexpected_exception_is_an_error_outcome_without_its_message(world: World) -> None:
    def respond(kind: str, payload: dict[str, Any]) -> Any:
        return RuntimeError("secret provider text sk-or-FAKE")

    result, _, _ = run(world, respond, only={"t-one"})
    (record,) = ai_records(result)
    assert [c.outcome for c in record.calls] == ["error", "error"]
    assert "secret" not in json.dumps(
        ai.build_report(
            result,
            world.expectations,
            expectations_sha="x",
            scenarios_sha="y",
            kit=ai.default_kit(),
            args_summary={},
        )
    )


# --- Not run --------------------------------------------------------------------------------------


def test_an_ineligible_model_is_not_run_and_stays_out_of_every_denominator(world: World) -> None:
    result, factory, _ = run(world, lambda kind, payload: unavailable("ineligible"))
    records = ai_records(result)
    assert records and all(r.status == "not_run" for r in records)
    assert all(r.reason == ai.MODEL_NOT_AVAILABLE for r in records)
    table = cells(world, result)
    assert set(table[f"ai:{MODEL}"].values()) == {"Not run"}
    assert table["rules"]["realism"] == "6/6"  # the baselines are not affected
    assert result.requests_sent == 0
    assert ai.cost_rows(result.records, result.models)[0].calls == 0
    assert len(factory.calls) == len(records)  # one refused goal request each, no planner call


def test_a_disabled_provider_is_not_run(world: World) -> None:
    result, _, _ = run(world, lambda kind, payload: unavailable("disabled"), only={"t-one"})
    assert [r.status for r in ai_records(result)] == ["not_run"]


def test_scenarios_that_were_not_selected_are_not_run_and_not_counted(world: World) -> None:
    result, _, _ = run(world, oracle(world), only={"t-absent", "t-one"})
    assert [s["reason"] for s in result.scenario_status].count(ai.NOT_SELECTED) == 4
    table = cells(world, result)
    assert table["rules"]["coverage"] == "2/2"
    assert table[f"ai:{MODEL}"]["error_priority"] == "1/1"  # only t-absent has a pinned error


def test_a_metric_no_selected_scenario_applies_to_is_not_run(world: World) -> None:
    result, _, _ = run(world, oracle(world), only={"t-one"})
    assert cells(world, result)["rules"]["error_priority"] == "Not run"


def test_a_metric_no_scenario_of_the_file_applies_to_is_not_applicable(tmp_path: Path) -> None:
    plain = build_world(tmp_path, [entry("a", 1), entry("b", 7)])
    result, _, _ = run(plain, oracle(plain))
    table = cells(plain, result)
    assert table["rules"]["error_priority"] == "N/A"
    assert table[f"ai:{MODEL}"]["error_priority"] == "N/A"
    assert table[f"ai:{MODEL}"]["goal_recognition"] == "2/2"


def test_without_models_the_ai_column_is_not_run(world: World) -> None:
    status, prepared = ai.plan_scenarios(
        world.scenarios, world.expectations, None, catalog.edition_list()
    )
    result = ai.run_comparison(
        status,
        prepared,
        models=[],
        runs=1,
        provider_factory=None,
        kit=ai.default_kit(),
        language="en",
        placement_detail=ai.PLACEMENT_COUNTS,
        max_tokens=400,
        timeout=8.0,
        pause=0,
        sleep=lambda s: None,
        clock=Tick(),
        today=TODAY,
    )
    assert result.columns == ["fixed", "rules", "ai"]
    assert set(cells(world, result)["ai"].values()) == {"Not run"}
    assert result.requests_sent == 0
    assert ai.overhead_cells(result.records, result.columns)["ai"] == "Not run"


def test_a_scenario_without_a_pinned_answer_is_not_run(tmp_path: Path) -> None:
    world = build_world(tmp_path)
    extra, _ = ai.load_scenarios(_write(tmp_path, [entry("unpinned", 1)]))
    status, prepared = ai.plan_scenarios(
        [*world.scenarios, *extra], world.expectations, None, catalog.edition_list()
    )
    reasons = {s["scenarioId"]: s["reason"] for s in status if s["status"] == "not_run"}
    assert reasons == {"unpinned": ai.NO_EXPECTATION}
    assert len(prepared) == len(world.scenarios)


def _write(tmp_path: Path, entries: list[dict[str, Any]]) -> Path:
    path = tmp_path / f"extra-{entries[0]['scenarioId']}.json"
    path.write_text(json.dumps({"fixtureVersion": 1, "scenarios": entries}), encoding="utf-8")
    return path


def test_each_resolution_failure_has_its_own_reason(tmp_path: Path) -> None:
    cases = {
        "lost": (entry("lost", 1, editionKeyPrefixes=["no-book"]), ai.EDITION_NOT_RESOLVED),
        "nosec": (entry("nosec", 1, sectionRefs=["999"]), ai.NO_SECTIONS),
        "nopath": (entry("nopath", 1, paths=["sanad"]), ai.PATH_UNAVAILABLE),
    }
    editions = catalog.edition_list()
    for scenario_id, (item, reason) in cases.items():
        scenarios, _ = ai.load_scenarios(_write(tmp_path, [item]))
        expectation = ai.Expectation(
            scenario_id, 1, "quran-hafs-quranenc", ("112",), 4, 6, (), False
        )
        assert ai.prepare(scenarios[0], expectation, editions) == reason
    scenarios, _ = ai.load_scenarios(_write(tmp_path, [entry("refs", 1, errorPassageRefs=["999"])]))
    expectation = ai.Expectation("refs", 1, "quran-hafs-quranenc", ("112",), 4, 6, (), False)
    assert ai.prepare(scenarios[0], expectation, editions) == ai.ERROR_REFS_UNRESOLVED
    mismatch = ai.Expectation("refs", 1, "quran-hafs-quranenc", ("113",), 4, 6, (), False)
    assert ai.prepare(scenarios[0], mismatch, editions) == ai.EXPECTATION_MISMATCH


# --- cost, tokens and latency ---------------------------------------------------------------------


def test_tokens_latency_and_a_known_zero_cost_are_reported(world: World) -> None:
    result, _, _ = run(world, oracle(world), only={"t-one"})
    (row,) = ai.cost_rows(result.records, result.models)
    assert row.calls == 2 and row.avg_input_tokens == 900 and row.avg_output_tokens == 40
    assert row.cost_per_call == "0"
    assert row.p50_s == 0.5 and row.p95_s == 0.5
    assert row.success_all == "1/1" and row.fallback == "0/1"


def test_an_unknown_cost_is_unknown_never_zero(world: World) -> None:
    result, _, _ = run(world, oracle(world), only={"t-one"}, cost_usd=None)
    (row,) = ai.cost_rows(result.records, result.models)
    assert row.cost_per_call == "unknown"
    assert "unknown" in ai.overhead_cells(result.records, result.columns)[f"ai:{MODEL}"]


def test_a_partly_known_cost_says_how_much_is_known() -> None:
    assert ai._fmt_cost([0.5, None]) == "0.5 (1/2 known)"
    assert ai._fmt_cost([0.25, 0.75]) == "0.5"
    assert ai._fmt_cost([]) == "-"


def test_the_two_tables_render_in_the_layout_of_the_qa_document(world: World) -> None:
    result, _, _ = run(world, oracle(world), only={"t-one", "t-absent"})
    table = ai.render_metric_table(
        ai.build_cells(result.records, result.columns, world.expectations),
        ai.overhead_cells(result.records, result.columns),
        result.columns,
    )
    lines = table.splitlines()
    assert lines[0].startswith("| المقياس | الخطة الثابتة | خطة القواعد | خطة AI (free/a:free) |")
    assert len(lines) == 2 + 6  # five metrics and the timeout, cost and fallback row
    assert "التعرف على الهدف" in lines[2] and "N/A" in lines[2]
    cost = ai.render_cost_table(ai.cost_rows(result.records, result.models)).splitlines()
    assert cost[0].count("|") == 8 and cost[2].startswith("| free/a:free | 4 |")


# --- payload hygiene ------------------------------------------------------------------------------


def test_only_the_allowlisted_data_reaches_the_model(world: World) -> None:
    result, factory, _ = run(world, oracle(world))
    kit = ai.default_kit()
    texts = {p.scenario.goal_text_en for p in world.prepared.values()}
    titles = {p.scenario.title_en for p in world.prepared.values()}
    assert factory.calls
    for call in factory.calls:
        encoded = json.dumps(call["payload"], ensure_ascii=False)
        if call["kind"] == "planner":
            assert find_disallowed_keys(call["payload"], kit.allowed_keys) == []
            assert not any(text in encoded for text in texts | titles)
            assert set(call["payload"]) <= {
                "scenarioId",
                "passages",
                "placement",
                "maxNewWordsPerDay",
            }
            assert call["system_prompt"] == kit.prompt and call["schema"] == kit.schema
            assert not re.search(r"username|account|ip address|session", encoded, re.I)
        else:
            assert find_disallowed_keys(call["payload"], ai.GOAL_PAYLOAD_KEYS) == []
            assert call["payload"]["goalText"] in texts
            assert call["system_prompt"] == ai.GOAL_SYSTEM_PROMPT
            assert call["schema_name"] == ai.GOAL_SCHEMA_NAME
    assert result.requests_sent == len(factory.calls)


def test_the_planner_payload_counts_placement_unless_the_experiment_is_asked_for(
    world: World,
) -> None:
    prepared = world.prepared["t-late-error"]
    kit = ai.default_kit()
    counts = ai.planner_payload(kit, prepared)
    assert counts["placement"] == {"correct": 5, "incorrect": 1}
    ids = ai.planner_payload(kit, prepared, ai.PLACEMENT_IDS)
    assert ids["placement"]["incorrect"] == [str(i) for i in prepared.expected_error_ids]
    assert find_disallowed_keys(ids, kit.allowed_keys) == []


def test_naming_the_incorrect_passages_is_what_lets_a_model_prioritise_them(world: World) -> None:
    def naive(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        if kind == "goal":
            return oracle(world)(kind, payload)
        incorrect = payload["placement"]["incorrect"]
        return {
            "newWordsPerDay": payload["maxNewWordsPerDay"],
            "reviewOffsetsDays": [1, 3],
            "priorityReviewPassageIds": incorrect if isinstance(incorrect, list) else [],
        }

    counts, _, _ = run(world, naive, only={"t-late-error"})
    ids, _, _ = run(world, naive, only={"t-late-error"}, placement_detail=ai.PLACEMENT_IDS)
    assert cells(world, counts)[f"ai:{MODEL}"]["error_priority"] == "0/1"
    assert cells(world, ids)[f"ai:{MODEL}"]["error_priority"] == "1/1"


def test_the_goal_interpretation_exists_only_in_the_harness() -> None:
    for path in APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert ai.GOAL_PROMPT_VERSION not in text, path
        assert "GOAL_SYSTEM_PROMPT" not in text and "goal_interpretation" not in text, path


def test_the_requests_are_paced(world: World) -> None:
    result, factory, sleeps = run(world, oracle(world), only={"t-one", "t-little"}, pause=2.0)
    assert len(factory.calls) == 4
    assert sleeps == [2.0, 2.0, 2.0]  # between requests, never before the first
    assert result.requests_sent == 4


def test_the_report_names_what_was_run_and_what_was_not(world: World) -> None:
    result, _, _ = run(world, oracle(world), only={"t-one"})
    report = ai.build_report(
        result,
        world.expectations,
        expectations_sha="e" * 64,
        scenarios_sha="s" * 64,
        kit=ai.default_kit(),
        args_summary={"runs": 1},
    )
    assert report["synthetic"] is True and report["expectationsSha256"] == "e" * 64
    rows = {row["metric"]: row for row in report["table"]["rows"]}
    assert set(rows) == {*ai.METRICS, "timeout_cost_fallback"}
    assert rows["goal_recognition"]["cells"]["fixed"]["state"] == "na"
    assert rows["realism"]["cells"][f"ai:{MODEL}"] == {
        "state": "ratio",
        "successes": 1,
        "executed": 1,
    }
    assert {n["reason"] for n in report["notRun"]} == {ai.NOT_SELECTED}
    assert len(report["runs"]) == 3 and report["requestsSent"] == 2
    json.dumps(report)  # serialisable
