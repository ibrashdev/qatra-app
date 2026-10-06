"""Helpers for the content manager web admin tests (D91). Synthetic data only: every title, text and
key below is made up for the test run. No Quran or hadith text, and no real secret.

Testing personas (Role 6 verification; they invent no production role: the only gate is the
server setting ``QATRA_CONTENT_MANAGER_USERNAMES`` of docs/Content-admin.md section 2)

=====================  ==========================  =========================================
Persona                Account                     Precondition
=====================  ==========================  =========================================
Visitor                none                        no session cookie
Manager                ``sample_user_01``          registered, named in the setting
                                                   (written ``Sample_User_01`` there: the
                                                   comparison is normalized)
Other learner          ``second_user``             registered, NOT named in the setting
Demo manager           ``demo_learner``            ``is_demo`` session whose name IS in the
                                                   setting (a demo is never a manager)
Manager, empty list    ``sample_user_01``          the setting is unset or empty (nobody)
=====================  ==========================  =========================================

Allowed and denied, with the expected outcome:

- Visitor: every route ``401 unauthenticated`` (a mutation without ``Origin`` is ``403
  forbidden_origin`` first).
- Manager: every route of section 4 on the seeded content; refusals as ``409`` (``stale``,
  ``in_use``, ``state``), ``404`` and ``422`` as the spec lists them.
- Other learner, demo manager and manager with an empty list: every route ``403 forbidden``.

``seed_catalog`` fills a ``MemoryContentAdminRepository`` with a small catalog (one published
edition with sections, units, jobs and an owner approval, one draft, and unused rows to delete).
``FakePostgrest`` plays the Supabase REST API over ``httpx.MockTransport`` for the PostgREST tests.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx

from app.repositories.content_admin import MemoryContentAdminRepository

SERVICE_KEY = "synthetic-service-role-key-for-tests"
ANON_KEY = "synthetic-anon-key-for-tests"
SUPABASE_URL = "https://synthetic-project.example"
NOW = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)
PUBLISHED_AT = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)

# Every table the admin may read or write over PostgREST. A request to any other table (a learner
# or personal one) fails the PostgREST tests.
CONTENT_TABLES = frozenset(
    {
        "categories",
        "books",
        "sources",
        "book_editions",
        "book_sections",
        "units",
        "passages",
        "lessons",
        "question_items",
        "content_jobs",
    }
)


def uid(number: int) -> UUID:
    """A fixed synthetic id."""
    return UUID(f"c0c0c0c0-0000-4000-8000-{number:012d}")


class FakeClock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kwargs: float) -> None:
        self.now += timedelta(**kwargs)


@dataclass(frozen=True)
class Seeded:
    """Ids of the seeded catalog (see ``seed_catalog``)."""

    category: UUID = uid(1)
    empty_category: UUID = uid(2)
    book: UUID = uid(11)
    empty_book: UUID = uid(12)
    source: UUID = uid(21)
    empty_source: UUID = uid(22)
    published: UUID = uid(31)  # published edition of ``book``
    draft: UUID = uid(32)  # draft edition of ``book`` (never published)
    section: UUID = uid(41)  # section 1 of ``published``
    section_two: UUID = uid(42)
    draft_section: UUID = uid(43)
    unit_a: UUID = uid(51)
    unit_b: UUID = uid(52)


IDS = Seeded()

APPROVAL = {
    "who": "Synthetic Owner",
    "at": "2026-10-04T08:00:00+04:00",
    "note": "synthetic note",
    "scope": "synthetic scope",
    "words": "synthetic owner words",
    "source": "https://example.invalid/session",
}


def edition_row(
    edition_id: UUID,
    *,
    key: str,
    version: int,
    status: str,
    review_record: dict[str, Any] | None = None,
    book_id: UUID = IDS.book,
    source_id: UUID = IDS.source,
) -> dict[str, Any]:
    return {
        "id": edition_id,
        "book_id": book_id,
        "source_id": source_id,
        "edition_key": key,
        "edition_label": f"Synthetic label {version}",
        "language": "ar",
        "version": version,
        "bank_version": 1,
        "content_hash": None if status == "draft" else "a" * 64,
        "status": status,
        "review_record": review_record if review_record is not None else {},
        "catalog_hidden": False,
        "archived_at": None,
    }


def seed_catalog(repo: MemoryContentAdminRepository) -> Seeded:
    """Two categories, two books, two sources, a published and a draft edition."""
    ids = IDS
    repo.insert(
        "categories",
        {
            "id": ids.category,
            "slug": "demo-category",
            "label_ar": "تصنيف تجريبي",
            "label_en": "Demo category",
            "display_order": 1,
        },
    )
    repo.insert(
        "categories",
        {
            "id": ids.empty_category,
            "slug": "empty-category",
            "label_ar": "تصنيف فارغ",
            "label_en": None,
            "display_order": 2,
        },
    )
    for book_id, title, en in (
        (ids.book, "كتاب تجريبي", "Demo book"),
        (ids.empty_book, "كتاب غير مستخدم", None),
    ):
        repo.insert(
            "books",
            {
                "id": book_id,
                "category_id": ids.category,
                "title_ar": title,
                "title_en": en,
                "author": "مؤلف تجريبي",
                "content_format": "hadith_collection",
            },
        )
    for source_id, title in ((ids.source, "Synthetic source"), (ids.empty_source, "Unused source")):
        repo.insert(
            "sources",
            {
                "id": source_id,
                "title": title,
                "provider": "Synthetic provider",
                "source_url": "https://example.invalid/source",
                "license_url": "https://example.invalid/license",
                "rights_status": "owner_accepted_pending_verification",
                "checked_at": None,
            },
        )
    repo.insert(
        "book_editions",
        edition_row(
            ids.published,
            key="synthetic-edition-1",
            version=1,
            status="published",
            review_record={"approval": dict(APPROVAL), "acquisition": {"tool": "synthetic"}},
        ),
    )
    repo.insert(
        "book_editions",
        edition_row(ids.draft, key="synthetic-edition-2", version=2, status="draft"),
    )
    for section_id, edition_id, ordinal in (
        (ids.section, ids.published, 1),
        (ids.section_two, ids.published, 2),
        (ids.draft_section, ids.draft, 1),
    ):
        repo.insert(
            "book_sections",
            {
                "id": section_id,
                "edition_id": edition_id,
                "ordinal": ordinal,
                "kind": "hadith",
                "reference": f"synthetic-ref-{ordinal}",
                "title_ar": f"عنوان قسم {ordinal}",
                "title_en": f"Section title {ordinal}",
            },
        )
    for unit_id, ordinal in ((ids.unit_a, 1), (ids.unit_b, 2)):
        repo.insert(
            "units",
            {
                "id": unit_id,
                "edition_id": ids.published,
                "section_id": ids.section,
                "ordinal": ordinal,
                "kind": "hadith_narration",
                "reference": f"synthetic-unit-{ordinal}",
                "canonical_text": f"نص تجريبي للوحدة {ordinal}",
            },
        )
    repo.insert(
        "passages",
        {"id": uid(61), "edition_id": ids.published, "bank_version": 1, "section_id": ids.section},
    )
    repo.insert(
        "lessons",
        {"id": uid(71), "edition_id": ids.published, "bank_version": 1, "passage_id": uid(61)},
    )
    for number, (unit_id, kind) in enumerate(
        (
            (ids.unit_a, "word_order"),
            (ids.unit_a, "word_choice"),
            (ids.unit_b, "word_choice"),
            (ids.unit_b, "similar_distinction"),
        )
    ):
        repo.insert(
            "question_items",
            {
                "id": uid(81 + number),
                "edition_id": ids.published,
                "bank_version": 1,
                "unit_id": unit_id,
                "type": kind,
            },
        )
    for step in ("approved", "published"):
        repo.insert(
            "content_jobs",
            {
                "id": uid(91 if step == "approved" else 92),
                "edition_id": ids.published,
                "bank_version": 1,
                "pipeline_version": "synthetic-pipeline-1",
                "step": step,
                "status": "succeeded",
                "published_at": PUBLISHED_AT if step == "published" else None,
            },
        )
    return ids


def stamp_of(row: dict[str, Any]) -> str:
    """``updatedAt`` of a row as the API returns it (what a client sends back)."""
    value = row["updated_at"]
    return value.isoformat() if isinstance(value, datetime) else str(value)


# --- a fake Supabase REST API ---------------------------------------------------------------------


def _json_safe(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def tables_from_memory(repo: MemoryContentAdminRepository) -> dict[str, list[dict[str, Any]]]:
    """The memory tables as JSON-like rows (ids and timestamps as text, like PostgREST)."""
    return {name: [_json_safe(row) for row in rows.values()] for name, rows in repo.tables.items()}


def _is_time(column: str) -> bool:
    return column.endswith("_at")


def _same(column: str, left: Any, right: str) -> bool:
    if _is_time(column) and isinstance(left, str):
        try:
            return datetime.fromisoformat(left) == datetime.fromisoformat(right)
        except ValueError:
            return False
    if isinstance(left, bool):
        return str(left).lower() == right
    return str(left) == right


def _matches(row: dict[str, Any], filters: dict[str, str]) -> bool:
    for column, expression in filters.items():
        operator, _, operand = expression.partition(".")
        if operator == "eq":
            if not _same(column, row.get(column), operand):
                return False
        elif operator == "in":
            options = operand.strip("()").split(",")
            if not any(_same(column, row.get(column), option) for option in options):
                return False
        else:  # an operator the fake does not know must not pass silently
            raise AssertionError(f"unsupported filter {column}={expression}")
    return True


@dataclass
class Recorded:
    method: str
    table: str
    params: dict[str, str]
    headers: httpx.Headers
    body: Any
    path: str
    query: str = ""


@dataclass
class FakePostgrest:
    """The REST API of one Supabase project, just enough for the content admin.

    GET and HEAD filter by ``eq.`` and ``in.(...)``; PATCH and DELETE apply the same filters
    (``updated_at`` compares as an instant) and PATCH bumps ``updated_at`` like the trigger; a POST
    to a table is an upsert on ``on_conflict``; ``rpc/srv_redact_revoked_content`` is recorded.
    ``fail`` queues an error answer for the next matching call: ``fail("PATCH", "book_editions",
    status=409, code="23001")``.
    """

    tables: dict[str, list[dict[str, Any]]]
    requests: list[Recorded] = field(default_factory=list)
    redacted: list[str] = field(default_factory=list)
    failures: list[tuple[str, str, int, str | None]] = field(default_factory=list)
    clock: datetime = NOW

    def fail(self, method: str, table: str, *, status: int, code: str | None = None) -> None:
        self.failures.append((method, table, status, code))

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def calls(self, method: str | None = None, table: str | None = None) -> list[Recorded]:
        return [
            call
            for call in self.requests
            if (method is None or call.method == method) and (table is None or call.table == table)
        ]

    def _bump(self) -> str:
        self.clock += timedelta(microseconds=7)
        return self.clock.isoformat()

    def _handle(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path.startswith("/rest/v1/"), request.url.path
        name = request.url.path.removeprefix("/rest/v1/")
        params = dict(request.url.params.items())
        body = json.loads(request.content) if request.content else None
        method = request.method
        self.requests.append(
            Recorded(
                method,
                name,
                params,
                request.headers,
                body,
                request.url.path,
                request.url.query.decode(),
            )
        )
        for index, (fail_method, fail_table, status, code) in enumerate(self.failures):
            if (fail_method, fail_table) == (method, name):
                del self.failures[index]
                payload = {"code": code, "message": "synthetic failure", "details": None}
                return httpx.Response(status, json=payload)
        if name == "rpc/srv_redact_revoked_content":
            self.redacted.append(body["p_edition_id"])
            return httpx.Response(204)
        assert name in CONTENT_TABLES, f"the admin must not query {name}"
        rows = self.tables.setdefault(name, [])
        reserved = {"select", "order", "limit", "offset", "on_conflict"}
        filters = {key: value for key, value in params.items() if key not in reserved}
        matched = [row for row in rows if _matches(row, filters)]
        if method == "GET":
            return self._select(matched, params)
        if method == "HEAD":
            return httpx.Response(200, headers={"Content-Range": f"*/{len(matched)}"})
        if method == "PATCH":
            for row in matched:
                row.update(copy.deepcopy(body))
                if "updated_at" in row:
                    row["updated_at"] = self._bump()
            return httpx.Response(200, json=matched)
        if method == "DELETE":
            for row in matched:
                rows.remove(row)
            return httpx.Response(200, json=matched)
        if method == "POST":
            return self._upsert(name, rows, params, body)
        raise AssertionError(f"unexpected {method} {request.url}")

    @staticmethod
    def _select(matched: list[dict[str, Any]], params: dict[str, str]) -> httpx.Response:
        columns = params["select"].split(",")
        start = int(params.get("offset", 0))
        stop = start + int(params["limit"]) if "limit" in params else None
        page = matched[start:stop]
        if columns != ["*"]:
            missing = [c for row in page for c in columns if c not in row]
            assert not missing, f"selected columns the row does not have: {sorted(set(missing))}"
            page = [{column: row[column] for column in columns} for row in page]
        return httpx.Response(200, json=copy.deepcopy(page))

    def _upsert(
        self, name: str, rows: list[dict[str, Any]], params: dict[str, str], body: list[dict]
    ) -> httpx.Response:
        keys = params["on_conflict"].split(",")
        stored: list[dict[str, Any]] = []
        for incoming in body:
            existing = next((r for r in rows if all(r.get(k) == incoming[k] for k in keys)), None)
            if existing is None:
                existing = {
                    "id": str(uid(900 + len(rows))),
                    "created_at": self._bump(),
                    "published_at": None,
                    "updated_at": self._bump(),
                }
                rows.append(existing)
            existing.update(copy.deepcopy(incoming))
            stored.append(copy.deepcopy(existing))
        return httpx.Response(201, json=stored)
