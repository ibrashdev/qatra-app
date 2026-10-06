"""The three alternatives and the five metrics, exactly as QA-and-evaluation.md scores them."""

from __future__ import annotations

import math
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from app.domain.plan_policy import compute_estimate, review_buffered_days
from app.domain.session_policy import REVIEW_QUESTION_CAP
from scripts import ai_comparison as ai
from scripts import demo_catalog as catalog
from tests.comparison.cmp_support import TODAY, World, build_world


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> World:
    return build_world(tmp_path_factory.mktemp("world"))


def errors_of(prepared: ai.Prepared) -> set[str]:
    return {str(i) for i in prepared.expected_error_ids}


# --- the alternatives -----------------------------------------------------------------------------


def test_the_fixed_plan_is_25_words_a_day_without_buffer_or_adaptation(world: World) -> None:
    prepared = world.prepared["t-little"]  # 225 words, 5 minutes
    plan = ai.fixed_plan(prepared, TODAY)
    assert plan.new_words_per_day == 25 and plan.days == math.ceil(225 / 25) == 9
    assert plan.covered_ids == {str(p.id) for p in prepared.passages}
    assert plan.light_review is None and plan.new_material is None  # no absence in this case


def test_the_fixed_plan_ignores_an_absence_and_resumes_new_material(world: World) -> None:
    plan = ai.fixed_plan(world.prepared["t-absent"], TODAY)
    assert plan.light_review is False and plan.new_material is True


def test_the_rules_plan_is_the_production_estimate(world: World) -> None:
    prepared = world.prepared["t-little"]
    plan = ai.rules_plan(prepared, TODAY)
    estimate = compute_estimate(
        prepared.edition,
        ordinals=prepared.ordinals,
        paths=prepared.paths,
        session_minutes=5,
        today=TODAY,
    )
    assert (plan.days, plan.new_words_per_day) == (estimate.days, estimate.new_words_per_day)
    assert plan.covered_ids == {str(p.id) for p in prepared.passages}  # build_phases drops none


def test_the_rules_plan_makes_the_first_session_after_an_absence_a_light_review(
    world: World,
) -> None:
    plan = ai.rules_plan(world.prepared["t-absent"], TODAY)
    assert plan.light_review is True and plan.new_material is False


def test_two_days_of_absence_are_not_a_light_review(tmp_path: Path) -> None:
    from tests.comparison.cmp_support import entry

    short = build_world(tmp_path, [entry("short", 4, absenceDays=2, sectionRefs=["112", "113"])])
    plan = ai.rules_plan(short.prepared["short"], TODAY)
    assert plan.light_review is False and plan.new_material is True


def test_the_first_review_session_ends_at_the_first_round_that_does_not_fit() -> None:
    editions = catalog.harness_editions()
    passages = catalog.passages_for(editions["juz_amma"], [112, 113], ["quran"])
    cap = REVIEW_QUESTION_CAP[5]
    chosen = ai.first_review_session(passages, 5)
    assert 0 < len(chosen) <= cap
    assert chosen == tuple(str(p.id) for p in passages[: len(chosen)])  # in the order given


def test_a_late_error_is_outside_the_first_session_of_fixed_and_rules(world: World) -> None:
    prepared = world.prepared["t-late-error"]
    unit = errors_of(prepared)
    assert len(unit) == 1
    assert not unit <= set(ai.fixed_plan(prepared, TODAY).first_review_ids)
    assert not unit <= set(ai.rules_plan(prepared, TODAY).first_review_ids)


def test_a_priority_id_moves_a_unit_to_the_front_of_the_first_session(world: World) -> None:
    prepared = world.prepared["t-late-error"]
    (unit,) = errors_of(prepared)
    plan = ai.advised_plan(
        prepared, TODAY, new_words_per_day=25, priority_ids=[unit], raw_ids=[unit]
    )
    assert plan.first_review_ids[0] == unit


def test_an_advised_pace_recomputes_the_days_and_nothing_else_moves(world: World) -> None:
    prepared = world.prepared["t-little"]
    base = ai.rules_plan(prepared, TODAY)
    slower = ai.advised_plan(prepared, TODAY, new_words_per_day=6, priority_ids=(), raw_ids=())
    assert slower.days == review_buffered_days(prepared.total_words, 6) > base.days
    assert slower.covered_ids == base.covered_ids  # new material still follows the plan order
    assert slower.light_review == base.light_review
    fallback = ai.advised_plan(prepared, TODAY, new_words_per_day=None, priority_ids=(), raw_ids=())
    assert fallback.days == base.days


# --- the five metrics -----------------------------------------------------------------------------


def score(
    prepared: ai.Prepared, outcome: ai.PlanOutcome, goal: Any = None, with_goal: bool = False
):
    return ai.score_plan(prepared, outcome, goal, score_goal_metric=with_goal)


def test_the_rules_plan_scores_the_applicable_metrics(world: World) -> None:
    prepared = world.prepared["t-absent"]
    metrics = score(prepared, ai.rules_plan(prepared, TODAY))
    assert metrics["goal_recognition"] is None  # only the AI alternative is scored (G-9)
    assert metrics["realism"] is True and metrics["coverage"] is True
    assert metrics["resume_reference"] is True


def test_realism_is_inclusive_at_both_ends_of_the_pinned_range(world: World) -> None:
    prepared = world.prepared["t-little"]
    plan = ai.rules_plan(prepared, TODAY)
    low, high = prepared.expectation.days_min, prepared.expectation.days_max
    assert score(prepared, replace(plan, days=low))["realism"] is True
    assert score(prepared, replace(plan, days=high))["realism"] is True
    assert score(prepared, replace(plan, days=low - 1))["realism"] is False
    assert score(prepared, replace(plan, days=high + 1))["realism"] is False


def test_the_fixed_plan_is_too_fast_for_a_little_time(world: World) -> None:
    prepared = world.prepared["t-little"]
    assert score(prepared, ai.fixed_plan(prepared, TODAY))["realism"] is False


def test_coverage_needs_every_target_passage_in_the_phases(world: World) -> None:
    prepared = world.prepared["t-one"]
    plan = ai.rules_plan(prepared, TODAY)
    missing = frozenset(sorted(plan.covered_ids)[1:])
    assert score(prepared, replace(plan, covered_ids=missing))["coverage"] is False
    assert score(prepared, plan)["coverage"] is True


def test_error_priority_applies_only_where_a_unit_is_pinned(world: World) -> None:
    plain = world.prepared["t-one"]
    assert score(plain, ai.rules_plan(plain, TODAY))["error_priority"] is None
    pinned = world.prepared["t-late-error"]
    (unit,) = errors_of(pinned)
    plan = ai.rules_plan(pinned, TODAY)
    assert score(pinned, replace(plan, first_review_ids=(unit,)))["error_priority"] is True
    assert score(pinned, replace(plan, first_review_ids=()))["error_priority"] is False


def test_resume_needs_a_light_review_with_no_new_material_where_pinned(world: World) -> None:
    prepared = world.prepared["t-absent"]
    plan = ai.rules_plan(prepared, TODAY)
    assert score(prepared, plan)["resume_reference"] is True
    assert score(prepared, replace(plan, light_review=False))["resume_reference"] is False
    assert score(prepared, replace(plan, new_material=True))["resume_reference"] is False
    assert score(prepared, ai.fixed_plan(prepared, TODAY))["resume_reference"] is False


def test_reference_validity_needs_published_ids_of_the_same_edition(world: World) -> None:
    prepared = world.prepared["t-one"]
    plan = ai.rules_plan(prepared, TODAY)
    other = catalog.passages_for(catalog.harness_editions()["nawawi40"], [1], ["matn"])[0]
    invented = "00000000-0000-4000-8000-000000000000"
    for bad in (invented, str(other.id)):
        broken = replace(plan, referenced_ids=(*plan.referenced_ids, bad))
        assert score(prepared, broken)["resume_reference"] is False


def test_goal_recognition_is_an_exact_match_of_edition_and_scope(world: World) -> None:
    prepared = world.prepared["t-little"]
    plan = ai.rules_plan(prepared, TODAY)
    key = prepared.edition.edition_key
    exact = ai.GoalResult(key, tuple(prepared.ordinals))
    assert score(prepared, plan, exact, True)["goal_recognition"] is True
    for wrong in (
        ai.GoalResult(key, (112,)),  # a part of the scope
        ai.GoalResult(key, (*prepared.ordinals, 114)),  # more than the scope
        ai.GoalResult(key, (112, 112, 113)),  # a repeated ordinal
        ai.GoalResult("nawawi40-hadeethenc-synthetic", tuple(prepared.ordinals)),
        ai.GoalResult(None, None),
        None,
    ):
        assert score(prepared, plan, wrong, True)["goal_recognition"] is False


def test_the_goal_answer_must_name_the_catalog() -> None:
    editions = catalog.edition_list()
    ok = {"editionKey": "quran-hafs-quranenc-synthetic", "sectionOrdinals": [112, 113]}
    assert ai.parse_goal(ok, editions) == ai.GoalResult("quran-hafs-quranenc-synthetic", (112, 113))
    bad_values: list[Any] = [
        {"editionKey": "nope", "sectionOrdinals": [112]},
        {"editionKey": "quran-hafs-quranenc-synthetic", "sectionOrdinals": [1]},
        {"editionKey": "quran-hafs-quranenc-synthetic", "sectionOrdinals": []},
        {"editionKey": "quran-hafs-quranenc-synthetic", "sectionOrdinals": [True]},
        {"editionKey": "quran-hafs-quranenc-synthetic", "sectionOrdinals": [112], "extra": 1},
        ["editionKey"],
        None,
    ]
    for bad in bad_values:
        assert ai.parse_goal(bad, editions) is None


# --- the planner contract (bounds of G-5) ---------------------------------------------------------

IDS = ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"]


def advice(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "newWordsPerDay": 20,
        "reviewOffsetsDays": [1, 3, 7],
        "priorityReviewPassageIds": [IDS[1]],
    }
    base.update(changes)
    return base


@pytest.mark.parametrize(
    "data",
    [
        advice(newWordsPerDay=0),
        advice(newWordsPerDay=26),
        advice(newWordsPerDay=True),
        advice(newWordsPerDay="20"),
        advice(reviewOffsetsDays=[]),
        advice(reviewOffsetsDays=[3, 1]),
        advice(reviewOffsetsDays=[1, 1]),
        advice(reviewOffsetsDays=[1, 2, 3, 4, 5, 6]),
        advice(reviewOffsetsDays=[0, 3]),
        advice(reviewOffsetsDays=[1, 31]),
        advice(priorityReviewPassageIds=["bbbbbbbb-bbbb-4bbb-8bbb-000000000009"]),
        advice(priorityReviewPassageIds=[IDS[0], "invented"]),
        advice(priorityReviewPassageIds="all"),
        {**advice(), "reply": "hello"},
        {"newWordsPerDay": 20},
        [],
        None,
    ],
)
def test_the_local_advice_validator_refuses_anything_outside_the_bounds(data: Any) -> None:
    assert ai.validate_advice_local(data, passage_ids=IDS, capacity=25) is None


def test_the_local_advice_validator_accepts_and_cleans_valid_advice() -> None:
    got = ai.validate_advice_local(
        advice(priorityReviewPassageIds=[IDS[1].upper(), IDS[1], IDS[0]]),
        passage_ids=IDS,
        capacity=25,
    )
    assert got is not None
    assert got.new_words_per_day == 20 and got.review_offsets_days == (1, 3, 7)
    assert got.priority_review_passage_ids == (IDS[1], IDS[0])


def test_the_local_adapter_and_the_api_policy_agree(world: World) -> None:
    kit = ai.wp_a_kit()
    if kit is None:
        pytest.skip("app.domain.demo_policy does not offer the planner contract yet")
    local = ai.local_kit()
    prepared = world.prepared["t-absent"]
    assert local.build_payload(prepared) == kit.build_payload(prepared)
    assert local.schema == kit.schema and local.prompt == kit.prompt
    assert local.allowed_keys == kit.allowed_keys
    ids = [str(p.id) for p in prepared.passages]
    for data in (
        advice(priorityReviewPassageIds=[ids[0]]),
        advice(newWordsPerDay=99),
        advice(priorityReviewPassageIds=["invented"]),
        advice(reviewOffsetsDays=[2, 1]),
    ):
        mine = local.validate(data, passage_ids=ids, capacity=25)
        theirs = kit.validate(data, passage_ids=ids, capacity=25)
        assert (mine is None) == (theirs is None)
        if mine is not None and theirs is not None:
            assert mine.new_words_per_day == theirs.new_words_per_day
            assert mine.priority_review_passage_ids == theirs.priority_review_passage_ids
