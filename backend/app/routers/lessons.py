"""The lessons reader: ``GET /api/lessons`` and ``GET /api/lessons/{sectionId}`` (D92, owner
approval of 5 Oct 2026: the lessons tab, a session without games that only shows the verses or
hadiths of the learner's own plan, read only).

Both are "Session read" operations like E18 and E19: a valid session (``require_session``) and the
per-IP limiter ``QATRA_RATE_SESSION_READ_PER_MIN`` shared by name with the other reads. A GET
changes nothing and every response carries ``Cache-Control: no-store``. The service is built by
``app.wiring.install_learning_core`` (``install_lessons``) over the bank repository and the plan
directory of the sessions package and stored on ``app.state.lessons_service``; without it the
endpoints answer ``503 unavailable``.

Errors: ``401`` without a session, ``409 version_conflict`` (``details.reason =
"plan_not_active"``) for an account without an active plan, ``404 not_found`` for a section outside
the active plan's scope and selected paths (or an edition that is no longer readable), ``422`` for a
section id that is not a positive number, ``429``, ``503``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi import Path as PathParam

from app.contracts import ErrorEnvelope
from app.contracts_lessons import LessonSectionDetail, LessonsResponse
from app.dependencies import SessionContext, require_session
from app.errors import AppError, ErrorCode
from app.repositories.bank import BankRepository
from app.routers.health import ip_rate_limit
from app.services.lessons import LessonService
from app.services.progress import PlanDirectory

router = APIRouter(prefix="/api", tags=["lessons"])

_NO_STORE = "no-store"

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    409: {"model": ErrorEnvelope, "description": "version_conflict: plan_not_active"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}
_DETAIL_ERRORS = {**_ERRORS, 404: {"model": ErrorEnvelope, "description": "not_found"}}

# Shared by name with the other Session read operations (``session_read_limiter``).
enforce_session_read_limit = ip_rate_limit(
    "session_read_limiter", "QATRA_RATE_SESSION_READ_PER_MIN"
)


def get_lessons_service(request: Request) -> LessonService:
    service: LessonService | None = getattr(request.app.state, "lessons_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


Service = Annotated[LessonService, Depends(get_lessons_service)]
Session = Annotated[SessionContext, Depends(require_session)]
_READ_GUARDS = [Depends(require_session), Depends(enforce_session_read_limit)]


@router.get(
    "/lessons",
    response_model=LessonsResponse,
    response_model_by_alias=True,
    summary="The sections of the learner's active plan, to read (lessons)",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def list_lessons(response: Response, ctx: Session, service: Service) -> LessonsResponse:
    response.headers["Cache-Control"] = _NO_STORE
    return service.list_sections(ctx)


@router.get(
    "/lessons/{section_id}",
    response_model=LessonSectionDetail,
    response_model_by_alias=True,
    summary="The text of one section of the learner's active plan (lessons)",
    responses=_DETAIL_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_lesson(
    section_id: Annotated[int, PathParam(ge=1)],
    response: Response,
    ctx: Session,
    service: Service,
) -> LessonSectionDetail:
    response.headers["Cache-Control"] = _NO_STORE
    return service.read_section(ctx, section_id)


def install_lessons(
    app: FastAPI, *, bank: BankRepository | None, plans: PlanDirectory | None
) -> None:
    """Build the service on ``app.state.lessons_service`` (the routes are included by
    ``create_app``). Without the bank repository or the plan directory, which is the case in
    supabase mode without its configuration, the endpoints answer ``503``. Calling it again
    replaces the service and keeps the routes."""
    app.state.lessons_service = (
        None if bank is None or plans is None else LessonService(bank=bank, plans=plans)
    )
