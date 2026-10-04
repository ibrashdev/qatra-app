from __future__ import annotations

from collections.abc import Callable, Iterator

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field

from app.contracts import ErrorEnvelope
from app.errors import AppError, ErrorCode, install_error_handlers
from tests.support import FRONTEND_ORIGIN

SPEC_STATUS = {
    "terms_required": 400,
    "unauthenticated": 401,
    "invalid_credentials": 401,
    "forbidden_origin": 403,
    "forbidden": 403,
    "not_found": 404,
    "username_taken": 409,
    "version_conflict": 409,
    "payload_too_large": 413,
    "validation_error": 422,
    "throttled": 429,
    "internal": 500,
    "unavailable": 503,
}


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str = Field(min_length=3)


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=3)
    age: int
    events: list[Event] = []


@pytest.fixture
def probe_app(app: FastAPI) -> FastAPI:
    """The real application plus test-only routes."""

    @app.post("/api/_test/payload")
    async def payload(body: Payload) -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/_test/size")
    async def size(request: Request) -> dict[str, int]:
        return {"bytes": len(await request.body())}

    @app.get("/api/_test/boom")
    async def boom() -> None:
        raise RuntimeError("SENTINEL-exception-message dsn=postgresql://user:pw@host/db")

    @app.get("/api/_test/app-error/{code}")
    async def app_error(code: str) -> None:
        if code == "throttled":
            raise AppError(ErrorCode.throttled, retry_after=30)
        if code == "version_conflict":
            raise AppError(
                ErrorCode.version_conflict,
                details={"reason": "plan_version", "currentVersion": 3},
            )
        raise AppError(ErrorCode(code))

    @app.get("/api/_test/http/{status}")
    async def http_error(status: int) -> None:
        raise HTTPException(status_code=status, detail="SENTINEL-framework-detail")

    return app


@pytest.fixture
def probe(probe_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(probe_app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        yield client


def assert_envelope(response, status: int, code: str) -> dict:
    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "details"}
    assert body["error"]["code"] == code
    ErrorEnvelope.model_validate(body)
    return body["error"]


def test_error_codes_are_the_closed_list_with_the_specified_statuses() -> None:
    assert {code.value: code.status for code in ErrorCode} == SPEC_STATUS


def test_throttled_error_requires_retry_after() -> None:
    with pytest.raises(ValueError):
        AppError(ErrorCode.throttled)


def test_unknown_route_is_not_found_envelope(client: TestClient) -> None:
    error = assert_envelope(client.get("/api/nope"), 404, "not_found")
    assert error["details"] == {}


def test_wrong_method_is_not_found_envelope(client: TestClient) -> None:
    response = client.post("/api/health")
    assert_envelope(response, 404, "not_found")
    assert "allow" not in response.headers


def test_unparsable_json_is_validation_error(probe: TestClient) -> None:
    response = probe.post(
        "/api/_test/payload",
        content=b'{"name": "SENTINEL-value", ',
        headers={"Content-Type": "application/json"},
    )
    error = assert_envelope(response, 422, "validation_error")
    assert error["details"] == {"fields": [{"field": "body", "rule": "json_invalid"}]}
    assert "SENTINEL" not in response.text


def test_wrong_content_type_is_validation_error(probe: TestClient) -> None:
    response = probe.post(
        "/api/_test/payload", content=b"name=x", headers={"Content-Type": "text/plain"}
    )
    assert_envelope(response, 422, "validation_error")


def test_validation_error_reports_fields_and_rules_but_never_values(probe: TestClient) -> None:
    response = probe.post(
        "/api/_test/payload",
        json={
            "name": "ab",
            "age": "SENTINEL-not-a-number",
            "events": [
                {"answer": "fine"},
                {"answer": "SENTINEL-answer-x", "correct": "SENTINEL-y"},
            ],
            "userId": "SENTINEL-user-id",
        },
    )
    error = assert_envelope(response, 422, "validation_error")
    fields = error["details"]["fields"]
    assert {"field": "name", "rule": "string_too_short"} in fields
    assert {"field": "age", "rule": "int_parsing"} in fields
    assert {"field": "events[1].correct", "rule": "forbidden_field"} in fields
    assert {"field": "userId", "rule": "forbidden_field"} in fields
    assert all(set(item) == {"field", "rule"} for item in fields)
    for leaked in ("not-a-number", "SENTINEL-answer-x", "SENTINEL-y", "SENTINEL-user-id", '"ab"'):
        assert leaked not in response.text


def test_missing_field_rule_is_required(probe: TestClient) -> None:
    error = assert_envelope(probe.post("/api/_test/payload", json={}), 422, "validation_error")
    assert {"field": "name", "rule": "required"} in error["details"]["fields"]


def test_body_above_limit_is_payload_too_large(probe: TestClient) -> None:
    response = probe.post("/api/_test/size", content=b"x" * (65536 + 1))
    assert_envelope(response, 413, "payload_too_large")


def test_body_at_limit_is_accepted(probe: TestClient) -> None:
    response = probe.post("/api/_test/size", content=b"x" * 65536)
    assert response.status_code == 200
    assert response.json() == {"bytes": 65536}


def test_limit_is_checked_before_routing(client: TestClient) -> None:
    assert_envelope(client.post("/api/unknown", content=b"x" * 70000), 413, "payload_too_large")


def test_streamed_body_above_limit_is_rejected(probe: TestClient) -> None:
    def chunks() -> Iterator[bytes]:
        for _ in range(9):  # 9 x 8000 bytes: no Content-Length, chunked transfer
            yield b"x" * 8000

    response = probe.post("/api/_test/size", content=chunks())
    assert_envelope(response, 413, "payload_too_large")


def test_streamed_body_within_limit_reaches_the_handler_intact(probe: TestClient) -> None:
    def chunks() -> Iterator[bytes]:
        for _ in range(5):
            yield b"y" * 8000

    response = probe.post("/api/_test/size", content=chunks())
    assert response.status_code == 200
    assert response.json() == {"bytes": 40000}


def test_understated_content_length_cannot_bypass_the_limit(
    app_factory: Callable[..., FastAPI],
) -> None:
    app = app_factory(QATRA_BODY_LIMIT_BYTES=100)

    @app.post("/api/_test/size")
    async def size(request: Request) -> dict[str, int]:
        return {"bytes": len(await request.body())}

    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        response = client.post(
            "/api/_test/size", content=b"z" * 200, headers={"Content-Length": "10"}
        )
    assert_envelope(response, 413, "payload_too_large")


def test_unexpected_exception_is_internal_without_leaking_anything(
    probe: TestClient, log_lines: list[str]
) -> None:
    response = probe.get("/api/_test/boom")
    error = assert_envelope(response, 500, "internal")
    assert error["details"] == {}
    assert "SENTINEL" not in response.text
    joined = "\n".join(log_lines)
    assert "RuntimeError" in joined
    assert "SENTINEL" not in joined
    assert "postgresql" not in joined


def test_handler_alone_converts_unexpected_exception() -> None:
    bare = FastAPI()
    install_error_handlers(bare)

    @bare.get("/boom")
    async def boom() -> None:
        raise RuntimeError("SENTINEL")

    with TestClient(bare, raise_server_exceptions=False) as client:
        response = client.get("/boom")
    error = assert_envelope(response, 500, "internal")
    assert "SENTINEL" not in response.text
    assert error["details"] == {}


@pytest.mark.parametrize("code", [c for c in SPEC_STATUS if c != "throttled"])
def test_app_error_uses_status_derived_from_code(probe: TestClient, code: str) -> None:
    response = probe.get(f"/api/_test/app-error/{code}")
    error = assert_envelope(response, SPEC_STATUS[code], code)
    assert error["message"] == ErrorCode(code).default_message
    assert "retry-after" not in response.headers


def test_throttled_carries_retry_after_header_and_detail(probe: TestClient) -> None:
    response = probe.get("/api/_test/app-error/throttled")
    error = assert_envelope(response, 429, "throttled")
    assert response.headers["retry-after"] == "30"
    assert error["details"] == {"retryAfterSec": 30}


def test_app_error_details_are_passed_through(probe: TestClient) -> None:
    error = assert_envelope(
        probe.get("/api/_test/app-error/version_conflict"), 409, "version_conflict"
    )
    assert error["details"] == {"reason": "plan_version", "currentVersion": 3}


@pytest.mark.parametrize(
    ("status", "code", "expected_status"),
    [
        (404, "not_found", 404),
        (405, "not_found", 404),
        (400, "validation_error", 422),
        (415, "validation_error", 422),
        (413, "payload_too_large", 413),
        (503, "internal", 500),
    ],
)
def test_framework_http_exceptions_are_converted(
    probe: TestClient, status: int, code: str, expected_status: int
) -> None:
    response = probe.get(f"/api/_test/http/{status}")
    assert_envelope(response, expected_status, code)
    assert "SENTINEL" not in response.text
