"""Content manager web admin routes (D91, docs/Content-admin.md section 4), prefix ``/api/admin``.

Every route is for a content manager only. Guards, in this order: ``require_valid_origin`` (every
POST and PATCH), the session (``require_session_details``: ``401 unauthenticated``, ``400
terms_required``), ``require_content_manager`` (``403 forbidden`` for a signed-in account that is
not named in ``QATRA_CONTENT_MANAGER_USERNAMES``, for a demo session and when the setting is empty)
and the per-client-IP admin limiter ``QATRA_RATE_ADMIN_PER_MIN``. A missing service answers
``503 unavailable``. Deletes are POSTs (the ``POST /api/account/delete`` convention, A-10) and
answer ``204``. Every response is ``Cache-Control: no-store``; bodies forbid unknown fields.

Handlers are synchronous (the database calls block), so they run in the framework's thread pool.
The one log event of a state-changing request is written by the service.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope
from app.contracts_content_admin import (
    AccessResponse,
    BooksResponse,
    CategoriesResponse,
    EditionDetail,
    ExpectedVersionRequest,
    Overview,
    PatchBookRequest,
    PatchCategoryRequest,
    PatchEditionRequest,
    PatchSectionRequest,
    PatchSourceRequest,
    SectionDetail,
    SourcesResponse,
    WithdrawEditionRequest,
)
from app.contracts_content_admin import Book as BookDto
from app.contracts_content_admin import Category as CategoryDto
from app.contracts_content_admin import Source as SourceDto
from app.dependencies import (
    ResolvedSession,
    get_settings,
    require_session_details,
    require_valid_origin,
)
from app.domain.content_admin_policy import is_content_manager
from app.errors import AppError, ErrorCode
from app.routers.health import ip_rate_limit
from app.services.content_admin import ContentAdminService

router = APIRouter(prefix="/api/admin", tags=["content-admin"])

_NO_STORE = "no-store"

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden or forbidden_origin"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {
        "model": ErrorEnvelope,
        "description": "version_conflict (details.reason: stale, in_use or state)",
    },
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}

enforce_admin_limit = ip_rate_limit("admin_limiter", "QATRA_RATE_ADMIN_PER_MIN")


def require_content_manager(
    resolved: Annotated[ResolvedSession, Depends(require_session_details)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    """Only an account named in ``QATRA_CONTENT_MANAGER_USERNAMES`` (normalized like a username
    lookup key) may use the admin; a demo session never may; an empty setting means nobody."""
    allowed = is_content_manager(
        settings.QATRA_CONTENT_MANAGER_USERNAMES,
        resolved.username,
        is_demo=resolved.context.is_demo,
    )
    if not allowed:
        raise AppError(ErrorCode.forbidden)


def get_content_admin_service(request: Request) -> ContentAdminService:
    service: ContentAdminService | None = getattr(request.app.state, "content_admin_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = _NO_STORE


Service = Annotated[ContentAdminService, Depends(get_content_admin_service)]
_READ_GUARDS = [
    Depends(require_session_details),
    Depends(require_content_manager),
    Depends(enforce_admin_limit),
    Depends(_no_store),
]
_WRITE_GUARDS = [Depends(require_valid_origin), *_READ_GUARDS]


def _no_content() -> Response:
    return Response(status_code=204, headers={"Cache-Control": _NO_STORE})


# --- access and overview -------------------------------------------------------------------------


@router.get(
    "/access",
    response_model=AccessResponse,
    response_model_by_alias=True,
    summary="Is the signed-in account a content manager",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_access() -> AccessResponse:
    return AccessResponse(content_manager=True)


@router.get(
    "/overview",
    response_model=Overview,
    response_model_by_alias=True,
    summary="Counts, editions and the AI status card",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_overview(service: Service) -> Overview:
    return service.overview()


# --- editions -----------------------------------------------------------------------------------


@router.get(
    "/editions/{edition_id}",
    response_model=EditionDetail,
    response_model_by_alias=True,
    summary="One edition with its sections, jobs and allowed actions",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_edition(edition_id: UUID, service: Service) -> EditionDetail:
    return service.edition_detail(edition_id)


@router.patch(
    "/editions/{edition_id}",
    response_model=EditionDetail,
    response_model_by_alias=True,
    summary="Rename an edition label",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def patch_edition(edition_id: UUID, body: PatchEditionRequest, service: Service) -> EditionDetail:
    return service.patch_edition(edition_id, body)


@router.post(
    "/editions/{edition_id}/withdraw",
    response_model=EditionDetail,
    response_model_by_alias=True,
    summary="Withdraw a published edition (irreversible)",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def withdraw_edition(
    edition_id: UUID, body: WithdrawEditionRequest, service: Service
) -> EditionDetail:
    return service.withdraw_edition(edition_id, body)


@router.post(
    "/editions/{edition_id}/archive",
    response_model=EditionDetail,
    response_model_by_alias=True,
    summary="Hide a published edition from the catalog (reversible)",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def archive_edition(
    edition_id: UUID, body: ExpectedVersionRequest, service: Service
) -> EditionDetail:
    return service.archive_edition(edition_id, body)


@router.post(
    "/editions/{edition_id}/unarchive",
    response_model=EditionDetail,
    response_model_by_alias=True,
    summary="Show a hidden published edition again",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def unarchive_edition(
    edition_id: UUID, body: ExpectedVersionRequest, service: Service
) -> EditionDetail:
    return service.unarchive_edition(edition_id, body)


@router.post(
    "/editions/{edition_id}/delete",
    status_code=204,
    response_class=Response,
    summary="Delete a never-published draft edition",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def delete_edition(edition_id: UUID, body: ExpectedVersionRequest, service: Service) -> Response:
    service.delete_edition(edition_id, body)
    return _no_content()


# --- sections -----------------------------------------------------------------------------------


@router.get(
    "/sections/{section_id}",
    response_model=SectionDetail,
    response_model_by_alias=True,
    summary="One section with its original units (read only)",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_section(section_id: UUID, service: Service) -> SectionDetail:
    return service.section_detail(section_id)


@router.patch(
    "/sections/{section_id}",
    response_model=SectionDetail,
    response_model_by_alias=True,
    summary="Rename a section",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def patch_section(section_id: UUID, body: PatchSectionRequest, service: Service) -> SectionDetail:
    return service.patch_section(section_id, body)


# --- books --------------------------------------------------------------------------------------


@router.get(
    "/books",
    response_model=BooksResponse,
    response_model_by_alias=True,
    summary="Books and the category options",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_books(service: Service) -> BooksResponse:
    return service.books()


@router.patch(
    "/books/{book_id}",
    response_model=BookDto,
    response_model_by_alias=True,
    summary="Edit a book's titles, author or category",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def patch_book(book_id: UUID, body: PatchBookRequest, service: Service) -> BookDto:
    return service.patch_book(book_id, body)


@router.post(
    "/books/{book_id}/delete",
    status_code=204,
    response_class=Response,
    summary="Delete a book that no edition uses",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def delete_book(book_id: UUID, body: ExpectedVersionRequest, service: Service) -> Response:
    service.delete_book(book_id, body)
    return _no_content()


# --- categories ---------------------------------------------------------------------------------


@router.get(
    "/categories",
    response_model=CategoriesResponse,
    response_model_by_alias=True,
    summary="Categories",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_categories(service: Service) -> CategoriesResponse:
    return service.categories()


@router.patch(
    "/categories/{category_id}",
    response_model=CategoryDto,
    response_model_by_alias=True,
    summary="Edit a category's labels or display order",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def patch_category(category_id: UUID, body: PatchCategoryRequest, service: Service) -> CategoryDto:
    return service.patch_category(category_id, body)


@router.post(
    "/categories/{category_id}/delete",
    status_code=204,
    response_class=Response,
    summary="Delete a category that no book uses",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def delete_category(category_id: UUID, body: ExpectedVersionRequest, service: Service) -> Response:
    service.delete_category(category_id, body)
    return _no_content()


# --- sources ------------------------------------------------------------------------------------


@router.get(
    "/sources",
    response_model=SourcesResponse,
    response_model_by_alias=True,
    summary="Sources",
    responses=_ERRORS,
    dependencies=_READ_GUARDS,
)
def read_sources(service: Service) -> SourcesResponse:
    return service.sources()


@router.patch(
    "/sources/{source_id}",
    response_model=SourceDto,
    response_model_by_alias=True,
    summary="Edit a source's title, provider, license link or rights status",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def patch_source(source_id: UUID, body: PatchSourceRequest, service: Service) -> SourceDto:
    return service.patch_source(source_id, body)


@router.post(
    "/sources/{source_id}/delete",
    status_code=204,
    response_class=Response,
    summary="Delete a source that no edition uses",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def delete_source(source_id: UUID, body: ExpectedVersionRequest, service: Service) -> Response:
    service.delete_source(source_id, body)
    return _no_content()
