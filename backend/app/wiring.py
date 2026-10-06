"""Startup wiring of the learning core: catalog (E14), plans (E15-E17, E30), sessions and progress
(E18-E22) and the plan conversation (E31-E34), and of the content manager web admin (D91)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi import FastAPI

from app.config import Settings
from app.dependencies import SessionContext
from app.repositories.ai_usage import UsageLedger
from app.repositories.content_admin import (
    ContentAdminRepository,
    MemoryContentAdminRepository,
    PostgrestContentAdminRepository,
)
from app.repositories.learning import InMemoryLearningStore
from app.repositories.plan_chats import PlanChatRepository
from app.routers.lessons import install_lessons
from app.routers.sessions import install_sessions
from app.services.content_admin import ContentAdminService
from app.services.plan_access import PlanServiceAccess, PlanServiceCalendar
from app.services.plan_chat import PlanChatApi, build_plan_chat_gateway
from app.services.plans import build_planning_services
from app.services.progress import PlanServiceDirectory

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
    ``SUPABASE_URL`` and ``SUPABASE_ANON_KEY`` every endpoint answers 503. The calendar names the
    account time zone for E21, and E18 names the open plan conversation through the service
    ``install_plan_chat`` leaves on ``app.state``. ``clock`` and ``transport`` are test seams.
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
        open_chat_lookup=_open_chat_lookup(app),
    )
    install_lessons(
        app,
        bank=getattr(app.state, "bank_repository", None),
        plans=None if plans is None else PlanServiceDirectory(plans),
    )
    install_plan_chat(app, settings, clock=clock)


def _open_chat_lookup(app: FastAPI) -> Callable[[SessionContext], UUID | None]:
    """The seam of ``Today.openPlanChatId`` (E18): the open conversation of the caller.

    ``install_plan_chat`` runs after ``install_sessions`` and may be called again to replace the
    service, so ``app.state.plan_chat_service`` is read when E18 is served, not when it is wired.
    Without a service (supabase mode without its configuration) there is no conversation to name.
    A failing read propagates like any other read of E18.
    """

    def lookup(ctx: SessionContext) -> UUID | None:
        service: PlanChatApi | None = getattr(app.state, "plan_chat_service", None)
        return None if service is None else service.open_chat_id(ctx)

    return lookup


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


def install_content_admin(
    app: FastAPI,
    settings: Settings,
    *,
    repository: ContentAdminRepository | None = None,
    clock: Callable[[], datetime] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> None:
    """Build the content manager admin (D91) and store it on ``app.state.content_admin_service``;
    include its routes (once).

    Memory mode uses an empty ``MemoryContentAdminRepository``. Supabase mode uses a PostgREST
    client of its own whose key is ``SUPABASE_SERVICE_ROLE_KEY`` (server side only); without
    ``SUPABASE_URL`` or that key the service is ``None`` and every admin route answers
    ``503 unavailable``. The AI status card reads the global counters of the plan conversation's
    usage ledger when it is reachable from ``app.state`` (looked up per request, so a later
    ``install_plan_chat`` is seen). ``repository``, ``clock`` and ``transport`` are test seams.
    """
    from app.routers import content_admin  # local import: keeps the router out of module import

    if not getattr(app.state, "content_admin_routes_included", False):
        app.include_router(content_admin.router)
        app.state.content_admin_routes_included = True

    if repository is None:
        if settings.QATRA_DATA_BACKEND == "memory":
            repository = MemoryContentAdminRepository(clock=clock)
        elif settings.is_missing("SUPABASE_URL") or settings.is_missing(
            "SUPABASE_SERVICE_ROLE_KEY"
        ):
            app.state.content_admin_service = None
            return
        else:
            repository = PostgrestContentAdminRepository.from_settings(
                settings, transport=transport
            )

    def usage_ledger() -> UsageLedger | None:
        gateway = getattr(app.state, "plan_chat_service", None)
        ledger: UsageLedger | None = getattr(gateway, "ledger", None)
        return ledger

    app.state.content_admin_service = ContentAdminService(
        settings, repository, clock=clock, usage_ledger=usage_ledger
    )
