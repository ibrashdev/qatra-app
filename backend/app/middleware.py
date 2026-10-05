"""Pure ASGI middleware: Origin guard, body-size cap, structured access log, default ``no-store``.

Order (outermost first): ``NoStoreMiddleware`` -> ``AccessLogMiddleware`` ->
``OriginGuardMiddleware`` -> ``BodyLimitMiddleware`` -> framework exception handling -> routers.

The Origin guard sits before the body cap and before routing: a state-changing request with a
wrong or missing ``Origin`` is answered ``403 forbidden_origin`` before any body is read or
parsed, before an unknown route is reported and before authentication (API-spec §1.3).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.domain.origin_policy import is_origin_allowed
from app.errors import ErrorCode, error_response, log_unexpected, mark_error_code
from app.logging_config import log_event

access_logger = logging.getLogger("qatra.access")

_UNMATCHED_ROUTE = "<unmatched>"


class OriginGuardMiddleware:
    """Answer ``403 forbidden_origin`` to a POST, PUT, PATCH or DELETE whose ``Origin`` header
    is missing or differs from ``FRONTEND_ORIGIN``. GET, HEAD and OPTIONS pass through."""

    def __init__(self, app: ASGIApp, frontend_origin: str | None) -> None:
        self.app = app
        self.frontend_origin = frontend_origin

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not is_origin_allowed(
            scope["method"], Headers(scope=scope).get("origin"), self.frontend_origin
        ):
            mark_error_code(scope, ErrorCode.forbidden_origin)
            await error_response(ErrorCode.forbidden_origin)(scope, receive, send)
            return
        await self.app(scope, receive, send)


class BodyLimitMiddleware:
    """Reject request bodies above ``limit_bytes`` with ``413 payload_too_large``.

    The ``Content-Length`` header is checked first. Any other body (chunked or with an
    understated length) is read through a counter and buffered, at most ``limit_bytes``,
    then replayed to the application. The check runs before routing, so it also covers
    unknown routes.
    """

    def __init__(self, app: ASGIApp, limit_bytes: int) -> None:
        self.app = app
        self.limit = limit_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        declared = self._declared_length(headers)
        chunked = "chunked" in headers.get("transfer-encoding", "").lower()

        if declared is not None and declared > self.limit:
            await self._reject(scope, receive, send)
            return
        if declared == 0 or (declared is None and not chunked):
            await self.app(scope, receive, send)  # no body
            return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":  # disconnect: let the app see it
                await self.app(scope, _replay([message]), send)
                return
            body += message.get("body", b"")
            if len(body) > self.limit:
                await self._reject(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        await self.app(scope, _replay([{"type": "http.request", "body": bytes(body)}]), send)

    @staticmethod
    def _declared_length(headers: Headers) -> int | None:
        raw = headers.get("content-length")
        if raw is None:
            return None
        try:
            value = int(raw)
        except ValueError:
            return None
        return value if value >= 0 else None

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
        mark_error_code(scope, ErrorCode.payload_too_large)
        await error_response(ErrorCode.payload_too_large)(scope, receive, send)


def _replay(messages: list[Message]) -> Receive:
    queue = list(messages)

    async def receive() -> Message:
        if queue:
            return queue.pop(0)
        return {"type": "http.disconnect"}

    return receive


def _proxy_chain_counts(scope: Scope) -> tuple[int, bool]:
    """``(xff_entries, via_vercel)`` from the raw request headers: a count and a flag only.

    ``xff_entries`` is the number of non-empty, comma-separated entries over all
    ``X-Forwarded-For`` lines (joined with a comma, as ``client_key`` reads them); 0 when the
    header is absent. ``via_vercel`` is whether an ``x-vercel-id`` header is present. Header
    names are matched without regard to case. No value is kept or returned.
    """
    forwarded: list[bytes] = []
    via_vercel = False
    for name, value in scope.get("headers", ()):
        lowered = name.lower()
        if lowered == b"x-forwarded-for":
            forwarded.append(value)
        elif lowered == b"x-vercel-id":
            via_vercel = True
    joined = b",".join(forwarded).decode("latin-1")  # the text ``client_key`` sees
    return sum(1 for entry in joined.split(",") if entry.strip()), via_vercel


class AccessLogMiddleware:
    """One structured log line per request: method, route template, status, latency, error code,
    and two proxy-chain measures, ``xff_entries`` (how many ``X-Forwarded-For`` entries arrived,
    0 when absent) and ``via_vercel`` (whether ``x-vercel-id`` was present). They size
    ``QATRA_TRUSTED_XFF_DEPTH``.

    Never logged: bodies, cookies, tokens, usernames, raw paths with ids, query strings, IP
    addresses or any header value (the two measures are a number and a flag, never the addresses
    or ids behind them). Unhandled exceptions are converted to ``500 internal`` here (only the
    exception type is logged), so no traceback, which can contain submitted values, reaches the
    logs.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        scope.setdefault("state", {})
        started = time.perf_counter()
        status: dict[str, Any] = {"code": None}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            log_unexpected(exc)
            mark_error_code(scope, ErrorCode.internal)
            if status["code"] is None:
                await error_response(ErrorCode.internal)(scope, receive, send_wrapper)
            else:
                self._log(scope, status["code"], started)
                raise
        self._log(scope, status["code"], started)

    @staticmethod
    def _log(scope: Scope, status_code: int | None, started: float) -> None:
        route = scope.get("route")
        template = getattr(route, "path", None) or _UNMATCHED_ROUTE
        xff_entries, via_vercel = _proxy_chain_counts(scope)
        log_event(
            access_logger,
            "request",
            method=scope.get("method", ""),
            route=template,
            status=status_code,
            latency_ms=round((time.perf_counter() - started) * 1000, 2),
            error_code=scope.get("state", {}).get("error_code"),
            xff_entries=xff_entries,
            via_vercel=via_vercel,
        )


class NoStoreMiddleware:
    """Add ``Cache-Control: no-store`` to every response that does not set one (§1.9)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "cache-control" not in headers:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_wrapper)
