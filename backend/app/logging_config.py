"""Structured, privacy-preserving logging (API-spec §1.12, NFR-13).

Log lines are single JSON objects. Callers pass only non-personal fields (method, route
template, status, latency, error code). Request or response bodies, cookies, tokens,
usernames and raw IP addresses must never be passed to ``log_event``.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

ROOT_LOGGER_NAME = "qatra"


def _silence_server_access_log() -> None:
    """Turn off uvicorn's own access log: it prints raw client IPs, raw paths and query strings,
    which API-spec §1.12 forbids. ``qatra.access`` (route template only) replaces it."""
    server_access = logging.getLogger("uvicorn.access")
    server_access.handlers.clear()
    server_access.propagate = False
    server_access.disabled = True


def configure_logging() -> None:
    """Attach one stdout handler to the ``qatra`` logger (idempotent)."""
    _silence_server_access_log()
    logger = logging.getLogger(ROOT_LOGGER_NAME)
    if any(getattr(h, "_qatra", False) for h in logger.handlers):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler._qatra = True  # type: ignore[attr-defined]
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False


def log_event(
    logger: logging.Logger, event: str, *, level: int = logging.INFO, **fields: Any
) -> None:
    """Emit ``{"event": ..., **fields}`` as one JSON line."""
    logger.log(level, json.dumps({"event": event, **fields}, separators=(",", ":"), default=str))
