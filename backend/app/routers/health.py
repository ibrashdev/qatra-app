"""Health endpoints: E01 liveness and E02 readiness (API-spec §4.1). Both are public."""

from __future__ import annotations

import ipaddress
import threading
from collections.abc import Callable
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


def _trusted_depth(request: Request) -> int:
    # ``scope["app"]`` is absent when a bare ``Request`` is built (tests).
    state = getattr(request.scope.get("app"), "state", None)
    settings: Settings | None = getattr(state, "settings", None)
    return settings.QATRA_TRUSTED_XFF_DEPTH if settings is not None else 0


def forwarded_client(header: str, depth: int) -> str | None:
    """The ``depth``-th entry from the right of an ``X-Forwarded-For`` value in canonical form
    (an IPv4-mapped IPv6 address becomes IPv4), or ``None`` when the header has fewer entries or
    the entry is not a plain IP address."""
    entries = header.split(",")
    if depth < 1 or len(entries) < depth:
        return None
    try:
        address = ipaddress.ip_address(entries[-depth].strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id is not None:
            return None
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
    return str(address)


def client_key(request: Request) -> str:
    """The client address behind ``QATRA_TRUSTED_XFF_DEPTH`` proxies: the key of every per-IP
    limiter and the source of the throttle prefix.

    Depth 0 is the peer address. Otherwise each trusted proxy appends the address it saw, so only
    the entries counted from the right are believed: the left ones are client-written. A short
    header or an entry that is not an IP falls back to the peer. Memory only: never log or return
    the address.
    """
    peer = request.client.host if request.client else "unknown"
    depth = _trusted_depth(request)
    if depth < 1:
        return peer
    header = ",".join(request.headers.getlist("x-forwarded-for"))
    return forwarded_client(header, depth) or peer


_limiter_lock = threading.Lock()


def ip_rate_limit(state_attr: str, setting_name: str) -> Callable[[Request], None]:
    """A dependency that counts requests per client address in the limiter
    ``app.state.<state_attr>``, created on first use with the limit of the setting
    ``setting_name``. Routers of one rate class share an instance by using the same name."""

    def enforce(request: Request) -> None:
        limiter: SlidingWindowLimiter | None = getattr(request.app.state, state_attr, None)
        if limiter is None:
            with _limiter_lock:
                limiter = getattr(request.app.state, state_attr, None)
                if limiter is None:
                    limit = getattr(get_settings(request), setting_name)
                    limiter = SlidingWindowLimiter(limit)
                    setattr(request.app.state, state_attr, limiter)
        decision = limiter.check(client_key(request))
        if not decision.allowed:
            raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)

    return enforce


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
