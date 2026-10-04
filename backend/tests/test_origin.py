from __future__ import annotations

import json
import re
from collections.abc import Iterator
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.requests import Request

from app.dependencies import require_session, require_valid_origin
from app.domain.origin_policy import is_origin_allowed
from app.middleware import OriginGuardMiddleware
from tests.support import FRONTEND_ORIGIN, make_settings

MUTATING = ("post", "put", "patch", "delete")


@pytest.fixture
def probe(app: FastAPI) -> Iterator[TestClient]:
    guard = [Depends(require_valid_origin)]

    async def handler() -> dict[str, bool]:
        return {"ok": True}

    for method in MUTATING:
        app.add_api_route(
            "/api/_test/mutate", handler, methods=[method.upper()], dependencies=guard
        )
    app.add_api_route("/api/_test/read", handler, methods=["GET"], dependencies=guard)
    app.add_api_route(
        "/api/_test/session-mutate",
        handler,
        methods=["POST"],
        dependencies=[Depends(require_valid_origin), Depends(require_session)],
    )
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize("method", MUTATING)
def test_mutation_without_origin_is_forbidden(probe: TestClient, method: str) -> None:
    response = probe.request(method, "/api/_test/mutate")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_origin"


@pytest.mark.parametrize(
    "origin",
    [
        "http://evil.example",
        "http://localhost:3001",
        "https://localhost:3000",
        "http://localhost:3000/",
        "HTTP://LOCALHOST:3000",
        "null",
        "",
    ],
)
def test_mutation_with_wrong_origin_is_forbidden(probe: TestClient, origin: str) -> None:
    response = probe.post("/api/_test/mutate", headers={"Origin": origin})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_origin"


@pytest.mark.parametrize("method", MUTATING)
def test_mutation_with_matching_origin_passes(probe: TestClient, method: str) -> None:
    response = probe.request(method, "/api/_test/mutate", headers={"Origin": FRONTEND_ORIGIN})
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_get_is_exempt(probe: TestClient) -> None:
    assert probe.get("/api/_test/read").status_code == 200
    assert (
        probe.get("/api/_test/read", headers={"Origin": "http://evil.example"}).status_code == 200
    )


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_safe_methods_are_exempt_when_called_directly(method: str) -> None:
    request = Request(
        {
            "type": "http",
            "method": method,
            "headers": [],
            "app": SimpleNamespace(state=SimpleNamespace(settings=make_settings())),
        }
    )
    assert require_valid_origin(request) is None


def test_origin_is_checked_before_the_session(probe: TestClient) -> None:
    bad = probe.post("/api/_test/session-mutate", headers={"Origin": "http://evil.example"})
    assert bad.json()["error"]["code"] == "forbidden_origin"
    good = probe.post("/api/_test/session-mutate", headers={"Origin": FRONTEND_ORIGIN})
    assert good.status_code == 401
    assert good.json()["error"]["code"] == "unauthenticated"


def without_origin_guard(app: FastAPI) -> FastAPI:
    """Remove ``OriginGuardMiddleware`` so that only the per-route dependency is exercised.

    Must be called before the first request (the middleware stack is built lazily).
    """
    app.user_middleware = [m for m in app.user_middleware if m.cls is not OriginGuardMiddleware]
    app.middleware_stack = None
    return app


def unguarded_mutations(app: FastAPI) -> list[str]:
    """Mutations whose per-route dependency does not answer a request without ``Origin`` with
    ``403 forbidden_origin``, checked with the ASGI guard removed.

    Black box over the OpenAPI document, so the check also proves that the dependency runs
    before authentication. Defence in depth for later packages: a new POST/PUT/PATCH/DELETE
    route may not skip ``require_valid_origin``, even though the ASGI guard runs first.
    """
    without_origin_guard(app)
    unguarded: list[str] = []
    with TestClient(app) as client:
        for path, operations in app.openapi()["paths"].items():
            for method in operations:
                if method.upper() not in {"POST", "PUT", "PATCH", "DELETE"}:
                    continue
                url = re.sub(r"\{[^}]+\}", "00000000-0000-0000-0000-000000000000", path)
                response = client.request(method, url)
                error = response.json().get("error", {}) if response.status_code >= 400 else {}
                if response.status_code != 403 or error.get("code") != "forbidden_origin":
                    unguarded.append(f"{method.upper()} {path}")
    return unguarded


def test_every_state_changing_route_of_the_application_checks_origin_first(app: FastAPI) -> None:
    assert unguarded_mutations(app) == []


def test_the_guard_detects_a_mutation_that_skips_the_check(app: FastAPI) -> None:
    @app.post("/api/_test/unguarded")
    async def unguarded() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/_test/guarded-after-session", dependencies=[Depends(require_session)])
    async def wrong_order() -> dict[str, bool]:
        return {"ok": True}

    assert unguarded_mutations(app) == [
        "POST /api/_test/unguarded",
        "POST /api/_test/guarded-after-session",
    ]


# --- OriginGuardMiddleware: strict API-spec §1.3 ordering --------------------------------------

OVERSIZED = b"x" * (65536 + 1)


class _Payload(BaseModel):
    name: str


@pytest.fixture
def guarded(app: FastAPI) -> Iterator[TestClient]:
    """Routes WITHOUT the dependency: only the ASGI guard can reject a wrong Origin."""

    @app.post("/api/_test/body")
    async def body(payload: _Payload) -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/_test/size")
    async def size(request: Request) -> dict[str, int]:
        return {"bytes": len(await request.body())}

    with TestClient(app) as client:  # no default Origin header
        yield client


def assert_forbidden_origin(response) -> None:
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_origin"


@pytest.mark.parametrize("origin", [None, "http://evil.example"])
def test_wrong_or_missing_origin_with_oversized_body_is_403_not_413(
    guarded: TestClient, origin: str | None
) -> None:
    headers = {"Origin": origin} if origin else {}
    assert_forbidden_origin(guarded.post("/api/_test/size", content=OVERSIZED, headers=headers))


def test_wrong_origin_with_oversized_streamed_body_is_403_not_413(guarded: TestClient) -> None:
    def chunks() -> Iterator[bytes]:
        for _ in range(9):
            yield b"x" * 8000

    response = guarded.post(
        "/api/_test/size", content=chunks(), headers={"Origin": "http://evil.example"}
    )
    assert_forbidden_origin(response)


@pytest.mark.parametrize("origin", [None, "http://evil.example"])
def test_wrong_or_missing_origin_with_unparsable_json_is_403_not_422(
    guarded: TestClient, origin: str | None
) -> None:
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    response = guarded.post("/api/_test/body", content=b'{"name": ', headers=headers)
    assert_forbidden_origin(response)


@pytest.mark.parametrize("method", MUTATING)
def test_wrong_origin_on_an_unknown_route_is_403_not_404(guarded: TestClient, method: str) -> None:
    response = guarded.request(
        method, "/api/does-not-exist", headers={"Origin": "http://x.example"}
    )
    assert_forbidden_origin(response)


def test_the_guard_rejects_without_the_per_route_dependency(guarded: TestClient) -> None:
    assert_forbidden_origin(guarded.post("/api/_test/size", content=b"abc"))


def test_matching_origin_with_oversized_body_is_413(guarded: TestClient) -> None:
    response = guarded.post(
        "/api/_test/size", content=OVERSIZED, headers={"Origin": FRONTEND_ORIGIN}
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_matching_origin_reaches_the_handler(guarded: TestClient) -> None:
    response = guarded.post("/api/_test/size", content=b"abc", headers={"Origin": FRONTEND_ORIGIN})
    assert response.status_code == 200
    assert response.json() == {"bytes": 3}


def test_matching_origin_with_unparsable_json_is_422(guarded: TestClient) -> None:
    response = guarded.post(
        "/api/_test/body",
        content=b'{"name": ',
        headers={"Origin": FRONTEND_ORIGIN, "Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("path", ["/api/health", "/api/health/ready", "/api/does-not-exist"])
def test_get_without_origin_is_unaffected_by_the_guard(guarded: TestClient, path: str) -> None:
    response = guarded.get(path)
    assert response.status_code in {200, 404}
    assert response.json().get("error", {}).get("code") != "forbidden_origin"


@pytest.mark.parametrize("method", ["HEAD", "OPTIONS"])
def test_head_and_options_pass_through_the_guard(guarded: TestClient, method: str) -> None:
    response = guarded.request(method, "/api/does-not-exist")
    assert response.status_code == 404  # reached routing: not rejected as forbidden_origin


def test_guarded_rejection_is_logged_with_its_error_code(
    guarded: TestClient, log_lines: list[str]
) -> None:
    guarded.post("/api/_test/size", content=OVERSIZED, headers={"Origin": "http://evil.example"})
    entries = [json.loads(line) for line in log_lines if '"event":"request"' in line]
    (entry,) = entries
    assert entry["status"] == 403
    assert entry["error_code"] == "forbidden_origin"
    assert entry["method"] == "POST"
    assert "evil.example" not in "\n".join(log_lines)


def test_guard_rejection_carries_no_store(guarded: TestClient) -> None:
    response = guarded.post("/api/_test/size", content=b"abc")
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("method", "origin", "expected", "allowed"),
    [
        ("GET", None, "http://a.example", True),
        ("get", "http://b.example", "http://a.example", True),
        ("HEAD", None, "http://a.example", True),
        ("OPTIONS", None, None, True),
        ("POST", "http://a.example", "http://a.example", True),
        ("post", "http://a.example", "http://a.example", True),
        ("POST", None, "http://a.example", False),
        ("POST", "", "http://a.example", False),
        ("POST", "http://a.example/", "http://a.example", False),
        ("PUT", "http://A.example", "http://a.example", False),
        ("DELETE", "http://a.example", None, False),
        ("PATCH", None, None, False),
    ],
)
def test_origin_policy(
    method: str, origin: str | None, expected: str | None, allowed: bool
) -> None:
    assert is_origin_allowed(method, origin, expected) is allowed


@pytest.mark.parametrize("method", MUTATING)
def test_dependency_alone_still_rejects_without_the_asgi_guard(app: FastAPI, method: str) -> None:
    """Defence in depth: with the ASGI guard removed, the per-route dependency rejects."""

    async def handler() -> dict[str, bool]:
        return {"ok": True}

    app.add_api_route(
        "/api/_test/dep-only",
        handler,
        methods=[method.upper()],
        dependencies=[Depends(require_valid_origin)],
    )
    without_origin_guard(app)
    with TestClient(app) as client:
        assert_forbidden_origin(client.request(method, "/api/_test/dep-only"))
        ok = client.request(method, "/api/_test/dep-only", headers={"Origin": FRONTEND_ORIGIN})
        assert ok.status_code == 200


def test_middleware_order_is_nostore_accesslog_originguard_bodylimit(app: FastAPI) -> None:
    assert [m.cls.__name__ for m in app.user_middleware] == [
        "NoStoreMiddleware",
        "AccessLogMiddleware",
        "OriginGuardMiddleware",
        "BodyLimitMiddleware",
    ]
