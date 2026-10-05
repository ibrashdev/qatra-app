"""A fake PostgREST for the adapter tests: served through ``httpx.MockTransport``, no network.

It holds the tables the two repositories read, built from the synthetic bundles, and speaks enough
PostgREST for them: ``eq``/``in``/``is``/``gt``/``gte``/``lt``/``lte`` filters, ``select`` (checked:
``book_editions`` and ``sources`` must name their columns and never ask for the unreadable ones),
``order``, ``limit`` and ``offset``, PostgREST's ``and=(a.gte.x,a.lte.y)`` group, ``Prefer:
return=representation`` on PATCH, and the RPCs ``app_open_session``, ``app_apply_events`` and
``app_complete_session`` with the semantics of the migration (an atomic daily get-or-create and
``QT002`` when the plan version is not the one in force; every event element once per
``client_event_id`` with the mastery upsert, evidence once per part, ``greatest`` on the daily time
and one completion per date, all in one transaction that is rolled back on a refused element).
Row-level security is imitated where it matters: a learner sees only ``published`` and
``superseded`` editions and only his own rows.

Every request must carry ``apikey`` and ``Authorization: Bearer <learner token>``; anything else is
answered ``401 PGRST301`` like an expired JWT.
"""

from __future__ import annotations

import copy
import json
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import unquote
from uuid import UUID

import httpx

from app.domain.learning_state import PassageMastery
from app.providers.postgrest import PostgrestClient
from tests.sessions.ss_support import HADITH, NOW, PLAN_ID, PLAN_VERSION_ID, QURAN, USER

TOKEN = "learner-access-token-0001"
ANON = "anon-publishable-key-0001"
BASE = "https://project.example"
UNREADABLE = ("raw_storage_path", "review_record")
RESERVED = {"select", "order", "limit", "offset"}
LEARNER_TABLES = (
    "learning_sessions",
    "target_mastery",
    "target_part_evidence",
    "attempts",
    "daily_progress",
    "session_activity_intervals",
    "daily_completions",
)
ERROR_KINDS = {
    None,
    "none",
    "wrong_choice",
    "wrong_order",
    "wrong_recall",
    "similar_confusion",
    "timeout",
    "skipped",
}
_TOKEN_REF = re.compile(r"^\d+:\d+$")


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


class _Refused(Exception):
    """A constraint of the database refuses an element: the SQLSTATE of the violation."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


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
        self.tables: dict[str, list[dict[str, Any]]] = {name: [] for name in LEARNER_TABLES}
        for bundle in bundles:
            for name, rows in tables_of(bundle).items():
                self.tables.setdefault(name, []).extend(rows)
        self.tables["plan_versions"] = [
            {"id": str(PLAN_VERSION_ID), "plan_id": str(PLAN_ID), "version_no": 2}
        ]
        self.plan_version_in_force: str | None = str(PLAN_VERSION_ID)
        self.requests: list[httpx.Request] = []
        self.rpc_bodies: list[dict[str, Any]] = []
        self.apply_bodies: list[dict[str, Any]] = []
        self.complete_bodies: list[dict[str, Any]] = []
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

    def _condition(self, row: Mapping[str, Any], column: str, expression: str) -> bool:
        """One query parameter: a column filter, or PostgREST's ``and=(a.gte.1,a.lte.9)`` group."""
        if column != "and":
            return self._matches(row, column, expression)
        inner = expression.removeprefix("(").removesuffix(")")
        for part in inner.split(","):
            name, _, rest = part.partition(".")
            if not self._matches(row, name, rest):
                return False
        return True

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
                self._condition(r, column, unquote(value))
                for column, value in params.multi_items()
                if column not in RESERVED
            )
        ]
        if table in LEARNER_TABLES:
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
        if name == "app_apply_events":
            return self._apply_events(args)
        if name == "app_complete_session":
            return self._complete_session(args)
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

    # -- app_apply_events and app_complete_session ----------------------------------------------

    @staticmethod
    def _error(status: int, code: str, message: str = "refused") -> httpx.Response:
        return httpx.Response(
            status, json={"code": code, "message": message, "details": None, "hint": None}
        )

    def _owned_session(self, session_id: Any) -> dict[str, Any] | None:
        return next(
            (
                row
                for row in self.tables["learning_sessions"]
                if row["id"] == str(session_id) and row["user_id"] == self.user_id
            ),
            None,
        )

    def _apply_events(self, args: dict[str, Any]) -> httpx.Response:
        """``app_apply_events`` of migration 0005 section 7.4, in one transaction: a refused
        element rolls every table back."""
        self.apply_bodies.append(args)
        if set(args) != {"p_session_id", "p_events", "p_daily", "p_open_session"}:
            return self._error(404, "PGRST202")  # a misspelt argument, like the real PostgREST
        session = self._owned_session(args["p_session_id"])
        if session is None:
            return self._error(500, "P0002", "session_not_found")
        if not isinstance(args["p_events"], list):
            return self._error(400, "22023", "p_events must be a JSON array")
        names = ("learning_sessions", *LEARNER_TABLES[1:])
        backup = {name: copy.deepcopy(self.tables[name]) for name in names}
        try:
            body = self._apply(session, args)
        except _Refused as refused:
            for name, rows in backup.items():
                self.tables[name][:] = rows
            return self._error(400, refused.code)
        return httpx.Response(200, json=body)

    def _apply(self, session: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        uid = self.user_id
        if args["p_open_session"] and session["status"] == "prepared":
            session["status"] = "open"
        outcomes: list[str] = []
        for element in args["p_events"]:
            if ("attempt" in element) == ("interval" in element):
                raise _Refused("22023")
            if "attempt" in element:
                outcomes.append(self._apply_attempt(session, element))
            else:
                outcomes.append(self._apply_interval(session, element["interval"]))
        inserted = False
        daily = args["p_daily"]
        if daily is not None:
            if daily["goal_ms"] <= 0 or daily["active_ms"] < 0:
                raise _Refused("23514")
            rows = self.tables["daily_progress"]
            row = next(
                (
                    r
                    for r in rows
                    if r["user_id"] == uid and r["learning_date"] == daily["learning_date"]
                ),
                None,
            )
            if row is None:
                rows.append(
                    {
                        "user_id": uid,
                        "learning_date": daily["learning_date"],
                        "active_ms": daily["active_ms"],
                        "goal_ms": daily["goal_ms"],
                    }
                )
            else:
                row["active_ms"] = max(row["active_ms"], daily["active_ms"])
                row["goal_ms"] = daily["goal_ms"]
            if daily.get("completed"):
                if daily.get("reached_in_plan_id") is None:
                    raise _Refused("23514")
                done = self.tables["daily_completions"]
                if not any(
                    r["user_id"] == uid and r["learning_date"] == daily["learning_date"]
                    for r in done
                ):
                    done.append(
                        {
                            "user_id": uid,
                            "learning_date": daily["learning_date"],
                            "reached_in_plan_id": daily["reached_in_plan_id"],
                            "completed_at": NOW.isoformat(),
                        }
                    )
                    inserted = True
        return {"outcomes": outcomes, "daily_completion_inserted": inserted}

    def _apply_attempt(self, session: dict[str, Any], element: dict[str, Any]) -> str:
        uid = self.user_id
        a = element["attempt"]
        attempts = self.tables["attempts"]
        if any(
            r["user_id"] == uid and r["client_event_id"] == a["client_event_id"] for r in attempts
        ):
            return "duplicate"
        wrong_ref = a.get("wrong_token_ref")
        if (
            a.get("error_kind") not in ERROR_KINDS
            or (wrong_ref is not None and not _TOKEN_REF.match(wrong_ref))
            or a["duration_ms"] < 0
        ):
            raise _Refused("23514")
        attempt_id = str(uuid.uuid4())
        attempts.append(
            {
                "id": attempt_id,
                "user_id": uid,
                "session_id": session["id"],
                "edition_id": session["edition_id"],
                "client_event_id": a["client_event_id"],
                "question_id": a["question_id"],
                "passage_id": a["passage_id"],
                "correct": a["correct"],
                "assisted": bool(a.get("assisted")),
                "error_kind": a.get("error_kind"),
                "wrong_token_ref": wrong_ref,
                "review_round_id": a.get("review_round_id"),
                "duration_ms": a["duration_ms"],
                "occurred_at": a["occurred_at"],
                "created_at": NOW.isoformat(),
            }
        )
        mastery = element.get("mastery")
        if isinstance(mastery, dict):
            if PassageMastery.from_row(mastery).violations():
                raise _Refused("23514")
            rows = self.tables["target_mastery"]
            row = next(
                (
                    r
                    for r in rows
                    if r["user_id"] == uid
                    and r["plan_id"] == mastery["plan_id"]
                    and r["passage_id"] == mastery["passage_id"]
                ),
                None,
            )
            values = {"user_id": uid, "edition_id": session["edition_id"], **mastery}
            if row is None:
                rows.append(values)
            else:
                row.update(values)
        for item in element.get("evidence") or []:
            rows = self.tables["target_part_evidence"]
            if not any(
                r["user_id"] == uid
                and r["plan_id"] == item["plan_id"]
                and r["part_id"] == item["part_id"]
                for r in rows
            ):
                rows.append({"user_id": uid, "attempt_id": attempt_id, **item})
        return "acknowledged"

    def _apply_interval(self, session: dict[str, Any], i: dict[str, Any]) -> str:
        uid = self.user_id
        rows = self.tables["session_activity_intervals"]
        if any(r["user_id"] == uid and r["client_event_id"] == i["client_event_id"] for r in rows):
            return "duplicate"
        started = datetime.fromisoformat(i["started_at"])
        ended = datetime.fromisoformat(i["ended_at"])
        span_ms = (ended - started) // timedelta(milliseconds=1)
        if not (
            ended >= started
            and 0 <= i["active_ms"] <= 1_800_000
            and i["active_ms"] <= span_ms + 1000
        ):
            raise _Refused("23514")
        rows.append(
            {
                "id": str(uuid.uuid4()),
                "user_id": uid,
                "session_id": session["id"],
                "client_event_id": i["client_event_id"],
                "started_at": i["started_at"],
                "ended_at": i["ended_at"],
                "active_ms": i["active_ms"],
                "learning_date": i["learning_date"],
                "created_at": NOW.isoformat(),
            }
        )
        return "acknowledged"

    def _complete_session(self, args: dict[str, Any]) -> httpx.Response:
        """``app_complete_session``: true when this call completed the session."""
        self.complete_bodies.append(args)
        if set(args) != {"p_session_id", "p_elapsed_ms"}:
            return self._error(404, "PGRST202")
        session = self._owned_session(args["p_session_id"])
        if session is None:
            return self._error(500, "P0002", "session_not_found")
        if session["status"] == "completed":
            return httpx.Response(200, json=False)
        if args["p_elapsed_ms"] < 0:
            return self._error(400, "23514")
        session["status"] = "completed"
        session["elapsed_ms"] = args["p_elapsed_ms"]
        return httpx.Response(200, json=True)

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
