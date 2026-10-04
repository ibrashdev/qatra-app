"""Request dependencies: settings, Origin check and session (stub in B0)."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import Request

from app.config import Settings
from app.domain.origin_policy import is_origin_allowed
from app.errors import AppError, ErrorCode


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def require_valid_origin(request: Request) -> None:
    """State-changing requests must carry ``Origin`` equal to ``FRONTEND_ORIGIN`` exactly.

    A missing header counts as a mismatch. GET, HEAD and OPTIONS never change state and are
    exempt. ``OriginGuardMiddleware`` already enforces this before routing, body processing
    and authentication (API-spec §1.3); this dependency documents the rule on each route and
    double-checks it. Declare it first on every mutation, before ``require_session``.
    """
    expected = get_settings(request).FRONTEND_ORIGIN
    if not is_origin_allowed(request.method, request.headers.get("origin"), expected):
        raise AppError(ErrorCode.forbidden_origin)


@dataclass(frozen=True, slots=True)
class SessionContext:
    """Identity resolved from the server-side session. Fields only in B0."""

    user_id: UUID
    is_demo: bool
    auth_epoch: int


def require_session(request: Request) -> SessionContext:
    """STUB: always denies. B3 implements the cookie, expiry and ``auth_epoch`` checks.

    Identity must come only from the server-side session, never from a header or query
    parameter, so this stub deliberately reads nothing from the request.
    """
    raise AppError(ErrorCode.unauthenticated)
