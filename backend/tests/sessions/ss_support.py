"""Fixtures for the service and route tests of E20 (synthetic bundles only, no network).

``Env`` wires a ``SessionService`` over the in-memory repositories and the committed synthetic
bundles, with a fake ``PlanAccess`` (it enforces ownership like B4 will) and a fixed calendar.
``login_as`` replaces ``require_session`` with a fake context: a TEST-ONLY shortcut, never a real
session cookie.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from pydantic import SecretStr

from app.contracts_sessions import SessionSnapshot
from app.dependencies import SessionContext, require_session
from app.errors import AppError, ErrorCode
from app.main import create_app
from app.repositories.bank import InMemoryBankRepository
from app.repositories.learning import InMemoryLearningStore
from app.routers.sessions import install_sessions
from app.services.sessions import PlanSnapshot, SessionService
from app.workflow.bundle import loads_bundle
from tests.support import make_settings

DATA = Path(__file__).resolve().parent.parent / "data"
TODAY = date(2026, 10, 5)
NOW = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
USER = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")
OTHER_USER = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")
PLAN_ID = uuid.UUID("44444444-4444-4444-8444-000000000001")
PLAN_B_ID = uuid.UUID("44444444-4444-4444-8444-000000000002")
PLAN_VERSION_ID = uuid.UUID("44444444-4444-4444-8444-0000000000a2")


def load_bundle(name: str) -> dict[str, Any]:
    return loads_bundle((DATA / name).read_text(encoding="utf-8"))


QURAN = load_bundle("synthetic_bundle.json")
HADITH = load_bundle("synthetic_bundle_hadith.json")
QURAN_EDITION = UUID(QURAN["edition"]["id"])
HADITH_EDITION = UUID(HADITH["edition"]["id"])
QURAN_PASSAGES = [UUID(p["id"]) for p in QURAN["passages"]]


def ctx(user_id: UUID = USER, *, demo: bool = False, token: str | None = None) -> SessionContext:
    return SessionContext(
        user_id=user_id,
        is_demo=demo,
        auth_epoch=1,
        access_token=None if token is None else SecretStr(token),
    )


def quran_plan(**overrides: Any) -> PlanSnapshot:
    values: dict[str, Any] = {
        "plan_id": PLAN_ID,
        "status": "active",
        "current_version": 2,
        "plan_version_id": PLAN_VERSION_ID,
        "edition_id": QURAN_EDITION,
        "bank_version": 1,
        "section_ordinals": (1, 2, 3),
        "paths": ("quran",),
        "order": "book",
        "session_minutes": 10,
    }
    values.update(overrides)
    return PlanSnapshot(**values)


def hadith_plan(**overrides: Any) -> PlanSnapshot:
    values: dict[str, Any] = {
        "plan_id": PLAN_B_ID,
        "edition_id": HADITH_EDITION,
        "section_ordinals": (1, 2, 3, 4),
        "paths": ("matn", "sanad", "grade"),
        "session_minutes": 15,
    }
    values.update(overrides)
    return quran_plan(**values)


class FakePlanAccess:
    """B4's port in memory: a plan is visible to its owner only (404 otherwise)."""

    def __init__(self) -> None:
        self._plans: dict[UUID, tuple[UUID, PlanSnapshot]] = {}
        self.calls = 0

    def add(self, plan: PlanSnapshot, owner: UUID = USER) -> PlanSnapshot:
        self._plans[plan.plan_id] = (owner, plan)
        return plan

    def update(self, plan_id: UUID, **changes: Any) -> PlanSnapshot:
        owner, plan = self._plans[plan_id]
        updated = replace(plan, **changes)
        self._plans[plan_id] = (owner, updated)
        return updated

    def owned_by(self, owner: UUID) -> list[PlanSnapshot]:
        """The owner's plans, newest first (the order the plan repository lists them in)."""
        return [plan for who, plan in reversed(list(self._plans.values())) if who == owner]

    def load_for_session(self, ctx: SessionContext, plan_id: UUID) -> PlanSnapshot:
        self.calls += 1
        owner, plan = self._plans.get(plan_id, (None, None))  # type: ignore[assignment]
        if plan is None or owner != ctx.user_id:
            raise AppError(ErrorCode.not_found)
        return plan


class FixedCalendar:
    def __init__(self, today: date = TODAY) -> None:
        self.today = today

    def learning_date(self, ctx: SessionContext) -> date:
        return self.today


class Env:
    """A wired service with every collaborator reachable for assertions."""

    def __init__(self, *, bundles: Sequence[dict[str, Any]] = (QURAN, HADITH)) -> None:
        self.bank = InMemoryBankRepository(bundles)
        self.store = InMemoryLearningStore()
        self.plans = FakePlanAccess()
        self.calendar = FixedCalendar()
        self._ids = iter(uuid.UUID(f"55555555-5555-4555-8555-{n:012d}") for n in range(1, 10_000))
        self.service = SessionService(
            bank=self.bank,
            learning=self.store,
            plans=self.plans,
            calendar=self.calendar,
            clock=lambda: NOW,
            new_id=lambda: next(self._ids),
        )
        self.plans.add(quran_plan())
        self.plans.add(hadith_plan())

    def create(
        self, body: dict[str, Any], *, context: SessionContext | None = None
    ) -> tuple[SessionSnapshot, bool]:
        created = self.service.create_session(context or ctx(), self.service.parse_request(body))
        return created.snapshot, created.created

    def daily(
        self, plan_id: UUID = PLAN_ID, version: int = 2, **kw: Any
    ) -> tuple[SessionSnapshot, bool]:
        return self.create(
            {"kind": "daily", "planId": str(plan_id), "expectedPlanVersion": version}, **kw
        )

    def game(
        self, plan_id: UUID = PLAN_ID, version: int = 2, **extra: Any
    ) -> tuple[SessionSnapshot, bool]:
        body = {"kind": "game", "planId": str(plan_id), "expectedPlanVersion": version, **extra}
        return self.create(body)

    def placement(
        self, edition: UUID = QURAN_EDITION, scope: Sequence[int] = (1, 2, 3), **extra: Any
    ):
        body = {
            "kind": "placement",
            "editionId": str(edition),
            "targetScope": {"sectionOrdinals": list(scope)},
            **extra,
        }
        return self.create(body)


def error_of(call) -> AppError:
    """The ``AppError`` a callable raises."""
    try:
        call()
    except AppError as error:
        return error
    raise AssertionError("expected an AppError")


def field_rules(error: AppError) -> list[tuple[str, str]]:
    return [(f["field"], f["rule"]) for f in error.details["fields"]]


def steps_json(snapshot: SessionSnapshot) -> list[dict[str, Any]]:
    return json.loads(snapshot.model_dump_json(by_alias=True))["steps"]


def questions_json(snapshot: SessionSnapshot) -> list[dict[str, Any]]:
    return [s["question"] for s in steps_json(snapshot) if s["type"] == "question"]


def learn_json(snapshot: SessionSnapshot) -> list[dict[str, Any]]:
    return [s["passage"] for s in steps_json(snapshot) if s["type"] == "learn"]


def login_as(app: FastAPI, user_id: UUID = USER, *, demo: bool = False) -> None:
    """TEST ONLY: replace ``require_session`` with a fake context (never a real cookie)."""
    app.dependency_overrides[require_session] = lambda: ctx(user_id, demo=demo)


def make_app(env: Env, **settings: Any) -> FastAPI:
    app_settings = make_settings(**settings)
    app = create_app(app_settings)
    install_sessions(
        app,
        app_settings,
        plans=env.plans,
        calendar=env.calendar,
        bank=env.bank,
        learning=env.store,
        clock=lambda: NOW,
        new_id=env.service._new_id,
    )
    return app
