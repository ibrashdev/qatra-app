"""Contract §4, rules 1 and 2: the validated attempt and the initial evidence (pure, no I/O)."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime

import pytest

from app.domain.learning_state import PassageMastery
from app.domain.mastery_policy import advance_target_streak, attempt_counts_for_mastery
from tests.mastery.mastery_support import D0, NOW, Learner, at, day, right, wrong
from tests.sessions.ss_policy_support import PLAN, passage, uid

# --- rule 1: the validated attempt -------------------------------------------------------------


def test_rule1_correct_unassisted_attempt_adds_one_to_the_streak() -> None:
    learner = Learner()
    assert learner.answer(right(), 1).state.consecutive_correct == 1
    assert learner.answer(right(), 2).state.consecutive_correct == 2


def test_rule1_correct_unassisted_attempt_gives_evidence_to_each_tested_part() -> None:
    learner = Learner(parts=4)
    effect = learner.answer(right(), 1, 3)
    assert effect.new_evidence_part_ids == (learner.part(1), learner.part(3))
    assert learner.covered == {learner.part(1), learner.part(3)}


def test_rule1_a_part_gains_evidence_once() -> None:
    learner = Learner(parts=4)
    learner.answer(right(), 1, 2)
    again = learner.answer(right(), 2, 3)
    assert again.new_evidence_part_ids == (learner.part(3),)
    assert learner.answer(right(), 1).new_evidence_part_ids == ()
    assert learner.covered == {learner.part(1), learner.part(2), learner.part(3)}


def test_rule1_a_part_listed_twice_in_one_question_gains_one_evidence() -> None:
    learner = Learner()
    effect = learner.answer(right(), 2, 2)
    assert effect.new_evidence_part_ids == (learner.part(2),)


def test_rule1_a_part_of_another_passage_never_gains_evidence() -> None:
    learner = Learner()
    stranger = passage("other", words=(4,)).parts[0].id
    effect = advance_target_streak(
        learner.state,
        right(),
        question_part_ids=[stranger, learner.part(1)],
        passage_part_ids=learner.parts,
        covered_part_ids=set(),
        learning_date=D0,
        now=NOW,
    )
    assert effect.new_evidence_part_ids == (learner.part(1),)


def test_rule1_incorrect_attempt_resets_the_streak_to_zero() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    learner.answer(right(), 2)
    assert learner.answer(wrong(), 3).state.consecutive_correct == 0


def test_rule1_incorrect_attempt_adds_the_tested_parts_to_the_error_parts() -> None:
    learner = Learner(parts=4)
    effect = learner.answer(wrong(), 2, 4)
    assert effect.state.error_part_ids == (learner.part(2), learner.part(4))


def test_rule1_error_parts_are_kept_once_in_the_order_they_were_added() -> None:
    learner = Learner(parts=4)
    learner.answer(wrong(), 3)
    learner.answer(wrong(), 1, 3)
    assert learner.state.error_part_ids == (learner.part(3), learner.part(1))


def test_rule1_incorrect_attempt_gives_no_evidence_and_takes_none_away() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    effect = learner.answer(wrong(), 1, 2)
    assert effect.new_evidence_part_ids == ()
    assert learner.covered == {learner.part(1)}


def test_rule1_assisted_correct_answer_changes_neither_streak_nor_evidence() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    effect = learner.answer(right(assisted=True), 2)
    assert effect.state.consecutive_correct == 1
    assert effect.new_evidence_part_ids == ()
    assert effect.state.error_part_ids == ()
    assert learner.covered == {learner.part(1)}


def test_rule1_assisted_wrong_answer_neither_resets_the_streak_nor_marks_error_parts() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    learner.answer(right(), 2)
    effect = learner.answer(wrong(assisted=True), 3)
    assert effect.state.consecutive_correct == 2
    assert effect.state.error_part_ids == ()
    assert effect.new_evidence_part_ids == ()


@pytest.mark.parametrize("attempt", [right(), wrong(), right(assisted=True), wrong(assisted=True)])
def test_rule1_a_first_graded_attempt_of_any_kind_starts_learning(attempt) -> None:
    learner = Learner()
    assert learner.state.status == "new"
    assert learner.answer(attempt, 1).state.status == "learning"


@pytest.mark.parametrize("status", ["learning", "reviewing", "confirmed", "needs_refresh"])
def test_rule1_an_attempt_never_changes_the_status_of_a_passage_that_is_not_new(
    status: str,
) -> None:
    learner = Learner()
    learner.reach_initial_evidence()
    learner.state = replace(
        learner.state,
        status=status,
        confirmed_at=at(0) if status == "confirmed" else None,
        first_confirmed_at=at(0) if status in ("confirmed", "needs_refresh") else None,
        initial_success_at=None if status == "learning" else learner.state.initial_success_at,
        initial_learning_date=None if status == "learning" else learner.state.initial_learning_date,
        consecutive_correct=0 if status == "learning" else learner.state.consecutive_correct,
        review_stage=0 if status == "learning" else learner.state.review_stage,
    )
    assert learner.answer(wrong(), 1).state.status == status
    assert learner.answer(right(assisted=True), 1).state.status == status


def test_rule1_applying_an_attempt_never_changes_the_state_it_started_from() -> None:
    before = PassageMastery(plan_id=PLAN, passage_id=uid("p"))
    advance_target_streak(
        before,
        wrong(),
        question_part_ids=[uid("part")],
        passage_part_ids={uid("part")},
        covered_part_ids=set(),
        learning_date=D0,
        now=NOW,
    )
    assert before == PassageMastery(plan_id=PLAN, passage_id=uid("p"))


@pytest.mark.parametrize(
    ("role", "earlier", "counts"),
    [
        ("review", 0, True),
        ("review", 1, False),
        ("review", 3, False),
        ("training", 0, True),
        ("training", 2, True),
        ("test", 1, True),
        ("game", 5, True),
        ("placement", 1, True),
    ],
)
def test_rule3_a_review_question_counts_only_at_its_first_attempt(
    role: str, earlier: int, counts: bool
) -> None:
    assert attempt_counts_for_mastery(role, earlier) is counts


# --- rule 2: initial evidence --------------------------------------------------------------------


def test_rule2_third_consecutive_correct_unassisted_answer_is_the_initial_evidence() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    learner.answer(right(), 2)
    third = learner.answer(right(), 3, on=0, now=datetime(2026, 10, 5, 9, 15, tzinfo=UTC))
    assert third.initial_evidence_reached
    state = third.state
    assert state.status == "reviewing"
    assert state.review_stage == 1
    assert state.initial_success_at == datetime(2026, 10, 5, 9, 15, tzinfo=UTC)
    assert state.initial_learning_date == D0
    assert state.next_review_due == day(1)
    assert state.last_review_date is None
    assert state.consecutive_correct == 3


def test_rule2_two_correct_answers_are_not_yet_initial_evidence() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    second = learner.answer(right(), 2)
    assert not second.initial_evidence_reached
    assert second.state.status == "learning"
    assert second.state.initial_success_at is None
    assert second.state.next_review_due is None


def test_rule2_a_wrong_answer_restarts_the_count_toward_three() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    learner.answer(right(), 2)
    learner.answer(wrong(), 3)
    learner.answer(right(), 1)
    assert learner.answer(right(), 2).state.status == "learning"
    assert learner.answer(right(), 3).state.status == "reviewing"


def test_rule2_assisted_answers_neither_count_toward_nor_break_the_streak() -> None:
    learner = Learner()
    learner.answer(right(), 1)
    learner.answer(right(assisted=True), 2)
    learner.answer(wrong(assisted=True), 2)
    assert learner.answer(right(), 2).state.status == "learning"  # only two clean answers so far
    assert learner.answer(right(), 3).state.status == "reviewing"


def test_rule2_initial_evidence_is_recorded_once_and_a_later_streak_changes_nothing() -> None:
    learner = Learner()
    learner.reach_initial_evidence(on=0)
    first = learner.state
    learner.answer(wrong(), 1, on=2)
    for _ in range(3):
        effect = learner.answer(right(), 1, on=3, now=at(3))
        assert not effect.initial_evidence_reached
    assert learner.state.initial_success_at == first.initial_success_at
    assert learner.state.initial_learning_date == first.initial_learning_date
    assert learner.state.next_review_due == first.next_review_due
    assert learner.state.status == "reviewing"


def test_rule2_initial_evidence_needs_no_coverage_and_is_not_a_confirmation() -> None:
    learner = Learner(parts=6)
    learner.reach_initial_evidence(cover=False)
    assert learner.state.status == "reviewing"
    assert len(learner.covered) == 3  # three of six parts
    assert learner.state.confirmed_at is None
    assert learner.state.first_confirmed_at is None


def test_rule2_one_streak_may_span_several_sessions_and_games() -> None:
    """D41: three consecutive correct answers in one or more games."""
    learner = Learner()
    learner.answer(right(), 1, on=0)
    learner.answer(right(), 2, on=0)  # first game
    assert learner.state.status == "learning"
    third = learner.answer(right(), 3, on=1)  # a later session on another day
    assert third.initial_evidence_reached
    assert third.state.initial_learning_date == day(1)
    assert third.state.next_review_due == day(2)


def test_rule2_initial_dates_follow_the_session_date_not_the_server_clock() -> None:
    learner = Learner()
    learner.answer(right(), 1, on=0)
    learner.answer(right(), 2, on=0)
    late = learner.answer(right(), 3, on=0, now=at(5))  # replayed five days later
    assert late.state.initial_learning_date == day(0)
    assert late.state.next_review_due == day(1)
    assert late.state.initial_success_at == at(5)  # the server's own clock stamps the evidence


def test_rule2_next_day_is_computed_with_calendar_days() -> None:
    learner = Learner()
    for number in (1, 2, 3):
        effect = advance_target_streak(
            learner.state,
            right(),
            question_part_ids=[learner.part(number)],
            passage_part_ids=learner.parts,
            covered_part_ids=learner.covered,
            learning_date=date(2026, 12, 31),
            now=NOW,
        )
        learner.state = effect.state
    assert learner.state.next_review_due == date(2027, 1, 1)
