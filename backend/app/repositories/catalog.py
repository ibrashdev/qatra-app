"""Catalog and passage reads for the planning package (API-spec E14, Database-schema §7).

Two sources behind the same small protocols:

- **Memory mode** (``QATRA_DATA_BACKEND=memory``): the editions come from the content bundles
  listed in ``QATRA_CONTENT_BUNDLES`` (format v1, produced by the content workflow). Only
  catalog metadata and the passage table (ids, section, path, order, word count) are kept; the
  verbatim text, lessons and questions of a bundle are never retained here. No bundle means an
  empty catalog.
- **Supabase mode**: the catalog is read through PostgREST with the anon key over the two public
  views ``public.catalog_editions`` and ``public.catalog_sections`` and nothing else (no session;
  a cookie, if one was sent, is never looked at). Passages, which the anon role may not read, are
  read with the learner's access token under row-level security (the passage table holds ids,
  paths and counts, no text).

Whole-unit counts (D92): a surah section carries its ayah count (``SectionData.unit_count``) so
that the plan can tell the learner "3 ayat a day". Memory mode counts the bundle's ayah units. The
public views do not expose units (and this package adds no migration), so Supabase mode uses
``QURAN_AYAH_COUNTS``, the table the content workflow validates every published surah against
(``ayat_count`` in ``workflow.validation``): both give the same number for a published edition.
A surah outside that table has no count, and the plan then shows the words figure instead.

Editions are ordered by ``edition_key``. API-spec §1.13 says "category display order, then
``editionKey``", but the views do not expose ``categories.display_order`` and the content
publisher leaves it at its default 0, so the two orders coincide until a category is given a
different display order (reported to the coordinator).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

from app.contracts_plan_chat import PATH_ORDER
from app.dependencies import SessionContext
from app.domain.plan_policy import (
    EditionData,
    PassageRow,
    SectionData,
    canonical_paths,
)
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.postgrest import PostgrestClient, require_token
from app.workflow.bundle import loads_bundle
from app.workflow.editions import QURAN_AYAH_COUNTS
from app.workflow.errors import InputError

logger = logging.getLogger("qatra.catalog")

EDITION_COLUMNS = (
    "edition_id,edition_key,edition_label,catalog_version,book_title_ar,book_title_en,author,"
    "content_format,category_slug,category_label_ar,category_label_en,available_paths,"
    "path_word_counts,path_passage_counts"
)
SECTION_COLUMNS = "edition_id,section_id,ordinal,kind,reference,title_ar,title_en,path_stats"
PASSAGE_COLUMNS = "id,section_id,path,ordinal,word_count"


class CatalogRepository(Protocol):
    def list_editions(self) -> list[EditionData]:
        """Published, non-revoked, non-hidden editions ordered by ``edition_key``."""

    def get_edition(self, edition_id: UUID) -> EditionData | None:
        """One such edition, or ``None`` (unknown, unpublished, revoked, hidden or archived)."""


class PassageReader(Protocol):
    def passages(self, ctx: SessionContext, edition: EditionData) -> list[PassageRow]:
        """The passages of the edition's current bank version."""


# --- memory mode: bundles ------------------------------------------------------------------------


class BundleLoadError(Exception):
    """A bundle could not be read. The message names nothing from the bundle (no values)."""


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("count")
    return value


def _text(value: Any) -> str:
    """A required text column: the schema makes these non-empty (Database-schema §6.1)."""
    if not isinstance(value, str) or not value:
        raise ValueError("text")
    return value


def _choice(value: Any, allowed: frozenset[str]) -> str:
    if value not in allowed:
        raise ValueError("choice")
    return str(value)


_FORMATS = frozenset({"quran", "hadith_collection"})
_KINDS = frozenset({"surah", "hadith"})


def _ayah_count(kind: str, reference: str, counted: int | None) -> int | None:
    """The ayat of a surah section (D92): the ``counted`` units when the source has them, else the
    validated per-surah table (the section ``reference`` is the surah number). ``None`` for a
    hadith section or a surah the table does not know."""
    if kind != "surah":
        return None
    if counted:
        return counted
    return QURAN_AYAH_COUNTS.get(int(reference)) if reference.isdecimal() else None


def edition_from_bundle(bundle: Mapping[str, Any]) -> tuple[EditionData, tuple[PassageRow, ...]]:
    """Catalog data of one bundle (contract §2.6). Reads metadata, sections and passages only."""
    try:
        book, category, edition = bundle["book"], bundle["category"], bundle["edition"]
        passages = tuple(
            PassageRow(
                passage_id=UUID(str(raw["id"])),
                section_ordinal=_count(raw["sectionOrdinal"]),
                path=_choice(raw["path"], frozenset(PATH_ORDER)),
                ordinal=_count(raw["ordinal"]),
                words=_count(raw["wordCount"]),
            )
            for raw in bundle["passages"]
        )
        words: dict[int, dict[str, int]] = {}
        counts: dict[int, dict[str, int]] = {}
        for row in passages:
            words.setdefault(row.section_ordinal, {}).setdefault(row.path, 0)
            words[row.section_ordinal][row.path] += row.words
            counts.setdefault(row.section_ordinal, {}).setdefault(row.path, 0)
            counts[row.section_ordinal][row.path] += 1
        ayat: dict[int, int] = {}
        for unit in bundle.get("units") or ():
            if unit.get("kind") == "ayah":
                ayat[unit["sectionOrdinal"]] = ayat.get(unit["sectionOrdinal"], 0) + 1
        sections = tuple(
            SectionData(
                section_id=_text(raw["id"]),
                ordinal=_count(raw["ordinal"]),
                kind=_choice(raw["kind"], _KINDS),
                reference=_text(raw["reference"]),
                title_ar=_text(raw["titleAr"]),
                title_en=_text(raw["titleEn"]),
                path_words=words.get(raw["ordinal"], {}),
                path_passages=counts.get(raw["ordinal"], {}),
                unit_count=_ayah_count(
                    _choice(raw["kind"], _KINDS),
                    _text(raw["reference"]),
                    ayat.get(raw["ordinal"]),
                ),
            )
            for raw in sorted(bundle["sections"], key=lambda item: item["ordinal"])
        )
        available = canonical_paths(row.path for row in passages)
        data = EditionData(
            edition_id=UUID(str(edition["id"])),
            edition_key=_text(bundle["editionKey"]),
            edition_label=_text(edition["editionLabel"]),
            title_ar=_text(book["titleAr"]),
            title_en=_optional_text(book.get("titleEn")),
            author=_text(book["author"]),
            category_slug=_text(category["slug"]),
            category_label_ar=_text(category["labelAr"]),
            category_label_en=_optional_text(category.get("labelEn")),
            catalog_version=_count(bundle["bankVersion"]),
            content_format=_choice(book["contentFormat"], _FORMATS),
            available_paths=available,
            path_words={p: sum(w.get(p, 0) for w in words.values()) for p in available},
            path_passages={p: sum(c.get(p, 0) for c in counts.values()) for p in available},
            sections=sections,
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        raise BundleLoadError("a content bundle is malformed") from None
    return data, passages


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


class MemoryContent:
    """The editions and passages of the loaded bundles (read-only after construction)."""

    def __init__(self, entries: Sequence[tuple[EditionData, Sequence[PassageRow]]] = ()) -> None:
        self._editions: dict[UUID, EditionData] = {}
        self._passages: dict[UUID, list[PassageRow]] = {}
        for edition, passages in entries:
            if edition.edition_id in self._editions:
                raise BundleLoadError("two bundles describe the same edition")
            self._editions[edition.edition_id] = edition
            self._passages[edition.edition_id] = list(passages)

    @classmethod
    def from_bundles(cls, bundles: Sequence[Mapping[str, Any]]) -> MemoryContent:
        return cls([edition_from_bundle(bundle) for bundle in bundles])

    @classmethod
    def from_paths(cls, raw: str | None) -> MemoryContent:
        """``QATRA_CONTENT_BUNDLES``: comma-separated bundle file paths (empty = no editions)."""
        paths = [item.strip() for item in (raw or "").split(",") if item.strip()]
        bundles = []
        for path in paths:
            try:
                bundles.append(loads_bundle(Path(path).read_text(encoding="utf-8")))
            except (OSError, UnicodeDecodeError, InputError):
                raise BundleLoadError("a content bundle cannot be read") from None
        return cls.from_bundles(bundles)

    def editions(self) -> list[EditionData]:
        return sorted(self._editions.values(), key=lambda item: item.edition_key)

    def edition(self, edition_id: UUID) -> EditionData | None:
        return self._editions.get(edition_id)

    def passages(self, edition_id: UUID) -> list[PassageRow]:
        return list(self._passages.get(edition_id, ()))

    def titles(self, edition_id: UUID) -> tuple[str, str]:
        """``(titleAr, titleEn)`` of an edition; a missing English title falls back to Arabic."""
        edition = self._editions.get(edition_id)
        if edition is None:
            return "", ""
        return edition.title_ar, edition.title_en or edition.title_ar


class MemoryCatalogRepository:
    def __init__(self, content: MemoryContent) -> None:
        self._content = content

    def list_editions(self) -> list[EditionData]:
        return self._content.editions()

    def get_edition(self, edition_id: UUID) -> EditionData | None:
        return self._content.edition(edition_id)


class MemoryPassageReader:
    def __init__(self, content: MemoryContent) -> None:
        self._content = content

    def passages(self, ctx: SessionContext, edition: EditionData) -> list[PassageRow]:
        return self._content.passages(edition.edition_id)


# --- supabase mode: PostgREST --------------------------------------------------------------------


def _fail(kind: str) -> AppError:
    """A row that does not have the documented shape: schema drift, answered ``internal``."""
    log_event(logger, "catalog_row_invalid", level=logging.ERROR, kind=kind)
    return AppError(ErrorCode.internal)


def _int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        raise ValueError("number")
    return int(value)


def _path_numbers(value: Any) -> dict[str, int]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("object")
    return {str(path): _int(count) for path, count in value.items() if path in PATH_ORDER}


def _section_from_row(row: Mapping[str, Any]) -> SectionData:
    stats = row.get("path_stats") or {}
    if not isinstance(stats, dict):
        raise ValueError("path_stats")
    words: dict[str, int] = {}
    passages: dict[str, int] = {}
    for path, item in stats.items():
        if path not in PATH_ORDER:
            continue
        if not isinstance(item, dict):
            raise ValueError("path_stats")
        words[path] = _int(item.get("words"))
        passages[path] = _int(item.get("passages"))
    kind = _choice(row["kind"], _KINDS)
    reference = _text(row["reference"])
    return SectionData(
        section_id=_text(row["section_id"]),
        ordinal=_int(row["ordinal"]),
        kind=kind,
        reference=reference,
        title_ar=_text(row["title_ar"]),
        title_en=_text(row["title_en"]),
        path_words=words,
        path_passages=passages,
        unit_count=_ayah_count(kind, reference, None),
    )


def _edition_from_rows(row: Mapping[str, Any], sections: Sequence[SectionData]) -> EditionData:
    available = row.get("available_paths") or []
    if not isinstance(available, list):
        raise ValueError("available_paths")
    return EditionData(
        edition_id=UUID(str(row["edition_id"])),
        edition_key=_text(row["edition_key"]),
        edition_label=_text(row["edition_label"]),
        title_ar=_text(row["book_title_ar"]),
        title_en=_optional_text(row.get("book_title_en")),
        author=_text(row["author"]),
        category_slug=_text(row["category_slug"]),
        category_label_ar=_text(row["category_label_ar"]),
        category_label_en=_optional_text(row.get("category_label_en")),
        catalog_version=_int(row["catalog_version"]),
        content_format=_choice(row["content_format"], _FORMATS),
        available_paths=canonical_paths(item for item in available if item in PATH_ORDER),
        path_words=_path_numbers(row.get("path_word_counts")),
        path_passages=_path_numbers(row.get("path_passage_counts")),
        sections=tuple(sorted(sections, key=lambda section: section.ordinal)),
    )


class PostgrestCatalogRepository:
    """The anon view reads of E14 (no session, no token)."""

    def __init__(self, client: PostgrestClient) -> None:
        self._client = client

    def list_editions(self) -> list[EditionData]:
        edition_rows = self._client.select(
            "catalog_editions", columns=EDITION_COLUMNS, order="edition_key.asc"
        )
        section_rows = self._client.select(
            "catalog_sections", columns=SECTION_COLUMNS, order="ordinal.asc"
        )
        return self._assemble(edition_rows, section_rows)

    def get_edition(self, edition_id: UUID) -> EditionData | None:
        filters = {"edition_id": f"eq.{edition_id}"}
        edition_rows = self._client.select(
            "catalog_editions", columns=EDITION_COLUMNS, filters=filters
        )
        if not edition_rows:
            return None
        section_rows = self._client.select(
            "catalog_sections", columns=SECTION_COLUMNS, filters=filters, order="ordinal.asc"
        )
        editions = self._assemble(edition_rows, section_rows)
        return editions[0] if editions else None

    @staticmethod
    def _assemble(
        edition_rows: Sequence[Mapping[str, Any]], section_rows: Sequence[Mapping[str, Any]]
    ) -> list[EditionData]:
        try:
            by_edition: dict[str, list[SectionData]] = {}
            for row in section_rows:
                by_edition.setdefault(str(row["edition_id"]), []).append(_section_from_row(row))
            editions = [
                _edition_from_rows(row, by_edition.get(str(row["edition_id"]), []))
                for row in edition_rows
            ]
        except (KeyError, TypeError, ValueError, AttributeError):
            raise _fail("catalog_shape") from None
        return sorted(editions, key=lambda item: item.edition_key)


class PostgrestPassageReader:
    """The passage table under the learner's token (RLS: published or superseded editions, the
    edition's current bank version)."""

    def __init__(self, client: PostgrestClient) -> None:
        self._client = client

    def passages(self, ctx: SessionContext, edition: EditionData) -> list[PassageRow]:
        rows = self._client.select(
            "passages",
            columns=PASSAGE_COLUMNS,
            filters={
                "edition_id": f"eq.{edition.edition_id}",
                "bank_version": f"eq.{edition.catalog_version}",
            },
            order="path.asc,ordinal.asc",
            token=require_token(ctx.access_token),
        )
        ordinal_of = {section.section_id: section.ordinal for section in edition.sections}
        try:
            return [
                PassageRow(
                    passage_id=UUID(str(row["id"])),
                    section_ordinal=ordinal_of[str(row["section_id"])],
                    path=_choice(row["path"], frozenset(PATH_ORDER)),
                    ordinal=_int(row["ordinal"]),
                    words=_int(row["word_count"]),
                )
                for row in rows
                if str(row.get("section_id")) in ordinal_of
            ]
        except (KeyError, TypeError, ValueError):
            raise _fail("passage_shape") from None
