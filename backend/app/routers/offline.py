"""Offline endpoints: E23 ``POST /api/plans/:id/offline-snapshots``, E24
``GET /api/offline-snapshots/:id`` and E25 ``POST /api/offline/revalidate`` (package B9;
API-spec §4.8, D46, D58, D59).

Both POSTs list ``require_valid_origin`` before ``require_session`` (demo accounts are allowed) and
then the per-IP "Session write" limiter (``QATRA_RATE_SESSION_WRITE_PER_MIN``, 60); the GET uses
the "Session read" limiter (``QATRA_RATE_SESSION_READ_PER_MIN``, 120). Both limiters are shared by
name with the other session operations. Every response carries ``Cache-Control: no-store``; no
body, answer, question or snapshot is ever logged.

E23 answers ``201`` for a new snapshot and ``200`` with the same snapshot when the same
``clientOperationId`` repeats with the same input. The body is read as a plain JSON object and
validated by ``OfflineService.parse_create`` (rule names of API-spec E23). E24 reads only and never
creates a session; a snapshot of a revoked edition is ``404``. E25 answers ``200`` with the status
in the body.

The service is created by ``install_offline`` (called from ``install_sessions``, which owns the
bank, the learning repository and the plan ports it shares) and stored on
``app.state.offline_service``; without it the endpoints answer ``503 unavailable``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, FastAPI, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope
from app.contracts_offline import OfflinePlanSnapshot, RevalidationResult
from app.dependencies import SessionContext, require_session, require_valid_origin
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.bank import EditionInfo
from app.repositories.learning import InMemoryLearningStore
from app.repositories.offline import (
    InMemoryOfflineRepository,
    OfflineRepository,
    PostgrestOfflineRepository,
)
from app.routers.health import ip_rate_limit
from app.services.offline import OfflineService
from app.services.sessions import SessionService

router = APIRouter(prefix="/api", tags=["offline"])

_NO_STORE = "no-store"

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "version_conflict"},
    413: {"model": ErrorEnvelope, "description": "payload_too_large"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}
# E24 is a GET (no body, no origin check, no state conflict); E25 has no 409 (the status is data).
_READ_ERRORS = {code: _ERRORS[code] for code in (401, 404, 429, 503)}
_REVALIDATE_ERRORS = {code: spec for code, spec in _ERRORS.items() if code != 409}

# Shared by name with the other Session operations.
enforce_session_write_limit = ip_rate_limit(
    "session_write_limiter", "QATRA_RATE_SESSION_WRITE_PER_MIN"
)
enforce_session_read_limit = ip_rate_limit(
    "session_read_limiter", "QATRA_RATE_SESSION_READ_PER_MIN"
)


def get_offline_service(request: Request) -> OfflineService:
    service: OfflineService | None = getattr(request.app.state, "offline_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


Service = Annotated[OfflineService, Depends(get_offline_service)]
Session = Annotated[SessionContext, Depends(require_session)]
_WRITE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(enforce_session_write_limit),
]
_READ_GUARDS = [Depends(require_session), Depends(enforce_session_read_limit)]


@router.post(
    "/plans/{plan_id}/offline-snapshots",
    response_model=OfflinePlanSnapshot,
    response_model_by_alias=True,
    status_code=201,
    summary="Prepare an offline snapshot of an active plan (E23)",
    responses={200: {"model": OfflinePlanSnapshot, "description": "the same snapshot"}, **_ERRORS},
    dependencies=_WRITE_GUARDS,
)
def create_offline_snapshot(
    plan_id: UUID,
    body: Annotated[dict[str, Any], Body()],
    response: Response,
    ctx: Session,
    service: Service,
) -> OfflinePlanSnapshot:
    response.headers["Cache-Control"] = _NO_STORE
    request = service.parse_create(body)
    created = service.create_snapshot(ctx, plan_id, request)
    response.status_code = 201 if created.created else 200
    return created.snapshot


@router.get(
    "/offline-snapshots/{snapshot_id}",
    response_model=OfflinePlanSnapshot,
    response_model_by_alias=True,
    summary="Read an owned offline snapshot (E24)",
    responses=_READ_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_offline_snapshot(
    snapshot_id: UUID, response: Response, ctx: Session, service: Service
) -> OfflinePlanSnapshot:
    response.headers["Cache-Control"] = _NO_STORE
    return service.read_snapshot(ctx, snapshot_id)


@router.post(
    "/offline/revalidate",
    response_model=RevalidationResult,
    response_model_by_alias=True,
    summary="Revalidate a downloaded snapshot (E25)",
    responses=_REVALIDATE_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def revalidate_offline_snapshot(
    body: Annotated[dict[str, Any], Body()],
    response: Response,
    ctx: Session,
    service: Service,
) -> RevalidationResult:
    response.headers["Cache-Control"] = _NO_STORE
    return service.revalidate(ctx, service.parse_revalidate(body))


def install_offline(
    app: FastAPI,
    settings: Settings,
    *,
    sessions: SessionService | None,
    repository: OfflineRepository | None = None,
    client: PostgrestClient | None = None,
    new_id: Callable[[], UUID] | None = None,
    rights_rejected: Callable[[EditionInfo], bool] | None = None,
) -> None:
    """Include the router of E23 to E25 once and build the service on ``app.state``.

    The service shares the bank, learning repository, plan port, calendar and clock of
    ``sessions`` (the ``SessionService`` of E20 to E22). ``repository`` defaults to the one of the
    learning repository in use: memory mode (an ``InMemoryLearningStore``) keeps the snapshots next
    to it; otherwise it is built over ``client``. With neither (or without ``sessions``) the
    endpoints answer ``503``; nothing is faked. ``rights_rejected`` is the optional rights check of
    an edition (G-12).
    """
    if not getattr(app.state, "offline_router_included", False):
        app.include_router(router)
        app.state.offline_router_included = True
    app.state.offline_service = None
    if sessions is None:
        return
    if repository is None:
        learning = sessions.learning
        if isinstance(learning, InMemoryLearningStore):
            repository = InMemoryOfflineRepository(learning)
        elif client is not None:
            repository = PostgrestOfflineRepository(client)
        else:
            return
    app.state.offline_service = OfflineService(
        sessions=sessions,
        repository=repository,
        new_id=new_id,
        rights_rejected=rights_rejected,
    )
