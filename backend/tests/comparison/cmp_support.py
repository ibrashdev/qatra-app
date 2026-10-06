"""Fixtures and fakes for the comparison tests (synthetic data only)."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from app.config import Settings
from app.providers.llm import ProviderUnavailable
from scripts import ai_comparison as ai
from scripts import demo_catalog as catalog
from tests.support import make_settings

FAKE_KEY = "sk-or-FAKE-KEY-0123456789"
TODAY = date(2026, 10, 5)
REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_SCENARIOS = REPO_ROOT / "fixtures" / "demo_scenarios.json"
REAL_EXPECTATIONS = REPO_ROOT / "fixtures" / "comparison_expectations.json"


def entry(scenario_id: str, qa_case: int, **overrides: Any) -> dict[str, Any]:
    """A scenario in the shape of fixtures/demo_scenarios.json."""
    values: dict[str, Any] = {
        "scenarioId": scenario_id,
        "qaCase": qa_case,
        "titleAr": "عنوان",
        "titleEn": f"Title {scenario_id}",
        "goalTextAr": f"هدف {scenario_id}",
        "goalTextEn": f"Goal sentence of {scenario_id}",
        "editionKeyPrefixes": ["quran-hafs-quranenc"],
        "sectionRefs": ["112"],
        "paths": ["quran"],
        "order": "book",
        "sessionMinutes": 10,
        "preferredDateOffsetDays": None,
        "placement": {"correct": 0, "incorrect": 0},
        "absenceDays": 0,
        "errorPassageRefs": [],
    }
    values.update(overrides)
    return values


def standard_entries() -> list[dict[str, Any]]:
    return [
        entry("t-one", 1),
        entry("t-little", 3, sectionRefs=["112", "113"], sessionMinutes=5),
        entry(
            "t-absent",
            4,
            sectionRefs=["112", "113", "114"],
            absenceDays=4,
            errorPassageRefs=["113"],
            placement={"correct": 3, "incorrect": 1},
        ),
        entry(
            "t-late-error",
            5,
            sectionRefs=["*"],
            absenceDays=4,
            errorPassageRefs=["100"],
            placement={"correct": 5, "incorrect": 1},
        ),
        entry(
            "t-hadith",
            9,
            editionKeyPrefixes=["nawawi40-hadeethenc"],
            sectionRefs=["nawawi40:1", "nawawi40:2", "nawawi40:3"],
            paths=["matn", "sanad"],
            sessionMinutes=5,
            errorPassageRefs=["nawawi40:2"],
            placement={"correct": 1, "incorrect": 3},
        ),
        entry(
            "t-large",
            10,
            editionKeyPrefixes=["nawawi40-hadeethenc"],
            sectionRefs=["*"],
            paths=["matn"],
            preferredDateOffsetDays=30,
        ),
    ]


def write_scenarios(directory: Path, entries: list[dict[str, Any]] | None = None) -> Path:
    path = directory / "scenarios.json"
    path.write_text(
        json.dumps({"fixtureVersion": 1, "scenarios": entries or standard_entries()}),
        encoding="utf-8",
    )
    return path


def pin(directory: Path, scenarios_path: Path) -> Path:
    """Pin the expectations the way an operator does (derived from the scenario file)."""
    scenarios, _ = ai.load_scenarios(scenarios_path)
    document = ai.derive_expectations(scenarios, catalog.edition_list())
    path = directory / "expectations.json"
    path.write_bytes(ai.render_expectations(document))
    return path


@dataclass
class World:
    scenarios_path: Path
    expectations_path: Path
    scenarios: list[ai.Scenario]
    expectations: dict[str, ai.Expectation]
    status: list[dict[str, Any]]
    prepared: dict[str, ai.Prepared]

    def argv(self, *extra: str) -> list[str]:
        return [
            "--scenarios-file",
            str(self.scenarios_path),
            "--expectations",
            str(self.expectations_path),
            *extra,
        ]


def build_world(directory: Path, entries: list[dict[str, Any]] | None = None) -> World:
    scenarios_path = write_scenarios(directory, entries)
    expectations_path = pin(directory, scenarios_path)
    scenarios, _ = ai.load_scenarios(scenarios_path)
    expectations, _ = ai.load_expectations(expectations_path)
    status, prepared = ai.plan_scenarios(scenarios, expectations, None, catalog.edition_list())
    return World(
        scenarios_path,
        expectations_path,
        scenarios,
        expectations,
        status,
        {p.scenario.scenario_id: p for p in prepared},
    )


# --- a fake model ---------------------------------------------------------------------------------

Responder = Callable[[str, dict[str, Any]], Any]


@dataclass
class FakeProvider:
    """A ``complete_json`` provider scripted by ``responder(kind, payload)``: a dict is the
    parsed reply, an exception is raised, anything else is returned as the whole reply."""

    responder: Responder
    model: str = "fake/free-model:free"
    input_tokens: int | None = 900
    output_tokens: int | None = 40
    cost_usd: float | None = 0.0
    calls: list[dict[str, Any]] = field(default_factory=list)

    def complete_json(
        self,
        payload: dict[str, Any],
        *,
        system_prompt: str,
        response_schema: dict[str, Any],
        schema_name: str = "structured_reply",
        max_tokens: int,
        timeout_sec: float,
    ) -> Any:
        kind = "goal" if "goalText" in payload else "planner"
        self.calls.append(
            {
                "kind": kind,
                "payload": payload,
                "system_prompt": system_prompt,
                "schema": response_schema,
                "schema_name": schema_name,
                "max_tokens": max_tokens,
                "timeout_sec": timeout_sec,
            }
        )
        result = self.responder(kind, payload)
        if isinstance(result, BaseException):
            raise result
        if isinstance(result, dict) or isinstance(result, list) or result is None:
            return SimpleNamespace(
                data=result,
                model=self.model,
                input_tokens=self.input_tokens,
                output_tokens=self.output_tokens,
                cost_usd=self.cost_usd,
            )
        return result


def oracle(world: World) -> Responder:
    """A model that answers every scenario the way the pinned expectations want."""
    by_goal = {p.scenario.goal_text_en: p for p in world.prepared.values()}

    def respond(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        if kind == "goal":
            prepared = by_goal[payload["goalText"]]
            return {
                "editionKey": prepared.edition.edition_key,
                "sectionOrdinals": list(prepared.ordinals),
            }
        prepared = world.prepared[payload["scenarioId"]]
        return {
            "newWordsPerDay": payload["maxNewWordsPerDay"],
            "reviewOffsetsDays": [1, 3, 7],
            "priorityReviewPassageIds": [str(i) for i in prepared.expected_error_ids],
        }

    return respond


class Factory:
    """A ``provider_factory`` that hands out one ``FakeProvider`` per model id."""

    def __init__(self, responder: Responder, **provider_values: Any) -> None:
        self.responder = responder
        self.provider_values = provider_values
        self.providers: dict[str, FakeProvider] = {}

    def __call__(self, model: str) -> FakeProvider:
        provider = FakeProvider(self.responder, **self.provider_values)
        self.providers[model] = provider
        return provider

    @property
    def calls(self) -> list[dict[str, Any]]:
        return [call for provider in self.providers.values() for call in provider.calls]


class Tick:
    """A clock that advances by ``step`` on every read, so each call measures exactly ``step``."""

    def __init__(self, step: float = 0.5) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {"OPENROUTER_API_KEY": FAKE_KEY, "OPENROUTER_MODELS": "free/a:free"}
    values.update(overrides)
    return make_settings(**values)


def unavailable(reason: str) -> ProviderUnavailable:
    return ProviderUnavailable(reason)  # type: ignore[arg-type]
