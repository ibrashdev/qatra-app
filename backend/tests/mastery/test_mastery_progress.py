"""Contract §4, rules 7 and 8: overall plan progress, section counts, the next review date and the
effect of a scope (path) change (pure, no I/O)."""

from __future__ import annotations

from datetime import date

import pytest

from app.domain.mastery_policy import (
    PassageCounts,
    coverage_counts,
    next_new_passage,
    percent_of,
    section_status,
    summarize_plan_progress,
)
from tests.sessions.ss_policy_support import mastery, passage, uid

OCT_6 = date(2026, 10, 6)
OCT_19 = date(2026, 10, 19)


def api_spec_plan():
    """The plan of the E19 example: two sections, four passages of 50, 50, 40 and 40 words; the
    first is confirmed, the second reviewing (due 2026-10-06), the third being learned."""
    a = passage("A", section=1, ordinal=1, words=(25, 25))
    b = passage("B", section=1, ordinal=2, words=(25, 25))
    c = passage("C", section=2, ordinal=1, words=(20, 20))
    d = passage("D", section=2, ordinal=2, words=(20, 20))
    rows = {
        a.id: mastery(a, "confirmed", due=OCT_19),
        b.id: mastery(b, "reviewing", due=OCT_6),
        c.id: mastery(c, "learning"),
    }
    return [a, b, c, d], rows


# --- rule 7: overall progress --------------------------------------------------------------------


def test_rule7_overall_percent_is_the_floor_of_confirmed_words_over_all_words() -> None:
    passages, rows = api_spec_plan()
    facts = summarize_plan_progress(passages, rows)
    assert (facts.confirmed_words, facts.total_words) == (50, 180)
    assert facts.overall_percent == 27  # floor(100 * 50 / 180) = floor(27.7)


@pytest.mark.parametrize(
    ("confirmed", "total", "percent"),
    [
        (0, 180, 0),
        (1, 3, 33),
        (2, 3, 66),
        (179, 180, 99),
        (180, 180, 100),
        (50, 100, 50),
        (0, 0, 0),
    ],
)
def test_rule7_percent_is_floored_never_rounded_up_and_zero_without_words(
    confirmed: int, total: int, percent: int
) -> None:
    assert percent_of(confirmed, total) == percent


def test_rule7_progress_is_word_weighted_so_a_long_passage_outweighs_a_short_one() -> None:
    short = passage("short", section=1, ordinal=1, words=(10,))
    long = passage("long", section=1, ordinal=2, words=(45, 45))
    only_short = {short.id: mastery(short, "confirmed", due=OCT_19)}
    only_long = {long.id: mastery(long, "confirmed", due=OCT_19)}
    assert summarize_plan_progress([short, long], only_short).overall_percent == 10
    assert summarize_plan_progress([short, long], only_long).overall_percent == 90


def test_rule7_everything_confirmed_is_one_hundred_percent() -> None:
    passages, _ = api_spec_plan()
    rows = {p.id: mastery(p, "confirmed", due=OCT_19) for p in passages}
    facts = summarize_plan_progress(passages, rows)
    assert facts.overall_percent == 100
    assert facts.confirmed_sections == facts.total_sections == 2


@pytest.mark.parametrize("status", ["new", "learning", "reviewing", "needs_refresh"])
def test_rule7_only_confirmed_passages_are_in_the_numerator(status: str) -> None:
    a = passage("A", section=1, ordinal=1, words=(30,))
    b = passage("B", section=1, ordinal=2, words=(70,))
    rows = {a.id: mastery(a, "confirmed", due=OCT_19), b.id: mastery(b, status, due=OCT_6)}
    assert summarize_plan_progress([a, b], rows).overall_percent == 30


def test_rule7_a_passage_that_needs_refresh_leaves_the_numerator_and_returns_when_confirmed() -> (
    None
):
    a = passage("A", section=1, ordinal=1, words=(50,))
    b = passage("B", section=1, ordinal=2, words=(50,))
    confirmed = {
        a.id: mastery(a, "confirmed", due=OCT_19),
        b.id: mastery(b, "confirmed", due=OCT_19),
    }
    assert summarize_plan_progress([a, b], confirmed).overall_percent == 100
    lapsed = {**confirmed, b.id: mastery(b, "needs_refresh", due=OCT_6)}
    assert summarize_plan_progress([a, b], lapsed).overall_percent == 50
    assert summarize_plan_progress([a, b], confirmed).overall_percent == 100


def test_rule7_a_plan_with_no_passages_has_no_progress() -> None:
    facts = summarize_plan_progress([], {})
    assert (facts.overall_percent, facts.total_words, facts.total_sections) == (0, 0, 0)
    assert facts.next_review_date is None
    assert facts.sections == ()


def test_rule7_counts_per_status_with_new_including_passages_that_have_no_row() -> None:
    passages, rows = api_spec_plan()
    facts = summarize_plan_progress(passages, rows)
    assert facts.counts == PassageCounts(
        new=1, learning=1, reviewing=1, confirmed=1, needs_refresh=0
    )
    rows[passages[0].id] = mastery(passages[0], "needs_refresh", due=OCT_6)
    counts = summarize_plan_progress(passages, rows).counts
    assert counts == PassageCounts(new=1, learning=1, reviewing=1, confirmed=0, needs_refresh=1)


def test_rule7_a_section_is_confirmed_only_when_all_its_passages_are() -> None:
    passages, rows = api_spec_plan()
    assert summarize_plan_progress(passages, rows).confirmed_sections == 0  # section 1 is half done
    rows[passages[1].id] = mastery(passages[1], "confirmed", due=OCT_19)
    facts = summarize_plan_progress(passages, rows)
    assert facts.confirmed_sections == 1
    assert facts.total_sections == 2


def test_rule7_the_example_sections_have_the_percent_and_status_of_the_api_spec() -> None:
    passages, rows = api_spec_plan()
    first, second = summarize_plan_progress(passages, rows).sections
    assert (first.ordinal, first.percent, first.status) == (1, 50, "reviewing")
    assert (second.ordinal, second.percent, second.status) == (2, 0, "learning")
    assert (first.words, first.confirmed_words, first.passage_count) == (100, 50, 2)


def test_rule7_the_next_review_date_is_the_earliest_due_date_on_the_ladder() -> None:
    passages, rows = api_spec_plan()
    assert summarize_plan_progress(passages, rows).next_review_date == OCT_6
    del rows[passages[1].id]  # only the confirmed passage (maintenance due) is left on the ladder
    assert summarize_plan_progress(passages, rows).next_review_date == OCT_19


def test_rule7_new_and_learning_passages_have_no_review_date() -> None:
    a = passage("A", words=(10,))
    b = passage("B", ordinal=2, words=(10,))
    rows = {a.id: mastery(a, "learning", next_review_due=date(2026, 1, 1))}
    assert summarize_plan_progress([a, b], rows).next_review_date is None


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], "new"),
        (["new"], "new"),
        (["new", "new"], "new"),
        (["learning"], "learning"),
        (["new", "learning"], "learning"),
        (["reviewing"], "reviewing"),
        (["new", "reviewing"], "reviewing"),
        (["learning", "reviewing"], "reviewing"),
        (["confirmed", "new"], "reviewing"),
        (["confirmed", "learning"], "reviewing"),
        (["confirmed", "reviewing"], "reviewing"),
        (["confirmed"], "confirmed"),
        (["confirmed", "confirmed"], "confirmed"),
        (["needs_refresh"], "needs_refresh"),
        (["confirmed", "needs_refresh"], "needs_refresh"),
        (["reviewing", "needs_refresh", "new"], "needs_refresh"),
    ],
)
def test_rule7_section_status_rolls_up_its_passage_statuses(statuses: list[str], expected: str):
    assert section_status(statuses) == expected


def test_rule7_sections_are_listed_in_ascending_ordinal_order() -> None:
    late = passage("late", section=7, words=(10,))
    early = passage("early", section=2, words=(10,))
    assert [s.ordinal for s in summarize_plan_progress([late, early], {}).sections] == [2, 7]


# --- rule 8: a scope change leaves the evidence in history ---------------------------------------


def hadith_section():
    matn = passage("h1-matn", section=1, path="matn", ordinal=1, words=(20, 20))
    sanad = passage("h1-sanad", section=1, path="sanad", ordinal=2, words=(10, 10))
    return matn, sanad


def test_rule8_a_deselected_path_leaves_the_denominator_and_the_numerator() -> None:
    matn, sanad = hadith_section()
    rows = {
        matn.id: mastery(matn, "confirmed", due=OCT_19),
        sanad.id: mastery(sanad, "confirmed", due=OCT_19),
    }
    both = summarize_plan_progress([matn, sanad], rows)
    assert (both.confirmed_words, both.total_words, both.overall_percent) == (60, 60, 100)
    only_matn = summarize_plan_progress([matn], rows)
    assert (only_matn.confirmed_words, only_matn.total_words) == (40, 40)
    assert only_matn.counts == PassageCounts(confirmed=1)


def test_rule8_the_evidence_of_a_deselected_path_stays_and_reselecting_restores_it() -> None:
    matn, sanad = hadith_section()
    rows = {
        matn.id: mastery(matn, "new"),
        sanad.id: mastery(sanad, "confirmed", due=OCT_19),
    }
    kept = dict(rows)
    before = summarize_plan_progress([matn, sanad], rows)
    during = summarize_plan_progress([matn], rows)
    after = summarize_plan_progress([matn, sanad], rows)
    assert rows == kept  # nothing was deleted or changed while the path was out of scope
    assert (before.confirmed_words, before.total_words) == (20, 60)
    assert (during.confirmed_words, during.total_words) == (0, 40)
    assert after == before  # reselecting restores the progress


def test_rule8_a_deselected_path_no_longer_shows_in_the_next_review_date() -> None:
    matn, sanad = hadith_section()
    rows = {
        matn.id: mastery(matn, "reviewing", due=OCT_19),
        sanad.id: mastery(sanad, "reviewing", due=OCT_6),
    }
    assert summarize_plan_progress([matn, sanad], rows).next_review_date == OCT_6
    assert summarize_plan_progress([matn], rows).next_review_date == OCT_19


def test_rule8_a_section_whose_passages_are_all_on_deselected_paths_is_not_counted() -> None:
    matn, _ = hadith_section()
    only_sanad = passage("h2-sanad", section=2, path="sanad", words=(10,))
    with_it = summarize_plan_progress([matn, only_sanad], {})
    without_it = summarize_plan_progress([matn], {})
    assert (with_it.total_sections, without_it.total_sections) == (2, 1)
    assert [s.ordinal for s in without_it.sections] == [1]


# --- the next new passage and the coverage counts ------------------------------------------------


def test_the_next_new_passage_is_the_first_one_in_plan_order() -> None:
    passages, rows = api_spec_plan()
    rows.pop(passages[2].id)  # C no longer being learned: D and C are new
    chosen = next_new_passage(passages, rows, set(), "book")
    assert chosen is not None and chosen.id == passages[2].id


def test_the_next_new_passage_prefers_a_passage_still_being_learned_to_a_new_one() -> None:
    passages, rows = api_spec_plan()
    rows[passages[3].id] = mastery(passages[3], "learning")  # D is being learned, C too
    chosen = next_new_passage(passages, rows, set(), "book")
    assert chosen is not None and chosen.id == passages[2].id
    del rows[passages[2].id]  # only D is being learned; C is new but comes first in plan order
    chosen = next_new_passage(passages, rows, set(), "book")
    assert chosen is not None and chosen.id == passages[3].id


def test_the_next_new_passage_follows_the_plan_order_reverse_starts_at_the_last_section() -> None:
    passages, _ = api_spec_plan()
    chosen = next_new_passage(passages, {}, set(), "reverse")
    assert chosen is not None and chosen.section_ordinal == 2 and chosen.ordinal == 1


def test_the_next_new_passage_skips_passages_known_from_the_placement_test() -> None:
    passages, _ = api_spec_plan()
    chosen = next_new_passage(passages, {}, {passages[0].id}, "book")
    assert chosen is not None and chosen.id == passages[1].id


def test_there_is_no_next_new_passage_when_every_passage_is_past_learning() -> None:
    passages, _ = api_spec_plan()
    rows = {p.id: mastery(p, "reviewing", due=OCT_6) for p in passages}
    assert next_new_passage(passages, rows, set(), "book") is None
    assert next_new_passage([], {}, set(), "book") is None


def test_coverage_counts_report_covered_and_total_parts() -> None:
    parts = [uid("part", n) for n in range(5)]
    assert coverage_counts(parts, set()) == (0, 5)
    assert coverage_counts(parts, {parts[0], parts[3], uid("another passage")}) == (2, 5)
    assert coverage_counts(parts, set(parts)) == (5, 5)
    assert coverage_counts((), set()) == (0, 0)
