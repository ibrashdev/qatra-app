"""Question-bank reads for session preparation (package B5): passages, parts, questions, units,
sections, lessons and edition facts, always by edition, pinned bank version, scope and paths.

Two implementations of ``BankRepository``:

- ``InMemoryBankRepository`` (memory mode): built from the content bundles listed in
  ``QATRA_CONTENT_BUNDLES`` (contract §2.6; tests use the committed synthetic bundles).
- ``PostgrestBankRepository`` (supabase mode): reads through PostgREST with the learner's access
  token as ``Authorization: Bearer`` and the anon key as ``apikey``, so row-level security applies
  (Database-schema §4.5): learners see only ``published`` or ``superseded`` editions, the bank
  version of the edition, and published questions; a ``revoked`` edition is never readable (A-02,
  D44). Without a token (``ctx.access_token is None``) every call is ``unauthenticated``.

Both return the same immutable value objects. ``LearnerClient`` below puts the error mapping of
the session endpoints on the shared ``PostgrestClient`` (``app/providers/postgrest.py``), which does
all the HTTP; ``repositories/learning.py`` uses it too.

Error mapping (the same for every call): a transport failure, a 5xx, an unexpected answer or a
privilege fault of the deployment is ``unavailable``; ``401`` or an expired token is
``unauthenticated``; ``QT002`` (the migration's version conflict) is ``version_conflict`` with
``details.reason = "plan_version"``; ``P0002`` (no data found) is ``not_found``; any other database
signal is ``unavailable``. The token, request bodies and response bodies are never logged: only the
HTTP status and the PostgREST error code.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Final, Protocol, TypeVar
from uuid import UUID

from app.config import Settings, StartupConfigError
from app.dependencies import SessionContext
from app.domain.session_policy import PartInfo, PassageInfo, QuestionInfo
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.postgrest import DbSignal, PostgrestClient, TokenRefused, require_token
from app.workflow.bundle import loads_bundle
from app.workflow.bundle_index import parse_ref
from app.workflow.errors import WorkflowError

logger = logging.getLogger("qatra.bank")

T = TypeVar("T")

READABLE_STATUSES: Final = ("published", "superseded")
DEFAULT_PATHS: Final[Mapping[str, tuple[str, ...]]] = {
    "quran": ("quran",),
    "hadith_collection": ("matn",),  # the Forty defaults to the matn path (contract §5)
}
_IN_CHUNK = 40  # ids per ``in.(...)`` filter, so a URL stays short


# --- value objects --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BankToken:
    """A token of a unit (contract §2.2): ``s``/``e`` are offsets into the unit's text."""

    i: int
    s: int
    e: int
    k: str
    n: str
    a: str | None = None


@dataclass(frozen=True, slots=True)
class BankUnit:
    """A verbatim unit. ``section_ordinal`` is only set when the unit was read as part of a
    section (``section_units``) or in memory mode."""

    ordinal: int
    kind: str
    reference: str
    source_url: str | None
    text: str
    tokens: tuple[BankToken, ...]
    hadith_meta: Mapping[str, Any] | None = None
    section_ordinal: int | None = None

    def surface(self, index: int) -> str:
        """The text of token ``index`` exactly as stored (marks and attached punctuation kept)."""
        token = self.tokens[index]
        return self.text[token.s : token.e]

    def token(self, index: int) -> BankToken:
        return self.tokens[index]


@dataclass(frozen=True, slots=True)
class BankSection:
    ordinal: int
    kind: str
    reference: str
    title_ar: str
    title_en: str
    source_url: str | None


@dataclass(frozen=True, slots=True)
class BankPart:
    id: UUID
    ordinal: int
    start_ref: str
    end_ref: str
    word_count: int


@dataclass(frozen=True, slots=True)
class BankPassage:
    id: UUID
    section_ordinal: int
    ordinal: int
    path: str
    start_ref: str
    end_ref: str
    word_count: int
    reference: str
    parts: tuple[BankPart, ...]

    def info(self) -> PassageInfo:
        start = parse_ref(self.start_ref)
        if start is None:
            raise ValueError("a passage needs a token reference as its start")
        return PassageInfo(
            id=self.id,
            section_ordinal=self.section_ordinal,
            path=self.path,
            ordinal=self.ordinal,
            start=start,
            word_count=self.word_count,
            parts=tuple(
                PartInfo(part.id, part.ordinal, part.word_count)
                for part in sorted(self.parts, key=lambda p: p.ordinal)
            ),
        )


@dataclass(frozen=True, slots=True)
class BankQuestion:
    """A bank question: only token references, never text (D31); text is read from the units."""

    id: UUID
    passage_id: UUID
    type: str
    variant: str | None
    covered_part_ids: tuple[UUID, ...]
    token_refs: tuple[str, ...]
    option_refs: tuple[tuple[str, ...], ...] | None
    correct_ref: tuple[str, ...]
    context_refs: tuple[str, ...]
    reference: str

    def info(self) -> QuestionInfo:
        return QuestionInfo(
            id=self.id,
            passage_id=self.passage_id,
            type=self.type,
            variant=self.variant,
            covered_part_ids=self.covered_part_ids,
        )


@dataclass(frozen=True, slots=True)
class EditionInfo:
    """Facts about a readable edition. ``revoked`` editions are never returned."""

    edition_id: UUID
    edition_key: str
    status: str  # published | superseded
    hidden: bool  # catalog_hidden or archived: stops NEW selection only (D44)
    bank_version: int  # the bank version learners read: the catalog version
    content_format: str  # quran | hadith_collection
    edition_label: str
    book_title_ar: str
    source_title: str
    source_provider: str
    source_url: str

    @property
    def default_paths(self) -> tuple[str, ...]:
        """The paths a placement test samples and a new plan starts with (contract §5)."""
        return DEFAULT_PATHS.get(self.content_format, ())

    @property
    def selectable(self) -> bool:
        """May be chosen for a new plan, placement or snapshot: published and not hidden (S-2)."""
        return self.status == "published" and not self.hidden


class BankRepository(Protocol):
    """Reads of the published bank. Every method takes the caller's context; ``passages`` and
    ``questions`` take the pinned bank version and return nothing for another one."""

    def edition(self, ctx: SessionContext, edition_id: UUID) -> EditionInfo | None:
        """The readable edition, or ``None`` when unknown or revoked (never served)."""

    def passages(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        section_ordinals: Sequence[int],
        paths: Sequence[str],
    ) -> list[BankPassage]:
        """The passages of the scope on the given paths, with their parts (any order)."""

    def questions(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        passage_ids: Sequence[UUID],
    ) -> list[BankQuestion]:
        """The published questions of those passages."""

    def sections(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int]
    ) -> dict[int, BankSection]:
        """The existing sections among ``ordinals``, by ordinal."""

    def units(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int]
    ) -> dict[int, BankUnit]:
        """The units with those ordinals, by ordinal (option and context tokens may lie outside
        the scope: technical distractors, D31)."""

    def section_units(
        self, ctx: SessionContext, edition_id: UUID, section_ordinals: Sequence[int]
    ) -> list[BankUnit]:
        """Every unit of those sections (with ``section_ordinal`` set), in unit order."""

    def lessons(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        passage_ids: Sequence[UUID],
    ) -> dict[UUID, UUID]:
        """Lesson id by passage id."""


def _integrity_error() -> AppError:
    return AppError(ErrorCode.internal)


# --- memory mode ----------------------------------------------------------------------------------


@dataclass(slots=True)
class _EditionData:
    info: EditionInfo
    sections: dict[int, BankSection]
    units: dict[int, BankUnit]
    passages: tuple[BankPassage, ...]
    questions: tuple[BankQuestion, ...]
    lessons: dict[UUID, UUID]


def _refs(value: Any) -> tuple[str, ...]:
    return tuple(str(ref) for ref in value)


def _parse_bundle(bundle: Mapping[str, Any]) -> _EditionData:
    """A content bundle (contract §2.6) as value objects. Raises ``ValueError``/``KeyError`` on a
    malformed bundle; callers convert that into a configuration error."""
    book, source, edition = bundle["book"], bundle["source"], bundle["edition"]
    info = EditionInfo(
        edition_id=UUID(str(edition["id"])),
        edition_key=str(bundle["editionKey"]),
        status="published",
        hidden=False,
        bank_version=int(bundle["bankVersion"]),
        content_format=str(book["contentFormat"]),
        edition_label=str(edition["editionLabel"]),
        book_title_ar=str(book["titleAr"]),
        source_title=str(source["title"]),
        source_provider=str(source["provider"]),
        source_url=str(source["sourceUrl"]),
    )
    sections = {
        int(s["ordinal"]): BankSection(
            ordinal=int(s["ordinal"]),
            kind=str(s["kind"]),
            reference=str(s["reference"]),
            title_ar=str(s["titleAr"]),
            title_en=str(s["titleEn"]),
            source_url=s.get("sourceUrl"),
        )
        for s in bundle["sections"]
    }
    units = {
        int(u["ordinal"]): BankUnit(
            ordinal=int(u["ordinal"]),
            kind=str(u["kind"]),
            reference=str(u["reference"]),
            source_url=u.get("sourceUrl"),
            text=str(u["canonicalText"]),
            tokens=tuple(
                BankToken(
                    i=int(t["i"]),
                    s=int(t["s"]),
                    e=int(t["e"]),
                    k=str(t["k"]),
                    n=str(t["n"]),
                    a=t.get("a"),
                )
                for t in u["tokens"]
            ),
            hadith_meta=u.get("hadithMeta"),
            section_ordinal=int(u["sectionOrdinal"]),
        )
        for u in bundle["units"]
    }
    passages = tuple(
        BankPassage(
            id=UUID(str(p["id"])),
            section_ordinal=int(p["sectionOrdinal"]),
            ordinal=int(p["ordinal"]),
            path=str(p["path"]),
            start_ref=str(p["startRef"]),
            end_ref=str(p["endRef"]),
            word_count=int(p["wordCount"]),
            reference=str(p["reference"]),
            parts=tuple(
                BankPart(
                    id=UUID(str(part["id"])),
                    ordinal=int(part["ordinal"]),
                    start_ref=str(part["startRef"]),
                    end_ref=str(part["endRef"]),
                    word_count=int(part["wordCount"]),
                )
                for part in p["parts"]
            ),
        )
        for p in bundle["passages"]
    )
    questions = tuple(
        BankQuestion(
            id=UUID(str(q["id"])),
            passage_id=UUID(str(q["passageId"])),
            type=str(q["type"]),
            variant=q.get("variant"),
            covered_part_ids=tuple(UUID(str(part)) for part in q["coveredPartIds"]),
            token_refs=_refs(q["tokenRefs"]),
            option_refs=(
                None if q.get("optionRefs") is None else tuple(_refs(o) for o in q["optionRefs"])
            ),
            correct_ref=_refs(q["correctRef"]),
            context_refs=_refs(q["contextRefs"]),
            reference=str(q["reference"]),
        )
        for q in bundle["questions"]
    )
    lessons = {UUID(str(x["passageId"])): UUID(str(x["id"])) for x in bundle["lessons"]}
    return _EditionData(info, sections, units, passages, questions, lessons)


class InMemoryBankRepository:
    """Memory-mode bank over content bundles. Every edition starts ``published``; ``set_status``
    lets a test or a developer simulate supersession, hiding and revocation."""

    def __init__(self, bundles: Iterable[Mapping[str, Any]] = ()) -> None:
        self._editions: dict[UUID, _EditionData] = {}
        for bundle in bundles:
            self.add_bundle(bundle)

    @classmethod
    def from_settings(cls, settings: Settings) -> InMemoryBankRepository:
        """Load the bundles of ``QATRA_CONTENT_BUNDLES`` (comma-separated paths); none is fine."""
        raw = settings.QATRA_CONTENT_BUNDLES or ""
        repository = cls()
        for position, name in enumerate(item.strip() for item in raw.split(",") if item.strip()):
            try:
                repository.add_bundle(loads_bundle(Path(name).read_text(encoding="utf-8")))
            except (OSError, ValueError, KeyError, TypeError, WorkflowError):
                # Names only: neither the path nor the parser's message is repeated.
                raise StartupConfigError(
                    [f"QATRA_CONTENT_BUNDLES entry {position + 1} is not a readable content bundle"]
                ) from None
        return repository

    def add_bundle(self, bundle: Mapping[str, Any]) -> UUID:
        data = _parse_bundle(bundle)
        self._editions[data.info.edition_id] = data
        return data.info.edition_id

    def set_status(self, edition_id: UUID, status: str, *, hidden: bool = False) -> None:
        """Simulate the edition lifecycle: ``published``, ``superseded`` or ``revoked``."""
        data = self._editions[edition_id]
        data.info = replace(data.info, status=status, hidden=hidden)

    def _readable(self, edition_id: UUID) -> _EditionData | None:
        data = self._editions.get(edition_id)
        return data if data is not None and data.info.status in READABLE_STATUSES else None

    def edition(self, ctx: SessionContext, edition_id: UUID) -> EditionInfo | None:
        data = self._readable(edition_id)
        return None if data is None else data.info

    def passages(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        section_ordinals: Sequence[int],
        paths: Sequence[str],
    ) -> list[BankPassage]:
        data = self._readable(edition_id)
        if data is None or data.info.bank_version != bank_version:
            return []
        sections, wanted = set(section_ordinals), set(paths)
        return [p for p in data.passages if p.section_ordinal in sections and p.path in wanted]

    def questions(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        passage_ids: Sequence[UUID],
    ) -> list[BankQuestion]:
        data = self._readable(edition_id)
        if data is None or data.info.bank_version != bank_version:
            return []
        wanted = set(passage_ids)
        return [q for q in data.questions if q.passage_id in wanted]

    def sections(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int]
    ) -> dict[int, BankSection]:
        data = self._readable(edition_id)
        if data is None:
            return {}
        return {o: data.sections[o] for o in ordinals if o in data.sections}

    def units(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int]
    ) -> dict[int, BankUnit]:
        data = self._readable(edition_id)
        if data is None:
            return {}
        return {o: data.units[o] for o in ordinals if o in data.units}

    def section_units(
        self, ctx: SessionContext, edition_id: UUID, section_ordinals: Sequence[int]
    ) -> list[BankUnit]:
        data = self._readable(edition_id)
        if data is None:
            return []
        wanted = set(section_ordinals)
        return sorted(
            (u for u in data.units.values() if u.section_ordinal in wanted),
            key=lambda u: u.ordinal,
        )

    def lessons(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        passage_ids: Sequence[UUID],
    ) -> dict[UUID, UUID]:
        data = self._readable(edition_id)
        if data is None or data.info.bank_version != bank_version:
            return {}
        return {pid: data.lessons[pid] for pid in passage_ids if pid in data.lessons}


# --- PostgREST ------------------------------------------------------------------------------------


def _signal_error(signal: DbSignal) -> AppError:
    """Only QT002 and P0002 are known here; any other signal is logged by code and answered 503."""
    if signal.sqlstate == "QT002":
        return AppError(ErrorCode.version_conflict, details={"reason": "plan_version"})
    if signal.sqlstate == "P0002":
        return AppError(ErrorCode.not_found)
    log_event(logger, "db_signal_unexpected", level=logging.WARNING, sqlstate=signal.sqlstate)
    return AppError(ErrorCode.unavailable)


class LearnerClient:
    """The shared client acting as the learner: the token comes from the caller's context (without
    one nothing is sent) and failures are answered as the module docstring says."""

    def __init__(self, client: PostgrestClient) -> None:
        self._client = client

    def __repr__(self) -> str:
        return "LearnerClient(<redacted>)"

    def select(
        self,
        ctx: SessionContext,
        table: str,
        *,
        columns: str,
        filters: Mapping[str, str] | None = None,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return self._run(
            lambda: self._client.select(
                table,
                columns=columns,
                filters=filters,
                order=order,
                limit=limit,
                token=require_token(ctx.access_token),
            )
        )

    def select_all(
        self,
        ctx: SessionContext,
        table: str,
        *,
        columns: str,
        filters: Mapping[str, str] | None = None,
        order: str,
    ) -> list[dict[str, Any]]:
        return self._run(
            lambda: self._client.select_all(
                table,
                columns=columns,
                filters=filters,
                order=order,
                token=require_token(ctx.access_token),
            )
        )

    def rpc(self, ctx: SessionContext, function: str, arguments: Mapping[str, Any]) -> Any:
        return self._run(
            lambda: self._client.rpc(function, arguments, token=require_token(ctx.access_token))
        )

    def patch(
        self,
        ctx: SessionContext,
        table: str,
        *,
        filters: Mapping[str, str],
        values: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        return self._run(
            lambda: self._client.patch(
                table, filters=filters, values=values, token=require_token(ctx.access_token)
            )
        )

    @staticmethod
    def _run(call: Callable[[], T]) -> T:
        try:
            return call()
        except DbSignal as signal:
            raise _signal_error(signal) from None
        except TokenRefused as refused:
            if refused.privilege:  # a missing grant is no reason to end the learner's session
                raise AppError(ErrorCode.unavailable) from None
            raise
        except AppError as error:
            if error.code is ErrorCode.internal:  # an answer the client could not make sense of
                raise AppError(ErrorCode.unavailable) from None
            raise


def in_filter(values: Iterable[Any]) -> str:
    """PostgREST ``in.(a,b,c)`` filter value."""
    return "in.(" + ",".join(str(value) for value in values) + ")"


def chunks(items: Sequence[T], size: int = _IN_CHUNK) -> list[Sequence[T]]:
    return [items[start : start + size] for start in range(0, len(items), size)]


def parse_or_internal(parse: Callable[[], T]) -> T:
    """Row parsing: a row that does not have the documented shape is an integrity problem."""
    try:
        return parse()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise _integrity_error() from None


class PostgrestBankRepository:
    """Supabase-mode bank reads as the learner (row-level security applies). ``in_chunk`` is how
    many ids one ``in.(...)`` filter carries, so that a URL stays short."""

    def __init__(self, client: PostgrestClient, *, in_chunk: int = _IN_CHUNK) -> None:
        self._rest = LearnerClient(client)
        self._chunk = max(1, in_chunk)

    def __repr__(self) -> str:
        return "PostgrestBankRepository(<redacted>)"

    def edition(self, ctx: SessionContext, edition_id: UUID) -> EditionInfo | None:
        # Explicit columns: raw_storage_path and review_record are not readable (§5.2 item 4).
        rows = self._rest.select(
            ctx,
            "book_editions",
            columns=(
                "id,book_id,source_id,edition_key,edition_label,bank_version,status,"
                "catalog_hidden,archived_at"
            ),
            filters={"id": f"eq.{edition_id}"},
        )
        if not rows or rows[0].get("status") not in READABLE_STATUSES:
            return None
        row = rows[0]
        books = self._rest.select(
            ctx,
            "books",
            columns="id,title_ar,content_format",
            filters={"id": f"eq.{row['book_id']}"},
        )
        sources = self._rest.select(
            ctx,
            "sources",
            columns="id,title,provider,source_url",
            filters={"id": f"eq.{row['source_id']}"},
        )
        if not books or not sources:  # visible edition with unreadable parents: a data problem
            raise AppError(ErrorCode.unavailable)
        book, source = books[0], sources[0]
        return parse_or_internal(
            lambda: EditionInfo(
                edition_id=UUID(str(row["id"])),
                edition_key=str(row["edition_key"]),
                status=str(row["status"]),
                hidden=bool(row.get("catalog_hidden")) or row.get("archived_at") is not None,
                bank_version=int(row["bank_version"]),
                content_format=str(book["content_format"]),
                edition_label=str(row["edition_label"]),
                book_title_ar=str(book["title_ar"]),
                source_title=str(source["title"]),
                source_provider=str(source["provider"]),
                source_url=str(source["source_url"]),
            )
        )

    def _section_rows(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int], select: str
    ) -> list[dict[str, Any]]:
        if not ordinals:
            return []
        return self._rest.select_all(
            ctx,
            "book_sections",
            columns=select,
            filters={
                "edition_id": f"eq.{edition_id}",
                "ordinal": in_filter(sorted(set(ordinals))),
            },
            order="ordinal.asc",
        )

    def passages(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        section_ordinals: Sequence[int],
        paths: Sequence[str],
    ) -> list[BankPassage]:
        section_rows = self._section_rows(ctx, edition_id, section_ordinals, "id,ordinal")
        if not section_rows or not paths:
            return []
        ordinal_of = {str(r["id"]): int(r["ordinal"]) for r in section_rows}
        rows = self._rest.select_all(
            ctx,
            "passages",
            columns="id,ordinal,section_id,path,start_ref,end_ref,word_count,reference",
            filters={
                "edition_id": f"eq.{edition_id}",
                "bank_version": f"eq.{bank_version}",
                "section_id": in_filter(ordinal_of),
                "path": in_filter(paths),
            },
            order="id.asc",
        )
        parts: dict[str, list[BankPart]] = {}
        ids = [str(r["id"]) for r in rows]
        for chunk in chunks(ids, self._chunk):
            for part in self._rest.select_all(
                ctx,
                "passage_parts",
                columns="id,passage_id,ordinal,start_ref,end_ref,word_count",
                filters={"passage_id": in_filter(chunk)},
                order="passage_id.asc,ordinal.asc",
            ):
                parts.setdefault(str(part["passage_id"]), []).append(
                    parse_or_internal(
                        lambda part=part: BankPart(
                            id=UUID(str(part["id"])),
                            ordinal=int(part["ordinal"]),
                            start_ref=str(part["start_ref"]),
                            end_ref=str(part["end_ref"]),
                            word_count=int(part["word_count"]),
                        )
                    )
                )
        return [
            parse_or_internal(
                lambda row=row: BankPassage(
                    id=UUID(str(row["id"])),
                    section_ordinal=ordinal_of[str(row["section_id"])],
                    ordinal=int(row["ordinal"]),
                    path=str(row["path"]),
                    start_ref=str(row["start_ref"]),
                    end_ref=str(row["end_ref"]),
                    word_count=int(row["word_count"]),
                    reference=str(row["reference"]),
                    parts=tuple(parts.get(str(row["id"]), ())),
                )
            )
            for row in rows
        ]

    def questions(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        passage_ids: Sequence[UUID],
    ) -> list[BankQuestion]:
        found: list[BankQuestion] = []
        for chunk in chunks(list(passage_ids), self._chunk):
            for row in self._rest.select_all(
                ctx,
                "question_items",
                columns=(
                    "id,passage_id,type,variant,covered_part_ids,token_refs,option_refs,"
                    "correct_ref,context_refs,reference"
                ),
                filters={
                    "edition_id": f"eq.{edition_id}",
                    "bank_version": f"eq.{bank_version}",
                    "status": "eq.published",
                    "passage_id": in_filter(chunk),
                },
                order="id.asc",
            ):
                found.append(
                    parse_or_internal(
                        lambda row=row: BankQuestion(
                            id=UUID(str(row["id"])),
                            passage_id=UUID(str(row["passage_id"])),
                            type=str(row["type"]),
                            variant=row.get("variant"),
                            covered_part_ids=tuple(UUID(str(p)) for p in row["covered_part_ids"]),
                            token_refs=_refs(row["token_refs"]),
                            option_refs=(
                                None
                                if row.get("option_refs") is None
                                else tuple(_refs(o) for o in row["option_refs"])
                            ),
                            correct_ref=_refs(row["correct_ref"]),
                            context_refs=_refs(row.get("context_refs") or ()),
                            reference=str(row["reference"]),
                        )
                    )
                )
        return found

    def sections(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int]
    ) -> dict[int, BankSection]:
        rows = self._section_rows(
            ctx, edition_id, ordinals, "id,ordinal,kind,reference,title_ar,title_en,source_url"
        )
        return {
            int(row["ordinal"]): parse_or_internal(
                lambda row=row: BankSection(
                    ordinal=int(row["ordinal"]),
                    kind=str(row["kind"]),
                    reference=str(row["reference"]),
                    title_ar=str(row["title_ar"]),
                    title_en=str(row["title_en"]),
                    source_url=row.get("source_url"),
                )
            )
            for row in rows
        }

    _UNIT_COLUMNS = (
        "id,ordinal,section_id,kind,reference,source_url,canonical_text,token_spans,hadith_meta"
    )

    @staticmethod
    def _unit(row: Mapping[str, Any], section_ordinal: int | None) -> BankUnit:
        return parse_or_internal(
            lambda: BankUnit(
                ordinal=int(row["ordinal"]),
                kind=str(row["kind"]),
                reference=str(row["reference"]),
                source_url=row.get("source_url"),
                text=str(row["canonical_text"]),
                tokens=tuple(
                    BankToken(
                        i=int(t["i"]),
                        s=int(t["s"]),
                        e=int(t["e"]),
                        k=str(t["k"]),
                        n=str(t["n"]),
                        a=t.get("a"),
                    )
                    for t in row["token_spans"]
                ),
                hadith_meta=row.get("hadith_meta"),
                section_ordinal=section_ordinal,
            )
        )

    def units(
        self, ctx: SessionContext, edition_id: UUID, ordinals: Sequence[int]
    ) -> dict[int, BankUnit]:
        found: dict[int, BankUnit] = {}
        for chunk in chunks(sorted(set(ordinals)), self._chunk):
            for row in self._rest.select_all(
                ctx,
                "units",
                columns=self._UNIT_COLUMNS,
                filters={"edition_id": f"eq.{edition_id}", "ordinal": in_filter(chunk)},
                order="ordinal.asc",
            ):
                unit = self._unit(row, None)
                found[unit.ordinal] = unit
        return found

    def section_units(
        self, ctx: SessionContext, edition_id: UUID, section_ordinals: Sequence[int]
    ) -> list[BankUnit]:
        section_rows = self._section_rows(ctx, edition_id, section_ordinals, "id,ordinal")
        if not section_rows:
            return []
        ordinal_of = {str(r["id"]): int(r["ordinal"]) for r in section_rows}
        rows = self._rest.select_all(
            ctx,
            "units",
            columns=self._UNIT_COLUMNS,
            filters={"edition_id": f"eq.{edition_id}", "section_id": in_filter(ordinal_of)},
            order="ordinal.asc",
        )
        return [self._unit(row, ordinal_of.get(str(row["section_id"]))) for row in rows]

    def lessons(
        self,
        ctx: SessionContext,
        edition_id: UUID,
        *,
        bank_version: int,
        passage_ids: Sequence[UUID],
    ) -> dict[UUID, UUID]:
        found: dict[UUID, UUID] = {}
        for chunk in chunks(list(passage_ids), self._chunk):
            for row in self._rest.select_all(
                ctx,
                "lessons",
                columns="id,passage_id",
                filters={
                    "edition_id": f"eq.{edition_id}",
                    "bank_version": f"eq.{bank_version}",
                    "status": "eq.published",
                    "passage_id": in_filter(chunk),
                },
                order="id.asc",
            ):
                found[UUID(str(row["passage_id"]))] = UUID(str(row["id"]))
        return found
