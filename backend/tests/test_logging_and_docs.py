from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.support import FRONTEND_ORIGIN, production_values


@pytest.fixture
def probe(app: FastAPI) -> Iterator[TestClient]:
    @app.get("/api/_test/items/{item_id}")
    async def item(item_id: str) -> dict[str, str]:
        return {"id": item_id}

    with TestClient(app) as client:
        yield client


def parse(lines: list[str]) -> list[dict]:
    return [json.loads(line) for line in lines if '"event":"request"' in line]


def test_access_log_has_only_the_allowed_fields(client: TestClient, log_lines: list[str]) -> None:
    client.get("/api/health")
    (entry,) = parse(log_lines)
    assert set(entry) == {"event", "method", "route", "status", "latency_ms", "error_code"}
    assert entry["method"] == "GET"
    assert entry["route"] == "/api/health"
    assert entry["status"] == 200
    assert isinstance(entry["latency_ms"], int | float)
    assert entry["error_code"] is None


def test_access_log_uses_the_route_template_and_no_personal_data(
    probe: TestClient, log_lines: list[str]
) -> None:
    item_id = "123e4567-e89b-12d3-a456-426614174000"
    probe.cookies.set("__Host-qatra_session", "SENTINEL-cookie-value")
    probe.get(
        f"/api/_test/items/{item_id}?username=SENTINEL-alice",
        headers={"Authorization": "Bearer SENTINEL-token", "X-Forwarded-For": "203.0.113.7"},
    )
    (entry,) = parse(log_lines)
    assert entry["route"] == "/api/_test/items/{item_id}"
    joined = "\n".join(log_lines)
    for leaked in (item_id, "SENTINEL", "alice", "203.0.113.7", "127.0.0.1", "testclient"):
        assert leaked not in joined


def test_access_log_records_the_error_code(client: TestClient, log_lines: list[str]) -> None:
    client.get("/api/does-not-exist/42")
    client.post("/api/unknown", content=b"x" * 70000)
    not_found, too_large = parse(log_lines)
    assert (not_found["status"], not_found["error_code"]) == (404, "not_found")
    assert not_found["route"] == "<unmatched>"
    assert (too_large["status"], too_large["error_code"]) == (413, "payload_too_large")
    assert "42" not in "\n".join(log_lines)


def test_access_log_records_throttling(
    app_factory: Callable[..., FastAPI], log_lines: list[str]
) -> None:
    with TestClient(app_factory(QATRA_READY_RATE_PER_MIN=1)) as client:
        client.get("/api/health/ready")
        client.get("/api/health/ready")
    first, second = parse(log_lines)
    assert (first["status"], first["error_code"]) == (200, None)
    assert (second["status"], second["error_code"]) == (429, "throttled")
    assert second["route"] == "/api/health/ready"


def test_docs_are_available_outside_production(client: TestClient) -> None:
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200


def test_docs_are_disabled_in_production() -> None:
    settings = Settings(_env_file=None, **production_values())  # type: ignore[call-arg]
    with TestClient(create_app(settings)) as client:
        for path in ("/docs", "/redoc", "/openapi.json"):
            response = client.get(path)
            assert response.status_code == 404
            assert response.json()["error"]["code"] == "not_found"
        assert client.get("/api/health").status_code == 200


def test_no_cors_headers_are_added(client: TestClient) -> None:
    response = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert not any(name.startswith("access-control-") for name in response.headers)


def test_every_response_defaults_to_no_store(client: TestClient) -> None:
    assert client.get("/api/missing").headers["cache-control"] == "no-store"
    assert client.get("/openapi.json").headers["cache-control"] == "no-store"


def test_every_route_is_logged_by_its_full_template(app: FastAPI, log_lines: list[str]) -> None:
    """The logged template equals the documented path, never the raw path."""
    expected: list[str] = []
    with TestClient(app) as client:
        for path, operations in app.openapi()["paths"].items():
            for method in operations:
                url = re.sub(r"\{[^}]+\}", "00000000-0000-0000-0000-000000000000", path)
                # A browser always sends Origin on mutations; without it the guard answers
                # before routing and the route would be logged as unmatched.
                client.request(method, url, headers={"Origin": FRONTEND_ORIGIN})
                expected.append(path)
    assert expected  # at least the health endpoints
    assert [entry["route"] for entry in parse(log_lines)] == expected


def test_the_servers_own_access_log_is_silenced(app: FastAPI) -> None:
    """uvicorn's access log would print raw IP addresses, paths and query strings."""
    server_access = logging.getLogger("uvicorn.access")
    assert server_access.disabled is True
    assert server_access.propagate is False
