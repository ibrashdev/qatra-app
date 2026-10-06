"""Data access of the content manager web admin (D91, docs/Content-admin.md).

Two implementations behind one small ``ContentAdminRepository`` protocol, both returning plain
``dict`` rows named after the database columns:

- ``MemoryContentAdminRepository`` (tests and memory mode): dict tables that start empty. It
  behaves like the database where the admin relies on it: ``updated_at`` moves on every update
  (the trigger), a delete is restricted by what uses the row (foreign keys ``23503``), an edition
  delete is refused unless it is a never-published draft (guard trigger ``23001``) and its
  dependent rows go with it (``ON DELETE CASCADE``), and the CHECK that keeps
  ``review_record.approval`` on every non-draft edition is enforced. Memory mode has no content
  bundles loader that retains verbatim units, so nothing is seeded from ``QATRA_CONTENT_BUNDLES``.
- ``PostgrestContentAdminRepository`` (supabase mode): PostgREST with a SEPARATE client whose
  ``apikey`` and ``Bearer`` token are both ``SUPABASE_SERVICE_ROLE_KEY``. Only the base content
  tables are read or written (the catalog views are not granted to ``service_role``); no learner
  or personal table is ever queried, and a learner reference is detected only by the database
  refusing a delete (``23503``). A refused service key is a configuration fault and answers
  ``unavailable``, never ``unauthenticated`` (that would sign the manager out).

Concurrency: ``update`` and ``delete`` take ``expected_updated_at`` and match
``updated_at=eq.<value>``; no match returns ``None`` (the service tells a stale write from a
missing row). ``book_sections`` has no ``updated_at``, so its writes pass ``None``.
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, Final, Protocol
from uuid import UUID

import httpx
from pydantic import SecretStr

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.providers.postgrest import DbSignal, PostgrestClient, TokenRefused

Row = dict[str, Any]

# Tables the admin may write. Reads of other tables go through the dedicated methods below.
EDITABLE_TABLES: Final = frozenset(
    {"categories", "books", "sources", "book_editions", "book_sections"}
)
QUESTION_TYPES: Final = ("word_order", "word_choice", "word_recall", "similar_distinction")
_ID_CHUNK = 40  # ids per ``in.(...)`` filter, which keeps the request URL short


class ContentAdminRepositoryError(Exception):
    """A refusal of the data layer that the service turns into ``409 version_conflict``."""


class ContentInUseError(ContentAdminRepositoryError):
    """Something still uses the row (foreign key ``23503``): reason ``in_use``."""


class ContentStateError(ContentAdminRepositoryError):
    """The row's state forbids the change (the edition delete guard ``23001``): reason ``state``."""


class ContentAdminRepository(Protocol):
    def counts(self) -> dict[str, int]:
        """Row counts of ``categories``, ``books`` and ``sources``."""

    def list_categories(self) -> list[Row]: ...

    def list_books(self) -> list[Row]: ...

    def list_sources(self) -> list[Row]: ...

    def list_editions(self) -> list[Row]:
        """Every edition, without ``review_record`` and ``content_hash``."""

    def get(self, table: str, row_id: str | UUID) -> Row | None:
        """One row of an editable table with all its admin columns, or ``None``."""

    def update(
        self,
        table: str,
        row_id: str | UUID,
        values: Mapping[str, Any],
        *,
        expected_updated_at: datetime | None,
        require: Mapping[str, Any] | None = None,
    ) -> Row | None:
        """The updated row, or ``None`` when no row matched id, ``updated_at`` and ``require``."""

    def delete(
        self, table: str, row_id: str | UUID, *, expected_updated_at: datetime | None
    ) -> bool:
        """``True`` when a row was deleted, ``False`` when none matched. Raises
        ``ContentInUseError`` or ``ContentStateError`` when the database refuses."""

    def list_sections(self, edition_id: str | UUID) -> list[Row]: ...

    def list_units(self, section_id: str | UUID) -> list[Row]: ...

    def list_jobs(self, edition_id: str | UUID) -> list[Row]: ...

    def edition_content_counts(self, edition_id: str | UUID, bank_version: int) -> dict[str, int]:
        """``sections``, ``units``, ``passages``, ``lessons`` and ``questions`` of the edition
        (passages, lessons and questions of that bank version)."""

    def question_counts(self, unit_ids: Sequence[str], bank_version: int) -> dict[str, int]:
        """Question items of the given units and bank version by type (``QUESTION_TYPES``)."""

    def redact_revoked_content(self, edition_id: str | UUID) -> None:
        """Call ``srv_redact_revoked_content`` (idempotent; the edition must be revoked)."""

    def upsert_job(
        self,
        *,
        edition_id: str | UUID,
        bank_version: int,
        pipeline_version: str,
        step: str,
        status: str,
    ) -> None:
        """Insert or merge the ``content_jobs`` row of ``(edition, bank version, step)``."""


def format_stamp(value: datetime) -> str:
    """A timestamp as a PostgREST filter value (UTC, microseconds, explicit offset)."""
    return value.astimezone(UTC).isoformat()


# --- memory --------------------------------------------------------------------------------------

_HAS_UPDATED_AT: Final = frozenset({"categories", "books", "sources", "book_editions"})


class MemoryContentAdminRepository:
    """In-memory content tables (see the module note). ``insert`` seeds rows (tests, demos).

    Test seams: ``learner_edition_ids`` (editions a learner plan or session uses: their delete is
    refused like the foreign key does), ``redacted`` (editions redact was called for) and
    ``fail_on`` (names ``"redact"`` and ``"job"`` make that step raise ``unavailable`` once the
    name is in the set).
    """

    def __init__(self, *, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))
        self.tables: dict[str, dict[str, Row]] = {
            "categories": {},
            "books": {},
            "sources": {},
            "book_editions": {},
            "book_sections": {},
            "units": {},
            "content_jobs": {},
            "passages": {},
            "lessons": {},
            "question_items": {},
        }
        self.learner_edition_ids: set[str] = set()
        self.redacted: list[str] = []
        self.fail_on: set[str] = set()
        self._last_tick: datetime | None = None

    def __repr__(self) -> str:
        return "MemoryContentAdminRepository()"

    # -- seeding and helpers ------------------------------------------------------------------

    def _tick(self, floor: datetime | None = None) -> datetime:
        """A strictly increasing timestamp, like the ``updated_at`` trigger of the database."""
        now = self._clock().astimezone(UTC)
        for earlier in (self._last_tick, floor):
            if earlier is not None and now <= earlier:
                now = earlier + timedelta(microseconds=1)
        self._last_tick = now
        return now

    def insert(self, table: str, row: Mapping[str, Any]) -> Row:
        """Add a row (its ``id`` is required); stamps ``created_at`` and ``updated_at``."""
        # ids are text, like the JSON of PostgREST
        stored = {
            key: str(value) if isinstance(value, UUID) else copy.deepcopy(value)
            for key, value in row.items()
        }
        stamp = self._tick()
        if table in _HAS_UPDATED_AT or table == "content_jobs":
            stored.setdefault("created_at", stamp)
            stored.setdefault("updated_at", stamp)
        self.tables[table][stored["id"]] = stored
        return copy.deepcopy(stored)

    def _rows(self, table: str, **match: Any) -> list[Row]:
        return [
            copy.deepcopy(row)
            for row in self.tables[table].values()
            if all(str(row.get(key)) == str(value) for key, value in match.items())
        ]

    # -- reads --------------------------------------------------------------------------------

    def counts(self) -> dict[str, int]:
        return {name: len(self.tables[name]) for name in ("categories", "books", "sources")}

    def list_categories(self) -> list[Row]:
        return self._rows("categories")

    def list_books(self) -> list[Row]:
        return self._rows("books")

    def list_sources(self) -> list[Row]:
        return self._rows("sources")

    def list_editions(self) -> list[Row]:
        rows = self._rows("book_editions")
        for row in rows:
            row.pop("review_record", None)
            row.pop("content_hash", None)
        return rows

    def get(self, table: str, row_id: str | UUID) -> Row | None:
        _require_editable(table)
        row = self.tables[table].get(str(row_id))
        return copy.deepcopy(row) if row is not None else None

    def list_sections(self, edition_id: str | UUID) -> list[Row]:
        rows = self._rows("book_sections", edition_id=edition_id)
        return sorted(rows, key=lambda row: row["ordinal"])

    def list_units(self, section_id: str | UUID) -> list[Row]:
        rows = self._rows("units", section_id=section_id)
        return sorted(rows, key=lambda row: row["ordinal"])

    def list_jobs(self, edition_id: str | UUID) -> list[Row]:
        rows = self._rows("content_jobs", edition_id=edition_id)
        return sorted(rows, key=lambda row: row["created_at"])

    def edition_content_counts(self, edition_id: str | UUID, bank_version: int) -> dict[str, int]:
        return {
            "sections": len(self._rows("book_sections", edition_id=edition_id)),
            "units": len(self._rows("units", edition_id=edition_id)),
            "passages": len(
                self._rows("passages", edition_id=edition_id, bank_version=bank_version)
            ),
            "lessons": len(self._rows("lessons", edition_id=edition_id, bank_version=bank_version)),
            "questions": len(
                self._rows("question_items", edition_id=edition_id, bank_version=bank_version)
            ),
        }

    def question_counts(self, unit_ids: Sequence[str], bank_version: int) -> dict[str, int]:
        wanted = {str(unit_id) for unit_id in unit_ids}
        counts = dict.fromkeys(QUESTION_TYPES, 0)
        for row in self.tables["question_items"].values():
            if str(row["unit_id"]) in wanted and row["bank_version"] == bank_version:
                if row["type"] in counts:
                    counts[row["type"]] += 1
        return counts

    # -- writes -------------------------------------------------------------------------------

    def update(
        self,
        table: str,
        row_id: str | UUID,
        values: Mapping[str, Any],
        *,
        expected_updated_at: datetime | None,
        require: Mapping[str, Any] | None = None,
    ) -> Row | None:
        _require_editable(table)
        row = self.tables[table].get(str(row_id))
        if row is None:
            return None
        if expected_updated_at is not None and row.get("updated_at") != expected_updated_at:
            return None
        if any(row.get(column) != value for column, value in (require or {}).items()):
            return None
        changed = {**row, **copy.deepcopy(dict(values))}
        if table == "book_editions":
            _check_approval(changed)
        if table in _HAS_UPDATED_AT:
            changed["updated_at"] = self._tick(floor=row.get("updated_at"))
        self.tables[table][str(row_id)] = changed
        return copy.deepcopy(changed)

    def delete(
        self, table: str, row_id: str | UUID, *, expected_updated_at: datetime | None
    ) -> bool:
        _require_editable(table)
        key = str(row_id)
        row = self.tables[table].get(key)
        if row is None:
            return False
        if expected_updated_at is not None and row.get("updated_at") != expected_updated_at:
            return False
        if table == "book_editions":
            self._guard_edition_delete(row)
        elif self._is_referenced(table, key):
            raise ContentInUseError
        del self.tables[table][key]
        if table == "book_editions":
            self._cascade_edition(key)
        return True

    def _is_referenced(self, table: str, key: str) -> bool:
        references = {
            "categories": ("books", "category_id"),
            "books": ("book_editions", "book_id"),
            "sources": ("book_editions", "source_id"),
        }
        target = references.get(table)
        if target is None:
            return False
        child, column = target
        return any(str(row.get(column)) == key for row in self.tables[child].values())

    def _guard_edition_delete(self, edition: Row) -> None:
        """``private.guard_edition_delete`` fires first (``23001``), then the foreign keys."""
        if edition["status"] != "draft":
            raise ContentStateError
        edition_id = str(edition["id"])
        if any(
            job["step"] == "published" and str(job["edition_id"]) == edition_id
            for job in self.tables["content_jobs"].values()
        ):
            raise ContentStateError
        if edition_id in self.learner_edition_ids:
            raise ContentInUseError

    def _cascade_edition(self, edition_id: str) -> None:
        for name in (
            "book_sections",
            "units",
            "passages",
            "lessons",
            "question_items",
            "content_jobs",
        ):
            table = self.tables[name]
            for key in [k for k, row in table.items() if str(row.get("edition_id")) == edition_id]:
                del table[key]

    def redact_revoked_content(self, edition_id: str | UUID) -> None:
        if "redact" in self.fail_on:
            raise AppError(ErrorCode.unavailable)
        edition = self.tables["book_editions"].get(str(edition_id))
        if edition is None or edition["status"] != "revoked":
            raise AppError(ErrorCode.internal)
        self.redacted.append(str(edition_id))

    def upsert_job(
        self,
        *,
        edition_id: str | UUID,
        bank_version: int,
        pipeline_version: str,
        step: str,
        status: str,
    ) -> None:
        if "job" in self.fail_on:
            raise AppError(ErrorCode.unavailable)
        for key, row in self.tables["content_jobs"].items():
            if (
                str(row["edition_id"]) == str(edition_id)
                and row["bank_version"] == bank_version
                and row["step"] == step
            ):
                self.tables["content_jobs"][key] = {
                    **row,
                    "pipeline_version": pipeline_version,
                    "status": status,
                    "updated_at": self._tick(floor=row.get("updated_at")),
                }
                return
        self.insert(
            "content_jobs",
            {
                "id": UUID(int=len(self.tables["content_jobs"]) + 1),
                "edition_id": str(edition_id),
                "bank_version": bank_version,
                "pipeline_version": pipeline_version,
                "step": step,
                "status": status,
                "published_at": None,
            },
        )


def _require_editable(table: str) -> None:
    if table not in EDITABLE_TABLES:
        raise ValueError("table is not editable by the admin")


def _check_approval(edition: Row) -> None:
    """``book_editions_status_approval_check``: nothing past ``validated`` without approval."""
    record = edition.get("review_record") or {}
    if edition["status"] not in ("draft", "validated") and "approval" not in record:
        raise ValueError("book_editions_status_approval_check")


# --- PostgREST -----------------------------------------------------------------------------------

_COLUMNS: Final[dict[str, str]] = {
    "categories": "id,slug,label_ar,label_en,display_order,updated_at",
    "books": "id,category_id,title_ar,title_en,author,content_format,updated_at",
    "sources": ("id,title,provider,source_url,license_url,rights_status,checked_at,updated_at"),
    "book_editions": (
        "id,book_id,source_id,edition_key,edition_label,language,version,bank_version,"
        "content_hash,status,review_record,catalog_hidden,archived_at,updated_at"
    ),
    "book_sections": "id,edition_id,ordinal,kind,reference,title_ar,title_en",
}
_EDITION_LIST_COLUMNS = (
    "id,book_id,source_id,edition_key,edition_label,language,version,bank_version,status,"
    "catalog_hidden,archived_at,updated_at"
)
_UNIT_COLUMNS = "id,ordinal,kind,reference,canonical_text"
_JOB_COLUMNS = "step,status,pipeline_version,bank_version,published_at,created_at,updated_at"
_JOB_CONFLICT = "edition_id,bank_version,step"


class PostgrestContentAdminRepository:
    """Content tables through PostgREST under the ``service_role`` key (see the module note)."""

    def __init__(self, client: PostgrestClient, service_key: SecretStr) -> None:
        self._client = client
        self._token = service_key

    def __repr__(self) -> str:
        return "PostgrestContentAdminRepository(<redacted>)"

    @classmethod
    def from_settings(
        cls, settings: Settings, *, transport: httpx.BaseTransport | None = None
    ) -> PostgrestContentAdminRepository:
        """Needs ``SUPABASE_URL`` and ``SUPABASE_SERVICE_ROLE_KEY``; the client is a separate one
        from the learner path and its ``apikey`` is the service key."""
        key = settings.SUPABASE_SERVICE_ROLE_KEY
        if settings.SUPABASE_URL is None or key is None:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
        return cls(PostgrestClient(settings.SUPABASE_URL, key, transport=transport), key)

    @contextmanager
    def _mapped(self) -> Iterator[None]:
        """Database signals become the repository's conditions; a refused service key is a
        deployment fault (``unavailable``), never ``unauthenticated``."""
        try:
            yield
        except TokenRefused:
            raise AppError(ErrorCode.unavailable) from None
        except DbSignal as signal:
            if signal.sqlstate == "23503":
                raise ContentInUseError from None
            if signal.sqlstate == "23001":
                raise ContentStateError from None
            raise AppError(ErrorCode.internal) from None

    def _select(
        self, table: str, columns: str, filters: Mapping[str, str] | None, order: str
    ) -> list[Row]:
        with self._mapped():
            return self._client.select_all(
                table, columns=columns, filters=filters, order=order, token=self._token
            )

    def _count(self, table: str, filters: Mapping[str, str] | None = None) -> int:
        with self._mapped():
            return self._client.count(table, filters=filters, token=self._token)

    # -- reads --------------------------------------------------------------------------------

    def counts(self) -> dict[str, int]:
        return {name: self._count(name) for name in ("categories", "books", "sources")}

    def list_categories(self) -> list[Row]:
        return self._select("categories", _COLUMNS["categories"], None, "id.asc")

    def list_books(self) -> list[Row]:
        return self._select("books", _COLUMNS["books"], None, "id.asc")

    def list_sources(self) -> list[Row]:
        return self._select("sources", _COLUMNS["sources"], None, "id.asc")

    def list_editions(self) -> list[Row]:
        return self._select("book_editions", _EDITION_LIST_COLUMNS, None, "id.asc")

    def get(self, table: str, row_id: str | UUID) -> Row | None:
        _require_editable(table)
        with self._mapped():
            rows = self._client.select(
                table,
                columns=_COLUMNS[table],
                filters={"id": f"eq.{row_id}"},
                limit=1,
                token=self._token,
            )
        return rows[0] if rows else None

    def list_sections(self, edition_id: str | UUID) -> list[Row]:
        return self._select(
            "book_sections",
            _COLUMNS["book_sections"],
            {"edition_id": f"eq.{edition_id}"},
            "ordinal.asc",
        )

    def list_units(self, section_id: str | UUID) -> list[Row]:
        return self._select(
            "units", _UNIT_COLUMNS, {"section_id": f"eq.{section_id}"}, "ordinal.asc"
        )

    def list_jobs(self, edition_id: str | UUID) -> list[Row]:
        return self._select(
            "content_jobs",
            _JOB_COLUMNS,
            {"edition_id": f"eq.{edition_id}"},
            "created_at.asc,step.asc",
        )

    def edition_content_counts(self, edition_id: str | UUID, bank_version: int) -> dict[str, int]:
        edition = {"edition_id": f"eq.{edition_id}"}
        banked = {**edition, "bank_version": f"eq.{bank_version}"}
        return {
            "sections": self._count("book_sections", edition),
            "units": self._count("units", edition),
            "passages": self._count("passages", banked),
            "lessons": self._count("lessons", banked),
            "questions": self._count("question_items", banked),
        }

    def question_counts(self, unit_ids: Sequence[str], bank_version: int) -> dict[str, int]:
        counts = dict.fromkeys(QUESTION_TYPES, 0)
        for start in range(0, len(unit_ids), _ID_CHUNK):
            chunk = ",".join(str(unit_id) for unit_id in unit_ids[start : start + _ID_CHUNK])
            for row in self._select(
                "question_items",
                "type",
                {"unit_id": f"in.({chunk})", "bank_version": f"eq.{bank_version}"},
                "id.asc",
            ):
                if row.get("type") in counts:
                    counts[row["type"]] += 1
        return counts

    # -- writes -------------------------------------------------------------------------------

    def update(
        self,
        table: str,
        row_id: str | UUID,
        values: Mapping[str, Any],
        *,
        expected_updated_at: datetime | None,
        require: Mapping[str, Any] | None = None,
    ) -> Row | None:
        _require_editable(table)
        filters = {"id": f"eq.{row_id}"}
        if expected_updated_at is not None:
            filters["updated_at"] = f"eq.{format_stamp(expected_updated_at)}"
        for column, value in (require or {}).items():
            filters[column] = f"eq.{value}"
        with self._mapped():
            rows = self._client.patch(table, filters=filters, values=values, token=self._token)
        return rows[0] if rows else None

    def delete(
        self, table: str, row_id: str | UUID, *, expected_updated_at: datetime | None
    ) -> bool:
        _require_editable(table)
        filters = {"id": f"eq.{row_id}"}
        if expected_updated_at is not None:
            filters["updated_at"] = f"eq.{format_stamp(expected_updated_at)}"
        with self._mapped():
            rows = self._client.delete(table, filters=filters, token=self._token)
        return bool(rows)

    def redact_revoked_content(self, edition_id: str | UUID) -> None:
        with self._mapped():
            self._client.rpc(
                "srv_redact_revoked_content", {"p_edition_id": str(edition_id)}, token=self._token
            )

    def upsert_job(
        self,
        *,
        edition_id: str | UUID,
        bank_version: int,
        pipeline_version: str,
        step: str,
        status: str,
    ) -> None:
        row = {
            "edition_id": str(edition_id),
            "bank_version": bank_version,
            "pipeline_version": pipeline_version,
            "step": step,
            "status": status,
        }
        with self._mapped():
            self._client.upsert(
                "content_jobs", rows=[row], on_conflict=_JOB_CONFLICT, token=self._token
            )
