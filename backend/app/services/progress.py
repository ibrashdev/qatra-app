"""Today and progress: E18 ``GET /api/today`` and E19 ``GET /api/progress`` (package B6;
API-spec §4.6).

Pure reads of facts the server has validated (D40, D66): a GET never creates a session, evidence or
a row. Time and material stay independent: the daily figure is verified active time against the
goal of the day, the overall figure is the share of words of confirmed passages in the plan's scope.

The plans of the account come through a port, ``PlanDirectory``, so that this module does not reach
into package B4: ``PlanServiceDirectory`` binds it to B4's plan service (``list_plans`` and
``plan_in_force``). Each entry is the ``Plan`` as E18 shows it (``sessionMinutes`` of the version in
force today, a later change apart in ``pendingSessionMinutes``, D57) with the scope, paths, order,
minutes and known passages in force today; progress is computed over that scope, so a path change
applies from the next learning day and the evidence of a deselected path stays in history.

Design choices where the specification is silent (also in the package report):

- ``Today.plan`` is the active plan only; a paused or completed plan appears in E19.
- ``dueReviews`` and ``nextNewPassage`` look at the passages of the scope in force;
  ``openSessionId`` is the open daily session of today when it belongs to the active plan.
- ``streakDays`` counts consecutive completed days ending today or yesterday
  (``daily_completions``).
- ``history`` lists the learning dates before today (the last 30) that have a ``daily_progress``
  row, oldest first; a day without activity has no row and is not listed.
- E19 lists the active plan first, then the other plans newest first.
- ``openPlanChatId`` comes from an optional seam, ``open_chat_lookup``; without it it is ``null``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Protocol
from uuid import UUID

from app.contracts_plan_chat import Plan
from app.contracts_sessions import (
    DailyProgress,
    HistoryDay,
    NextNewPassage,
    PlanProgress,
    ProgressResponse,
    SectionProgress,
    StatusCounts,
    Today,
)
from app.dependencies import SessionContext
from app.domain.mastery_policy import count_due, next_new_passage, summarize_plan_progress
from app.domain.time_policy import history_range, streak_days
from app.repositories.bank import BankPassage, BankRepository
from app.repositories.learning import LearningRepository
from app.services.plan_access import snapshot_of
from app.services.plans import PlanService, plan_dto
from app.services.sessions import LearningCalendar, PlanSnapshot, daily_progress_dto

STREAK_WINDOW_DAYS = 366  # completion dates are read a window at a time, going back
STREAK_MAX_WINDOWS = 20  # a streak of 20 years is the end of the line


@dataclass(frozen=True, slots=True)
class PlanEntry:
    """One plan of the account: the ``Plan`` DTO and the values in force today."""

    plan: Plan
    in_force: PlanSnapshot


class PlanDirectory(Protocol):
    def list_plans(self, ctx: SessionContext) -> Sequence[PlanEntry]:
        """Every plan of the caller (active, paused, completed), newest first."""


class PlanServiceDirectory:
    """``PlanDirectory`` over package B4's plan service."""

    def __init__(self, plans: PlanService) -> None:
        self._plans = plans

    def list_plans(self, ctx: SessionContext) -> list[PlanEntry]:
        entries: list[PlanEntry] = []
        for stored in self._plans.list_plans(ctx):
            state = self._plans.plan_in_force(ctx, stored.plan_id)
            if state is None:  # the plan vanished between the two reads
                continue
            pending = (
                stored.session_minutes if stored.session_minutes != state.session_minutes else None
            )
            plan = plan_dto(stored).model_copy(
                update={
                    "session_minutes": state.session_minutes,
                    "pending_session_minutes": pending,
                }
            )
            entries.append(PlanEntry(plan, snapshot_of(state)))
        return entries


class ProgressService:
    def __init__(
        self,
        *,
        bank: BankRepository,
        learning: LearningRepository,
        plans: PlanDirectory,
        calendar: LearningCalendar,
        open_chat_lookup: Callable[[SessionContext], UUID | None] | None = None,
    ) -> None:
        self._bank = bank
        self._learning = learning
        self._plans = plans
        self._calendar = calendar
        self._open_chat_lookup = open_chat_lookup

    # -- E18 -------------------------------------------------------------------------------------

    def read_today(self, ctx: SessionContext) -> Today:
        today, active, _ = self._overview(ctx)
        daily = self._daily(ctx, today, active)
        due, next_new, open_session = 0, None, None
        if active is not None:
            due, next_new = self._plan_today(ctx, active, today)
            existing = self._learning.find_open_daily(ctx, today)
            if existing is not None and existing.plan_id == active.plan.plan_id:
                open_session = existing.id
        chat = None if self._open_chat_lookup is None else self._open_chat_lookup(ctx)
        return Today(
            **daily.model_dump(),
            plan=None if active is None else active.plan,
            due_reviews=due,
            next_new_passage=next_new,
            open_session_id=open_session,
            streak_days=self._streak(ctx, today),
            open_plan_chat_id=chat,
        )

    def _plan_today(
        self, ctx: SessionContext, entry: PlanEntry, today: date
    ) -> tuple[int, NextNewPassage | None]:
        snapshot = entry.in_force
        scope = self._scope(ctx, snapshot)
        mastery = self._learning.mastery_for_plan(ctx, snapshot.plan_id)
        in_scope = {passage.id: passage for passage in scope}
        due = count_due((row for pid, row in mastery.items() if pid in in_scope), today)
        found = next_new_passage(
            [passage.info() for passage in scope],
            mastery,
            snapshot.known_passage_ids,
            snapshot.order,
        )
        if found is None:
            return due, None
        passage = in_scope[found.id]
        section = self._bank.sections(ctx, snapshot.edition_id, [passage.section_ordinal]).get(
            passage.section_ordinal
        )
        title = "" if section is None else section.title_ar
        return due, NextNewPassage(reference=passage.reference, section_title_ar=title)

    def _streak(self, ctx: SessionContext, today: date) -> int:
        """Consecutive completed learning dates ending today or yesterday. Completion dates are read
        a year at a time, and the next earlier year only while the run reaches the start of the
        window."""
        completed: set[date] = set()
        end = today
        for _ in range(STREAK_MAX_WINDOWS):
            start = end - timedelta(days=STREAK_WINDOW_DAYS - 1)
            window = self._learning.completion_dates(ctx, start, end)
            completed |= window
            if start not in window:
                break
            end = start - timedelta(days=1)
        return streak_days(completed, today)

    # -- E19 -------------------------------------------------------------------------------------

    def read_progress(self, ctx: SessionContext) -> ProgressResponse:
        today, active, entries = self._overview(ctx)
        first, last = history_range(today)
        done = self._learning.completion_dates(ctx, first, last)
        history = [
            HistoryDay(
                date=row.learning_date,
                active_ms=row.active_ms,
                goal_ms=row.goal_ms,
                completed=row.learning_date in done,
            )
            for row in self._learning.daily_progress_between(ctx, first, last)
        ]
        ordered = sorted(entries, key=lambda entry: entry.plan.status != "active")  # stable
        return ProgressResponse(
            daily=self._daily(ctx, today, active),
            history=history,
            plans=[self._plan_progress(ctx, entry) for entry in ordered],
        )

    def _plan_progress(self, ctx: SessionContext, entry: PlanEntry) -> PlanProgress:
        snapshot = entry.in_force
        passages = self._scope(ctx, snapshot)
        mastery = self._learning.mastery_for_plan(ctx, snapshot.plan_id)
        facts = summarize_plan_progress([passage.info() for passage in passages], mastery)
        titles = self._bank.sections(
            ctx, snapshot.edition_id, [section.ordinal for section in facts.sections]
        )
        sections = []
        for section in facts.sections:
            meta = titles.get(section.ordinal)
            sections.append(
                SectionProgress(
                    ordinal=section.ordinal,
                    reference=str(section.ordinal) if meta is None else meta.reference,
                    title_ar="" if meta is None else meta.title_ar,
                    title_en="" if meta is None else meta.title_en,
                    percent=section.percent,
                    status=section.status,  # type: ignore[arg-type]
                )
            )
        counts = facts.counts
        return PlanProgress(
            plan_id=entry.plan.plan_id,
            title_ar=entry.plan.title_ar,
            title_en=entry.plan.title_en,
            status=entry.plan.status,
            current_version=entry.plan.current_version,
            overall_percent=facts.overall_percent,
            confirmed_words=facts.confirmed_words,
            total_words=facts.total_words,
            confirmed_sections=facts.confirmed_sections,
            total_sections=facts.total_sections,
            counts=StatusCounts(
                new=counts.new,
                learning=counts.learning,
                reviewing=counts.reviewing,
                confirmed=counts.confirmed,
                needs_refresh=counts.needs_refresh,
            ),
            next_review_date=facts.next_review_date,
            sections=sections,
        )

    # -- shared ------------------------------------------------------------------------------------

    def _overview(self, ctx: SessionContext) -> tuple[date, PlanEntry | None, list[PlanEntry]]:
        today = self._calendar.learning_date(ctx)
        entries = list(self._plans.list_plans(ctx))
        active = next((entry for entry in entries if entry.plan.status == "active"), None)
        return today, active, entries

    def _daily(self, ctx: SessionContext, today: date, active: PlanEntry | None) -> DailyProgress:
        minutes = None if active is None else active.in_force.session_minutes
        return daily_progress_dto(self._learning, ctx, today, session_minutes=lambda: minutes)

    def _scope(self, ctx: SessionContext, snapshot: PlanSnapshot) -> list[BankPassage]:
        return self._bank.passages(
            ctx,
            snapshot.edition_id,
            bank_version=snapshot.bank_version,
            section_ordinals=snapshot.section_ordinals,
            paths=snapshot.paths,
        )
