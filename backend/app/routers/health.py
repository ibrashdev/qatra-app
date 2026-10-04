"""Health endpoints: E01 liveness and E02 readiness (API-spec §4.1). Both are public."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope, HealthResponse, ReadyResponse
from app.dependencies import get_settings
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import AppError, ErrorCode
from app.providers import database as database_provider
from app.services.health import read_health_status, read_ready_status

# The router declares its full ``/api`` prefix itself (not through ``include_router``): the
# access log reads the route template from the matched route, which must be the full path.
router = APIRouter(prefix="/api", tags=["health"])

_NO_STORE = "no-store"


def client_key(request: Request) -> str:
    """Rate-limit key: the peer address as the server sees it.

    Trusted-proxy handling of ``X-Forwarded-For`` on Render is verified at provisioning
    (P2) and is not assumed here. The address is used in memory only and must never be
    logged or returned.
    """
    return request.client.host if request.client else "unknown"


def enforce_ready_rate_limit(request: Request) -> None:
    limiter: SlidingWindowLimiter = request.app.state.ready_limiter
    decision = limiter.check(client_key(request))
    if not decision.allowed:
        raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)


@router.get("/health", response_model=HealthResponse, summary="Liveness (E01)")
async def read_health(
    response: Response, settings: Annotated[Settings, Depends(get_settings)]
) -> HealthResponse:
    """No database, no authentication, minimal body."""
    response.headers["Cache-Control"] = _NO_STORE
    return read_health_status(settings, datetime.now(UTC))


@router.get(
    "/health/ready",
    response_model=ReadyResponse,
    summary="Readiness (E02)",
    responses={
        429: {"model": ErrorEnvelope, "description": "throttled"},
        503: {"model": ErrorEnvelope, "description": "unavailable"},
    },
    dependencies=[Depends(enforce_ready_rate_limit)],
)
def read_ready(
    response: Response, settings: Annotated[Settings, Depends(get_settings)]
) -> ReadyResponse:
    """Trivial database query over the restricted role (blocking call, so a sync handler)."""
    response.headers["Cache-Control"] = _NO_STORE
    database = database_provider.open_restricted_database(settings)
    return read_ready_status(database)
