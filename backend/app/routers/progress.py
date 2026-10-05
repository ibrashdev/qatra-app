"""Today and progress: E18 ``GET /api/today`` and E19 ``GET /api/progress`` (package B6;
API-spec §4.6).

Both are "Session read" operations: a valid session (``require_session``) and the per-IP limiter
``QATRA_RATE_SESSION_READ_PER_MIN`` (API-spec §1.8), shared by name with the other reads. A GET
never changes anything. Every response carries ``Cache-Control: no-store`` and nothing of the
learner's data is logged. The service is created by ``install_sessions`` and stored on
``app.state.progress_service``; without it the endpoints answer ``503 unavailable``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.contracts import ErrorEnvelope
from app.contracts_sessions import ProgressResponse, Today
from app.dependencies import SessionContext, require_session
from app.errors import AppError, ErrorCode
from app.routers.health import ip_rate_limit
from app.services.progress import ProgressService

router = APIRouter(prefix="/api", tags=["progress"])

_NO_STORE = "no-store"

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}

# Shared by name with the other Session read operations (``session_read_limiter``).
enforce_session_read_limit = ip_rate_limit(
    "session_read_limiter", "QATRA_RATE_SESSION_READ_PER_MIN"
)


def get_progress_service(request: Request) -> ProgressService:
    service: ProgressService | None = getattr(request.app.state, "progress_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


Service = Annotated[ProgressService, Depends(get_progress_service)]
Session = Annotated[SessionContext, Depends(require_session)]
_READ_GUARDS = [Depends(require_session), Depends(enforce_session_read_limit)]


@router.get(
    "/today",
    response_model=Today,
    response_model_by_alias=True,
    summary="The learner's day (E18)",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_today(response: Response, ctx: Session, service: Service) -> Today:
    response.headers["Cache-Control"] = _NO_STORE
    return service.read_today(ctx)


@router.get(
    "/progress",
    response_model=ProgressResponse,
    response_model_by_alias=True,
    summary="Daily progress, history and overall progress per plan (E19)",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_progress(response: Response, ctx: Session, service: Service) -> ProgressResponse:
    response.headers["Cache-Control"] = _NO_STORE
    return service.read_progress(ctx)
