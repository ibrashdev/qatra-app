"""Authentication endpoints E03-E10 (API-spec §4.2) and the package wiring (``install_auth``).

Every mutation lists ``require_valid_origin`` first, then its per-IP limiter, then (Session level)
the session. Handlers are synchronous: they call the database and the identity provider, so the
framework runs them in its thread pool. Bodies, passwords, recovery codes, grants, usernames,
cookies and addresses are never logged here (API-spec §1.12).

The session cookie (contract §6): production ``__Host-qatra_session`` with ``Secure``; otherwise
``qatra_session`` without it; always ``HttpOnly; SameSite=Strict; Path=/``, no ``Domain``,
``Max-Age=2592000``, value = base64url of 32 random bytes. Clearing sends ``Max-Age=0``.

``install_auth(app, settings)`` builds the services (memory or supabase mode by
``QATRA_DATA_BACKEND``), stores the resolver and services on ``app.state``, registers the handler
that clears the cookie on a ``401 unauthenticated``, and includes the routers of E03-E13. Call it
once, after ``create_app``.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.responses import JSONResponse

from app.config import Settings, StartupConfigError
from app.contracts import ErrorEnvelope
from app.contracts_auth import (
    ChangePasswordRequest,
    ConsentRequest,
    LoginRequest,
    LoginResponse,
    ProfileEnvelope,
    RecoveryCodeResponse,
    RecoveryResetRequest,
    RecoveryVerifyRequest,
    RegisterRequest,
    RegisterResponse,
    ResetGrantResponse,
    RotateRecoveryRequest,
)
from app.dependencies import (
    ResolvedSession,
    SessionEndedError,
    get_settings,
    require_session_details,
    require_session_details_allow_reconsent,
    require_valid_origin,
)
from app.domain import auth_policy as policy
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import AppError, ErrorCode, error_response, mark_error_code
from app.logging_config import log_event
from app.providers.supabase_auth import FakeSupabaseAuth, HttpSupabaseAuth, SupabaseAuth
from app.repositories.accounts import (
    AccountRepository,
    InMemoryAccounts,
    PostgresAccountRepository,
    PostgrestProfileStore,
    ProfileStore,
)
from app.routers.health import client_key
from app.services.account import AccountService
from app.services.auth import AuthService, AuthThrottle, ConsentCache, SessionService
from app.services.session_crypto import (
    SessionCrypto,
    cookie_is_secure,
    cookie_name_for,
)

router = APIRouter(prefix="/api", tags=["auth"])
logger = logging.getLogger("qatra.auth")

_NO_STORE = "no-store"
_COOKIE_MAX_AGE_SEC = policy.SESSION_LIFETIME_SEC

_ERRORS = {
    400: {"model": ErrorEnvelope, "description": "terms_required"},
    401: {"model": ErrorEnvelope, "description": "unauthenticated or invalid_credentials"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin"},
    409: {"model": ErrorEnvelope, "description": "username_taken"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}


# --- cookie ---------------------------------------------------------------------------------------


def session_cookie_header(settings: Settings, value: str, max_age: int) -> str:
    """The ``Set-Cookie`` value: attributes in the order of the API-spec examples."""
    parts = [f"{cookie_name_for(settings)}={value}"]
    if cookie_is_secure(settings):
        parts.append("Secure")
    parts += ["HttpOnly", "SameSite=Strict", "Path=/", f"Max-Age={max_age}"]
    return "; ".join(parts)


def set_session_cookie(response: Response, settings: Settings, value: str) -> None:
    response.headers.append(
        "set-cookie", session_cookie_header(settings, value, _COOKIE_MAX_AGE_SEC)
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.headers.append("set-cookie", session_cookie_header(settings, "", 0))


# --- dependencies ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RateLimits:
    """Per-client-IP classes of API-spec §1.8 (requests per minute). Configuration defaults
    (A-12), not approved numbers."""

    anonymous_entry_per_min: int = 10
    session_write_per_min: int = 60
    session_read_per_min: int = 120


def _enforce(request: Request, name: str) -> None:
    limiters: dict[str, SlidingWindowLimiter] | None = getattr(
        request.app.state, "auth_limiters", None
    )
    if limiters is None:
        return
    decision = limiters[name].check(client_key(request))
    if not decision.allowed:
        raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)


def limit_anonymous_entry(request: Request) -> None:
    """Anonymous entry class: E03 (10 per client IP per minute)."""
    _enforce(request, "anonymous_entry")


def limit_session_write(request: Request) -> None:
    """Session write class: E05, E08, E09, E10, E12, E13 (60 per client IP per minute)."""
    _enforce(request, "session_write")


def limit_session_read(request: Request) -> None:
    """Session read class: E11 (120 per client IP per minute)."""
    _enforce(request, "session_read")


def get_auth_service(request: Request) -> AuthService:
    service: AuthService | None = getattr(request.app.state, "auth_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def get_account_service(request: Request) -> AccountService:
    service: AccountService | None = getattr(request.app.state, "account_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def client_prefix(request: Request) -> str:
    """The throttle prefix of the caller (IPv4 /24, IPv6 /48) from the trusted-proxy address."""
    return policy.ip_prefix(client_key(request))


Service = Annotated[AuthService, Depends(get_auth_service)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
Session = Annotated[ResolvedSession, Depends(require_session_details)]
SessionAllowingReconsent = Annotated[
    ResolvedSession, Depends(require_session_details_allow_reconsent)
]


_ORIGIN = Depends(require_valid_origin)
_WRITE_LIMIT = Depends(limit_session_write)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = _NO_STORE


# --- E03 .. E10 -----------------------------------------------------------------------------------


@router.post(
    "/auth/register",
    response_model=RegisterResponse,
    response_model_by_alias=True,
    status_code=201,
    summary="Register (E03)",
    responses=_ERRORS,
    dependencies=[_ORIGIN, Depends(limit_anonymous_entry)],
)
def register(
    body: RegisterRequest, response: Response, service: Service, settings: SettingsDep
) -> RegisterResponse:
    result = service.register_account(
        username=body.username,
        password=body.password,
        time_zone=body.time_zone,
        language=body.language,
        terms_accepted=body.terms_accepted,
        terms_version=body.terms_version,
    )
    _no_store(response)
    set_session_cookie(response, settings, result.cookie_value)
    return RegisterResponse(profile=result.profile, recovery_code=result.recovery_code)


@router.post(
    "/auth/login",
    response_model=LoginResponse,
    response_model_by_alias=True,
    summary="Log in (E04)",
    responses=_ERRORS,
    dependencies=[_ORIGIN],
)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    service: Service,
    settings: SettingsDep,
) -> LoginResponse:
    result = service.authenticate(
        username=body.username,
        password=body.password,
        ip_prefix=client_prefix(request),
        previous_cookie=request.cookies.get(cookie_name_for(settings)),
    )
    _no_store(response)
    set_session_cookie(response, settings, result.cookie_value)
    return LoginResponse(profile=result.profile, reconsent_required=result.reconsent_required)


@router.post(
    "/auth/consent",
    response_model=ProfileEnvelope,
    response_model_by_alias=True,
    summary="Accept the current terms (E05)",
    responses=_ERRORS,
    dependencies=[_ORIGIN, _WRITE_LIMIT, Depends(require_session_details_allow_reconsent)],
)
def consent(
    body: ConsentRequest,
    response: Response,
    session: SessionAllowingReconsent,
    service: Service,
) -> ProfileEnvelope:
    _no_store(response)
    return ProfileEnvelope(profile=service.accept_terms(session, body.terms_version))


@router.post(
    "/auth/recovery/verify",
    response_model=ResetGrantResponse,
    response_model_by_alias=True,
    summary="Verify a recovery code (E06)",
    responses=_ERRORS,
    dependencies=[_ORIGIN],
)
def verify_recovery(
    body: RecoveryVerifyRequest, request: Request, response: Response, service: Service
) -> ResetGrantResponse:
    issued = service.verify_recovery(
        username=body.username,
        recovery_code=body.recovery_code,
        ip_prefix=client_prefix(request),
    )
    _no_store(response)
    return ResetGrantResponse(reset_grant=issued.reset_grant, expires_in_sec=issued.expires_in_sec)


@router.post(
    "/auth/recovery/reset",
    response_model=RecoveryCodeResponse,
    response_model_by_alias=True,
    summary="Reset the password with a reset grant (E07)",
    responses=_ERRORS,
    dependencies=[_ORIGIN],
)
def reset_password(
    body: RecoveryResetRequest, request: Request, response: Response, service: Service
) -> RecoveryCodeResponse:
    code = service.reset_password(
        reset_grant=body.reset_grant,
        new_password=body.new_password,
        ip_prefix=client_prefix(request),
    )
    _no_store(response)
    return RecoveryCodeResponse(recovery_code=code)


@router.post(
    "/auth/recovery/rotate",
    response_model=RecoveryCodeResponse,
    response_model_by_alias=True,
    summary="Replace the recovery code (E08)",
    responses=_ERRORS,
    dependencies=[_ORIGIN, _WRITE_LIMIT, Depends(require_session_details)],
)
def rotate_recovery(
    body: RotateRecoveryRequest,
    request: Request,
    response: Response,
    session: Session,
    service: Service,
) -> RecoveryCodeResponse:
    code = service.rotate_recovery(
        session, password=body.password, ip_prefix=client_prefix(request)
    )
    _no_store(response)
    return RecoveryCodeResponse(recovery_code=code)


@router.post(
    "/auth/password",
    response_model=ProfileEnvelope,
    response_model_by_alias=True,
    summary="Change the password (E09)",
    responses=_ERRORS,
    dependencies=[_ORIGIN, _WRITE_LIMIT, Depends(require_session_details)],
)
def change_password(
    body: ChangePasswordRequest,
    request: Request,
    response: Response,
    session: Session,
    service: Service,
    settings: SettingsDep,
) -> ProfileEnvelope:
    changed = service.change_password(
        session,
        current_password=body.current_password,
        new_password=body.new_password,
        ip_prefix=client_prefix(request),
    )
    _no_store(response)
    set_session_cookie(response, settings, changed.cookie_value)
    return ProfileEnvelope(profile=changed.profile)


@router.post(
    "/auth/logout",
    status_code=204,
    response_class=Response,
    summary="Log out (E10)",
    responses={403: _ERRORS[403], 429: _ERRORS[429], 503: _ERRORS[503]},
    dependencies=[_ORIGIN, _WRITE_LIMIT],
)
def logout(request: Request, service: Service, settings: SettingsDep) -> Response:
    """Tolerant: a missing, malformed, unknown or revoked session still answers 204 with the
    cookie cleared, so a logout that was pending offline can finish (API-spec O-14)."""
    service.logout(request.cookies.get(cookie_name_for(settings)))
    response = Response(status_code=204, headers={"Cache-Control": _NO_STORE})
    clear_session_cookie(response, settings)
    return response


# --- wiring ---------------------------------------------------------------------------------------


_KEY_VARIABLES = (
    "QATRA_SESSION_KEY",
    "QATRA_SESSION_HMAC_KEY",
    "QATRA_RECOVERY_HMAC_KEY",
    "QATRA_THROTTLE_HMAC_KEY",
)


def _missing_configuration(
    settings: Settings,
    *,
    repository: AccountRepository | None,
    profiles: ProfileStore | None,
    provider: SupabaseAuth | None,
) -> list[str]:
    """Names of the variables the default supabase-mode components still need (names only)."""
    needed = list(_KEY_VARIABLES)
    if repository is None:
        needed.append("QATRA_SERVER_DB")
    if profiles is None and not isinstance(repository, InMemoryAccounts):
        needed += ["SUPABASE_URL", "SUPABASE_ANON_KEY"]
    if provider is None:
        needed += ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]
    return [name for name in dict.fromkeys(needed) if settings.is_missing(name)]


def _include_routes(app: FastAPI) -> None:
    from app.routers import account  # local import: account.py imports helpers from this module

    app.include_router(router)
    app.include_router(account.router)


def install_auth(
    app: FastAPI,
    settings: Settings,
    *,
    repository: AccountRepository | None = None,
    profiles: ProfileStore | None = None,
    provider: SupabaseAuth | None = None,
    clock: Callable[[], datetime] | None = None,
    monotonic: Callable[[], float] | None = None,
    rate_limits: RateLimits | None = None,
) -> None:
    """Wire authentication into ``app`` (call once, after ``create_app``).

    ``QATRA_DATA_BACKEND=memory`` uses the in-memory store and the fake identity provider (and
    ephemeral keys when none are configured); ``supabase`` uses the restricted database role,
    PostgREST under the learner's token and the Supabase Auth API. The keyword arguments let a
    caller supply its own components (tests do); an omitted component takes the default of the
    mode. In production missing or invalid configuration is a ``StartupConfigError`` naming
    variables, never values. In development and test (where only ``FRONTEND_ORIGIN`` and
    ``TERMS_VERSION`` are required, contract §8) a supabase-mode application without its
    configuration still starts: the routes exist but have no services behind them, so they answer
    ``503 unavailable`` (nothing is faked), ``require_session`` keeps denying, and one log line
    names the missing variables. A value that is set but invalid always fails."""
    memory = settings.QATRA_DATA_BACKEND == "memory"
    now = clock or (lambda: datetime.now(UTC))
    if not memory and settings.APP_ENV != "production":
        missing = _missing_configuration(
            settings, repository=repository, profiles=profiles, provider=provider
        )
        if missing:
            log_event(logger, "auth_not_configured", missing=missing)
            _include_routes(app)
            return
    crypto = SessionCrypto.from_settings(settings, allow_ephemeral=memory)

    if repository is None:
        if memory:
            repository = InMemoryAccounts(clock=now)
        else:
            if settings.is_missing("QATRA_SERVER_DB"):
                raise StartupConfigError(["QATRA_SERVER_DB is required"])
            assert settings.QATRA_SERVER_DB is not None
            repository = PostgresAccountRepository(settings.QATRA_SERVER_DB.get_secret_value())
    if profiles is None:
        if isinstance(repository, InMemoryAccounts):
            profiles = repository
        else:
            profiles = PostgrestProfileStore.from_settings(settings)
    if provider is None:
        provider = (
            FakeSupabaseAuth(clock=lambda: now().timestamp())
            if memory
            else HttpSupabaseAuth.from_settings(settings)
        )

    assert settings.TERMS_VERSION is not None
    consent = ConsentCache(settings.TERMS_VERSION)
    sessions = SessionService(
        settings=settings,
        repository=repository,
        provider=provider,
        crypto=crypto,
        profiles=profiles,
        consent=consent,
        clock=now,
        expose_access_token=not memory,
    )
    throttle = AuthThrottle(repository, crypto, monotonic=monotonic or time.monotonic)
    auth = AuthService(
        settings=settings,
        repository=repository,
        provider=provider,
        crypto=crypto,
        profiles=profiles,
        sessions=sessions,
        throttle=throttle,
        consent=consent,
        clock=now,
    )
    account = AccountService(
        settings=settings,
        repository=repository,
        provider=provider,
        crypto=crypto,
        profiles=profiles,
        sessions=sessions,
        auth=auth,
        consent=consent,
        clock=now,
    )
    limits = rate_limits or RateLimits()

    app.state.account_repository = repository
    app.state.profile_store = profiles
    app.state.auth_provider = provider
    app.state.session_resolver = sessions
    app.state.auth_service = auth
    app.state.account_service = account
    app.state.auth_limiters = {
        "anonymous_entry": SlidingWindowLimiter(limits.anonymous_entry_per_min),
        "session_write": SlidingWindowLimiter(limits.session_write_per_min),
        "session_read": SlidingWindowLimiter(limits.session_read_per_min),
    }

    async def handle_session_ended(request: Request, exc: SessionEndedError) -> JSONResponse:
        mark_error_code(request.scope, exc.code)
        response = error_response(exc.code, exc.message, exc.details, exc.retry_after)
        clear_session_cookie(response, settings)
        return response

    app.add_exception_handler(SessionEndedError, handle_session_ended)  # type: ignore[arg-type]
    _include_routes(app)
