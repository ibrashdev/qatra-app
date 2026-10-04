"""Startup wiring of the learning core: catalog (E14), plans (E15-E17, E30) and sessions (E20)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.config import Settings
from app.repositories.learning import InMemoryLearningStore
from app.routers.sessions import install_sessions
from app.services.plan_access import PlanServiceAccess, PlanServiceCalendar
from app.services.plans import build_planning_services

if TYPE_CHECKING:
    import httpx


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
