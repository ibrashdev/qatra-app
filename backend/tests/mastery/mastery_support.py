"""Hand-built, synthetic fixtures for the pure mastery tests (no text, no database, no network).

``Learner`` plays one passage through the pure rules the way the E21 service will: every attempt
goes through ``advance_target_streak`` (evidence is added as it happens), and a review round is
decided by ``summarize_round`` and moved by ``apply_round`` once its answers are in. Days are
offsets from ``D0`` so that a test reads as a calendar ("the review on day 3").
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from app.domain.answer_policy import ValidatedAttempt
from app.domain.learning_state import PassageMastery
from app.domain.mastery_policy import (
    AttemptEffect,
    RoundAnswer,
    advance_target_streak,
    apply_round,
    summarize_round,
)
from tests.sessions.ss_policy_support import PLAN, passage, uid

D0 = date(2026, 10, 5)
NOW = datetime(2026, 10, 5, 8, 30, tzinfo=UTC)


def day(offset: int) -> date:
    return D0 + timedelta(days=offset)


def at(offset: int) -> datetime:
    return NOW + timedelta(days=offset)


def right(*, assisted: bool = False) -> ValidatedAttempt:
    return ValidatedAttempt(correct=True, assisted=assisted, error_kind="none")


def wrong(*, assisted: bool = False) -> ValidatedAttempt:
    return ValidatedAttempt(correct=False, assisted=assisted, error_kind="wrong_choice")


class Learner:
    """One passage of ``parts`` parts, its state and the parts that have evidence."""

    def __init__(self, parts: int = 3, *, name: str = "p") -> None:
        self.info = passage(name, words=(4,) * parts)
        self.parts: tuple[UUID, ...] = tuple(part.id for part in self.info.parts)
        self.state = PassageMastery(plan_id=PLAN, passage_id=self.info.id)
        self.covered: set[UUID] = set()

    def part(self, number: int) -> UUID:
        """The id of part ``number`` (1-based)."""
        return self.parts[number - 1]

    def answer(
        self, attempt: ValidatedAttempt, *parts: int, on: int = 0, now: datetime | None = None
    ) -> AttemptEffect:
        """One graded attempt on a question that tests ``parts`` (default: part 1)."""
        effect = advance_target_streak(
            self.state,
            attempt,
            question_part_ids=[self.part(n) for n in parts or (1,)],
            passage_part_ids=self.parts,
            covered_part_ids=self.covered,
            learning_date=day(on),
            now=now or at(on),
        )
        self.state = effect.state
        self.covered.update(effect.new_evidence_part_ids)
        assert self.state.violations() == ()
        return effect

    def cover_all(self, *, on: int = 0) -> None:
        """A correct, unassisted answer for every part that has no evidence yet."""
        for number in range(1, len(self.parts) + 1):
            if self.part(number) not in self.covered:
                self.answer(right(), number, on=on)

    def reach_initial_evidence(self, *, on: int = 0, cover: bool = True) -> None:
        """Three correct answers on day ``on``; with ``cover`` every part ends with evidence."""
        for number in (1, 2, 3):
            self.answer(right(), min(number, len(self.parts)), on=on)
        if cover:
            self.cover_all(on=on)

    def review(self, *answers: tuple[ValidatedAttempt, tuple[int, ...]], on: int) -> PassageMastery:
        """A review round taken on day ``on``: each ``(attempt, parts)`` is the first attempt of one
        question. The round is evaluated once every answer is in."""
        round_answers: list[RoundAnswer] = []
        for index, (attempt, parts) in enumerate(answers):
            self.answer(attempt, *parts, on=on)
            round_answers.append(
                RoundAnswer(
                    question_id=uid("round-question", self.info.id, on, index),
                    correct=attempt.correct,
                    assisted=attempt.assisted,
                    part_ids=tuple(self.part(n) for n in parts),
                )
            )
        self.state = apply_round(
            self.state,
            summarize_round(round_answers),
            passage_part_ids=self.parts,
            covered_part_ids=self.covered,
            review_date=day(on),
            now=at(on),
        )
        assert self.state.violations() == ()
        return self.state

    def clean_round(self, *, on: int) -> PassageMastery:
        """A passing round: two correct, unassisted answers on parts 1 and 2."""
        return self.review((right(), (1,)), (right(), (2,)), on=on)

    def failed_round(self, *, on: int) -> PassageMastery:
        """A failing round: the first question is answered wrongly, the second correctly."""
        return self.review((wrong(), (1,)), (right(), (2,)), on=on)

    def on_the_ladder(self, *, stage: int, on: int = 0) -> None:
        """Initial evidence on day ``on`` with full coverage, then clean rounds on time until the
        passage is at ``stage`` (1 to 3)."""
        self.reach_initial_evidence(on=on)
        due = on + 1
        for _ in range(1, stage):
            self.clean_round(on=due)
            assert self.state.next_review_due is not None
            due = (self.state.next_review_due - D0).days

    def confirmed(self, *, on: int = 0) -> int:
        """Reach confirmation on time and return the day it happened (day 7 when ``on`` is 0)."""
        self.on_the_ladder(stage=3, on=on)
        assert self.state.next_review_due is not None
        confirmed_day = (self.state.next_review_due - D0).days
        self.clean_round(on=confirmed_day)
        assert self.state.status == "confirmed"
        return confirmed_day
