"""Startup wiring of the learning core: catalog (E14), plans (E15-E17, E30), sessions (E20) and the
plan conversation (E31-E34)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from app.config import Settings
from app.repositories.ai_usage import UsageLedger
from app.repositories.learning import InMemoryLearningStore
from app.repositories.plan_chats import PlanChatRepository
from app.routers.sessions import install_sessions
from app.services.plan_access import PlanServiceAccess, PlanServiceCalendar
from app.services.plan_chat import build_plan_chat_gateway
from app.services.plans import build_planning_services

if TYPE_CHECKING:
    import httpx

_UNSET: Any = object()


def install_learning_core(
    app: FastAPI,
    settings: Settings,
    *,
    clock: Callable[[], datetime] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> None:
    """Build the services of the configured backend and put them on ``app.state``.

    Memory mode shares one ``InMemoryLearningStore``: it is package B5's learning repository and
    package B4's placement reader. Supabase mode shares one ``PostgrestClient``; without
    ``SUPABASE_URL`` and ``SUPABASE_ANON_KEY`` every endpoint answers 503. ``clock`` and
    ``transport`` are test seams.
    """
    store = InMemoryLearningStore() if settings.QATRA_DATA_BACKEND == "memory" else None
    planning = build_planning_services(settings, clock=clock, transport=transport, placements=store)
    app.state.catalog_service = planning.catalog
    app.state.plan_service = planning.plans
    app.state.postgrest_client = planning.client
    plans = planning.plans
    install_sessions(
        app,
        settings,
        plans=None if plans is None else PlanServiceAccess(plans),
        calendar=None if plans is None else PlanServiceCalendar(plans),
        learning=store,
        client=planning.client,
        clock=clock,
    )
    install_plan_chat(app, settings, clock=clock)


def install_plan_chat(
    app: FastAPI,
    settings: Settings,
    *,
    provider: Any = _UNSET,
    ledger: UsageLedger | None = None,
    repository: PlanChatRepository | None = None,
    clock: Callable[[], datetime] | None = None,
) -> None:
    """Build the plan conversation (E31-E34) and store it on ``app.state.plan_chat_service``.

    It uses what ``install_learning_core`` left on ``app.state``: the plan service (its ports are
    bound per request), the learning and bank repositories (the learning record of a revision)
    and the PostgREST client. Without the plan service, which is the case in supabase mode
    without ``SUPABASE_URL`` and ``SUPABASE_ANON_KEY``, the endpoints answer ``503``.

    ``provider`` (default: OpenRouter when a key and candidate models are configured),
    ``ledger``, ``repository`` (memory mode) and ``clock`` are test seams. Calling it again
    replaces the service and keeps the routes, as ``install_auth`` does.
    """
    plans = getattr(app.state, "plan_service", None)
    if plans is None:
        app.state.plan_chat_service = None
        return
    chosen: dict[str, Any] = {} if provider is _UNSET else {"provider": provider}
    app.state.plan_chat_service = build_plan_chat_gateway(
        settings,
        plans=plans,
        learning=getattr(app.state, "learning_repository", None),
        bank=getattr(app.state, "bank_repository", None),
        client=getattr(app.state, "postgrest_client", None),
        ledger=ledger,
        repository=repository,
        clock=clock,
        **chosen,
    )
