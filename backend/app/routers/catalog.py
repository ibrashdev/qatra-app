"""The public catalog, E14 ``GET /api/catalog`` (API-spec §4.4).

Public: no session is required and a session cookie, if one is sent, is never read; visitors,
learners and demo accounts receive the same metadata-only payload (D71). Rate class "Public read"
(per client IP). The response is ``Cache-Control: no-store`` (A-12, O-07).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.contracts import ErrorEnvelope
from app.contracts_plan_chat import CamelModel, CatalogEdition
from app.errors import AppError, ErrorCode
from app.routers.plans import PUBLIC_READ_RATE_PER_MIN, ip_rate_limit
from app.services.catalog import CatalogService

router = APIRouter(prefix="/api", tags=["catalog"])

_NO_STORE = "no-store"
enforce_public_read_limit = ip_rate_limit("public_read_limiter", PUBLIC_READ_RATE_PER_MIN)


class CatalogResponse(CamelModel):
    editions: list[CatalogEdition]


def get_catalog_service(request: Request) -> CatalogService:
    service: CatalogService | None = getattr(request.app.state, "catalog_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


Service = Annotated[CatalogService, Depends(get_catalog_service)]


@router.get(
    "/catalog",
    response_model=CatalogResponse,
    response_model_by_alias=True,
    summary="Public catalog (E14)",
    responses={
        429: {"model": ErrorEnvelope, "description": "throttled"},
        503: {"model": ErrorEnvelope, "description": "unavailable"},
    },
    dependencies=[Depends(enforce_public_read_limit)],
)
def get_catalog(response: Response, service: Service) -> CatalogResponse:
    """Published, non-revoked, non-hidden editions: metadata only (no text, lessons, questions
    or canonical URLs)."""
    response.headers["Cache-Control"] = _NO_STORE
    return CatalogResponse(editions=service.list_editions())
