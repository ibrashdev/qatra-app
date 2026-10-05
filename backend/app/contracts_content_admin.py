"""DTOs of the content manager web admin (D91, docs/Content-admin.md section 4).

Pure pydantic. Responses are ``CamelModel`` (camelCase on the wire, built by field name); request
bodies are ``RequestModel`` (camelCase names only, unknown properties forbidden) and strict like
every request body (API-spec S-1): a wrong type is refused, never coerced.

Text is trimmed and checked by the pure rules of ``content_admin_policy`` (length and control
characters), so a violation answers ``422`` with the rule name of that policy (``text_length``,
``text_control_chars``, ``url_https`` ...). A PATCH must send at least one field (``no_fields``).
``titleEn`` of a book, ``labelEn`` of a category and ``licenseUrl`` of a source accept ``null`` to
clear the value; every other field refuses ``null`` (``null_not_allowed``), among them the English
title of a section, whose column is ``NOT NULL`` (a deviation from the spec text, see the report).
``expectedUpdatedAt`` is the ``updatedAt`` the manager read, an ISO 8601 date-time with a time
zone; the service sends it back to the database as the concurrency filter.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any, ClassVar, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BeforeValidator,
    Field,
    StrictInt,
    StrictStr,
    model_validator,
)
from pydantic_core import PydanticCustomError

from app.contracts_plan_chat import CamelModel, RequestModel
from app.domain import content_admin_policy as policy

EditionStatus = Literal["draft", "validated", "published", "superseded", "revoked"]
RightsStatus = Literal["owner_accepted_pending_verification", "verified", "rejected"]
WithdrawReason = Literal["transmission", "rights", "accreditation"]

# --- request building blocks --------------------------------------------------------------------


def _cleaner(max_length: int) -> Callable[[str], str]:
    def clean(value: str) -> str:
        trimmed = value.strip()
        rule = policy.text_violation(trimmed, max_length=max_length)
        if rule is not None:
            raise PydanticCustomError(rule, "the text is not acceptable")
        return trimmed

    return clean


def _clean_url(value: str) -> str:
    trimmed = value.strip()
    rule = policy.url_violation(trimmed)
    if rule is not None:
        raise PydanticCustomError(rule, "the link is not acceptable")
    return trimmed


def _parse_stamp(value: Any) -> datetime:
    """``expectedUpdatedAt``: an ISO 8601 string with a time zone, as the API returned it."""
    if not isinstance(value, str):
        raise PydanticCustomError("timestamp_invalid", "an ISO 8601 date-time is required")
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        raise PydanticCustomError(
            "timestamp_invalid", "an ISO 8601 date-time is required"
        ) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PydanticCustomError("timestamp_invalid", "a time zone is required")
    return parsed


Title = Annotated[StrictStr, AfterValidator(_cleaner(policy.TITLE_MAX_LENGTH))]
SourceTitle = Annotated[StrictStr, AfterValidator(_cleaner(policy.SOURCE_TITLE_MAX_LENGTH))]
WithdrawalNote = Annotated[StrictStr, AfterValidator(_cleaner(policy.WITHDRAWAL_NOTE_MAX_LENGTH))]
LicenseUrl = Annotated[StrictStr, AfterValidator(_clean_url)]
DisplayOrder = Annotated[StrictInt, Field(ge=policy.DISPLAY_ORDER_MIN, le=policy.DISPLAY_ORDER_MAX)]
Stamp = Annotated[datetime, BeforeValidator(_parse_stamp)]


class ExpectedVersionRequest(RequestModel):
    """The body of archive, unarchive and the deletes."""

    expected_updated_at: Stamp


class _PatchRequest(RequestModel):
    """A PATCH body: at least one change field, and no ``null`` except where a subclass allows it
    (its field is typed ``X | None`` and left out of ``NOT_NULL``)."""

    CHANGE_FIELDS: ClassVar[tuple[str, ...]] = ()
    NOT_NULL: ClassVar[tuple[str, ...]] = ()

    @model_validator(mode="before")
    @classmethod
    def _no_explicit_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for alias, value in data.items():
                if value is None and cls._is_not_null(alias):
                    raise PydanticCustomError(
                        "null_not_allowed", "null is not allowed for this field"
                    )
        return data

    @classmethod
    def _is_not_null(cls, alias: str) -> bool:
        for name in cls.NOT_NULL:
            field = cls.model_fields[name]
            if alias == field.alias:
                return True
        return False

    @model_validator(mode="after")
    def _at_least_one(self) -> _PatchRequest:
        if not set(self.CHANGE_FIELDS) & self.model_fields_set:
            raise PydanticCustomError("no_fields", "at least one field is required")
        return self

    def to_changes(self) -> dict[str, Any]:
        """The database columns to change: the fields that were present, by column name."""
        changes: dict[str, Any] = {}
        for name in self.CHANGE_FIELDS:
            if name in self.model_fields_set:
                value = getattr(self, name)
                changes[name] = str(value) if isinstance(value, UUID) else value
        return changes


class PatchEditionRequest(ExpectedVersionRequest):
    edition_label: Title


class WithdrawEditionRequest(ExpectedVersionRequest):
    reason: WithdrawReason
    note: WithdrawalNote


class PatchSectionRequest(_PatchRequest):
    """No concurrency token (sections have no ``updated_at``); ``titleEn`` is not nullable."""

    CHANGE_FIELDS: ClassVar[tuple[str, ...]] = ("title_ar", "title_en")
    NOT_NULL: ClassVar[tuple[str, ...]] = ("title_ar", "title_en")

    title_ar: Title | None = None
    title_en: Title | None = None


class PatchBookRequest(_PatchRequest):
    CHANGE_FIELDS: ClassVar[tuple[str, ...]] = ("title_ar", "title_en", "author", "category_id")
    NOT_NULL: ClassVar[tuple[str, ...]] = ("title_ar", "author", "category_id")

    expected_updated_at: Stamp
    title_ar: Title | None = None
    title_en: Title | None = None
    author: Title | None = None
    category_id: UUID | None = None


class PatchCategoryRequest(_PatchRequest):
    CHANGE_FIELDS: ClassVar[tuple[str, ...]] = ("label_ar", "label_en", "display_order")
    NOT_NULL: ClassVar[tuple[str, ...]] = ("label_ar", "display_order")

    expected_updated_at: Stamp
    label_ar: Title | None = None
    label_en: Title | None = None
    display_order: DisplayOrder | None = None


class PatchSourceRequest(_PatchRequest):
    CHANGE_FIELDS: ClassVar[tuple[str, ...]] = ("title", "provider", "license_url", "rights_status")
    NOT_NULL: ClassVar[tuple[str, ...]] = ("title", "provider", "rights_status")

    expected_updated_at: Stamp
    title: SourceTitle | None = None
    provider: Title | None = None
    license_url: LicenseUrl | None = None
    rights_status: RightsStatus | None = None


# --- responses ----------------------------------------------------------------------------------


class AccessResponse(CamelModel):
    """``true`` when the signed-in account is a content manager, ``false`` for every other
    signed-in account (a non-manager, a demo session, an empty setting)."""

    content_manager: bool


class BookRef(CamelModel):
    id: UUID
    title_ar: str
    title_en: str | None


class EditionSummary(CamelModel):
    id: UUID
    edition_key: str
    edition_label: str
    language: str
    version: int
    bank_version: int
    status: EditionStatus
    catalog_hidden: bool
    archived_at: datetime | None
    updated_at: datetime
    book: BookRef


class EditionStatusCounts(CamelModel):
    draft: int
    validated: int
    published: int
    superseded: int
    revoked: int


class OverviewCounts(CamelModel):
    categories: int
    books: int
    sources: int
    editions: EditionStatusCounts


class AiStatus(CamelModel):
    """Configuration and in-process counters only (spec section 7). The provider key itself is
    never part of it; the counters are ``null`` when no ledger is reachable."""

    chat_model_for_learners: bool
    provider_configured: bool
    models: list[str]
    daily_cap: int
    used_today: int | None
    used_last_minute: int | None


class Overview(CamelModel):
    counts: OverviewCounts
    editions: list[EditionSummary]
    ai: AiStatus


class EditionSourceRef(CamelModel):
    id: UUID
    title: str
    provider: str
    rights_status: RightsStatus


class ApprovalView(CamelModel):
    who: str | None
    at: str | None
    scope: str | None
    words: str | None
    source: str | None


class WithdrawalView(CamelModel):
    reason: str | None
    note: str | None
    at: str | None


class EditionContentCounts(CamelModel):
    sections: int
    units: int
    passages: int
    lessons: int
    questions: int


class SectionItem(CamelModel):
    id: UUID
    ordinal: int
    kind: str
    reference: str
    title_ar: str
    title_en: str


class JobItem(CamelModel):
    step: str
    status: str
    updated_at: datetime
    published_at: datetime | None


class EditionActionsView(CamelModel):
    edit_label: bool
    archive: bool
    unarchive: bool
    withdraw: bool
    delete: bool


class EditionDetail(EditionSummary):
    source: EditionSourceRef
    content_hash: str | None
    approval: ApprovalView | None
    withdrawal: WithdrawalView | None
    counts: EditionContentCounts
    sections: list[SectionItem]
    jobs: list[JobItem]
    actions: EditionActionsView


class SectionEdition(CamelModel):
    id: UUID
    edition_label: str
    status: EditionStatus


class UnitItem(CamelModel):
    id: UUID
    ordinal: int
    kind: str
    reference: str
    text: str


class QuestionCounts(CamelModel):
    word_order: int
    word_choice: int
    word_recall: int
    similar_distinction: int


class SectionDetail(CamelModel):
    id: UUID
    edition: SectionEdition
    ordinal: int
    kind: str
    reference: str
    title_ar: str
    title_en: str
    units: list[UnitItem]
    question_counts: QuestionCounts


class CategoryOption(CamelModel):
    id: UUID
    label_ar: str


class Book(CamelModel):
    id: UUID
    title_ar: str
    title_en: str | None
    author: str
    content_format: str
    category: CategoryOption
    edition_count: int
    updated_at: datetime


class BooksResponse(CamelModel):
    books: list[Book]
    categories: list[CategoryOption]


class Category(CamelModel):
    id: UUID
    slug: str
    label_ar: str
    label_en: str | None
    display_order: int
    book_count: int
    updated_at: datetime


class CategoriesResponse(CamelModel):
    categories: list[Category]


class Source(CamelModel):
    id: UUID
    title: str
    provider: str
    source_url: str
    license_url: str | None
    rights_status: RightsStatus
    checked_at: datetime | None
    edition_count: int
    updated_at: datetime


class SourcesResponse(CamelModel):
    sources: list[Source]
