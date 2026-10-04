"""Plan endpoints E15, E16, E17 and E30 (API-spec §4.5).

Every route lists ``require_valid_origin`` before ``require_session`` (E15 is a POST too), then the
per-client-IP rate limit of its class (API-spec §1.8: "Session read" for E15, "Session write" for
E16, E17 and E30). E16 and E30 are for learner accounts only: a demo account is refused with
``403 forbidden`` before the body is looked at. Bodies are validated strictly (S-1); no endpoint
accepts a user id, a demo flag or a mode. Handlers are synchronous (database calls block), so they
run in the framework's thread pool. Plan data, ids and estimates are never logged here.

The per-IP numbers are the configuration defaults of A-12 (not approved numbers); they are module
constants for now because ``app.config`` has no setting for them. The limiter classes are kept in
``app.state`` by class name, so a later package that belongs to the same class can share them with
``ip_rate_limit``.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from app.contracts import ErrorEnvelope
from app.contracts_plan_chat import EstimateResult, Plan
from app.contracts_plans import CreatePlanRequest, EstimateRequest, RevisePlanRequest
from app.dependencies import SessionContext, require_session, require_valid_origin
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import AppError, ErrorCode
from app.routers.health import client_key
from app.services.plans import PlanService

router = APIRouter(prefix="/api", tags=["plans"])

PUBLIC_READ_RATE_PER_MIN = 60  # E14 (A-12 configuration default, API-spec §1.8)
SESSION_READ_RATE_PER_MIN = 120  # E15 (and the other session reads)
SESSION_WRITE_RATE_PER_MIN = 60  # E16, E17, E30 (and the other session writes)
_NO_STORE = "no-store"
_limiter_lock = threading.Lock()

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin or forbidden (demo account)"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "version_conflict"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}


def ip_rate_limit(state_attr: str, per_minute: int) -> Callable[[Request], None]:
    """A dependency that counts requests per client IP in the limiter ``app.state.<state_attr>``
    (created on first use). The address is used in memory only and never logged or returned."""

    def enforce(request: Request) -> None:
        limiter: SlidingWindowLimiter | None = getattr(request.app.state, state_attr, None)
        if limiter is None:
            with _limiter_lock:
                limiter = getattr(request.app.state, state_attr, None)
                if limiter is None:
                    limiter = SlidingWindowLimiter(per_minute)
                    setattr(request.app.state, state_attr, limiter)
        decision = limiter.check(client_key(request))
        if not decision.allowed:
            raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)

    return enforce


enforce_session_read_limit = ip_rate_limit("session_read_limiter", SESSION_READ_RATE_PER_MIN)
enforce_session_write_limit = ip_rate_limit("session_write_limiter", SESSION_WRITE_RATE_PER_MIN)

Session = Annotated[SessionContext, Depends(require_session)]


def get_plan_service(request: Request) -> PlanService:
    service: PlanService | None = getattr(request.app.state, "plan_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def require_learner(ctx: Session) -> None:
    """Role-based denial (API-spec §1.4): a demo account may not use E16 or E30."""
    if ctx.is_demo:
        raise AppError(ErrorCode.forbidden)


Service = Annotated[PlanService, Depends(get_plan_service)]
_ESTIMATE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(enforce_session_read_limit),
]
_WRITE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(enforce_session_write_limit),
]
_LEARNER_WRITE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(require_learner),
    Depends(enforce_session_write_limit),
]


@router.post(
    "/plans/estimate",
    response_model=EstimateResult,
    response_model_by_alias=True,
    summary="Estimate a plan (E15)",
    responses=_ERRORS,
    dependencies=_ESTIMATE_GUARDS,
)
def estimate_plan(
    body: EstimateRequest, response: Response, ctx: Session, service: Service
) -> EstimateResult:
    response.headers["Cache-Control"] = _NO_STORE
    return service.estimate(ctx, body)


@router.post(
    "/plans",
    response_model=Plan,
    response_model_by_alias=True,
    status_code=201,
    summary="Create a plan (E16)",
    responses=_ERRORS,
    dependencies=_LEARNER_WRITE_GUARDS,
)
def create_plan(
    body: CreatePlanRequest, response: Response, ctx: Session, service: Service
) -> Plan:
    response.headers["Cache-Control"] = _NO_STORE
    return service.create_plan(ctx, body)


@router.post(
    "/plans/{plan_id}/revise",
    response_model=Plan,
    response_model_by_alias=True,
    summary="Revise a plan (E17)",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def revise_plan(
    plan_id: UUID,
    body: RevisePlanRequest,
    response: Response,
    ctx: Session,
    service: Service,
) -> Plan:
    response.headers["Cache-Control"] = _NO_STORE
    return service.revise_plan(ctx, plan_id, body)


@router.post(
    "/plans/{plan_id}/resume",
    response_model=Plan,
    response_model_by_alias=True,
    summary="Resume a paused plan (E30)",
    responses=_ERRORS,
    dependencies=_LEARNER_WRITE_GUARDS,
)
def resume_plan(plan_id: UUID, response: Response, ctx: Session, service: Service) -> Plan:
    response.headers["Cache-Control"] = _NO_STORE
    return service.resume_plan(ctx, plan_id)
