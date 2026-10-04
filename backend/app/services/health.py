"""Health services (E01, E02)."""

from __future__ import annotations

from datetime import UTC, datetime

from app.config import Settings
from app.contracts import HealthResponse, ReadyResponse
from app.errors import AppError, ErrorCode
from app.providers.database import RestrictedDatabase


def read_health_status(settings: Settings, now: datetime) -> HealthResponse:
    """Liveness: no database, no authentication; time at whole-second UTC precision."""
    return HealthResponse(
        status="ok",
        version=settings.APP_VERSION,
        time=now.astimezone(UTC).replace(microsecond=0),
    )


def read_ready_status(database: RestrictedDatabase) -> ReadyResponse:
    """Readiness: a trivial query through the restricted role. Failure exposes no detail."""
    try:
        database.ping()
    except Exception:
        raise AppError(ErrorCode.unavailable) from None
    return ReadyResponse(status="ok")
