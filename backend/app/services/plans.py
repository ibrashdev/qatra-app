"""Plan services of package B4: estimate (E15), create (E16), revise (E17), resume (E30), and the
adapters that give the plan conversation (B13) its ports.

Layering: router -> this service -> pure policy (``domain/plan_policy``) + repositories. The same
core functions serve the REST endpoints and the ports of ``domain/planning_port`` (so E34 and E16
cannot drift apart): the core raises domain exceptions, the REST methods turn them into the error
envelope (``AppError``), the ports hand them on as the exception types the conversation expects.

Server authority only: the user id, the demo flag and the learner's access token come from the
resolved ``SessionContext``; nothing is read from the request body (S-1). No endpoint here calls a
model: the plan is computed by the rules engine and ``planner.source`` is ``rules`` unless the
plan conversation reports that a model turn supplied the parameters (B13, ``create_plan`` port).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from app.config import Settings, StartupConfigError
from app.contracts_plan_chat import (
    CatalogEdition,
    Estimate,
    EstimateResult,
    Plan,
    PlannerInfo,
    TargetScope,
)
from app.contracts_plans import CreatePlanRequest, EstimateRequest, RevisePlanRequest
from app.dependencies import SessionContext
from app.domain.plan_chat_policy import FieldError
from app.domain.plan_policy import (
    REASON_CREATED,
    REASON_REVISED,
    EditionData,
    EstimateMismatch,
    KnownPassages,
    PassageRow,
    PlanCommit,
    PlanInputError,
    PlanValues,
    build_plan_commit,
    canonical_paths,
    edition_dto,
    estimate_with_alternatives,
    estimates_equal,
    known_from_policy,
    learning_date,
    planner_from_policy,
    validate_plan_input,
)
from app.domain.planning_port import (
    ActivePlanConflict,
    EstimateChanged,
    PlacementNotFound,
    PlanningRuleError,
    PlanNotActive,
    PlanNotFound,
    PlanVersionConflict,
    RevisablePlan,
)
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.postgrest import PostgrestClient
from app.repositories.catalog import (
    BundleLoadError,
    CatalogRepository,
    MemoryCatalogRepository,
    MemoryContent,
    MemoryPassageReader,
    PassageReader,
    PostgrestCatalogRepository,
    PostgrestPassageReader,
)
from app.repositories.plans import (
    MemoryPlacementReader,
    MemoryPlanRepository,
    MemoryProfileReader,
    PlacementReader,
    PlanInForce,
    PlanRepository,
    PostgrestPlacementReader,
    PostgrestPlanRepository,
    PostgrestProfileReader,
    ProfileReader,
    StoredPlan,
)
from app.services.catalog import CatalogService

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger("qatra.plans")


# --- DTO builders --------------------------------------------------------------------------------


def plan_dto(stored: StoredPlan) -> Plan:
    """The ``Plan`` of a stored plan: the values of the latest version (API-spec §4.5).

    ``pendingSessionMinutes`` stays empty here: E17 reports the latest version's values and E18
    (a later package) says what is in force today (API-spec [O-13]).
    """
    source, model = planner_from_policy(stored.policy)
    return Plan(
        plan_id=stored.plan_id,
        edition_id=stored.edition_id,
        title_ar=stored.title_ar,
        title_en=stored.title_en,
        target_scope=TargetScope(section_ordinals=list(stored.target_scope)),
        paths=list(stored.paths),  # type: ignore[arg-type]
        order=stored.order,  # type: ignore[arg-type]
        session_minutes=stored.session_minutes,  # type: ignore[arg-type]
        preferred_date=stored.preferred_date,
        agreed_estimate=stored.agreed_estimate,
        current_version=stored.current_version,
        status=stored.status,  # type: ignore[arg-type]
        created_at=stored.created_at.astimezone(UTC).replace(microsecond=0),
        planner=PlannerInfo(source=source, model=model),  # type: ignore[arg-type]
    )


def revisable_plan(stored: StoredPlan) -> RevisablePlan:
    """What the plan conversation needs to know about a plan it revises."""
    return RevisablePlan(
        plan_id=stored.plan_id,
        edition_id=stored.edition_id,
        target_scope=TargetScope(section_ordinals=list(stored.target_scope)),
        paths=list(stored.paths),  # type: ignore[arg-type]
        order=stored.order,  # type: ignore[arg-type]
        session_minutes=stored.session_minutes,  # type: ignore[arg-type]
        preferred_date=stored.preferred_date,
        current_version=stored.current_version,
        status=stored.status,  # type: ignore[arg-type]
        placement_session_id=known_from_policy(stored.policy).placement_session_id,
    )


def _fields(errors: Sequence[FieldError]) -> AppError:
    return AppError(
        ErrorCode.validation_error,
        details={"fields": [{"field": e.field, "rule": e.rule} for e in errors]},
    )


@contextmanager
def _http_errors() -> Iterator[None]:
    """Domain conditions of the plan core -> the unified error envelope (API-spec §1.5)."""
    try:
        yield
    except PlanInputError as exc:
        raise _fields(exc.errors) from None
    except EstimateMismatch as exc:
        raise AppError(
            ErrorCode.version_conflict,
            details={
                "reason": "estimate_changed",
                "estimate": exc.fresh.model_dump(by_alias=True, mode="json"),
            },
        ) from None
    except (PlacementNotFound, PlanNotFound):
        raise AppError(ErrorCode.not_found) from None
    except PlanNotActive:
        raise AppError(ErrorCode.version_conflict, details={"reason": "plan_not_active"}) from None
    except PlanVersionConflict as exc:
        raise AppError(
            ErrorCode.version_conflict,
            details={"reason": "plan_version", "currentVersion": exc.current_version},
        ) from None
    except ActivePlanConflict:
        raise AppError(
            ErrorCode.version_conflict, details={"reason": "active_plan_conflict"}
        ) from None


class _Unchanged:
    """Marks a value the caller did not send (``None`` is a real value for ``preferredDate``)."""


_UNCHANGED = _Unchanged()


@dataclass(frozen=True, slots=True)
class _Resolved:
    """The validated inputs of one estimate: the edition, today, the known passages and the
    estimate with its alternatives."""

    edition: EditionData
    today: date
    scope: tuple[int, ...]
    paths: tuple[str, ...]
    placement_session_id: UUID | None
    known_ids: frozenset[UUID]
    passages: tuple[PassageRow, ...]
    result: EstimateResult


class PlanService:
    def __init__(
        self,
        *,
        catalog: CatalogService,
        plans: PlanRepository,
        placements: PlacementReader,
        profiles: ProfileReader,
        passages: PassageReader,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._catalog = catalog
        self._plans = plans
        self._placements = placements
        self._profiles = profiles
        self._passages = passages
        self._clock = clock or (lambda: datetime.now(UTC))

    # ------------------------------------------------------------------ shared pieces

    def learning_date(self, ctx: SessionContext) -> date:
        """Today's learning date in the account time zone (API-spec §1.10)."""
        zone = self._profiles.learning_zone(ctx)
        try:
            return learning_date(
                self._clock(), zone.time_zone, zone.pending_time_zone, zone.pending_effective
            )
        except ValueError:
            log_event(logger, "time_zone_unknown", level=logging.ERROR)
            raise AppError(ErrorCode.internal) from None

    def edition(self, edition_id: UUID) -> EditionData | None:
        """A published, non-revoked, non-hidden edition that a plan may be made for."""
        return self._catalog.get_edition(edition_id)

    def read_plan(self, ctx: SessionContext, plan_id: UUID) -> StoredPlan | None:
        """The caller's own plan, or ``None`` (unknown and foreign plans look the same)."""
        return self._plans.read_plan(ctx, plan_id)

    def list_plans(self, ctx: SessionContext) -> list[StoredPlan]:
        """Every plan of the caller, newest first (E18 and E19)."""
        return self._plans.list_plans(ctx)

    def plan_in_force(self, ctx: SessionContext, plan_id: UUID) -> PlanInForce | None:
        """The caller's plan with the values in force on today's learning date (D57), for E20."""
        return self._plans.read_in_force(ctx, plan_id, self.learning_date(ctx))

    def ports_for(self, ctx: SessionContext) -> PlanPorts:
        """``PlanningRules`` and ``PlanWriter`` of the plan conversation, bound to this request's
        context (cheap: no I/O until a method is called)."""
        return PlanPorts(self, ctx)

    @staticmethod
    def _require_learner(ctx: SessionContext) -> None:
        """E16 and E30 are for learner accounts; a demo plan comes from E28 or E34."""
        if ctx.is_demo:
            raise AppError(ErrorCode.forbidden)

    def _resolve(
        self,
        ctx: SessionContext,
        *,
        edition_id: UUID,
        ordinals: Sequence[int],
        paths: Sequence[str],
        session_minutes: int,
        preferred_date: date | None,
        order: str,
        placement_session_id: UUID | None,
        check_date: bool = True,
        with_passages: bool = False,
    ) -> _Resolved:
        """Validate the shared rules and compute the estimate (the E15 function)."""
        today = self.learning_date(ctx)
        edition = self._catalog.get_edition(edition_id)
        if edition is None:
            raise PlanInputError([FieldError("editionId", "edition_not_available")])
        errors = validate_plan_input(
            edition,
            ordinals=ordinals,
            paths=paths,
            session_minutes=session_minutes,
            # An unchanged stored date may have passed since the plan was made: only a date the
            # caller sets must not lie in the past.
            preferred_date=preferred_date if check_date else None,
            order=order,
            today=today,
        )
        if errors:
            raise PlanInputError(errors)
        scope = tuple(sorted(set(ordinals)))
        selected = canonical_paths(paths)
        known_ids: frozenset[UUID] = frozenset()
        if placement_session_id is not None:
            known_ids = self._placements.known_passage_ids(ctx, placement_session_id, edition_id)
        passages: tuple[PassageRow, ...] = ()
        if placement_session_id is not None or with_passages:
            passages = tuple(self._passages.passages(ctx, edition))
        known = tuple(row for row in passages if row.passage_id in known_ids)
        result = estimate_with_alternatives(
            edition,
            ordinals=scope,
            paths=selected,
            session_minutes=session_minutes,
            order=order,
            preferred_date=preferred_date,
            today=today,
            known=known,
        )
        return _Resolved(
            edition, today, scope, selected, placement_session_id, known_ids, passages, result
        )

    def _commit(
        self,
        resolved: _Resolved,
        *,
        agreed: Estimate,
        session_minutes: int,
        preferred_date: date | None,
        order: str,
        reason_code: str,
        planner_source: str,
        planner_model: str | None,
        effective_date: date,
    ) -> PlanCommit:
        values = PlanValues(
            edition_id=resolved.edition.edition_id,
            scope=resolved.scope,
            paths=resolved.paths,
            order=order,
            session_minutes=session_minutes,
            preferred_date=preferred_date,
            agreed_estimate=agreed,
        )
        commit = build_plan_commit(
            values,
            reason_code=reason_code,
            edition=resolved.edition,
            passages=resolved.passages,
            known=KnownPassages(
                resolved.placement_session_id,
                tuple(sorted(resolved.known_ids, key=str)),
            ),
            planner_source=planner_source,
            planner_model=planner_model,
            today=resolved.today,
            days=resolved.result.estimate.days,
            effective_date=effective_date,
        )
        if sum(phase.goal_size for phase in commit.phases) != resolved.result.estimate.total_words:
            # The catalog counts and the passages that could be read disagree (a bank that
            # changed, or a passage the learner may not read): refuse to save a plan whose phases
            # would not cover the whole scope (no unit may be dropped).
            log_event(logger, "plan_phases_do_not_cover_the_scope", level=logging.ERROR)
            raise AppError(ErrorCode.internal)
        return commit

    def _read_back(self, ctx: SessionContext, plan_id: UUID) -> Plan:
        stored = self._plans.read_plan(ctx, plan_id)
        if stored is None:
            log_event(logger, "plan_missing_after_write", level=logging.ERROR)
            raise AppError(ErrorCode.internal)
        return plan_dto(stored)

    # ------------------------------------------------------------------ core operations
    # Shared by the REST methods below and by ``PlanPorts``: they raise domain exceptions
    # (``PlanInputError``, ``EstimateMismatch`` and the exception types of ``planning_port``).

    def run_estimate(
        self,
        ctx: SessionContext,
        *,
        edition_id: UUID,
        ordinals: Sequence[int],
        paths: Sequence[str],
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        order: str,
    ) -> EstimateResult:
        return self._resolve(
            ctx,
            edition_id=edition_id,
            ordinals=ordinals,
            paths=paths,
            session_minutes=session_minutes,
            preferred_date=preferred_date,
            order=order,
            placement_session_id=placement_session_id,
        ).result

    def prepare_creation(
        self,
        ctx: SessionContext,
        *,
        edition_id: UUID,
        ordinals: Sequence[int],
        paths: Sequence[str],
        order: str,
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        confirmed: Estimate,
        planner_source: str,
        planner_model: str | None,
    ) -> PlanCommit:
        """E16 up to the write: validate, recompute from the request's own inputs, require
        ``confirmedEstimate`` to equal the result, and build the commit (plan values, version 1,
        phases). ``PlanCommit.plan_args()`` is what ``app_plan_chat_confirm`` takes, so the plan
        conversation can run the same commit inside its own database transaction."""
        resolved = self._resolve(
            ctx,
            edition_id=edition_id,
            ordinals=ordinals,
            paths=paths,
            session_minutes=session_minutes,
            preferred_date=preferred_date,
            order=order,
            placement_session_id=placement_session_id,
            with_passages=True,
        )
        fresh = resolved.result.estimate
        if not estimates_equal(confirmed, fresh):
            raise EstimateMismatch(fresh)
        return self._commit(
            resolved,
            agreed=fresh,
            session_minutes=session_minutes,
            preferred_date=preferred_date,
            order=order,
            reason_code=REASON_CREATED,
            planner_source=planner_source,
            planner_model=planner_model,
            effective_date=resolved.today,
        )

    def run_create(
        self,
        ctx: SessionContext,
        *,
        edition_id: UUID,
        ordinals: Sequence[int],
        paths: Sequence[str],
        order: str,
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        confirmed: Estimate,
        planner_source: str,
        planner_model: str | None,
    ) -> Plan:
        """E16: save plan, version 1 and phases in one database function; the previous active
        plan is paused in the same transaction."""
        commit = self.prepare_creation(
            ctx,
            edition_id=edition_id,
            ordinals=ordinals,
            paths=paths,
            order=order,
            session_minutes=session_minutes,
            preferred_date=preferred_date,
            placement_session_id=placement_session_id,
            confirmed=confirmed,
            planner_source=planner_source,
            planner_model=planner_model,
        )
        return self._read_back(ctx, self._plans.create_plan(ctx, commit))

    def prepare_revision(
        self,
        ctx: SessionContext,
        plan_id: UUID,
        *,
        expected_version: int,
        scope: Sequence[int] | None = None,
        paths: Sequence[str] | None = None,
        order: str | None = None,
        session_minutes: int | None = None,
        preferred_date: date | None | _Unchanged = _UNCHANGED,
        confirmed: Estimate | None = None,
    ) -> PlanCommit:
        """E17 up to the write: a new immutable version with limited changes. The edition and the
        scope are the plan's own (``scope``, when given, must equal it); an omitted value stays as
        it is; the changes apply from the next learning day (D57)."""
        stored = self._plans.read_plan(ctx, plan_id)
        if stored is None:
            raise PlanNotFound
        if stored.status == "completed":
            raise PlanNotActive
        if stored.current_version != expected_version:
            raise PlanVersionConflict(stored.current_version)
        if scope is not None and tuple(sorted(set(scope))) != stored.target_scope:
            raise PlanInputError([FieldError("targetScope", "scope_invalid")])
        new_paths = stored.paths if paths is None else paths
        new_order = stored.order if order is None else order
        new_minutes = stored.session_minutes if session_minutes is None else session_minutes
        new_date = (
            stored.preferred_date if isinstance(preferred_date, _Unchanged) else preferred_date
        )
        known = known_from_policy(stored.policy)
        resolved = self._resolve(
            ctx,
            edition_id=stored.edition_id,
            ordinals=stored.target_scope,
            paths=new_paths,
            session_minutes=new_minutes,
            preferred_date=new_date,
            order=new_order,
            placement_session_id=known.placement_session_id,
            check_date=new_date != stored.preferred_date,
            with_passages=True,
        )
        fresh = resolved.result.estimate
        if confirmed is not None and not estimates_equal(confirmed, fresh):
            raise EstimateMismatch(fresh)
        return self._commit(
            resolved,
            # A revision that carries no confirmed estimate keeps the stored one (API-spec E17).
            agreed=fresh if confirmed is not None else stored.agreed_estimate,
            session_minutes=new_minutes,
            preferred_date=new_date,
            order=new_order,
            reason_code=REASON_REVISED,
            planner_source="rules",
            planner_model=None,
            effective_date=resolved.today + timedelta(days=1),
        )

    def run_revise(
        self,
        ctx: SessionContext,
        plan_id: UUID,
        *,
        expected_version: int,
        scope: Sequence[int] | None = None,
        paths: Sequence[str] | None = None,
        order: str | None = None,
        session_minutes: int | None = None,
        preferred_date: date | None | _Unchanged = _UNCHANGED,
        confirmed: Estimate | None = None,
    ) -> Plan:
        """E17: append the version (optimistic on ``expected_version``) and answer with the plan."""
        commit = self.prepare_revision(
            ctx,
            plan_id,
            expected_version=expected_version,
            scope=scope,
            paths=paths,
            order=order,
            session_minutes=session_minutes,
            preferred_date=preferred_date,
            confirmed=confirmed,
        )
        self._plans.revise_plan(ctx, plan_id, expected_version, commit)
        return self._read_back(ctx, plan_id)

    # ------------------------------------------------------------------ REST operations

    def estimate(self, ctx: SessionContext, body: EstimateRequest) -> EstimateResult:
        """E15: read-only; demo accounts may call it."""
        with _http_errors():
            return self.run_estimate(
                ctx,
                edition_id=body.edition_id,
                ordinals=body.target_scope.section_ordinals,
                paths=body.paths,
                session_minutes=body.session_minutes,
                preferred_date=body.preferred_date,
                placement_session_id=body.placement_session_id,
                order=body.order,
            )

    def create_plan(self, ctx: SessionContext, body: CreatePlanRequest) -> Plan:
        """E16: learner accounts only (``planner.source`` is ``rules``)."""
        self._require_learner(ctx)
        with _http_errors():
            return self.run_create(
                ctx,
                edition_id=body.edition_id,
                ordinals=body.target_scope.section_ordinals,
                paths=body.paths,
                order=body.order,
                session_minutes=body.session_minutes,
                preferred_date=body.preferred_date,
                placement_session_id=body.placement_session_id,
                confirmed=body.confirmed_estimate.to_estimate(),
                planner_source="rules",
                planner_model=None,
            )

    def revise_plan(self, ctx: SessionContext, plan_id: UUID, body: RevisePlanRequest) -> Plan:
        """E17: demo accounts may revise (D71)."""
        if not body.has_changes:
            raise _fields([FieldError("body", "no_fields")])
        with _http_errors():
            return self.run_revise(
                ctx,
                plan_id,
                expected_version=body.expected_version,
                paths=body.paths,
                order=body.order,
                session_minutes=body.session_minutes,
                preferred_date=(
                    body.preferred_date if "preferred_date" in body.model_fields_set else _UNCHANGED
                ),
                confirmed=(
                    body.confirmed_estimate.to_estimate()
                    if body.confirmed_estimate is not None
                    else None
                ),
            )

    def resume_plan(self, ctx: SessionContext, plan_id: UUID) -> Plan:
        """E30: a paused plan becomes active and the current active plan is paused; learner
        accounts only. An already active plan is returned unchanged."""
        self._require_learner(ctx)
        with _http_errors():
            self._plans.resume_plan(ctx, plan_id)
            return self._read_back(ctx, plan_id)


class PlanPorts:
    """``PlanningRules`` and ``PlanWriter`` (``app.domain.planning_port``) for one request.

    The plan conversation passes ``user_id`` to every method; it must be the context's user (a
    mismatch is a programming error and answers ``internal``). The ports raise the exception types
    of ``planning_port`` only: a rule violation is ``PlanningRuleError`` (the first failing field),
    a ``confirmedEstimate`` mismatch is ``EstimateChanged``. Plan creation works for demo accounts
    too (E34 semantics): the schema stores no processing mode, so a demo account's plan is an
    ordinary plan of its own account.
    """

    def __init__(self, service: PlanService, ctx: SessionContext) -> None:
        self._service = service
        self._ctx = ctx

    def _own(self, user_id: UUID) -> None:
        if user_id != self._ctx.user_id:
            raise AppError(ErrorCode.internal)

    # -- PlanningRules -------------------------------------------------------------------------

    def learning_date(self, user_id: UUID) -> date:
        self._own(user_id)
        return self._service.learning_date(self._ctx)

    def catalog_edition(self, edition_id: UUID) -> CatalogEdition:
        edition = self._service.edition(edition_id)
        if edition is None:
            raise PlanningRuleError("edition_not_available", "editionId")
        return edition_dto(edition)

    def estimate(
        self,
        user_id: UUID,
        edition_id: UUID,
        target_scope: TargetScope,
        paths: list[str],
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        order: Literal["book", "reverse"] = "book",
    ) -> EstimateResult:
        self._own(user_id)
        try:
            return self._service.run_estimate(
                self._ctx,
                edition_id=edition_id,
                ordinals=target_scope.section_ordinals,
                paths=paths,
                session_minutes=session_minutes,
                preferred_date=preferred_date,
                placement_session_id=placement_session_id,
                order=order,
            )
        except PlanInputError as exc:
            raise _first_rule(exc) from None

    # -- PlanWriter ----------------------------------------------------------------------------

    def load_plan(self, user_id: UUID, plan_id: UUID) -> RevisablePlan | None:
        self._own(user_id)
        stored = self._service.read_plan(self._ctx, plan_id)
        return revisable_plan(stored) if stored is not None else None

    def create_plan(
        self,
        user_id: UUID,
        *,
        is_demo: bool,
        edition_id: UUID,
        target_scope: TargetScope,
        paths: list[str],
        order: Literal["book", "reverse"],
        session_minutes: int,
        preferred_date: date | None,
        placement_session_id: UUID | None,
        confirmed_estimate: Estimate,
        planner_source: Literal["rules", "teaching_agent"],
        planner_model: str | None,
    ) -> Plan:
        self._own(user_id)
        if is_demo != self._ctx.is_demo:
            raise AppError(ErrorCode.internal)
        try:
            return self._service.run_create(
                self._ctx,
                edition_id=edition_id,
                ordinals=target_scope.section_ordinals,
                paths=paths,
                order=order,
                session_minutes=session_minutes,
                preferred_date=preferred_date,
                placement_session_id=placement_session_id,
                confirmed=confirmed_estimate,
                planner_source=planner_source,
                planner_model=planner_model,
            )
        except PlanInputError as exc:
            raise _first_rule(exc) from None
        except EstimateMismatch:
            raise EstimateChanged from None

    def revise_plan(
        self,
        user_id: UUID,
        plan_id: UUID,
        *,
        expected_version: int,
        target_scope: TargetScope,
        paths: list[str],
        order: Literal["book", "reverse"],
        session_minutes: int,
        preferred_date: date | None,
        confirmed_estimate: Estimate,
    ) -> Plan:
        self._own(user_id)
        try:
            return self._service.run_revise(
                self._ctx,
                plan_id,
                expected_version=expected_version,
                scope=target_scope.section_ordinals,
                paths=paths,
                order=order,
                session_minutes=session_minutes,
                preferred_date=preferred_date,
                confirmed=confirmed_estimate,
            )
        except PlanInputError as exc:
            raise _first_rule(exc) from None
        except EstimateMismatch:
            raise EstimateChanged from None


def _first_rule(exc: PlanInputError) -> PlanningRuleError:
    first = exc.errors[0]
    return PlanningRuleError(first.rule, first.field)


# --- startup wiring ------------------------------------------------------------------------------


@dataclass(frozen=True)
class PlanningServices:
    """The services built at startup. The memory-mode parts are exposed so that tests (and the
    session package later) can seed placement sessions and profiles; they are ``None`` in
    supabase mode, and ``placements`` is also ``None`` when a reader was injected. ``catalog`` and
    ``plans`` are ``None`` when supabase mode is selected without ``SUPABASE_URL`` and
    ``SUPABASE_ANON_KEY`` (the endpoints then answer ``503 unavailable``). ``client`` is the
    PostgREST client of supabase mode, shared with package B5."""

    catalog: CatalogService | None
    plans: PlanService | None
    content: MemoryContent | None = None
    placements: MemoryPlacementReader | None = None
    profiles: MemoryProfileReader | None = None
    repository: MemoryPlanRepository | None = None
    client: PostgrestClient | None = None


def _bank_version_of(content: MemoryContent) -> Callable[[UUID], int | None]:
    def bank_version(edition_id: UUID) -> int | None:
        edition = content.edition(edition_id)
        return None if edition is None else edition.catalog_version

    return bank_version


def build_planning_services(
    settings: Settings,
    *,
    clock: Callable[[], datetime] | None = None,
    transport: httpx.BaseTransport | None = None,
    placements: PlacementReader | None = None,
) -> PlanningServices:
    """Memory or supabase wiring, chosen by ``QATRA_DATA_BACKEND``.

    ``placements`` replaces the seedable placement reader in memory mode. Errors name the
    variable only, never a value (``StartupConfigError``).
    """
    if settings.QATRA_DATA_BACKEND == "memory":
        try:
            content = MemoryContent.from_paths(settings.QATRA_CONTENT_BUNDLES)
        except BundleLoadError:
            raise StartupConfigError(
                ["invalid values for variables: QATRA_CONTENT_BUNDLES"]
            ) from None
        repository = MemoryPlanRepository(
            titles=content.titles, bank_version=_bank_version_of(content), clock=clock
        )
        reader: PlacementReader
        seedable: MemoryPlacementReader | None = None
        if placements is None:
            seedable = reader = MemoryPlacementReader()
        else:
            reader = placements
        profiles = MemoryProfileReader()
        catalog = CatalogService(MemoryCatalogRepository(content))
        plans = PlanService(
            catalog=catalog,
            plans=repository,
            placements=reader,
            profiles=profiles,
            passages=MemoryPassageReader(content),
            clock=clock,
        )
        return PlanningServices(catalog, plans, content, seedable, profiles, repository)

    if settings.is_missing("SUPABASE_URL") or settings.is_missing("SUPABASE_ANON_KEY"):
        return PlanningServices(None, None)
    try:
        client = PostgrestClient(
            str(settings.SUPABASE_URL), settings.SUPABASE_ANON_KEY or "", transport=transport
        )
    except ValueError:
        raise StartupConfigError(
            ["invalid values for variables: SUPABASE_URL, SUPABASE_ANON_KEY"]
        ) from None
    catalog_repository: CatalogRepository = PostgrestCatalogRepository(client)
    catalog = CatalogService(catalog_repository)
    plans = PlanService(
        catalog=catalog,
        plans=PostgrestPlanRepository(client),
        placements=PostgrestPlacementReader(client),
        profiles=PostgrestProfileReader(client),
        passages=PostgrestPassageReader(client),
        clock=clock,
    )
    return PlanningServices(catalog, plans, client=client)
