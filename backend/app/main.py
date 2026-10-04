"""Application factory (``create_app``) and the module-level ``app`` served by uvicorn."""

from __future__ import annotations

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
from app.routers import health


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the application. Raises ``StartupConfigError`` (names only) on invalid config."""
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

    install_error_handlers(app)

    # Last added is outermost: NoStore -> AccessLog -> OriginGuard -> BodyLimit -> app.
    # There is no CORS middleware: the browser talks to the frontend origin only and Vercel
    # rewrites forward /api/* (same origin).
    app.add_middleware(BodyLimitMiddleware, limit_bytes=settings.QATRA_BODY_LIMIT_BYTES)
    app.add_middleware(OriginGuardMiddleware, frontend_origin=settings.FRONTEND_ORIGIN)
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(NoStoreMiddleware)

    app.include_router(health.router)
    return app


app = create_app()
