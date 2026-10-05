"""The content manager web admin (D91, docs/Content-admin.md): every endpoint's logic.

The service reads and updates DISPLAY metadata and removes content the D44 way; it never edits
source text, never creates anything and never calls a model. It talks to a
``ContentAdminRepository`` and decides with the pure rules of ``content_admin_policy``.

Concurrency (section 3): a write carries ``expectedUpdatedAt`` and the repository matches
``updated_at`` with it; no row matched means ``409 version_conflict`` reason ``stale`` (or
``404`` when the row is gone). ``409`` reason ``state`` is a status that does not allow the action
and ``in_use`` is a row something still references. Sections have no ``updated_at`` (last write
wins).

Withdrawal (section 5) is a sequence PostgREST cannot make atomic, so every step is safe to
repeat: the status write (skipped on a retry), then the redaction of offline snapshots and
prepared sessions, then the ``withdrawn`` job. A failure after the status write answers
``503 unavailable``; the edition is already ``revoked``, and repeating the request finishes it.

Logging: one event, ``content_admin_action``, with ``action``, ``entity`` and ``outcome`` for
every state-changing request. No id, username, text or body is ever logged.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, NoReturn
from uuid import UUID

from app.config import Settings
from app.contracts_content_admin import (
    AiStatus,
    ApprovalView,
    Book,
    BookRef,
    BooksResponse,
    CategoriesResponse,
    Category,
    CategoryOption,
    EditionActionsView,
    EditionContentCounts,
    EditionDetail,
    EditionSourceRef,
    EditionStatusCounts,
    EditionSummary,
    ExpectedVersionRequest,
    JobItem,
    Overview,
    OverviewCounts,
    PatchBookRequest,
    PatchCategoryRequest,
    PatchEditionRequest,
    PatchSectionRequest,
    PatchSourceRequest,
    QuestionCounts,
    SectionDetail,
    SectionEdition,
    SectionItem,
    Source,
    SourcesResponse,
    UnitItem,
    WithdrawalView,
    WithdrawEditionRequest,
)
from app.domain import content_admin_policy as policy
from app.domain.content_policy import ContentPolicyError
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.repositories.ai_usage import UsageLedger
from app.repositories.content_admin import (
    ContentAdminRepository,
    ContentAdminRepositoryError,
    ContentInUseError,
    ContentStateError,
    Row,
)

logger = logging.getLogger("qatra.content_admin")

_NO_ACCOUNT = UUID(int=0)  # the ledger's per-account count is not used here
_EDITION_STATUSES = ("draft", "validated", "published", "superseded", "revoked")


def _conflict(reason: str) -> AppError:
    return AppError(ErrorCode.version_conflict, details={"reason": reason})


def _invalid(field: str, rule: str) -> AppError:
    return AppError(
        ErrorCode.validation_error, details={"fields": [{"field": field, "rule": rule}]}
    )


def _outcome(error: AppError) -> str:
    if error.code is ErrorCode.version_conflict:
        return str(error.details.get("reason", "conflict"))
    return error.code.value


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


class ContentAdminService:
    """One instance per application (``app.state.content_admin_service``)."""

    def __init__(
        self,
        settings: Settings,
        repository: ContentAdminRepository,
        *,
        clock: Callable[[], datetime] | None = None,
        usage_ledger: Callable[[], UsageLedger | None] | None = None,
    ) -> None:
        self._settings = settings
        self._repo = repository
        self._clock = clock or (lambda: datetime.now(UTC))
        self._usage_ledger = usage_ledger

    def __repr__(self) -> str:
        return "ContentAdminService()"

    # -- plumbing -----------------------------------------------------------------------------

    @contextmanager
    def _action(self, action: str, entity: str) -> Iterator[None]:
        """Turn the repository's and the policy's refusals into the API errors and log the one
        ``content_admin_action`` event of the request."""
        outcome = "ok"
        try:
            yield
        except ContentInUseError:
            outcome = "in_use"
            raise _conflict("in_use") from None
        except (ContentStateError, ContentPolicyError):
            outcome = "state"
            raise _conflict("state") from None
        except AppError as error:
            outcome = _outcome(error)
            raise
        except Exception:
            outcome = "error"
            raise
        finally:
            log_event(logger, "content_admin_action", action=action, entity=entity, outcome=outcome)

    def _now(self) -> datetime:
        return self._clock().astimezone(UTC)

    def _require(self, table: str, row_id: UUID) -> Row:
        row = self._repo.get(table, row_id)
        if row is None:
            raise AppError(ErrorCode.not_found)
        return row

    def _no_match(self, table: str, row_id: UUID) -> NoReturn:
        """A write matched no row: the row is gone (404) or changed since the manager read it."""
        if self._repo.get(table, row_id) is None:
            raise AppError(ErrorCode.not_found)
        raise _conflict("stale")

    def _update(
        self,
        table: str,
        row_id: UUID,
        values: Mapping[str, Any],
        *,
        expected: datetime | None,
        require: Mapping[str, Any] | None = None,
    ) -> Row:
        updated = self._repo.update(
            table, row_id, values, expected_updated_at=expected, require=require
        )
        if updated is None:
            self._no_match(table, row_id)
        return updated

    def _delete(self, table: str, row_id: UUID, body: ExpectedVersionRequest) -> None:
        if not self._repo.delete(table, row_id, expected_updated_at=body.expected_updated_at):
            self._no_match(table, row_id)

    # -- overview and AI status (sections 4 and 7) --------------------------------------------

    def overview(self) -> Overview:
        counts = self._repo.counts()
        editions = self._repo.list_editions()
        books = {str(book["id"]): book for book in self._repo.list_books()}
        by_status = dict.fromkeys(_EDITION_STATUSES, 0)
        for edition in editions:
            by_status[edition["status"]] += 1
        summaries = [self._summary(edition, books) for edition in editions]
        summaries.sort(key=lambda s: (s.book.title_ar, -s.version, s.edition_key))
        return Overview(
            counts=OverviewCounts(
                categories=counts["categories"],
                books=counts["books"],
                sources=counts["sources"],
                editions=EditionStatusCounts(**by_status),
            ),
            editions=summaries,
            ai=self.ai_status(),
        )

    def ai_status(self) -> AiStatus:
        """Configuration and the in-process counters. The key is reported as a boolean only."""
        settings = self._settings
        key = settings.OPENROUTER_API_KEY
        models = [item.strip() for item in (settings.OPENROUTER_MODELS or "").split(",")]
        used_today: int | None = None
        used_last_minute: int | None = None
        ledger = self._usage_ledger() if self._usage_ledger is not None else None
        if ledger is not None:
            usage = ledger.counts(_NO_ACCOUNT, self._now())
            used_today, used_last_minute = usage.global_day, usage.global_minute
        return AiStatus(
            chat_model_for_learners=settings.QATRA_CHAT_MODEL_FOR_LEARNERS,
            provider_configured=key is not None and bool(key.get_secret_value().strip()),
            models=[model for model in models if model],
            daily_cap=settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY,
            used_today=used_today,
            used_last_minute=used_last_minute,
        )

    @staticmethod
    def _summary(edition: Row, books: Mapping[str, Row]) -> EditionSummary:
        book = books[str(edition["book_id"])]
        return EditionSummary(
            id=edition["id"],
            edition_key=edition["edition_key"],
            edition_label=edition["edition_label"],
            language=edition["language"],
            version=edition["version"],
            bank_version=edition["bank_version"],
            status=edition["status"],
            catalog_hidden=edition["catalog_hidden"],
            archived_at=edition.get("archived_at"),
            updated_at=edition["updated_at"],
            book=BookRef(id=book["id"], title_ar=book["title_ar"], title_en=book.get("title_en")),
        )

    # -- editions (sections 4 and 5) ----------------------------------------------------------

    def edition_detail(self, edition_id: UUID) -> EditionDetail:
        return self._detail(self._require("book_editions", edition_id))

    def _detail(self, edition: Row) -> EditionDetail:
        edition_id = edition["id"]
        book = self._require("books", edition["book_id"])
        source = self._require("sources", edition["source_id"])
        sections = self._repo.list_sections(edition_id)
        jobs = self._repo.list_jobs(edition_id)
        counts = self._repo.edition_content_counts(edition_id, edition["bank_version"])
        record = edition.get("review_record")
        approval = policy.approval_view(record)
        withdrawal = policy.withdrawal_view(record)
        actions = policy.edition_actions(
            status=edition["status"],
            catalog_hidden=edition["catalog_hidden"],
            review_record=record,
            jobs=jobs,
        )
        summary = self._summary(edition, {str(book["id"]): book})
        return EditionDetail(
            **summary.model_dump(),
            source=EditionSourceRef(
                id=source["id"],
                title=source["title"],
                provider=source["provider"],
                rights_status=source["rights_status"],
            ),
            content_hash=edition.get("content_hash"),
            approval=None if approval is None else ApprovalView(**approval),
            withdrawal=None if withdrawal is None else WithdrawalView(**withdrawal),
            counts=EditionContentCounts(**counts),
            sections=[
                SectionItem(
                    id=section["id"],
                    ordinal=section["ordinal"],
                    kind=section["kind"],
                    reference=section["reference"],
                    title_ar=section["title_ar"],
                    title_en=section["title_en"],
                )
                for section in sorted(sections, key=lambda item: item["ordinal"])
            ],
            jobs=[
                JobItem(
                    step=job["step"],
                    status=job["status"],
                    updated_at=job["updated_at"],
                    published_at=job.get("published_at"),
                )
                for job in jobs
            ],
            actions=EditionActionsView(
                edit_label=actions.edit_label,
                archive=actions.archive,
                unarchive=actions.unarchive,
                withdraw=actions.withdraw,
                delete=actions.delete,
            ),
        )

    def patch_edition(self, edition_id: UUID, body: PatchEditionRequest) -> EditionDetail:
        with self._action("update", "edition"):
            edition = self._require("book_editions", edition_id)
            policy.assert_can_edit_label(edition["status"])
            updated = self._update(
                "book_editions",
                edition_id,
                {"edition_label": body.edition_label},
                expected=body.expected_updated_at,
            )
            return self._detail(updated)

    def archive_edition(self, edition_id: UUID, body: ExpectedVersionRequest) -> EditionDetail:
        """Hide a published edition from the catalog (reversible)."""
        with self._action("archive", "edition"):
            edition = self._require("book_editions", edition_id)
            policy.assert_can_archive(edition["status"], edition["catalog_hidden"])
            now = self._now()
            updated = self._update(
                "book_editions",
                edition_id,
                {
                    "catalog_hidden": True,
                    "archived_at": _iso(now),
                    "review_record": policy.with_catalog_visibility(
                        edition.get("review_record"), action="hidden", at=now
                    ),
                },
                expected=body.expected_updated_at,
                require={"status": "published"},
            )
            self._record_job(updated, step="archived")
            return self._detail(updated)

    def unarchive_edition(self, edition_id: UUID, body: ExpectedVersionRequest) -> EditionDetail:
        """Show a hidden published edition again."""
        with self._action("unarchive", "edition"):
            edition = self._require("book_editions", edition_id)
            policy.assert_can_unarchive(edition["status"], edition["catalog_hidden"])
            updated = self._update(
                "book_editions",
                edition_id,
                {
                    "catalog_hidden": False,
                    "archived_at": None,
                    "review_record": policy.with_catalog_visibility(
                        edition.get("review_record"), action="shown", at=self._now()
                    ),
                },
                expected=body.expected_updated_at,
                require={"status": "published"},
            )
            return self._detail(updated)

    def withdraw_edition(self, edition_id: UUID, body: WithdrawEditionRequest) -> EditionDetail:
        """Withdraw a published edition (irreversible); see the module note for the sequence."""
        with self._action("withdraw", "edition"):
            edition = self._require("book_editions", edition_id)
            mode = policy.withdrawal_mode(edition["status"], edition.get("review_record"))
            if mode == "fresh":
                edition = self._update(
                    "book_editions",
                    edition_id,
                    {
                        "status": "revoked",
                        "review_record": policy.with_withdrawal(
                            edition.get("review_record"),
                            reason=body.reason,
                            note=body.note,
                            at=self._now(),
                        ),
                    },
                    expected=body.expected_updated_at,
                    require={"status": "published"},
                )
            try:
                self._repo.redact_revoked_content(edition_id)
                self._record_job(edition, step="withdrawn")
            except (AppError, ContentAdminRepositoryError):
                # The status is already revoked: learners no longer receive the edition, and
                # repeating the request completes what is left.
                raise AppError(ErrorCode.unavailable) from None
            return self._detail(edition)

    def delete_edition(self, edition_id: UUID, body: ExpectedVersionRequest) -> None:
        """Delete a never-published draft; its dependent rows go with it (ON DELETE CASCADE)."""
        with self._action("delete", "edition"):
            edition = self._require("book_editions", edition_id)
            policy.assert_can_delete_edition(edition["status"], self._repo.list_jobs(edition_id))
            self._delete("book_editions", edition_id, body)

    def _record_job(self, edition: Row, *, step: str) -> None:
        """Upsert the audit job row of ``step`` as ``succeeded`` (the pipeline version comes from
        the edition's published job, or is ``admin-web``)."""
        edition_id = edition["id"]
        version = policy.pipeline_version_for(
            self._repo.list_jobs(edition_id), edition["bank_version"]
        )
        self._repo.upsert_job(
            edition_id=edition_id,
            bank_version=edition["bank_version"],
            pipeline_version=version,
            step=step,
            status="succeeded",
        )

    # -- sections -----------------------------------------------------------------------------

    def section_detail(self, section_id: UUID) -> SectionDetail:
        section = self._require("book_sections", section_id)
        edition = self._require("book_editions", section["edition_id"])
        units = self._repo.list_units(section_id)
        counts = self._repo.question_counts(
            [str(unit["id"]) for unit in units], edition["bank_version"]
        )
        return SectionDetail(
            id=section["id"],
            edition=SectionEdition(
                id=edition["id"], edition_label=edition["edition_label"], status=edition["status"]
            ),
            ordinal=section["ordinal"],
            kind=section["kind"],
            reference=section["reference"],
            title_ar=section["title_ar"],
            title_en=section["title_en"],
            units=[
                UnitItem(
                    id=unit["id"],
                    ordinal=unit["ordinal"],
                    kind=unit["kind"],
                    reference=unit["reference"],
                    text=unit["canonical_text"],
                )
                for unit in sorted(units, key=lambda item: item["ordinal"])
            ],
            question_counts=QuestionCounts(**counts),
        )

    def patch_section(self, section_id: UUID, body: PatchSectionRequest) -> SectionDetail:
        with self._action("update", "section"):
            section = self._require("book_sections", section_id)
            edition = self._require("book_editions", section["edition_id"])
            policy.assert_can_edit_section(edition["status"])
            # No ``updated_at`` on sections: the last write wins.
            self._update("book_sections", section_id, body.to_changes(), expected=None)
            return self.section_detail(section_id)

    # -- books --------------------------------------------------------------------------------

    def books(self) -> BooksResponse:
        categories = self._repo.list_categories()
        ordered = sorted(categories, key=lambda row: (row["display_order"], row["label_ar"]))
        return BooksResponse(
            books=self._book_items(categories),
            categories=[CategoryOption(id=row["id"], label_ar=row["label_ar"]) for row in ordered],
        )

    def _book_items(self, category_rows: list[Row] | None = None) -> list[Book]:
        rows = self._repo.list_categories() if category_rows is None else category_rows
        categories = {str(row["id"]): row for row in rows}
        editions_of: dict[str, int] = {}
        for edition in self._repo.list_editions():
            key = str(edition["book_id"])
            editions_of[key] = editions_of.get(key, 0) + 1
        items = [
            Book(
                id=row["id"],
                title_ar=row["title_ar"],
                title_en=row.get("title_en"),
                author=row["author"],
                content_format=row["content_format"],
                category=CategoryOption(
                    id=row["category_id"],
                    label_ar=categories[str(row["category_id"])]["label_ar"],
                ),
                edition_count=editions_of.get(str(row["id"]), 0),
                updated_at=row["updated_at"],
            )
            for row in self._repo.list_books()
        ]
        items.sort(key=lambda item: (item.title_ar, str(item.id)))
        return items

    def patch_book(self, book_id: UUID, body: PatchBookRequest) -> Book:
        with self._action("update", "book"):
            changes = body.to_changes()
            if (
                "category_id" in changes
                and self._repo.get("categories", changes["category_id"]) is None
            ):
                raise _invalid("categoryId", "category_not_found")
            try:
                self._update("books", book_id, changes, expected=body.expected_updated_at)
            except ContentInUseError:
                # The category vanished between the check and the write (foreign key refusal).
                raise _invalid("categoryId", "category_not_found") from None
            return self._pick(self._book_items(), book_id)

    def delete_book(self, book_id: UUID, body: ExpectedVersionRequest) -> None:
        with self._action("delete", "book"):
            self._delete("books", book_id, body)

    # -- categories ---------------------------------------------------------------------------

    def categories(self) -> CategoriesResponse:
        return CategoriesResponse(categories=self._category_items())

    def _category_items(self) -> list[Category]:
        books_of: dict[str, int] = {}
        for book in self._repo.list_books():
            key = str(book["category_id"])
            books_of[key] = books_of.get(key, 0) + 1
        items = [
            Category(
                id=row["id"],
                slug=row["slug"],
                label_ar=row["label_ar"],
                label_en=row.get("label_en"),
                display_order=row["display_order"],
                book_count=books_of.get(str(row["id"]), 0),
                updated_at=row["updated_at"],
            )
            for row in self._repo.list_categories()
        ]
        items.sort(key=lambda item: (item.display_order, item.label_ar, item.slug))
        return items

    def patch_category(self, category_id: UUID, body: PatchCategoryRequest) -> Category:
        with self._action("update", "category"):
            self._update(
                "categories", category_id, body.to_changes(), expected=body.expected_updated_at
            )
            return self._pick(self._category_items(), category_id)

    def delete_category(self, category_id: UUID, body: ExpectedVersionRequest) -> None:
        with self._action("delete", "category"):
            self._delete("categories", category_id, body)

    # -- sources ------------------------------------------------------------------------------

    def sources(self) -> SourcesResponse:
        return SourcesResponse(sources=self._source_items())

    def _source_items(self) -> list[Source]:
        editions_of: dict[str, int] = {}
        for edition in self._repo.list_editions():
            key = str(edition["source_id"])
            editions_of[key] = editions_of.get(key, 0) + 1
        items = [
            Source(
                id=row["id"],
                title=row["title"],
                provider=row["provider"],
                source_url=row["source_url"],
                license_url=row.get("license_url"),
                rights_status=row["rights_status"],
                checked_at=row.get("checked_at"),
                edition_count=editions_of.get(str(row["id"]), 0),
                updated_at=row["updated_at"],
            )
            for row in self._repo.list_sources()
        ]
        items.sort(key=lambda item: (item.title, str(item.id)))
        return items

    def patch_source(self, source_id: UUID, body: PatchSourceRequest) -> Source:
        with self._action("update", "source"):
            self._update("sources", source_id, body.to_changes(), expected=body.expected_updated_at)
            return self._pick(self._source_items(), source_id)

    def delete_source(self, source_id: UUID, body: ExpectedVersionRequest) -> None:
        with self._action("delete", "source"):
            self._delete("sources", source_id, body)

    @staticmethod
    def _pick(items: list[Any], row_id: UUID) -> Any:
        for item in items:
            if item.id == row_id:
                return item
        raise AppError(ErrorCode.not_found)
