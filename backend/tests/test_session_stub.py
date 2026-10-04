from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.dependencies import SessionContext, require_session
from app.errors import AppError, ErrorCode


@pytest.fixture
def probe(app: FastAPI) -> Iterator[TestClient]:
    @app.get("/api/_test/whoami")
    async def whoami(
        context: Annotated[SessionContext, Depends(require_session)],
    ) -> dict[str, str]:
        return {"userId": str(context.user_id)}

    with TestClient(app) as client:
        yield client


def test_require_session_always_denies_without_credentials(probe: TestClient) -> None:
    response = probe.get("/api/_test/whoami")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_require_session_denies_even_with_cookies_headers_and_query_present(
    probe: TestClient,
) -> None:
    probe.cookies.set("__Host-qatra_session", "0123456789abcdef")
    probe.cookies.set("session", "another")
    response = probe.get(
        "/api/_test/whoami",
        params={"userId": "11111111-1111-1111-1111-111111111111", "isDemo": "true"},
        headers={
            "Authorization": "Bearer abc.def.ghi",
            "X-User-Id": "11111111-1111-1111-1111-111111111111",
            "X-Forwarded-User": "someone",
        },
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


def test_require_session_raises_unauthenticated_when_called_directly() -> None:
    request = Request({"type": "http", "method": "GET", "headers": [(b"x-user-id", b"1")]})
    with pytest.raises(AppError) as raised:
        require_session(request)
    assert raised.value.code is ErrorCode.unauthenticated


def test_session_context_has_the_documented_fields() -> None:
    context = SessionContext(
        user_id=UUID("11111111-1111-1111-1111-111111111111"), is_demo=False, auth_epoch=0
    )
    assert (context.is_demo, context.auth_epoch) == (False, 0)
    with pytest.raises(AttributeError):
        context.is_demo = True  # type: ignore[misc]
