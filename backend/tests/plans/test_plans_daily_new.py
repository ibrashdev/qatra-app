"""The daily amount in whole units (D90): ``Estimate.daily_new``. Synthetic data only.

The pace stays in words; the learner is told whole ayat or hadith a day (or one hadith every N
days). Fixtures: surah 112 has 4 ayat in the validated table; one long hadith of 66 words takes
two days at 15 minutes.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from app.contracts_plan_chat import DailyNew, Estimate, TargetScope
from app.contracts_plans import EstimateInput
from app.domain import plan_policy as pp
from app.repositories.catalog import edition_from_bundle
from tests.plans.plans_support import (
    HADITH_ID,
    QURAN_ID,
    TODAY,
    hadith_bundle,
    make_bundle,
    pid,
    quran_bundle,
)


def quran_edition(
    sections: list[tuple[int, str, str, str]], passages: list[tuple[int, int, str, int, int]]
) -> tuple[pp.EditionData, list[pp.PassageRow]]:
    data, rows = edition_from_bundle(
        make_bundle(
            edition_id=QURAN_ID,
            key="quran-daily",
            content_format="quran",
            sections=sections,
            passages=passages,
        )
    )
    return data, list(rows)


def hadith_edition(count: int, words: list[int]) -> tuple[pp.EditionData, list[pp.PassageRow]]:
    """``count`` hadith with one matn passage each; ``words`` gives the words of each."""
    data, rows = edition_from_bundle(
        make_bundle(
            edition_id=HADITH_ID,
            key="hadith-daily",
            content_format="hadith_collection",
            sections=[(n, "hadith", f"nawawi40:{n}", f"Hadith {n}") for n in range(1, count + 1)],
            passages=[(n, n, "matn", n, words[n - 1]) for n in range(1, count + 1)],
        )
    )
    return data, list(rows)


def estimate(edition: pp.EditionData, ordinals: list[int], minutes: int, **kwargs: Any) -> Estimate:
    paths = kwargs.pop("paths", ["quran"] if edition.content_format == "quran" else ["matn"])
    return pp.compute_estimate(
        edition, ordinals=ordinals, paths=paths, session_minutes=minutes, today=TODAY, **kwargs
    )


# --- ayat (Quran editions) -----------------------------------------------------------------------


def test_surah_112_at_fifteen_minutes_is_four_ayat_a_day() -> None:
    """Surah 112 has 4 ayat; about 15 words take one day at 40 words a day."""
    edition, _ = quran_edition([(1, "surah", "112", "Surah 112")], [(1, 1, "quran", 1, 15)])
    result = estimate(edition, [1], 15)
    assert result.days == 1 and result.new_words_per_day == 40
    assert result.daily_new == DailyNew(unit="ayah", per_day=4)
    assert result.model_dump(by_alias=True, mode="json")["dailyNew"] == {
        "unit": "ayah",
        "perDay": 4,
        "everyDays": None,
    }


def test_the_words_pace_is_unchanged_by_the_unit_amount() -> None:
    edition, _ = quran_edition([(1, "surah", "112", "Surah 112")], [(1, 1, "quran", 1, 15)])
    for minutes, capacity in ((5, 12), (10, 25), (15, 40)):
        assert estimate(edition, [1], minutes).new_words_per_day == capacity


def test_ayat_are_spread_over_the_days_and_rounded_half_up() -> None:
    # surah 110: 3 ayat, 20 words; at 5 minutes days = ceil(20 * 1.15 / 12) = 2; 3 / 2 = 1.5 -> 2
    edition, _ = quran_edition([(1, "surah", "110", "Surah 110")], [(1, 1, "quran", 1, 20)])
    result = estimate(edition, [1], 5)
    assert result.days == 2
    assert result.daily_new == DailyNew(unit="ayah", per_day=2)


def test_ayat_of_every_section_in_scope_are_added() -> None:
    edition, _ = quran_edition(
        [(1, "surah", "112", "Surah 112"), (2, "surah", "113", "Surah 113")],
        [(1, 1, "quran", 1, 30), (2, 2, "quran", 2, 30)],
    )
    # 4 + 5 ayat, 60 words at 10 minutes: days = ceil(60 * 1.15 / 25) = 3 -> 9 / 3 = 3 a day
    assert estimate(edition, [1, 2], 10).daily_new == DailyNew(unit="ayah", per_day=3)
    # 5 ayat, 30 words: 2 days; 5 / 2 = 2.5 rounds half up to 3
    assert estimate(edition, [2], 10).daily_new == DailyNew(unit="ayah", per_day=3)


def test_a_bundle_that_carries_ayah_units_is_counted_not_looked_up() -> None:
    """In memory mode the bundle's own units win over the per-surah table."""
    bundle = make_bundle(
        edition_id=QURAN_ID,
        key="quran-units",
        content_format="quran",
        sections=[(1, "surah", "112", "Surah 112")],
        passages=[(1, 1, "quran", 1, 15)],
    )
    bundle["units"] = [{"kind": "ayah", "sectionOrdinal": 1, "ordinal": n} for n in (1, 2, 3)]
    data, _ = edition_from_bundle(bundle)
    assert data.sections[0].unit_count == 3
    assert estimate(data, [1], 15).daily_new == DailyNew(unit="ayah", per_day=3)


def test_known_words_shrink_the_remaining_ayat_in_proportion() -> None:
    # 100 words, 20 known -> 80 words, 20 % of the 40 ayat of surah 78 are known.
    edition, passages = quran_edition(
        [(1, "surah", "78", "Surah 78")], [(1, 1, "quran", 1, 20), (2, 1, "quran", 2, 80)]
    )
    known = [row for row in passages if row.passage_id == pid(1)]
    fresh = estimate(edition, [1], 5)
    partly = estimate(edition, [1], 5, known=known)
    assert fresh.days == 10 and fresh.daily_new == DailyNew(unit="ayah", per_day=4)  # 40 / 10
    assert partly.days == 8  # ceil(80 * 1.15 / 12)
    # 32 remaining ayat / 8 days; all 40 over 8 days would wrongly say 5
    assert partly.daily_new == DailyNew(unit="ayah", per_day=4)


def test_nothing_to_learn_has_no_amount() -> None:
    edition, passages = quran_edition([(1, "surah", "112", "Surah 112")], [(1, 1, "quran", 1, 15)])
    result = estimate(edition, [1], 15, known=passages)
    assert result.days == 0 and result.daily_new is None


def test_a_surah_without_a_known_ayah_count_has_no_amount() -> None:
    """Outside the validated table there is no number to show: the client falls back to words."""
    edition, _ = quran_edition([(1, "surah", "2", "Surah 2")], [(1, 1, "quran", 1, 15)])
    assert edition.sections[0].unit_count is None
    assert estimate(edition, [1], 15).daily_new is None


def test_supabase_mode_sections_use_the_validated_table() -> None:
    from app.repositories.catalog import _section_from_row

    section = _section_from_row(
        {
            "section_id": "s1",
            "ordinal": 1,
            "kind": "surah",
            "reference": "112",
            "title_ar": "ع",
            "title_en": "e",
            "path_stats": {"quran": {"words": 15, "passages": 1}},
        }
    )
    assert section.unit_count == 4
    hadith = _section_from_row(
        {
            "section_id": "s2",
            "ordinal": 2,
            "kind": "hadith",
            "reference": "nawawi40:1",
            "title_ar": "ع",
            "title_en": "e",
            "path_stats": {},
        }
    )
    assert hadith.unit_count is None


# --- hadith (the Forty) --------------------------------------------------------------------------


def test_one_long_hadith_at_fifteen_minutes_is_one_new_hadith_every_two_days() -> None:
    """A hadith of 66 words at 40 words a day takes ceil(66 * 1.15 / 40) = 2 days."""
    edition, _ = hadith_edition(1, [66])
    result = estimate(edition, [1], 15)
    assert result.days == 2
    assert result.daily_new == DailyNew(unit="hadith", every_days=2)
    assert result.model_dump(by_alias=True, mode="json")["dailyNew"] == {
        "unit": "hadith",
        "perDay": None,
        "everyDays": 2,
    }


def test_a_few_long_hadith_are_one_every_n_days() -> None:
    edition, _ = hadith_edition(3, [30, 30, 30])  # 90 words at 12 a day: ceil(90 * 1.15 / 12) = 9
    result = estimate(edition, [1, 2, 3], 5)
    assert result.days == 9
    assert result.daily_new == DailyNew(unit="hadith", every_days=3)


def test_many_short_hadith_are_several_a_day() -> None:
    edition, _ = hadith_edition(10, [10] * 10)  # 100 words at 40 a day: 3 days; 10 / 3 = 3.33
    result = estimate(edition, list(range(1, 11)), 15)
    assert result.days == 3
    assert result.daily_new == DailyNew(unit="hadith", per_day=3)


def test_as_many_hadith_as_days_is_one_a_day() -> None:
    edition, _ = hadith_edition(3, [10, 10, 10])  # 30 words at 12 a day: ceil(34.5 / 12) = 3 days
    result = estimate(edition, [1, 2, 3], 5)
    assert result.days == 3
    assert result.daily_new == DailyNew(unit="hadith", per_day=1)


def test_only_hadith_with_the_selected_path_count() -> None:
    edition, _ = edition_from_bundle(hadith_bundle())
    # fixture: hadith 2 has no grade passage; the grade path covers hadith 1 and 3 only.
    result = estimate(edition, [1, 2, 3], 5, paths=["grade"])
    assert result.passage_count == 2
    assert result.daily_new is not None and result.daily_new.unit == "hadith"
    assert pp.scope_units(edition, [1, 2, 3], ["grade"]) == ("hadith", 2)
    assert pp.scope_units(edition, [1, 2, 3], ["matn"]) == ("hadith", 3)


# --- the contract --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "values",
    [
        {"unit": "ayah"},
        {"unit": "ayah", "per_day": 1, "every_days": 1},
        {"unit": "ayah", "per_day": 0},
        {"unit": "hadith", "every_days": 0},
        {"unit": "surah", "per_day": 1},
    ],
)
def test_daily_new_needs_exactly_one_positive_rate(values: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        DailyNew(**values)


def test_estimates_equal_ignores_daily_new() -> None:
    """A client that predates D90 (or echoes a stale value) still confirms the same estimate."""
    edition, _ = quran_edition([(1, "surah", "112", "Surah 112")], [(1, 1, "quran", 1, 15)])
    fresh = estimate(edition, [1], 15)
    assert fresh.daily_new is not None
    assert pp.estimates_equal(fresh, fresh.model_copy(update={"daily_new": None}))
    assert pp.estimates_equal(
        fresh, fresh.model_copy(update={"daily_new": DailyNew(unit="ayah", per_day=9)})
    )


def test_an_estimate_stored_before_d90_reads_back_without_a_daily_amount() -> None:
    stored = {
        "days": 8,
        "endDate": "2026-10-12",
        "newWordsPerDay": 25,
        "totalWords": 160,
        "knownWords": 0,
        "passageCount": 4,
        "sessionMinutes": 10,
        "scope": {"sectionOrdinals": [1, 2]},
        "paths": ["quran"],
    }
    old = Estimate.model_validate(stored)
    assert old.daily_new is None
    assert old.model_dump(by_alias=True, mode="json")["dailyNew"] is None
    assert old.scope == TargetScope(section_ordinals=[1, 2])


def test_confirmed_estimate_input_accepts_a_daily_amount_or_none() -> None:
    base = {
        "days": 1,
        "endDate": "2026-10-05",
        "newWordsPerDay": 40,
        "totalWords": 15,
        "knownWords": 0,
        "passageCount": 1,
        "sessionMinutes": 15,
        "scope": {"sectionOrdinals": [1]},
        "paths": ["quran"],
    }
    assert EstimateInput.model_validate(base).daily_new is None
    echoed = {**base, "dailyNew": {"unit": "ayah", "perDay": 4, "everyDays": None}}
    assert EstimateInput.model_validate(echoed).daily_new is not None
    with pytest.raises(ValidationError):
        EstimateInput.model_validate({**base, "dailyNew": {"unit": "ayah", "extra": 1}})


def test_the_fixture_quran_edition_still_estimates_in_ayat() -> None:
    edition, _ = edition_from_bundle(quran_bundle())
    assert [section.unit_count for section in edition.sections] == [40, 46, 42, 29]
