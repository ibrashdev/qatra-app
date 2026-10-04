"""The whole learner journey through one ``create_app`` in memory mode, with the real session.

No ``require_session`` override anywhere: the identity comes from the cookie that E03 sets, through
the resolver that ``create_app`` installs. Synthetic bundles only, no network.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domain.auth_policy import normalize_username
from app.main import create_app
from app.repositories.accounts import InMemoryAccounts
from tests.auth.auth_support import PASSWORD, USERNAME, registration
from tests.integration.core_support import BUNDLES, NOW, PLACEMENT, SCOPE, daily
from tests.plans.plans_support import Clock
from tests.sessions.ss_support import QURAN_EDITION
from tests.support import FRONTEND_ORIGIN, make_settings

COOKIE = "qatra_session"
OTHER_USERNAME = "second_user"


def build() -> tuple[FastAPI, TestClient]:
    app = create_app(make_settings(QATRA_CONTENT_BUNDLES=BUNDLES), clock=Clock(NOW))
    return app, TestClient(app, headers={"Origin": FRONTEND_ORIGIN})


def user_id_of(app: FastAPI, username: str = USERNAME) -> UUID:
    store: InMemoryAccounts = app.state.account_repository
    handle = store.find_handle(normalize_username(username))
    assert handle is not None
    return handle.user_id


def create_plan(client: TestClient) -> dict[str, Any]:
    body = {**SCOPE, "paths": ["quran"], "sessionMinutes": 5}
    estimate = client.post("/api/plans/estimate", json=body)
    assert estimate.status_code == 200
    created = client.post(
        "/api/plans",
        json={**body, "order": "book", "confirmedEstimate": estimate.json()["estimate"]},
    )
    assert created.status_code == 201
    plan: dict[str, Any] = created.json()
    return plan


def test_register_to_logout_with_the_real_session() -> None:
    app, client = build()
    with client:
        registered = client.post("/api/auth/register", json=registration())
        assert registered.status_code == 201
        assert re.fullmatch(r"([0-9a-f]{4}-){7}[0-9a-f]{4}", registered.json()["recoveryCode"])
        assert client.cookies.get(COOKIE)

        login = client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})
        assert login.status_code == 200 and login.json()["reconsentRequired"] is False

        me = client.get("/api/me")
        assert me.status_code == 200 and me.json()["username"] == USERNAME

        catalog = client.get("/api/catalog")
        assert catalog.status_code == 200
        assert str(QURAN_EDITION) in {e["editionId"] for e in catalog.json()["editions"]}

        placement = client.post("/api/sessions", json=PLACEMENT)
        assert placement.status_code == 201

        plan = create_plan(client)
        plan_id = plan["planId"]

        first = client.post("/api/sessions", json=daily(plan_id, 1))
        assert first.status_code == 201
        again = client.post("/api/sessions", json=daily(plan_id, 1))
        assert again.status_code == 200
        assert again.json()["sessionId"] == first.json()["sessionId"]

        revised = client.post(
            f"/api/plans/{plan_id}/revise", json={"expectedVersion": 1, "sessionMinutes": 15}
        )
        assert revised.status_code == 200 and revised.json()["currentVersion"] == 2

        token = client.cookies.get(COOKIE)
        assert client.post("/api/auth/logout").status_code == 204
        assert client.post("/api/sessions", json=daily(plan_id, 2)).status_code == 401
        assert client.get("/api/me").status_code == 401

        # The cookie of the ended session is dead on the server too, not only cleared in the jar.
        client.cookies.set(COOKIE, token or "")
        stale = client.post("/api/sessions", json=daily(plan_id, 2))
        assert stale.status_code == 401
        assert stale.json()["error"]["code"] == "unauthenticated"


def test_the_learning_core_stores_everything_under_the_account_of_the_session() -> None:
    app, client = build()
    with client:
        assert client.post("/api/auth/register", json=registration()).status_code == 201
        user_id = user_id_of(app)
        plan = create_plan(client)
        assert client.post("/api/sessions", json=PLACEMENT).status_code == 201
        assert client.post("/api/sessions", json=daily(plan["planId"], 1)).status_code == 201

    plans = app.state.plan_service._plans._plans
    assert {p.user_id for p in plans.values()} == {user_id}
    sessions = app.state.learning_repository.sessions
    assert len(sessions) == 2 and {s.user_id for s in sessions.values()} == {user_id}


def test_one_account_cannot_reach_the_plan_of_another() -> None:
    app, owner = build()
    with owner:
        assert owner.post("/api/auth/register", json=registration()).status_code == 201
        plan_id = create_plan(owner)["planId"]
        other = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
        with other:
            second = registration(username=OTHER_USERNAME)
            assert other.post("/api/auth/register", json=second).status_code == 201
            assert user_id_of(app, OTHER_USERNAME) != user_id_of(app)
            revise = other.post(
                f"/api/plans/{plan_id}/revise", json={"expectedVersion": 1, "sessionMinutes": 10}
            )
            assert revise.status_code == 404
            assert other.post("/api/sessions", json=daily(plan_id, 1)).status_code == 404
        assert owner.get("/api/me").json()["username"] == USERNAME


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/me"),
        ("post", "/api/plans/estimate"),
        ("post", "/api/plans"),
        ("post", "/api/sessions"),
    ],
)
def test_without_a_session_every_protected_call_is_401(method: str, path: str) -> None:
    _, client = build()
    with client:
        response = getattr(client, method)(path)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthenticated"
