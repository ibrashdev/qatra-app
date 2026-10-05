"""Coordinator decisions of checkpoint 2 on the mastery rules (pure, no I/O): a part leaves the
error parts on a correct answer (decision 6) and a stale replayed round has no effect (decision 5).
Decision 3 (stage 3 with an uncovered part is due the next learning day) is tested next to rule 4
in ``test_mastery_rounds.py``."""

from __future__ import annotations

import random

import pytest

from app.domain.mastery_policy import RoundResult, apply_round
from tests.mastery.mastery_support import Learner, at, day, right, wrong

# --- decision 6: a part leaves error_part_ids on a correct, unassisted answer --------------------


def test_decision6_a_correct_unassisted_answer_takes_the_tested_parts_out_of_the_error_parts() -> (
    None
):
    learner = Learner(parts=4)
    learner.answer(wrong(), 1, 2)
    assert learner.state.error_part_ids == (learner.part(1), learner.part(2))
    learner.answer(right(), 1, 2)
    assert learner.state.error_part_ids == ()


def test_decision6_only_the_tested_parts_leave_the_error_parts() -> None:
    learner = Learner(parts=4)
    learner.answer(wrong(), 1, 2, 3)
    learner.answer(right(), 2)
    assert learner.state.error_part_ids == (learner.part(1), learner.part(3))


@pytest.mark.parametrize(
    "attempt",
    [wrong(), right(assisted=True), wrong(assisted=True)],
    ids=["incorrect", "assisted correct", "assisted incorrect"],
)
def test_decision6_an_answer_that_is_not_correct_and_unassisted_clears_nothing(attempt) -> None:
    learner = Learner(parts=3)
    learner.answer(wrong(), 1)
    before = learner.state.error_part_ids
    learner.answer(attempt, 1)
    assert set(before) <= set(learner.state.error_part_ids)


def test_decision6_a_cleared_part_can_become_an_error_part_again() -> None:
    learner = Learner(parts=3)
    learner.answer(wrong(), 2)
    learner.answer(right(), 2)
    assert learner.state.error_part_ids == ()
    learner.answer(wrong(), 2)
    assert learner.state.error_part_ids == (learner.part(2),)


def test_decision6_a_clean_review_round_clears_the_error_parts_of_its_questions() -> None:
    learner = Learner(parts=4)
    learner.reach_initial_evidence()
    learner.answer(wrong(), 3, on=0)
    learner.answer(wrong(), 4, on=0)
    learner.clean_round(on=1)  # questions on parts 1 and 2: parts 3 and 4 stay errors
    assert learner.state.error_part_ids == (learner.part(3), learner.part(4))
    learner.review((right(), (3,)), (right(), (4,)), on=3)
    assert learner.state.error_part_ids == ()


def test_decision6_a_failed_round_adds_its_failing_parts_after_a_correct_answer_cleared_them() -> (
    None
):
    """Question 1 is wrong on part 1 and question 2 is right on part 1: the right answer clears the
    part, then the failed round puts it back, because question 1 failed the round."""
    learner = Learner(parts=3)
    learner.reach_initial_evidence()
    learner.review((wrong(), (1,)), (right(), (1,)), on=1)
    assert learner.state.error_part_ids == (learner.part(1),)


def test_decision6_the_parts_of_a_clean_question_of_a_failed_round_stay_cleared() -> None:
    learner = Learner(parts=3)
    learner.reach_initial_evidence()
    learner.answer(wrong(), 1, on=0)
    learner.review((right(), (1,)), (wrong(), (2,)), on=1)  # part 1 recalled, part 2 failed
    assert learner.state.error_part_ids == (learner.part(2),)


def test_decision6_a_hinted_question_in_a_round_marks_its_parts_when_the_round_fails() -> None:
    learner = Learner(parts=3)
    learner.reach_initial_evidence()
    learner.review((right(assisted=True), (3,)), (right(), (1,)), on=1)
    assert learner.state.error_part_ids == (learner.part(3),)


@pytest.mark.parametrize("seed", range(30))
def test_decision6_error_parts_follow_the_last_graded_answer_of_each_part(seed: int) -> None:
    """Seeded property: after any correct, unassisted answer its parts are not error parts; after
    an unassisted wrong answer they are; an assisted answer changes nothing."""
    rng = random.Random(seed)
    learner = Learner(parts=5, name=f"d6-{seed}")
    for _ in range(80):
        parts = tuple(sorted(rng.sample(range(1, 6), rng.choice([1, 1, 2]))))
        kind = rng.choice(["right", "wrong", "assisted"])
        before = learner.state.error_part_ids
        ids = {learner.part(n) for n in parts}
        if kind == "right":
            learner.answer(right(), *parts)
            assert ids.isdisjoint(learner.state.error_part_ids)
        elif kind == "wrong":
            learner.answer(wrong(), *parts)
            assert ids <= set(learner.state.error_part_ids)
        else:
            learner.answer(rng.choice([right(assisted=True), wrong(assisted=True)]), *parts)
            assert learner.state.error_part_ids == before
        assert len(set(learner.state.error_part_ids)) == len(learner.state.error_part_ids)
        assert set(learner.state.error_part_ids) <= set(learner.parts)


# --- decision 5: a stale replayed round has no effect --------------------------------------------


def apply(learner: Learner, passed: bool, on: int) -> None:
    result = RoundResult(passed, () if passed else (learner.part(1),))
    learner.state = apply_round(
        learner.state,
        result,
        passage_part_ids=learner.parts,
        covered_part_ids=learner.covered,
        review_date=day(on),
        now=at(on),
    )


@pytest.mark.parametrize("passed", [True, False])
def test_decision5_a_round_older_than_the_last_round_has_no_effect(passed: bool) -> None:
    learner = Learner()
    learner.on_the_ladder(stage=2)  # the round of day 1 moved it; the last round is day 1
    learner.clean_round(on=3)  # the last round is now day 3, stage 3 due on day 7
    after_day_3 = learner.state
    apply(learner, passed, on=2)  # a replay of an older round
    assert learner.state == after_day_3


def test_decision5_a_replayed_older_failure_does_not_reset_a_passage_that_moved_on() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.clean_round(on=1)
    learner.clean_round(on=3)
    moved_on = learner.state
    apply(learner, False, on=1)
    assert learner.state == moved_on
    assert learner.state.lapse_count == 0


def test_decision5_a_round_on_the_date_of_the_last_round_is_not_stale() -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.clean_round(on=1)
    apply(learner, False, on=1)  # a failure of the same date still applies (rule 3)
    assert learner.state.review_stage == 1
    assert learner.state.lapse_count == 1


def test_decision5_a_pass_before_the_due_date_still_advances_one_stage() -> None:
    """The coordinator does not require ``due <= review date``: only the other guards apply."""
    learner = Learner()
    learner.reach_initial_evidence()
    learner.clean_round(on=1)  # stage 2, due on day 3
    learner.clean_round(on=2)  # a day early
    assert learner.state.review_stage == 3
    assert learner.state.next_review_due == day(6)


@pytest.mark.parametrize("seed", range(30))
def test_decision5_the_last_review_date_never_moves_backwards_whatever_the_replay_order(
    seed: int,
) -> None:
    rng = random.Random(7000 + seed)
    learner = Learner(parts=3, name=f"d5-{seed}")
    learner.reach_initial_evidence()
    last = None
    for _ in range(40):
        on = rng.randint(1, 30)  # any order, repeats included
        apply(learner, rng.random() < 0.7, on=on)
        assert learner.state.violations() == ()
        current = learner.state.last_review_date
        if last is not None and current is not None:
            assert current >= last
        last = current or last
        if learner.state.last_review_date is not None:
            assert learner.state.next_review_due is not None
            assert learner.state.next_review_due > learner.state.last_review_date
