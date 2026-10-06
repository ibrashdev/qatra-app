"""The pinned expected answers (fixtures/comparison_expectations.json) and how they are made."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts import ai_comparison as ai
from scripts import demo_catalog as catalog
from tests.comparison.cmp_support import (
    REAL_EXPECTATIONS,
    REAL_SCENARIOS,
    build_world,
    entry,
    write_scenarios,
)

TOP_KEYS = {
    "expectationsVersion",
    "synthetic",
    "pinnedFrom",
    "catalogProfile",
    "derivation",
    "scenarios",
}
SCENARIO_KEYS = {
    "scenarioId",
    "qaCase",
    "goalRecognition",
    "realisticDays",
    "errorPriorityRefs",
    "lightReviewExpected",
    "basis",
}


def test_the_committed_pin_covers_the_ten_cases() -> None:
    expectations, digest = ai.load_expectations(REAL_EXPECTATIONS)
    assert sorted(expectations) == [f"scenario-{n:02d}" for n in range(1, 11)]
    assert [expectations[f"scenario-{n:02d}"].qa_case for n in range(1, 11)] == list(range(1, 11))
    normalized = REAL_EXPECTATIONS.read_bytes().replace(b"\r\n", b"\n")
    assert digest == hashlib.sha256(normalized).hexdigest()


def test_the_committed_pin_holds_answers_and_no_results() -> None:
    document = json.loads(REAL_EXPECTATIONS.read_text(encoding="utf-8"))
    assert set(document) == TOP_KEYS
    assert document["synthetic"] is True
    for item in document["scenarios"]:
        assert set(item) == SCENARIO_KEYS
        assert item["realisticDays"]["min"] <= item["realisticDays"]["max"]
    assert REAL_EXPECTATIONS.read_bytes().endswith(b"\n")  # LF or CRLF checkout


def test_the_pinned_cases_that_need_an_error_or_a_light_review() -> None:
    expectations, _ = ai.load_expectations(REAL_EXPECTATIONS)
    with_errors = {sid for sid, e in expectations.items() if e.error_priority_refs}
    assert with_errors == {"scenario-04", "scenario-05", "scenario-09"}
    assert {sid for sid, e in expectations.items() if e.light_review_expected} == {"scenario-04"}


@pytest.mark.skipif(not REAL_SCENARIOS.exists(), reason="the scenario fixture is not written yet")
def test_the_pin_is_the_derivation_of_the_current_scenario_fixture() -> None:
    scenarios, _ = ai.load_scenarios(REAL_SCENARIOS)
    derived = ai.derive_expectations(scenarios, catalog.edition_list())
    assert derived == json.loads(REAL_EXPECTATIONS.read_text(encoding="utf-8")), (
        "the scenario fixture changed after the pin: re-pinning needs the owner's approval"
    )


@pytest.mark.skipif(not REAL_SCENARIOS.exists(), reason="the scenario fixture is not written yet")
def test_every_scenario_of_the_fixture_resolves_and_agrees_with_its_pin() -> None:
    scenarios, _ = ai.load_scenarios(REAL_SCENARIOS)
    expectations, _ = ai.load_expectations(REAL_EXPECTATIONS)
    status, prepared = ai.plan_scenarios(scenarios, expectations, None, catalog.edition_list())
    assert [s["reason"] for s in status] == [None] * len(scenarios)
    assert len(prepared) == len(scenarios)
    for item in prepared:
        basis = json.loads(REAL_EXPECTATIONS.read_text("utf-8"))["scenarios"]
        pinned = next(b for b in basis if b["scenarioId"] == item.scenario.scenario_id)["basis"]
        assert pinned == {
            "totalWords": item.total_words,
            "sessionMinutes": item.scenario.session_minutes,
        }


def test_the_derivation_sets_the_range_the_flags_and_the_refs(tmp_path: Path) -> None:
    scenarios_path = write_scenarios(
        tmp_path,
        [
            entry("a", 3, sectionRefs=["112", "113"], sessionMinutes=5),
            entry("b", 9, sectionRefs=["112"], errorPassageRefs=["112"], absenceDays=2),
            entry("c", 4, sectionRefs=["112"], absenceDays=3),
        ],
    )
    scenarios, _ = ai.load_scenarios(scenarios_path)
    document = ai.derive_expectations(scenarios, catalog.edition_list())
    first, second, third = document["scenarios"]
    assert first["basis"] == {"totalWords": 225, "sessionMinutes": 5}
    assert first["realisticDays"] == {"min": 22, "max": 33}  # ceil(225/12 x 1.15), x 1.5
    assert second["realisticDays"] == {"min": 4, "max": 8}  # QA case 9 starts light: x 2
    assert second["errorPriorityRefs"] == ["112"] and second["lightReviewExpected"] is False
    assert third["lightReviewExpected"] is True  # three days of absence is enough
    assert first["goalRecognition"] == {
        "editionKeyPrefix": "quran-hafs-quranenc",
        "sectionRefs": ["112", "113"],
    }


def test_the_pin_is_byte_stable_and_refuses_to_overwrite(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    scenarios_path = write_scenarios(tmp_path)
    first, second = tmp_path / "one.json", tmp_path / "two.json"
    assert ai.main(["--scenarios-file", str(scenarios_path), "--pin-expectations", str(first)]) == 0
    assert (
        ai.main(["--scenarios-file", str(scenarios_path), "--pin-expectations", str(second)]) == 0
    )
    assert first.read_bytes() == second.read_bytes()
    out = capsys.readouterr().out
    assert hashlib.sha256(first.read_bytes()).hexdigest() in out
    before = first.read_bytes()
    code = ai.main(["--scenarios-file", str(scenarios_path), "--pin-expectations", str(first)])
    assert code == 2 and first.read_bytes() == before
    assert "never regenerated" in capsys.readouterr().err


def test_a_scenario_that_cannot_be_pinned_stops_the_pin(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    scenarios_path = write_scenarios(tmp_path, [entry("lost", 1, editionKeyPrefixes=["no-book"])])
    target = tmp_path / "pin.json"
    code = ai.main(["--scenarios-file", str(scenarios_path), "--pin-expectations", str(target)])
    assert code == 2 and not target.exists()
    assert "lost" in capsys.readouterr().err


def test_a_damaged_pin_or_scenario_file_is_refused_by_name_only(tmp_path: Path) -> None:
    world = build_world(tmp_path)
    document = json.loads(world.expectations_path.read_text(encoding="utf-8"))
    del document["scenarios"][0]["realisticDays"]
    world.expectations_path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ai.FixtureProblem) as caught:
        ai.load_expectations(world.expectations_path)
    assert caught.value.reason == "bad_realisticDays"
    world.scenarios_path.write_text("{not json", encoding="utf-8")
    with pytest.raises(ai.FixtureProblem) as damaged:
        ai.load_scenarios(world.scenarios_path)
    assert damaged.value.reason == "not_json"
    with pytest.raises(ai.FixtureProblem) as missing:
        ai.load_scenarios(tmp_path / "absent.json")
    assert missing.value.reason == "unreadable"
