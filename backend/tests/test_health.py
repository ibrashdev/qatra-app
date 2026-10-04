from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import ErrorCode
from app.providers import database as database_provider


def test_health_shape_and_headers(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"status", "version", "time"}
    assert body["status"] == "ok"
    assert body["version"] == "dev"
    assert "set-cookie" not in response.headers


def test_health_time_is_utc_iso_at_second_precision(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["time"].endswith("Z")
    assert "." not in body["time"]
    parsed = datetime.fromisoformat(body["time"])
    assert parsed.tzinfo is not None
    assert abs(datetime.now(UTC) - parsed) < timedelta(seconds=5)


def test_health_reports_configured_version(app_factory: Callable[..., FastAPI]) -> None:
    with TestClient(app_factory(APP_VERSION="example-build-1")) as client:
        assert client.get("/api/health").json()["version"] == "example-build-1"


def test_health_needs_no_database_and_no_authentication(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def forbidden(settings: object) -> None:
        raise AssertionError("E01 must not touch the database")

    monkeypatch.setattr(database_provider, "open_restricted_database", forbidden)
    client.cookies.set("__Host-qatra_session", "ignored")
    response = client.get("/api/health", headers={"Authorization": "Bearer ignored"})
    assert response.status_code == 200


def test_ready_ok_in_memory_mode(client: TestClient) -> None:
    response = client.get("/api/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"


def test_ready_returns_503_without_detail_when_ping_fails(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingDatabase:
        def ping(self) -> None:
            raise RuntimeError("db.internal-host.example refused the connection")

    monkeypatch.setattr(database_provider, "open_restricted_database", lambda s: FailingDatabase())
    response = client.get("/api/health/ready")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    error = response.json()["error"]
    assert error["code"] == ErrorCode.unavailable
    assert error["details"] == {}
    assert "internal-host" not in response.text


def test_ready_without_configured_database_is_unavailable(
    app_factory: Callable[..., FastAPI],
) -> None:
    # supabase backend selected but no QATRA_SERVER_DB (allowed in development/test)
    app = app_factory(APP_ENV="development", QATRA_DATA_BACKEND="supabase")
    with TestClient(app) as client:
        response = client.get("/api/health/ready")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "unavailable"


def test_ready_is_rate_limited_per_client_with_retry_after(
    app_factory: Callable[..., FastAPI],
) -> None:
    with TestClient(app_factory(QATRA_READY_RATE_PER_MIN=3)) as client:
        assert [client.get("/api/health/ready").status_code for _ in range(3)] == [200] * 3
        response = client.get("/api/health/ready")
    assert response.status_code == 429
    retry_after = int(response.headers["retry-after"])
    assert 1 <= retry_after <= 60
    error = response.json()["error"]
    assert error["code"] == "throttled"
    assert error["details"] == {"retryAfterSec": retry_after}
    assert response.headers["cache-control"] == "no-store"


def test_ready_default_limit_is_six_per_minute(client: TestClient) -> None:
    statuses = [client.get("/api/health/ready").status_code for _ in range(7)]
    assert statuses == [200] * 6 + [429]


def test_liveness_is_not_rate_limited(app_factory: Callable[..., FastAPI]) -> None:
    with TestClient(app_factory(QATRA_READY_RATE_PER_MIN=1)) as client:
        assert all(client.get("/api/health").status_code == 200 for _ in range(10))
