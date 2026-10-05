"""Pydantic DTOs of the plan conversation (Plan-conversation.md §2.2, operations E31-E34).

This module is pure pydantic: it imports no FastAPI, Starlette or database client, so the pure
``app/domain`` modules may import it. JSON names are camelCase (aliases); Python attribute
names are snake_case. Responses are built by field name and serialized by alias (FastAPI does
this by default); request models accept the camelCase names only and forbid unknown fields.

The shared plan DTOs (``Estimate``, ``TargetScope``, ``CatalogEdition``, ``Plan``) mirror
Implementation-contract §7 so that B4 (plans and catalog) can implement the ports of
``app/domain/planning_port.py`` against them. When B4 introduces its own module for them, this
module should re-export from there instead of redefining them.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator
from pydantic.alias_generators import to_camel

# --- vocabularies -------------------------------------------------------------------------------

Path = Literal["quran", "matn", "sanad", "grade"]
PlanOrder = Literal["book", "reverse"]
SessionMinutes = Literal[5, 10, 15]
Language = Literal["ar", "en"]
ReasonCode = Literal["fits_preferred_date", "exceeds_preferred_date", "no_preferred_date"]
QuickReplyCode = Literal[
    "fewer_minutes",
    "more_minutes",
    "smaller_scope",
    "later_date",
    "no_date",
    "order_book",
    "order_reverse",
    "paths_matn_only",
    "paths_all",
    "confirm",
]
MessageKind = Literal["text", "proposal", "refusal", "redirect", "fallback", "quick_reply"]
MessageSource = Literal["learner", "rules", "model", "fixed"]
ChatStatus = Literal["open", "confirmed", "abandoned"]
ModelIntent = Literal["set_parameters", "question", "confirm", "religious", "out_of_scope"]

PATH_ORDER: tuple[str, ...] = ("quran", "matn", "sanad", "grade")
SESSION_MINUTES_OPTIONS: tuple[int, ...] = (5, 10, 15)


class CamelModel(BaseModel):
    """Base of response and internal models: camelCase aliases, built by field name."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RequestModel(BaseModel):
    """Base of request bodies: camelCase names only, unknown fields forbidden."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        extra="forbid",
    )


# --- contract §7 shared DTOs ----------------------------------------------------------------------


class TargetScope(CamelModel):
    section_ordinals: list[int]


class DailyNew(CamelModel):
    """The daily amount of new material in whole learning units (D90).

    The internal pace stays in words (``Estimate.new_words_per_day``, which the passage split of
    D66 relies on); this is how the learner is told: ``perDay`` whole units a day, or one whole
    unit every ``everyDays`` days (a long hadith that takes several days). Exactly one of the two
    is set, never both and never a number below 1. Units are never split.
    """

    unit: Literal["ayah", "hadith"]
    per_day: int | None = Field(default=None, ge=1)
    every_days: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _exactly_one_rate(self) -> DailyNew:
        if (self.per_day is None) == (self.every_days is None):
            raise ValueError("exactly one of perDay and everyDays must be set")
        return self


class Estimate(CamelModel):
    days: int
    end_date: date
    new_words_per_day: int
    total_words: int
    known_words: int
    passage_count: int
    session_minutes: SessionMinutes
    scope: TargetScope
    paths: list[Path]
    # D90: the learner-facing amount in whole units. ``None`` when the catalog gives no unit count
    # (and for a plan stored before D90): the client then falls back to the words figure.
    daily_new: DailyNew | None = None


class EstimateResult(CamelModel):
    """Result of the E15 function: the estimate, up to two alternatives and the reason code."""

    estimate: Estimate
    alternatives: list[Estimate] = Field(default_factory=list)
    reason_code: ReasonCode


class CatalogSection(CamelModel):
    section_id: str
    ordinal: int
    kind: Literal["surah", "hadith"]
    reference: str
    title_ar: str
    title_en: str
    word_count: int
    passage_count: int
    paths: list[Path]


class CatalogCategory(CamelModel):
    slug: str
    label_ar: str
    label_en: str


class CatalogEdition(CamelModel):
    edition_id: str
    edition_key: str
    title_ar: str
    title_en: str
    author: str
    edition_label: str
    category: CatalogCategory
    catalog_version: int
    content_format: Literal["quran", "hadith_collection"]
    available_paths: list[Path]
    default_paths: list[Path]
    default_order: PlanOrder = "book"
    total_words: int
    sections: list[CatalogSection]


class PlannerInfo(CamelModel):
    source: Literal["rules", "teaching_agent"]
    model: str | None = None

    @model_serializer(mode="wrap")
    def _drop_empty_model(self, handler: Any) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if data.get("model") is None:
            data.pop("model", None)
        return data


class Plan(CamelModel):
    plan_id: UUID
    edition_id: UUID
    title_ar: str
    title_en: str
    target_scope: TargetScope
    paths: list[Path]
    order: PlanOrder
    session_minutes: SessionMinutes
    preferred_date: date | None
    agreed_estimate: Estimate
    current_version: int
    status: Literal["active", "paused", "completed"]
    created_at: datetime
    pending_session_minutes: SessionMinutes | None = None
    planner: PlannerInfo


# --- plan parameters (internal, loosely typed so that invalid input can be validated) -----------


class PlanParameters(CamelModel):
    """The plan fields a conversation can change. Loosely typed on purpose: validation is the
    job of ``domain.plan_chat_policy.validate_parameters``; the typed ``PlanProposal`` is built
    only from validated parameters."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True)

    edition_id: UUID
    target_scope: TargetScope
    paths: list[str]
    order: str = "book"
    session_minutes: int
    preferred_date: date | None = None


# --- Plan-conversation §2.2 DTOs ------------------------------------------------------------------


class QuickReply(CamelModel):
    code: QuickReplyCode
    label_ar: str
    label_en: str


class PlanSections(CamelModel):
    """Plain text in the interface language, server-built from templates and rules numbers."""

    goal: str
    total_time: str
    daily_time: str
    stages: str
    reviews: str
    next_step: str


class PlanProposal(CamelModel):
    proposal_version: int
    edition_id: UUID
    target_scope: TargetScope
    paths: list[Path]
    order: PlanOrder
    session_minutes: SessionMinutes
    preferred_date: date | None
    estimate: Estimate
    sections: PlanSections


class StoredProposal(PlanProposal):
    """The ``plan_chats.proposal`` JSON: the public proposal plus two server-only fields.

    ``placement_session_id`` keeps the placement used for ``knownWords`` (Plan-conversation
    §2.3, [O-17]); ``plan_version`` is the revised plan's ``currentVersion`` when the
    conversation started (``expectedVersion`` of E17). Neither is exposed in ``PlanProposal``.
    """

    placement_session_id: UUID | None = None
    plan_version: int | None = None
    reason_code: ReasonCode = "no_preferred_date"

    def public(self) -> PlanProposal:
        return PlanProposal(**{name: getattr(self, name) for name in PlanProposal.model_fields})


class ChatMessage(CamelModel):
    message_id: UUID
    ordinal: int
    role: Literal["learner", "assistant"]
    kind: MessageKind
    text: str
    source: MessageSource
    created_at: datetime


class AssistantInfo(CamelModel):
    source: Literal["rules", "model"]
    model: str | None = None

    @model_serializer(mode="wrap")
    def _drop_empty_model(self, handler: Any) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if data.get("model") is None:
            data.pop("model", None)
        return data


class PlanChat(CamelModel):
    chat_id: UUID
    status: ChatStatus
    plan_id: UUID | None
    language: Language
    messages: list[ChatMessage]
    proposal: PlanProposal | None
    quick_replies: list[QuickReply]
    model_turns_left: int
    assistant: AssistantInfo
    # E31 only (Plan-conversation §2.9 item 2): the open conversation this one replaced.
    replaced_chat_id: UUID | None = None

    @model_serializer(mode="wrap")
    def _drop_empty_replaced(self, handler: Any) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if data.get("replacedChatId", data.get("replaced_chat_id")) is None:
            data.pop("replacedChatId", None)
            data.pop("replaced_chat_id", None)
        return data


# --- requests -------------------------------------------------------------------------------------


class TargetScopeRequest(RequestModel):
    section_ordinals: list[int]


class CreatePlanChatRequest(RequestModel):
    edition_id: UUID
    target_scope: TargetScopeRequest
    paths: list[str]
    session_minutes: int
    preferred_date: date | None = None
    placement_session_id: UUID | None = None
    goal_text: str
    language: Language
    plan_id: UUID | None = None


class SendMessageRequest(RequestModel):
    text: str | None = None
    quick_reply: QuickReplyCode | None = None


class ConfirmRequest(RequestModel):
    proposal_version: int


# --- anonymized learning record for revision conversations (R27, §2.4) --------------------------


class ReviewOutcome(CamelModel):
    date: date
    passed: bool


class PassageMasteryItem(CamelModel):
    reference: str
    state: Literal["new", "learning", "reviewing", "confirmed", "needs_refresh"]
    review_outcomes: list[ReviewOutcome] = Field(default_factory=list)


class ErrorPartItem(CamelModel):
    reference: str
    error_count: int


class DailyTimeItem(CamelModel):
    date: date
    active_minutes: int


class RecentAttempt(CamelModel):
    question_type: str
    reference: str
    correct: bool
    assisted: bool
    error_kind: str | None = None
    date: date


class LearningSummary(CamelModel):
    """Source-text references and dates only: no account, device or registration data."""

    passages: list[PassageMasteryItem] = Field(default_factory=list)
    error_parts: list[ErrorPartItem] = Field(default_factory=list)
    daily_time: list[DailyTimeItem] = Field(default_factory=list)
    attempts: list[RecentAttempt] = Field(default_factory=list)


MAX_DAILY_TIME_ITEMS = 30
MAX_RECENT_ATTEMPTS = 50
