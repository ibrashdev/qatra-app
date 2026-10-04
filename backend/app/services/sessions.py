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
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal, Protocol, TypeVar
from uuid import UUID

from pydantic import TypeAdapter

from app.config import Settings
from app.contracts_sessions import (
    ChoiceOption,
    DailySessionRequest,
    GameSessionRequest,
    Highlight,
    LearnStep,
    OptionAnswerKey,
    OrderAnswerKey,
    PassageUnit,
    PassageView,
    PlacementSessionRequest,
    QuestionContext,
    QuestionPolicy,
    QuestionStep,
    RecallAnswerKey,
    RecallQuestion,
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
)
from app.contracts_sessions import Question as QuestionDto
from app.dependencies import SessionContext
from app.domain.answer_policy import (
    SIMILAR_DISTINCTION,
    WORD_CHOICE,
    WORD_ORDER,
    WORD_RECALL,
)
from app.domain.session_policy import (
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
    InMemoryLearningStore,
    LearningRepository,
    NewSession,
    PostgrestLearningRepository,
    StoredSession,
)
from app.workflow.bundle_index import parse_ref

T = TypeVar("T")

_STEPS = TypeAdapter(list[Step])


# --- ports ----------------------------------------------------------------------------------------


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


# --- helpers --------------------------------------------------------------------------------------


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


# --- the service ----------------------------------------------------------------------------------


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


# --- wiring ---------------------------------------------------------------------------------------


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
