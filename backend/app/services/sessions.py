"""Session preparation: E20 ``POST /api/sessions`` (package B5; API-spec §4.7, §3 S-1..S-5).

``SessionService.create_session`` validates the request against the plan, edition and scope,
composes the session with the pure policies in ``domain/session_policy.py``, renders it into the
DTOs of ``contracts_sessions`` (verbatim text with its canonical URL, every ``answerKey``) and
persists it as an immutable snapshot through ``repositories/learning.py``. No model is called.

Plans and dates come through two ports; this package imports neither B4 (plans) nor B3
(accounts). ``services/plan_access.py`` binds both to B4's plan service and ``app/wiring.py``
installs them:

- ``PlanAccess.load_for_session(ctx, plan_id) -> PlanSnapshot`` (raises ``not_found`` for an
  unknown or foreign plan);
- ``LearningCalendar.learning_date(ctx) -> date`` (the account's time zone, API-spec §1.10).

Order of the checks for ``daily`` and ``game``: plan (404) -> plan state and version (409) ->
edition and scope (422). A ``paused`` plan accepts no session; a ``completed`` plan serves a
``daily`` session of maintenance reviews only and no ``game``. The daily session of a learning date
is a get-or-create: an open one is returned unchanged (200), so a second call returns the same
steps; the response is always built from the stored row.

Design choices where the contract is silent (also in the package report):

- A pinned ``bank_version`` that is no longer the edition's current one is unreadable for a learner
  (row-level security hides it), so it is ``edition_not_available``.
- ``app_open_session`` returns the open daily session of the date whatever its plan; a leftover of
  another plan (the learner switched plans today) is completed first, because nothing can be
  recorded in the session of a plan that is not active.
- Nothing logs a request body, a question or an answer.

Package B6 adds E21 ``POST /api/sessions/:id/events`` (``record_events``) and E22
``POST /api/sessions/:id/complete`` (``complete_session``) to the same service. An E21 request
is processed event by event in array order on a working copy of the passage states
(``_EventBatch``), with the pure rules of ``domain/mastery_policy.py`` and
``domain/time_policy.py``, and persisted with one call of ``app_apply_events`` (plus an
empty-events call for every further learning date). An acknowledged ``clientEventId`` is never
applied twice (the ids are looked up first; the database constraint is the final arbiter). Where
the specification leaves the outcome open:

- Every event gets exactly one outcome. Order of the checks: duplicate, session completed
  (``session_closed``), edition not readable (``edition_mismatch``), the offline envelope against
  the session's pinned values or, for a prepared session, its absence (``envelope_mismatch``: an
  online event needs an open session and a replay opens it, API-spec E21 step 4), a replay whose
  plan moved to another version (``pending`` ``plan_changed_unverifiable``, D59), an online event
  for a paused plan (``plan_not_active``; a completed plan serves maintenance sessions and is
  accepted).
- Answers: ``question_not_in_session`` (S-3), ``invalid_answer_shape`` and ``pending``
  ``policy_unsupported`` (answer policy), ``out_of_scope`` (the plan's scope and paths, S-2),
  ``pending`` ``content_unverifiable`` (the pinned bank cannot be read). Placement sessions record
  the attempt only (no mastery, no evidence) and report an empty passage state.
- Activity: ``activity_out_of_bounds`` (time policy). Placement activity is acknowledged and
  dropped. The learning date of an interval is the date of ``startedAt`` in the account zone, read
  once per request from the calendar's optional ``learning_zone`` (D57); without it the session's
  own date is used.
- ``EventsResponse.daily`` and the ``daily`` of E22 are today's learning date. The goal of a date
  is kept from its first ``daily_progress`` row (D57), else the plan's minutes in force.
"""

from __future__ import annotations

import uuid
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, Protocol, TypeVar
from uuid import UUID

from pydantic import TypeAdapter

from app.config import Settings
from app.contracts_sessions import (
    ActivityEvent,
    AnswerEvent,
    AnswerExpected,
    AnswerPassageState,
    AnswerResult,
    ChoiceOption,
    CompleteResponse,
    CompleteSummary,
    DailyProgress,
    DailySessionRequest,
    EventsRequest,
    EventsResponse,
    GameSessionRequest,
    Highlight,
    LearnStep,
    OfflineEnvelope,
    OptionAnswerKey,
    OrderAnswerKey,
    PassageUnit,
    PassageView,
    PendingEvent,
    PlacementSessionRequest,
    QuestionContext,
    QuestionPolicy,
    QuestionStep,
    RecallAnswerKey,
    RecallQuestion,
    RejectedEvent,
    RequestViolation,
    SessionRequest,
    SessionSnapshot,
    SimilarQuestion,
    SourceRef,
    Step,
    TokenView,
    WordChoiceQuestion,
    WordOrderQuestion,
    option_id_for_refs,
    parse_create_session_request,
    parse_events_request,
    refs_for_option_id,
)
from app.contracts_sessions import Question as QuestionDto
from app.dependencies import SessionContext
from app.domain.answer_policy import (
    SIMILAR_DISTINCTION,
    WORD_CHOICE,
    WORD_ORDER,
    WORD_RECALL,
    GradingUnavailable,
    RejectedAnswer,
    ValidatedAttempt,
    evaluate_answer,
    key_from_question,
)
from app.domain.learning_state import AttemptRecord, PassageMastery
from app.domain.mastery_policy import (
    AcknowledgedIds,
    RoundAnswer,
    advance_target_streak,
    apply_round,
    attempt_counts_for_mastery,
    coverage_counts,
    round_is_complete,
    summarize_round,
)
from app.domain.session_policy import (
    ROLE_REVIEW,
    DailyInputs,
    GameInputs,
    PassageData,
    PlacementInputs,
    PlannedLearn,
    PlannedQuestion,
    PlannedStep,
    compose_daily,
    compose_game,
    compose_placement,
    stable_hash,
)
from app.domain.time_policy import (
    ActivityIgnored,
    ActivityRejected,
    Interval,
    credited_interval,
    learning_date_at,
    resolve_goal_ms,
    session_active_ms,
    should_record_completion,
    summarize_day,
    union_ms,
    validate_activity,
)
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.bank import (
    BankPassage,
    BankQuestion,
    BankRepository,
    BankSection,
    BankUnit,
    EditionInfo,
    InMemoryBankRepository,
    PostgrestBankRepository,
)
from app.repositories.learning import (
    AttemptWrite,
    DailyWrite,
    EventWrite,
    EvidenceWrite,
    InMemoryLearningStore,
    IntervalWrite,
    LearningRepository,
    NewSession,
    PostgrestLearningRepository,
    StoredSession,
)
from app.workflow.bundle_index import parse_ref

T = TypeVar("T")

_STEPS = TypeAdapter(list[Step])


# --- ports ---------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlanSnapshot:
    """What E20 needs to know about a plan, resolved by package B4 for the learning date.

    ``session_minutes`` is the value in force on that date (D57); ``known_passage_ids`` are the
    passages answered correctly in the placement test; ``plan_version_id`` is the id of the
    ``plan_versions`` row of ``current_version`` (the argument of ``app_open_session``).
    """

    plan_id: UUID
    status: Literal["active", "paused", "completed"]
    current_version: int
    plan_version_id: UUID
    edition_id: UUID
    bank_version: int
    section_ordinals: tuple[int, ...]
    paths: tuple[str, ...]
    order: Literal["book", "reverse"]
    session_minutes: Literal[5, 10, 15]
    known_passage_ids: frozenset[UUID] = frozenset()


class PlanAccess(Protocol):
    def load_for_session(self, ctx: SessionContext, plan_id: UUID) -> PlanSnapshot:
        """The caller's plan. Raises ``AppError(not_found)`` for an unknown or foreign plan."""


class LearningCalendar(Protocol):
    def learning_date(self, ctx: SessionContext) -> date:
        """Today's learning date in the account's time zone (API-spec §1.10)."""


class LearningZoneLike(Protocol):
    """What the learning date of an instant needs (``LearningZone`` of package B4 has it)."""

    time_zone: str
    pending_time_zone: str | None
    pending_effective: date | None


class ZoneAwareCalendar(Protocol):
    """Optional companion of ``LearningCalendar``: the account's time zone and a pending change, so
    that E21 can date an activity event by its ``startedAt`` (D57). A calendar without it makes E21
    use the session's own learning date for the intervals of its activity events."""

    def learning_zone(self, ctx: SessionContext) -> LearningZoneLike:
        """The zone in force and a pending change; E21 reads it once per request."""


class _UnboundPlans:
    def load_for_session(self, ctx: SessionContext, plan_id: UUID) -> PlanSnapshot:
        raise AppError(ErrorCode.unavailable)  # nothing is faked before B4 binds the port


class _UnboundCalendar:
    def learning_date(self, ctx: SessionContext) -> date:
        raise AppError(ErrorCode.unavailable)


@dataclass(frozen=True, slots=True)
class CreatedSession:
    """E20 result: ``created`` is false when an open daily session is returned (200)."""

    snapshot: SessionSnapshot
    created: bool


# --- helpers -------------------------------------------------------------------------------------


def _violation(*pairs: tuple[str, str]) -> AppError:
    return AppError(
        ErrorCode.validation_error,
        details={"fields": [{"field": field, "rule": rule} for field, rule in pairs]},
    )


def _integrity() -> AppError:
    return AppError(ErrorCode.internal)


def _ref_key(ref: str) -> tuple[int, int]:
    parsed = parse_ref(ref)
    if parsed is None:
        raise ValueError("not a token reference")
    return parsed


def _shuffled(items: Sequence[T], key: Callable[[T], str], seed: int, salt: object) -> list[T]:
    """A deterministic shuffle: items ordered by a hash of (seed, salt, key)."""
    return sorted(items, key=lambda item: stable_hash(seed, salt, key(item)))


def _question_ordinals(question: BankQuestion) -> set[int]:
    """Ordinals of every unit a question reads text from (options and context may lie outside the
    passage and even outside the plan scope: technical distractors, D31)."""
    refs = [
        *question.token_refs,
        *question.context_refs,
        *question.correct_ref,
        *(ref for option in question.option_refs or () for ref in option),
    ]
    return {_ref_key(ref)[0] for ref in refs}


class _Units:
    """Request-scoped unit and section cache over the bank."""

    def __init__(self, bank: BankRepository, ctx: SessionContext, edition: EditionInfo) -> None:
        self._bank, self._ctx, self._edition = bank, ctx, edition
        self.units: dict[int, BankUnit] = {}
        self.sections: dict[int, BankSection] = {}
        self.by_section: dict[int, list[BankUnit]] = defaultdict(list)
        self._section_units_loaded: set[int] = set()

    def load_section_meta(self, ordinals: Iterable[int]) -> None:
        """Titles and canonical URLs of sections (no units)."""
        wanted = sorted(set(ordinals) - set(self.sections))
        if wanted:
            self.sections.update(self._bank.sections(self._ctx, self._edition.edition_id, wanted))

    def load_section_units(self, ordinals: Iterable[int]) -> None:
        """Every unit of the sections: the text of a passage and the hadith record around it."""
        wanted = sorted(set(ordinals) - self._section_units_loaded)
        if not wanted:
            return
        self.load_section_meta(wanted)
        for unit in self._bank.section_units(self._ctx, self._edition.edition_id, wanted):
            self.units[unit.ordinal] = unit
            if unit.section_ordinal is not None:
                self.by_section[unit.section_ordinal].append(unit)
        self._section_units_loaded.update(wanted)

    def load_units(self, ordinals: Iterable[int]) -> None:
        wanted = sorted(set(ordinals) - set(self.units))
        if wanted:
            self.units.update(self._bank.units(self._ctx, self._edition.edition_id, wanted))

    def unit(self, ordinal: int) -> BankUnit:
        return self.units[ordinal]

    def surface(self, ref: str) -> str:
        unit, index = _ref_key(ref)
        return self.units[unit].surface(index)

    def text_of(self, refs: Sequence[str]) -> str:
        """The verbatim text of an option: one slice of the unit from the first token to the last
        (inner marks and spacing kept); an option over several units joins its slices by a space."""
        groups: dict[int, list[int]] = {}
        for ref in refs:
            unit, index = _ref_key(ref)
            groups.setdefault(unit, []).append(index)
        pieces: list[str] = []
        for unit_ordinal, indexes in groups.items():
            unit = self.units[unit_ordinal]
            first, last = unit.token(min(indexes)), unit.token(max(indexes))
            pieces.append(unit.text[first.s : last.e])
        return " ".join(pieces)

    def source_url(self, ref_or_ordinal: str | int, section: BankSection | None) -> str:
        ordinal = ref_or_ordinal if isinstance(ref_or_ordinal, int) else _ref_key(ref_or_ordinal)[0]
        unit = self.units.get(ordinal)
        if unit is not None and unit.source_url:
            return unit.source_url
        if section is not None and section.source_url:
            return section.source_url
        return self._edition.source_url


class _Questions:
    """Request-scoped question cache; also the ``PassageLoader`` of the pure policies."""

    def __init__(
        self,
        bank: BankRepository,
        learning: LearningRepository,
        ctx: SessionContext,
        edition: EditionInfo,
        bank_version: int,
        *,
        with_history: bool,
    ) -> None:
        self._bank, self._learning, self._ctx = bank, learning, ctx
        self._edition_id, self._bank_version = edition.edition_id, bank_version
        self._with_history = with_history
        self.by_passage: dict[UUID, tuple[BankQuestion, ...]] = {}
        self.by_id: dict[UUID, BankQuestion] = {}
        self._last_tested: dict[UUID, datetime] = {}
        self._last_type: dict[UUID, str] = {}

    def load(self, passage_ids: Sequence[UUID]) -> PassageData:
        missing = [pid for pid in dict.fromkeys(passage_ids) if pid not in self.by_passage]
        if missing:
            grouped: dict[UUID, list[BankQuestion]] = defaultdict(list)
            for question in self._bank.questions(
                self._ctx,
                self._edition_id,
                bank_version=self._bank_version,
                passage_ids=missing,
            ):
                grouped[question.passage_id].append(question)
                self.by_id[question.id] = question
            for passage_id in missing:
                self.by_passage[passage_id] = tuple(grouped.get(passage_id, ()))
            if self._with_history:
                self._absorb_history(missing)
        return PassageData(
            questions={pid: tuple(q.info() for q in self.by_passage[pid]) for pid in passage_ids},
            last_tested=dict(self._last_tested),
            last_type=dict(self._last_type),
        )

    def _absorb_history(self, passage_ids: Sequence[UUID]) -> None:
        """Latest attempt time and question type per part (newest attempts first)."""
        for attempt in self._learning.attempts_for_passages(self._ctx, passage_ids):
            question = self.by_id.get(attempt.question_id)
            if question is None:  # an attempt on a question of another bank version
                continue
            for part_id in question.covered_part_ids:
                self._last_tested.setdefault(part_id, attempt.created_at)
                self._last_type.setdefault(part_id, question.type)


# --- the service ---------------------------------------------------------------------------------


class SessionService:
    def __init__(
        self,
        *,
        bank: BankRepository,
        learning: LearningRepository,
        plans: PlanAccess,
        calendar: LearningCalendar,
        clock: Callable[[], datetime] | None = None,
        new_id: Callable[[], UUID] | None = None,
    ) -> None:
        self._bank = bank
        self._learning = learning
        self._plans = plans
        self._calendar = calendar
        self._clock = clock or (lambda: datetime.now(UTC))
        self._new_id = new_id or uuid.uuid4

    @property
    def bank(self) -> BankRepository:
        return self._bank

    @property
    def learning(self) -> LearningRepository:
        return self._learning

    @property
    def plans(self) -> PlanAccess:
        return self._plans

    @property
    def calendar(self) -> LearningCalendar:
        return self._calendar

    @property
    def clock(self) -> Callable[[], datetime]:
        return self._clock

    # -- E21 and E22 ---------------------------------------------------------------------------

    def parse_events(self, raw: Any) -> EventsRequest:
        """Validate the E21 body: 1 to 100 events, strict, the rule names of API-spec E21 (a
        forbidden property reads ``events[3].correct``). Any failure fails the whole request; values
        are never echoed."""
        try:
            return parse_events_request(raw)
        except RequestViolation as violation:
            raise _violation(*violation.fields) from None

    def record_events(self, ctx: SessionContext, session_id: UUID, raw: Any) -> EventsResponse:
        """E21: grade, record and credit the events of one of the caller's sessions. ``raw`` is the
        JSON body. The order of the failures is the one of API-spec E21: the session (404) before
        the body schema (422)."""
        lock = getattr(self._learning, "lock", None)  # memory mode: one writer at a time
        with lock if lock is not None else nullcontext():
            session = self._learning.read_session(ctx, session_id)
            if session is None:
                raise AppError(ErrorCode.not_found)
            request = self.parse_events(raw)
            batch = _EventBatch(
                self, ctx, session, self._clock(), self._calendar.learning_date(ctx)
            )
            return batch.run(request.events)

    def complete_session(self, ctx: SessionContext, session_id: UUID) -> CompleteResponse:
        """E22: close the session and report what its acknowledged events came to. Adds no time and
        no completion of the day; repeating the call returns the same summary."""
        lock = getattr(self._learning, "lock", None)
        with lock if lock is not None else nullcontext():
            session = self._learning.read_session(ctx, session_id)
            if session is None:
                raise AppError(ErrorCode.not_found)
            today = self._calendar.learning_date(ctx)
            attempts = self._learning.attempts_for_session(ctx, session_id)
            credited = [
                credited_interval(i.started_at, i.ended_at, i.active_ms)
                for i in self._learning.intervals_for_session(ctx, session_id)
            ]
            computed_ms = session_active_ms(credited)
            completed = session.status == "completed"
            passed, failed = _rounds_outcome(session, attempts)
            summary = CompleteSummary(
                answered=len(attempts),
                correct=sum(1 for a in attempts if a.correct),
                new_passages=self._new_passages(ctx, session, attempts),
                reviews_passed=passed,
                reviews_failed=failed,
                active_ms=session.elapsed_ms if completed else computed_ms,
            )
            if not completed:
                self._learning.complete_session(ctx, session_id, computed_ms)
            daily = daily_progress_dto(
                self._learning, ctx, today, session_minutes=lambda: self._minutes(ctx, session)
            )
            return CompleteResponse(summary=summary, daily=daily)

    def _minutes(self, ctx: SessionContext, session: StoredSession) -> int | None:
        """The plan's session minutes in force, for the goal of a day that has no row yet."""
        if session.plan_id is None:
            return None
        try:
            return self._plans.load_for_session(ctx, session.plan_id).session_minutes
        except AppError as error:
            if error.code is ErrorCode.not_found:
                return None
            raise

    def _new_passages(
        self, ctx: SessionContext, session: StoredSession, attempts: Sequence[AttemptRecord]
    ) -> int:
        """Passages whose first attempt of the account was in this session (API-spec E22). The first
        attempt is the earliest by ``occurredAt``, then ``clientEventId`` (the replay order of
        A-12), so a session replayed late is still the one that introduced its passages."""
        passage_ids = list(dict.fromkeys(a.passage_id for a in attempts))
        if not passage_ids:
            return 0
        first: dict[UUID, AttemptRecord] = {}
        ordered = sorted(
            self._learning.attempts_for_passages(ctx, passage_ids),
            key=lambda a: (a.occurred_at, str(a.client_event_id)),
        )
        for attempt in ordered:
            first.setdefault(attempt.passage_id, attempt)
        return sum(
            1
            for passage_id in passage_ids
            if (found := first.get(passage_id)) is not None and found.session_id == session.id
        )

    # -- E20 -----------------------------------------------------------------------------------

    def parse_request(self, raw: Any) -> SessionRequest:
        """Validate the JSON body (S-1: strict, unknown properties refused). The rule names are
        those of API-spec E20; values are never echoed."""
        try:
            return parse_create_session_request(raw)
        except RequestViolation as violation:
            raise _violation(*violation.fields) from None

    def create_session(self, ctx: SessionContext, request: SessionRequest) -> CreatedSession:
        if isinstance(request, PlacementSessionRequest):
            return self._placement(ctx, request)
        plan = self._plans.load_for_session(ctx, request.plan_id)
        if plan.status == "paused" or (
            plan.status == "completed" and isinstance(request, GameSessionRequest)
        ):
            raise AppError(ErrorCode.version_conflict, details={"reason": "plan_not_active"})
        if request.expected_plan_version != plan.current_version:
            raise AppError(
                ErrorCode.version_conflict,
                details={"reason": "plan_version", "currentVersion": plan.current_version},
            )
        edition = self._bank.edition(ctx, plan.edition_id)
        if edition is None or edition.bank_version != plan.bank_version:
            raise _violation(("planId", "edition_not_available"))
        if isinstance(request, DailySessionRequest):
            return self._daily(ctx, plan, edition)
        return self._game(ctx, request, plan, edition)

    # -- daily ---------------------------------------------------------------------------------

    def _daily(
        self, ctx: SessionContext, plan: PlanSnapshot, edition: EditionInfo
    ) -> CreatedSession:
        learning_date = self._calendar.learning_date(ctx)
        existing = self._learning.find_open_daily(ctx, learning_date)
        if existing is not None:
            if existing.plan_id == plan.plan_id:
                return CreatedSession(self._snapshot(existing), created=False)
            # The open session of another plan can no longer receive events (that plan is not
            # active) but would block this one: the database allows one open daily per date.
            self._learning.mark_completed(ctx, existing.id)
        passages = self._scope_passages(ctx, plan, edition)
        session_id = self._new_id()
        questions = _Questions(
            self._bank, self._learning, ctx, edition, plan.bank_version, with_history=True
        )
        composition = compose_daily(
            DailyInputs(
                learning_date=learning_date,
                session_minutes=plan.session_minutes,
                plan_status="active" if plan.status == "active" else "completed",
                order=plan.order,
                passages=tuple(p.info() for p in passages),
                mastery=self._learning.mastery_for_plan(ctx, plan.plan_id),
                covered_part_ids=self._learning.covered_parts(ctx, plan.plan_id),
                known_passage_ids=plan.known_passage_ids,
                last_active_date=self._learning.last_active_date(ctx, learning_date),
                seed=stable_hash("daily", plan.plan_id, learning_date.isoformat()),
                session_id=session_id,
            ),
            questions.load,
        )
        return self._persist(
            ctx,
            kind="daily",
            session_id=session_id,
            plan=plan,
            edition=edition,
            learning_date=learning_date,
            passages=passages,
            steps=composition.steps,
            questions=questions,
            seed=stable_hash("render", plan.plan_id, learning_date.isoformat()),
            self_rating=None,
        )

    # -- game ----------------------------------------------------------------------------------

    def _game(
        self,
        ctx: SessionContext,
        request: GameSessionRequest,
        plan: PlanSnapshot,
        edition: EditionInfo,
    ) -> CreatedSession:
        learning_date = self._calendar.learning_date(ctx)
        passages = self._scope_passages(ctx, plan, edition)
        by_id = {p.id: p for p in passages}
        if request.passage_ids is None:
            candidates = list(passages)
        else:
            outside = [
                (f"passageIds[{index}]", "out_of_scope")
                for index, passage_id in enumerate(request.passage_ids)
                if passage_id not in by_id
            ]
            if outside:
                raise _violation(*outside)
            candidates = [by_id[pid] for pid in dict.fromkeys(request.passage_ids)]
        session_id = self._new_id()
        questions = _Questions(
            self._bank, self._learning, ctx, edition, plan.bank_version, with_history=True
        )
        planned = compose_game(
            GameInputs(
                passages=tuple(p.info() for p in candidates),
                game_type=request.game_type,
                mastery=self._learning.mastery_for_plan(ctx, plan.plan_id),
                seed=stable_hash("game", session_id),
            ),
            questions.load,
        )
        return self._persist(
            ctx,
            kind="game",
            session_id=session_id,
            plan=plan,
            edition=edition,
            learning_date=learning_date,
            passages=passages,
            steps=planned,
            questions=questions,
            seed=stable_hash("render", session_id),
            self_rating=None,
        )

    # -- placement -----------------------------------------------------------------------------

    def _placement(self, ctx: SessionContext, request: PlacementSessionRequest) -> CreatedSession:
        edition = self._bank.edition(ctx, request.edition_id)
        if edition is None or not edition.selectable:
            raise _violation(("editionId", "edition_not_available"))
        ordinals = request.target_scope.section_ordinals
        if set(self._bank.sections(ctx, edition.edition_id, ordinals)) != set(ordinals):
            raise _violation(("targetScope.sectionOrdinals", "scope_invalid"))
        passages = self._bank.passages(
            ctx,
            edition.edition_id,
            bank_version=edition.bank_version,
            section_ordinals=ordinals,
            paths=edition.default_paths,
        )
        learning_date = self._calendar.learning_date(ctx)
        session_id = self._new_id()
        questions = _Questions(
            self._bank, self._learning, ctx, edition, edition.bank_version, with_history=False
        )
        planned = compose_placement(
            PlacementInputs(
                passages=tuple(p.info() for p in passages),
                seed=stable_hash("placement", session_id),
            ),
            questions.load,
        )
        return self._persist(
            ctx,
            kind="placement",
            session_id=session_id,
            plan=None,
            edition=edition,
            learning_date=learning_date,
            passages=passages,
            steps=planned,
            questions=questions,
            seed=stable_hash("render", session_id),
            self_rating=request.self_rating,
        )

    # -- shared --------------------------------------------------------------------------------

    def _scope_passages(
        self, ctx: SessionContext, plan: PlanSnapshot, edition: EditionInfo
    ) -> list[BankPassage]:
        return self._bank.passages(
            ctx,
            edition.edition_id,
            bank_version=plan.bank_version,
            section_ordinals=plan.section_ordinals,
            paths=plan.paths,
        )

    def _persist(
        self,
        ctx: SessionContext,
        *,
        kind: str,
        session_id: UUID,
        plan: PlanSnapshot | None,
        edition: EditionInfo,
        learning_date: date,
        passages: Sequence[BankPassage],
        steps: Sequence[PlannedStep],
        questions: _Questions,
        seed: int,
        self_rating: str | None,
    ) -> CreatedSession:
        bank_version = plan.bank_version if plan is not None else edition.bank_version
        try:
            rendered = self._render(ctx, edition, passages, steps, questions, seed)
        except (KeyError, IndexError, ValueError):
            raise _integrity() from None  # the bank or its units do not hold what a step needs
        learn_ids = [s.passage.passage_id for s in rendered if isinstance(s, LearnStep)]
        lessons = (
            self._bank.lessons(
                ctx, edition.edition_id, bank_version=bank_version, passage_ids=learn_ids
            )
            if learn_ids
            else {}
        )
        new = NewSession(
            session_id=session_id,
            kind=kind,
            plan_id=None if plan is None else plan.plan_id,
            plan_version_id=None if plan is None else plan.plan_version_id,
            plan_version=None if plan is None else plan.current_version,
            edition_id=edition.edition_id,
            learning_date=learning_date,
            lesson_refs=tuple(lessons[pid] for pid in learn_ids if pid in lessons),
            question_refs=tuple(
                s.question.question_id for s in rendered if isinstance(s, QuestionStep)
            ),
            steps=_STEPS.dump_python(list(rendered), mode="json", by_alias=True),
            bank_version=bank_version,
            created_at=self._clock(),
            self_rating=self_rating,
        )
        try:
            opened = self._learning.open_session(ctx, new)
        except AppError as error:
            if error.code is ErrorCode.version_conflict and plan is not None:
                latest = self._plans.load_for_session(ctx, plan.plan_id)
                raise AppError(
                    ErrorCode.version_conflict,
                    details={"reason": "plan_version", "currentVersion": latest.current_version},
                ) from None
            raise
        stored = self._learning.read_session(ctx, opened.session_id)
        if stored is None:
            raise AppError(ErrorCode.unavailable)
        if not opened.created and (plan is None or stored.plan_id != plan.plan_id):
            raise AppError(ErrorCode.unavailable)  # lost a race to another plan's session
        return CreatedSession(self._snapshot(stored), created=opened.created)

    def _snapshot(self, stored: StoredSession) -> SessionSnapshot:
        """The response, always built from the stored row: a repeated call returns the same."""
        try:
            return SessionSnapshot(
                session_id=stored.id,
                kind=stored.kind,  # type: ignore[arg-type]
                plan_id=stored.plan_id,
                plan_version=stored.plan_version,
                edition_id=stored.edition_id,
                bank_version=stored.bank_version,
                learning_date=stored.learning_date,
                status=stored.status,  # type: ignore[arg-type]
                steps=_STEPS.validate_python(stored.steps),
                created_at=stored.created_at,
            )
        except ValueError:
            raise _integrity() from None

    # -- rendering -----------------------------------------------------------------------------

    def _render(
        self,
        ctx: SessionContext,
        edition: EditionInfo,
        passages: Sequence[BankPassage],
        steps: Sequence[PlannedStep],
        questions: _Questions,
        seed: int,
    ) -> list[LearnStep | QuestionStep]:
        by_id = {p.id: p for p in passages}
        learn = [by_id[s.passage_id] for s in steps if isinstance(s, PlannedLearn)]
        asked = [questions.by_id[s.question_id] for s in steps if isinstance(s, PlannedQuestion)]
        units = _Units(self._bank, ctx, edition)
        units.load_section_units(p.section_ordinal for p in learn)
        units.load_section_meta(by_id[q.passage_id].section_ordinal for q in asked)
        units.load_units(ordinal for question in asked for ordinal in _question_ordinals(question))
        rendered: list[LearnStep | QuestionStep] = []
        for step in steps:
            if isinstance(step, PlannedLearn):
                rendered.append(
                    LearnStep(
                        type="learn",
                        passage=self._passage_view(edition, by_id[step.passage_id], units),
                    )
                )
            else:
                bank_question = questions.by_id[step.question_id]
                section = units.sections.get(by_id[step.passage_id].section_ordinal)
                rendered.append(
                    QuestionStep(
                        type="question",
                        question=self._question(edition, step, bank_question, section, units, seed),
                    )
                )
        return rendered

    @staticmethod
    def _source(edition: EditionInfo, reference: str, url: str) -> SourceRef:
        return SourceRef(
            publisher=edition.source_title,
            edition_label=edition.edition_label,
            book_title_ar=edition.book_title_ar,
            reference=reference,
            url=url,
            pages=[],
        )

    def passage_views(
        self, ctx: SessionContext, edition: EditionInfo, passages: Sequence[BankPassage]
    ) -> list[PassageView]:
        """The verbatim lesson view of passages, rendered without composing or storing a session
        (package B9 puts them in an offline snapshot). A bank that lacks a unit the passage spans
        is an integrity problem (``internal``)."""
        units = _Units(self._bank, ctx, edition)
        try:
            units.load_section_units(p.section_ordinal for p in passages)
            return [self._passage_view(edition, passage, units) for passage in passages]
        except (KeyError, IndexError, ValueError):
            raise _integrity() from None

    def _passage_view(
        self, edition: EditionInfo, passage: BankPassage, units: _Units
    ) -> PassageView:
        first, _ = _ref_key(passage.start_ref)
        last, _ = _ref_key(passage.end_ref)
        spanned = [units.unit(ordinal) for ordinal in range(first, last + 1)]
        section = units.sections.get(passage.section_ordinal)
        siblings = units.by_section[passage.section_ordinal]
        takhrij = next((u.text for u in siblings if u.kind == "hadith_takhrij"), None)
        grade = next((u.text for u in siblings if u.kind == "hadith_grade"), None)
        meta = next(
            (u.hadith_meta for u in siblings if u.kind == "hadith_narration" and u.hadith_meta),
            next((u.hadith_meta for u in siblings if u.hadith_meta), None),
        )
        return PassageView(
            passage_id=passage.id,
            path=passage.path,  # type: ignore[arg-type]
            reference=passage.reference,
            section_title_ar=section.title_ar if section is not None else "",
            units=[
                PassageUnit(
                    unit_ref=unit.ordinal,
                    kind=unit.kind,  # type: ignore[arg-type]
                    reference=unit.reference,
                    text=unit.text,
                )
                for unit in spanned
            ],
            highlight=Highlight(start_ref=passage.start_ref, end_ref=passage.end_ref),
            takhrij=takhrij,
            grade=grade,
            show_d50_notice=bool(meta.get("showD50Notice")) if meta else False,
            source=self._source(edition, passage.reference, units.source_url(first, section)),
        )

    def _question(
        self,
        edition: EditionInfo,
        planned: PlannedQuestion,
        question: BankQuestion,
        section: BankSection | None,
        units: _Units,
        seed: int,
    ) -> QuestionDto:
        target = sorted(_ref_key(ref) for ref in question.token_refs)
        low, high = target[0], target[-1]
        shown = [TokenView(ref=ref, text=units.surface(ref)) for ref in question.context_refs]
        context = QuestionContext(
            before=[t for t in shown if _ref_key(t.ref) < low],
            after=[t for t in shown if _ref_key(t.ref) > high],
        )
        common: dict[str, Any] = {
            "question_id": question.id,
            "passage_id": question.passage_id,
            "role": planned.role,
            "review_round_id": planned.review_round_id,
            "context": context,
            "policy": QuestionPolicy(),
            "source": self._source(
                edition, question.reference, units.source_url(question.token_refs[0], section)
            ),
        }
        kind = question.type
        if kind == WORD_ORDER:
            tokens = [TokenView(ref=ref, text=units.surface(ref)) for ref in question.token_refs]
            mixed = _shuffled(tokens, lambda t: t.ref, seed, question.id)
            if len(tokens) > 1 and [t.ref for t in mixed] == list(question.token_refs):
                mixed = mixed[1:] + mixed[:1]  # a shuffle that shows the answer is no shuffle
            return WordOrderQuestion(
                **{**common, "context": QuestionContext()},
                type="word_order",
                tokens=mixed,
                answer_key=OrderAnswerKey(order=list(question.token_refs)),
            )
        if kind in (WORD_CHOICE, SIMILAR_DISTINCTION):
            if question.option_refs is None or question.correct_ref not in question.option_refs:
                raise ValueError("a choice question needs its correct option among the options")
            options = [
                ChoiceOption(option_id=option_id_for_refs(refs), text=units.text_of(refs))
                for refs in question.option_refs
            ]
            mixed_options = _shuffled(options, lambda o: o.option_id, seed, question.id)
            answer = OptionAnswerKey(option_id=option_id_for_refs(question.correct_ref))
            if kind == WORD_CHOICE:
                if question.variant not in ("word", "segment"):
                    raise ValueError("a word-choice question has the word or segment variant")
                return WordChoiceQuestion(
                    **common,
                    type="word_choice",
                    variant=question.variant,  # type: ignore[arg-type]
                    options=mixed_options,
                    answer_key=answer,
                )
            return SimilarQuestion(
                **common, type="similar_distinction", options=mixed_options, answer_key=answer
            )
        if kind == WORD_RECALL:
            unit_ordinal, index = _ref_key(question.token_refs[0])
            token = units.unit(unit_ordinal).token(index)
            norms = [token.n] + ([token.a] if token.a and token.a != token.n else [])
            return RecallQuestion(
                **common,
                type="word_recall",
                hint_first_letter=token.n[0],
                answer_key=RecallAnswerKey(accepted_norms=norms),
            )
        raise ValueError("unknown question type")


# --- E21 and E22 helpers -------------------------------------------------------------------------


def daily_progress_dto(
    learning: LearningRepository,
    ctx: SessionContext,
    today: date,
    *,
    session_minutes: Callable[[], int | None],
) -> DailyProgress:
    """The ``DailyProgress`` of ``today`` from the stored row and the single completion (D40). The
    goal is the one the row was created with (D57); ``session_minutes`` is asked only when the day
    has no row yet."""
    rows = learning.daily_progress_between(ctx, today, today)
    row = rows[0] if rows else None
    completed = today in learning.completion_dates(ctx, today, today)
    goal = (
        row.goal_ms
        if row is not None and row.goal_ms > 0
        else resolve_goal_ms(None, session_minutes())
    )
    summary = summarize_day(
        today, row.active_ms if row is not None else 0, goal, completed=completed
    )
    return DailyProgress(
        learning_date=today,
        daily_active_ms=summary.active_ms,
        daily_goal_ms=summary.goal_ms,
        daily_percent=summary.percent,
        daily_completed=summary.completed,
        extra_active_ms=summary.extra_ms,
    )


def _question_steps(session: StoredSession) -> dict[UUID, dict[str, Any]]:
    """The question steps of the immutable snapshot by question id (S-3)."""
    found: dict[UUID, dict[str, Any]] = {}
    try:
        for step in session.steps:
            if step.get("type") == "question":
                question = step["question"]
                found[UUID(str(question["questionId"]))] = question
    except (KeyError, TypeError, ValueError, AttributeError):
        raise _integrity() from None
    return found


def _first_attempts(attempts: Sequence[AttemptRecord]) -> dict[UUID, AttemptRecord]:
    """The first attempt of every question: the oldest by receipt time, then by the client's own
    time and id (the rows of one request share the receipt time)."""
    first: dict[UUID, AttemptRecord] = {}
    for attempt in sorted(
        attempts, key=lambda a: (a.created_at, a.occurred_at, str(a.client_event_id))
    ):
        first.setdefault(attempt.question_id, attempt)
    return first


def _rounds_outcome(session: StoredSession, attempts: Sequence[AttemptRecord]) -> tuple[int, int]:
    """``(passed, failed)`` review rounds of the session: a round counts once every one of its
    questions has its first attempt (an unfinished round is not evaluated)."""
    members: dict[UUID, list[UUID]] = defaultdict(list)
    for question_id, question in _question_steps(session).items():
        if question.get("role") == ROLE_REVIEW and question.get("reviewRoundId") is not None:
            members[UUID(str(question["reviewRoundId"]))].append(question_id)
    first = _first_attempts(attempts)
    passed = failed = 0
    for question_ids in members.values():
        if not round_is_complete(question_ids, first):
            continue
        answers = [RoundAnswer(q, first[q].correct, first[q].assisted, ()) for q in question_ids]
        if summarize_round(answers).passed:
            passed += 1
        else:
            failed += 1
    return passed, failed


def _wrong_token_ref(evaluation: ValidatedAttempt) -> str | None:
    """The first token reference of the option a learner picked wrongly in a choice game (D31);
    never the text of a recall answer."""
    if evaluation.correct or evaluation.chosen_option_id is None:
        return None
    try:
        return refs_for_option_id(evaluation.chosen_option_id)[0]
    except ValueError:
        return None


class _once:
    """A per-instance memo like ``functools.cached_property`` without its lock. In Python 3.11 that
    decorator holds one lock for the property across every instance, so two requests that ran at the
    same time waited for each other's database calls. A batch belongs to one request and one thread,
    so it needs no lock."""

    def __init__(self, getter: Callable[[Any], Any]) -> None:
        self._getter = getter
        self._name = getter.__name__

    def __set_name__(self, owner: type, name: str) -> None:
        self._name = name

    def __get__(self, instance: Any, owner: type | None = None) -> Any:
        if instance is None:
            return self
        value = self._getter(instance)
        instance.__dict__[self._name] = value
        return value


@dataclass(slots=True)
class _Outcome:
    """What one event came to: ``acknowledged``, ``duplicate``, ``pending`` or ``rejected``.
    ``code`` is the ``reasonCode`` or the rejection code. ``write_index`` points at the element sent
    to the repository, so that a ``duplicate`` reported by the database overrules the
    acknowledgment (two requests that share an id)."""

    kind: str
    code: str | None = None
    result: AnswerResult | None = None
    write_index: int | None = None


class _EventBatch:
    """One E21 request. Everything the batch changes is worked out in memory, event by event in
    array order, so a later event sees the effect of an earlier one (the streak, the evidence, a
    round that just completed); then one call persists it. Collaborators load lazily: a batch of
    duplicates reads almost nothing."""

    def __init__(
        self,
        service: SessionService,
        ctx: SessionContext,
        session: StoredSession,
        now: datetime,
        today: date,
    ) -> None:
        self._service = service
        self._ctx = ctx
        self._session = session
        self._now = now
        self._today = today
        self._learning = service.learning
        self._bank = service.bank
        self._questions = _question_steps(session)
        self._round_members: dict[UUID, list[UUID]] = defaultdict(list)
        for question_id, question in self._questions.items():
            if question.get("reviewRoundId") is not None:
                self._round_members[UUID(str(question["reviewRoundId"]))].append(question_id)
        self._ledger = AcknowledgedIds()
        self._writes: list[EventWrite] = []
        self._new_intervals: dict[date, list[Interval]] = defaultdict(list)
        self._attempt_counts: Counter[UUID] = Counter()
        self._prior: list[AttemptRecord] | None = None
        self._round_cache: dict[UUID, dict[UUID, RoundAnswer]] = {}
        self._bank_questions: dict[UUID, BankQuestion] = {}
        self._loaded_passages: set[UUID] = set()
        self._units: dict[int, BankUnit] = {}

    # -- lazy collaborators ---------------------------------------------------------------------

    @_once
    def _plan(self) -> PlanSnapshot | None:
        if self._session.plan_id is None:
            return None
        return self._service.plans.load_for_session(self._ctx, self._session.plan_id)

    @_once
    def _edition(self) -> EditionInfo | None:
        return self._bank.edition(self._ctx, self._session.edition_id)

    @_once
    def _scope(self) -> dict[UUID, BankPassage]:
        plan = self._plan
        if plan is None:
            return {}
        passages = self._bank.passages(
            self._ctx,
            self._session.edition_id,
            bank_version=self._session.bank_version,
            section_ordinals=plan.section_ordinals,
            paths=plan.paths,
        )
        return {passage.id: passage for passage in passages}

    @_once
    def _mastery(self) -> dict[UUID, PassageMastery]:
        assert self._plan is not None
        return dict(self._learning.mastery_for_plan(self._ctx, self._plan.plan_id))

    @_once
    def _covered(self) -> set[UUID]:
        assert self._plan is not None
        return set(self._learning.covered_parts(self._ctx, self._plan.plan_id))

    def _prior_attempts(self) -> list[AttemptRecord]:
        if self._prior is None:
            self._prior = self._learning.attempts_for_session(self._ctx, self._session.id)
            self._attempt_counts.update(a.question_id for a in self._prior)
        return self._prior

    def _bank_question(self, passage_id: UUID, question_id: UUID) -> BankQuestion | None:
        if passage_id not in self._loaded_passages:
            for question in self._bank.questions(
                self._ctx,
                self._session.edition_id,
                bank_version=self._session.bank_version,
                passage_ids=[passage_id],
            ):
                self._bank_questions[question.id] = question
            self._loaded_passages.add(passage_id)
        return self._bank_questions.get(question_id)

    def _target_word(self, question: BankQuestion) -> str | None:
        """The verbatim text of a recall question's target word (shown as the original)."""
        try:
            ordinal, index = _ref_key(question.token_refs[0])
            unit = self._units.get(ordinal)
            if unit is None:
                unit = self._bank.units(self._ctx, self._session.edition_id, [ordinal]).get(ordinal)
                if unit is None:
                    return None
                self._units[ordinal] = unit
            return unit.surface(index)
        except (IndexError, ValueError):
            return None

    # -- the request ------------------------------------------------------------------------------

    def run(self, events: Sequence[Any]) -> EventsResponse:
        ids = [event.client_event_id for event in events]
        self._ledger = AcknowledgedIds(self._learning.acknowledged_event_ids(self._ctx, ids))
        outcomes = [self._event(event) for event in events]
        self._persist(outcomes)
        return self._response(events, outcomes)

    def _event(self, event: AnswerEvent | ActivityEvent) -> _Outcome:
        session = self._session
        if self._ledger.is_duplicate(event.client_event_id):
            return _Outcome("duplicate")
        if session.status == "completed":
            return _Outcome("rejected", "session_closed")
        if self._edition is None:
            return _Outcome("rejected", "edition_mismatch")
        envelope = event.envelope()
        if envelope is None and session.status == "prepared":
            # An online event needs an open session (API-spec E21 step 4). A prepared session is
            # opened by the replay of its run, and a replay carries the offline envelope.
            return _Outcome("rejected", "envelope_mismatch")
        if envelope is not None:
            if not self._envelope_matches(envelope):
                return _Outcome("rejected", "envelope_mismatch")
            plan = self._plan
            if plan is not None and plan.current_version != session.plan_version:
                return _Outcome("pending", "plan_changed_unverifiable")
        elif self._plan is not None and self._plan.status == "paused":
            return _Outcome("rejected", "plan_not_active")
        if isinstance(event, ActivityEvent):
            return self._activity(event)
        return self._answer(event, envelope)

    def _envelope_matches(self, envelope: OfflineEnvelope) -> bool:
        """The replay envelope against the session's pinned values (API-spec S-10)."""
        session = self._session
        return (
            envelope.protocol_version == 1
            and session.offline_snapshot_id is not None
            and envelope.snapshot_id == session.offline_snapshot_id
            and envelope.edition_id == session.edition_id
            and envelope.bank_version == session.bank_version
            and session.plan_version is not None
            and envelope.plan_version == session.plan_version
        )

    # -- activity ---------------------------------------------------------------------------------

    @_once
    def _zone(self) -> LearningZoneLike | None:
        lookup = getattr(self._service.calendar, "learning_zone", None)
        return lookup(self._ctx) if callable(lookup) else None

    def _activity_date(self, started_at: datetime) -> date:
        zone = self._zone
        if zone is None:
            return self._session.learning_date
        try:
            return learning_date_at(
                started_at, zone.time_zone, zone.pending_time_zone, zone.pending_effective
            )
        except ValueError:  # an unknown zone name in the profile
            raise AppError(ErrorCode.internal) from None

    def _activity(self, event: ActivityEvent) -> _Outcome:
        verdict = validate_activity(
            started_at=event.started_at,
            ended_at=event.ended_at,
            active_ms=event.active_ms,
            server_now=self._now,
            session_created_at=self._session.created_at,
            session_kind=self._session.kind,
            learning_date=self._activity_date(event.started_at),
        )
        if isinstance(verdict, ActivityRejected):
            return _Outcome("rejected", "activity_out_of_bounds")
        self._ledger.acknowledge(event.client_event_id)
        if isinstance(verdict, ActivityIgnored):
            return _Outcome("acknowledged")  # a placement session: acknowledged, never counted
        self._writes.append(
            IntervalWrite(
                client_event_id=event.client_event_id,
                started_at=event.started_at,
                ended_at=event.ended_at,
                active_ms=event.active_ms,
                learning_date=verdict.learning_date,
            )
        )
        self._new_intervals[verdict.learning_date].append(verdict.interval)
        return _Outcome("acknowledged", write_index=len(self._writes) - 1)

    # -- answers ----------------------------------------------------------------------------------

    def _answer(self, event: AnswerEvent, envelope: OfflineEnvelope | None) -> _Outcome:
        question = self._questions.get(event.question_id)
        if question is None:
            return _Outcome("rejected", "question_not_in_session")
        try:
            key = key_from_question(question)
            passage_id = UUID(str(question["passageId"]))
            role = str(question["role"])
            round_id = (
                None
                if question.get("reviewRoundId") is None
                else UUID(str(question["reviewRoundId"]))
            )
            policy = question.get("policy") or {}
        except (KeyError, TypeError, ValueError, AttributeError):
            raise _integrity() from None
        if envelope is not None:
            normalization = envelope.normalization_policy_version
            scoring = envelope.scoring_policy_version
        else:
            normalization = policy.get("normalizationPolicyVersion")
            scoring = policy.get("scoringPolicyVersion")
        evaluation = evaluate_answer(
            key,
            event.answer.model_dump(by_alias=True),
            hint_used=event.hint_used,
            normalization_policy=normalization,
            scoring_policy=scoring,
        )
        if isinstance(evaluation, RejectedAnswer):
            return _Outcome("rejected", "invalid_answer_shape")
        if isinstance(evaluation, GradingUnavailable):
            return _Outcome("pending", "policy_unsupported")
        self._prior_attempts()
        if self._session.kind == "placement":
            return self._placement_answer(event, evaluation, passage_id, round_id, key.type)
        return self._plan_answer(event, evaluation, passage_id, role, round_id)

    def _write_attempt(
        self,
        event: AnswerEvent,
        evaluation: ValidatedAttempt,
        passage_id: UUID,
        round_id: UUID | None,
        mastery: PassageMastery | None,
        evidence: tuple[EvidenceWrite, ...],
    ) -> int:
        self._writes.append(
            AttemptWrite(
                client_event_id=event.client_event_id,
                question_id=event.question_id,
                passage_id=passage_id,
                correct=evaluation.correct,
                assisted=evaluation.assisted,
                error_kind=evaluation.error_kind,
                duration_ms=event.duration_ms,
                occurred_at=event.occurred_at,
                wrong_token_ref=_wrong_token_ref(evaluation),
                review_round_id=round_id,
                mastery=mastery,
                evidence=evidence,
            )
        )
        self._attempt_counts[event.question_id] += 1
        self._ledger.acknowledge(event.client_event_id)
        return len(self._writes) - 1

    def _expected(
        self, evaluation: ValidatedAttempt, question: BankQuestion | None
    ) -> AnswerExpected | None:
        if evaluation.expected_order is not None:
            return AnswerExpected(order=list(evaluation.expected_order))
        if evaluation.expected_option_id is not None:
            return AnswerExpected(option_id=evaluation.expected_option_id)
        word = None if question is None else self._target_word(question)
        return None if word is None else AnswerExpected(word=word)

    def _placement_answer(
        self,
        event: AnswerEvent,
        evaluation: ValidatedAttempt,
        passage_id: UUID,
        round_id: UUID | None,
        question_type: str,
    ) -> _Outcome:
        """A placement attempt is recorded for the estimate and gives no mastery credit."""
        bank_question = (
            self._bank_question(passage_id, event.question_id)
            if question_type == WORD_RECALL
            else None
        )
        expected = self._expected(evaluation, bank_question)
        if expected is None:
            return _Outcome("pending", "content_unverifiable")
        index = self._write_attempt(event, evaluation, passage_id, round_id, None, ())
        result = AnswerResult(
            client_event_id=event.client_event_id,
            question_id=event.question_id,
            correct=evaluation.correct,
            assisted=evaluation.assisted,
            expected=expected,
            passage=AnswerPassageState(
                passage_id=passage_id,
                status="new",
                covered_parts=0,
                total_parts=0,
                consecutive_correct=0,
            ),
        )
        return _Outcome("acknowledged", result=result, write_index=index)

    def _plan_answer(
        self,
        event: AnswerEvent,
        evaluation: ValidatedAttempt,
        passage_id: UUID,
        role: str,
        round_id: UUID | None,
    ) -> _Outcome:
        plan, session = self._plan, self._session
        assert plan is not None
        if not self._scope:
            return _Outcome("pending", "content_unverifiable")
        passage = self._scope.get(passage_id)
        if passage is None:
            return _Outcome("rejected", "out_of_scope")
        bank_question = self._bank_question(passage_id, event.question_id)
        expected = self._expected(evaluation, bank_question)
        if bank_question is None or expected is None:
            return _Outcome("pending", "content_unverifiable")
        part_ids = tuple(part.id for part in passage.parts)
        before = self._mastery.get(passage_id) or PassageMastery(
            plan_id=plan.plan_id, passage_id=passage_id
        )
        after, evidence = before, ()
        counts = attempt_counts_for_mastery(role, self._attempt_counts[event.question_id])
        if counts:
            effect = advance_target_streak(
                before,
                evaluation,
                question_part_ids=bank_question.covered_part_ids,
                passage_part_ids=part_ids,
                covered_part_ids=self._covered,
                learning_date=session.learning_date,
                now=self._now,
            )
            after = effect.state
            self._covered.update(effect.new_evidence_part_ids)
            evidence = tuple(
                EvidenceWrite(plan.plan_id, passage_id, part, session.learning_date)
                for part in effect.new_evidence_part_ids
            )
            if role == ROLE_REVIEW and round_id is not None:
                after = self._round(
                    round_id,
                    event.question_id,
                    evaluation,
                    bank_question,
                    passage_id,
                    after,
                    part_ids,
                )
            self._mastery[passage_id] = after
        index = self._write_attempt(
            event, evaluation, passage_id, round_id, after if counts else None, evidence
        )
        covered_parts, total_parts = coverage_counts(part_ids, self._covered)
        result = AnswerResult(
            client_event_id=event.client_event_id,
            question_id=event.question_id,
            correct=evaluation.correct,
            assisted=evaluation.assisted,
            expected=expected,
            passage=AnswerPassageState(
                passage_id=passage_id,
                status=after.status,  # type: ignore[arg-type]
                covered_parts=covered_parts,
                total_parts=total_parts,
                consecutive_correct=after.consecutive_correct,
            ),
        )
        return _Outcome("acknowledged", result=result, write_index=index)

    def _round(
        self,
        round_id: UUID,
        question_id: UUID,
        evaluation: ValidatedAttempt,
        bank_question: BankQuestion,
        passage_id: UUID,
        state: PassageMastery,
        part_ids: tuple[UUID, ...],
    ) -> PassageMastery:
        """Record the first attempt of a round question and, when it was the last one missing,
        evaluate the round and move the ladder (API-spec E21 step 5)."""
        answers = self._round_answers(round_id, passage_id)
        answers[question_id] = RoundAnswer(
            question_id, evaluation.correct, evaluation.assisted, bank_question.covered_part_ids
        )
        members = self._round_members[round_id]
        if not round_is_complete(members, answers):
            return state
        return apply_round(
            state,
            summarize_round(answers[member] for member in members),
            passage_part_ids=part_ids,
            covered_part_ids=self._covered,
            review_date=self._session.learning_date,
            now=self._now,
        )

    def _round_answers(self, round_id: UUID, passage_id: UUID) -> dict[UUID, RoundAnswer]:
        """The first attempts already recorded for the round, read once per request."""
        cached = self._round_cache.get(round_id)
        if cached is not None:
            return cached
        recorded = [a for a in self._prior_attempts() if a.review_round_id == round_id]
        found: dict[UUID, RoundAnswer] = {}
        for question_id, attempt in _first_attempts(recorded).items():
            bank_question = self._bank_question(passage_id, question_id)
            parts = () if bank_question is None else bank_question.covered_part_ids
            found[question_id] = RoundAnswer(question_id, attempt.correct, attempt.assisted, parts)
        self._round_cache[round_id] = found
        return found

    # -- persistence and answer -------------------------------------------------------------------

    def _daily_writes(self) -> list[DailyWrite]:
        """One ``daily_progress`` write per learning date that gained an interval: the union of the
        stored intervals of the date and the new ones, never less than the stored figure."""
        plan = self._plan
        found: list[DailyWrite] = []
        for day, fresh in sorted(self._new_intervals.items()):
            rows = self._learning.daily_progress_between(self._ctx, day, day)
            row = rows[0] if rows else None
            stored = [
                credited_interval(i.started_at, i.ended_at, i.active_ms)
                for i in self._learning.intervals_for_date(self._ctx, day)
            ]
            active = max(union_ms([*stored, *fresh]), row.active_ms if row is not None else 0)
            goal = resolve_goal_ms(
                row.goal_ms if row is not None else None,
                plan.session_minutes if plan is not None else None,
            )
            if goal <= 0 or plan is None:
                continue  # no goal, no day to write (cannot happen for a plan session)
            reached = should_record_completion(active, goal, already_completed=False)
            found.append(DailyWrite(day, active, goal, reached, plan.plan_id if reached else None))
        return found

    def _persist(self, outcomes: list[_Outcome]) -> None:
        session = self._session
        opens = session.status == "prepared" and any(o.kind == "acknowledged" for o in outcomes)
        dailies = self._daily_writes()
        if not self._writes and not opens and not dailies:
            return
        first = dailies[-1] if dailies else None  # the latest date goes with the events
        result = self._learning.apply_events(
            self._ctx, session.id, self._writes, first, open_session=opens
        )
        for other in dailies[:-1]:
            self._learning.apply_events(self._ctx, session.id, [], other, open_session=False)
        for outcome in outcomes:
            if (
                outcome.write_index is not None
                and result.outcomes[outcome.write_index] == "duplicate"
            ):
                outcome.kind, outcome.result = (
                    "duplicate",
                    None,
                )  # another request recorded it first

    def _response(self, events: Sequence[Any], outcomes: list[_Outcome]) -> EventsResponse:
        def of(kind: str) -> list[tuple[Any, _Outcome]]:
            return [(e, o) for e, o in zip(events, outcomes, strict=True) if o.kind == kind]

        daily = daily_progress_dto(
            self._learning,
            self._ctx,
            self._today,
            session_minutes=lambda: self._plan.session_minutes if self._plan else None,
        )
        return EventsResponse(
            acknowledged=[e.client_event_id for e, _ in of("acknowledged")],
            duplicate=[e.client_event_id for e, _ in of("duplicate")],
            pending=[
                PendingEvent(client_event_id=e.client_event_id, reason_code=o.code)  # type: ignore[arg-type]
                for e, o in of("pending")
            ],
            rejected=[
                RejectedEvent(client_event_id=e.client_event_id, code=o.code)  # type: ignore[arg-type]
                for e, o in of("rejected")
            ],
            results=[o.result for _, o in of("acknowledged") if o.result is not None],
            daily=daily,
        )


# --- wiring --------------------------------------------------------------------------------------


def build_sessions_service(
    settings: Settings,
    *,
    plans: PlanAccess | None = None,
    calendar: LearningCalendar | None = None,
    bank: BankRepository | None = None,
    learning: LearningRepository | None = None,
    client: PostgrestClient | None = None,
    clock: Callable[[], datetime] | None = None,
    new_id: Callable[[], UUID] | None = None,
) -> SessionService | None:
    """The service over the repositories of the configured data backend. ``None`` in supabase mode
    without a ``client`` or repositories (the endpoint answers ``503``). Unbound ports answer
    ``503 unavailable`` (nothing is faked)."""
    memory = settings.QATRA_DATA_BACKEND == "memory"
    if bank is None:
        if memory:
            bank = InMemoryBankRepository.from_settings(settings)
        elif client is not None:
            bank = PostgrestBankRepository(client)
        else:
            return None
    if learning is None:
        if memory:
            learning = InMemoryLearningStore()
        elif client is not None:
            learning = PostgrestLearningRepository(client)
        else:
            return None
    return SessionService(
        bank=bank,
        learning=learning,
        plans=_UnboundPlans() if plans is None else plans,
        calendar=_UnboundCalendar() if calendar is None else calendar,
        clock=clock,
        new_id=new_id,
    )
