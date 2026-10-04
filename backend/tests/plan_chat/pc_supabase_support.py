"""Helpers for the supabase-mode tests of E31-E34: the application over a fake Supabase project
(``ChatProject``), a fake restricted database connection for the usage ledger, and the learner
session of the integration tests (``require_session`` is overridden: TEST ONLY, never a cookie).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from uuid import UUID

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.contracts_plan_chat import PlanParameters, TargetScope
from app.domain import plan_chat_templates as templates
from app.main import create_app
from app.services.plan_chat import PlanChatGateway
from app.wiring import install_plan_chat
from tests.integration.fake_project import OTHER_TOKEN
from tests.plan_chat.pc_e2e_support import ANYONE, MODEL_ID, NOW, FakeOpenRouter
from tests.plan_chat.pc_postgrest import ChatProject
from tests.plans.plans_support import Clock, login_as
from tests.sessions.ss_postgrest import ANON, TOKEN
from tests.sessions.ss_support import OTHER_USER, QURAN_EDITION, USER
from tests.support import FRONTEND_ORIGIN, make_settings

DSN = "postgresql://qatra_server:SENTINEL-password@db.sentinel-host.example:5432/postgres"
MODEL_SETTINGS = {"OPENROUTER_API_KEY": "dummy-key-for-tests", "OPENROUTER_MODELS": MODEL_ID}


class UsageDatabase:
    """A fake ``psycopg.connect`` for the usage ledger: every ``execute`` is kept."""

    def __init__(self) -> None:
        self.connects: list[tuple[str, dict[str, Any]]] = []
        self.statements: list[tuple[str, tuple[Any, ...] | None]] = []
        self.fail: Exception | None = None

    def connect(self, dsn: str, **kwargs: Any) -> UsageDatabase:
        self.connects.append((dsn, kwargs))
        if self.fail is not None:
            raise self.fail
        return self

    def __enter__(self) -> UsageDatabase:
        return self

    def __exit__(self, *rest: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> UsageDatabase:
        self.statements.append((sql, params))
        return self

    @property
    def writes(self) -> list[tuple[Any, ...]]:
        """The parameters of every ``srv_record_ai_usage`` call."""
        return [p for sql, p in self.statements if "srv_record_ai_usage" in sql and p is not None]


class SupabaseJourney:
    """The application in supabase mode over ``ChatProject`` with one signed-in learner."""

    def __init__(
        self,
        project: ChatProject,
        app: FastAPI,
        clock: Clock,
        usage: UsageDatabase,
        settings: Any,
    ) -> None:
        self.project = project
        self.app = app
        self.clock = clock
        self.usage = usage
        self.settings = settings
        self.client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})

    @property
    def gateway(self) -> PlanChatGateway:
        gateway = self.app.state.plan_chat_service
        assert isinstance(gateway, PlanChatGateway)
        return gateway

    def as_other_learner(self) -> None:
        login_as(self.app, OTHER_USER, token=OTHER_TOKEN)

    def as_learner(self) -> None:
        login_as(self.app, USER, token=TOKEN)

    def goal_for(self, body: dict[str, Any], language: str = "en") -> str:
        catalog = self.app.state.plan_service.ports_for(ANYONE).catalog_edition(
            UUID(body["editionId"])
        )
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

    def create_chat(self, *, goal: str | None = None, **overrides: Any) -> dict[str, Any]:
        response = self.client.post("/api/plan-chats", json=self.body(goal=goal, **overrides))
        assert response.status_code == 201, response.text
        chat: dict[str, Any] = response.json()
        return chat

    def post(self, chat_id: str, tail: str, body: dict[str, Any]) -> httpx.Response:
        return self.client.post(f"/api/plan-chats/{chat_id}/{tail}", json=body)

    def chat_requests(self) -> list[httpx.Request]:
        return [r for r in self.project.requests if "/plan_chat" in r.url.path]


def build_supabase_journey(
    usage: UsageDatabase,
    *,
    fake: FakeOpenRouter | None = None,
    configure: Callable[[ChatProject], None] | None = None,
    **setting_overrides: Any,
) -> SupabaseJourney:
    project = ChatProject()
    if configure is not None:
        configure(project)
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL="https://project.example",
        SUPABASE_ANON_KEY=ANON,
        QATRA_SERVER_DB=DSN,
        **setting_overrides,
    )
    clock = Clock(NOW)
    app = create_app(settings, clock=clock, transport=project.transport())
    login_as(app, USER, token=TOKEN)
    if fake is not None:
        install_plan_chat(app, settings, provider=fake.provider(settings), clock=clock)
    return SupabaseJourney(project, app, clock, usage, settings)
