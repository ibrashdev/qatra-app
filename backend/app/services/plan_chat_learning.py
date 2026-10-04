"""The anonymized learning record of a plan revision conversation (R27, Plan-conversation §2.4).

``PlanChatLearningSummary`` implements ``LearningSummaryPort`` for one request. It reads the
learner's own state through the shared learning repository (mastery, attempts) and the bank
repository (passage references, question types) and returns source-text references and dates
only: no account, device, session or registration data and no answer text. The service sends the
result to the model under a temporary conversation id, trimmed to 30 daily entries and 50
attempts.

What the schema keeps limits the record:

- Review outcomes: there is no review history table, so a passage carries at most its latest
  review (the date and whether it passed, which is false while the passage is ``needs_refresh``).
- Error parts: the mastery row lists the parts with errors; the error count is the number of
  wrong answers on questions that cover the part among the newest attempts (at least 1).
- Attempt dates are UTC dates of ``occurred_at`` (an attempt carries no learning date).
- Daily time: ``daily_progress_between`` is an optional method of the learning repository. When
  the repository has it the 30-day window is filled; otherwise the list is empty.

The passage and error-part lists are capped here (the spec fixes only the 30 and 50 above) so the
model context stays small: the most urgent passages come first.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import UTC, date, timedelta
from typing import Protocol, runtime_checkable
from uuid import UUID

from app.contracts_plan_chat import (
    MAX_DAILY_TIME_ITEMS,
    MAX_RECENT_ATTEMPTS,
    DailyTimeItem,
    ErrorPartItem,
    LearningSummary,
    PassageMasteryItem,
    RecentAttempt,
    ReviewOutcome,
)
from app.dependencies import SessionContext
from app.domain.learning_state import AttemptRecord, DailyProgressRow, PassageMastery
from app.errors import AppError, ErrorCode
from app.repositories.bank import BankPassage, BankQuestion, BankRepository
from app.repositories.learning import LearningRepository
from app.repositories.plans import StoredPlan

MAX_PASSAGE_ITEMS = 60
MAX_ERROR_PART_ITEMS = 30
UNKNOWN_QUESTION_TYPE = "unknown"
_MS_PER_MINUTE = 60_000
# Most urgent first: a passage that needs a refresh, then the ones still being learned.
_STATE_PRIORITY = {"needs_refresh": 0, "learning": 1, "reviewing": 2, "confirmed": 3, "new": 4}


class PlanLookup(Protocol):
    """The two reads of the plan service that the record needs."""

    def read_plan(self, ctx: SessionContext, plan_id: UUID) -> StoredPlan | None: ...

    def learning_date(self, ctx: SessionContext) -> date: ...


@runtime_checkable
class DailyProgressSource(Protocol):
    """Optional capability of the learning repository: the days with verified activity."""

    def daily_progress_between(
        self, ctx: SessionContext, start: date, end: date
    ) -> list[DailyProgressRow]: ...


def _passage_items(
    mastery: Mapping[UUID, PassageMastery], passages: Mapping[UUID, BankPassage]
) -> list[PassageMasteryItem]:
    """One item per mastery row of a passage in scope, the most urgent first."""
    items: list[PassageMasteryItem] = []
    for passage_id, row in mastery.items():
        passage = passages.get(passage_id)
        if passage is None:  # a passage of an earlier version of the plan
            continue
        outcomes = []
        if row.last_review_date is not None:
            outcomes.append(
                ReviewOutcome(date=row.last_review_date, passed=row.status != "needs_refresh")
            )
        items.append(
            PassageMasteryItem(
                reference=passage.reference,
                state=row.status,  # type: ignore[arg-type]
                review_outcomes=outcomes,
            )
        )
    items.sort(key=lambda item: (_STATE_PRIORITY.get(item.state, 9), item.reference))
    return items


def _error_part_items(
    mastery: Mapping[UUID, PassageMastery],
    passages: Mapping[UUID, BankPassage],
    attempts: Sequence[AttemptRecord],
    questions: Mapping[UUID, BankQuestion],
) -> list[ErrorPartItem]:
    """The parts a mastery row lists with errors, most errors first. The count is the number of
    wrong answers on questions that cover the part (at least 1: the row says it has errors)."""
    wrong_by_part: Counter[UUID] = Counter()
    for attempt in attempts:
        question = questions.get(attempt.question_id)
        if question is not None and not attempt.correct:
            wrong_by_part.update(question.covered_part_ids)
    items: list[ErrorPartItem] = []
    for passage_id, row in mastery.items():
        passage = passages.get(passage_id)
        if passage is None:
            continue
        parts = {part.id: part for part in passage.parts}
        for part_id in row.error_part_ids:
            part = parts.get(part_id)
            if part is not None:
                items.append(
                    ErrorPartItem(
                        reference=f"{passage.reference} (part {part.ordinal})",
                        error_count=max(1, wrong_by_part[part_id]),
                    )
                )
    items.sort(key=lambda item: (-item.error_count, item.reference))
    return items


def _attempt_items(
    attempts: Sequence[AttemptRecord],
    passages: Mapping[UUID, BankPassage],
    questions: Mapping[UUID, BankQuestion],
) -> list[RecentAttempt]:
    items: list[RecentAttempt] = []
    for attempt in attempts:
        passage = passages.get(attempt.passage_id)
        if passage is None:
            continue
        question = questions.get(attempt.question_id)
        items.append(
            RecentAttempt(
                question_type=question.type if question else UNKNOWN_QUESTION_TYPE,
                reference=passage.reference,
                correct=attempt.correct,
                assisted=attempt.assisted,
                error_kind=attempt.error_kind,
                date=attempt.occurred_at.astimezone(UTC).date(),
            )
        )
    return items


class EmptyLearningSummary:
    """No record: used when the learning or bank repository is not available."""

    def summary_for(self, user_id: UUID, plan_id: UUID, *, is_demo: bool) -> LearningSummary:
        return LearningSummary()


def _minutes(active_ms: int) -> int:
    return (active_ms + _MS_PER_MINUTE // 2) // _MS_PER_MINUTE


class PlanChatLearningSummary:
    """``LearningSummaryPort`` for one request: the context carries the learner's session."""

    def __init__(
        self,
        ctx: SessionContext,
        *,
        plans: PlanLookup,
        learning: LearningRepository,
        bank: BankRepository,
    ) -> None:
        self._ctx = ctx
        self._plans = plans
        self._learning = learning
        self._bank = bank

    def summary_for(self, user_id: UUID, plan_id: UUID, *, is_demo: bool) -> LearningSummary:
        ctx = self._ctx
        if user_id != ctx.user_id:
            raise AppError(ErrorCode.internal)  # a programming error, never a client condition
        if is_demo:
            return LearningSummary()  # a demo account's record never leaves the server
        stored = self._plans.read_plan(ctx, plan_id)
        if stored is None:
            return LearningSummary()
        today = self._plans.learning_date(ctx)
        daily = self._daily_time(today)
        edition = self._bank.edition(ctx, stored.edition_id)
        if edition is None:  # unknown or revoked: nothing of it may be read
            return LearningSummary(daily_time=daily)
        passages = {
            passage.id: passage
            for passage in self._bank.passages(
                ctx,
                stored.edition_id,
                bank_version=edition.bank_version,
                section_ordinals=list(stored.target_scope),
                paths=list(stored.paths),
            )
        }
        if not passages:
            return LearningSummary(daily_time=daily)
        mastery = self._learning.mastery_for_plan(ctx, plan_id)
        attempts = self._learning.attempts_for_passages(ctx, list(passages))  # newest first
        recent = attempts[:MAX_RECENT_ATTEMPTS]
        with_errors = {
            passage_id for passage_id, row in mastery.items() if row.error_part_ids
        } & set(passages)
        needed = {attempt.passage_id for attempt in recent} | with_errors
        questions = {
            question.id: question
            for question in (
                self._bank.questions(
                    ctx,
                    stored.edition_id,
                    bank_version=edition.bank_version,
                    passage_ids=sorted(needed, key=str),
                )
                if needed
                else []
            )
        }
        return LearningSummary(
            passages=_passage_items(mastery, passages)[:MAX_PASSAGE_ITEMS],
            error_parts=_error_part_items(mastery, passages, attempts, questions)[
                :MAX_ERROR_PART_ITEMS
            ],
            daily_time=daily,
            attempts=_attempt_items(recent, passages, questions),
        )

    def _daily_time(self, today: date) -> list[DailyTimeItem]:
        source = self._learning
        if not isinstance(source, DailyProgressSource):
            return []
        start = today - timedelta(days=MAX_DAILY_TIME_ITEMS - 1)
        rows = source.daily_progress_between(self._ctx, start, today)
        items = [
            DailyTimeItem(date=row.learning_date, active_minutes=_minutes(row.active_ms))
            for row in sorted(rows, key=lambda r: r.learning_date)
            if start <= row.learning_date <= today
        ]
        return [item for item in items if item.active_minutes > 0]
