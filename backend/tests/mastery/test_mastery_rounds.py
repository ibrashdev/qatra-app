"""Contract §4, rules 3 to 6: review rounds, confirmation, maintenance and overdue reviews
(pure, no I/O). Round size, part choice and type rotation are session preparation (B5) and are
reused, so their tests here prove the rule through that code."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.domain.learning_state import PassageMastery
from app.domain.mastery_policy import (
    RoundAnswer,
    RoundResult,
    apply_round,
    count_due,
    days_overdue,
    evaluate_confirmation,
    is_fully_covered,
    round_is_complete,
    summarize_round,
)
from app.domain.session_policy import rank_parts, review_game_type, review_round_size
from tests.mastery.mastery_support import D0, Learner, at, day, right, wrong
from tests.sessions.ss_policy_support import (
    PLAN,
    TODAY,
    compose,
    describe,
    full_bank,
    loader,
    mastery,
    part_id,
    passage,
    questions_of,
    uid,
)
from tests.sessions.ss_policy_support import (
    at as past,
)

LADDER = ("review_stage", "next_review_due", "last_review_date", "lapse_count", "status")


def ladder_of(state: PassageMastery) -> tuple[object, ...]:
    return tuple(getattr(state, name) for name in LADDER)


# --- rule 3: round size, parts, types (reused from session preparation) --------------------------


@pytest.mark.parametrize(
    ("parts", "size"),
    [(1, 1), (2, 1), (3, 2), (4, 2), (5, 2), (6, 3), (7, 3), (9, 3), (12, 3)],
)
def test_rule3_a_round_has_one_two_or_three_questions_by_part_count(parts: int, size: int) -> None:
    assert review_round_size(parts) == size


def test_rule3_round_parts_are_uncovered_first_then_error_parts_then_least_recently_tested() -> (
    None
):
    p = passage("p", words=(4,) * 5)  # five parts: a round of two questions
    ids = [part_id(p, n) for n in range(1, 6)]
    banks = {p.id: full_bank(p)}
    rows = {p.id: mastery(p, "reviewing", due=TODAY, errors=(2, 4))}
    result = compose(
        [p],
        banks,
        minutes=5,
        rows=rows,
        covered=[ids[0], ids[1]],
        load=loader(banks, last_tested={ids[2]: past(3), ids[4]: past(9)}),
    )
    index = {q.id: q for q in banks[p.id]}
    taken = [index[q.question_id].covered_part_ids[0] for q in questions_of(result, "review")]
    # uncovered: parts 3, 4, 5. Part 4 is an error part so it leads; of the rest the older test
    # (part 3, September 3) comes before the newer one (part 5, September 9).
    assert taken == [ids[3], ids[2]]


def test_rule3_ranking_puts_never_tested_parts_before_older_before_newer_tests() -> None:
    p = passage("p", words=(4,) * 3)
    ids = [part_id(p, n) for n in range(1, 4)]
    ranked = rank_parts(p.parts, set(), set(), {ids[0]: past(3), ids[1]: past(1)})
    assert [part.id for part in ranked] == [ids[2], ids[1], ids[0]]


def test_rule3_question_types_rotate_across_reviews() -> None:
    p = passage("p", words=(4,) * 6)  # a round of three questions
    banks = {p.id: full_bank(p)}
    index = {q.id: q for q in banks[p.id]}
    rows = {p.id: mastery(p, "reviewing", due=TODAY)}
    first_part = part_id(p, 1)
    for seed in range(8):
        round_types = [
            index[q.question_id].type
            for q in questions_of(compose([p], banks, minutes=5, rows=rows, seed=seed), "review")
        ]
        # D90: a day's reviews prefer one game type, which changes with the seed (so it rotates
        # across days); the bank has no similar_distinction question, so the usual rotation then
        # gives a round three different templates.
        day_type = review_game_type(seed)
        if day_type == "similar_distinction":
            assert len(set(round_types)) == 3
        else:
            assert set(round_types) == {day_type}
        for last in ("word_choice", "word_recall", "word_order"):
            result = compose(
                [p],
                banks,
                minutes=5,
                rows=rows,
                seed=seed,
                load=loader(banks, last_type={first_part: last}),
            )
            asked = next(
                index[q.question_id]
                for q in questions_of(result, "review")
                if index[q.question_id].covered_part_ids == (first_part,)
            )
            assert asked.type != last  # the next review changes the template


# --- rule 3: the round verdict -------------------------------------------------------------------


def answer(n: int, *, correct: bool = True, assisted: bool = False, parts=(1,)) -> RoundAnswer:
    return RoundAnswer(uid("q", n), correct, assisted, tuple(uid("part", p) for p in parts))


def test_rule3_a_round_passes_only_when_every_question_is_correct_unassisted_and_first_attempt():
    assert summarize_round([answer(1), answer(2), answer(3)]) == RoundResult(True, ())


@pytest.mark.parametrize(
    "bad",
    [
        {"correct": False},
        {"assisted": True},
        {"correct": False, "assisted": True},
    ],
    ids=["an error", "a hint", "an error with a hint"],
)
def test_rule3_one_error_or_one_hint_fails_the_whole_round(bad: dict) -> None:
    result = summarize_round([answer(1), answer(2, **bad), answer(3)])
    assert not result.passed


def test_rule3_failing_parts_are_the_parts_of_the_wrong_and_of_the_assisted_questions_only() -> (
    None
):
    result = summarize_round(
        [
            answer(1, parts=(1,)),
            answer(2, correct=False, parts=(2,)),
            answer(3, assisted=True, parts=(3, 1)),
        ]
    )
    assert result.failing_part_ids == (uid("part", 2), uid("part", 3), uid("part", 1))


def test_rule3_a_round_without_answers_is_not_a_round() -> None:
    with pytest.raises(ValueError):
        summarize_round([])


def test_rule3_a_round_is_evaluated_only_when_every_question_has_its_first_attempt() -> None:
    ids = [uid("q1"), uid("q2"), uid("q3")]
    assert not round_is_complete(ids, set())
    assert not round_is_complete(ids, {ids[0], ids[1]})
    assert round_is_complete(ids, {ids[2], ids[0], ids[1], uid("another round")})
    assert not round_is_complete([], {ids[0]})


def test_rule3_an_unfinished_round_leaves_the_passage_due_and_unchanged() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    before = ladder_of(learner.state)
    learner.answer(right(), 1, on=1)  # one of two questions answered; the round is not evaluated
    assert not round_is_complete([uid("q1"), uid("q2")], {uid("q1")})
    assert ladder_of(learner.state) == before
    assert learner.state.is_due(day(1))


# --- rule 3: the ladder --------------------------------------------------------------------------


def test_rule3_on_time_reviews_fall_on_days_1_3_and_7() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    assert learner.state.next_review_due == day(1)
    learner.clean_round(on=1)
    assert (learner.state.review_stage, learner.state.next_review_due) == (2, day(3))
    learner.clean_round(on=3)
    assert (learner.state.review_stage, learner.state.next_review_due) == (3, day(7))
    learner.clean_round(on=7)
    assert learner.state.status == "confirmed"


@pytest.mark.parametrize("late", [0, 1, 3, 10, 40])
def test_rule3_intervals_are_1_2_4_days_counted_from_the_actual_review_date(late: int) -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    first = 1 + late
    learner.clean_round(on=first)
    assert learner.state.review_stage == 2
    assert learner.state.next_review_due == day(first + 2)
    second = first + 2 + late
    learner.clean_round(on=second)
    assert learner.state.review_stage == 3
    assert learner.state.next_review_due == day(second + 4)
    assert learner.state.last_review_date == day(second)


def test_rule3_a_pass_advances_exactly_one_stage() -> None:
    learner = Learner()
    learner.on_the_ladder(stage=1)
    learner.clean_round(on=1)
    assert learner.state.review_stage == 2  # not 3, however the round went


def test_rule3_at_most_one_stage_per_learning_date() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.clean_round(on=1)
    once = ladder_of(learner.state)
    learner.clean_round(on=1)  # a second round of the same date (another session)
    learner.clean_round(on=1)
    assert ladder_of(learner.state) == once


def test_rule3_a_round_on_the_date_of_the_initial_evidence_does_not_move_the_ladder() -> None:
    learner = Learner()
    learner.reach_initial_evidence(on=0)
    before = ladder_of(learner.state)
    learner.clean_round(on=0)
    assert ladder_of(learner.state) == before


def test_rule3_a_failed_round_blocks_a_pass_of_the_same_date() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.failed_round(on=1)
    failed = ladder_of(learner.state)
    learner.clean_round(on=1)
    assert ladder_of(learner.state) == failed


def test_rule3_a_failure_after_a_pass_of_the_same_date_still_resets_the_ladder() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.clean_round(on=1)
    assert learner.state.review_stage == 2
    learner.failed_round(on=1)
    assert learner.state.review_stage == 1
    assert learner.state.next_review_due == day(2)
    assert learner.state.lapse_count == 1


def test_rule3_a_failed_round_resets_to_stage_one_due_next_day_with_one_more_lapse() -> None:
    learner = Learner()
    learner.on_the_ladder(stage=3)  # stage 3 due on day 7
    learner.failed_round(on=7)
    state = learner.state
    assert state.status == "reviewing"
    assert state.review_stage == 1
    assert state.next_review_due == day(8)
    assert state.lapse_count == 1
    assert state.last_review_date == day(7)


def test_rule3_the_day_after_a_late_failure_is_counted_from_the_review_date() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.failed_round(on=9)  # eight days late
    assert learner.state.next_review_due == day(10)


def test_rule3_a_failed_round_keeps_coverage_and_the_initial_evidence() -> None:
    learner = Learner()
    learner.on_the_ladder(stage=2)
    initial = (learner.state.initial_success_at, learner.state.initial_learning_date)
    covered = set(learner.covered)
    learner.failed_round(on=3)
    assert learner.covered == covered
    assert (learner.state.initial_success_at, learner.state.initial_learning_date) == initial


def test_rule3_failing_parts_join_the_error_parts() -> None:
    learner = Learner(parts=4)
    learner.reach_initial_evidence()
    learner.review((right(), (1,)), (wrong(), (3,)), on=1)
    assert learner.state.error_part_ids == (learner.part(3),)
    learner.review((right(assisted=True), (2,)), (right(), (4,)), on=2)
    assert learner.state.error_part_ids == (learner.part(3), learner.part(2))


def test_rule3_a_hint_fails_the_round_even_when_the_answer_was_right() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.review((right(assisted=True), (1,)), (right(), (2,)), on=1)
    assert learner.state.review_stage == 1
    assert learner.state.next_review_due == day(2)
    assert learner.state.lapse_count == 1


@pytest.mark.parametrize("status", ["new", "learning"])
def test_rule3_a_passage_that_is_not_on_the_ladder_is_not_moved_by_a_round(status: str) -> None:
    state = PassageMastery(plan_id=PLAN, passage_id=uid("p"), status=status)
    for passed in (True, False):
        moved = apply_round(
            state,
            RoundResult(passed, () if passed else (uid("part"),)),
            passage_part_ids={uid("part")},
            covered_part_ids=set(),
            review_date=D0,
            now=at(0),
        )
        assert moved == state


# --- rule 4: confirmation ------------------------------------------------------------------------


def test_rule4_stage_three_passed_with_every_part_covered_confirms() -> None:
    learner = Learner()
    learner.on_the_ladder(stage=3)
    learner.clean_round(on=7)
    state = learner.state
    assert state.status == "confirmed"
    assert state.confirmed_at == at(7)
    assert state.first_confirmed_at == at(7)
    assert state.maintenance_stage == 1
    assert state.next_review_due == day(21)  # maintenance after 14 days
    assert state.review_stage == 3


def test_rule4_stages_one_and_two_never_confirm_even_with_full_coverage() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    assert is_fully_covered(learner.parts, learner.covered)
    learner.clean_round(on=1)
    assert learner.state.status == "reviewing"
    learner.clean_round(on=3)
    assert learner.state.status == "reviewing"


def six_parts_at_stage_three_with_three_uncovered() -> Learner:
    """Initial evidence with parts 1 to 3 covered, then three clean rounds on days 1, 3 and 7."""
    learner = Learner(parts=6)
    learner.reach_initial_evidence(cover=False)
    for on in (1, 3, 7):
        learner.review((right(), (1,)), (right(), (2,)), (right(), (3,)), on=on)
    return learner


def test_rule4_stage_three_passed_with_a_part_uncovered_does_not_confirm() -> None:
    learner = six_parts_at_stage_three_with_three_uncovered()
    state = learner.state
    assert learner.part(4) not in learner.covered
    assert state.status == "reviewing"
    assert state.confirmed_at is None
    assert state.first_confirmed_at is None
    assert state.review_stage == 3


def test_rule4_stage_three_with_a_part_uncovered_stays_at_stage_three_without_a_lapse() -> None:
    state = six_parts_at_stage_three_with_three_uncovered().state
    assert state.review_stage == 3
    assert state.lapse_count == 0
    assert state.last_review_date == day(7)


def test_rule4_stage_three_with_a_part_uncovered_is_due_again_the_next_learning_day() -> None:
    """Decision of the coordinator: retention is shown, coverage is the only missing condition."""
    state = six_parts_at_stage_three_with_three_uncovered().state
    assert state.next_review_due == day(8)


def test_rule4_a_later_stage_three_round_that_completes_coverage_confirms() -> None:
    learner = six_parts_at_stage_three_with_three_uncovered()
    assert learner.state.status == "reviewing"
    learner.review((right(), (4,)), (right(), (5,)), (right(), (6,)), on=8)
    assert learner.state.status == "confirmed"
    assert learner.state.confirmed_at == at(8)
    assert learner.state.first_confirmed_at == at(8)
    assert learner.state.next_review_due == day(22)  # maintenance after 14 days


def test_rule4_a_game_that_completes_coverage_is_picked_up_by_the_next_stage_three_round() -> None:
    learner = six_parts_at_stage_three_with_three_uncovered()
    for number in (4, 5, 6):
        learner.answer(right(), number, on=7)  # games on the same day cover the missing parts
    assert learner.state.status == "reviewing"  # coverage alone does not confirm
    learner.review((right(), (1,)), (right(), (2,)), (right(), (3,)), on=8)
    assert learner.state.status == "confirmed"


def test_rule4_a_failed_round_after_the_gap_resets_the_ladder_as_usual() -> None:
    learner = six_parts_at_stage_three_with_three_uncovered()
    learner.review((wrong(), (4,)), (right(), (5,)), (right(), (6,)), on=8)
    assert learner.state.review_stage == 1
    assert learner.state.lapse_count == 1
    assert learner.state.next_review_due == day(9)


def test_rule4_evidence_from_the_rounds_own_answers_counts_toward_the_confirmation() -> None:
    learner = Learner(parts=4)
    learner.reach_initial_evidence(cover=False)  # parts 1 to 3; part 4 has no evidence
    learner.clean_round(on=1)
    learner.clean_round(on=3)
    learner.review((right(), (4,)), (right(), (1,)), on=7)  # the last part is covered in the round
    assert learner.state.status == "confirmed"


def test_rule4_a_failed_stage_three_round_does_not_confirm_even_when_it_completes_coverage() -> (
    None
):
    learner = Learner(parts=4)
    learner.reach_initial_evidence(cover=False)
    learner.clean_round(on=1)
    learner.clean_round(on=3)
    learner.review((right(), (4,)), (wrong(), (1,)), on=7)
    assert learner.state.status == "reviewing"
    assert learner.state.review_stage == 1


@pytest.mark.parametrize(
    ("stage", "covered", "confirmed"),
    [
        (3, 3, True),
        (3, 2, False),
        (3, 0, False),
        (2, 3, False),
        (1, 3, False),
        (0, 3, False),
        (4, 3, True),
    ],
)
def test_rule4_confirmation_needs_stage_three_passed_and_every_part_covered(
    stage: int, covered: int, confirmed: bool
) -> None:
    parts = [uid("part", n) for n in range(3)]
    assert (
        evaluate_confirmation(
            stage_passed=stage, passage_part_ids=parts, covered_part_ids=set(parts[:covered])
        )
        is confirmed
    )


def test_rule4_a_passage_without_parts_is_never_fully_covered() -> None:
    assert not is_fully_covered((), set())
    assert not evaluate_confirmation(stage_passed=3, passage_part_ids=(), covered_part_ids=set())


# --- rule 5: maintenance and needs_refresh -------------------------------------------------------


def test_rule5_maintenance_rounds_come_after_14_then_30_then_every_60_days() -> None:
    learner = Learner()
    confirmed_on = learner.confirmed()
    assert learner.state.next_review_due == day(confirmed_on + 14)
    when = confirmed_on + 14
    for stage, interval in ((2, 30), (3, 60), (4, 60), (5, 60)):
        learner.clean_round(on=when)
        assert learner.state.status == "confirmed"
        assert learner.state.maintenance_stage == stage
        assert learner.state.next_review_due == day(when + interval)
        when += interval


def test_rule5_a_late_maintenance_pass_counts_the_next_interval_from_the_actual_review_date() -> (
    None
):
    learner = Learner()
    confirmed_on = learner.confirmed()
    late = confirmed_on + 14 + 20
    learner.clean_round(on=late)
    assert learner.state.next_review_due == day(late + 30)
    assert learner.state.confirmed_at == at(
        confirmed_on
    )  # a maintenance pass is not a new confirmation


def test_rule5_maintenance_moves_at_most_once_per_learning_date() -> None:
    learner = Learner()
    confirmed_on = learner.confirmed()
    when = confirmed_on + 14
    learner.clean_round(on=when)
    once = ladder_of(learner.state)
    learner.clean_round(on=when)
    assert ladder_of(learner.state) == once


def test_rule5_a_failed_maintenance_round_gives_needs_refresh_and_keeps_the_first_confirmation():
    learner = Learner()
    confirmed_on = learner.confirmed()
    first = learner.state.first_confirmed_at
    learner.failed_round(on=confirmed_on + 14)
    state = learner.state
    assert state.status == "needs_refresh"
    assert state.confirmed_at is None
    assert state.first_confirmed_at == first
    assert state.maintenance_stage == 0


def test_rule5_the_ladder_starts_again_at_stage_one_due_the_next_learning_day() -> None:
    learner = Learner()
    confirmed_on = learner.confirmed()
    due = confirmed_on + 14
    learner.failed_round(on=due)
    state = learner.state
    assert state.review_stage == 1
    assert state.next_review_due == day(due + 1)
    assert state.lapse_count == 1
    assert state.last_review_date == day(due)


def test_rule5_coverage_and_the_initial_evidence_survive_a_failed_maintenance_round() -> None:
    learner = Learner()
    confirmed_on = learner.confirmed()
    covered = set(learner.covered)
    initial = learner.state.initial_success_at
    learner.failed_round(on=confirmed_on + 14)
    assert learner.covered == covered
    assert learner.state.initial_success_at == initial
    assert is_fully_covered(learner.parts, learner.covered)


def test_rule5_a_passage_in_needs_refresh_is_confirmed_again_after_stages_one_to_three() -> None:
    learner = Learner()
    confirmed_on = learner.confirmed()
    first = learner.state.first_confirmed_at
    start = confirmed_on + 14
    learner.failed_round(on=start)  # needs_refresh, stage 1 due the next day
    learner.clean_round(on=start + 1)
    assert (learner.state.status, learner.state.review_stage) == ("needs_refresh", 2)
    learner.clean_round(on=start + 3)
    assert (learner.state.status, learner.state.review_stage) == ("needs_refresh", 3)
    learner.clean_round(on=start + 7)
    state = learner.state
    assert state.status == "confirmed"
    assert state.confirmed_at == at(start + 7)
    assert state.first_confirmed_at == first
    assert state.maintenance_stage == 1
    assert state.next_review_due == day(start + 7 + 14)


def test_rule5_a_failure_during_needs_refresh_restarts_the_ladder() -> None:
    learner = Learner()
    confirmed_on = learner.confirmed()
    start = confirmed_on + 14
    learner.failed_round(on=start)
    learner.clean_round(on=start + 1)
    learner.failed_round(on=start + 3)
    state = learner.state
    assert (state.status, state.review_stage) == ("needs_refresh", 1)
    assert state.next_review_due == day(start + 4)
    assert state.lapse_count == 2


def test_rule5_a_wrong_answer_outside_a_round_does_not_demote_a_confirmed_passage() -> None:
    learner = Learner()
    learner.confirmed()
    learner.answer(wrong(), 1, on=9)  # for example a game question
    assert learner.state.status == "confirmed"
    assert learner.state.consecutive_correct == 0


# --- rule 6: overdue reviews ---------------------------------------------------------------------


def test_rule6_an_overdue_review_stays_due_and_time_alone_changes_nothing() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    state = learner.state
    for on in (1, 2, 10, 400):
        assert state.is_due(day(on))
    assert days_overdue(state, day(1)) == 0
    assert days_overdue(state, day(10)) == 9
    assert days_overdue(state, day(400)) == 399
    assert state.to_payload() == learner.state.to_payload()  # lateness is stored nowhere


def test_rule6_a_late_pass_carries_no_penalty() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.clean_round(on=30)  # a month late
    assert learner.state.review_stage == 2
    assert learner.state.lapse_count == 0
    assert learner.state.status == "reviewing"
    assert learner.state.next_review_due == day(32)


def test_rule6_a_passage_not_yet_due_is_not_overdue() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    assert days_overdue(learner.state, day(0)) == 0
    assert not learner.state.is_due(day(0))
    new = PassageMastery(plan_id=PLAN, passage_id=uid("p"))
    assert days_overdue(new, day(100)) == 0


def test_rule6_the_due_count_is_made_of_every_passage_due_or_overdue() -> None:
    def due_on(offset: int) -> PassageMastery:
        return mastery(passage(f"x{offset}"), "reviewing", due=TODAY + timedelta(days=offset))

    rows = [due_on(-5), due_on(0), due_on(1), PassageMastery(plan_id=PLAN, passage_id=uid("n"))]
    assert count_due(rows, TODAY) == 2
    assert count_due(rows, TODAY + timedelta(days=1)) == 3


def test_rule6_overdue_rounds_are_taken_before_rounds_that_are_due_today() -> None:
    old = passage("old", section=2, words=(4, 4))
    fresh = passage("fresh", section=1, words=(4, 4))
    rows = {
        fresh.id: mastery(fresh, "reviewing", due=TODAY),
        old.id: mastery(old, "reviewing", due=TODAY - timedelta(days=6)),
    }
    reviews = [
        name for role, name in describe(compose([fresh, old], rows=rows)) if role == "review"
    ]
    assert reviews == ["old", "fresh"]
