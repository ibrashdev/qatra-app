"""Plan storage and the learner reads the plan endpoints need (E15, E16, E17, E30).

Every method takes the resolved server context (``SessionContext``: user id from the session,
never from the client) and typed ids. Two implementations behind each protocol:

- **Memory mode**: thread-safe stores with the semantics of the database functions: one active
  plan per account, a new plan pauses the previous active one, versions increment, a paused plan
  can be revised and stays paused, resume pauses the current plan and returns an already active
  plan unchanged. Nothing outlives the process.
- **Supabase mode**: PostgREST with the learner's access token, so row-level security applies.
  Plan writes go only through the atomic functions ``app_create_plan``, ``app_revise_plan`` and
  ``app_resume_plan`` (migrations 0005 and 0006); reads are plain selects of the learner's own
  rows. ``service_role`` and the ``qatra_server`` connection are never used for learner data.

Database signals are mapped to the exception types of ``app.domain.planning_port``: ``QT002``
(stale version) -> ``PlanVersionConflict`` with the current version read afterwards, ``QT003``
(completed plan; ``app_resume_plan`` and ``app_revise_plan``) -> ``PlanNotActive``, ``P0002``
(unknown or foreign row) -> ``PlanNotFound``, ``23505`` on ``master_plans_user_id_active_key`` (a
race on the one-active-plan rule) -> ``ActivePlanConflict``. The service reads the plan status
before a revision and ``app_revise_plan`` tests it again under its row lock, so a plan that
completes in between is still refused.

``read_in_force`` serves E20 (package B5). A revision applies from the next learning day (D57), so
the session values come from the newest ``plan_versions`` row whose ``effective_learning_date`` has
arrived (its ``policy_json`` snapshot, Database-schema OPEN-09), while ``app_open_session`` needs
the row id of the CURRENT version; both are returned.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Protocol
from uuid import UUID

from pydantic import SecretStr

from app.contracts_plan_chat import PATH_ORDER, SESSION_MINUTES_OPTIONS, Estimate
from app.dependencies import SessionContext
from app.domain.plan_policy import PlanCommit, canonical_paths, known_from_policy
from app.domain.planning_port import (
    ActivePlanConflict,
    PlacementNotFound,
    PlanNotActive,
    PlanNotFound,
    PlanVersionConflict,
)
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.postgrest import DbSignal, PostgrestClient, require_token

logger = logging.getLogger("qatra.plans")

ACTIVE_PLAN_CONSTRAINT = "master_plans_user_id_active_key"
DEFAULT_TIME_ZONE = "Asia/Dubai"  # memory mode only: the project's zone (D55), synthetic profile
PLAN_COLUMNS = (
    "id,edition_id,target_scope,paths,plan_order,session_minutes,preferred_date,agreed_estimate,"
    "current_version,status,created_at,book_editions(books(title_ar,title_en))"
)
IN_FORCE_PLAN_COLUMNS = "id,edition_id,status,current_version,book_editions(bank_version)"
IN_FORCE_VERSION_COLUMNS = "id,version_no,policy_json"


@dataclass(frozen=True, slots=True)
class StoredPlan:
    """A plan of the caller: the ``master_plans`` row (the latest version's values), the titles of
    its book and the ``policy_json`` of the current version."""

    plan_id: UUID
    edition_id: UUID
    title_ar: str
    title_en: str
    target_scope: tuple[int, ...]
    paths: tuple[str, ...]
    order: str
    session_minutes: int
    preferred_date: date | None
    agreed_estimate: Estimate
    current_version: int
    status: str  # active | paused | completed
    created_at: datetime
    policy: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class LearningZone:
    """What the learning date needs from the profile (API-spec §1.10, D57)."""

    time_zone: str
    pending_time_zone: str | None = None
    pending_effective: date | None = None


@dataclass(frozen=True, slots=True)
class PlanInForce:
    """A plan on one learning date, as E20 needs it.

    ``current_version_id`` is the row ``app_open_session`` accepts. Scope, paths, order, minutes and
    known passages are those of ``version_in_force`` (D57). ``bank_version`` is the edition's, since
    the schema stores none on a plan (A-02); ``None`` once the edition is no longer readable.
    """

    plan_id: UUID
    edition_id: UUID
    status: str  # active | paused | completed
    current_version: int
    current_version_id: UUID
    version_in_force: int
    bank_version: int | None
    target_scope: tuple[int, ...]
    paths: tuple[str, ...]
    order: str
    session_minutes: int
    known_passage_ids: frozenset[UUID]


class PlanRepository(Protocol):
    def read_plan(self, ctx: SessionContext, plan_id: UUID) -> StoredPlan | None:
        """The caller's plan, or ``None`` when unknown or not owned (indistinguishable)."""

    def read_in_force(self, ctx: SessionContext, plan_id: UUID, on: date) -> PlanInForce | None:
        """The caller's plan with the values in force on the learning date ``on``, or ``None`` when
        unknown or not owned. The status is not judged here."""

    def create_plan(self, ctx: SessionContext, commit: PlanCommit) -> UUID:
        """Pause the caller's active plan, insert plan, version 1 and phases. Raises
        ``ActivePlanConflict`` on a race on the one-active-plan rule."""

    def revise_plan(
        self, ctx: SessionContext, plan_id: UUID, expected_version: int, commit: PlanCommit
    ) -> int:
        """Append a version; returns the new version number. Raises ``PlanNotFound``,
        ``PlanNotActive`` (completed; tested before the version) and ``PlanVersionConflict``. The
        plan status is not changed."""

    def resume_plan(self, ctx: SessionContext, plan_id: UUID) -> int:
        """Make a paused plan active and pause the current one; an active plan is unchanged.
        Returns ``currentVersion``. Raises ``PlanNotFound``, ``PlanNotActive`` (completed) and
        ``ActivePlanConflict``."""


class PlacementReader(Protocol):
    def known_passage_ids(
        self, ctx: SessionContext, placement_session_id: UUID, edition_id: UUID
    ) -> frozenset[UUID]:
        """Passages answered correctly and unassisted in the caller's placement session for this
        edition. Raises ``PlacementNotFound`` for an unknown, foreign or other-edition session."""


class ProfileReader(Protocol):
    def learning_zone(self, ctx: SessionContext) -> LearningZone:
        """The caller's time zone (and a pending change) for the learning date."""


@dataclass(frozen=True, slots=True)
class _Snapshot:
    scope: tuple[int, ...]
    paths: tuple[str, ...]
    order: str
    session_minutes: int
    known: frozenset[UUID]


def _snapshot_of(policy: Mapping[str, Any]) -> _Snapshot:
    """The values one plan version put in force, read from its ``policy_json``. A snapshot that is
    incomplete or out of range raises ``KeyError``, ``TypeError`` or ``ValueError``."""
    scope = policy["scope"]["sectionOrdinals"]
    paths = policy["paths"]
    minutes = policy["sessionMinutes"]
    order = policy["order"]
    if (
        not isinstance(scope, list)
        or not scope
        or any(isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in scope)
        or not isinstance(paths, list)
        or not paths
        or any(path not in PATH_ORDER for path in paths)
        or order not in ("book", "reverse")
        or isinstance(minutes, bool)
        or not isinstance(minutes, int)
        or minutes not in SESSION_MINUTES_OPTIONS
    ):
        raise ValueError("policy snapshot")
    return _Snapshot(
        tuple(sorted(set(scope))),
        canonical_paths(paths),
        order,
        minutes,
        frozenset(known_from_policy(policy).passage_ids),
    )


# --- memory mode ---------------------------------------------------------------------------------


@dataclass
class _Version:
    version_id: UUID
    version_no: int
    reason_code: str
    policy: dict[str, Any]
    effective_learning_date: date
    phases: list[dict[str, Any]]


@dataclass
class _Plan:
    plan_id: UUID
    user_id: UUID
    edition_id: UUID
    target_scope: tuple[int, ...]
    paths: tuple[str, ...]
    order: str
    session_minutes: int
    preferred_date: date | None
    agreed_estimate: Estimate
    current_version: int
    status: str
    created_at: datetime
    versions: list[_Version] = field(default_factory=list)


class MemoryPlanRepository:
    """In-memory plans with the semantics of the database functions (memory mode, tests)."""

    def __init__(
        self,
        *,
        titles: Callable[[UUID], tuple[str, str]] | None = None,
        bank_version: Callable[[UUID], int | None] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._titles = titles or (lambda edition_id: ("", ""))
        self._bank_version = bank_version or (lambda edition_id: None)
        self._clock = clock or (lambda: datetime.now(UTC))
        self._plans: dict[UUID, _Plan] = {}
        self._lock = threading.RLock()

    def _owned(self, user_id: UUID, plan_id: UUID) -> _Plan | None:
        plan = self._plans.get(plan_id)
        return plan if plan is not None and plan.user_id == user_id else None

    def _stored(self, plan: _Plan) -> StoredPlan:
        titles = self._titles(plan.edition_id)
        return StoredPlan(
            plan_id=plan.plan_id,
            edition_id=plan.edition_id,
            title_ar=titles[0],
            title_en=titles[1],
            target_scope=plan.target_scope,
            paths=plan.paths,
            order=plan.order,
            session_minutes=plan.session_minutes,
            preferred_date=plan.preferred_date,
            agreed_estimate=plan.agreed_estimate,
            current_version=plan.current_version,
            status=plan.status,
            created_at=plan.created_at,
            policy=dict(plan.versions[-1].policy),
        )

    def read_plan(self, ctx: SessionContext, plan_id: UUID) -> StoredPlan | None:
        with self._lock:
            plan = self._owned(ctx.user_id, plan_id)
            return self._stored(plan) if plan is not None else None

    def read_in_force(self, ctx: SessionContext, plan_id: UUID, on: date) -> PlanInForce | None:
        with self._lock:
            plan = self._owned(ctx.user_id, plan_id)
            if plan is None:
                return None
            arrived = [v for v in plan.versions if v.effective_learning_date <= on]
            # A zone moved west can put the date before version 1's: version 1 applies then.
            in_force = max(arrived, key=lambda v: v.version_no) if arrived else plan.versions[0]
            current = plan.versions[plan.current_version - 1]
            try:
                snapshot = _snapshot_of(in_force.policy)
            except (KeyError, TypeError, ValueError):
                raise _bad_row("policy_snapshot") from None
            return PlanInForce(
                plan_id=plan.plan_id,
                edition_id=plan.edition_id,
                status=plan.status,
                current_version=plan.current_version,
                current_version_id=current.version_id,
                version_in_force=in_force.version_no,
                bank_version=self._bank_version(plan.edition_id),
                target_scope=snapshot.scope,
                paths=snapshot.paths,
                order=snapshot.order,
                session_minutes=snapshot.session_minutes,
                known_passage_ids=snapshot.known,
            )

    def create_plan(self, ctx: SessionContext, commit: PlanCommit) -> UUID:
        values = commit.values
        with self._lock:
            for other in self._plans.values():
                if other.user_id == ctx.user_id and other.status == "active":
                    other.status = "paused"
            plan = _Plan(
                plan_id=uuid.uuid4(),
                user_id=ctx.user_id,
                edition_id=values.edition_id,
                target_scope=values.scope,
                paths=values.paths,
                order=values.order,
                session_minutes=values.session_minutes,
                preferred_date=values.preferred_date,
                agreed_estimate=values.agreed_estimate,
                current_version=1,
                status="active",
                created_at=self._clock().astimezone(UTC),
            )
            plan.versions.append(_version_of(1, commit))
            self._plans[plan.plan_id] = plan
            return plan.plan_id

    def revise_plan(
        self, ctx: SessionContext, plan_id: UUID, expected_version: int, commit: PlanCommit
    ) -> int:
        values = commit.values
        with self._lock:
            plan = self._owned(ctx.user_id, plan_id)
            if plan is None:
                raise PlanNotFound
            if plan.status == "completed":  # the function tests the status before the version
                raise PlanNotActive
            if plan.current_version != expected_version:
                raise PlanVersionConflict(plan.current_version)
            plan.target_scope = values.scope
            plan.paths = values.paths
            plan.order = values.order
            plan.session_minutes = values.session_minutes
            plan.preferred_date = values.preferred_date
            plan.agreed_estimate = values.agreed_estimate
            plan.current_version = expected_version + 1
            plan.versions.append(_version_of(plan.current_version, commit))
            return plan.current_version

    def resume_plan(self, ctx: SessionContext, plan_id: UUID) -> int:
        with self._lock:
            plan = self._owned(ctx.user_id, plan_id)
            if plan is None:
                raise PlanNotFound
            if plan.status == "completed":
                raise PlanNotActive
            if plan.status == "active":
                return plan.current_version
            for other in self._plans.values():
                if other.user_id == ctx.user_id and other.status == "active":
                    other.status = "paused"
            plan.status = "active"
            return plan.current_version

    # -- helpers for tests and tooling (not part of the protocol) ------------------------------

    def plans_of(self, user_id: UUID) -> list[StoredPlan]:
        with self._lock:
            return [self._stored(p) for p in self._plans.values() if p.user_id == user_id]

    def versions_of(self, plan_id: UUID) -> list[dict[str, Any]]:
        """The stored versions (reason, effective date, policy, phases), oldest first."""
        with self._lock:
            plan = self._plans.get(plan_id)
            if plan is None:
                return []
            return [
                {
                    "versionId": v.version_id,
                    "versionNo": v.version_no,
                    "reasonCode": v.reason_code,
                    "effectiveLearningDate": v.effective_learning_date,
                    "policy": v.policy,
                    "phases": v.phases,
                }
                for v in plan.versions
            ]

    def complete_plan(self, plan_id: UUID) -> None:
        """Mark a plan completed (the mastery engine does this later; tests need it now)."""
        with self._lock:
            self._plans[plan_id].status = "completed"


def _version_of(version_no: int, commit: PlanCommit) -> _Version:
    return _Version(
        version_id=uuid.uuid4(),
        version_no=version_no,
        reason_code=commit.reason_code,
        policy=dict(commit.policy_json),
        effective_learning_date=commit.effective_learning_date,
        phases=commit.phase_rows(),
    )


class MemoryPlacementReader:
    """Placement sessions of memory mode: seeded by tests (and later by the session package)."""

    def __init__(self) -> None:
        self._sessions: dict[UUID, tuple[UUID, UUID, frozenset[UUID]]] = {}
        self._lock = threading.Lock()

    def add_session(
        self,
        user_id: UUID,
        placement_session_id: UUID,
        edition_id: UUID,
        known_passage_ids: frozenset[UUID] | set[UUID],
    ) -> None:
        with self._lock:
            self._sessions[placement_session_id] = (
                user_id,
                edition_id,
                frozenset(known_passage_ids),
            )

    def known_passage_ids(
        self, ctx: SessionContext, placement_session_id: UUID, edition_id: UUID
    ) -> frozenset[UUID]:
        with self._lock:
            entry = self._sessions.get(placement_session_id)
        if entry is None or entry[0] != ctx.user_id or entry[1] != edition_id:
            raise PlacementNotFound
        return entry[2]


class MemoryProfileReader:
    """Synthetic profiles of memory mode: every account has ``default`` unless one is set."""

    def __init__(self, default: str = DEFAULT_TIME_ZONE) -> None:
        self._default = default
        self._zones: dict[UUID, LearningZone] = {}

    def set_zone(self, user_id: UUID, zone: LearningZone) -> None:
        self._zones[user_id] = zone

    def learning_zone(self, ctx: SessionContext) -> LearningZone:
        return self._zones.get(ctx.user_id) or LearningZone(self._default)


# --- supabase mode -------------------------------------------------------------------------------


def _unexpected(signal: DbSignal) -> AppError:
    """A database signal this call does not expect: logged by code only, answered ``internal``."""
    log_event(logger, "db_signal_unexpected", level=logging.ERROR, sqlstate=signal.sqlstate)
    return AppError(ErrorCode.internal)


def _bad_row(kind: str) -> AppError:
    log_event(logger, "plan_row_invalid", level=logging.ERROR, kind=kind)
    return AppError(ErrorCode.internal)


def _rpc_int(result: Any) -> int:
    if isinstance(result, bool) or not isinstance(result, int):
        raise _bad_row("rpc_result")
    return result


def _book_titles(row: Mapping[str, Any]) -> tuple[str, str]:
    """Titles from the embedded ``book_editions(books(...))``; empty when the learner may not read
    the edition any more (revoked)."""
    edition: Any = row.get("book_editions")
    if isinstance(edition, list):
        edition = edition[0] if edition else None
    book: Any = edition.get("books") if isinstance(edition, dict) else None
    if isinstance(book, list):
        book = book[0] if book else None
    if not isinstance(book, dict):
        return "", ""
    title_ar = str(book.get("title_ar") or "")
    return title_ar, str(book.get("title_en") or title_ar)


def _embedded_bank_version(row: Mapping[str, Any]) -> int | None:
    """``book_editions(bank_version)`` of a plan row; ``None`` when the edition is not readable."""
    edition: Any = row.get("book_editions")
    if isinstance(edition, list):
        edition = edition[0] if edition else None
    value: Any = edition.get("bank_version") if isinstance(edition, dict) else None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    return value


def _plan_from_row(row: Mapping[str, Any], policy: Mapping[str, Any]) -> StoredPlan:
    scope = row["target_scope"]["sectionOrdinals"]
    title_ar, title_en = _book_titles(row)
    preferred = row.get("preferred_date")
    created = datetime.fromisoformat(str(row["created_at"]))
    return StoredPlan(
        plan_id=UUID(str(row["id"])),
        edition_id=UUID(str(row["edition_id"])),
        title_ar=title_ar,
        title_en=title_en,
        target_scope=tuple(sorted({int(item) for item in scope})),
        paths=tuple(str(item) for item in row["paths"]),
        order=str(row["plan_order"]),
        session_minutes=int(row["session_minutes"]),
        preferred_date=date.fromisoformat(str(preferred)) if preferred else None,
        agreed_estimate=Estimate.model_validate(row["agreed_estimate"]),
        current_version=int(row["current_version"]),
        status=str(row["status"]),
        created_at=created if created.tzinfo else created.replace(tzinfo=UTC),
        policy=policy if isinstance(policy, Mapping) else {},
    )


def _plan_args(commit: PlanCommit) -> dict[str, Any]:
    """The named arguments shared by ``app_create_plan`` and ``app_revise_plan``."""
    values = commit.values
    return {
        "p_target_scope": {"sectionOrdinals": list(values.scope)},
        "p_paths": list(values.paths),
        "p_plan_order": values.order,
        "p_session_minutes": values.session_minutes,
        "p_preferred_date": values.preferred_date.isoformat() if values.preferred_date else None,
        "p_agreed_estimate": values.agreed_estimate.model_dump(by_alias=True, mode="json"),
        "p_reason_code": commit.reason_code,
        "p_policy_json": commit.policy_json,
        "p_effective_learning_date": commit.effective_learning_date.isoformat(),
        "p_phases": commit.phase_rows(),
    }


class PostgrestPlanRepository:
    def __init__(self, client: PostgrestClient) -> None:
        self._client = client

    def read_plan(self, ctx: SessionContext, plan_id: UUID) -> StoredPlan | None:
        token = require_token(ctx.access_token)
        rows = self._client.select(
            "master_plans",
            columns=PLAN_COLUMNS,
            filters={"id": f"eq.{plan_id}", "user_id": f"eq.{ctx.user_id}"},
            token=token,
        )
        if not rows:
            return None
        row = rows[0]
        try:
            versions = self._client.select(
                "plan_versions",
                columns="policy_json",
                filters={
                    "plan_id": f"eq.{plan_id}",
                    "user_id": f"eq.{ctx.user_id}",
                    "version_no": f"eq.{int(row['current_version'])}",
                },
                token=token,
            )
            policy = versions[0].get("policy_json") if versions else {}
            return _plan_from_row(row, policy if isinstance(policy, dict) else {})
        except (KeyError, TypeError, ValueError, AttributeError):
            raise _bad_row("plan_shape") from None

    def read_in_force(self, ctx: SessionContext, plan_id: UUID, on: date) -> PlanInForce | None:
        token = require_token(ctx.access_token)
        rows = self._client.select(
            "master_plans",
            columns=IN_FORCE_PLAN_COLUMNS,
            filters={"id": f"eq.{plan_id}", "user_id": f"eq.{ctx.user_id}"},
            token=token,
        )
        if not rows:
            return None
        row = rows[0]
        own = {"plan_id": f"eq.{plan_id}", "user_id": f"eq.{ctx.user_id}"}
        # The newest version whose date has arrived, else the first.
        in_force = self._first_version(
            {**own, "effective_learning_date": f"lte.{on.isoformat()}"}, "version_no.desc", token
        ) or self._first_version(own, "version_no.asc", token)
        try:
            current = int(row["current_version"])
            if in_force is None:
                raise ValueError("a plan without a version")
            snapshot = _snapshot_of(in_force["policy_json"])
            in_force_id = UUID(str(in_force["id"]))
            if int(in_force["version_no"]) == current:
                current_id = in_force_id
            else:  # a revision is waiting for its day, and app_open_session wants that row
                latest = self._first_version({**own, "version_no": f"eq.{current}"}, None, token)
                if latest is None:
                    raise ValueError("the current version row")
                current_id = UUID(str(latest["id"]))
            return PlanInForce(
                plan_id=UUID(str(row["id"])),
                edition_id=UUID(str(row["edition_id"])),
                status=str(row["status"]),
                current_version=current,
                current_version_id=current_id,
                version_in_force=int(in_force["version_no"]),
                bank_version=_embedded_bank_version(row),
                target_scope=snapshot.scope,
                paths=snapshot.paths,
                order=snapshot.order,
                session_minutes=snapshot.session_minutes,
                known_passage_ids=snapshot.known,
            )
        except (KeyError, TypeError, ValueError, AttributeError):
            raise _bad_row("plan_in_force") from None

    def _first_version(
        self, filters: Mapping[str, str], order: str | None, token: SecretStr
    ) -> dict[str, Any] | None:
        rows = self._client.select(
            "plan_versions",
            columns=IN_FORCE_VERSION_COLUMNS,
            filters=filters,
            order=order,
            limit=1,
            token=token,
        )
        return rows[0] if rows else None

    def create_plan(self, ctx: SessionContext, commit: PlanCommit) -> UUID:
        arguments = {
            "p_edition_id": str(commit.values.edition_id),
            **_plan_args(commit),
            "p_sessions": None,
            "p_plan_id": None,
        }
        try:
            result = self._client.rpc(
                "app_create_plan", arguments, token=require_token(ctx.access_token)
            )
        except DbSignal as signal:
            if signal.sqlstate == "23505" and signal.constraint == ACTIVE_PLAN_CONSTRAINT:
                raise ActivePlanConflict from None
            raise _unexpected(signal) from None
        try:
            return UUID(str(result))
        except ValueError:
            raise _bad_row("rpc_result") from None

    def revise_plan(
        self, ctx: SessionContext, plan_id: UUID, expected_version: int, commit: PlanCommit
    ) -> int:
        arguments = {
            "p_plan_id": str(plan_id),
            "p_expected_version": expected_version,
            **_plan_args(commit),
        }
        try:
            result = self._client.rpc(
                "app_revise_plan", arguments, token=require_token(ctx.access_token)
            )
        except DbSignal as signal:
            if signal.sqlstate == "QT002":
                current = self.read_plan(ctx, plan_id)
                if current is None:
                    raise PlanNotFound from None
                raise PlanVersionConflict(current.current_version) from None
            if signal.sqlstate == "P0002":
                raise PlanNotFound from None
            if signal.sqlstate == "QT003":  # completed after the service read the status
                raise PlanNotActive from None
            raise _unexpected(signal) from None
        return _rpc_int(result)

    def resume_plan(self, ctx: SessionContext, plan_id: UUID) -> int:
        try:
            result = self._client.rpc(
                "app_resume_plan", {"p_plan": str(plan_id)}, token=require_token(ctx.access_token)
            )
        except DbSignal as signal:
            if signal.sqlstate == "P0002":
                raise PlanNotFound from None
            if signal.sqlstate == "QT003":
                raise PlanNotActive from None
            if signal.sqlstate == "23505" and signal.constraint == ACTIVE_PLAN_CONSTRAINT:
                raise ActivePlanConflict from None
            raise _unexpected(signal) from None
        return _rpc_int(result)


class PostgrestPlacementReader:
    """A placement session is a ``learning_sessions`` row of kind ``placement``; its known
    passages are those with a correct, unassisted attempt in it ([O-17], the simplest reading of
    "answered correctly")."""

    def __init__(self, client: PostgrestClient) -> None:
        self._client = client

    def known_passage_ids(
        self, ctx: SessionContext, placement_session_id: UUID, edition_id: UUID
    ) -> frozenset[UUID]:
        token = require_token(ctx.access_token)
        sessions = self._client.select(
            "learning_sessions",
            columns="id,edition_id",
            filters={
                "id": f"eq.{placement_session_id}",
                "user_id": f"eq.{ctx.user_id}",
                "kind": "eq.placement",
            },
            token=token,
        )
        if not sessions or str(sessions[0].get("edition_id")) != str(edition_id):
            raise PlacementNotFound
        attempts = self._client.select(
            "attempts",
            columns="passage_id",
            filters={
                "session_id": f"eq.{placement_session_id}",
                "user_id": f"eq.{ctx.user_id}",
                "correct": "eq.true",
                "assisted": "eq.false",
            },
            token=token,
        )
        try:
            return frozenset(UUID(str(row["passage_id"])) for row in attempts)
        except (KeyError, ValueError):
            raise _bad_row("attempt_shape") from None


class PostgrestProfileReader:
    def __init__(self, client: PostgrestClient) -> None:
        self._client = client

    def learning_zone(self, ctx: SessionContext) -> LearningZone:
        rows = self._client.select(
            "profiles",
            columns="time_zone,pending_settings",
            filters={"user_id": f"eq.{ctx.user_id}"},
            token=require_token(ctx.access_token),
        )
        if not rows:
            raise _bad_row("profile_missing")
        pending = rows[0].get("pending_settings")
        pending_zone: str | None = None
        pending_effective: date | None = None
        try:
            if (
                isinstance(pending, dict)
                and pending.get("timeZone")
                and pending.get("effectiveDate")
            ):
                pending_zone = str(pending["timeZone"])
                pending_effective = date.fromisoformat(str(pending["effectiveDate"]))
            return LearningZone(str(rows[0]["time_zone"]), pending_zone, pending_effective)
        except (KeyError, ValueError):
            raise _bad_row("profile_shape") from None
