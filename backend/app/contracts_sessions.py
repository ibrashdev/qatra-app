"""DTOs of the today, progress and session endpoints E18-E22 (Implementation-contract §7,
API-spec §4.6-§4.7). Package B5 implements E20 only; B6 builds E18, E19, E21 and E22 on these.

This module is pure pydantic (no FastAPI, Starlette or database client), like
``contracts_plan_chat``, whose camelCase base classes and shared types (``Path``, ``Plan``,
``TargetScope``) it reuses. JSON names are camelCase; Python names are snake_case. Responses are
built by field name and serialized by alias; request models accept the camelCase names only,
forbid unknown properties (API-spec S-1) and use strict integers.

Deviations from the TypeScript of contract §7, all additive and listed here once:

- ``PassageView.units[].kind`` also allows ``hadith_grade``: a ``grade`` passage lies inside the
  ``hadith_grade`` unit, which the contract's ``'ayah' | 'hadith_narration'`` cannot express.
- ``OfflineEnvelope`` fields are plain ``int``/``str`` rather than literals: API-spec S-10 says a
  wrong ``protocolVersion`` is a per-event ``envelope_mismatch`` and an unsupported policy version
  makes grading unavailable (``pending``), neither of which may fail the whole request with 422.
- Option ids of the choice questions encode their token references (``"2:0,2:1"``), see
  ``option_id_for_refs``; the contract only says ``optionId: string``.
- D90 (owner approvals of 5 Oct 2026): every question's ``context`` carries the WHOLE passage around
  the blank (``before`` and ``after`` hold every token of the passage outside the target, for every
  question type, word order included), with the ayah ends of a Quran passage as structured
  ``ayahEnds`` (never inside a token's text). ``SourceRef.referenceAr`` and
  ``PassageView.referenceAr`` are the learner-facing reference (the hadith title, or the surah and
  the ayah range); both default to ``""`` so a session stored before D90 still validates.
- ``AnswerEvent.durationMs`` is bounded by 30 minutes (API-spec E21 field table, A-12 [O-22]); the
  contract's ``number`` does not say so. A larger value fails the whole request with 422
  (``less_than_equal``): the spec has no per-event code for it. The bounds of an activity event
  are per-event decisions (``activity_out_of_bounds``), so ``ActivityEvent.activeMs`` has no
  schema bound.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    Field,
    ValidationError,
    field_validator,
    model_serializer,
    model_validator,
)
from pydantic_core import PydanticCustomError

from app.contracts_plan_chat import CamelModel, Path, Plan, RequestModel
from app.domain.answer_policy import GAME_TYPES
from app.domain.time_policy import MAX_EVENT_MS

# --- vocabularies ---------------------------------------------------------------------------------

GameType = Literal["word_order", "word_choice", "word_recall", "similar_distinction"]
SessionKind = Literal["daily", "game", "placement"]
SessionStatus = Literal["prepared", "open", "completed"]
QuestionRole = Literal["training", "review", "test", "placement", "game"]
SelfRating = Literal["none", "some", "most"]
MasteryStatus = Literal["new", "learning", "reviewing", "confirmed", "needs_refresh"]
UnitKind = Literal["ayah", "hadith_narration", "hadith_grade"]
RejectedCode = Literal[
    "question_not_in_session",
    "out_of_scope",
    "edition_mismatch",
    "bank_version_mismatch",
    "invalid_answer_shape",
    "activity_out_of_bounds",
    "plan_not_active",
    "session_closed",
    "envelope_mismatch",
]
PendingReason = Literal[
    "plan_changed_unverifiable",
    "content_unverifiable",
    "policy_unsupported",
    "clock_unverifiable",
]

SELF_RATINGS: tuple[str, ...] = ("none", "some", "most")
MAX_SCOPE_ORDINALS = 60  # API-spec §1.7 (A-12)
MAX_PASSAGE_IDS = 60
MAX_EVENTS = 100
NORMALIZATION_POLICY_VERSION = "arabic-norm-v1"
SCORING_POLICY_VERSION = "v1"

_TOKEN_REF = re.compile(r"^\d+:\d+$")


def option_id_for_refs(refs: Sequence[str]) -> str:
    """The option id of a choice option: its token references joined by commas (``"2:0,2:1"``).

    The id is stable, needs no lookup to resolve and carries nothing the ``answerKey`` does not
    already give the client, so the server can derive ``attempts.wrong_token_ref`` from the option
    a learner picked without consulting the bank.
    """
    if not refs or not all(_TOKEN_REF.match(ref) for ref in refs):
        raise ValueError("an option needs token references")
    return ",".join(refs)


def refs_for_option_id(option_id: str) -> list[str]:
    """The token references an option id encodes (the inverse of ``option_id_for_refs``)."""
    refs = option_id.split(",")
    if not all(_TOKEN_REF.match(ref) for ref in refs):
        raise ValueError("not an option id")
    return refs


# --- shared response pieces -----------------------------------------------------------------------


class TokenView(CamelModel):
    ref: str
    text: str


class SourceRef(CamelModel):
    """The citation shown with text. ``pages`` is empty for a web edition; ``url`` is always shown
    (the publisher's citation requirement, D68)."""

    publisher: str
    edition_label: str
    book_title_ar: str
    reference: str
    url: str
    pages: list[str] = Field(default_factory=list)
    # What the learner reads (D90): the hadith title or "surah, ayah range". ``publisher``,
    # ``edition_label`` and the technical ``reference`` stay for compatibility and are not shown.
    reference_ar: str = ""


class PassageUnit(CamelModel):
    unit_ref: int
    kind: UnitKind
    reference: str
    text: str  # verbatim, never trimmed or normalized


class Highlight(CamelModel):
    start_ref: str
    end_ref: str


class PassageView(CamelModel):
    passage_id: UUID
    path: Path
    reference: str
    reference_ar: str = ""  # D90: the learner-facing reference, as ``SourceRef.reference_ar``
    section_title_ar: str
    units: list[PassageUnit]
    highlight: Highlight
    takhrij: str | None
    grade: str | None
    show_d50_notice: bool
    source: SourceRef


class AyahEnd(CamelModel):
    """Where an ayah of a Quran passage ends, for the number the reader draws after it (D90).

    ``after_ref`` is the last token of the ayah and ``number`` its ayah number. It is decoration
    around the text and never part of a token. Only the ends between two ayat of the passage are
    listed, and none inside the blank: an end whose ``after_ref`` is neither in ``before`` nor in
    ``after`` is the one right after the blank (the blank closes its ayah)."""

    after_ref: str
    number: int


class QuestionContext(CamelModel):
    """The whole passage around the blank (D90): ``before`` and ``after`` are every token of the
    question's passage before and after the target, in book order."""

    before: list[TokenView] = Field(default_factory=list)
    after: list[TokenView] = Field(default_factory=list)
    ayah_ends: list[AyahEnd] = Field(default_factory=list)


class QuestionPolicy(CamelModel):
    normalization_policy_version: Literal["arabic-norm-v1"] = "arabic-norm-v1"
    scoring_policy_version: Literal["v1"] = "v1"


class ChoiceOption(CamelModel):
    option_id: str
    text: str


class OrderAnswerKey(CamelModel):
    order: list[str]


class OptionAnswerKey(CamelModel):
    option_id: str


class RecallAnswerKey(CamelModel):
    accepted_norms: list[str]


class _QuestionBase(CamelModel):
    question_id: UUID
    passage_id: UUID
    role: QuestionRole
    review_round_id: UUID | None
    context: QuestionContext
    policy: QuestionPolicy
    source: SourceRef


class WordOrderQuestion(_QuestionBase):
    type: Literal["word_order"]
    tokens: list[TokenView]  # shuffled
    answer_key: OrderAnswerKey


class WordChoiceQuestion(_QuestionBase):
    type: Literal["word_choice"]
    variant: Literal["word", "segment"]
    options: list[ChoiceOption]
    answer_key: OptionAnswerKey


class SimilarQuestion(_QuestionBase):
    type: Literal["similar_distinction"]
    options: list[ChoiceOption]
    answer_key: OptionAnswerKey


class RecallQuestion(_QuestionBase):
    type: Literal["word_recall"]
    hint_first_letter: str
    answer_key: RecallAnswerKey


Question = Annotated[
    WordOrderQuestion | WordChoiceQuestion | SimilarQuestion | RecallQuestion,
    Field(discriminator="type"),
]


class LearnStep(CamelModel):
    type: Literal["learn"]
    passage: PassageView


class QuestionStep(CamelModel):
    type: Literal["question"]
    question: Question


Step = Annotated[LearnStep | QuestionStep, Field(discriminator="type")]


class SessionSnapshot(CamelModel):
    """The immutable session. Every ``Question`` carries its ``answerKey`` (accepted risk, D72)."""

    session_id: UUID
    kind: SessionKind
    plan_id: UUID | None
    plan_version: int | None
    edition_id: UUID
    bank_version: int
    learning_date: date
    status: SessionStatus
    steps: list[Step]
    created_at: datetime


# --- E20 request: a union on ``kind`` with strict bodies ------------------------------------------


class RequestViolation(Exception):
    """A request body broke a rule: ``fields`` lists ``(field, rule)`` pairs (values never echoed).
    The service turns it into ``422 validation_error`` with ``details.fields``."""

    def __init__(self, fields: Sequence[tuple[str, str]]) -> None:
        self.fields = tuple(fields)
        super().__init__("; ".join(f"{field}: {rule}" for field, rule in self.fields))


class _Scope(RequestModel):
    section_ordinals: list[int]

    @field_validator("section_ordinals", mode="before")
    @classmethod
    def _valid_scope(cls, value: Any) -> list[int]:
        """Non-empty, at most 60 unique positive integers, stored ascending (shared plan rules)."""
        if (
            not isinstance(value, list)
            or not 0 < len(value) <= MAX_SCOPE_ORDINALS
            or not all(type(item) is int and item >= 1 for item in value)
            or len(set(value)) != len(value)
        ):
            raise PydanticCustomError("scope_invalid", "the scope is not valid")
        return sorted(value)


_StrictVersion = Annotated[int, Field(strict=True, ge=1)]


class DailySessionRequest(RequestModel):
    kind: Literal["daily"]
    plan_id: UUID
    expected_plan_version: _StrictVersion


class GameSessionRequest(RequestModel):
    kind: Literal["game"]
    plan_id: UUID
    expected_plan_version: _StrictVersion
    game_type: str | None = None
    passage_ids: list[UUID] | None = Field(default=None, max_length=MAX_PASSAGE_IDS)

    @field_validator("game_type", mode="before")
    @classmethod
    def _known_game_type(cls, value: Any) -> Any:
        if value is not None and value not in GAME_TYPES:
            raise PydanticCustomError("game_type_invalid", "unsupported game type")
        return value


class PlacementSessionRequest(RequestModel):
    kind: Literal["placement"]
    edition_id: UUID
    target_scope: _Scope
    self_rating: str | None = None

    @field_validator("self_rating", mode="before")
    @classmethod
    def _known_rating(cls, value: Any) -> Any:
        if value is not None and value not in SELF_RATINGS:
            raise PydanticCustomError("self_rating_invalid", "unsupported self rating")
        return value


SessionRequest = DailySessionRequest | GameSessionRequest | PlacementSessionRequest
# The same union with its discriminator, for typing and documentation. Parsing goes through
# ``parse_create_session_request``, which reports the rule names of API-spec E20.
CreateSessionRequest = Annotated[SessionRequest, Field(discriminator="kind")]

_MAX_REPORTED_FIELDS = 50
_RULE_NAMES = {"extra_forbidden": "forbidden_field", "missing": "required"}


def _field_path(
    loc: Sequence[Any], tags: frozenset[str] = frozenset(), members: frozenset[str] = frozenset()
) -> str:
    """``events[3].correct`` style path. ``tags`` are the union tags that pydantic inserts right
    after a list index, and ``members`` the class names it inserts for a plain union; both are
    left out so a path names fields only."""
    rendered = ""
    after_index = False
    for part in loc:
        if isinstance(part, int):
            rendered += f"[{part}]"
            after_index = True
            continue
        skip = (after_index and part in tags) or part in members
        after_index = False
        if not skip:
            rendered += f".{part}" if rendered else str(part)
    return rendered[:100] or "body"


def violations_of(
    error: ValidationError,
    tags: frozenset[str] = frozenset(),
    members: frozenset[str] = frozenset(),
) -> list[tuple[str, str]]:
    """``(field, rule)`` pairs of a pydantic error. A scope error of any kind is ``scope_invalid``;
    rule names follow API-spec E20 and §1.5 (``forbidden_field`` for an unknown property)."""
    found: list[tuple[str, str]] = []
    for item in error.errors(include_url=False, include_context=False, include_input=False)[
        :_MAX_REPORTED_FIELDS
    ]:
        loc = item["loc"]
        rule = _RULE_NAMES.get(item["type"], item["type"])
        if loc and loc[0] == "targetScope" and rule not in ("forbidden_field", "required"):
            rule = "scope_invalid"
        found.append((_field_path(loc, tags, members), rule))
    return list(dict.fromkeys(found))  # an answer that fits no shape repeats a rule per member


def parse_create_session_request(raw: Any) -> SessionRequest:
    """Validate an E20 body. Raises ``RequestViolation`` with the API-spec rule names:
    ``kind_invalid``, ``forbidden_field``, ``game_type_invalid``, ``self_rating_invalid``,
    ``scope_invalid`` and the pydantic type name for any other wrong or missing field."""
    if not isinstance(raw, dict):
        raise RequestViolation([("body", "object_required")])
    kind = raw.get("kind")
    models: dict[str, type[RequestModel]] = {
        "daily": DailySessionRequest,
        "game": GameSessionRequest,
        "placement": PlacementSessionRequest,
    }
    model = models.get(kind) if isinstance(kind, str) else None
    if model is None:
        raise RequestViolation([("kind", "kind_invalid")])
    try:
        return model.model_validate(raw)  # type: ignore[return-value]
    except ValidationError as error:
        raise RequestViolation(violations_of(error)) from None


# --- E21 request: events --------------------------------------------------------------------------


class OrderAnswer(RequestModel):
    order: list[str]


class OptionAnswer(RequestModel):
    option_id: str


class TextAnswer(RequestModel):
    text: str  # transient: graded and discarded, never stored or logged (S-11)


AnswerPayload = OrderAnswer | OptionAnswer | TextAnswer

_ENVELOPE_FIELDS = (
    "client_run_id",
    "snapshot_id",
    "protocol_version",
    "plan_version",
    "edition_id",
    "bank_version",
    "normalization_policy_version",
    "scoring_policy_version",
    "local_sequence",
)


class OfflineEnvelope(CamelModel):
    """The replay envelope of contract §7 as one value (built by ``_Event.envelope()`` once an event
    carries all of it). The wire form stays flat on the event, as ``Partial<OfflineEnvelope>``."""

    client_run_id: UUID
    snapshot_id: UUID
    protocol_version: int
    plan_version: int
    edition_id: UUID
    bank_version: int
    normalization_policy_version: str
    scoring_policy_version: str
    local_sequence: int


class _Event(RequestModel):
    """Common to both event types: the id and the optional offline envelope (all fields or none,
    API-spec S-10; ``localSequence`` is an ordering input, never a clock)."""

    client_event_id: UUID
    client_run_id: UUID | None = None
    snapshot_id: UUID | None = None
    protocol_version: Annotated[int, Field(strict=True)] | None = None
    plan_version: Annotated[int, Field(strict=True)] | None = None
    edition_id: UUID | None = None
    bank_version: Annotated[int, Field(strict=True)] | None = None
    normalization_policy_version: str | None = None
    scoring_policy_version: str | None = None
    local_sequence: Annotated[int, Field(strict=True, ge=0)] | None = None

    @model_validator(mode="after")
    def _envelope_is_complete_or_absent(self) -> _Event:
        present = [name for name in _ENVELOPE_FIELDS if getattr(self, name) is not None]
        if present and len(present) != len(_ENVELOPE_FIELDS):
            raise PydanticCustomError("envelope_incomplete", "the offline envelope is incomplete")
        return self

    @property
    def has_envelope(self) -> bool:
        return self.client_run_id is not None

    def envelope(self) -> OfflineEnvelope | None:
        """The whole envelope, or ``None`` for an online event (never partial, see above)."""
        if not self.has_envelope:
            return None
        return OfflineEnvelope.model_validate(
            {name: getattr(self, name) for name in _ENVELOPE_FIELDS}
        )


class AnswerEvent(_Event):
    type: Literal["answer"]
    question_id: UUID
    answer: AnswerPayload
    hint_used: Annotated[bool, Field(strict=True)]
    occurred_at: AwareDatetime
    duration_ms: Annotated[int, Field(strict=True, ge=0, le=MAX_EVENT_MS)]


class ActivityEvent(_Event):
    type: Literal["activity"]
    started_at: AwareDatetime
    ended_at: AwareDatetime
    active_ms: Annotated[int, Field(strict=True, ge=0)]


SessionEvent = Annotated[AnswerEvent | ActivityEvent, Field(discriminator="type")]


class EventsRequest(RequestModel):
    events: list[SessionEvent]

    @field_validator("events", mode="before")
    @classmethod
    def _count(cls, value: Any) -> Any:
        if isinstance(value, list):
            if not value:
                raise PydanticCustomError("events_empty", "at least one event is required")
            if len(value) > MAX_EVENTS:
                raise PydanticCustomError("events_too_many", "at most 100 events per request")
        return value


_EVENT_TAGS = frozenset({"answer", "activity"})
_ANSWER_MEMBERS = frozenset({"OrderAnswer", "OptionAnswer", "TextAnswer"})


def parse_events_request(raw: Any) -> EventsRequest:
    """Validate an E21 body with the field paths of API-spec E21: a forbidden property inside an
    event reads ``events[3].correct`` (the union tag is left out). Raises ``RequestViolation``;
    any failure fails the whole request (``events_empty``, ``events_too_many``,
    ``forbidden_field``, ``envelope_incomplete`` and the pydantic type name otherwise)."""
    if not isinstance(raw, dict):
        raise RequestViolation([("body", "object_required")])
    try:
        return EventsRequest.model_validate(raw)
    except ValidationError as error:
        raise RequestViolation(violations_of(error, _EVENT_TAGS, _ANSWER_MEMBERS)) from None


# --- progress, today and completion (E18, E19, E22) -----------------------------------------------


class DailyProgress(CamelModel):
    learning_date: date
    daily_active_ms: int
    daily_goal_ms: int
    daily_percent: int
    daily_completed: bool
    extra_active_ms: int


class NextNewPassage(CamelModel):
    reference: str
    section_title_ar: str


class Today(DailyProgress):
    plan: Plan | None
    due_reviews: int
    next_new_passage: NextNewPassage | None
    open_session_id: UUID | None
    streak_days: int
    open_plan_chat_id: UUID | None = None  # v1.5 (D75): lets S-08 and S-11 resume a conversation


class HistoryDay(CamelModel):
    date: date
    active_ms: int
    goal_ms: int
    completed: bool


class StatusCounts(CamelModel):
    new: int
    learning: int
    reviewing: int
    confirmed: int
    needs_refresh: int


class SectionProgress(CamelModel):
    ordinal: int
    reference: str
    title_ar: str
    title_en: str
    percent: int
    status: MasteryStatus


class PlanProgress(CamelModel):
    plan_id: UUID
    title_ar: str
    title_en: str
    status: Literal["active", "paused", "completed"]
    current_version: int  # v1.5 (O-32): opens an E20 daily session on a completed plan
    overall_percent: int
    confirmed_words: int
    total_words: int
    confirmed_sections: int
    total_sections: int
    counts: StatusCounts
    next_review_date: date | None
    sections: list[SectionProgress]


class ProgressResponse(CamelModel):
    daily: DailyProgress
    history: list[HistoryDay]
    plans: list[PlanProgress]


class AnswerExpected(CamelModel):
    """What the learner should have answered; only the member of the question's type is set."""

    order: list[str] | None = None
    option_id: str | None = None
    word: str | None = None

    @model_serializer(mode="wrap")
    def _drop_unset(self, handler: Any) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        return {name: value for name, value in data.items() if value is not None}


class AnswerPassageState(CamelModel):
    passage_id: UUID
    status: MasteryStatus
    covered_parts: int
    total_parts: int
    consecutive_correct: int


class AnswerResult(CamelModel):
    client_event_id: UUID
    question_id: UUID
    correct: bool
    assisted: bool
    expected: AnswerExpected
    passage: AnswerPassageState


class PendingEvent(CamelModel):
    client_event_id: UUID
    reason_code: PendingReason


class RejectedEvent(CamelModel):
    client_event_id: UUID
    code: RejectedCode


class EventsResponse(CamelModel):
    acknowledged: list[UUID]
    duplicate: list[UUID]  # the same clientEventId was acknowledged earlier
    pending: list[PendingEvent]  # kept without credit (D59)
    rejected: list[RejectedEvent]
    results: list[AnswerResult]
    daily: DailyProgress


class CompleteSummary(CamelModel):
    answered: int
    correct: int
    new_passages: int
    reviews_passed: int
    reviews_failed: int
    active_ms: int


class CompleteResponse(CamelModel):
    summary: CompleteSummary
    daily: DailyProgress
