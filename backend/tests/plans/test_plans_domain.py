"""The pure planning rules of B4 (``app.domain.plan_policy``): estimate, alternatives, rules,
learning date, phases and the commit. Synthetic data only."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from fractions import Fraction
from uuid import UUID

import pytest

from app.contracts_plan_chat import Estimate, TargetScope
from app.domain import plan_policy as pp
from app.domain.plan_chat_policy import FieldError, halve_scope
from app.repositories.catalog import edition_from_bundle
from tests.plans.plans_support import (
    EXAMPLE_ALTERNATIVES,
    EXAMPLE_ESTIMATE,
    TODAY,
    hadith_bundle,
    pid,
    quran_bundle,
)


@pytest.fixture(scope="module")
def quran() -> tuple[pp.EditionData, list[pp.PassageRow]]:
    data, passages = edition_from_bundle(quran_bundle())
    return data, list(passages)


@pytest.fixture(scope="module")
def hadith() -> tuple[pp.EditionData, list[pp.PassageRow]]:
    data, passages = edition_from_bundle(hadith_bundle())
    return data, list(passages)


def known_rows(passages: list[pp.PassageRow], *numbers: int) -> list[pp.PassageRow]:
    wanted = {pid(number) for number in numbers}
    return [row for row in passages if row.passage_id in wanted]


def dump(estimate: Estimate) -> dict:
    return estimate.model_dump(by_alias=True, mode="json")


# --- the estimate formula ------------------------------------------------------------------------


@pytest.mark.parametrize("minutes,capacity", [(5, 12), (10, 25), (15, 40)])
def test_capacity_per_session_length(minutes: int, capacity: int) -> None:
    assert pp.CAPACITY_BY_MINUTES[minutes] == capacity


def test_days_formula_is_the_exact_ceiling_of_the_buffered_quotient() -> None:
    """``ceil(remaining / capacity * 1.15)`` with 1.15 as the exact fraction 23/20."""
    for capacity in (12, 25, 40):
        for remaining in range(0, 3000):
            exact = Fraction(remaining, capacity) * Fraction(23, 20)
            expected = -(-exact.numerator // exact.denominator)
            assert pp.review_buffered_days(remaining, capacity) == expected


def test_days_never_negative_and_zero_when_everything_is_known() -> None:
    assert pp.review_buffered_days(0, 12) == 0
    assert pp.review_buffered_days(-5, 12) == 0


def test_the_estimate_reproduces_the_api_spec_e15_example(quran) -> None:
    edition, passages = quran
    result = pp.estimate_with_alternatives(
        edition,
        ordinals=[1, 2],
        paths=["quran"],
        session_minutes=5,
        order="book",
        preferred_date=date(2026, 10, 20),
        today=TODAY,
        known=known_rows(passages, 1),
    )
    assert dump(result.estimate) == EXAMPLE_ESTIMATE
    assert [dump(item) for item in result.alternatives] == EXAMPLE_ALTERNATIVES
    assert result.reason_code == "fits_preferred_date"


def test_end_date_is_today_plus_days(quran) -> None:
    edition, _ = quran
    estimate = pp.compute_estimate(
        edition, ordinals=[1, 2], paths=["quran"], session_minutes=15, today=date(2026, 12, 30)
    )
    assert estimate.days == 6  # 180 / 40 * 1.15 = 5.175
    assert estimate.end_date == date(2026, 12, 30) + timedelta(days=6)
    assert estimate.known_words == 0 and estimate.new_words_per_day == 40


@pytest.mark.parametrize(
    "preferred,expected",
    [
        (date(2026, 10, 20), "fits_preferred_date"),
        (date(2026, 10, 19), "exceeds_preferred_date"),
        (None, "no_preferred_date"),
    ],
)
def test_reason_code(quran, preferred: date | None, expected: str) -> None:
    edition, passages = quran
    result = pp.estimate_with_alternatives(
        edition,
        ordinals=[1, 2],
        paths=["quran"],
        session_minutes=5,
        order="book",
        preferred_date=preferred,
        today=TODAY,
        known=known_rows(passages, 1),
    )
    assert result.estimate.end_date == date(2026, 10, 20)
    assert result.reason_code == expected


def estimate_for(edition, **overrides):
    values = {
        "ordinals": [1, 2],
        "paths": ["quran"],
        "session_minutes": 5,
        "order": "book",
        "preferred_date": None,
        "today": TODAY,
    }
    values.update(overrides)
    return pp.estimate_with_alternatives(edition, **values)


def test_alternative_a_is_omitted_at_fifteen_minutes(quran) -> None:
    edition, _ = quran
    result = estimate_for(edition, session_minutes=15)
    assert [a.session_minutes for a in result.alternatives] == [15]
    assert [a.scope.section_ordinals for a in result.alternatives] == [[1]]


def test_alternative_b_is_omitted_for_a_single_section(quran) -> None:
    edition, _ = quran
    result = estimate_for(edition, ordinals=[2])
    assert [a.session_minutes for a in result.alternatives] == [10]


def test_no_alternatives_at_fifteen_minutes_and_one_section(quran) -> None:
    edition, _ = quran
    assert estimate_for(edition, ordinals=[3], session_minutes=15).alternatives == []


def test_alternative_a_is_the_next_larger_option(quran) -> None:
    edition, _ = quran
    assert estimate_for(edition, session_minutes=10).alternatives[0].session_minutes == 15
    assert estimate_for(edition, session_minutes=5).alternatives[0].session_minutes == 10


@pytest.mark.parametrize(
    "ordinals,order,expected",
    [
        ([1, 2, 3, 4], "book", [1, 2]),
        ([1, 2, 3, 4], "reverse", [3, 4]),  # the first half in reverse plan order is 4, 3
        ([1, 2, 3], "book", [1, 2]),
        ([1, 2, 3], "reverse", [2, 3]),
        ([4, 1], "book", [1]),
    ],
)
def test_alternative_b_uses_halve_scope_in_plan_order(quran, ordinals, order, expected) -> None:
    edition, _ = quran
    result = estimate_for(edition, ordinals=ordinals, order=order)
    assert result.alternatives[-1].scope.section_ordinals == expected
    assert expected == halve_scope(ordinals, order)


def test_alternative_b_counts_known_words_inside_the_halved_scope_only(quran) -> None:
    edition, passages = quran
    result = estimate_for(edition, known=known_rows(passages, 3))  # section 2 passage, 40 words
    assert result.estimate.known_words == 40
    assert result.alternatives[1].scope.section_ordinals == [1]
    assert result.alternatives[1].known_words == 0


def test_known_words_only_count_inside_scope_and_selected_paths(hadith) -> None:
    edition, passages = hadith
    known = known_rows(passages, 11, 12, 16)  # matn s1 (10), sanad s1 (6), matn s3 (20)
    matn = pp.compute_estimate(
        edition, ordinals=[1, 2], paths=["matn"], session_minutes=5, today=TODAY, known=known
    )
    assert (matn.total_words, matn.known_words, matn.passage_count) == (40, 10, 2)
    both = pp.compute_estimate(
        edition,
        ordinals=[1, 2],
        paths=["sanad", "matn"],
        session_minutes=5,
        today=TODAY,
        known=known,
    )
    assert both.paths == ["matn", "sanad"]
    assert (both.total_words, both.known_words, both.passage_count) == (54, 16, 4)


def test_known_words_never_exceed_the_total(quran) -> None:
    edition, passages = quran
    estimate = pp.compute_estimate(
        edition, ordinals=[3], paths=["quran"], session_minutes=5, today=TODAY, known=passages
    )
    assert estimate.known_words == estimate.total_words == 30
    assert estimate.days == 0


def test_estimates_compare_every_field_and_ignore_the_order_of_lists(quran) -> None:
    edition, _ = quran
    left = pp.compute_estimate(
        edition, ordinals=[1, 2], paths=["quran"], session_minutes=5, today=TODAY
    )
    right = left.model_copy(deep=True)
    assert pp.estimates_equal(left, right)
    right.scope = TargetScope(section_ordinals=[2, 1])
    assert pp.estimates_equal(left, right)
    for change in (
        {"days": left.days + 1},
        {"end_date": left.end_date + timedelta(days=1)},
        {"new_words_per_day": 25},
        {"total_words": 1},
        {"known_words": 1},
        {"passage_count": 9},
        {"session_minutes": 10},
        {"scope": TargetScope(section_ordinals=[1])},
        {"paths": ["matn"]},
    ):
        assert not pp.estimates_equal(left, left.model_copy(update=change))


# --- catalog view of an edition ------------------------------------------------------------------


def test_catalog_counts_sum_the_default_paths(hadith) -> None:
    edition, _ = hadith
    dto = pp.edition_dto(edition)
    assert dto.available_paths == ["matn", "sanad", "grade"]
    assert dto.default_paths == ["matn"]
    assert dto.default_order == "book"
    assert dto.total_words == 60  # the matn words only (A-12, O-15)
    assert [(s.ordinal, s.word_count, s.passage_count) for s in dto.sections] == [
        (1, 10, 1),
        (2, 30, 1),
        (3, 20, 1),
    ]
    assert [s.paths for s in dto.sections] == [
        ["matn", "sanad", "grade"],
        ["matn", "sanad"],
        ["matn", "sanad", "grade"],
    ]


def test_quran_defaults_to_the_quran_path(quran) -> None:
    edition, _ = quran
    dto = pp.edition_dto(edition)
    assert dto.default_paths == ["quran"] and dto.total_words == 240


def test_default_path_when_the_expected_one_is_missing() -> None:
    assert pp.default_paths("hadith_collection", ("sanad", "grade")) == ("sanad",)
    assert pp.default_paths("quran", ()) == ()


def test_missing_english_labels_fall_back_to_arabic_never_to_a_translation() -> None:
    data, _ = edition_from_bundle(quran_bundle(title_en=None, category_label_en=None))
    dto = pp.edition_dto(data)
    assert dto.title_en == dto.title_ar == "«عنوان الكتاب»"
    assert dto.category.label_en == dto.category.label_ar == "«اسم الباب»"


def test_canonical_path_order() -> None:
    assert pp.canonical_paths(["grade", "quran", "sanad", "matn", "matn"]) == (
        "quran",
        "matn",
        "sanad",
        "grade",
    )


# --- the shared input rules ----------------------------------------------------------------------


def check(edition, **overrides) -> list[tuple[str, str]]:
    values = {
        "ordinals": [1, 2],
        "paths": ["quran"],
        "session_minutes": 5,
        "preferred_date": None,
        "order": "book",
        "today": TODAY,
    }
    values.update(overrides)
    return [(e.field, e.rule) for e in pp.validate_plan_input(edition, **values)]


def test_valid_input_has_no_errors(quran, hadith) -> None:
    assert check(quran[0]) == []
    assert check(quran[0], order="reverse", preferred_date=TODAY) == []
    assert check(hadith[0], paths=["matn", "sanad"], ordinals=[3, 1]) == []


@pytest.mark.parametrize(
    "ordinals",
    [[], [1, 1], [1, 99], [0], [-1], list(range(1, 62))],
    ids=["empty", "duplicate", "unknown", "zero", "negative", "more than 60"],
)
def test_scope_rule(quran, ordinals) -> None:
    assert check(quran[0], ordinals=ordinals) == [("targetScope", "scope_invalid")]


@pytest.mark.parametrize(
    "paths",
    [[], ["quran", "quran"], ["foo"], ["matn"], ["quran", "matn"], ["takhrij"]],
    ids=["empty", "duplicate", "unknown", "not available", "partly available", "takhrij"],
)
def test_paths_rule_on_the_quran_edition(quran, paths) -> None:
    assert check(quran[0], paths=paths) == [("paths", "paths_invalid")]


def test_paths_rule_on_the_hadith_edition(hadith) -> None:
    assert check(hadith[0], paths=["quran"]) == [("paths", "paths_invalid")]
    assert check(hadith[0], paths=["matn", "matn"]) == [("paths", "paths_invalid")]
    assert check(hadith[0], paths=["matn", "sanad", "grade"]) == []


@pytest.mark.parametrize("minutes", [0, 4, 7, 20, -5])
def test_session_minutes_rule(quran, minutes) -> None:
    assert check(quran[0], session_minutes=minutes) == [
        ("sessionMinutes", "session_minutes_invalid")
    ]


def test_past_date_rule_and_today_is_allowed(quran) -> None:
    assert check(quran[0], preferred_date=TODAY - timedelta(days=1)) == [
        ("preferredDate", "date_invalid")
    ]
    assert check(quran[0], preferred_date=TODAY) == []


def test_order_rules(quran, hadith) -> None:
    assert check(quran[0], order="sideways") == [("order", "order_invalid")]
    assert check(hadith[0], paths=["matn"], order="reverse") == [("order", "order_not_available")]
    assert check(hadith[0], paths=["matn"], order="book") == []
    assert check(quran[0], order="reverse") == []


def test_several_rules_are_reported_together(quran) -> None:
    errors = check(
        quran[0],
        ordinals=[99],
        paths=["matn"],
        session_minutes=7,
        order="x",
        preferred_date=TODAY - timedelta(days=3),
    )
    assert set(errors) == {
        ("targetScope", "scope_invalid"),
        ("paths", "paths_invalid"),
        ("sessionMinutes", "session_minutes_invalid"),
        ("order", "order_invalid"),
        ("preferredDate", "date_invalid"),
    }


def test_a_scope_without_passages_for_the_selected_paths_is_refused() -> None:
    """Hadith 2 has no grade passage: a plan for the grade path of that hadith alone is empty."""
    data, _ = edition_from_bundle(hadith_bundle())
    assert check(data, ordinals=[2], paths=["grade"]) == [("targetScope", "scope_invalid")]
    assert check(data, ordinals=[1, 2], paths=["grade"]) == []


# --- learning date (API-spec §1.10, D57) ---------------------------------------------------------


def test_learning_date_follows_the_account_time_zone() -> None:
    late = datetime(2026, 10, 4, 21, 0, tzinfo=UTC)  # 01:00 on 5 October in Dubai
    assert pp.learning_date(late, "Asia/Dubai") == date(2026, 10, 5)
    assert pp.learning_date(late, "UTC") == date(2026, 10, 4)
    assert pp.learning_date(late, "Pacific/Honolulu") == date(2026, 10, 4)
    boundary = datetime(2026, 10, 4, 19, 59, 59, tzinfo=UTC)
    assert pp.learning_date(boundary, "Asia/Dubai") == date(2026, 10, 4)
    assert pp.learning_date(boundary + timedelta(seconds=1), "Asia/Dubai") == date(2026, 10, 5)


def test_a_pending_time_zone_applies_from_its_effective_date_only() -> None:
    now = datetime(2026, 10, 4, 21, 0, tzinfo=UTC)  # 5 October in Dubai, 4 October in Honolulu
    before = pp.learning_date(now, "Asia/Dubai", "Pacific/Honolulu", date(2026, 10, 6))
    assert before == date(2026, 10, 5)  # the current zone stays in force
    after = pp.learning_date(now, "Asia/Dubai", "Pacific/Honolulu", date(2026, 10, 5))
    assert after == date(2026, 10, 4)  # the pending zone is in force from its day


@pytest.mark.parametrize("zone", ["Mars/Base", "", "../etc", "Asia"])
def test_an_unknown_time_zone_is_a_value_error(zone: str) -> None:
    with pytest.raises(ValueError):
        pp.learning_date(datetime(2026, 10, 4, tzinfo=UTC), zone)


# --- phases --------------------------------------------------------------------------------------


def phases_for(data, passages, *, ordinals, paths, order="book", known=(), days=16):
    return pp.build_phases(
        data,
        passages,
        ordinals=ordinals,
        paths=paths,
        order=order,
        known_ids=known,
        today=TODAY,
        days=days,
    )


def test_book_order_runs_sections_ascending(quran) -> None:
    data, passages = quran
    phases = phases_for(data, passages, ordinals=[3, 1, 2], paths=["quran"])
    assert [p.section_refs[0]["ordinal"] for p in phases] == [1, 2, 3]
    assert [p.ordinal for p in phases] == [1, 2, 3]


def test_reverse_order_runs_sections_descending_with_passages_in_mushaf_order(quran) -> None:
    data, passages = quran
    phases = phases_for(data, passages, ordinals=[1, 2, 4], paths=["quran"], order="reverse")
    assert [p.section_refs[0]["ordinal"] for p in phases] == [4, 2, 1]
    # inside a surah the passages keep book order (D72, confirmed by D74 Q4)
    second = [item["ordinal"] for item in phases[1].unit_range["passages"]]
    third = [item["ordinal"] for item in phases[2].unit_range["passages"]]
    assert second == [3, 4] and third == [1, 2]


def test_every_passage_of_the_scope_appears_exactly_once_and_goal_sizes_add_up(quran) -> None:
    data, passages = quran
    for order in ("book", "reverse"):
        phases = phases_for(data, passages, ordinals=[1, 2, 3, 4], paths=["quran"], order=order)
        listed = [item["id"] for p in phases for item in p.unit_range["passages"]]
        assert sorted(listed) == sorted(str(row.passage_id) for row in passages)
        assert sum(p.goal_size for p in phases) == 240


def test_hadith_phases_group_paths_in_the_fixed_order_and_skip_empty_sections(hadith) -> None:
    data, passages = hadith
    phases = phases_for(
        data, passages, ordinals=[1, 2, 3], paths=["grade", "matn", "sanad"], days=3
    )
    first = [item["path"] for item in phases[0].unit_range["passages"]]
    assert first == ["matn", "sanad", "grade"]
    only_grade = phases_for(data, passages, ordinals=[1, 2, 3], paths=["grade"], days=1)
    assert [p.section_refs[0]["ordinal"] for p in only_grade] == [1, 3]  # hadith 2 has none
    assert [p.ordinal for p in only_grade] == [1, 2]


def test_phase_rows_have_the_database_shape(quran) -> None:
    data, passages = quran
    row = phases_for(data, passages, ordinals=[1], paths=["quran"])[0].row()
    assert set(row) == {"ordinal", "section_refs", "unit_range", "goal_size", "estimated_window"}
    assert row["section_refs"] == [{"sectionId": data.sections[0].section_id, "ordinal": 1}]
    assert row["goal_size"] == 100
    assert row["estimated_window"] == "[2026-10-04,2026-10-20)"


def test_windows_share_the_plan_days_in_proportion_to_unknown_words(quran) -> None:
    data, passages = quran
    phases = phases_for(data, passages, ordinals=[1, 2], paths=["quran"], known=[pid(1)], days=16)
    # 80 unknown words in each section: two halves of the 16 days
    assert [(p.window_start, p.window_end) for p in phases] == [
        (TODAY, TODAY + timedelta(days=8)),
        (TODAY + timedelta(days=8), TODAY + timedelta(days=16)),
    ]
    assert phases[0].goal_size == 100  # known passages stay in the goal (D66 weight)


@pytest.mark.parametrize("days", [0, 1, 2, 3, 7, 40])
def test_windows_are_never_empty_and_stay_inside_the_plan(quran, days) -> None:
    data, passages = quran
    phases = phases_for(data, passages, ordinals=[1, 2, 3, 4], paths=["quran"], days=days)
    assert len(phases) == 4
    end = TODAY + timedelta(days=max(days, 1))
    for phase in phases:
        assert TODAY <= phase.window_start < phase.window_end <= end
    assert phases[0].window_start == TODAY and phases[-1].window_end == end


def test_all_known_scope_still_gets_one_day_windows(quran) -> None:
    data, passages = quran
    phases = phases_for(data, passages, ordinals=[3], paths=["quran"], known=[pid(5)], days=0)
    assert [(p.window_start, p.window_end) for p in phases] == [(TODAY, TODAY + timedelta(days=1))]


# --- the commit ----------------------------------------------------------------------------------


def make_values(data, passages, **overrides) -> pp.PlanValues:
    estimate = pp.compute_estimate(
        data, ordinals=[1, 2], paths=["quran"], session_minutes=5, today=TODAY
    )
    values = {
        "edition_id": data.edition_id,
        "scope": (1, 2),
        "paths": ("quran",),
        "order": "book",
        "session_minutes": 5,
        "preferred_date": date(2026, 10, 20),
        "agreed_estimate": estimate,
    }
    values.update(overrides)
    return pp.PlanValues(**values)


def test_the_commit_carries_the_policy_snapshot_and_phase_rows(quran) -> None:
    data, passages = quran
    known = pp.KnownPassages(UUID("33333333-3333-4333-8333-000000000001"), (pid(1),))
    commit = pp.build_plan_commit(
        make_values(data, passages),
        reason_code=pp.REASON_CREATED,
        edition=data,
        passages=passages,
        known=known,
        planner_source="teaching_agent",
        planner_model="free/model:free",
        today=TODAY,
        days=16,
        effective_date=TODAY,
    )
    policy = commit.policy_json
    assert policy["policyVersion"] == 1
    assert policy["scope"] == {"sectionOrdinals": [1, 2]}
    assert (policy["paths"], policy["order"], policy["sessionMinutes"]) == (["quran"], "book", 5)
    assert policy["preferredDate"] == "2026-10-20"
    assert policy["knownPassages"] == {
        "placementSessionId": "33333333-3333-4333-8333-000000000001",
        "passageIds": [str(pid(1))],
    }
    assert policy["planner"] == {"source": "teaching_agent", "model": "free/model:free"}
    assert policy["agreedEstimate"]["totalWords"] == 180
    assert commit.reason_code == "plan_created" and commit.effective_learning_date == TODAY
    assert len(commit.phase_rows()) == 2


def test_the_rules_planner_records_no_model(quran) -> None:
    data, passages = quran
    commit = pp.build_plan_commit(
        make_values(data, passages, preferred_date=None),
        reason_code=pp.REASON_REVISED,
        edition=data,
        passages=passages,
        known=pp.KnownPassages(),
        planner_source="rules",
        planner_model=None,
        today=TODAY,
        days=16,
        effective_date=TODAY + timedelta(days=1),
    )
    assert commit.policy_json["planner"] == {"source": "rules"}
    assert commit.policy_json["preferredDate"] is None
    assert commit.policy_json["knownPassages"] == {"placementSessionId": None, "passageIds": []}


def test_plan_args_are_the_arguments_of_the_chat_confirm_function(quran) -> None:
    data, passages = quran
    commit = pp.build_plan_commit(
        make_values(data, passages),
        reason_code=pp.REASON_CREATED,
        edition=data,
        passages=passages,
        known=pp.KnownPassages(),
        planner_source="rules",
        planner_model=None,
        today=TODAY,
        days=16,
        effective_date=TODAY,
    )
    args = commit.plan_args()
    assert set(args) == {"reason_code", "policy_json", "effective_learning_date", "phases"}
    assert args["effective_learning_date"] == "2026-10-04"
    assert args["phases"] == commit.phase_rows()


def test_known_passages_round_trip_and_tolerate_damaged_policy() -> None:
    known = pp.KnownPassages(UUID(int=7), (pid(2), pid(1)))
    assert pp.known_from_policy({"knownPassages": known.as_json()}) == known
    assert pp.known_from_policy({}) == pp.KnownPassages()
    assert pp.known_from_policy({"knownPassages": "x"}) == pp.KnownPassages()
    damaged = {"knownPassages": {"placementSessionId": "no", "passageIds": ["no", str(pid(1)), 3]}}
    assert pp.known_from_policy(damaged) == pp.KnownPassages(None, (pid(1),))


def test_planner_defaults_to_rules_for_plans_without_a_record() -> None:
    assert pp.planner_from_policy({}) == ("rules", None)
    assert pp.planner_from_policy({"planner": {"source": "teaching_agent", "model": "m"}}) == (
        "teaching_agent",
        "m",
    )
    assert pp.planner_from_policy({"planner": {"source": "other"}}) == ("rules", None)


def test_field_errors_are_the_shared_type() -> None:
    error = pp.PlanInputError([FieldError("paths", "paths_invalid")])
    assert error.errors[0].rule == "paths_invalid"
