"""Helpers for the end-to-end tests of E31-E34 on the production wiring of ``create_app``.

Memory mode uses the real session: an account registers through E03 and its cookie identifies it,
so no ``require_session`` override is involved. The model is a mocked OpenRouter
(``httpx.MockTransport``): no test calls a live provider. Synthetic bundles only.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.contracts_plan_chat import PlanParameters, TargetScope
from app.dependencies import SessionContext
from app.domain import plan_chat_templates as templates
from app.domain.auth_policy import normalize_username
from app.main import create_app
from app.providers.openrouter import OpenRouterProvider
from app.repositories.accounts import InMemoryAccounts
from app.services.plan_chat import PlanChatGateway
from app.wiring import install_plan_chat
from tests.auth.auth_support import USERNAME, registration
from tests.plans.plans_support import Clock
from tests.sessions.ss_support import QURAN_EDITION
from tests.support import FRONTEND_ORIGIN, make_settings

DATA = Path(__file__).resolve().parents[1] / "data"
BUNDLES = f"{DATA / 'synthetic_bundle.json'},{DATA / 'synthetic_bundle_hadith.json'}"
NOW = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)  # 11:00 on 2026-10-05 in Asia/Dubai
COOKIE = "qatra_session"
ANYONE = SessionContext(user_id=UUID(int=1), is_demo=False, auth_epoch=1)
FREE_GOAL = "a free text goal about the schedule"  # logistics: reaches the model when allowed
MODEL_ID = "free/mock-model:free"


class FakeOpenRouter:
    """A mocked OpenRouter: the models list (one free model) and chat completions. Every request
    is kept, so a test can serialize what would have left the server."""

    def __init__(self, *replies: dict[str, Any]) -> None:
        self.replies = list(replies) or [{"intent": "question", "reply": "Fine."}]
        self.requests: list[httpx.Request] = []
        self.completions: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/models"):
            entry = {
                "id": MODEL_ID,
                "pricing": {"prompt": "0", "completion": "0"},
                "supported_parameters": ["response_format"],
            }
            return httpx.Response(200, json={"data": [entry]})
        self.completions.append(request)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(reply)}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 4},
            },
        )

    def provider(self, settings: Settings) -> OpenRouterProvider:
        return OpenRouterProvider(settings, httpx.MockTransport(self.handler))

    def wire(self) -> str:
        """Every request as text: method, URL, headers and body."""
        return "\n".join(
            f"{r.method} {r.url}\n{dict(r.headers)}\n{r.content.decode()}" for r in self.requests
        )


class Journey:
    """One application in memory mode with its clock and a signed-in browser."""

    def __init__(self, app: FastAPI, client: TestClient, clock: Clock, settings: Settings) -> None:
        self.app = app
        self.client = client
        self.clock = clock
        self.settings = settings

    @property
    def gateway(self) -> PlanChatGateway:
        gateway = self.app.state.plan_chat_service
        assert isinstance(gateway, PlanChatGateway)
        return gateway

    def user_id(self, username: str = USERNAME) -> UUID:
        store: InMemoryAccounts = self.app.state.account_repository
        handle = store.find_handle(normalize_username(username))
        assert handle is not None
        return handle.user_id

    def register(self, client: TestClient | None = None, username: str = USERNAME) -> None:
        response = (client or self.client).post(
            "/api/auth/register", json=registration(username=username)
        )
        assert response.status_code == 201

    def other_browser(self, username: str) -> TestClient:
        other = TestClient(self.app, headers={"Origin": FRONTEND_ORIGIN})
        self.register(other, username)
        return other

    def sensitive_values(self, client: TestClient | None = None) -> dict[str, str]:
        """What must never leave the server: the account, the session and the cookie."""
        browser = client or self.client
        cookie = browser.cookies.get(COOKIE)
        resolved = self.app.state.session_resolver.resolve(cookie, enforce_terms=False)
        values = {
            "user id": str(resolved.context.user_id),
            "username": resolved.username,
            "auth alias": resolved.internal_alias,
            "session id": str(resolved.context.session_id),
            "cookie": cookie or "",
            "session hash": resolved.session_hash.hex(),
            "access token": resolved.tokens.access,
            "refresh token": resolved.tokens.refresh,
        }
        assert all(values.values())
        return values

    def goal_for(self, body: dict[str, Any], language: str = "en") -> str:
        """The sentence the start form composes for ``body`` (a first turn without a model)."""
        ports = self.app.state.plan_service.ports_for(ANYONE)  # the catalog is public
        catalog = ports.catalog_edition(UUID(body["editionId"]))
        params = PlanParameters(
            edition_id=UUID(body["editionId"]),
            target_scope=TargetScope(section_ordinals=body["targetScope"]["sectionOrdinals"]),
            paths=body["paths"],
            order="book",
            session_minutes=body["sessionMinutes"],
            preferred_date=date.fromisoformat(body["preferredDate"])
            if body.get("preferredDate")
            else None,
        )
        return templates.compose_goal_sentence(catalog, params, language)

    def body(self, *, goal: str | None = None, **overrides: Any) -> dict[str, Any]:
        """An E31 body for the synthetic Quran edition. Without ``goal`` the goal text is the
        composed sentence, so the first turn makes no model call."""
        body: dict[str, Any] = {
            "editionId": str(QURAN_EDITION),
            "targetScope": {"sectionOrdinals": [1, 2, 3]},
            "paths": ["quran"],
            "sessionMinutes": 5,
            "goalText": "x",
            "language": "en",
        }
        body.update(overrides)
        body["goalText"] = goal if goal is not None else self.goal_for(body, body["language"])
        return body

    def create_chat(
        self, client: TestClient | None = None, *, goal: str | None = None, **overrides: Any
    ) -> dict[str, Any]:
        response = (client or self.client).post(
            "/api/plan-chats", json=self.body(goal=goal, **overrides)
        )
        assert response.status_code == 201, response.text
        chat: dict[str, Any] = response.json()
        return chat


def build_journey(*, signed_in: bool = True, **setting_overrides: Any) -> Journey:
    """``create_app`` in memory mode over the synthetic bundles with a settable clock; the
    browser is registered (E03) unless ``signed_in`` is false."""
    settings = make_settings(QATRA_CONTENT_BUNDLES=BUNDLES, **setting_overrides)
    clock = Clock(NOW)
    app = create_app(settings, clock=clock)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    journey = Journey(app, client, clock, settings)
    if signed_in:
        journey.register()
    return journey


def with_model(journey: Journey, fake: FakeOpenRouter) -> Journey:
    """Replace the conversation of ``journey`` by one whose provider is ``fake`` (the seam of
    ``install_plan_chat``; the rest of the wiring stays as ``create_app`` made it)."""
    install_plan_chat(
        journey.app, journey.settings, provider=fake.provider(journey.settings), clock=journey.clock
    )
    return journey
