"""Session endpoints: E20 ``POST /api/sessions`` (package B5), E21 ``POST /api/sessions/:id/events``
and E22 ``POST /api/sessions/:id/complete`` (package B6; API-spec §4.7).

The route lists ``require_valid_origin`` before ``require_session`` and then the per-IP "Session
write" limiter (``QATRA_RATE_SESSION_WRITE_PER_MIN``, API-spec §1.8). The body is
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

E21 takes ``{"events": [...]}`` (1 to 100 answer and activity events, API-spec E21) and answers
``200`` with the outcome of every event; there is no ``409``, conflicts are reported per event.
The session (404) is checked before the body (422). E22 takes no body (an empty body or ``{}`` is
ignored) and an optional ``Idempotency-Key`` header: a UUID, otherwise ``422``; the key adds no
semantics, completion is idempotent per session. Both use the Session write limiter and set
``Cache-Control: no-store``; neither the body, an answer nor a question is ever logged.

``install_sessions`` also includes the router of E18 and E19 (``routers/progress.py``) and builds
the ``ProgressService``, so the application factory and ``app/wiring.py`` need no change.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, Header, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope
from app.contracts_sessions import CompleteResponse, EventsResponse, SessionSnapshot
from app.dependencies import SessionContext, require_session, require_valid_origin
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.bank import BankRepository
from app.repositories.learning import LearningRepository
from app.routers.health import ip_rate_limit
from app.routers.progress import router as progress_router
from app.services.plans import PlanService
from app.services.progress import PlanDirectory, PlanServiceDirectory, ProgressService
from app.services.sessions import (
    LearningCalendar,
    PlanAccess,
    SessionService,
    build_sessions_service,
)

router = APIRouter(prefix="/api", tags=["sessions"])

_NO_STORE = "no-store"

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "version_conflict"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}
# E21 and E22 have no 409: conflicts are reported per event (E21) or are not possible (E22).
_EVENT_ERRORS = {
    **{code: spec for code, spec in _ERRORS.items() if code != 409},
    413: {"model": ErrorEnvelope, "description": "payload_too_large"},
}
_COMPLETE_ERRORS = {code: spec for code, spec in _ERRORS.items() if code != 409}
_UUID_TEXT = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def get_sessions_service(request: Request) -> SessionService:
    service: SessionService | None = getattr(request.app.state, "sessions_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


# Shared by name with the other Session write operations (``session_write_limiter``).
enforce_session_write_limit = ip_rate_limit(
    "session_write_limiter", "QATRA_RATE_SESSION_WRITE_PER_MIN"
)


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


@router.post(
    "/sessions/{session_id}/events",
    response_model=EventsResponse,
    response_model_by_alias=True,
    summary="Record answers and active time of a session (E21)",
    responses=_EVENT_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def record_events(
    session_id: UUID,
    body: Annotated[dict[str, Any], Body()],
    response: Response,
    ctx: Session,
    service: Service,
) -> EventsResponse:
    response.headers["Cache-Control"] = _NO_STORE
    return service.record_events(ctx, session_id, body)


@router.post(
    "/sessions/{session_id}/complete",
    response_model=CompleteResponse,
    response_model_by_alias=True,
    summary="Complete a session and return its summary (E22)",
    responses=_COMPLETE_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def complete_session(
    session_id: UUID,
    response: Response,
    ctx: Session,
    service: Service,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> CompleteResponse:
    response.headers["Cache-Control"] = _NO_STORE
    if idempotency_key is not None and not _UUID_TEXT.match(idempotency_key):
        raise AppError(
            ErrorCode.validation_error,
            details={"fields": [{"field": "Idempotency-Key", "rule": "uuid_parsing"}]},
        )
    return service.complete_session(ctx, session_id)


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
    plan_directory: PlanDirectory | None = None,
    open_chat_lookup: Callable[[SessionContext], UUID | None] | None = None,
) -> None:
    """Include the routers of E20 to E22 and E18 and E19 once and build the services on
    ``app.state``.

    ``plans`` and ``calendar`` are the ports of package B4 and B3; when omitted, the ones left on
    ``app.state.plan_access`` and ``app.state.learning_calendar`` are used, and when there are none
    the endpoint answers ``503`` rather than guessing. ``bank`` and ``learning`` default to the
    repositories of the configured data backend (supabase mode builds them over ``client``; with
    neither the endpoint answers ``503``). Besides ``sessions_service`` this sets
    ``bank_repository`` and ``learning_repository`` so that later packages (B9) share them.

    E18 and E19 need the plans of the account: ``plan_directory`` (a ``PlanDirectory``) or, when it
    is omitted, a ``PlanServiceDirectory`` over ``app.state.plan_service``, which the application
    wiring sets before it calls this function; without either they answer ``503``.
    ``open_chat_lookup`` is the seam that lets ``Today.openPlanChatId`` name the open plan
    conversation; without it the field is ``null``.
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
    if not getattr(app.state, "progress_router_included", False):
        app.include_router(progress_router)
        app.state.progress_router_included = True
    app.state.progress_service = None
    if service is not None:
        app.state.bank_repository = service.bank
        app.state.learning_repository = service.learning
        directory = plan_directory
        plan_service: PlanService | None = getattr(app.state, "plan_service", None)
        if directory is None and plan_service is not None:
            directory = PlanServiceDirectory(plan_service)
        if directory is not None:
            app.state.progress_service = ProgressService(
                bank=service.bank,
                learning=service.learning,
                plans=directory,
                calendar=service.calendar,
                open_chat_lookup=open_chat_lookup,
            )
