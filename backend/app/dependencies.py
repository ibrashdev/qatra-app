"""Request dependencies: settings, Origin check and the session (API-spec §1.3).

``require_session`` resolves the session cookie through the limited database role: a missing,
revoked or expired session, or one whose ``auth_epoch`` is no longer the account's, answers
``401 unauthenticated`` (and the response clears the cookie, API-spec O-14). The Supabase access
token is refreshed server-side and handed to repositories through ``SessionContext`` so that
row-level security applies (§1.3). While the account has not accepted the current terms (E04
``reconsentRequired``) every Session operation except E05, E10 and E11 answers
``400 terms_required`` (O-10): ``require_session`` enforces it, the ``*_allow_reconsent``
variants do not.

The resolver itself (cookie decoding, cryptography, refresh, storage) is installed on
``app.state.session_resolver`` by ``install_auth`` (B3). While none is installed the dependency
keeps the B0 behaviour and always denies, so packages and tests that do not wire authentication
stay valid.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol
from uuid import UUID

from fastapi import Request
from pydantic import SecretStr

from app.config import Settings
from app.domain.origin_policy import is_origin_allowed
from app.errors import AppError, ErrorCode

if TYPE_CHECKING:
    from app.services.session_crypto import TokenBundle


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
    """Identity resolved from the server-side session (B3 fills it; routes never build it).

    ``session_id`` is the ``app_sessions`` row. ``access_token`` is the learner's current
    Supabase access token, decrypted and refreshed server-side by B3; repositories use it so
    that row-level security applies (API-spec §1.3). It is ``None`` in memory mode, is never
    returned to the browser, and is excluded from ``repr`` and comparisons.
    """

    user_id: UUID
    is_demo: bool
    auth_epoch: int
    session_id: UUID | None = None
    access_token: SecretStr | None = field(default=None, repr=False, compare=False)


class SessionEndedError(AppError):
    """``401 unauthenticated`` from a session check. Its response also clears the session
    cookie (API-spec O-14, decided A-12): ``install_auth`` registers the handler that adds the
    ``Set-Cookie``. Without it the error is an ordinary ``AppError`` response."""

    def __init__(self) -> None:
        super().__init__(ErrorCode.unauthenticated)


@dataclass(frozen=True, slots=True)
class ResolvedSession:
    """A live session with the server-side details the authentication routes need.

    ``context`` is what every other package receives. ``username`` is the display name and
    ``internal_alias`` the Supabase Auth alias (both from the account handle); ``session_hash``
    identifies the session row; ``tokens`` are the decrypted Supabase tokens. None of them is
    ever returned to the browser or shown in ``repr``."""

    context: SessionContext
    username: str
    internal_alias: str = field(repr=False)
    session_hash: bytes = field(repr=False)
    tokens: TokenBundle = field(repr=False)


class SessionResolver(Protocol):
    """Installed on ``app.state.session_resolver`` by ``install_auth``."""

    cookie_name: str

    def resolve(self, cookie_value: str | None, *, enforce_terms: bool) -> ResolvedSession:
        """Resolve a cookie value to a live session. Raises ``SessionEndedError`` (401), an
        ``AppError`` ``terms_required`` (400, only when ``enforce_terms``) or ``unavailable``
        (503)."""


def _installed_resolver(request: Request) -> SessionResolver | None:
    # ``scope["app"]`` is absent when a dependency is called with a bare ``Request`` (tests).
    state = getattr(request.scope.get("app"), "state", None)
    resolver: SessionResolver | None = getattr(state, "session_resolver", None)
    return resolver


def _resolve(request: Request, *, enforce_terms: bool) -> ResolvedSession:
    resolver = _installed_resolver(request)
    if resolver is None:
        # B0 behaviour: no resolver, no session. Identity never comes from a header or query.
        raise AppError(ErrorCode.unauthenticated)
    return resolver.resolve(request.cookies.get(resolver.cookie_name), enforce_terms=enforce_terms)


def require_session(request: Request) -> SessionContext:
    """The identity of the caller, from the server-side session only.

    ``401 unauthenticated`` without a live session; ``400 terms_required`` (with
    ``details.requiredVersion``) while the account has not accepted the current terms. Use
    ``require_session_allow_reconsent`` for E05, E10 and E11 only."""
    return _resolve(request, enforce_terms=True).context


def require_session_allow_reconsent(request: Request) -> SessionContext:
    """As ``require_session`` but without the terms gate (E05 consent, E11 profile)."""
    return _resolve(request, enforce_terms=False).context


def require_session_details(request: Request) -> ResolvedSession:
    """As ``require_session``, returning the server-side details (authentication routes)."""
    return _resolve(request, enforce_terms=True)


def require_session_details_allow_reconsent(request: Request) -> ResolvedSession:
    """As ``require_session_allow_reconsent``, returning the server-side details."""
    return _resolve(request, enforce_terms=False)
