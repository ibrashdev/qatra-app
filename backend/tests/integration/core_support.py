"""Helpers of the integration tests: one app per backend with the hooks only a backend has.

``require_session`` is overridden here only (TEST ONLY: authentication is another package);
everything else is the production wiring of ``create_app``.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domain.learning_state import AttemptRecord
from app.main import create_app
from app.repositories.learning import InMemoryLearningStore
from tests.integration.fake_project import OTHER_TOKEN, FakeProject
from tests.plans.plans_support import Clock, login_as, session_context
from tests.sessions.ss_learning_support import Harness
from tests.sessions.ss_postgrest import ANON, TOKEN
from tests.sessions.ss_support import (
    QURAN_EDITION,
    USER,
)
from tests.support import FRONTEND_ORIGIN, make_settings

DATA = Path(__file__).resolve().parents[1] / "data"
BUNDLES = f"{DATA / 'synthetic_bundle.json'},{DATA / 'synthetic_bundle_hadith.json'}"
NOW = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)  # 11:00 on 2026-10-05 in Asia/Dubai
PLACEMENT = {
    "kind": "placement",
    "editionId": str(QURAN_EDITION),
    "targetScope": {"sectionOrdinals": [1, 2, 3]},
}
SCOPE = {"editionId": str(QURAN_EDITION), "targetScope": {"sectionOrdinals": [1, 2, 3]}}


def daily(plan_id: str, version: int) -> dict[str, Any]:
    return {"kind": "daily", "planId": plan_id, "expectedPlanVersion": version}


def learned(snapshot: dict[str, Any]) -> list[str]:
    return [s["passage"]["passageId"] for s in snapshot["steps"] if s["type"] == "learn"]


def questions(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    return [s["question"] for s in snapshot["steps"] if s["type"] == "question"]


@dataclass
class Mode:
    """One backend of the journey: the client plus what only the backend can do."""

    name: str
    app: FastAPI
    client: TestClient
    clock: Clock
    seed_attempt: Callable[[AttemptRecord], None]
    complete: Callable[[str], None]
    session_version_id: Callable[[str], str | None]
    version_id: Callable[[str, int], str]
    complete_plan: Callable[[str], None]
    revoke_edition: Callable[[], None]

    def post(self, path: str, body: dict[str, Any] | None = None):
        return self.client.post(path, json=body) if body is not None else self.client.post(path)

    def login(self, user_id: UUID = USER) -> None:
        token = None if self.name == "memory" else (TOKEN if user_id == USER else OTHER_TOKEN)
        login_as(self.app, user_id, token=token)

    def create_plan(self, *, sections: tuple[int, ...] = (1, 2, 3), minutes: int = 5) -> dict:
        """E15 then E16 for the Quran edition, the way a client confirms an estimate."""
        body = {
            "editionId": str(QURAN_EDITION),
            "targetScope": {"sectionOrdinals": list(sections)},
            "paths": ["quran"],
            "sessionMinutes": minutes,
        }
        estimate = self.post("/api/plans/estimate", body).json()["estimate"]
        response = self.post("/api/plans", {**body, "order": "book", "confirmedEstimate": estimate})
        assert response.status_code == 201
        return response.json()


def memory_mode() -> Mode:
    clock = Clock(NOW)
    app = create_app(make_settings(QATRA_CONTENT_BUNDLES=BUNDLES), clock=clock)
    login_as(app, USER)
    store = app.state.learning_repository
    assert isinstance(store, InMemoryLearningStore)
    plans = app.state.plan_service._plans
    context = session_context(USER)
    return Mode(
        "memory",
        app,
        TestClient(app, headers={"Origin": FRONTEND_ORIGIN}),
        clock,
        Harness("memory", store, store=store).seed_attempt,
        lambda session_id: store.mark_completed(context, UUID(session_id)),
        lambda session_id: str(store.sessions[UUID(session_id)].plan_version_id),
        lambda plan_id, number: str(plans.versions_of(UUID(plan_id))[number - 1]["versionId"]),
        lambda plan_id: plans.complete_plan(UUID(plan_id)),
        lambda: app.state.bank_repository.set_status(QURAN_EDITION, "revoked"),
    )


def supabase_mode() -> tuple[Mode, FakeProject]:
    project = FakeProject()
    clock = Clock(NOW)
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL="https://project.example",
        SUPABASE_ANON_KEY=ANON,
    )
    app = create_app(settings, clock=clock, transport=project.transport())
    login_as(app, USER, token=TOKEN)

    def complete(session_id: str) -> None:
        for row in project.bank.tables["learning_sessions"]:
            if row["id"] == session_id:
                row["status"] = "completed"

    def session_version_id(session_id: str) -> str | None:
        row = next(r for r in project.bank.tables["learning_sessions"] if r["id"] == session_id)
        return row["plan_version_id"]

    def version_id(plan_id: str, number: int) -> str:
        row = next(
            v
            for v in project.plans.versions
            if v["plan_id"] == plan_id and v["version_no"] == number
        )
        return row["id"]

    mode = Mode(
        "supabase",
        app,
        TestClient(app, headers={"Origin": FRONTEND_ORIGIN}),
        clock,
        Harness("supabase", None, fake=project.bank).seed_attempt,  # type: ignore[arg-type]
        complete,
        session_version_id,
        version_id,
        lambda plan_id: project.plans.plans[plan_id].update(status="completed"),
        lambda: revoke(project),
    )
    return mode, project


def revoke(project: FakeProject) -> None:
    project.bank.set_edition_status("revoked", str(QURAN_EDITION))
    project.plans.unreadable_editions.add(str(QURAN_EDITION))


def placement_attempt(
    session: dict[str, Any], question: dict[str, Any], **answer: bool
) -> AttemptRecord:
    return AttemptRecord(
        id=uuid.uuid4(),
        user_id=USER,
        session_id=UUID(session["sessionId"]),
        edition_id=QURAN_EDITION,
        client_event_id=uuid.uuid4(),
        question_id=UUID(question["questionId"]),
        passage_id=UUID(question["passageId"]),
        correct=answer["correct"],
        assisted=answer.get("assisted", False),
        duration_ms=1500,
        occurred_at=NOW,
        created_at=NOW,
    )
