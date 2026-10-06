"""Offline snapshots: E23 ``POST /api/plans/:id/offline-snapshots``, E24
``GET /api/offline-snapshots/:id`` and E25 ``POST /api/offline/revalidate`` (package B9; API-spec
§4.8, S-1, S-2, A-04, A-12, D46, D58, D59; offline-decisions G-01 to G-07, G-12).

``OfflineService.create_snapshot`` prepares what an installed app needs to reopen a plan without a
connection: the verbatim lessons of the downloaded passages (with their canonical URLs), up to seven
prepared sessions (one daily and one game per type, G-02) whose steps carry every option and
``answerKey``, the policy versions and hashes, and stores them as one immutable snapshot through
``repositories/offline.py``. No model is called and nothing of the snapshot is logged. The snapshot
never holds a token, a password, a recovery code, commentary or translation (the bank holds none).

Order of the checks of E23 (the body schema is validated first, as in E20): plan (404) -> an
existing snapshot of the same ``clientOperationId`` (200 with that snapshot when the plan, version
and, if sent, target references are the same, else 409 ``idempotency_input``) -> plan state (409
``plan_not_active``) -> version (409 ``plan_version``) -> edition (422 ``edition_not_available``,
``edition_not_downloadable``) -> target references (422 ``target_refs_invalid``). The idempotent
replay comes before the state checks so that a lost response can be retried after the plan moved on
(the device then learns the change from E25); only an edition that is revoked, withdrawn or no
longer readable refuses it, because a snapshot never delivers blocked text. Hiding an edition stops
new selection only (D44): it does not refuse a replay.

How the sessions are composed: a second ``SessionService`` runs the ordinary E20 composition and
rendering over a bank restricted to the downloaded passages and over a learning repository whose
``open_session`` only records the session (reads go to the real repository). So the prepared
sessions are exactly what E20 would build, nothing is stored until the snapshot is, and
``services/sessions.py`` needs only the public ``passage_views``. A session without steps is not
prepared (for example a game type the downloaded passages have no question for).

Design choices where the contract is silent (also in the package report):

- ``games`` lists the questions of the prepared game sessions (the same objects as in their
  steps, each once); ``references`` the distinct sources of the lessons and of those questions.
- The goal and the time zone are those in force at download: the day's ``daily_progress`` goal
  (D57) or the plan's minutes, and the calendar's ``learning_zone`` (``UTC`` when the calendar
  does not name one).
- A payload larger than ``MAX_PAYLOAD_BYTES`` is rebuilt over fewer passages when the server chose
  them, and refused with ``target_refs_invalid`` when the client did (G-15, well under 4 MB).
- Rights: ``rights_rejected`` is an optional callable. The column lives on ``sources`` and the
  learner role cannot read it, so by default only the edition status decides: a new download
  needs ``edition.selectable`` (G-12); E24 and E25 only look for a revoked or withdrawn edition.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import UUID

from app.contracts_offline import (
    MAX_PREPARED_SESSIONS,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    CreateSnapshotRequest,
    OfflinePlanSnapshot,
    RevalidateRequest,
    RevalidationResult,
    parse_create_snapshot_request,
    parse_revalidate_request,
)
from app.contracts_plan_chat import TargetScope
from app.contracts_sessions import (
    PassageView,
    QuestionStep,
    RequestViolation,
    SessionSnapshot,
    SourceRef,
)
from app.contracts_sessions import Question as QuestionDto
from app.dependencies import SessionContext
from app.domain.offline_policy import (
    Current,
    Held,
    derive_status,
    edition_downloadable,
    prepared_session_kinds,
    runnable_session_ids,
    select_download_targets,
    snapshot_mismatches,
)
from app.domain.time_policy import resolve_goal_ms
from app.errors import AppError, ErrorCode
from app.repositories.bank import BankPassage, BankRepository, EditionInfo, parse_or_internal
from app.repositories.learning import NewSession, OpenedSession, StoredSession
from app.repositories.offline import NewSnapshot, OfflineRepository, StoredSnapshot
from app.services.sessions import PlanAccess, PlanSnapshot, SessionService

MAX_PAYLOAD_BYTES = 3_500_000  # well under the 4 MB of a response through the host rewrite (G-15)
_SHRINK_ATTEMPTS = 6
_DEFAULT_ZONE = "UTC"


def _violation(*pairs: tuple[str, str]) -> AppError:
    return AppError(
        ErrorCode.validation_error,
        details={"fields": [{"field": field, "rule": rule} for field, rule in pairs]},
    )


def _conflict(reason: str, **details: Any) -> AppError:
    return AppError(ErrorCode.version_conflict, details={"reason": reason, **details})


def _integrity() -> AppError:
    return AppError(ErrorCode.internal)


@dataclass(frozen=True, slots=True)
class CreatedOfflineSnapshot:
    """E23 result: ``created`` is false when the operation returns its earlier snapshot (200)."""

    snapshot: OfflinePlanSnapshot
    created: bool


# --- the second session service: compose and render, store nothing --------------------------------


class _CapturingLearning:
    """A learning repository that records the sessions ``SessionService`` would open and answers
    every read from the real one. A recorded session reads back as ``prepared``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.captured: dict[UUID, NewSession] = {}

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def open_session(self, ctx: SessionContext, new: NewSession) -> OpenedSession:
        self.captured[new.session_id] = new
        return OpenedSession(new.session_id, True)

    def read_session(self, ctx: SessionContext, session_id: UUID) -> StoredSession | None:
        new = self.captured.get(session_id)
        if new is None:
            return None
        return StoredSession(
            id=new.session_id,
            user_id=ctx.user_id,
            plan_id=new.plan_id,
            plan_version_id=new.plan_version_id,
            plan_version=new.plan_version,
            edition_id=new.edition_id,
            kind=new.kind,
            learning_date=new.learning_date,
            lesson_refs=new.lesson_refs,
            question_refs=new.question_refs,
            steps=new.steps,
            bank_version=new.bank_version,
            status="prepared",
            created_at=new.created_at,
        )

    def find_open_daily(self, ctx: SessionContext, learning_date: date) -> StoredSession | None:
        return None  # an offline daily session never joins the daily get-or-create

    def mark_completed(self, ctx: SessionContext, session_id: UUID) -> None:
        return None


class _RestrictedBank:
    """The bank, except that ``passages`` returns only the downloaded ones: composition then
    draws only from them."""

    def __init__(self, inner: BankRepository, allowed: frozenset[UUID]) -> None:
        self._inner = inner
        self._allowed = allowed

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def passages(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        section_ordinals: Sequence[int],
        paths: Sequence[str],
    ) -> list[BankPassage]:
        return [
            passage
            for passage in self._inner.passages(
                ctx,
                edition_id,
                bank_version=bank_version,
                section_ordinals=section_ordinals,
                paths=paths,
            )
            if passage.id in self._allowed
        ]


class _FixedPlan:
    """``PlanAccess`` that returns the plan E23 already loaded, so every session is composed for
    the same plan version."""

    def __init__(self, plan: PlanSnapshot) -> None:
        self._plan = plan

    def load_for_session(self, ctx: SessionContext, plan_id: UUID) -> PlanSnapshot:
        return self._plan


# --- the service ---------------------------------------------------------------------------------


class OfflineService:
    def __init__(
        self,
        *,
        sessions: SessionService,
        repository: OfflineRepository,
        new_id: Callable[[], UUID] | None = None,
        rights_rejected: Callable[[EditionInfo], bool] | None = None,
        max_payload_bytes: int = MAX_PAYLOAD_BYTES,
    ) -> None:
        self._sessions = sessions
        self._repo = repository
        self._new_id = new_id or uuid.uuid4
        self._rights_rejected = rights_rejected
        self._max_bytes = max_payload_bytes

    @property
    def _bank(self) -> BankRepository:
        return self._sessions.bank

    @property
    def _plans(self) -> PlanAccess:
        return self._sessions.plans

    # -- parsing -------------------------------------------------------------------------------

    def parse_create(self, raw: Any) -> CreateSnapshotRequest:
        """Validate the E23 body; the rule names are those of API-spec E23."""
        try:
            return parse_create_snapshot_request(raw)
        except RequestViolation as violation:
            raise _violation(*violation.fields) from None

    def parse_revalidate(self, raw: Any) -> RevalidateRequest:
        """Validate the E25 body."""
        try:
            return parse_revalidate_request(raw)
        except RequestViolation as violation:
            raise _violation(*violation.fields) from None

    # -- E23 -----------------------------------------------------------------------------------

    def create_snapshot(
        self, ctx: SessionContext, plan_id: UUID, request: CreateSnapshotRequest
    ) -> CreatedOfflineSnapshot:
        plan = self._plans.load_for_session(ctx, plan_id)
        existing = self._repo.find_by_operation(ctx, request.client_operation_id)
        if existing is not None:
            return self._replay(ctx, plan, existing, request)
        if plan.status != "active":
            raise _conflict("plan_not_active")
        if request.expected_plan_version != plan.current_version:
            raise _conflict("plan_version", currentVersion=plan.current_version)
        edition = self._bank.edition(ctx, plan.edition_id)
        if edition is None or edition.bank_version != plan.bank_version:
            raise _violation(("planId", "edition_not_available"))
        if not self._downloadable(edition):
            raise _violation(("planId", "edition_not_downloadable"))
        passages = self._bank.passages(
            ctx,
            edition.edition_id,
            bank_version=plan.bank_version,
            section_ordinals=plan.section_ordinals,
            paths=plan.paths,
        )
        by_id = {passage.id: passage for passage in passages}
        chosen_by_server = request.download_target_refs is None
        if request.download_target_refs is None:
            ids = self._select_targets(ctx, plan, passages)
        else:
            ids = list(request.download_target_refs)
            outside = [
                (f"downloadTargetRefs[{index}]", "target_refs_invalid")
                for index, passage_id in enumerate(ids)
                if passage_id not in by_id
            ]
            if outside:
                raise _violation(*outside)
        if not ids:
            raise _violation(("downloadTargetRefs", "target_refs_invalid"))
        return self._create(ctx, plan, edition, request, ids, by_id, chosen_by_server)

    def _select_targets(
        self, ctx: SessionContext, plan: PlanSnapshot, passages: Sequence[BankPassage]
    ) -> list[UUID]:
        try:
            infos = [passage.info() for passage in passages]
        except ValueError:
            raise _integrity() from None
        return select_download_targets(
            infos,
            plan.order,
            self._sessions.learning.mastery_for_plan(ctx, plan.plan_id),
            self._sessions.calendar.learning_date(ctx),
        )

    def _replay(
        self,
        ctx: SessionContext,
        plan: PlanSnapshot,
        existing: StoredSnapshot,
        request: CreateSnapshotRequest,
    ) -> CreatedOfflineSnapshot:
        refs = (
            None
            if request.download_target_refs is None
            else tuple(str(ref) for ref in request.download_target_refs)
        )
        if (
            existing.plan_id != plan.plan_id
            or existing.plan_version != request.expected_plan_version
            or (refs is not None and existing.download_target_refs != refs)
        ):
            raise _conflict("idempotency_input")
        edition = self._bank.edition(ctx, existing.edition_id)
        if edition is None:
            raise _violation(("planId", "edition_not_available"))
        if self._withdrawn(edition):
            raise _violation(("planId", "edition_not_downloadable"))
        return CreatedOfflineSnapshot(self._dto(existing), created=False)

    def _create(
        self,
        ctx: SessionContext,
        plan: PlanSnapshot,
        edition: EditionInfo,
        request: CreateSnapshotRequest,
        ids: list[UUID],
        by_id: dict[UUID, BankPassage],
        chosen_by_server: bool,
    ) -> CreatedOfflineSnapshot:
        snapshot_id = self._new_id()
        learning_date = self._sessions.calendar.learning_date(ctx)
        for attempt in range(_SHRINK_ATTEMPTS):
            built, sessions = self._build(
                ctx, plan, edition, snapshot_id, learning_date, [by_id[i] for i in ids]
            )
            payload = built.model_dump(mode="json", by_alias=True)
            size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())
            if size <= self._max_bytes:
                break
            if not chosen_by_server or len(ids) == 1 or attempt == _SHRINK_ATTEMPTS - 1:
                raise _violation(("downloadTargetRefs", "target_refs_invalid"))
            ids = ids[: max(1, len(ids) // 2)]
            snapshot_id = self._new_id()
        new = NewSnapshot(
            snapshot_id=snapshot_id,
            plan_id=plan.plan_id,
            plan_version=plan.current_version,
            edition_id=edition.edition_id,
            bank_version=plan.bank_version,
            client_operation_id=request.client_operation_id,
            download_target_refs=tuple(str(i) for i in ids),
            schema_version=SCHEMA_VERSION,
            protocol_version=PROTOCOL_VERSION,
            payload=payload,
            sessions=tuple(sessions),
            created_at=self._sessions.clock(),
        )
        try:
            result = self._repo.create_snapshot(ctx, new, current_plan_version=plan.current_version)
        except AppError as error:
            if error.code is ErrorCode.version_conflict and error.details.get("reason") == (
                "plan_version"
            ):
                latest = self._plans.load_for_session(ctx, plan.plan_id)
                raise _conflict("plan_version", currentVersion=latest.current_version) from None
            raise
        if result.created:
            return CreatedOfflineSnapshot(built, created=True)
        stored = self._repo.read_snapshot(ctx, result.snapshot_id)  # a parallel request won
        if stored is None:
            raise AppError(ErrorCode.unavailable)
        return CreatedOfflineSnapshot(self._dto(stored), created=False)

    def _build(
        self,
        ctx: SessionContext,
        plan: PlanSnapshot,
        edition: EditionInfo,
        snapshot_id: UUID,
        learning_date: date,
        targets: list[BankPassage],
    ) -> tuple[OfflinePlanSnapshot, list[NewSession]]:
        lessons = self._sessions.passage_views(ctx, edition, targets)
        prepared, recorded = self._prepare_sessions(ctx, plan, targets)
        questions = _game_questions(prepared)
        zone = getattr(self._sessions.calendar, "learning_zone", None)
        rows = self._sessions.learning.daily_progress_between(ctx, learning_date, learning_date)
        now = self._sessions.clock()
        snapshot = OfflinePlanSnapshot(
            snapshot_id=snapshot_id,
            user_id=ctx.user_id,
            plan_id=plan.plan_id,
            plan_version=plan.current_version,
            edition_id=edition.edition_id,
            bank_version=plan.bank_version,
            target_scope=TargetScope(section_ordinals=list(plan.section_ordinals)),
            downloaded_target_refs=[passage.id for passage in targets],
            learning_time_zone=zone(ctx).time_zone if callable(zone) else _DEFAULT_ZONE,
            daily_goal_ms=resolve_goal_ms(rows[0].goal_ms if rows else None, plan.session_minutes),
            content_hashes=_content_hashes(lessons),
            verified_at=now,
            content_validity={
                "checkedAt": now.isoformat().replace("+00:00", "Z"),
                "result": "valid",
            },
            prepared_sessions=prepared,
            lessons=lessons,
            games=questions,
            references=_distinct_sources(lessons, questions),
        )
        return snapshot, recorded

    def _prepare_sessions(
        self, ctx: SessionContext, plan: PlanSnapshot, targets: Sequence[BankPassage]
    ) -> tuple[list[SessionSnapshot], list[NewSession]]:
        capture = _CapturingLearning(self._sessions.learning)
        composer = SessionService(
            bank=_RestrictedBank(self._bank, frozenset(passage.id for passage in targets)),
            learning=capture,  # type: ignore[arg-type]
            plans=_FixedPlan(plan),
            calendar=self._sessions.calendar,
            clock=self._sessions.clock,
            new_id=self._new_id,
        )
        prepared: list[SessionSnapshot] = []
        kept: list[NewSession] = []
        for kind, game_type in prepared_session_kinds():
            body: dict[str, Any] = {
                "kind": kind,
                "planId": str(plan.plan_id),
                "expectedPlanVersion": plan.current_version,
            }
            if game_type is not None:
                body["gameType"] = game_type
            created = composer.create_session(ctx, composer.parse_request(body))
            if not created.snapshot.steps:
                continue  # nothing to play: not prepared
            prepared.append(created.snapshot)
            kept.append(capture.captured[created.snapshot.session_id])
        if len(prepared) > MAX_PREPARED_SESSIONS:
            raise _integrity()
        return prepared, kept

    # -- E24 -----------------------------------------------------------------------------------

    def read_snapshot(self, ctx: SessionContext, snapshot_id: UUID) -> OfflinePlanSnapshot:
        """The stored snapshot. Reads only: it never creates a session. A snapshot whose edition is
        revoked, withdrawn or unreadable is ``404`` (A-04): the text is never served. A hidden or
        superseded edition still serves it (D44: hiding stops new selection only)."""
        stored = self._repo.read_snapshot(ctx, snapshot_id)
        if stored is None:
            raise AppError(ErrorCode.not_found)
        edition = self._bank.edition(ctx, stored.edition_id)
        if edition is None or self._withdrawn(edition):
            raise AppError(ErrorCode.not_found)
        return self._dto(stored)

    # -- E25 -----------------------------------------------------------------------------------

    def revalidate(self, ctx: SessionContext, request: RevalidateRequest) -> RevalidationResult:
        """What the device holds against the current server state (A-04, A-12, G-05)."""
        stored = self._repo.read_snapshot(ctx, request.snapshot_id)
        if stored is None:
            raise AppError(ErrorCode.not_found)
        recorded = Held(stored.plan_version, stored.edition_id, stored.bank_version)
        held = Held(request.expected_plan_version, request.edition_id, request.bank_version)
        mismatched = snapshot_mismatches(held, recorded)
        if mismatched:
            raise _violation(*((field, "snapshot_mismatch") for field in mismatched))
        plan = self._plans.load_for_session(ctx, stored.plan_id)
        edition = self._bank.edition(ctx, stored.edition_id)
        status, reason = derive_status(
            recorded,
            Current(
                plan_status=plan.status,
                plan_version=plan.current_version,
                edition_readable=edition is not None,
                bank_version=None if edition is None else edition.bank_version,
                rights_withdrawn=edition is not None and self._withdrawn(edition),
                edition_superseded=edition is not None and edition.status == "superseded",
            ),
        )
        allowed = (
            _in_snapshot_order(
                runnable_session_ids(self._repo.session_states(ctx, stored.id)), stored.payload
            )
            if status == "available"
            else []
        )
        return RevalidationResult(
            status=status,
            current_plan_version=plan.current_version,
            allowed_session_refs=allowed,
            catalog_version=stored.bank_version if edition is None else edition.bank_version,
            reason_code=reason,
        )

    # -- helpers -------------------------------------------------------------------------------

    def _withdrawn(self, edition: EditionInfo) -> bool:
        """The rights of the edition's source were rejected (the optional deployment hook)."""
        return self._rights_rejected is not None and self._rights_rejected(edition)

    def _downloadable(self, edition: EditionInfo) -> bool:
        """A new download (E23) needs a selectable edition whose rights are not rejected (G-12)."""
        return edition_downloadable(
            selectable=edition.selectable, rights_rejected=self._withdrawn(edition)
        )

    @staticmethod
    def _dto(stored: StoredSnapshot) -> OfflinePlanSnapshot:
        """The snapshot as stored; a payload that does not have the documented shape is an
        integrity problem."""
        snapshot = parse_or_internal(lambda: OfflinePlanSnapshot.model_validate(stored.payload))
        if snapshot.snapshot_id != stored.id:
            raise _integrity()
        return snapshot


# --- assembly helpers ----------------------------------------------------------------------------


def _game_questions(sessions: Sequence[SessionSnapshot]) -> list[QuestionDto]:
    """The questions of the prepared game sessions, each once (a question has one type, so no
    question is in two games). The questions of the daily session stay in its steps only: the same
    question can appear there with another role and option order."""
    seen: set[UUID] = set()
    found: list[QuestionDto] = []
    for session in sessions:
        if session.kind != "game":
            continue
        for step in session.steps:
            if isinstance(step, QuestionStep) and step.question.question_id not in seen:
                seen.add(step.question.question_id)
                found.append(step.question)
    return found


def _distinct_sources(
    lessons: Sequence[PassageView], questions: Sequence[QuestionDto]
) -> list[SourceRef]:
    seen: set[tuple[str, ...]] = set()
    found: list[SourceRef] = []
    for source in [*(lesson.source for lesson in lessons), *(q.source for q in questions)]:
        key = (
            source.publisher,
            source.edition_label,
            source.book_title_ar,
            source.reference,
            source.url,
            *source.pages,
        )
        if key not in seen:
            seen.add(key)
            found.append(source)
    return found


def _in_snapshot_order(session_ids: list[UUID], payload: dict[str, Any]) -> list[UUID]:
    """The sessions in the order the snapshot lists them (the database returns the rows of one
    transaction in no meaningful order)."""
    listed = payload.get("preparedSessions")
    position: dict[str, int] = {}
    if isinstance(listed, list):
        for index, session in enumerate(listed):
            if isinstance(session, dict):
                position.setdefault(str(session.get("sessionId")), index)
    return sorted(session_ids, key=lambda session_id: position.get(str(session_id), len(position)))


def _content_hashes(lessons: Sequence[PassageView]) -> dict[str, str]:
    """``unit:<unitRef>`` to the sha256 (hex) of the unit's verbatim text, as the bank's
    ``textHash`` (contract §2.6): the device can verify what it holds."""
    return {
        f"unit:{unit.unit_ref}": hashlib.sha256(unit.text.encode("utf-8")).hexdigest()
        for lesson in lessons
        for unit in lesson.units
    }
