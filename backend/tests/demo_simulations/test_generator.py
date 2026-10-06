"""The generator of fixtures/demo_simulations.json and the file it writes."""

from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from app.domain.mastery_policy import REVIEW_INTERVAL_DAYS
from app.domain.plan_policy import review_buffered_days
from app.domain.session_policy import CAPACITY_WORDS, PartInfo, PassageInfo
from scripts import demo_catalog as catalog
from scripts import make_demo_simulations as gen
from tests.demo_simulations import strict_schema

REPO_ROOT = Path(__file__).resolve().parents[3]
COMMITTED = REPO_ROOT / "fixtures" / "demo_simulations.json"
SCENARIO_FILE = REPO_ROOT / "fixtures" / "demo_scenarios.json"


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    return gen.build_fixture()


def paired(fixture: dict[str, Any]) -> list[tuple[gen.SimSpec, dict[str, Any]]]:
    """Each spec with the simulation built from it (both are ordered by scenario id)."""
    specs = sorted(gen.SPECS, key=lambda spec: spec.scenario_id)
    return list(zip(specs, fixture["simulations"], strict=True))


def sim_of(fixture: dict[str, Any], scenario_id: str) -> dict[str, Any]:
    return next(s for s in fixture["simulations"] if s["scenarioId"] == scenario_id)


# --- reproducibility ------------------------------------------------------------------------------


def test_two_builds_have_identical_bytes() -> None:
    assert gen.render(gen.build_fixture()) == gen.render(gen.build_fixture())


def test_running_the_command_twice_writes_identical_bytes(tmp_path: Path) -> None:
    first, second = tmp_path / "a.json", tmp_path / "b.json"
    assert gen.main(["--output", str(first)]) == 0
    assert gen.main(["--output", str(second)]) == 0
    assert first.read_bytes() == second.read_bytes()


def test_the_committed_file_is_what_the_generator_writes() -> None:
    committed = COMMITTED.read_bytes().replace(b"\r\n", b"\n")  # core.autocrlf checkouts
    assert committed == gen.render(gen.build_fixture()), (
        "fixtures/demo_simulations.json is stale: run "
        "`python -m scripts.make_demo_simulations` from backend/"
    )


def test_the_file_format_is_fixed(fixture: dict[str, Any]) -> None:
    raw = gen.render(fixture)
    assert raw.endswith(b"\n") and not raw.endswith(b"\n\n")
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert (
        text
        == json.dumps(
            json.loads(text), sort_keys=True, indent=2, separators=(",", ": "), ensure_ascii=False
        )
        + "\n"
    )
    assert not re.search(r"[ \t]+\n", text)


def test_the_content_hash_covers_exactly_the_simulations(fixture: dict[str, Any]) -> None:
    assert fixture["contentHash"] == strict_schema.canonical_hash(fixture["simulations"])
    changed = copy.deepcopy(fixture)
    changed["simulations"][0]["days"][0]["newWords"] += 1
    assert strict_schema.canonical_hash(changed["simulations"]) != fixture["contentHash"]


def test_check_flag_reports_a_missing_or_stale_file(tmp_path: Path) -> None:
    target = tmp_path / "sims.json"
    assert gen.main(["--check", "--output", str(target)]) == 1
    assert gen.main(["--output", str(target)]) == 0
    assert gen.main(["--check", "--output", str(target)]) == 0
    target.write_bytes(target.read_bytes().replace(b"\n", b"\r\n"))
    assert gen.main(["--check", "--output", str(target)]) == 0  # CRLF checkout is equal
    target.write_bytes(target.read_bytes() + b" ")
    assert gen.main(["--check", "--output", str(target)]) == 1


def test_a_bad_option_is_a_usage_error() -> None:
    assert gen.main(["--no-such-option"]) == 2


# --- the schema -----------------------------------------------------------------------------------


def test_the_generated_data_conforms_to_the_schema(fixture: dict[str, Any]) -> None:
    assert strict_schema.check(fixture) == []


def test_the_committed_file_conforms_to_the_schema() -> None:
    assert strict_schema.check(json.loads(COMMITTED.read_text(encoding="utf-8"))) == []


def _drop(path: list[Any]) -> Callable[[dict[str, Any]], None]:
    def mutate(data: dict[str, Any]) -> None:
        node: Any = data
        for step in path[:-1]:
            node = node[step]
        del node[path[-1]]

    return mutate


def _set(path: list[Any], value: Any) -> Callable[[dict[str, Any]], None]:
    def mutate(data: dict[str, Any]) -> None:
        node: Any = data
        for step in path[:-1]:
            node = node[step]
        node[path[-1]] = value

    return mutate


MUTATIONS: dict[str, Callable[[dict[str, Any]], None]] = {
    "extra top-level key": _set(["extra"], 1),
    "missing label": _drop(["label"]),
    "wrong label": _set(["label"], "live"),
    "wrong simulation label": _set(["simulations", 0, "label"], "live"),
    "extra simulation key": _set(["simulations", 0, "note"], "x"),
    "missing day key": _drop(["simulations", 0, "days", 0, "reviews"]),
    "unknown adjustment": _set(["simulations", 0, "days", 0, "adjustment"], "bogus"),
    "percent off": _set(["simulations", 0, "days", 3, "overallPercent"], 99),
    "hash off": _set(["contentHash"], "0" * 64),
    "gap in day numbers": _drop(["simulations", 0, "days", 2]),
    "profile not synthetic": _set(["simulations", 0, "profile", "name"], "juz-amma"),
    "confirmed above total": _set(["simulations", 0, "days", 0, "confirmedWordsCumulative"], 10**9),
    "light day with new words": _set(["simulations", 1, "days", 7, "newWords"], 5),
    "bad session minutes": _set(["simulations", 0, "profile", "sessionMinutes"], 7),
    "rate above one": _set(["simulations", 0, "learnerScript", "dailyCorrectRate"], 1.5),
    "em dash in a title": _set(["simulations", 0, "titleEn"], "one — two"),
}


@pytest.mark.parametrize("name", sorted(MUTATIONS))
def test_the_checker_is_strict(fixture: dict[str, Any], name: str) -> None:
    broken = copy.deepcopy(fixture)
    MUTATIONS[name](broken)
    if name != "hash off" and name != "extra top-level key" and name != "missing label":
        # Keep the hash consistent so that the mutation under test is what gets reported.
        broken["contentHash"] = strict_schema.canonical_hash(broken["simulations"])
    assert strict_schema.check(broken), f"the checker accepted: {name}"


def test_the_file_validates_against_the_api_model_when_it_exists() -> None:
    policy = pytest.importorskip("app.domain.demo_policy")
    parse = getattr(policy, "parse_simulation_fixture", None)
    if parse is None:
        pytest.skip("demo_policy has no simulation parser yet")
    model, verbatim = parse(COMMITTED.read_bytes())
    assert len(model.simulations) == len(verbatim) == len(gen.SPECS)
    assert verbatim == json.loads(COMMITTED.read_text(encoding="utf-8"))["simulations"]


def test_scenario_ids_exist_in_the_scenario_fixture_when_it_exists(
    fixture: dict[str, Any],
) -> None:
    if not SCENARIO_FILE.exists():
        pytest.skip("fixtures/demo_scenarios.json is not written yet")
    known = {s["scenarioId"] for s in json.loads(SCENARIO_FILE.read_text("utf-8"))["scenarios"]}
    assert {s["scenarioId"] for s in fixture["simulations"]} <= known


# --- labels and honesty ---------------------------------------------------------------------------


def test_every_record_is_labelled_precomputed_and_synthetic(fixture: dict[str, Any]) -> None:
    assert fixture["label"] == "precomputed_synthetic"
    assert fixture["generator"] == "backend/scripts/make_demo_simulations.py"
    for sim in fixture["simulations"]:
        assert sim["label"] == "precomputed_synthetic"
        assert "synthetic" in sim["profile"]["name"]


def test_the_required_scenarios_are_present(fixture: dict[str, Any]) -> None:
    present = {s["scenarioId"] for s in fixture["simulations"]}
    assert {"scenario-03", "scenario-04", "scenario-05", "scenario-06", "scenario-10"} <= present
    ids = [s["simulationId"] for s in fixture["simulations"]]
    assert ids == [f"sim-{n:02d}" for n in range(1, len(ids) + 1)]


def test_titles_are_generic_text_without_an_em_dash(fixture: dict[str, Any]) -> None:
    for sim in fixture["simulations"]:
        assert re.search(r"[؀-ۿ]", sim["titleAr"])
        assert re.search(r"[A-Za-z]", sim["titleEn"])
        assert "—" not in sim["titleAr"] + sim["titleEn"]


# --- the rules the numbers follow -----------------------------------------------------------------


def test_the_absence_scenario_returns_with_a_light_review(fixture: dict[str, Any]) -> None:
    sim = sim_of(fixture, "scenario-04")
    assert sim["learnerScript"]["absentDays"] == [5, 6, 7]
    days = sim["days"]
    for number in (5, 6, 7):
        assert days[number - 1]["newWords"] == 0 and days[number - 1]["reviews"] == 0
    back = days[7]
    assert back["day"] == 8 and back["lightReviewDay"] is True
    assert back["newWords"] == 0 and back["reviews"] > 0
    assert back["adjustment"] == "absence_light_review"
    assert [d["day"] for d in days if d["lightReviewDay"]] == [8]
    assert days[8]["newWords"] > 0  # new material resumes the next day


def test_two_absent_days_are_not_enough_for_a_light_review() -> None:
    spec = gen.SPECS[1]
    shorter = replace(spec, absent_days=(5, 6))
    days = gen.simulate("sim-xx", shorter)["days"]
    assert not any(d["lightReviewDay"] for d in days)
    longer = replace(spec, absent_days=(5, 6, 7, 8))
    long_days = gen.simulate("sim-xx", longer)["days"]
    assert [d["day"] for d in long_days if d["lightReviewDay"]] == [9]


def test_repeated_errors_are_scripted_and_mark_error_priority(fixture: dict[str, Any]) -> None:
    sim = sim_of(fixture, "scenario-05")
    error_days = sim["learnerScript"]["errorDays"]
    assert error_days
    tagged = [d["day"] for d in sim["days"] if d["adjustment"] == "error_priority"]
    assert tagged and min(tagged) >= min(error_days)
    clean = gen.simulate("sim-xx", replace(gen.SPECS[2], error_days=()))
    # The same learner without errors confirms at least as many words by the end.
    assert (
        clean["days"][-1]["confirmedWordsCumulative"] >= sim["days"][-1]["confirmedWordsCumulative"]
    )


def test_a_pace_revision_lowers_new_words_and_is_tagged(fixture: dict[str, Any]) -> None:
    sim = sim_of(fixture, "scenario-10")
    before, after = sim["days"][:7], sim["days"][7:]
    assert max(d["newWords"] for d in after) <= CAPACITY_WORDS[5]
    assert min(d["newWords"] for d in before if d["newWords"]) > CAPACITY_WORDS[5]
    assert all(d["adjustment"] == "pace_reduced" for d in after)
    assert not any(d["adjustment"] == "pace_reduced" for d in before)


def test_new_words_never_exceed_the_capacity_in_force(fixture: dict[str, Any]) -> None:
    for spec, sim in paired(fixture):
        for entry in sim["days"]:
            assert entry["newWords"] <= CAPACITY_WORDS[spec.minutes_on(entry["day"])]


def test_a_perfect_learner_confirms_on_the_one_three_seven_ladder(
    fixture: dict[str, Any],
) -> None:
    sim = sim_of(fixture, "scenario-08")  # one hadith, three passages, one introduced a day
    first_confirmation = 1 + sum(REVIEW_INTERVAL_DAYS)
    assert (1, 3, 7) == tuple(sum(REVIEW_INTERVAL_DAYS[: n + 1]) for n in range(3))
    days = sim["days"]
    assert all(d["confirmedWordsCumulative"] == 0 for d in days[: first_confirmation - 1])
    assert days[first_confirmation - 1]["confirmedWordsCumulative"] > 0
    assert days[-1]["overallPercent"] == 100
    assert days[-1]["confirmedWordsCumulative"] == sim["profile"]["totalWords"]


def test_the_percent_is_the_d66_floor_of_confirmed_over_total(fixture: dict[str, Any]) -> None:
    for sim in fixture["simulations"]:
        total = sim["profile"]["totalWords"]
        for entry in sim["days"]:
            assert entry["overallPercent"] == 100 * entry["confirmedWordsCumulative"] // total
    sim = sim_of(fixture, "scenario-08")
    assert any(0 < d["overallPercent"] < 100 for d in sim["days"])  # a floor, not a rounding


def test_confirmed_words_never_decrease(fixture: dict[str, Any]) -> None:
    for sim in fixture["simulations"]:
        series = [d["confirmedWordsCumulative"] for d in sim["days"]]
        assert series == sorted(series)


def test_the_number_of_days_follows_the_estimate_and_the_cap(fixture: dict[str, Any]) -> None:
    for spec, sim in paired(fixture):
        total = sim["profile"]["totalWords"]
        expected = min(
            spec.max_days,
            review_buffered_days(total, CAPACITY_WORDS[spec.session_minutes])
            + sum(REVIEW_INTERVAL_DAYS)
            + len(spec.absent_days)
            + len(spec.error_days),
        )
        assert len(sim["days"]) == expected
    assert len(sim_of(fixture, "scenario-06")["days"]) == 28  # a large plan is cut at the cap


def test_the_profile_total_is_the_size_of_the_synthetic_scope(fixture: dict[str, Any]) -> None:
    editions = catalog.harness_editions()
    for spec, sim in paired(fixture):
        edition = editions[spec.edition]
        sections = [edition.section(o) for o in spec.ordinals]
        words = sum(sec.path_words[spec.path] for sec in sections if sec is not None)
        assert sim["profile"]["totalWords"] == words
        assert sim["profile"]["sessionMinutes"] == spec.session_minutes


def test_the_learner_script_is_declared_as_scripted(fixture: dict[str, Any]) -> None:
    for spec, sim in paired(fixture):
        script = sim["learnerScript"]
        assert script["dailyCorrectRate"] == spec.daily_correct_rate
        assert script["absentDays"] == list(spec.absent_days)
        assert script["errorDays"] == list(spec.error_days)


def test_a_scripted_day_outside_the_plan_is_refused() -> None:
    spec = replace(gen.SPECS[1], absent_days=(999,))
    with pytest.raises(ValueError, match="outside"):
        gen.simulate("sim-xx", spec)


def test_the_synthetic_catalog_is_deterministic_and_labelled() -> None:
    first = catalog.passages_for(catalog.harness_editions()["juz_amma"], [112, 113], ["quran"])
    second = catalog.passages_for(catalog.harness_editions()["juz_amma"], [112, 113], ["quran"])
    assert first == second
    assert all(p.word_count <= catalog.QURAN_PASSAGE_WORDS for p in first)
    editions = catalog.edition_list()
    assert all("synthetic" in e.edition_key for e in editions)
    assert catalog.resolve_edition(editions, ["quran-hafs-quranenc"]) is editions[0]
    assert catalog.resolve_edition(editions, ["nope"]) is None
    assert catalog.resolve_section_ordinals(editions[0], ["112", "113"]) == (112, 113)
    assert len(catalog.resolve_section_ordinals(editions[0], ["*"])) == 37


def _passage(ordinal: int, parts: int) -> PassageInfo:
    return PassageInfo(
        id=uuid.UUID(int=ordinal),
        section_ordinal=1,
        path="quran",
        ordinal=ordinal,
        start=(ordinal, 0),
        word_count=2 * parts,
        parts=tuple(PartInfo(uuid.UUID(int=1000 * ordinal + n), n, 2) for n in range(1, parts + 1)),
    )


def test_review_rounds_stop_at_the_first_round_that_does_not_fit() -> None:
    # Rounds have 1 question for at most 2 parts, 2 for 3-5 parts, 3 for 6 or more; 5 minutes
    # allow 6 questions. Sizes 2 + 2 fit, the 3-question round does not, and the 1-question round
    # behind it must not jump the queue.
    order = [_passage(1, 4), _passage(2, 4), _passage(3, 6), _passage(4, 2)]
    assert [p.ordinal for p in catalog.rounds_within_cap(order, 5)] == [1, 2]
    assert [p.ordinal for p in catalog.rounds_within_cap(order, 15)] == [1, 2, 3, 4]
    assert catalog.rounds_within_cap([], 10) == []
    assert catalog.rounds_within_cap([_passage(9, 6)], 5) == [_passage(9, 6)]
