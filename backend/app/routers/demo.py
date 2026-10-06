"""Demo endpoints E26-E29 (API-spec §4.9) and the package wiring (``install_demo``).

E26 is anonymous entry: ``require_valid_origin`` first, then the anonymous-entry class limiter of
E03 (shared with it), then the body is validated like E03's and the per-address daily limit
(``QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY``) applies. E27 to E29 are Demo-session operations: the
session is resolved first (``401`` for a visitor), then ``require_demo`` refuses a learner with
``403 forbidden`` before the body is looked at, then the per-client-IP class limiter (E27 and E29
"Session read", E28 "Session write", API-spec §1.8) shared by name with the other routers.
Handlers are synchronous (database and model calls block), so they run in the thread pool.

No endpoint accepts a user id, a demo flag or a mode: bodies are strict (``forbidden_field``).
Bodies, scenario text, passage ids, replies and addresses are never logged here.

``install_demo(app, settings)`` builds the service on ``app.state.demo_service`` and includes the
router once; ``create_app`` calls it after ``install_auth``. Calling it again replaces the service
and keeps the routes. The plan, catalog and plan-conversation services are read from ``app.state``
when a request is served.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope
from app.contracts_demo import (
    CreateDemoAccountRequest,
    CreateDemoPlanRequest,
    DemoAccountResponse,
    DemoScenariosResponse,
    DemoSimulationsResponse,
)
from app.contracts_plan_chat import Plan
from app.dependencies import SessionContext, get_settings, require_session, require_valid_origin
from app.errors import AppError, ErrorCode
from app.repositories.ai_usage import UsageLedger
from app.routers.auth import get_auth_service, limit_anonymous_entry, set_session_cookie
from app.routers.health import client_key, ip_rate_limit
from app.services.auth import AuthService
from app.services.demo import DemoService, FixtureStore
from app.services.planner import UNSET, PlannerGateway

router = APIRouter(prefix="/api", tags=["demo"])

_NO_STORE = "no-store"

_ERRORS = {
    400: {"model": ErrorEnvelope, "description": "terms_required"},
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin or forbidden (not a demo)"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "username_taken or version_conflict"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}
_READ_ERRORS = {code: _ERRORS[code] for code in (401, 403, 429, 503)}
_PLAN_ERRORS = {code: _ERRORS[code] for code in (401, 403, 404, 409, 422, 429, 503)}
_ACCOUNT_ERRORS = {code: _ERRORS[code] for code in (400, 403, 409, 422, 429, 503)}

# Shared by name with the other Session read and write operations.
enforce_session_read_limit = ip_rate_limit(
    "session_read_limiter", "QATRA_RATE_SESSION_READ_PER_MIN"
)
enforce_session_write_limit = ip_rate_limit(
    "session_write_limiter", "QATRA_RATE_SESSION_WRITE_PER_MIN"
)

Session = Annotated[SessionContext, Depends(require_session)]


def get_demo_service(request: Request) -> DemoService:
    service: DemoService | None = getattr(request.app.state, "demo_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def require_demo(ctx: Session) -> None:
    """Role-based denial (API-spec §1.4): only a demo account may use E27 to E29."""
    if not ctx.is_demo:
        raise AppError(ErrorCode.forbidden)


Service = Annotated[DemoService, Depends(get_demo_service)]
Auth = Annotated[AuthService, Depends(get_auth_service)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

_READ_GUARDS = [
    Depends(require_session),
    Depends(require_demo),
    Depends(enforce_session_read_limit),
]
_WRITE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(require_demo),
    Depends(enforce_session_write_limit),
]


@router.post(
    "/demo/accounts",
    response_model=DemoAccountResponse,
    response_model_by_alias=True,
    status_code=201,
    summary="Create a demo account (E26)",
    responses=_ACCOUNT_ERRORS,
    dependencies=[Depends(require_valid_origin), Depends(limit_anonymous_entry)],
)
def create_demo_account(
    body: CreateDemoAccountRequest,
    request: Request,
    response: Response,
    auth: Auth,
    service: Service,
    settings: SettingsDep,
) -> DemoAccountResponse:
    registered = service.register_account(auth, body, client_key(request))
    response.headers["Cache-Control"] = _NO_STORE
    set_session_cookie(response, settings, registered.cookie_value)
    return DemoAccountResponse(profile=registered.profile, recovery_code=registered.recovery_code)


@router.get(
    "/demo/scenarios",
    response_model=DemoScenariosResponse,
    response_model_by_alias=True,
    summary="List the synthetic scenarios (E27)",
    responses=_READ_ERRORS,
    dependencies=_READ_GUARDS,
)
def list_scenarios(response: Response, service: Service) -> DemoScenariosResponse:
    response.headers["Cache-Control"] = _NO_STORE
    return service.list_scenarios()


@router.post(
    "/demo/plans",
    response_model=Plan,
    response_model_by_alias=True,
    status_code=201,
    summary="Build a demo plan from a scenario (E28)",
    responses=_PLAN_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def create_demo_plan(
    body: CreateDemoPlanRequest, response: Response, ctx: Session, service: Service
) -> Plan:
    response.headers["Cache-Control"] = _NO_STORE
    return service.create_plan(ctx, body)


@router.get(
    "/demo/simulations",
    response_model=DemoSimulationsResponse,
    response_model_by_alias=True,
    summary="Read the precomputed simulations (E29)",
    responses=_READ_ERRORS,
    dependencies=_READ_GUARDS,
)
def list_simulations(response: Response, service: Service) -> DemoSimulationsResponse:
    response.headers["Cache-Control"] = _NO_STORE
    return service.list_simulations()


def install_demo(
    app: FastAPI,
    settings: Settings,
    *,
    provider: Any = UNSET,
    ledger: UsageLedger | None = None,
    fixtures_dir: Path | str | None = None,
    clock: Callable[[], datetime] | None = None,
) -> None:
    """Wire E26 to E29 into ``app``.

    ``provider`` and ``ledger`` are test seams: by default the planner takes both lazily from the
    plan conversation (``app.state.plan_chat_service``), so demo calls share its provider, caps
    and usage ledger; without them the planner is the rules engine. ``fixtures_dir`` overrides
    ``QATRA_DEMO_FIXTURES_DIR`` (itself optional; the default is the repository-root
    ``fixtures`` directory). ``clock`` is a test seam.
    """
    directory = fixtures_dir if fixtures_dir is not None else settings.QATRA_DEMO_FIXTURES_DIR
    app.state.demo_service = DemoService(
        settings,
        state=app.state,
        fixtures=FixtureStore(directory),
        planner=PlannerGateway(app.state, provider=provider, ledger=ledger),
        clock=clock,
    )
    if not getattr(app.state, "demo_router_included", False):
        app.include_router(router)
        app.state.demo_router_included = True
