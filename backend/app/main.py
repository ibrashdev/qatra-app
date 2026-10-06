"""Application factory (``create_app``) and the module-level ``app`` served by uvicorn."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.config import Settings, load_settings, validate_startup
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import install_error_handlers
from app.logging_config import configure_logging
from app.middleware import (
    AccessLogMiddleware,
    BodyLimitMiddleware,
    NoStoreMiddleware,
    OriginGuardMiddleware,
)
from app.routers import catalog, health, lessons, plan_chats, plans
from app.routers.auth import install_auth
from app.wiring import install_learning_core

if TYPE_CHECKING:
    import httpx


def create_app(
    settings: Settings | None = None,
    *,
    clock: Callable[[], datetime] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> FastAPI:
    """Build the application. Raises ``StartupConfigError`` (names only) on invalid config.

    ``clock`` and ``transport`` are test seams; production passes neither. Authentication
    (E03-E13) is installed here, so ``require_session`` resolves real sessions; tests that
    need another identity override ``require_session``.
    """
    if settings is None:
        settings = load_settings()
    validate_startup(settings)
    configure_logging()

    # /docs, /redoc and /openapi.json are disabled in production.
    production = settings.APP_ENV == "production"
    app = FastAPI(
        title="Qatra API",
        version=settings.APP_VERSION,
        docs_url=None if production else "/docs",
        redoc_url=None if production else "/redoc",
        openapi_url=None if production else "/openapi.json",
    )
    app.state.settings = settings
    app.state.ready_limiter = SlidingWindowLimiter(settings.QATRA_READY_RATE_PER_MIN)
    install_learning_core(app, settings, clock=clock, transport=transport)
    install_auth(app, settings, clock=clock)

    install_error_handlers(app)

    # Last added is outermost: NoStore -> AccessLog -> OriginGuard -> BodyLimit -> app.
    # There is no CORS middleware: the browser talks to the frontend origin only and Vercel
    # rewrites forward /api/* (same origin).
    app.add_middleware(BodyLimitMiddleware, limit_bytes=settings.QATRA_BODY_LIMIT_BYTES)
    app.add_middleware(OriginGuardMiddleware, frontend_origin=settings.FRONTEND_ORIGIN)
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(NoStoreMiddleware)

    app.include_router(health.router)
    app.include_router(catalog.router)
    app.include_router(plans.router)
    app.include_router(plan_chats.router)
    app.include_router(lessons.router)
    return app


app = create_app()
