"""``domain/demo_policy``: fixture models, scenario resolution, the planner's payload and advice
validation, the model caps and the daily quotas. Pure: no app, no network."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from app.contracts_plan_chat import CatalogEdition
from app.domain import demo_policy as policy
from app.domain.demo_policy import FixtureError
from app.repositories.catalog import MemoryCatalogRepository, MemoryContent
from app.services.catalog import CatalogService
from tests.demo.demo_support import (
    BUNDLES,
    REAL_FIXTURES,
    Clock,
    real_scenarios,
    simulation_file,
)


@pytest.fixture(scope="module")
def editions() -> list[CatalogEdition]:
    content = MemoryContent.from_paths(BUNDLES)
    return CatalogService(MemoryCatalogRepository(content)).list_editions()


def scenario(**overrides: Any) -> policy.ScenarioEntry:
    base = copy.deepcopy(real_scenarios()["scenarios"][6])  # scenario-07, a surah
    base.update(overrides)
    return policy.ScenarioEntry.model_validate(base)


def by_id(resolved: list[policy.ResolvedScenario], scenario_id: str) -> policy.ResolvedScenario:
    return next(item for item in resolved if item.scenario.scenario_id == scenario_id)


# --- the real scenario file ----------------------------------------------------------------------


def test_the_real_scenario_file_is_valid_and_holds_the_ten_qa_cases() -> None:
    fixture = policy.parse_scenario_fixture((REAL_FIXTURES / "demo_scenarios.json").read_bytes())
    assert [s.scenario_id for s in fixture.scenarios] == [f"scenario-{n:02d}" for n in range(1, 11)]
    assert sorted(s.qa_case for s in fixture.scenarios) == list(range(1, 11))
    for entry in fixture.scenarios:
        assert entry.edition_key_prefixes in (["quran-hafs-quranenc"], ["nawawi40-hadeethenc"])
        assert entry.goal_text_ar and entry.goal_text_en
    quran = [s for s in fixture.scenarios if s.edition_key_prefixes == ["quran-hafs-quranenc"]]
    hadith = [s for s in fixture.scenarios if s.edition_key_prefixes == ["nawawi40-hadeethenc"]]
    assert {s.scenario_id for s in hadith} == {"scenario-08", "scenario-09", "scenario-10"}
    assert all(s.paths == ["quran"] for s in quran)
    assert all(set(s.paths) <= {"matn", "sanad", "grade"} for s in hadith)
    assert fixture.get("scenario-06").section_refs == ["*"]  # type: ignore[union-attr]
    assert fixture.get("nope") is None


def test_the_scenario_titles_are_generic_and_short() -> None:
    fixture = policy.parse_scenario_fixture((REAL_FIXTURES / "demo_scenarios.json").read_bytes())
    for entry in fixture.scenarios:
        assert len(entry.title_en) <= 40 and len(entry.title_ar) <= 40
        assert len(entry.goal_text_en) <= 120 and len(entry.goal_text_ar) <= 120


def test_the_real_scenarios_resolve_against_the_published_bundle_pair(
    editions: list[CatalogEdition],
) -> None:
    resolved = policy.resolve_all(
        policy.parse_scenario_fixture((REAL_FIXTURES / "demo_scenarios.json").read_bytes()),
        editions,
    )
    assert len(resolved) == 10
    assert by_id(resolved, "scenario-07").section_ordinals == (1,)
    assert by_id(resolved, "scenario-06").section_ordinals == (1, 2, 3)  # "*": every section
    assert by_id(resolved, "scenario-09").section_ordinals == (1, 2, 3)
    assert by_id(resolved, "scenario-10").section_ordinals == (1, 2, 3, 4)
    assert by_id(resolved, "scenario-08").edition_key == "nawawi40-hadeethenc"
    assert by_id(resolved, "scenario-09").paths == ("matn", "sanad")


def live_shaped(editions: list[CatalogEdition]) -> list[CatalogEdition]:
    """A catalog shaped like the live one: surahs 78-81 and the first hadith only."""
    live: list[CatalogEdition] = []
    for edition in editions:
        template = edition.sections[0]
        if edition.content_format == "quran":
            references = ["78", "79", "80", "81"]
            key = "quran-hafs-quranenc-ai-20261005"
        else:
            references = ["nawawi40:1"]
            key = "nawawi40-hadeethenc-ai-20261005"
        sections = [
            template.model_copy(update={"ordinal": ordinal, "reference": reference})
            for ordinal, reference in enumerate(references, start=1)
        ]
        live.append(edition.model_copy(update={"edition_key": key, "sections": sections}))
    return live


def test_the_real_scenarios_also_resolve_against_the_live_shaped_catalog(
    editions: list[CatalogEdition],
) -> None:
    resolved = policy.resolve_all(
        policy.parse_scenario_fixture((REAL_FIXTURES / "demo_scenarios.json").read_bytes()),
        live_shaped(editions),
    )
    assert len(resolved) == 10  # none is omitted from E27 on the live catalog
    # each Quran scenario keeps its intent: the vague goal and the surah stay small, the deadline
    # and the large plan cover everything published
    assert by_id(resolved, "scenario-01").section_ordinals == (4,)
    assert by_id(resolved, "scenario-02").section_ordinals == (1, 2, 3, 4)
    assert by_id(resolved, "scenario-03").section_ordinals == (3,)
    assert by_id(resolved, "scenario-04").section_ordinals == (2, 3, 4)
    assert by_id(resolved, "scenario-05").section_ordinals == (3, 4)
    assert by_id(resolved, "scenario-07").section_ordinals == (1,)
    assert by_id(resolved, "scenario-06").section_ordinals == (1, 2, 3, 4)  # "*"
    assert by_id(resolved, "scenario-09").section_ordinals == (1,)


def test_only_the_scenarios_of_a_published_edition_resolve(
    editions: list[CatalogEdition],
) -> None:
    fixture = policy.parse_scenario_fixture((REAL_FIXTURES / "demo_scenarios.json").read_bytes())
    only_quran = [e for e in editions if e.content_format == "quran"]
    ids = [r.scenario.scenario_id for r in policy.resolve_all(fixture, only_quran)]
    assert ids == [f"scenario-{n:02d}" for n in range(1, 8)]
    assert policy.resolve_all(fixture, []) == []


# --- scenario resolution rules -------------------------------------------------------------------


def fake_edition(editions: list[CatalogEdition], key: str, version: int) -> CatalogEdition:
    quran = next(e for e in editions if e.content_format == "quran")
    return quran.model_copy(update={"edition_key": key, "catalog_version": version})


def test_the_highest_catalog_version_wins_among_the_matches(editions: list[CatalogEdition]) -> None:
    older = fake_edition(editions, "quran-hafs-quranenc", 1)
    newer = fake_edition(editions, "quran-hafs-quranenc-v2", 2)
    resolved = policy.resolve_scenario(scenario(), [older, newer])
    assert resolved is not None and resolved.edition_key == "quran-hafs-quranenc-v2"
    assert policy.resolve_scenario(scenario(), [newer, older]) == resolved


def test_a_version_tie_goes_to_the_greatest_key(editions: list[CatalogEdition]) -> None:
    first = fake_edition(editions, "quran-hafs-quranenc-a", 3)
    second = fake_edition(editions, "quran-hafs-quranenc-b", 3)
    resolved = policy.resolve_scenario(scenario(), [first, second])
    assert resolved is not None and resolved.edition_key == "quran-hafs-quranenc-b"


def test_the_first_matching_prefix_decides(editions: list[CatalogEdition]) -> None:
    primary = fake_edition(editions, "quran-primary", 1)
    fallback = fake_edition(editions, "quran-fallback", 9)
    entry = scenario(editionKeyPrefixes=["quran-primary", "quran-fallback"])
    resolved = policy.resolve_scenario(entry, [fallback, primary])
    assert resolved is not None and resolved.edition_key == "quran-primary"
    only_fallback = policy.resolve_scenario(entry, [fallback])
    assert only_fallback is not None and only_fallback.edition_key == "quran-fallback"


def test_a_key_equal_to_the_prefix_matches(editions: list[CatalogEdition]) -> None:
    exact = policy.resolve_scenario(scenario(), editions)
    assert exact is not None and exact.edition_key == "quran-hafs-quranenc"
    assert policy.resolve_scenario(scenario(editionKeyPrefixes=["quran-hafs-quran"]), editions)
    assert policy.resolve_scenario(scenario(editionKeyPrefixes=["hafs"]), editions) is None


def test_the_resolved_sections_are_the_published_subset_in_ascending_order(
    editions: list[CatalogEdition],
) -> None:
    entry = scenario(sectionRefs=["114", "999", "112"])
    resolved = policy.resolve_scenario(entry, editions)
    assert resolved is not None and resolved.section_ordinals == (1, 3)
    assert policy.resolve_scenario(scenario(sectionRefs=["999"]), editions) is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"paths": ["matn"]},  # not available in a Quran edition
        {
            "editionKeyPrefixes": ["nawawi40-hadeethenc"],
            "order": "reverse",
            "paths": ["matn"],
            "sectionRefs": ["nawawi40:1"],
        },  # reverse is Quran only
        {
            "editionKeyPrefixes": ["nawawi40-hadeethenc"],
            "paths": ["grade"],
            "sectionRefs": ["nawawi40:3"],
        },  # that hadith has no grade passage
    ],
)
def test_a_scenario_that_cannot_be_planned_does_not_resolve(
    editions: list[CatalogEdition], overrides: dict[str, Any]
) -> None:
    assert policy.resolve_scenario(scenario(**overrides), editions) is None


def test_paths_come_out_in_canonical_order(editions: list[CatalogEdition]) -> None:
    entry = scenario(
        editionKeyPrefixes=["nawawi40-hadeethenc"],
        sectionRefs=["nawawi40:1"],
        paths=["sanad", "matn"],
    )
    resolved = policy.resolve_scenario(entry, editions)
    assert resolved is not None and resolved.paths == ("matn", "sanad")
    assert isinstance(resolved.edition_id, UUID)


# --- fixture validation --------------------------------------------------------------------------


DELETE = object()


def mutated(path: list[Any], value: Any) -> dict[str, Any]:
    data = copy.deepcopy(real_scenarios())
    node: Any = data
    for key in path[:-1]:
        node = node[key]
    if value is DELETE:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return data


@pytest.mark.parametrize(
    "data",
    [
        mutated(["fixtureVersion"], 2),
        mutated(["extra"], 1),
        mutated(["scenarios", 0, "extra"], 1),
        mutated(["scenarios", 0, "scenarioId"], "Scenario 01"),
        mutated(["scenarios", 1, "scenarioId"], "scenario-01"),  # duplicate id
        mutated(["scenarios", 0, "qaCase"], 11),
        mutated(["scenarios", 0, "titleEn"], ""),
        mutated(["scenarios", 0, "editionKeyPrefixes"], []),
        mutated(["scenarios", 0, "sectionRefs"], []),
        mutated(["scenarios", 0, "sectionRefs"], ["*", "112"]),
        mutated(["scenarios", 0, "sectionRefs"], ["112", "112"]),
        mutated(["scenarios", 0, "paths"], ["quran", "quran"]),
        mutated(["scenarios", 0, "paths"], ["tafsir"]),
        mutated(["scenarios", 0, "order"], "random"),
        mutated(["scenarios", 0, "sessionMinutes"], 7),
        mutated(["scenarios", 0, "preferredDateOffsetDays"], -1),
        mutated(["scenarios", 0, "placement", "correct"], -1),
        mutated(["scenarios", 0, "placement"], {"correct": 1}),
        mutated(["scenarios", 0, "goalTextEn"], DELETE),
        mutated(["scenarios"], []),
    ],
)
def test_a_damaged_scenario_file_is_refused(data: dict[str, Any]) -> None:
    with pytest.raises(FixtureError) as caught:
        policy.parse_scenario_fixture(json.dumps(data))
    assert caught.value.reason == "invalid_shape"


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param("", id="empty"),
        pytest.param("not json", id="text"),
        pytest.param("[]", id="list"),
        pytest.param("null", id="null"),
        pytest.param(b"\xff\xfe\x00", id="bytes"),
        pytest.param("[" * 100000, id="deeply-nested"),
    ],
)
def test_text_that_is_not_a_fixture_object_is_refused(raw: str | bytes) -> None:
    with pytest.raises(FixtureError):
        policy.parse_scenario_fixture(raw)


def test_a_fixture_error_names_no_value_from_the_file() -> None:
    data = mutated(["scenarios", 0, "scenarioId"], "Secret Value In File!")
    with pytest.raises(FixtureError) as caught:
        policy.parse_scenario_fixture(json.dumps(data))
    assert "Secret Value" not in str(caught.value) + caught.value.reason


# --- the simulation file -------------------------------------------------------------------------


def test_a_valid_simulation_file_is_returned_verbatim() -> None:
    raw = json.dumps(simulation_file())
    model, verbatim = policy.parse_simulation_fixture(raw)
    assert model.label == "precomputed_synthetic"
    assert verbatim == simulation_file()["simulations"]
    assert model.simulations[0].days[1].adjustment == "absence_light_review"


def test_the_committed_simulation_file_conforms_to_the_model_when_it_exists() -> None:
    """A guard on the contract with the generator: the file E29 will serve must validate."""
    path = REAL_FIXTURES / "demo_simulations.json"
    if not path.exists():
        pytest.skip("fixtures/demo_simulations.json is not written yet")
    model, verbatim = policy.parse_simulation_fixture(path.read_bytes())
    assert len(model.simulations) == len(verbatim) >= 1


def broken_simulation(change: Any) -> dict[str, Any]:
    data = simulation_file()
    change(data)
    return data


@pytest.mark.parametrize(
    "data",
    [
        broken_simulation(lambda d: d.update(label="live")),
        broken_simulation(lambda d: d["simulations"][0].update(label="live")),
        broken_simulation(lambda d: d.update(fixtureVersion=2)),
        broken_simulation(lambda d: d.update(contentHash="abc")),
        broken_simulation(lambda d: d.update(extra=1)),
        broken_simulation(lambda d: d["simulations"][0].update(extra=1)),
        broken_simulation(lambda d: d["simulations"][0]["days"][0].update(adjustment="other")),
        broken_simulation(lambda d: d["simulations"][0]["days"][1].update(day=1)),  # not increasing
        broken_simulation(lambda d: d["simulations"][0]["days"][1].update(overallPercent=26)),
        broken_simulation(
            lambda d: d["simulations"][0]["days"][1].update(confirmedWordsCumulative=101)
        ),
        broken_simulation(lambda d: d["simulations"][0]["profile"].update(totalWords=0)),
        broken_simulation(
            lambda d: d["simulations"][0]["learnerScript"].update(dailyCorrectRate=2)
        ),
        broken_simulation(lambda d: d["simulations"][0].update(days=[])),
        broken_simulation(lambda d: d.update(simulations=[])),
        broken_simulation(
            lambda d: d["simulations"].append(copy.deepcopy(d["simulations"][0]))
        ),  # duplicate id
    ],
)
def test_a_damaged_simulation_file_is_refused(data: dict[str, Any]) -> None:
    with pytest.raises(FixtureError):
        policy.parse_simulation_fixture(json.dumps(data))


def test_confirmed_words_may_not_decrease() -> None:
    data = simulation_file()
    data["simulations"][0]["days"][1]["confirmedWordsCumulative"] = 0
    data["simulations"][0]["days"][1]["overallPercent"] = 0
    data["simulations"][0]["days"][0]["confirmedWordsCumulative"] = 10
    data["simulations"][0]["days"][0]["overallPercent"] = 10
    with pytest.raises(FixtureError):
        policy.parse_simulation_fixture(json.dumps(data))


def test_a_sha256_prefix_is_accepted_in_the_content_hash() -> None:
    data = simulation_file(contentHash="sha256:" + "a" * 64)
    assert policy.parse_simulation_fixture(json.dumps(data))[0].content_hash.startswith("sha256:")


# --- the planner's payload and advice -------------------------------------------------------------


P1 = UUID("55555555-5555-4555-8555-000000000001")
P2 = UUID("55555555-5555-4555-8555-000000000002")


def basis(minutes: int = 10) -> policy.PlannerBasis:
    return policy.PlannerBasis(
        scenario_id="scenario-07",
        passages=(policy.PassageFact(P1, 12), policy.PassageFact(P2, 30)),
        placement_correct=1,
        placement_incorrect=2,
        session_minutes=minutes,
    )


def test_the_payload_is_the_scenario_id_the_passages_and_the_placement_counts() -> None:
    payload = policy.build_planner_payload(basis())
    assert payload == {
        "scenarioId": "scenario-07",
        "passages": [
            {"id": str(P1), "wordCount": 12},
            {"id": str(P2), "wordCount": 30},
        ],
        "placement": {"correct": 1, "incorrect": 2},
        "maxNewWordsPerDay": 25,
    }
    assert policy.payload_violations(payload) == []


@pytest.mark.parametrize("minutes, capacity", [(5, 12), (10, 25), (15, 40)])
def test_the_pace_bound_follows_the_session_length(minutes: int, capacity: int) -> None:
    assert basis(minutes).capacity == capacity
    assert policy.build_planner_payload(basis(minutes))["maxNewWordsPerDay"] == capacity


@pytest.mark.parametrize("key", ["userId", "accountId", "username", "ip", "sessionId", "text"])
def test_any_other_key_anywhere_in_the_payload_is_a_violation(key: str) -> None:
    payload = policy.build_planner_payload(basis())
    assert policy.payload_violations({**payload, key: "x"}) == [key]
    nested = copy.deepcopy(payload)
    nested["passages"][0][key] = "x"
    assert policy.payload_violations(nested) == [key]


def test_the_allowlist_is_exactly_what_the_payload_uses() -> None:
    keys: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            keys.update(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(policy.build_planner_payload(basis()))
    assert keys == policy.DEMO_PAYLOAD_KEYS


def good(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "newWordsPerDay": 10,
        "reviewOffsetsDays": [1, 3, 7],
        "priorityReviewPassageIds": [str(P2)],
    }
    data.update(overrides)
    return data


IDS = [str(P1), str(P2)]


def test_valid_advice_is_accepted() -> None:
    advice = policy.validate_advice(good(), passage_ids=IDS, capacity=25)
    assert advice == policy.PlanAdvice(10, (1, 3, 7), (str(P2),))
    assert advice.as_json() == {
        "newWordsPerDay": 10,
        "reviewOffsetsDays": [1, 3, 7],
        "priorityReviewPassageIds": [str(P2)],
        "promptVersion": "demo-planner-v1",
    }


@pytest.mark.parametrize("pace", [1, 25])
def test_the_pace_bounds_are_inclusive(pace: int) -> None:
    assert policy.validate_advice(good(newWordsPerDay=pace), passage_ids=IDS, capacity=25)


@pytest.mark.parametrize(
    "data",
    [
        None,
        "text",
        [],
        {},
        good(newWordsPerDay=0),
        good(newWordsPerDay=26),
        good(newWordsPerDay=-5),
        good(newWordsPerDay=True),
        good(newWordsPerDay=10.5),
        good(newWordsPerDay="10"),
        good(reviewOffsetsDays=[]),
        good(reviewOffsetsDays=[1, 2, 3, 4, 5, 6]),
        good(reviewOffsetsDays=[3, 1]),
        good(reviewOffsetsDays=[1, 1]),
        good(reviewOffsetsDays=[0, 1]),
        good(reviewOffsetsDays=[1, 31]),
        good(reviewOffsetsDays=[1.5]),
        good(reviewOffsetsDays=[True]),
        good(reviewOffsetsDays="1,3,7"),
        good(priorityReviewPassageIds=["55555555-5555-4555-8555-0000000000ff"]),  # invented id
        good(priorityReviewPassageIds=[str(P1), "invented"]),
        good(priorityReviewPassageIds=[1]),
        good(priorityReviewPassageIds="all"),
        good(extra="x"),
    ],
)
def test_advice_outside_the_bounds_is_rejected_whole(data: Any) -> None:
    assert policy.validate_advice(data, passage_ids=IDS, capacity=25) is None


def test_a_missing_key_is_rejected() -> None:
    data = good()
    del data["priorityReviewPassageIds"]
    assert policy.validate_advice(data, passage_ids=IDS, capacity=25) is None


def test_the_boundary_offsets_and_an_empty_priority_list_are_accepted() -> None:
    data = good(reviewOffsetsDays=[1, 2, 4, 14, 30], priorityReviewPassageIds=[])
    advice = policy.validate_advice(data, passage_ids=IDS, capacity=25)
    assert advice is not None and advice.review_offsets_days == (1, 2, 4, 14, 30)


def test_repeated_and_upper_case_priority_ids_are_collapsed() -> None:
    data = good(priorityReviewPassageIds=[str(P2).upper(), str(P2), str(P1)])
    advice = policy.validate_advice(data, passage_ids=IDS, capacity=25)
    assert advice is not None and advice.priority_review_passage_ids == (str(P2), str(P1))


def test_the_schema_requires_exactly_the_three_keys() -> None:
    schema = policy.DEMO_PLANNER_SCHEMA
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert policy.PROMPT_VERSION == "demo-planner-v1"


# --- caps ----------------------------------------------------------------------------------------


class Caps:
    QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY = 5
    QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE = 3
    QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY = 2


@pytest.mark.parametrize(
    "counts, allowed",
    [
        (policy.ModelCounts(0, 0, 0), True),
        (policy.ModelCounts(4, 2, 1), True),
        (policy.ModelCounts(5, 0, 0), False),
        (policy.ModelCounts(0, 3, 0), False),
        (policy.ModelCounts(0, 0, 2), False),
    ],
)
def test_the_free_budget_caps(counts: policy.ModelCounts, allowed: bool) -> None:
    assert policy.model_caps_allow(counts, Caps()) is allowed


# --- daily quotas --------------------------------------------------------------------------------


def test_a_rolling_quota_refuses_the_hit_over_the_limit_and_says_when_to_come_back() -> None:
    clock = Clock()
    quota = policy.DailyQuota(2, kind="rolling", clock=clock)
    assert quota.reserve("a").allowed
    clock.now += timedelta(hours=1)
    assert quota.reserve("a").allowed
    refused = quota.reserve("a")
    assert not refused.allowed
    assert refused.retry_after_sec == 23 * 3600  # the first hit leaves 24 hours after it came
    assert quota.used("a") == 2  # a refusal is not recorded
    clock.now += timedelta(hours=23)
    assert quota.reserve("a").allowed  # the first hit has left the window


def test_a_rolling_quota_counts_each_key_apart() -> None:
    quota = policy.DailyQuota(1, kind="rolling", clock=Clock())
    assert quota.reserve("a").allowed
    assert quota.reserve("b").allowed
    assert not quota.reserve("a").allowed


def test_a_released_hit_is_given_back() -> None:
    quota = policy.DailyQuota(1, kind="rolling", clock=Clock())
    decision = quota.reserve("a")
    assert not quota.reserve("a").allowed
    quota.release("a", decision.ticket)
    assert quota.used("a") == 0
    assert quota.reserve("a").allowed
    quota.release("a", None)  # nothing to give back
    quota.release("zzz", datetime(2000, 1, 1, tzinfo=UTC))  # unknown key and ticket: no effect
    assert quota.used("a") == 1


def test_a_utc_day_quota_resets_at_midnight_utc() -> None:
    clock = Clock(datetime(2026, 10, 4, 23, 0, tzinfo=UTC))
    quota = policy.DailyQuota(2, kind="utc_day", clock=clock)
    assert quota.reserve("a").allowed and quota.reserve("a").allowed
    refused = quota.reserve("a")
    assert not refused.allowed
    assert refused.retry_after_sec == 3600
    clock.now = datetime(2026, 10, 5, 0, 0, 1, tzinfo=UTC)
    assert quota.used("a") == 0
    assert quota.reserve("a").allowed


def test_the_number_of_tracked_keys_is_bounded() -> None:
    quota = policy.DailyQuota(1, kind="rolling", clock=Clock(), max_keys=3)
    for number in range(10):
        assert quota.reserve(f"key{number}").allowed
    assert len(quota._hits) <= 3


def test_a_quota_needs_a_positive_limit() -> None:
    with pytest.raises(ValueError):
        policy.DailyQuota(0)
