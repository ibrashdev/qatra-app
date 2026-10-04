"""Unified error envelope and exception handlers (API-spec §1.5).

Every error leaves the application as ``{"error": {"code", "message", "details"}}``.
``message`` is a short generic English sentence. It never contains submitted values,
tokens, secrets, SQL or stack traces. Clients branch on ``code``, not on status alone.
"""

from __future__ import annotations

import logging
from enum import StrEnum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging_config import log_event

logger = logging.getLogger("qatra.errors")

# The envelope never reports more field errors than this (keeps error bodies small).
MAX_REPORTED_FIELDS = 50
_MAX_FIELD_NAME_LENGTH = 100


class ErrorCode(StrEnum):
    """Closed list of error codes (API-spec §1.5, contract v1.4 amendment 5)."""

    terms_required = "terms_required"
    unauthenticated = "unauthenticated"
    invalid_credentials = "invalid_credentials"
    forbidden_origin = "forbidden_origin"
    forbidden = "forbidden"
    not_found = "not_found"
    username_taken = "username_taken"
    version_conflict = "version_conflict"
    payload_too_large = "payload_too_large"
    validation_error = "validation_error"
    throttled = "throttled"
    internal = "internal"
    unavailable = "unavailable"

    @property
    def status(self) -> int:
        return _STATUS[self]

    @property
    def default_message(self) -> str:
        return _DEFAULT_MESSAGE[self]


_STATUS: dict[ErrorCode, int] = {
    ErrorCode.terms_required: 400,
    ErrorCode.unauthenticated: 401,
    ErrorCode.invalid_credentials: 401,
    ErrorCode.forbidden_origin: 403,
    ErrorCode.forbidden: 403,
    ErrorCode.not_found: 404,
    ErrorCode.username_taken: 409,
    ErrorCode.version_conflict: 409,
    ErrorCode.payload_too_large: 413,
    ErrorCode.validation_error: 422,
    ErrorCode.throttled: 429,
    ErrorCode.internal: 500,
    ErrorCode.unavailable: 503,
}

_DEFAULT_MESSAGE: dict[ErrorCode, str] = {
    ErrorCode.terms_required: "The current terms must be accepted.",
    ErrorCode.unauthenticated: "Authentication is required.",
    ErrorCode.invalid_credentials: "The credentials are not valid.",
    ErrorCode.forbidden_origin: "The request origin is not allowed.",
    ErrorCode.forbidden: "This operation is not permitted.",
    ErrorCode.not_found: "The resource was not found.",
    ErrorCode.username_taken: "The username is not available.",
    ErrorCode.version_conflict: "The resource version conflicts with the request.",
    ErrorCode.payload_too_large: "The request body is too large.",
    ErrorCode.validation_error: "The request is not valid.",
    ErrorCode.throttled: "Too many requests.",
    ErrorCode.internal: "An unexpected error occurred.",
    ErrorCode.unavailable: "The service is temporarily unavailable.",
}


class AppError(Exception):
    """An application error with a closed ``code``; the HTTP status derives from the code.

    ``message`` must be a safe, generic sentence (no submitted values). A ``throttled``
    error requires ``retry_after`` (seconds): every 429 carries a ``Retry-After`` header
    and ``details.retryAfterSec`` (API-spec §1.5, A-12).
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        details: dict[str, Any] | None = None,
        retry_after: int | None = None,
    ) -> None:
        if code is ErrorCode.throttled and retry_after is None:
            raise ValueError("a throttled error requires retry_after")
        self.code = ErrorCode(code)
        self.message = message if message is not None else self.code.default_message
        self.details: dict[str, Any] = dict(details) if details else {}
        self.retry_after = retry_after
        if retry_after is not None:
            self.details.setdefault("retryAfterSec", retry_after)
        super().__init__(self.code.value)

    @property
    def status(self) -> int:
        return self.code.status

    def __str__(self) -> str:
        # Never include the message or details: they may be forwarded to logs.
        return self.code.value


def error_response(
    code: ErrorCode,
    message: str | None = None,
    details: dict[str, Any] | None = None,
    retry_after: int | None = None,
) -> JSONResponse:
    """Build the envelope response for ``code``."""
    body = {
        "error": {
            "code": code.value,
            "message": message if message is not None else code.default_message,
            "details": details or {},
        }
    }
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
    return JSONResponse(body, status_code=code.status, headers=headers)


def mark_error_code(scope: dict[str, Any], code: ErrorCode) -> None:
    """Record the error code in the ASGI scope for the structured access log."""
    scope.setdefault("state", {})["error_code"] = code.value


def _format_loc(loc: tuple[Any, ...] | list[Any]) -> str:
    """Render a pydantic location as ``events[3].correct``; the ``body`` prefix is dropped."""
    parts = list(loc)
    prefix = ""
    if parts and parts[0] in {"query", "path", "header", "cookie"}:
        prefix = f"{parts.pop(0)}."
    elif parts and parts[0] == "body":
        parts.pop(0)
    rendered = ""
    for part in parts:
        if isinstance(part, int):
            rendered += f"[{part}]"
        else:
            rendered += f".{part}" if rendered else str(part)
    return (prefix + rendered)[:_MAX_FIELD_NAME_LENGTH] or "body"


_RULE_BY_PYDANTIC_TYPE = {
    "missing": "required",
    "extra_forbidden": "forbidden_field",
}


def validation_fields(errors: list[Any]) -> list[dict[str, str]]:
    """Convert pydantic error dicts to ``[{field, rule}]``. Submitted values are never read."""
    fields: list[dict[str, str]] = []
    for error in errors[:MAX_REPORTED_FIELDS]:
        error_type = str(error.get("type", "invalid"))
        if error_type == "json_invalid":
            fields.append({"field": "body", "rule": "json_invalid"})
            continue
        fields.append(
            {
                "field": _format_loc(error.get("loc", ())),
                "rule": _RULE_BY_PYDANTIC_TYPE.get(error_type, error_type),
            }
        )
    return fields


def _code_for_http_status(status_code: int) -> ErrorCode:
    if status_code in (404, 405):
        return ErrorCode.not_found
    if status_code == 413:
        return ErrorCode.payload_too_large
    if status_code == 401:
        return ErrorCode.unauthenticated
    if status_code == 403:
        return ErrorCode.forbidden
    if status_code >= 500:
        return ErrorCode.internal
    # 400, 415 (wrong content type), 422 and any other client error.
    return ErrorCode.validation_error


def install_error_handlers(app: FastAPI) -> None:
    """Register the handlers that convert every failure into the unified envelope."""

    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        mark_error_code(request.scope, exc.code)
        return error_response(exc.code, exc.message, exc.details, exc.retry_after)

    async def handle_validation_error(request: Request, exc: RequestValidationError):
        mark_error_code(request.scope, ErrorCode.validation_error)
        return error_response(
            ErrorCode.validation_error,
            details={"fields": validation_fields(list(exc.errors()))},
        )

    async def handle_http_exception(request: Request, exc: StarletteHTTPException):
        # ``exc.detail`` is framework text and is deliberately not forwarded.
        code = _code_for_http_status(exc.status_code)
        mark_error_code(request.scope, code)
        return error_response(code)

    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        mark_error_code(request.scope, ErrorCode.internal)
        log_unexpected(exc)
        return error_response(ErrorCode.internal)

    app.add_exception_handler(AppError, handle_app_error)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, handle_validation_error)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, handle_http_exception)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, handle_unexpected)


def log_unexpected(exc: BaseException) -> None:
    """Log only the exception type: messages and tracebacks can carry submitted values."""
    log_event(logger, "unhandled_exception", level=logging.ERROR, exception_type=type(exc).__name__)
