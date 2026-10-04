"""Session endpoints: E20 ``POST /api/sessions`` (package B5; API-spec §4.7).

The route lists ``require_valid_origin`` before ``require_session`` and then the per-IP "Session
write" limiter (60 per client IP per minute, API-spec §1.8, a configuration default). The body is
read as a plain JSON object and validated by ``SessionService.parse_request``: a ``kind`` union
with strict bodies and the rule names of API-spec E20 (``kind_invalid``, ``forbidden_field``,
``game_type_invalid``, ``self_rating_invalid``, ``scope_invalid``). The response is ``201`` for a
new session and ``200`` when the open daily session of the learning date is returned; it always
carries ``Cache-Control: no-store`` and no body, question or answer is ever logged.

The service is created by ``install_sessions`` and stored on ``app.state.sessions_service``;
without it the endpoint answers ``503 unavailable`` (nothing is faked).
``app.wiring.install_learning_core`` calls it for ``create_app`` and binds the ports to B4's plan
service; they may also be left on ``app.state.plan_access`` and ``app.state.learning_calendar``.

Request E20 (all other properties are refused):

- ``{"kind": "daily", "planId", "expectedPlanVersion"}``
- ``{"kind": "game", "planId", "expectedPlanVersion", "gameType"?, "passageIds"?}``
- ``{"kind": "placement", "editionId", "targetScope": {"sectionOrdinals": [...]}, "selfRating"?}``
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope
from app.contracts_sessions import SessionSnapshot
from app.dependencies import SessionContext, require_session, require_valid_origin
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.bank import BankRepository
from app.repositories.learning import LearningRepository
from app.routers.health import client_key
from app.services.sessions import (
    LearningCalendar,
    PlanAccess,
    SessionService,
    build_sessions_service,
)

router = APIRouter(prefix="/api", tags=["sessions"])

SESSION_WRITE_RATE_PER_MIN = 60  # configuration default (API-spec §1.8), not an approved number
_NO_STORE = "no-store"
_limiter_lock = threading.Lock()

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "version_conflict"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}


def get_sessions_service(request: Request) -> SessionService:
    service: SessionService | None = getattr(request.app.state, "sessions_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def enforce_session_write_limit(request: Request) -> None:
    """Session write class, per client IP (the address is never logged). The limiter lives on
    ``app.state.session_write_limiter``: a package that owns another operation of the class can
    share the instance by using the same name."""
    limiter: SlidingWindowLimiter | None = getattr(request.app.state, "session_write_limiter", None)
    if limiter is None:
        with _limiter_lock:
            limiter = getattr(request.app.state, "session_write_limiter", None)
            if limiter is None:
                limiter = SlidingWindowLimiter(SESSION_WRITE_RATE_PER_MIN)
                request.app.state.session_write_limiter = limiter
    decision = limiter.check(client_key(request))
    if not decision.allowed:
        raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)


Service = Annotated[SessionService, Depends(get_sessions_service)]
Session = Annotated[SessionContext, Depends(require_session)]
_WRITE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(enforce_session_write_limit),
]


@router.post(
    "/sessions",
    response_model=SessionSnapshot,
    response_model_by_alias=True,
    status_code=201,
    summary="Prepare a daily, game or placement session (E20)",
    responses={200: {"model": SessionSnapshot, "description": "the open daily session"}, **_ERRORS},
    dependencies=_WRITE_GUARDS,
)
def create_session(
    body: Annotated[dict[str, Any], Body()],
    response: Response,
    ctx: Session,
    service: Service,
) -> SessionSnapshot:
    response.headers["Cache-Control"] = _NO_STORE
    request = service.parse_request(body)
    created = service.create_session(ctx, request)
    response.status_code = 201 if created.created else 200
    return created.snapshot


def install_sessions(
    app: FastAPI,
    settings: Settings,
    *,
    plans: PlanAccess | None = None,
    calendar: LearningCalendar | None = None,
    bank: BankRepository | None = None,
    learning: LearningRepository | None = None,
    client: PostgrestClient | None = None,
    clock: Callable[[], datetime] | None = None,
    new_id: Callable[[], UUID] | None = None,
) -> None:
    """Include the E20 router once and build the services on ``app.state``.

    ``plans`` and ``calendar`` are the ports of package B4 and B3; when omitted, the ones left on
    ``app.state.plan_access`` and ``app.state.learning_calendar`` are used, and when there are none
    the endpoint answers ``503`` rather than guessing. ``bank`` and ``learning`` default to the
    repositories of the configured data backend (supabase mode builds them over ``client``; with
    neither the endpoint answers ``503``). Besides ``sessions_service`` this sets
    ``bank_repository`` and ``learning_repository`` so that later packages (B6, B9) share them.
    """
    if not getattr(app.state, "sessions_router_included", False):
        app.include_router(router)
        app.state.sessions_router_included = True
    service = build_sessions_service(
        settings,
        plans=plans if plans is not None else getattr(app.state, "plan_access", None),
        calendar=calendar
        if calendar is not None
        else getattr(app.state, "learning_calendar", None),
        bank=bank,
        learning=learning,
        client=client,
        clock=clock,
        new_id=new_id,
    )
    app.state.sessions_service = service
    if service is not None:
        app.state.bank_repository = service.bank
        app.state.learning_repository = service.learning
