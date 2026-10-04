"""Mastery engine (pure): the rules of Implementation-contract §4 (D41/D64 as resolved by D66).

State per ``(user, plan, passage)`` is a ``PassageMastery`` (``domain/learning_state.py``). Every
function takes the state it starts from and returns the state it ends in. Nothing is mutated and no
clock is read: callers pass the server time ``now`` and the session's learning date, which governs
the ladder and the evidence even for a late replay (API-spec E21 step 8).

Where each rule lives:

- Rule 1 and 2, validated attempt and initial evidence: ``advance_target_streak``.
- Rule 3, review ladder: ``summarize_round`` decides a round and ``apply_round`` moves the ladder.
  The size of a round and the choice of its parts belong to session preparation and are reused, not
  duplicated: ``session_policy.review_round_size`` (1, 2 or 3 questions) and
  ``session_policy.rank_parts`` (uncovered first, then error parts, then least recently tested),
  with question types rotating inside ``compose_daily``.
- Rule 4 and 5, confirmation, maintenance and ``needs_refresh``: ``evaluate_confirmation`` and
  ``apply_round``.
- Rule 6, overdue reviews: ``days_overdue`` and ``count_due``. Nothing here punishes lateness.
- Rule 7 and 8, overall progress and scope: ``summarize_plan_progress`` over the passages of the
  scope in force. A passage outside that scope (a deselected hadith path) is ignored, never deleted,
  so its evidence stays in history and reselecting the path restores it.
- E21 idempotency: ``AcknowledgedIds`` (an acknowledged ``clientEventId`` has no second effect).

Where the contract is silent the choice is marked "Decision" and is listed in the package report.

Pure module: standard library, ``answer_policy``, ``learning_state`` and ``session_policy`` only.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from typing import Final
from uuid import UUID

from app.domain.answer_policy import ValidatedAttempt
from app.domain.learning_state import (
    LADDER_STATUSES,
    MAX_REVIEW_STAGE,
    STREAK_TARGET,
    PassageMastery,
)
from app.domain.session_policy import ROLE_REVIEW, PassageInfo, plan_order

# --- numbers of contract §4 ----------------------------------------------------------------------

# Days between ladder stages: the initial evidence makes stage 1 due after 1 day; passing stage 1
# makes stage 2 due after 2 days; passing stage 2 makes stage 3 due after 4 days (cumulative 1/3/7
# when on time).
REVIEW_INTERVAL_DAYS: Final[tuple[int, ...]] = (1, 2, 4)
FIRST_MAINTENANCE_DAYS: Final = 14
SECOND_MAINTENANCE_DAYS: Final = 30
LATER_MAINTENANCE_DAYS: Final = 60

SECTION_STATUS_NEW: Final = "new"


def _after(day: date, days: int) -> date:
    return day + timedelta(days=days)


def _distinct(ids: Iterable[UUID]) -> tuple[UUID, ...]:
    return tuple(dict.fromkeys(ids))


def _within(ids: Iterable[UUID], passage_part_ids: Collection[UUID]) -> tuple[UUID, ...]:
    """The ids that are parts of the passage, once each, in the order given (a part of another
    passage can never become evidence: the database key ties a part to its passage)."""
    return _distinct(part for part in ids if part in passage_part_ids)


# --- coverage ------------------------------------------------------------------------------------


def is_fully_covered(
    passage_part_ids: Collection[UUID], covered_part_ids: Collection[UUID]
) -> bool:
    """Every part of the passage has evidence. A passage without parts cannot be tested, so it is
    never fully covered."""
    return bool(passage_part_ids) and all(part in covered_part_ids for part in passage_part_ids)


def coverage_counts(
    passage_part_ids: Collection[UUID], covered_part_ids: Collection[UUID]
) -> tuple[int, int]:
    """``(covered parts, total parts)`` of the passage, for ``AnswerResult.passage``."""
    return sum(1 for part in passage_part_ids if part in covered_part_ids), len(passage_part_ids)


# --- rule 1 and 2: validated attempt, initial evidence -------------------------------------------


@dataclass(frozen=True, slots=True)
class AttemptEffect:
    """What one validated attempt does: the passage's new state, the parts that gain evidence now
    (each part once per plan) and whether this attempt reached the initial evidence."""

    state: PassageMastery
    new_evidence_part_ids: tuple[UUID, ...] = ()
    initial_evidence_reached: bool = False


def advance_target_streak(
    state: PassageMastery,
    attempt: ValidatedAttempt,
    *,
    question_part_ids: Sequence[UUID],
    passage_part_ids: Collection[UUID],
    covered_part_ids: Collection[UUID],
    learning_date: date,
    now: datetime,
) -> AttemptEffect:
    """Apply one server-graded attempt to the passage (contract §4.1 and §4.2).

    - Correct and unassisted: ``consecutive_correct + 1``; every part the question tests that has no
      evidence yet gains it. The first time the streak reaches ``STREAK_TARGET`` the passage has its
      initial evidence: ``reviewing``, stage 1, due ``learning_date + 1``.
    - Incorrect: the streak is 0 and the tested parts are added to ``error_part_ids``.
    - Assisted (a hint was used), correct or not: training time only. No streak change, no evidence,
      no error parts.

    Decision: a ``new`` passage becomes ``learning`` on its first graded attempt of any kind, so a
    passage the learner started (even with a hint) is "being learned" for session preparation.
    """
    tested = _within(question_part_ids, passage_part_ids)
    started = replace(state, status="learning") if state.status == "new" else state
    if attempt.assisted:
        return AttemptEffect(started)
    if not attempt.correct:
        errors = _distinct((*started.error_part_ids, *tested))
        return AttemptEffect(replace(started, consecutive_correct=0, error_part_ids=errors))
    streak = started.consecutive_correct + 1
    advanced = replace(started, consecutive_correct=streak)
    fresh = tuple(part for part in tested if part not in covered_part_ids)
    if advanced.initial_success_at is None and streak >= STREAK_TARGET:
        advanced = replace(
            advanced,
            status="reviewing",
            review_stage=1,
            initial_success_at=now,
            initial_learning_date=learning_date,
            next_review_due=_after(learning_date, REVIEW_INTERVAL_DAYS[0]),
        )
        return AttemptEffect(advanced, fresh, True)
    return AttemptEffect(advanced, fresh, False)


def attempt_counts_for_mastery(role: str, earlier_attempts_of_question: int) -> bool:
    """A review question counts only at its first attempt in its round (§4.3); every other role
    counts each attempt. A later attempt is still recorded, but has no effect on mastery."""
    return role != ROLE_REVIEW or earlier_attempts_of_question == 0


# --- rule 3: review rounds -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RoundAnswer:
    """The first attempt of one question of a review round."""

    question_id: UUID
    correct: bool
    assisted: bool
    part_ids: tuple[UUID, ...]

    @property
    def clean(self) -> bool:
        """Correct, unassisted and (by construction of this type) the first attempt."""
        return self.correct and not self.assisted


@dataclass(frozen=True, slots=True)
class RoundResult:
    """The verdict of a round and, when it failed, the parts of the questions that failed it."""

    passed: bool
    failing_part_ids: tuple[UUID, ...] = ()


def round_is_complete(round_question_ids: Collection[UUID], answered: Collection[UUID]) -> bool:
    """Every question of the round has its first attempt. An unfinished round is never evaluated
    (API-spec E21 step 5), so the passage stays due."""
    return bool(round_question_ids) and all(q in answered for q in round_question_ids)


def summarize_round(answers: Iterable[RoundAnswer]) -> RoundResult:
    """A round passes only if every question was answered correctly, unassisted, at its first
    attempt. Otherwise it fails (any error or any hint) and the failing parts are the parts of
    every question that was wrong or assisted."""
    given = list(answers)
    if not given:
        raise ValueError("a round has at least one answer")
    failed = [answer for answer in given if not answer.clean]
    return RoundResult(
        passed=not failed,
        failing_part_ids=_distinct(part for answer in failed for part in answer.part_ids),
    )


def _reset_to_stage_one(
    state: PassageMastery,
    failing_part_ids: Sequence[UUID],
    passage_part_ids: Collection[UUID],
    review_date: date,
) -> PassageMastery:
    """A failed round (§4.3 and §4.5): stage 1, due the next learning day, one more lapse, the
    failing parts into ``error_part_ids``. Coverage and the initial evidence are kept."""
    refresh = state.status in ("confirmed", "needs_refresh")
    return replace(
        state,
        status="needs_refresh" if refresh else state.status,
        review_stage=1,
        next_review_due=_after(review_date, 1),
        last_review_date=review_date,
        lapse_count=state.lapse_count + 1,
        error_part_ids=_distinct(
            (*state.error_part_ids, *_within(failing_part_ids, passage_part_ids))
        ),
        confirmed_at=None,
        maintenance_stage=0 if refresh else state.maintenance_stage,
    )


def evaluate_confirmation(
    *,
    stage_passed: int,
    passage_part_ids: Collection[UUID],
    covered_part_ids: Collection[UUID],
) -> bool:
    """§4.4: a passage is confirmed when stage 3 has passed and every part has evidence."""
    return stage_passed >= MAX_REVIEW_STAGE and is_fully_covered(passage_part_ids, covered_part_ids)


def _passed_ladder_stage(
    state: PassageMastery,
    passage_part_ids: Collection[UUID],
    covered_part_ids: Collection[UUID],
    review_date: date,
    now: datetime,
) -> PassageMastery:
    stage = min(max(state.review_stage, 1), MAX_REVIEW_STAGE)
    if stage < MAX_REVIEW_STAGE:
        return replace(
            state,
            review_stage=stage + 1,
            next_review_due=_after(review_date, REVIEW_INTERVAL_DAYS[stage]),
            last_review_date=review_date,
        )
    if evaluate_confirmation(
        stage_passed=stage, passage_part_ids=passage_part_ids, covered_part_ids=covered_part_ids
    ):
        return replace(
            state,
            status="confirmed",
            review_stage=MAX_REVIEW_STAGE,
            confirmed_at=now,
            first_confirmed_at=state.first_confirmed_at or now,
            maintenance_stage=1,
            next_review_due=_after(review_date, FIRST_MAINTENANCE_DAYS),
            last_review_date=review_date,
        )
    # Decision: stage 3 passed with a part still uncovered. The contract does not say what is
    # scheduled. The passage stays at stage 3 and its next round comes after the stage 3 interval,
    # choosing uncovered parts first, so the confirmation follows the round that completes coverage.
    return replace(
        state,
        next_review_due=_after(review_date, REVIEW_INTERVAL_DAYS[-1]),
        last_review_date=review_date,
    )


def _passed_maintenance(state: PassageMastery, review_date: date) -> PassageMastery:
    """§4.5: rounds at +14 (set on confirmation), +30, then every +60 days."""
    stage = max(state.maintenance_stage, 1)
    days = SECOND_MAINTENANCE_DAYS if stage == 1 else LATER_MAINTENANCE_DAYS
    return replace(
        state,
        maintenance_stage=stage + 1,
        next_review_due=_after(review_date, days),
        last_review_date=review_date,
    )


def _stage_already_moved_on(state: PassageMastery, review_date: date) -> bool:
    """At most one stage per learning date per passage (§4.3). A round that ended on the date of the
    initial evidence or of the previous round does not move the ladder again.

    Decision: the previous round counts whether it passed or failed, so a failed passage waits for
    its next learning day instead of passing the same day."""
    return review_date in (state.last_review_date, state.initial_learning_date)


def apply_round(
    state: PassageMastery,
    result: RoundResult,
    *,
    passage_part_ids: Collection[UUID],
    covered_part_ids: Collection[UUID],
    review_date: date,
    now: datetime,
) -> PassageMastery:
    """Move the ladder after an evaluated round (§4.3 to §4.6). ``covered_part_ids`` includes the
    evidence of the round's own attempts; ``review_date`` is the learning date of the session, the
    day the round was actually taken, from which the next interval is counted.

    - Fail: stage 1, due the next learning day, ``lapse_count + 1``. A confirmed or
      ``needs_refresh`` passage is ``needs_refresh`` with ``confirmed_at`` cleared and
      ``first_confirmed_at`` kept.
    - Pass on the ladder: one stage, next due after the next interval. Stage 3 with every part
      covered confirms (maintenance due after 14 days).
    - Pass on a confirmed passage: the next maintenance interval (30, then 60 days).

    A passage that is not on the ladder (``new`` or ``learning``) is returned unchanged.
    """
    if state.status not in LADDER_STATUSES:
        return state
    if not result.passed:
        return _reset_to_stage_one(state, result.failing_part_ids, passage_part_ids, review_date)
    if _stage_already_moved_on(state, review_date):
        return state
    if state.status == "confirmed":
        return _passed_maintenance(state, review_date)
    return _passed_ladder_stage(state, passage_part_ids, covered_part_ids, review_date, now)


# --- rule 6: overdue reviews ---------------------------------------------------------------------


def days_overdue(state: PassageMastery, on: date) -> int:
    """Whole days a due round has waited; 0 when it is due today or not due. Lateness changes
    nothing in the state: an overdue round stays due without penalty and is taken first."""
    if not state.is_due(on) or state.next_review_due is None:
        return 0
    return (on - state.next_review_due).days


def count_due(states: Iterable[PassageMastery], on: date) -> int:
    """Passages with a review or maintenance round due on ``on`` (``Today.dueReviews``)."""
    return sum(1 for state in states if state.is_due(on))


# --- rule 7 and 8: overall progress --------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PassageCounts:
    """Passages per status; ``new`` includes passages that have no mastery row yet."""

    new: int = 0
    learning: int = 0
    reviewing: int = 0
    confirmed: int = 0
    needs_refresh: int = 0


@dataclass(frozen=True, slots=True)
class SectionFacts:
    """One section of the plan scope (a surah or a hadith) for the selected paths."""

    ordinal: int
    passage_count: int
    words: int
    confirmed_words: int
    percent: int
    status: str


@dataclass(frozen=True, slots=True)
class PlanProgressFacts:
    overall_percent: int
    confirmed_words: int
    total_words: int
    confirmed_sections: int
    total_sections: int
    counts: PassageCounts
    next_review_date: date | None
    sections: tuple[SectionFacts, ...]


def percent_of(confirmed_words: int, total_words: int) -> int:
    """``floor(100 * confirmed / total)``; 0 when there are no words. Integer arithmetic only."""
    if total_words <= 0:
        return 0
    return 100 * confirmed_words // total_words


def section_status(passage_statuses: Iterable[str]) -> str:
    """Rollup of a section's passage statuses (the contract leaves it to implementation design).

    ``confirmed`` when every passage is confirmed; else ``needs_refresh`` when any passage is;
    else ``reviewing`` when any passage is reviewing or confirmed (in progress); else ``learning``
    when any passage is being learned; else ``new``.
    """
    seen = set(passage_statuses)
    if not seen:
        return SECTION_STATUS_NEW
    if seen == {"confirmed"}:
        return "confirmed"
    if "needs_refresh" in seen:
        return "needs_refresh"
    if seen & {"reviewing", "confirmed"}:
        return "reviewing"
    if "learning" in seen:
        return "learning"
    return SECTION_STATUS_NEW


def _status_of(mastery: Mapping[UUID, PassageMastery], passage_id: UUID) -> str:
    row = mastery.get(passage_id)
    return SECTION_STATUS_NEW if row is None else row.status


def summarize_plan_progress(
    passages: Sequence[PassageInfo], mastery: Mapping[UUID, PassageMastery]
) -> PlanProgressFacts:
    """Overall plan progress over the passages of the scope in force (§4.7, §4.8).

    ``overall_percent = floor(100 * words of confirmed passages / words of all passages)``. A
    passage in ``needs_refresh`` is outside the numerator. Mastery rows of passages that are not in
    ``passages`` (for example a deselected hadith path) are ignored. The next review date is the
    earliest ``next_review_due`` among the scope's passages on the ladder.
    """
    counts = {"new": 0, "learning": 0, "reviewing": 0, "confirmed": 0, "needs_refresh": 0}
    by_section: dict[int, list[PassageInfo]] = {}
    confirmed_words = total_words = 0
    due_dates: list[date] = []
    for passage in passages:
        status = _status_of(mastery, passage.id)
        counts[status if status in counts else SECTION_STATUS_NEW] += 1
        total_words += passage.word_count
        if status == "confirmed":
            confirmed_words += passage.word_count
        row = mastery.get(passage.id)
        if row is not None and row.status in LADDER_STATUSES and row.next_review_due is not None:
            due_dates.append(row.next_review_due)
        by_section.setdefault(passage.section_ordinal, []).append(passage)
    sections: list[SectionFacts] = []
    for ordinal in sorted(by_section):
        members = by_section[ordinal]
        statuses = [_status_of(mastery, p.id) for p in members]
        words = sum(p.word_count for p in members)
        done = sum(p.word_count for p, s in zip(members, statuses, strict=True) if s == "confirmed")
        sections.append(
            SectionFacts(
                ordinal=ordinal,
                passage_count=len(members),
                words=words,
                confirmed_words=done,
                percent=percent_of(done, words),
                status=section_status(statuses),
            )
        )
    return PlanProgressFacts(
        overall_percent=percent_of(confirmed_words, total_words),
        confirmed_words=confirmed_words,
        total_words=total_words,
        confirmed_sections=sum(1 for s in sections if s.status == "confirmed"),
        total_sections=len(sections),
        counts=PassageCounts(**counts),
        next_review_date=min(due_dates, default=None),
        sections=tuple(sections),
    )


def next_new_passage(
    passages: Sequence[PassageInfo],
    mastery: Mapping[UUID, PassageMastery],
    known_passage_ids: Collection[UUID],
    order: str,
) -> PassageInfo | None:
    """The passage the next daily session introduces first (``Today.nextNewPassage``): a passage
    still being learned comes before a new one, both in plan order, and passages known from the
    placement test are skipped (the rule of ``session_policy`` for new material)."""
    ordered = plan_order(passages, order)
    for wanted in ("learning", "new"):
        for passage in ordered:
            if passage.id not in known_passage_ids and _status_of(mastery, passage.id) == wanted:
                return passage
    return None


# --- E21 idempotency -----------------------------------------------------------------------------


class AcknowledgedIds:
    """The ``clientEventId`` values the server has acknowledged. An event whose id is in the set is
    a duplicate: it is reported as such and has no second effect (no regrading, no second credit).

    ``acknowledge`` is called only for an event that was recorded. An event that was rejected or
    kept pending is not acknowledged, so the same id may still be accepted later."""

    def __init__(self, known: Iterable[UUID] = ()) -> None:
        self._ids: set[UUID] = set(known)

    def is_duplicate(self, event_id: UUID) -> bool:
        return event_id in self._ids

    def acknowledge(self, event_id: UUID) -> None:
        self._ids.add(event_id)

    def __len__(self) -> int:
        return len(self._ids)
