"""Daily composition (contract §4.3, §5): synthetic passages and questions, no text."""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid5

import pytest

from app.domain.session_policy import (
    ABSENCE_THRESHOLD_DAYS,
    CAPACITY_WORDS,
    END_TEST_QUESTIONS,
    REVIEW_QUESTION_CAP,
    PlannedLearn,
    PlannedQuestion,
    absence_days,
    is_light_review_day,
    plan_order,
    rank_parts,
    review_round_size,
)
from tests.sessions.ss_policy_support import (
    NAMES,
    SEED,
    SESSION,
    TODAY,
    at,
    compose,
    describe,
    full_bank,
    loader,
    mastery,
    part_id,
    passage,
    question,
    questions_of,
    uid,
)

LATER = TODAY + timedelta(days=3)


def bank_index(banks):
    return {q.id: q for questions in banks.values() for q in questions}


# --- numbers of the contract ---------------------------------------------------------------------


def test_the_numbers_of_contract_section_5() -> None:
    assert CAPACITY_WORDS == {5: 12, 10: 25, 15: 40}
    assert REVIEW_QUESTION_CAP == {5: 6, 10: 10, 15: 14}
    assert END_TEST_QUESTIONS == {5: 3, 10: 5, 15: 7}
    assert ABSENCE_THRESHOLD_DAYS == 3


@pytest.mark.parametrize(
    ("parts", "size"),
    [(0, 1), (1, 1), (2, 1), (3, 2), (4, 2), (5, 2), (6, 3), (7, 3), (20, 3)],
)
def test_review_round_size_by_part_count(parts: int, size: int) -> None:
    assert review_round_size(parts) == size


# --- plan order ----------------------------------------------------------------------------------


def test_book_order_is_ascending_sections_with_mushaf_order_inside() -> None:
    a1 = passage("a1", section=1, start=(10, 0))
    a2 = passage("a2", section=1, start=(10, 40), ordinal=2)
    b1 = passage("b1", section=2, start=(20, 0))
    ordered = plan_order([b1, a2, a1], "book")
    assert [NAMES[p.id] for p in ordered] == ["a1", "a2", "b1"]


def test_reverse_order_descends_the_sections_but_keeps_mushaf_order_inside_one() -> None:
    a1 = passage("a1", section=1, start=(10, 0))
    a2 = passage("a2", section=1, start=(10, 40), ordinal=2)
    b1 = passage("b1", section=2, start=(20, 0))
    b2 = passage("b2", section=2, start=(20, 30), ordinal=2)
    c1 = passage("c1", section=3, start=(30, 0))
    ordered = plan_order([a2, c1, b2, a1, b1], "reverse")
    assert [NAMES[p.id] for p in ordered] == ["c1", "b1", "b2", "a1", "a2"]


def test_hadith_paths_inside_a_section_follow_the_text_and_none_is_dropped() -> None:
    sanad = passage("sanad", section=4, path="sanad", start=(40, 0))
    matn = passage("matn", section=4, path="matn", start=(40, 6))
    grade = passage("grade", section=4, path="grade", start=(42, 0))
    other = passage("other", section=3, path="matn", start=(30, 0))
    ordered = plan_order([grade, matn, other, sanad], "book")
    assert [NAMES[p.id] for p in ordered] == ["other", "sanad", "matn", "grade"]
    assert {p.id for p in ordered} == {grade.id, matn.id, other.id, sanad.id}


# --- absence (PRD R07) ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("days_ago", "absent", "light"),
    [(None, 0, False), (0, 0, False), (1, 0, False), (2, 1, False), (3, 2, False), (4, 3, True)],
)
def test_absence_counts_full_days_without_activity(
    days_ago: int | None, absent: int, light: bool
) -> None:
    last = None if days_ago is None else TODAY - timedelta(days=days_ago)
    assert absence_days(TODAY, last) == absent
    assert is_light_review_day(TODAY, last) is light


def test_a_last_active_date_in_the_future_is_no_absence() -> None:
    assert absence_days(TODAY, TODAY + timedelta(days=2)) == 0


# --- parts: uncovered first, then error parts, then least recently tested -------------------------


def test_rank_parts_puts_uncovered_first_then_error_parts_then_the_least_recent() -> None:
    p = passage("r", words=(4,) * 6)
    ids = [part_id(p, n) for n in range(1, 7)]
    covered = {ids[0], ids[1]}
    errors = {ids[1], ids[4]}
    tested = {ids[0]: at(10), ids[1]: at(20)}
    ranked = rank_parts(p.parts, covered, errors, tested)
    assert [part.ordinal for part in ranked] == [5, 3, 4, 6, 2, 1]


def test_rank_parts_orders_equally_covered_parts_by_least_recent_test_first() -> None:
    p = passage("r", words=(4, 4, 4))
    ids = [part_id(p, n) for n in range(1, 4)]
    ranked = rank_parts(p.parts, set(ids), set(), {ids[2]: at(1), ids[0]: at(5)})
    assert [part.ordinal for part in ranked] == [2, 3, 1]  # never tested, oldest, newest


# --- new material: capacity, plan order, learn + training + end test ----------------------------


@pytest.mark.parametrize(
    ("minutes", "introduced", "test_count"),
    [(5, ["a"], 3), (10, ["a", "b"], 5), (15, ["a", "b", "c"], 7)],
)
def test_new_passages_are_introduced_in_plan_order_up_to_capacity(
    minutes: int, introduced: list[str], test_count: int
) -> None:
    passages = [passage(name, section=n, words=(4, 4, 4)) for n, name in enumerate("abcd", 1)]
    result = compose(passages, minutes=minutes)
    expected: list[tuple[str, str]] = []
    for name in introduced:
        expected += [("learn", name)] + [("training", name)] * 3
    kinds = describe(result)
    assert kinds[: len(expected)] == expected  # learn, then one drill per part, passage by passage
    end_test = kinds[len(expected) :]
    assert len(end_test) == test_count
    assert {role for role, _ in end_test} == {"test"}  # then the end test of 3/5/7 questions
    assert {name for _, name in end_test} <= set(introduced)  # drawn from today's parts
    assert [NAMES[i] for i in result.new_passage_ids] == introduced
    assert not result.light_review and not result.maintenance_only
    assert not questions_of(result, "review")


def test_the_first_new_passage_is_taken_even_when_it_alone_exceeds_capacity() -> None:
    big = passage("big", section=1, words=(10, 10, 10, 10))
    small = passage("small", section=2, words=(4,))
    result = compose([big, small], minutes=5)  # capacity 12 < 40 words
    assert [NAMES[i] for i in result.new_passage_ids] == ["big"]
    assert describe(result)[0] == ("learn", "big")
    assert ("learn", "small") not in describe(result)


def test_a_passage_that_does_not_fit_ends_the_selection_and_later_ones_do_not_jump_ahead() -> None:
    first = passage("first", section=1, words=(15,))  # 15 of 25 words
    big = passage("big", section=2, words=(20,))  # 35 > 25: does not fit
    small = passage("small", section=3, words=(2,))  # would fit, but must not jump the queue
    result = compose([first, big, small], minutes=10)
    assert [NAMES[i] for i in result.new_passage_ids] == ["first"]


def test_training_has_one_question_per_part_with_rotating_templates() -> None:
    a = passage("a", words=(4, 4, 4))
    banks = {a.id: full_bank(a)}
    result = compose([a], banks, minutes=5)
    training = questions_of(result, "training")
    index = bank_index(banks)
    assert len(training) == 3
    assert [index[q.question_id].covered_part_ids for q in training] == [
        (part_id(a, 1),),
        (part_id(a, 2),),
        (part_id(a, 3),),
    ]
    assert len({index[q.question_id].type for q in training}) == 3  # templates rotate
    assert all(q.review_round_id is None for q in training)


@pytest.mark.parametrize(("part_count", "expected"), [(1, 3), (2, 3), (3, 3), (4, 4), (6, 6)])
def test_extra_questions_top_training_up_to_the_streak_target(
    part_count: int, expected: int
) -> None:
    p = passage("p", words=(4,) * part_count)
    result = compose([p], {p.id: full_bank(p, extra_choice=2)}, minutes=5)
    training = questions_of(result, "training")
    assert len(training) == expected
    assert len({q.question_id for q in training}) == expected  # extras are different questions


def test_extras_stop_when_the_bank_has_no_more_questions() -> None:
    p = passage("p", words=(12,))
    banks = {p.id: [question(p, "c0", "word_choice", (1,)), question(p, "r0", "word_recall", (1,))]}
    result = compose([p], banks, minutes=5)
    assert len(questions_of(result, "training")) == 2  # fewer than the target, no endless loop


def test_a_question_that_covers_several_parts_serves_them_all() -> None:
    p = passage("p", words=(4, 4, 4))
    merged = question(p, "o12", "word_order", (1, 2))
    third = question(p, "c3", "word_choice", (3,))
    result = compose([p], {p.id: [merged, third]}, minutes=5)
    assert [q.question_id for q in questions_of(result, "training")] == [merged.id, third.id]


def test_a_passage_without_questions_still_gets_its_learn_step() -> None:
    p = passage("p")
    result = compose([p], {}, minutes=5)
    assert describe(result) == [("learn", "p")]


def test_a_passage_still_being_learned_comes_before_new_ones() -> None:
    a = passage("a", section=1)
    b = passage("b", section=2)
    c = passage("c", section=3)
    rows = {b.id: mastery(b, "learning", consecutive_correct=1)}
    result = compose([a, b, c], rows=rows, minutes=10)
    assert [NAMES[i] for i in result.new_passage_ids] == ["b", "a"]  # 12 + 12 <= 25; c does not fit
    only = compose([a, b, c], rows=rows, minutes=5)
    assert [NAMES[i] for i in only.new_passage_ids] == ["b"]


def test_words_introduced_earlier_today_count_against_the_capacity() -> None:
    a = passage("a", section=1, words=(4, 4, 4))
    b = passage("b", section=2, words=(4, 4, 4))
    rows = {a.id: mastery(a, "reviewing", due=LATER, initial=TODAY)}
    result = compose([a, b], rows=rows, minutes=5)  # capacity 12 is used up by a
    assert result.new_passage_ids == ()
    assert not any(kind == "learn" for kind, _ in describe(result))
    yesterday = {a.id: mastery(a, "reviewing", due=LATER, initial=TODAY - timedelta(days=1))}
    fresh = compose([a, b], rows=yesterday, minutes=5)
    assert [NAMES[i] for i in fresh.new_passage_ids] == ["b"]


def test_reverse_order_introduces_the_last_section_first() -> None:
    passages = [passage(n, section=s, words=(4, 4, 4)) for s, n in enumerate("abc", 1)]
    result = compose(passages, order="reverse", minutes=15)
    assert [NAMES[i] for i in result.new_passage_ids] == ["c", "b", "a"]
    book = compose(passages, order="book", minutes=15)
    assert [NAMES[i] for i in book.new_passage_ids] == ["a", "b", "c"]


# --- due review rounds ---------------------------------------------------------------------------


def due_passages():
    x = passage("x", section=1, words=(4,) * 7)  # 7 parts: 3 questions
    y = passage("y", section=2, words=(4,) * 4)  # 4 parts: 2 questions
    z = passage("z", section=3, words=(4,) * 2)  # 2 parts: 1 question
    rows = {
        x.id: mastery(x, "reviewing", due=TODAY - timedelta(days=2)),
        y.id: mastery(y, "reviewing", due=TODAY - timedelta(days=4)),  # the most overdue
        z.id: mastery(z, "reviewing", due=TODAY - timedelta(days=2)),  # ties with x: plan order
    }
    return x, y, z, rows


def test_due_rounds_come_first_overdue_first_with_sizes_by_part_count() -> None:
    x, y, z, rows = due_passages()
    result = compose([x, y, z], rows=rows, minutes=5)
    reviews = [(role, name) for role, name in describe(result) if role == "review"]
    assert reviews == [("review", "y")] * 2 + [("review", "x")] * 3 + [("review", "z")]
    assert [s.role for s in result.steps[:6]] == ["review"] * 6  # before everything else
    assert not any(isinstance(s, PlannedLearn) for s in result.steps)  # all passages in progress


def test_each_round_has_one_round_id_derived_from_the_session_and_the_passage() -> None:
    x, y, z, rows = due_passages()
    result = compose([x, y, z], rows=rows, minutes=5)
    by_passage: dict[str, set] = {}
    for q in questions_of(result, "review"):
        by_passage.setdefault(NAMES[q.passage_id], set()).add(q.review_round_id)
    assert {name: len(ids) for name, ids in by_passage.items()} == {"x": 1, "y": 1, "z": 1}
    for name, ids in by_passage.items():
        assert ids == {uuid5(SESSION, f"round:{uid(name)}")}
    other = compose([x, y, z], rows=rows, minutes=5, session_id=uid("another session"))
    assert {q.review_round_id for q in questions_of(other, "review")}.isdisjoint(
        {q.review_round_id for q in questions_of(result, "review")}
    )


def test_a_round_is_never_split_and_the_first_one_that_does_not_fit_ends_the_step() -> None:
    sizes = [7, 4, 7, 2]  # round sizes 3, 2, 3, 1; the cap of 5 minutes is 6
    passages = [passage(f"p{n}", section=n, words=(4,) * parts) for n, parts in enumerate(sizes, 1)]
    rows = {
        p.id: mastery(p, "reviewing", due=TODAY - timedelta(days=10 - n))
        for n, p in enumerate(passages)
    }
    five = compose(passages, rows=rows, minutes=5)
    reviewed = [NAMES[q.passage_id] for q in questions_of(five, "review")]
    assert reviewed == ["p1"] * 3 + ["p2"] * 2  # 3 + 2 = 5; the next round (3) would make 8
    # p4's round of 1 would still fit (5 + 1 <= 6) but may not jump the queue:
    assert "p4" not in reviewed
    ten = compose(passages, rows=rows, minutes=10)  # cap 10: 3 + 2 + 3 = 8, then 1 -> 9
    assert [NAMES[q.passage_id] for q in questions_of(ten, "review")] == (
        ["p1"] * 3 + ["p2"] * 2 + ["p3"] * 3 + ["p4"]
    )


@pytest.mark.parametrize("status", ["reviewing", "confirmed", "needs_refresh"])
def test_every_ladder_status_with_a_due_date_gets_a_round(status: str) -> None:
    p = passage("p", words=(4, 4, 4))
    rows = {p.id: mastery(p, status, due=TODAY)}
    result = compose([p], rows=rows, minutes=5)
    assert len(questions_of(result, "review")) == 2


@pytest.mark.parametrize("status", ["new", "learning"])
def test_a_passage_without_a_ladder_status_has_no_round(status: str) -> None:
    p = passage("p", words=(4, 4, 4))
    rows = {p.id: mastery(p, status, due=TODAY - timedelta(days=1))}
    assert not questions_of(compose([p], rows=rows, minutes=5), "review")


def test_a_round_that_is_not_yet_due_is_left_alone() -> None:
    p = passage("p", words=(4, 4, 4))
    rows = {p.id: mastery(p, "reviewing", due=TODAY + timedelta(days=1))}
    assert not questions_of(compose([p], rows=rows, minutes=5), "review")


def test_round_parts_follow_uncovered_then_error_then_least_recent() -> None:
    p = passage("p", words=(4,) * 6)
    ids = [part_id(p, n) for n in range(1, 7)]
    banks = {p.id: full_bank(p)}
    rows = {p.id: mastery(p, "reviewing", due=TODAY, errors=(2, 5))}
    result = compose(
        [p],
        banks,
        minutes=5,
        rows=rows,
        covered=[ids[0], ids[1]],
        load=loader(banks, last_tested={ids[0]: at(10), ids[1]: at(20)}),
    )
    index = bank_index(banks)
    first_parts = [index[q.question_id].covered_part_ids[0] for q in questions_of(result, "review")]
    assert first_parts == [ids[4], ids[2], ids[3]]  # parts 5, 3, 4


def test_round_types_rotate_and_avoid_the_type_last_used_for_the_part() -> None:
    p = passage("p", words=(4,) * 6)
    banks = {p.id: full_bank(p)}
    index = bank_index(banks)
    rows = {p.id: mastery(p, "reviewing", due=TODAY)}
    for seed in range(12):
        result = compose([p], banks, minutes=5, rows=rows, seed=seed)
        types = [index[q.question_id].type for q in questions_of(result, "review")]
        assert len(types) == 3 and len(set(types)) == 3  # a round uses three different templates
    first_part = part_id(p, 1)
    for seed in range(12):
        for last in ("word_choice", "word_recall", "word_order"):
            result = compose(
                [p],
                banks,
                minutes=5,
                rows=rows,
                seed=seed,
                load=loader(banks, last_type={first_part: last}),
            )
            first = questions_of(result, "review")[0]
            assert index[first.question_id].covered_part_ids == (first_part,)
            assert index[first.question_id].type != last


def test_a_part_without_questions_is_skipped_and_the_round_still_fills_up() -> None:
    p = passage("p", words=(4, 4, 4))  # 3 parts: a round of 2
    banks = {p.id: [question(p, "c2", "word_choice", (2,)), question(p, "r3", "word_recall", (3,))]}
    rows = {p.id: mastery(p, "reviewing", due=TODAY)}
    result = compose([p], banks, minutes=5, rows=rows)
    assert [q.question_id for q in questions_of(result, "review")] == [
        uid(p.id, "q", "c2"),
        uid(p.id, "q", "r3"),
    ]


# --- known passages: an early quick drill instead of new learning ---------------------------------


def test_a_known_passage_gets_a_quick_drill_without_a_learn_step_or_capacity_use() -> None:
    known = passage("known", section=1, words=(4,) * 6)  # 24 words: a drill of 3 questions
    fresh = passage("fresh", section=2, words=(4, 4, 4))
    result = compose([known, fresh], minutes=5, known=[known.id])  # capacity 12 is for "fresh"
    kinds = describe(result)
    assert kinds[:3] == [("training", "known")] * 3
    assert ("learn", "known") not in kinds
    assert kinds[3] == ("learn", "fresh")
    assert result.quick_review_passage_ids == (known.id,)
    assert [NAMES[i] for i in result.new_passage_ids] == ["fresh"]
    assert all(q.review_round_id is None for q in questions_of(result, "training"))


def test_a_known_passage_keeps_getting_drills_while_it_is_still_being_learned() -> None:
    known = passage("known", words=(4, 4, 4))
    rows = {known.id: mastery(known, "learning", consecutive_correct=2)}
    result = compose([known], rows=rows, minutes=5, known=[known.id])
    assert result.quick_review_passage_ids == (known.id,)
    assert result.new_passage_ids == ()


def test_a_known_passage_on_the_ladder_is_handled_by_its_rounds_not_a_drill() -> None:
    known = passage("known", words=(4, 4, 4))
    rows = {known.id: mastery(known, "reviewing", due=TODAY)}
    result = compose([known], rows=rows, minutes=5, known=[known.id])
    assert result.quick_review_passage_ids == ()
    assert len(questions_of(result, "review")) == 2


def test_quick_drills_share_the_review_question_cap() -> None:
    due_a = passage("due_a", section=1, words=(4,) * 7)
    due_b = passage("due_b", section=2, words=(4,) * 7)
    known = passage("known", section=3, words=(4, 4, 4))
    rows = {
        due_a.id: mastery(due_a, "reviewing", due=TODAY),
        due_b.id: mastery(due_b, "reviewing", due=TODAY),
    }
    result = compose([due_a, due_b, known], rows=rows, minutes=5, known=[known.id])
    assert len(questions_of(result, "review")) == 6  # the whole cap of 5 minutes
    assert result.quick_review_passage_ids == ()  # no room left today


# --- end test ------------------------------------------------------------------------------------


def test_the_end_test_mixes_todays_parts_error_parts_and_uncovered_parts() -> None:
    today_passage = passage("today", section=3, words=(4, 4, 4))
    error_passage = passage("errors", section=1, words=(4,) * 4)
    gap_passage = passage("gaps", section=2, words=(4,) * 4)
    banks = {p.id: full_bank(p) for p in (today_passage, error_passage, gap_passage)}
    rows = {
        error_passage.id: mastery(error_passage, "reviewing", due=LATER, errors=(1, 3)),
        gap_passage.id: mastery(gap_passage, "reviewing", due=LATER),
    }
    covered = [part_id(error_passage, 1), part_id(error_passage, 2)]
    result = compose(
        [today_passage, error_passage, gap_passage], banks, minutes=15, rows=rows, covered=covered
    )
    index = bank_index(banks)
    tests = questions_of(result, "test")
    assert len(tests) == END_TEST_QUESTIONS[15] == 7
    today_parts = {part.id for part in today_passage.parts}
    error_parts = {part_id(error_passage, 1), part_id(error_passage, 3)}
    pools = []
    for q in tests:
        (part,) = index[q.question_id].covered_part_ids
        pools.append("today" if part in today_parts else "error" if part in error_parts else "gap")
    assert pools == ["today", "error", "gap", "today", "error", "gap", "today"]  # taken in turn
    assert len({q.question_id for q in tests}) == 7


def test_the_end_test_uses_each_part_once_before_a_part_repeats_with_another_question() -> None:
    solo = passage("solo", words=(12,))
    questions = [question(solo, f"c{n}", "word_choice", (1,), "word") for n in range(8)]
    result = compose([solo], {solo.id: questions}, minutes=10)  # end test of 5
    tests = questions_of(result, "test")
    assert len(tests) == 5  # 8 questions - 3 used by training
    assert len({q.question_id for q in tests}) == 5
    few = compose([solo], {solo.id: questions[:6]}, minutes=10)
    assert len(questions_of(few, "test")) == 3  # only 3 are left after training: fewer, no error


def test_the_end_test_runs_without_new_material_on_error_and_uncovered_parts() -> None:
    p = passage("p", section=1, words=(4,) * 4)
    rows = {p.id: mastery(p, "reviewing", due=LATER, errors=(2,))}
    result = compose([p], rows=rows, minutes=5)
    assert result.new_passage_ids == ()
    assert describe(result) == [("test", "p")] * 3


def test_no_question_appears_twice_in_one_session() -> None:
    passages = [passage(n, section=s, words=(4,) * 4) for s, n in enumerate("abcdef", 1)]
    rows = {
        passages[4].id: mastery(passages[4], "reviewing", due=TODAY, errors=(1,)),
        passages[5].id: mastery(passages[5], "reviewing", due=LATER, errors=(2, 3)),
    }
    result = compose(passages, rows=rows, minutes=15)
    ids = [s.question_id for s in result.steps if isinstance(s, PlannedQuestion)]
    assert len(ids) > 15 and len(ids) == len(set(ids))


# --- absence and completed plans ------------------------------------------------------------------


def test_three_days_of_absence_make_a_light_review_with_no_new_material() -> None:
    due = passage("due", section=1, words=(4, 4, 4))
    fresh = passage("fresh", section=2)
    known = passage("known", section=3)
    rows = {due.id: mastery(due, "reviewing", due=TODAY - timedelta(days=5), errors=(1,))}
    result = compose(
        [due, fresh, known],
        rows=rows,
        minutes=15,
        known=[known.id],
        last_active=TODAY - timedelta(days=4),  # three full days without activity
    )
    assert result.light_review and not result.maintenance_only
    assert describe(result) == [("review", "due")] * 2  # the due round only
    assert result.new_passage_ids == () and result.quick_review_passage_ids == ()


def test_fewer_than_three_days_of_absence_are_a_normal_session() -> None:
    fresh = passage("fresh", words=(4, 4, 4))
    result = compose([fresh], minutes=5, last_active=TODAY - timedelta(days=3))
    assert not result.light_review
    assert [NAMES[i] for i in result.new_passage_ids] == ["fresh"]


def test_a_light_review_keeps_the_due_rounds_that_do_not_fit_for_later() -> None:
    passages = [passage(f"p{n}", section=n, words=(4,) * 7) for n in range(1, 5)]
    rows = {
        p.id: mastery(p, "reviewing", due=TODAY - timedelta(days=9 - n))
        for n, p in enumerate(passages)
    }
    result = compose(passages, rows=rows, minutes=5, last_active=TODAY - timedelta(days=30))
    assert result.light_review
    assert [NAMES[q.passage_id] for q in questions_of(result, "review")] == ["p1"] * 3 + ["p2"] * 3
    assert len(result.steps) == 6  # p3 and p4 stay due for the following days


def test_a_completed_plan_serves_maintenance_reviews_only() -> None:
    done = [passage(n, section=s, words=(4, 4, 4)) for s, n in enumerate("abc", 1)]
    leftover = passage("leftover", section=4)  # never started: still no new material
    rows = {
        done[0].id: mastery(done[0], "confirmed", due=TODAY - timedelta(days=1)),
        done[1].id: mastery(done[1], "confirmed", due=LATER),
        done[2].id: mastery(done[2], "confirmed", due=TODAY),
    }
    result = compose([*done, leftover], rows=rows, minutes=15, status="completed")
    assert result.maintenance_only and not result.light_review
    assert describe(result) == [("review", "a")] * 2 + [("review", "c")] * 2
    assert result.new_passage_ids == () and result.quick_review_passage_ids == ()


def test_a_completed_plan_with_nothing_due_has_an_empty_session() -> None:
    p = passage("p")
    rows = {p.id: mastery(p, "confirmed", due=LATER)}
    calls: list = []
    result = compose([p], rows=rows, status="completed", load=loader({}, calls=calls))
    assert result.steps == () and result.maintenance_only
    assert calls == []  # nothing to load


# --- loading, determinism, validation -------------------------------------------------------------


def test_the_loader_is_called_once_with_every_passage_the_session_uses() -> None:
    due = passage("due", section=1, words=(4, 4, 4))
    fresh = passage("fresh", section=2, words=(4, 4, 4))
    gaps = passage("gaps", section=3, words=(4, 4, 4))
    rows = {
        due.id: mastery(due, "reviewing", due=TODAY),
        gaps.id: mastery(gaps, "reviewing", due=LATER),
    }
    calls: list = []
    banks = {p.id: full_bank(p) for p in (due, fresh, gaps)}
    compose([due, fresh, gaps], banks, rows=rows, minutes=10, load=loader(banks, calls=calls))
    assert len(calls) == 1
    assert set(calls[0]) == {due.id, fresh.id, gaps.id}
    assert len(calls[0]) == len(set(calls[0]))


def test_the_same_inputs_give_the_same_session_and_the_seed_varies_the_rotation() -> None:
    passages = [passage(n, section=s, words=(4,) * 5) for s, n in enumerate("abc", 1)]
    rows = {passages[0].id: mastery(passages[0], "reviewing", due=TODAY)}
    first = compose(passages, rows=rows, minutes=10)
    again = compose(passages, rows=rows, minutes=10)
    assert first == again
    variants = {compose(passages, rows=rows, minutes=10, seed=seed).steps for seed in range(10)}
    assert len(variants) > 1
    assert compose(passages, rows=rows, minutes=10, seed=SEED) == first


def test_the_end_test_pools_are_limited_to_twelve_passages() -> None:
    passages = [passage(f"p{n:02d}", section=n, words=(4, 4, 4)) for n in range(1, 21)]
    rows = {p.id: mastery(p, "reviewing", due=LATER) for p in passages}
    calls: list = []
    banks = {p.id: full_bank(p) for p in passages}
    compose(passages, banks, rows=rows, minutes=15, load=loader(banks, calls=calls))
    assert len(calls[0]) == 12


def test_session_minutes_must_be_5_10_or_15() -> None:
    with pytest.raises(ValueError):
        compose([passage("a")], minutes=7)
