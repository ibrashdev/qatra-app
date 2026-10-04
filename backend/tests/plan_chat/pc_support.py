"""Fixtures and fakes for the plan-conversation tests (synthetic data only).

Test-only helpers: ``RulesEstimateStub`` applies the contract §5 arithmetic to fixture word
counts (B4 supplies the real rules engine later); ``FakePlanWriter`` and ``FakeLearning`` stand
in for B4's plan functions and the progress package; ``FakeProvider`` scripts model replies.
``login_as`` overrides ``require_session`` with a fake ``SessionContext``: this is a TEST-ONLY
shortcut, never a session cookie, and production code never does it.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import FastAPI

from app.config import Settings
from app.contracts_plan_chat import (
    CatalogCategory,
    CatalogEdition,
    CatalogSection,
    DailyTimeItem,
    ErrorPartItem,
    Estimate,
    EstimateResult,
    LearningSummary,
    PassageMasteryItem,
    Plan,
    PlannerInfo,
    RecentAttempt,
    ReviewOutcome,
    TargetScope,
)
from app.dependencies import SessionContext, require_session
from app.domain import plan_chat_policy as policy
from app.domain.planning_port import (
    PlacementNotFound,
    PlanningRuleError,
    RevisablePlan,
)
from app.main import create_app
from app.providers.llm import ModelOutput, ModelReply, ParametersPatch, ProviderUnavailable
from app.repositories.ai_usage import InMemoryUsageLedger
from app.repositories.plan_chats import InMemoryPlanChatRepository
from app.services.plan_chat import PlanChatService, build_plan_chat_service
from tests.support import make_settings

TODAY = date(2026, 10, 4)
QURAN_ID = UUID("11111111-1111-4111-8111-0000000000e1")
HADITH_ID = UUID("11111111-1111-4111-8111-0000000000e2")
PLACEMENT_ID = UUID("33333333-3333-4333-8333-000000000001")
USER_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")
OTHER_USER_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")
CAPACITY = {5: 12, 10: 25, 15: 40}


def make_quran() -> CatalogEdition:
    sections = [
        CatalogSection(
            section_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, f"s{n}")),
            ordinal=n,
            kind="surah",
            reference=f"سورة {n}",
            title_ar=f"سورة {n}",
            title_en=f"Surah {n}",
            word_count=40,
            passage_count=1,
            paths=["quran"],
        )
        for n in range(78, 115)
    ]
    return CatalogEdition(
        edition_id=str(QURAN_ID),
        edition_key="quran-test",
        title_ar="«جزء عم (اختبار)»",
        title_en="Juz Amma (test)",
        author="synthetic",
        edition_label="test",
        category=CatalogCategory(slug="quran", label_ar="قرآن", label_en="Quran"),
        catalog_version=1,
        content_format="quran",
        available_paths=["quran"],
        default_paths=["quran"],
        total_words=40 * len(sections),
        sections=sections,
    )


def make_hadith() -> CatalogEdition:
    sections = [
        CatalogSection(
            section_id=str(uuid.uuid5(uuid.NAMESPACE_DNS, f"h{n}")),
            ordinal=n,
            kind="hadith",
            reference=f"الحديث {n}",
            title_ar=f"الحديث {n}",
            title_en=f"Hadith {n}",
            word_count=30,
            passage_count=1,
            paths=["matn", "sanad", "grade"],
        )
        for n in range(1, 43)
    ]
    return CatalogEdition(
        edition_id=str(HADITH_ID),
        edition_key="hadith-test",
        title_ar="«الأربعون (اختبار)»",
        title_en="Forty (test)",
        author="synthetic",
        edition_label="test",
        category=CatalogCategory(slug="hadith", label_ar="حديث", label_en="Hadith"),
        catalog_version=1,
        content_format="hadith_collection",
        available_paths=["matn", "sanad", "grade"],
        default_paths=["matn"],
        total_words=30 * len(sections),
        sections=sections,
    )


class RulesEstimateStub:
    """Contract §5 arithmetic on fixture word counts. Test-only."""

    def __init__(self, today: date = TODAY, known: dict[UUID, int] | None = None) -> None:
        self.today = today
        self.editions = {QURAN_ID: make_quran(), HADITH_ID: make_hadith()}
        self.known = {PLACEMENT_ID: 20} if known is None else known
        self.estimate_calls = 0

    def learning_date(self, user_id: UUID) -> date:
        return self.today

    def catalog_edition(self, edition_id: UUID) -> CatalogEdition:
        edition = self.editions.get(edition_id)
        if edition is None:
            raise PlanningRuleError("edition_not_available", "editionId")
        return edition

    def _one(
        self,
        edition: CatalogEdition,
        ordinals: list[int],
        paths: list[str],
        minutes: int,
        known: int,
    ) -> Estimate:
        words = {s.ordinal: s.word_count for s in edition.sections}
        total = sum(words[o] for o in ordinals) * len(paths)
        capacity = CAPACITY[minutes]
        days = math.ceil(max(total - known, 0) / capacity * 1.15)
        return Estimate(
            days=days,
            end_date=self.today + timedelta(days=days),
            new_words_per_day=capacity,
            total_words=total,
            known_words=min(known, total),
            passage_count=math.ceil(total / 60),
            session_minutes=minutes,  # type: ignore[arg-type]
            scope=TargetScope(section_ordinals=sorted(ordinals)),
            paths=list(paths),  # type: ignore[arg-type]
        )

    def estimate(
        self,
        user_id: UUID,
        edition_id: UUID,
        target_scope: TargetScope,
        paths: list[str],
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        order: str = "book",
    ) -> EstimateResult:
        self.estimate_calls += 1
        edition = self.catalog_edition(edition_id)
        known = 0
        if placement_session_id is not None:
            if placement_session_id not in self.known:
                raise PlacementNotFound
            known = self.known[placement_session_id]
        ordinals = list(target_scope.section_ordinals)
        main = self._one(edition, ordinals, paths, session_minutes, known)
        alternatives = []
        larger = [m for m in (5, 10, 15) if m > session_minutes]
        if larger:
            alternatives.append(self._one(edition, ordinals, paths, larger[0], known))
        half = policy.halve_scope(ordinals, order)
        if len(half) < len(set(ordinals)):
            alternatives.append(self._one(edition, half, paths, session_minutes, known))
        return EstimateResult(
            estimate=main,
            alternatives=alternatives,
            reason_code=policy.derive_reason_code(main.end_date, preferred_date),
        )


class FakePlanWriter:
    """Stands in for B4's E16/E17 functions. Test-only."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.revised: list[dict[str, Any]] = []
        self.plans: dict[UUID, RevisablePlan] = {}
        self.fail_create: Exception | None = None
        self.fail_revise: Exception | None = None

    def add_plan(self, user_id: UUID, **overrides: Any) -> RevisablePlan:
        values: dict[str, Any] = {
            "plan_id": uuid.uuid4(),
            "edition_id": QURAN_ID,
            "target_scope": TargetScope(section_ordinals=[78, 79, 80, 81]),
            "paths": ["quran"],
            "order": "book",
            "session_minutes": 10,
            "preferred_date": None,
            "current_version": 3,
            "status": "active",
            "placement_session_id": PLACEMENT_ID,
        }
        values.update(overrides)
        plan = RevisablePlan(**values)
        self.plans[plan.plan_id] = plan
        self._owners = getattr(self, "_owners", {})
        self._owners[plan.plan_id] = user_id
        return plan

    def load_plan(self, user_id: UUID, plan_id: UUID) -> RevisablePlan | None:
        owners = getattr(self, "_owners", {})
        return self.plans.get(plan_id) if owners.get(plan_id) == user_id else None

    def _plan(self, **values: Any) -> Plan:
        return Plan(
            plan_id=values.get("plan_id", uuid.uuid4()),
            edition_id=values["edition_id"],
            title_ar="«عنوان اختبار»",
            title_en="Test title",
            target_scope=values["target_scope"],
            paths=values["paths"],
            order=values["order"],
            session_minutes=values["session_minutes"],
            preferred_date=values["preferred_date"],
            agreed_estimate=values["confirmed_estimate"],
            current_version=values.get("current_version", 1),
            status="active",
            created_at=datetime(2026, 10, 4, 9, 5, tzinfo=UTC),
            planner=PlannerInfo(source=values["planner_source"], model=values.get("planner_model")),
        )

    def create_plan(self, user_id: UUID, **kwargs: Any) -> Plan:
        if self.fail_create is not None:
            raise self.fail_create
        self.created.append({"user_id": user_id, **kwargs})
        return self._plan(**kwargs)

    def revise_plan(self, user_id: UUID, plan_id: UUID, **kwargs: Any) -> Plan:
        if self.fail_revise is not None:
            raise self.fail_revise
        self.revised.append({"user_id": user_id, "plan_id": plan_id, **kwargs})
        plan = self.plans[plan_id]
        return self._plan(
            plan_id=plan_id,
            edition_id=plan.edition_id,
            planner_source="rules",
            current_version=kwargs["expected_version"] + 1,
            **kwargs,
        )


class FakeLearning:
    """A synthetic learning record, deliberately longer than the 30/50 caps."""

    def __init__(self) -> None:
        self.calls: list[tuple[UUID, UUID, bool]] = []

    def summary_for(self, user_id: UUID, plan_id: UUID, *, is_demo: bool) -> LearningSummary:
        self.calls.append((user_id, plan_id, is_demo))
        base = date(2026, 8, 1)
        return LearningSummary(
            passages=[
                PassageMasteryItem(
                    reference="78:1-5",
                    state="reviewing",
                    review_outcomes=[ReviewOutcome(date=date(2026, 9, 30), passed=True)],
                )
            ],
            error_parts=[ErrorPartItem(reference="78:3", error_count=2)],
            daily_time=[
                DailyTimeItem(date=base + timedelta(days=i), active_minutes=10) for i in range(45)
            ],
            attempts=[
                RecentAttempt(
                    question_type="word_choice",
                    reference="78:2",
                    correct=bool(i % 2),
                    assisted=False,
                    error_kind=None if i % 2 else "wrong_word",
                    date=base + timedelta(days=i % 60),
                )
                for i in range(70)
            ],
        )


def model_reply(
    intent: str = "question",
    reply: str = "",
    *,
    model: str = "free/model:free",
    **parameters: Any,
) -> ModelReply:
    patch = ParametersPatch(**parameters) if parameters else None
    return ModelReply(
        output=ModelOutput(intent=intent, parameters=patch, reply=reply),  # type: ignore[arg-type]
        model=model,
        input_tokens=100,
        output_tokens=20,
    )


class FakeProvider:
    """Scripted provider: replies or exceptions are consumed in order; calls are recorded."""

    name = "fake"

    def __init__(self, *script: Any, enabled: bool = True) -> None:
        self.script = list(script)
        self.enabled = enabled
        self.calls: list[dict[str, Any]] = []

    def is_enabled(self) -> bool:
        return self.enabled

    def complete(self, payload: dict[str, Any], *, max_tokens: int, timeout_sec: float):
        self.calls.append(payload)
        item = self.script.pop(0) if self.script else model_reply("question", "ok")
        if isinstance(item, Exception):
            raise item
        return item


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


class Env:
    """A wired service with every fake reachable for assertions."""

    def __init__(self, service: PlanChatService, **parts: Any) -> None:
        self.service = service
        self.__dict__.update(parts)
        self.planning: RulesEstimateStub
        self.writer: FakePlanWriter
        self.learning: FakeLearning
        self.provider: FakeProvider | None
        self.ledger: InMemoryUsageLedger
        self.repo: InMemoryPlanChatRepository
        self.clock: Clock
        self.settings: Settings


def make_env(*script: Any, provider: bool = True, **settings_overrides: Any) -> Env:
    settings = make_settings(**settings_overrides)
    planning = RulesEstimateStub()
    writer = FakePlanWriter()
    learning = FakeLearning()
    ledger = InMemoryUsageLedger()
    repo = InMemoryPlanChatRepository()
    clock = Clock()
    fake = FakeProvider(*script) if provider else None
    service = build_plan_chat_service(
        settings,
        planning=planning,
        writer=writer,
        learning=learning,
        repository=repo,
        ledger=ledger,
        provider=fake,
        clock=clock,
    )
    return Env(
        service,
        planning=planning,
        writer=writer,
        learning=learning,
        provider=fake,
        ledger=ledger,
        repo=repo,
        clock=clock,
        settings=settings,
    )


def ctx(user_id: UUID = USER_ID, *, demo: bool = False) -> SessionContext:
    return SessionContext(user_id=user_id, is_demo=demo, auth_epoch=1)


def create_body(**overrides: Any) -> dict[str, Any]:
    """An E31 JSON body (camelCase). The default goalText is composed by the caller."""
    body: dict[str, Any] = {
        "editionId": str(QURAN_ID),
        "targetScope": {"sectionOrdinals": [78, 79, 80, 81]},
        "paths": ["quran"],
        "sessionMinutes": 10,
        "goalText": "x",
        "language": "en",
    }
    body.update(overrides)
    return body


def composed(body: dict[str, Any], edition: CatalogEdition | None = None) -> str:
    """The sentence the start form pre-fills for ``body`` (the frontend template)."""
    from app.contracts_plan_chat import PlanParameters
    from app.domain import plan_chat_templates as templates

    edition = edition or (make_quran() if body["editionId"] == str(QURAN_ID) else make_hadith())
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
    return templates.compose_goal_sentence(edition, params, body["language"])


def composed_body(**overrides: Any) -> dict[str, Any]:
    body = create_body(**overrides)
    body["goalText"] = composed(body)
    return body


def login_as(app: FastAPI, user_id: UUID = USER_ID, *, demo: bool = False) -> None:
    """TEST ONLY: replace ``require_session`` with a fake context (never a real cookie)."""
    app.dependency_overrides[require_session] = lambda: ctx(user_id, demo=demo)


def make_app(env: Env) -> FastAPI:
    app = create_app(env.settings)
    app.state.plan_chat_service = env.service
    return app


UNAVAILABLE: Callable[..., ProviderUnavailable] = ProviderUnavailable
