"""The plan and calendar ports of E20 (package B5), bound to package B4's plan service.

A plan comes back with the values of the version in force today (D57) and the row id of its
current version; the learning date is the one of the account's time zone.
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

from app.dependencies import SessionContext
from app.errors import AppError, ErrorCode
from app.repositories.plans import PlanInForce
from app.services.plans import PlanService
from app.services.sessions import PlanSnapshot

# Real bank versions start at 1, so the edition check of E20 refuses this one.
UNKNOWN_BANK_VERSION = 0


def snapshot_of(state: PlanInForce) -> PlanSnapshot:
    return PlanSnapshot(
        plan_id=state.plan_id,
        status=state.status,  # type: ignore[arg-type]
        current_version=state.current_version,
        plan_version_id=state.current_version_id,
        edition_id=state.edition_id,
        bank_version=state.bank_version or UNKNOWN_BANK_VERSION,
        section_ordinals=state.target_scope,
        paths=state.paths,
        order=state.order,  # type: ignore[arg-type]
        session_minutes=state.session_minutes,  # type: ignore[arg-type]
        known_passage_ids=state.known_passage_ids,
    )


class PlanServiceAccess:
    """``PlanAccess``: an unknown or foreign plan is ``not_found``."""

    def __init__(self, plans: PlanService) -> None:
        self._plans = plans

    def load_for_session(self, ctx: SessionContext, plan_id: UUID) -> PlanSnapshot:
        state = self._plans.plan_in_force(ctx, plan_id)
        if state is None:
            raise AppError(ErrorCode.not_found)
        return snapshot_of(state)


class PlanServiceCalendar:
    """``LearningCalendar``: today's date in the account time zone, with a pending change."""

    def __init__(self, plans: PlanService) -> None:
        self._plans = plans

    def learning_date(self, ctx: SessionContext) -> date:
        return self._plans.learning_date(ctx)
