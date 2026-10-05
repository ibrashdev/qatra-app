"""The demo operations E26-E29 (API-spec §4.9; package B10).

Layering: router -> this service -> pure policy (``domain/demo_policy``) + the existing services.
E26 reuses ``AuthService.register_account(is_demo=True)`` unchanged and adds the per-address daily
limit. E27 and E28 resolve the scenarios of ``fixtures/demo_scenarios.json`` against the published
catalog at request time (a scenario whose edition or sections are not published is not offered
and is ``unknown_scenario`` for E28); E28 hands the plan to ``PlanService.create_demo_plan`` with
the restricted planner (``services/planner.py``). E29 answers ``fixtures/demo_simulations.json``
verbatim after validating it.

The fixtures sit in the repository-root ``fixtures`` directory (``QATRA_DEMO_FIXTURES_DIR``
overrides it). A missing or invalid file is logged by name (``demo_fixtures_invalid``) and the
operations that need it answer ``503 unavailable``: nothing is faked and the application still
starts. A valid file is read once; an invalid one is read again after a short delay, so a fixed
file is picked up without a restart.

Limits (in memory, per process, G-11 and G-12): E26 at most ``QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY``
accounts per client address in a rolling 24 hours, counting successful creations only; E28 at most
``QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY`` plans per demo account and UTC day, also counting only
plans that were created. The model's daily free budget is not an error: it falls back to rules.

Privacy: bodies, scenario text, passage ids, usernames, addresses and model traffic are never
logged here; events carry names and counts only.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import Settings
from app.contracts_demo import (
    CreateDemoAccountRequest,
    CreateDemoPlanRequest,
    DemoScenario,
    DemoScenariosResponse,
    DemoSimulationsResponse,
)
from app.contracts_plan_chat import Plan, TargetScope
from app.dependencies import SessionContext
from app.domain import demo_policy as policy
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.services.auth import AuthService, Registration
from app.services.catalog import CatalogService
from app.services.planner import PlannerGateway, plan_with_fallback
from app.services.plans import PlanService

logger = logging.getLogger("qatra.demo")

DEFAULT_FIXTURES_DIR = Path(__file__).resolve().parents[3] / "fixtures"
RETRY_INVALID_AFTER_SEC = 30.0


class FixtureStore:
    """Reads and validates the two fixture files lazily. Thread-safe."""

    def __init__(
        self,
        directory: Path | str | None = None,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._directory = Path(directory) if directory else DEFAULT_FIXTURES_DIR
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._loaded: dict[str, Any] = {}
        self._failed_at: dict[str, float] = {}

    def scenarios(self) -> policy.ScenarioFixture:
        loaded: policy.ScenarioFixture = self._load(
            "scenarios", policy.SCENARIOS_FILE, policy.parse_scenario_fixture
        )
        return loaded

    def simulations(self) -> tuple[policy.SimulationFixture, list[dict[str, Any]]]:
        loaded: tuple[policy.SimulationFixture, list[dict[str, Any]]] = self._load(
            "simulations", policy.SIMULATIONS_FILE, policy.parse_simulation_fixture
        )
        return loaded

    def _load(self, name: str, filename: str, parse: Callable[[bytes], Any]) -> Any:
        with self._lock:
            if name in self._loaded:
                return self._loaded[name]
            failed = self._failed_at.get(name)
            if failed is not None and self._monotonic() - failed < RETRY_INVALID_AFTER_SEC:
                raise AppError(ErrorCode.unavailable)
            try:
                result = parse(self._read(self._directory / filename))
            except policy.FixtureError as error:
                self._failed_at[name] = self._monotonic()
                log_event(
                    logger,
                    "demo_fixtures_invalid",
                    level=logging.ERROR,
                    fixture=name,
                    reason=error.reason,
                )
                raise AppError(ErrorCode.unavailable) from None
            self._failed_at.pop(name, None)
            self._loaded[name] = result
            return result

    @staticmethod
    def _read(path: Path) -> bytes:
        try:
            with path.open("rb") as handle:
                raw = handle.read(policy.MAX_FIXTURE_BYTES + 1)
        except FileNotFoundError:
            raise policy.FixtureError("missing") from None
        except OSError:
            raise policy.FixtureError("unreadable") from None
        if len(raw) > policy.MAX_FIXTURE_BYTES:
            raise policy.FixtureError("too_large")
        return raw


class DemoService:
    """Installed on ``app.state.demo_service`` by ``install_demo``.

    The plan and catalog services and the planner's provider are read from ``state`` when a
    request is served, because the application may replace them after wiring (supabase mode without
    configuration leaves them absent and every operation answers ``503``).
    """

    def __init__(
        self,
        settings: Settings,
        *,
        state: Any,
        fixtures: FixtureStore,
        planner: PlannerGateway,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._state = state
        self._fixtures = fixtures
        self._planner = planner
        self._clock = clock or (lambda: datetime.now(UTC))
        self._account_quota = policy.DailyQuota(
            settings.QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY, kind="rolling", clock=self._clock
        )
        self._plan_quota = policy.DailyQuota(
            settings.QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY, kind="utc_day", clock=self._clock
        )

    # ------------------------------------------------------------------ shared pieces

    def _plans(self) -> PlanService:
        service: PlanService | None = getattr(self._state, "plan_service", None)
        if service is None:
            raise AppError(ErrorCode.unavailable)
        return service

    def _catalog(self) -> CatalogService:
        service: CatalogService | None = getattr(self._state, "catalog_service", None)
        if service is None:
            raise AppError(ErrorCode.unavailable)
        return service

    @staticmethod
    def _unknown_scenario() -> AppError:
        return AppError(
            ErrorCode.validation_error,
            details={"fields": [{"field": "scenarioId", "rule": "unknown_scenario"}]},
        )

    # ------------------------------------------------------------------ E26

    def register_account(
        self, auth: AuthService, body: CreateDemoAccountRequest, client: str
    ) -> Registration:
        """E26: the registration of E03 with ``is_demo`` set by the server. The client address
        reserves one of its daily accounts first and gives it back when the registration fails."""
        decision = self._account_quota.reserve(client)
        if not decision.allowed:
            raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)
        try:
            result = auth.register_account(
                username=body.username,
                password=body.password,
                time_zone=body.time_zone,
                language=body.language,
                terms_accepted=body.terms_accepted,
                terms_version=body.terms_version,
                is_demo=True,
            )
        except BaseException:
            self._account_quota.release(client, decision.ticket)
            raise
        log_event(logger, "demo_account_created")
        return result

    # ------------------------------------------------------------------ E27

    def list_scenarios(self) -> DemoScenariosResponse:
        """E27: the fixture scenarios that resolve against the published catalog, in file order."""
        fixture = self._fixtures.scenarios()
        editions = self._catalog().list_editions()
        resolved = policy.resolve_all(fixture, editions)
        if len(resolved) < len(fixture.scenarios):
            log_event(
                logger,
                "demo_scenarios_unresolved",
                omitted=len(fixture.scenarios) - len(resolved),
            )
        return DemoScenariosResponse(
            scenarios=[
                DemoScenario(
                    scenario_id=item.scenario.scenario_id,
                    title_ar=item.scenario.title_ar,
                    title_en=item.scenario.title_en,
                    edition_key=item.edition_key,
                    target_scope=TargetScope(section_ordinals=list(item.section_ordinals)),
                )
                for item in resolved
            ]
        )

    # ------------------------------------------------------------------ E28

    def create_plan(self, ctx: SessionContext, body: CreateDemoPlanRequest) -> Plan:
        """E28: a demo plan from a trusted scenario (see ``PlanService.create_demo_plan``)."""
        fixture = self._fixtures.scenarios()
        plans = self._plans()
        scenario = fixture.get(body.scenario_id)
        resolved = (
            None
            if scenario is None
            else policy.resolve_scenario(scenario, self._catalog().list_editions())
        )
        if resolved is None:
            raise self._unknown_scenario()
        decision = self._plan_quota.reserve(str(ctx.user_id))
        if not decision.allowed:
            raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)
        chosen = resolved.scenario

        def planner(basis: policy.PlannerBasis) -> policy.PlannerOutcome:
            resources = self._planner.resources()
            return plan_with_fallback(
                basis,
                account=ctx.user_id,
                provider=resources.provider,
                ledger=resources.ledger,
                settings=self._settings,
                now=self._clock,
            )

        try:
            plan = plans.create_demo_plan(
                ctx,
                scenario_id=chosen.scenario_id,
                edition_id=resolved.edition_id,
                ordinals=resolved.section_ordinals,
                paths=resolved.paths,
                order=chosen.order,
                session_minutes=chosen.session_minutes,
                preferred_offset_days=chosen.preferred_date_offset_days,
                placement_session_id=body.placement_session_id,
                fallback_placement=(chosen.placement.correct, chosen.placement.incorrect),
                planner=planner,
            )
        except BaseException:
            self._plan_quota.release(str(ctx.user_id), decision.ticket)
            raise
        log_event(logger, "demo_plan_created", planner=plan.planner.source)
        return plan

    # ------------------------------------------------------------------ E29

    def list_simulations(self) -> DemoSimulationsResponse:
        """E29: the precomputed simulations, validated and returned as written."""
        _, simulations = self._fixtures.simulations()
        return DemoSimulationsResponse(simulations=simulations)
