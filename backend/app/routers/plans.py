"""Plan endpoints E15, E16, E17 and E30 (API-spec §4.5).

Every route lists ``require_valid_origin`` before ``require_session`` (E15 is a POST too), then the
per-client-IP rate limit of its class (API-spec §1.8: "Session read" for E15, "Session write" for
E16, E17 and E30). E16 and E30 are for learner accounts only: a demo account is refused with
``403 forbidden`` before the body is looked at. Bodies are validated strictly (S-1); no endpoint
accepts a user id, a demo flag or a mode. Handlers are synchronous (database calls block), so they
run in the framework's thread pool. Plan data, ids and estimates are never logged here.

The per-IP numbers are the ``QATRA_RATE_*`` settings (configuration defaults of A-12, not approved
numbers). The limiters are kept in ``app.state`` by class name, so a package of the same class
shares one with ``ip_rate_limit``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from app.contracts import ErrorEnvelope
from app.contracts_plan_chat import EstimateResult, Plan
from app.contracts_plans import CreatePlanRequest, EstimateRequest, RevisePlanRequest
from app.dependencies import SessionContext, require_session, require_valid_origin
from app.errors import AppError, ErrorCode
from app.routers.health import ip_rate_limit
from app.services.plans import PlanService

router = APIRouter(prefix="/api", tags=["plans"])

_NO_STORE = "no-store"

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin or forbidden (demo account)"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "version_conflict"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}


enforce_session_read_limit = ip_rate_limit(
    "session_read_limiter", "QATRA_RATE_SESSION_READ_PER_MIN"
)
enforce_session_write_limit = ip_rate_limit(
    "session_write_limiter", "QATRA_RATE_SESSION_WRITE_PER_MIN"
)

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
