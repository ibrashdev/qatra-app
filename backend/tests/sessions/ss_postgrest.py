"""A fake PostgREST for the adapter tests: served through ``httpx.MockTransport``, no network.

It holds the tables the two repositories read, built from the synthetic bundles, and speaks enough
PostgREST for them: ``eq``/``in``/``is``/``gt``/``gte``/``lt``/``lte`` filters, ``select`` (checked:
``book_editions`` and ``sources`` must name their columns and never ask for the unreadable ones),
``order``, ``limit`` and ``offset``, ``Prefer: return=representation`` on PATCH, and the RPC
``app_open_session`` with the semantics of the migration (an atomic daily get-or-create, and
``QT002`` when the plan version is not the one in force). Row-level security is imitated where it
matters: a learner sees only ``published`` and ``superseded`` editions and only his own rows.

Every request must carry ``apikey`` and ``Authorization: Bearer <learner token>``; anything else is
answered ``401 PGRST301`` like an expired JWT.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from urllib.parse import unquote
from uuid import UUID

import httpx

from app.providers.postgrest import PostgrestClient
from tests.sessions.ss_support import HADITH, NOW, PLAN_ID, PLAN_VERSION_ID, QURAN, USER

TOKEN = "learner-access-token-0001"
ANON = "anon-publishable-key-0001"
BASE = "https://project.example"
UNREADABLE = ("raw_storage_path", "review_record")
RESERVED = {"select", "order", "limit", "offset"}


def _text(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _number_or_text(value: Any) -> Any:
    try:
        return float(value)
    except (TypeError, ValueError):
        return str(value)


def _sort_key(value: Any) -> tuple[int, Any]:
    """Order by the type of the column like PostgreSQL: numbers numerically, the rest as text."""
    if value is None:
        return (2, "")
    if isinstance(value, int | float) and not isinstance(value, bool):
        return (0, value)
    return (1, str(value))


def tables_of(bundle: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    edition_id, book_id, source_id = (
        bundle["edition"]["id"],
        bundle["book"]["id"],
        bundle["source"]["id"],
    )
    section_id = {s["ordinal"]: s["id"] for s in bundle["sections"]}
    bank = bundle["bankVersion"]
    return {
        "book_editions": [
            {
                "id": edition_id,
                "book_id": book_id,
                "source_id": source_id,
                "edition_key": bundle["editionKey"],
                "edition_label": bundle["edition"]["editionLabel"],
                "bank_version": bank,
                "status": "published",
                "catalog_hidden": False,
                "archived_at": None,
                "raw_storage_path": "SECRET/raw/",
                "review_record": {"secret": True},
            }
        ],
        "books": [
            {
                "id": book_id,
                "title_ar": bundle["book"]["titleAr"],
                "title_en": bundle["book"]["titleEn"],
                "author": bundle["book"]["author"],
                "content_format": bundle["book"]["contentFormat"],
            }
        ],
        "sources": [
            {
                "id": source_id,
                "title": bundle["source"]["title"],
                "provider": bundle["source"]["provider"],
                "source_url": bundle["source"]["sourceUrl"],
                "license_record": {"secret": True},
            }
        ],
        "book_sections": [
            {
                "id": s["id"],
                "edition_id": edition_id,
                "ordinal": s["ordinal"],
                "kind": s["kind"],
                "reference": s["reference"],
                "title_ar": s["titleAr"],
                "title_en": s["titleEn"],
                "source_url": s.get("sourceUrl"),
            }
            for s in bundle["sections"]
        ],
        "units": [
            {
                "id": u["id"],
                "edition_id": edition_id,
                "section_id": section_id[u["sectionOrdinal"]],
                "ordinal": u["ordinal"],
                "kind": u["kind"],
                "reference": u["reference"],
                "source_url": u.get("sourceUrl"),
                "canonical_text": u["canonicalText"],
                "token_spans": u["tokens"],
                "hadith_meta": u.get("hadithMeta"),
            }
            for u in bundle["units"]
        ],
        "passages": [
            {
                "id": p["id"],
                "edition_id": edition_id,
                "bank_version": bank,
                "section_id": section_id[p["sectionOrdinal"]],
                "ordinal": p["ordinal"],
                "path": p["path"],
                "start_ref": p["startRef"],
                "end_ref": p["endRef"],
                "word_count": p["wordCount"],
                "reference": p["reference"],
            }
            for p in bundle["passages"]
        ],
        "passage_parts": [
            {
                "id": part["id"],
                "passage_id": p["id"],
                "edition_id": edition_id,
                "ordinal": part["ordinal"],
                "start_ref": part["startRef"],
                "end_ref": part["endRef"],
                "word_count": part["wordCount"],
            }
            for p in bundle["passages"]
            for part in p["parts"]
        ],
        "question_items": [
            {
                "id": q["id"],
                "edition_id": edition_id,
                "bank_version": bank,
                "passage_id": q["passageId"],
                "type": q["type"],
                "variant": q["variant"],
                "covered_part_ids": q["coveredPartIds"],
                "token_refs": q["tokenRefs"],
                "option_refs": q["optionRefs"],
                "correct_ref": q["correctRef"],
                "context_refs": q["contextRefs"],
                "reference": q["reference"],
                "status": "published",
            }
            for q in bundle["questions"]
        ],
        "lessons": [
            {
                "id": x["id"],
                "edition_id": edition_id,
                "bank_version": bank,
                "passage_id": x["passageId"],
                "ordinal": x["ordinal"],
                "status": "published",
            }
            for x in bundle["lessons"]
        ],
    }


class FakePostgrest:
    """The server side of the adapter tests. ``client()`` is a ``PostgrestClient`` wired to it."""

    def __init__(
        self,
        bundles: Sequence[Mapping[str, Any]] = (QURAN, HADITH),
        *,
        user_id: UUID = USER,
        token: str = TOKEN,
        anon: str = ANON,
    ) -> None:
        self.user_id, self.token, self.anon = str(user_id), token, anon
        self.tables: dict[str, list[dict[str, Any]]] = {
            name: []
            for name in (
                "learning_sessions",
                "target_mastery",
                "target_part_evidence",
                "attempts",
                "daily_progress",
            )
        }
        for bundle in bundles:
            for name, rows in tables_of(bundle).items():
                self.tables.setdefault(name, []).extend(rows)
        self.tables["plan_versions"] = [
            {"id": str(PLAN_VERSION_ID), "plan_id": str(PLAN_ID), "version_no": 2}
        ]
        self.plan_version_in_force: str | None = str(PLAN_VERSION_ID)
        self.requests: list[httpx.Request] = []
        self.rpc_bodies: list[dict[str, Any]] = []
        self.patch_bodies: list[dict[str, Any]] = []
        self.failures: list[tuple[str, Callable[[httpx.Request], httpx.Response]]] = []

    # -- wiring ------------------------------------------------------------------------------

    def client(self) -> PostgrestClient:
        return PostgrestClient(BASE, self.anon, transport=httpx.MockTransport(self.handle))

    def fail(self, fragment: str, response: Callable[[httpx.Request], httpx.Response]) -> None:
        """Answer the next request whose URL contains ``fragment`` with ``response(request)``."""
        self.failures.append((fragment, response))

    def calls_to(self, fragment: str) -> list[httpx.Request]:
        return [r for r in self.requests if fragment in str(r.url)]

    def set_edition_status(self, status: str, edition_id: str | None = None) -> None:
        for row in self.tables["book_editions"]:
            if edition_id is None or row["id"] == edition_id:
                row["status"] = status

    # -- server --------------------------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if (
            request.headers.get("apikey") != self.anon
            or request.headers.get("authorization") != f"Bearer {self.token}"
        ):
            return httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"})
        for index, (fragment, answer) in enumerate(self.failures):
            if fragment in str(request.url):
                del self.failures[index]
                return answer(request)
        path = request.url.path.removeprefix("/rest/v1/")
        if path.startswith("rpc/"):
            return self._rpc(path.removeprefix("rpc/"), json.loads(request.content or b"{}"))
        if request.method == "GET":
            return httpx.Response(200, json=self._select(path, request))
        if request.method == "PATCH":
            return self._patch(path, request)
        return httpx.Response(405, json={"code": "PGRST000", "message": "method"})

    # -- reads ---------------------------------------------------------------------------------

    def _visible(self, table: str) -> list[dict[str, Any]]:
        rows = self.tables[table]
        readable = {
            r["id"]
            for r in self.tables["book_editions"]
            if r["status"] in ("published", "superseded")
        }
        if table == "book_editions":
            return [r for r in rows if r["status"] in ("published", "superseded")]
        if table in (
            "book_sections",
            "units",
            "passages",
            "passage_parts",
            "question_items",
            "lessons",
        ):
            return [r for r in rows if r["edition_id"] in readable]
        if table == "books":
            books = {r["book_id"] for r in self.tables["book_editions"] if r["id"] in readable}
            return [r for r in rows if r["id"] in books]
        if table == "sources":
            sources = {r["source_id"] for r in self.tables["book_editions"] if r["id"] in readable}
            return [r for r in rows if r["id"] in sources]
        return rows

    @staticmethod
    def _matches(row: Mapping[str, Any], column: str, expression: str) -> bool:
        operator, _, value = expression.partition(".")
        current = row.get(column)
        if operator == "eq":
            return _text(current) == value
        if operator == "in":
            return _text(current) in value.removeprefix("(").removesuffix(")").split(",")
        if operator == "is":
            return current is None if value == "null" else _text(current) == value
        if operator in ("gt", "gte", "lt", "lte"):
            if current is None:
                return False
            left, right = _number_or_text(current), _number_or_text(value)
            return {
                "gt": left > right,
                "gte": left >= right,
                "lt": left < right,
                "lte": left <= right,
            }[operator]
        raise AssertionError(f"fake PostgREST does not support the operator {operator!r}")

    def _select(self, table: str, request: httpx.Request) -> list[dict[str, Any]]:
        params = request.url.params
        select = params.get("select")
        if table in ("book_editions", "sources"):
            columns = (select or "*").split(",")
            assert "*" not in columns and not set(columns) & set(UNREADABLE), "name the columns"
            assert table != "sources" or "license_record" not in columns
        rows = [
            r
            for r in self._visible(table)
            if all(
                self._matches(r, column, unquote(value))
                for column, value in params.multi_items()
                if column not in RESERVED
            )
        ]
        if table in (
            "learning_sessions",
            "target_mastery",
            "target_part_evidence",
            "attempts",
            "daily_progress",
        ):
            rows = [r for r in rows if r.get("user_id", self.user_id) == self.user_id]
        if order := params.get("order"):
            for spec in reversed(order.split(",")):
                column, _, direction = spec.partition(".")
                rows.sort(key=lambda r, c=column: _sort_key(r.get(c)), reverse=direction == "desc")
        offset = int(params.get("offset", 0))
        rows = rows[offset : offset + int(params["limit"])] if "limit" in params else rows[offset:]
        if select and select != "*":
            keep = select.split(",")
            rows = [{c: r[c] for c in keep if c in r} for r in rows]
        return json.loads(json.dumps(rows))

    # -- writes --------------------------------------------------------------------------------

    def _rpc(self, name: str, args: dict[str, Any]) -> httpx.Response:
        assert name == "app_open_session", f"unexpected function {name}"
        self.rpc_bodies.append(args)
        if (
            args["p_plan_id"] is not None
            and args["p_plan_version_id"] != self.plan_version_in_force
        ):
            return httpx.Response(
                400,
                json={
                    "code": "QT002",
                    "message": "version_conflict",
                    "details": None,
                    "hint": None,
                },
            )
        sessions = self.tables["learning_sessions"]
        if args["p_kind"] == "daily":
            for row in sessions:
                if (
                    row["user_id"] == self.user_id
                    and row["kind"] == "daily"
                    and row["learning_date"] == args["p_learning_date"]
                    and row["status"] in ("prepared", "open")
                    and row["offline_snapshot_id"] is None
                ):
                    return httpx.Response(200, json=[{"session_id": row["id"], "created": False}])
        session_id = args["p_session_id"]
        sessions.append(
            {
                "id": session_id,
                "user_id": self.user_id,
                "plan_id": args["p_plan_id"],
                "plan_version_id": args["p_plan_version_id"],
                "edition_id": args["p_edition_id"],
                "kind": args["p_kind"],
                "learning_date": args["p_learning_date"],
                "lesson_refs": args["p_lesson_refs"],
                "question_refs": args["p_question_refs"],
                "steps": args["p_steps"],
                "bank_version": args["p_bank_version"],
                "self_rating": args["p_self_rating"],
                "status": "open",
                "elapsed_ms": 0,
                "offline_snapshot_id": None,
                "created_at": NOW.isoformat(),
            }
        )
        return httpx.Response(200, json=[{"session_id": session_id, "created": True}])

    def _patch(self, table: str, request: httpx.Request) -> httpx.Response:
        assert table == "learning_sessions", "only the session status is written by PATCH"
        body = json.loads(request.content)
        self.patch_bodies.append(body)
        assert set(body) <= {"status", "elapsed_ms"}, (
            "learners may update status and elapsed_ms only"
        )
        params = request.url.params
        changed = []
        for row in self.tables[table]:
            if row["user_id"] == self.user_id and all(
                self._matches(row, column, unquote(value))
                for column, value in params.multi_items()
                if column not in RESERVED
            ):
                row.update(body)
                changed.append(row)
        return httpx.Response(200, json=json.loads(json.dumps(changed)))
