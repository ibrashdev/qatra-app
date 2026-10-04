"""Ports the plan conversation needs from other packages (pure: Protocols and plain types).

B4 (plans and catalog) implements ``PlanningRules`` (the E15 function and the catalog read) and
``PlanWriter`` (the E16 and E17 functions); B3 provides the learning date through the account
profile; the learning record behind ``LearningSummaryPort`` comes from the progress package.
Until they exist the conversation runs against in-memory fakes in tests only. Nothing here
fakes a session cookie: identity always arrives through ``require_session``.

``user_id`` is passed to the ports (they need it for ownership checks) but it never reaches the
external model: the service builds the model payload from public data only (R27).
"""

from __future__ import annotations

from datetime import date
from typing import Literal, Protocol
from uuid import UUID

from pydantic import BaseModel

from app.contracts_plan_chat import (
    CatalogEdition,
    Estimate,
    EstimateResult,
    LearningSummary,
    Path,
    Plan,
    PlanOrder,
    TargetScope,
)


class PlanningRuleError(Exception):
    """A planning rule rejected the input. ``rule`` is an API-spec §4.5 rule name such as
    ``edition_not_available`` or ``scope_invalid``; ``field`` is the request field."""

    def __init__(self, rule: str, field: str | None = None) -> None:
        self.rule = rule
        self.field = field
        super().__init__(rule)


class PlacementNotFound(Exception):
    """The placement session is unknown, not the caller's, or for another edition (404)."""


class PlanNotFound(Exception):
    """The plan is unknown or not the caller's (404)."""


class PlanNotActive(Exception):
    """The plan is completed (409 version_conflict, reason ``plan_not_active``)."""


class ActivePlanConflict(Exception):
    """A race on the one-active-plan rule (409, reason ``active_plan_conflict``)."""


class PlanVersionConflict(Exception):
    """The plan moved since the conversation started (reason ``plan_version``)."""

    def __init__(self, current_version: int) -> None:
        self.current_version = current_version
        super().__init__("plan_version")


class EstimateChanged(Exception):
    """The E16/E17 recomputation differs from ``confirmedEstimate`` (for example the learning day
    changed). The conversation answers with a fresh proposal (``proposal_stale``)."""


class RevisablePlan(BaseModel):
    """What the conversation needs to know about the plan being revised."""

    plan_id: UUID
    edition_id: UUID
    target_scope: TargetScope
    paths: list[Path]
    order: PlanOrder
    session_minutes: Literal[5, 10, 15]
    preferred_date: date | None
    current_version: int
    status: Literal["active", "paused", "completed"]
    placement_session_id: UUID | None = None


class PlanningRules(Protocol):
    """The rules engine (contract §5): B4 implements it; ``estimate`` is the E15 function."""

    def learning_date(self, user_id: UUID) -> date:
        """Today's learning date in the account time zone (API-spec §1.10)."""

    def catalog_edition(self, edition_id: UUID) -> CatalogEdition:
        """A published, non-revoked, non-hidden edition. Raise ``PlanningRuleError`` with rule
        ``edition_not_available`` otherwise."""

    def estimate(
        self,
        user_id: UUID,
        edition_id: UUID,
        target_scope: TargetScope,
        paths: list[str],
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        order: PlanOrder = "book",
    ) -> EstimateResult:
        """Estimate, alternatives and ``reasonCode`` (E15 semantics). Raise ``PlanningRuleError``
        for a rule violation and ``PlacementNotFound`` for a placement session that is not the
        caller's. ``alternatives`` (b) must use ``plan_chat_policy.halve_scope`` so that the
        "smaller scope" quick reply and the alternative agree."""


class PlanWriter(Protocol):
    """The E16 (create) and E17 (revise) functions. B4 implements it."""

    def load_plan(self, user_id: UUID, plan_id: UUID) -> RevisablePlan | None:
        """The caller's plan, or ``None`` when unknown or not owned."""

    def create_plan(
        self,
        user_id: UUID,
        *,
        is_demo: bool,
        edition_id: UUID,
        target_scope: TargetScope,
        paths: list[str],
        order: PlanOrder,
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        confirmed_estimate: Estimate,
        planner_source: Literal["rules", "teaching_agent"],
        planner_model: str | None,
    ) -> Plan:
        """E16 semantics (the previous active plan is paused). Demo accounts: ``synthetic_demo``
        mode as E28. ``planner_source`` is ``teaching_agent`` (with the model id) when a model
        turn supplied parameters, else ``rules`` (Plan-conversation §2.9 item 6). Raise
        ``ActivePlanConflict`` on a race and ``EstimateChanged`` when the
        recomputed estimate differs from ``confirmed_estimate``."""

    def revise_plan(
        self,
        user_id: UUID,
        plan_id: UUID,
        *,
        expected_version: int,
        target_scope: TargetScope,
        paths: list[str],
        order: PlanOrder,
        session_minutes: int,
        preferred_date: date | None,
        confirmed_estimate: Estimate,
    ) -> Plan:
        """E17 semantics. Raise ``PlanNotFound``, ``PlanNotActive`` (completed),
        ``PlanVersionConflict`` or ``EstimateChanged``."""


class LearningSummaryPort(Protocol):
    """The anonymized learning record for revision conversations (R27, §2.4)."""

    def summary_for(self, user_id: UUID, plan_id: UUID, *, is_demo: bool) -> LearningSummary:
        """Source-text references and dates only; synthetic data for demo accounts. The service
        trims the lists to 30 daily entries and 50 attempts and sends the result under a
        temporary conversation id, never with ``user_id``."""
