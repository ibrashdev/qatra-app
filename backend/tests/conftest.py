"""Shared fixtures.

The environment is fixed before ``app.main`` is imported, because that module builds the
module-level ``app`` at import time. Tests run in memory mode: no database, no secrets.
"""

from __future__ import annotations

import logging
import os

os.environ["APP_ENV"] = "test"
os.environ["QATRA_DATA_BACKEND"] = "memory"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:3000"
os.environ["TERMS_VERSION"] = "2026-10-04"

from collections.abc import Callable, Iterator  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402
from tests.support import CONFIG_NAMES, FRONTEND_ORIGIN, make_settings  # noqa: E402


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """Remove every configuration variable from the process environment."""
    for name in CONFIG_NAMES:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


@pytest.fixture
def app_factory() -> Callable[..., FastAPI]:
    def factory(**overrides: Any) -> FastAPI:
        return create_app(make_settings(**overrides))

    return factory


@pytest.fixture
def app(app_factory: Callable[..., FastAPI]) -> FastAPI:
    return app_factory()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    # A browser always sends Origin on mutations; Origin tests build their own client.
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as test_client:
        yield test_client


@pytest.fixture
def log_lines() -> Iterator[list[str]]:
    """Capture the messages of the ``qatra`` logger (it does not propagate to the root)."""
    lines: list[str] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            lines.append(record.getMessage())

    handler = Capture()
    logger = logging.getLogger("qatra")
    logger.addHandler(handler)
    try:
        yield lines
    finally:
        logger.removeHandler(handler)
