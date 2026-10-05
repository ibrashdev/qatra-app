"""Helpers for the demo tests (B10: E26-E29). Synthetic data only: every account name, password and
passage id is made up; the catalog is the synthetic bundle pair of ``tests/data``.

``build_env`` is ``create_app`` in memory mode with a fixed clock, the demo fixtures in a temporary
directory (never the real simulations file) and the planner's provider and usage ledger injected.
Accounts are real: demo accounts come from E26 and learners from E03, each on its own client
(cookie jar) with its own address.

Testing personas (Role 6 verification; they invent no production role)

=================  ===========  ==============================  ================================
Persona            Level        Account ownership               Precondition
=================  ===========  ==============================  ================================
Visitor            A            none                            no cookie
Learner            S            ``learner_one`` only            registered with E03 (is_demo off)
Demo account       D            ``demo_one`` only               registered with E26 (is_demo on)
Second demo        D            ``demo_two`` only               registered with E26 elsewhere
=================  ===========  ==============================  ================================

Allowed and denied: the visitor may use E26 only (E27-E29 answer ``401``); the learner is refused
E27-E29 with ``403 forbidden`` (before the body is looked at); a demo account may use E27-E29 on its
own plans only (no endpoint takes an account id), and a placement session of another account is
``404``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.domain import auth_policy
from app.main import create_app
from app.providers.llm import ProviderUnavailable
from app.repositories.ai_usage import InMemoryUsageLedger
from app.routers.demo import install_demo
from app.services.planner import UNSET
from app.services.plans import PlanningServices, build_planning_services
from tests.support import FRONTEND_ORIGIN, make_settings

BACKEND = Path(__file__).resolve().parents[2]
DATA = BACKEND / "tests" / "data"
BUNDLES = f"{DATA / 'synthetic_bundle.json'},{DATA / 'synthetic_bundle_hadith.json'}"
REAL_FIXTURES = BACKEND.parent / "fixtures"

NOW = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)  # 13:00 on 2026-10-04 in Asia/Dubai
TODAY_ISO = "2026-10-04"
TERMS = "2026-10-04"
PASSWORD = "synthetic passphrase for tests only"


class Clock:
    """A settable clock."""

    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


# --- the fake model ------------------------------------------------------------------------------


@dataclass
class FakeJsonReply:
    data: Any
    model: str = "free-model-x"
    input_tokens: int | None = 120
    output_tokens: int | None = 40
    cost_usd: float | None = None


def good_advice(payload: dict[str, Any], **overrides: Any) -> FakeJsonReply:
    """A valid answer built from the payload it was asked about."""
    data: dict[str, Any] = {
        "newWordsPerDay": 5,
        "reviewOffsetsDays": [1, 3, 7],
        "priorityReviewPassageIds": [payload["passages"][0]["id"]],
    }
    data.update(overrides)
    return FakeJsonReply(data)


def advice_reply(**overrides: Any) -> Callable[[dict[str, Any]], FakeJsonReply]:
    return lambda payload: good_advice(payload, **overrides)


class FakeJsonProvider:
    """Scripted JSON provider: a script item is a reply, an exception or a function of the payload
    (consumed in order, the last one repeats). Calls are recorded."""

    name = "fake"

    def __init__(self, *script: Any, enabled: bool = True) -> None:
        self.script = list(script) or [good_advice]
        self.enabled = enabled
        self.calls: list[dict[str, Any]] = []
        self.kwargs: list[dict[str, Any]] = []

    def is_enabled(self) -> bool:
        return self.enabled

    def complete_json(
        self,
        payload: dict[str, Any],
        *,
        system_prompt: str,
        response_schema: dict[str, Any],
        schema_name: str = "structured_reply",
        max_tokens: int,
        timeout_sec: float,
    ) -> FakeJsonReply:
        self.calls.append(payload)
        self.kwargs.append(
            {
                "system_prompt": system_prompt,
                "response_schema": response_schema,
                "schema_name": schema_name,
                "max_tokens": max_tokens,
                "timeout_sec": timeout_sec,
            }
        )
        item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(item, Exception):
            raise item
        return item(payload) if callable(item) else item


class ChatOnlyProvider:
    """A provider that only has the plan conversation's ``complete`` (no ``complete_json``)."""

    name = "chat-only"

    def __init__(self) -> None:
        self.calls = 0

    def is_enabled(self) -> bool:
        return True

    def complete(self, payload: dict[str, Any], *, max_tokens: int, timeout_sec: float) -> Any:
        self.calls += 1
        raise AssertionError("the demo planner must never call the chat completion")


def unavailable(reason: str, **kwargs: Any) -> ProviderUnavailable:
    return ProviderUnavailable(reason, **kwargs)  # type: ignore[arg-type]


# --- fixtures ------------------------------------------------------------------------------------


def simulation_file(*, label: str = "precomputed_synthetic", **overrides: Any) -> dict[str, Any]:
    """A small valid ``demo_simulations.json`` (the real one is produced by another package)."""
    days = [
        {
            "day": 1,
            "newWords": 25,
            "reviews": 0,
            "lightReviewDay": False,
            "adjustment": None,
            "confirmedWordsCumulative": 0,
            "overallPercent": 0,
        },
        {
            "day": 2,
            "newWords": 0,
            "reviews": 10,
            "lightReviewDay": True,
            "adjustment": "absence_light_review",
            "confirmedWordsCumulative": 25,
            "overallPercent": 25,
        },
    ]
    simulation = {
        "simulationId": "sim-01",
        "scenarioId": "scenario-04",
        "titleAr": "محاكاة اصطناعية",
        "titleEn": "Synthetic simulation",
        "label": label,
        "profile": {"name": "synthetic-small", "totalWords": 100, "sessionMinutes": 10},
        "learnerScript": {"dailyCorrectRate": 0.8, "absentDays": [2], "errorDays": []},
        "days": days,
    }
    body: dict[str, Any] = {
        "fixtureVersion": 1,
        "generator": "backend/scripts/make_demo_simulations.py",
        "generatorVersion": 1,
        "label": label,
        "contentHash": "0" * 64,
        "simulations": [simulation],
    }
    body.update(overrides)
    return body


def write_fixtures(
    directory: Path,
    *,
    scenarios: dict[str, Any] | str | None = None,
    simulations: dict[str, Any] | str | None = None,
) -> Path:
    """Write the two fixture files: the real scenarios (a copy) unless ``scenarios`` is given, and a
    small valid simulations file unless ``simulations`` is given. ``None`` is replaced by the
    default; pass the string ``"missing"`` to leave a file out."""
    directory.mkdir(parents=True, exist_ok=True)
    if scenarios != "missing":
        target = directory / "demo_scenarios.json"
        if scenarios is None:
            shutil.copyfile(REAL_FIXTURES / "demo_scenarios.json", target)
        elif isinstance(scenarios, str):
            target.write_text(scenarios, encoding="utf-8")
        else:
            target.write_text(json.dumps(scenarios, ensure_ascii=False), encoding="utf-8")
    if simulations != "missing":
        target = directory / "demo_simulations.json"
        content = simulation_file() if simulations is None else simulations
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        target.write_text(text, encoding="utf-8")
    return directory


def real_scenarios() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (REAL_FIXTURES / "demo_scenarios.json").read_text(encoding="utf-8")
    )
    return data


# --- the environment -----------------------------------------------------------------------------


def registration(username: str, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "username": username,
        "password": PASSWORD,
        "timeZone": "Asia/Dubai",
        "language": "en",
        "termsAccepted": True,
        "termsVersion": TERMS,
    }
    body.update(overrides)
    return body


@dataclass
class Persona:
    client: TestClient
    username: str
    user_id: UUID
    recovery_code: str = ""


@dataclass
class Env:
    app: FastAPI
    settings: Settings
    clock: Clock
    ledger: InMemoryUsageLedger
    provider: FakeJsonProvider | None
    fixtures: Path
    services: PlanningServices
    personas: list[Persona] = field(default_factory=list)

    def client(self, address: str = "203.0.113.9", *, origin: bool = True) -> TestClient:
        headers = {"Origin": FRONTEND_ORIGIN} if origin else {}
        return TestClient(self.app, headers=headers, client=(address, 50000))

    def user_id(self, username: str) -> UUID:
        handle = self.app.state.account_repository.find_handle(
            auth_policy.normalize_username(username)
        )
        assert handle is not None
        user_id: UUID = handle.user_id
        return user_id

    def demo(self, username: str = "demo_one", address: str = "203.0.113.9") -> Persona:
        client = self.client(address)
        response = client.post("/api/demo/accounts", json=registration(username))
        assert response.status_code == 201, response.text
        persona = Persona(client, username, self.user_id(username), response.json()["recoveryCode"])
        self.personas.append(persona)
        return persona

    def learner(self, username: str = "learner_one", address: str = "203.0.113.20") -> Persona:
        client = self.client(address)
        response = client.post("/api/auth/register", json=registration(username))
        assert response.status_code == 201, response.text
        persona = Persona(client, username, self.user_id(username))
        self.personas.append(persona)
        return persona

    def visitor(self, address: str = "203.0.113.30") -> TestClient:
        return self.client(address)

    @property
    def plan_repository(self) -> Any:
        assert self.services.repository is not None
        return self.services.repository


def build_env(
    tmp_path: Path,
    *,
    provider: Any = None,
    ledger: InMemoryUsageLedger | None = None,
    scenarios: dict[str, Any] | str | None = None,
    simulations: dict[str, Any] | str | None = None,
    bundles: str = BUNDLES,
    clock: Clock | None = None,
    **settings: Any,
) -> Env:
    """An application in memory mode. ``provider=None`` means no model (rules only); a provider
    object is injected as the planner's; ``provider=UNSET`` leaves the lazy lookup of the plan
    conversation in place."""
    moving = clock or Clock()
    fixtures = write_fixtures(tmp_path / "fixtures", scenarios=scenarios, simulations=simulations)
    values: dict[str, Any] = {
        "QATRA_CONTENT_BUNDLES": bundles,
        "QATRA_DEMO_FIXTURES_DIR": str(fixtures),
        "QATRA_RATE_ANONYMOUS_ENTRY_PER_MIN": 10_000,
        "QATRA_RATE_SESSION_READ_PER_MIN": 10_000,
        "QATRA_RATE_SESSION_WRITE_PER_MIN": 10_000,
    }
    values.update(settings)
    app_settings = make_settings(**values)
    app = create_app(app_settings, clock=moving)
    # A seedable placement reader, as plans_support.make_env does.
    services = build_planning_services(app_settings, clock=moving)
    app.state.catalog_service = services.catalog
    app.state.plan_service = services.plans
    usage = ledger or InMemoryUsageLedger()
    install_demo(
        app,
        app_settings,
        provider=UNSET if provider is UNSET else provider,
        ledger=None if provider is UNSET else usage,
        clock=moving,
    )
    return Env(app, app_settings, moving, usage, provider, fixtures, services)


def error_of(response: httpx.Response) -> dict[str, Any]:
    body: dict[str, Any] = response.json()["error"]
    return body


def fields_of(response: httpx.Response) -> list[tuple[str, str]]:
    return [(item["field"], item["rule"]) for item in error_of(response)["details"]["fields"]]
