from __future__ import annotations

import logging
from collections.abc import Callable, Iterator

import pytest

from tests.auth.auth_support import Harness, build_harness, register


@pytest.fixture
def harness() -> Iterator[Harness]:
    """A memory-mode application with authentication installed and a signed-out client."""
    built = build_harness()
    with built.client:
        yield built


@pytest.fixture
def signed_in(harness: Harness) -> Harness:
    """The same harness with ``sample_user_01`` registered and signed in on ``harness.client``."""
    response = register(harness.client)
    assert response.status_code == 201
    harness.recovery_code = response.json()["recoveryCode"]
    return harness


@pytest.fixture
def all_logs(caplog: pytest.LogCaptureFixture, log_lines: list[str]) -> Callable[[], list[str]]:
    """Every log message so far: the root logger (httpx, psycopg, uvicorn, ...) at DEBUG and the
    non-propagating ``qatra`` logger. Call it at the end of the test."""
    caplog.set_level(logging.DEBUG)
    return lambda: [*caplog.messages, *log_lines]
