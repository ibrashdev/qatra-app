"""A fake PostgREST for the supabase-mode tests (``httpx.MockTransport``; no network).

It serves exactly what B4 uses: the two public catalog views (anon ``apikey`` only), the learner
tables ``passages``, ``profiles``, ``learning_sessions``, ``attempts``, ``master_plans`` and
``plan_versions`` (a known bearer token is required and only the token owner's rows are served,
like row-level security) and the functions ``app_create_plan``, ``app_revise_plan`` and
``app_resume_plan`` with the semantics of migrations 0005 and 0006. The function parameter names
are checked against the migrations' signatures, so a misspelt argument fails like the real
PostgREST would (``PGRST202``).

It is a test double, not proof that the real database behaves the same: nothing here was run
against a Supabase project.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx

from app.domain.plan_policy import EditionData, PassageRow

ANON_KEY = "anon-key-for-tests"
SERVICE_ROLE_KEY = "service-role-key-must-never-be-sent"
ACTIVE_KEY_MESSAGE = (
    'duplicate key value violates unique constraint "master_plans_user_id_active_key"'
)
SECRET_TEXT = "database text that must never reach a client or a log"

CREATE_REQUIRED = {
    "p_edition_id",
    "p_target_scope",
    "p_paths",
    "p_plan_order",
    "p_session_minutes",
    "p_preferred_date",
    "p_agreed_estimate",
    "p_reason_code",
    "p_policy_json",
    "p_effective_learning_date",
    "p_phases",
}
CREATE_OPTIONAL = {"p_sessions", "p_plan_id"}
REVISE_ARGS = {
    "p_plan_id",
    "p_expected_version",
    "p_target_scope",
    "p_paths",
    "p_plan_order",
    "p_session_minutes",
    "p_preferred_date",
    "p_agreed_estimate",
    "p_reason_code",
    "p_policy_json",
    "p_effective_learning_date",
    "p_phases",
}
WINDOW = re.compile(r"^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$")


@dataclass
class Call:
    method: str
    path: str  # after /rest/v1, for example "/catalog_editions" or "/rpc/app_create_plan"
    params: dict[str, str]
    headers: dict[str, str]
    body: Any


def db_error(status: int, code: str, message: str = SECRET_TEXT) -> httpx.Response:
    """A PostgREST error body; message and details carry text that must never leak."""
    return httpx.Response(
        status,
        json={
            "code": code,
            "details": f"Key (user_id)=({SECRET_TEXT})",
            "hint": None,
            "message": message,
        },
    )


class FakePostgrest:
    def __init__(
        self,
        entries: Sequence[tuple[EditionData, Sequence[PassageRow]]],
        *,
        anon_key: str = ANON_KEY,
    ) -> None:
        self.entries = list(entries)
        self.anon_key = anon_key
        self.tokens: dict[str, UUID] = {}
        self.profiles: dict[UUID, dict[str, Any]] = {}
        self.sessions: list[dict[str, Any]] = []
        self.attempts: list[dict[str, Any]] = []
        self.plans: dict[str, dict[str, Any]] = {}
        self.versions: list[dict[str, Any]] = []
        self.phases: list[dict[str, Any]] = []
        self.calls: list[Call] = []
        # one-shot answers by name ("catalog_editions", "rpc/app_create_plan", ...)
        self.faults: dict[str, list[httpx.Response | Exception | Callable[[], httpx.Response]]] = {}

    # -- setup -------------------------------------------------------------------------------

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def add_user(
        self,
        user_id: UUID,
        token: str,
        *,
        time_zone: str = "Asia/Dubai",
        pending: dict[str, Any] | None = None,
    ) -> None:
        self.tokens[token] = user_id
        self.profiles[user_id] = {"time_zone": time_zone, "pending_settings": pending}

    def add_placement(
        self,
        user_id: UUID,
        session_id: UUID,
        edition_id: UUID,
        attempts: Sequence[tuple[UUID, bool, bool]],
        *,
        kind: str = "placement",
    ) -> None:
        self.sessions.append(
            {
                "id": str(session_id),
                "user_id": str(user_id),
                "edition_id": str(edition_id),
                "kind": kind,
            }
        )
        for passage_id, correct, assisted in attempts:
            self.attempts.append(
                {
                    "id": str(uuid.uuid4()),
                    "user_id": str(user_id),
                    "session_id": str(session_id),
                    "passage_id": str(passage_id),
                    "correct": correct,
                    "assisted": assisted,
                }
            )

    def fail(
        self, name: str, *answers: httpx.Response | Exception | Callable[[], httpx.Response]
    ) -> None:
        """Queue one-shot answers; a callable runs when the request arrives (to simulate a race)."""
        self.faults.setdefault(name, []).extend(answers)

    def calls_to(self, path: str) -> list[Call]:
        return [call for call in self.calls if call.path == path]

    # -- the transport handler ---------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/rest/v1")
        body = None
        if request.content:
            body = json.loads(request.content)
        self.calls.append(
            Call(
                request.method,
                path,
                dict(request.url.params),
                {key.lower(): value for key, value in request.headers.items()},
                body,
            )
        )
        name = path.lstrip("/")
        queued = self.faults.get(name)
        if queued:
            answer = queued.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer if isinstance(answer, httpx.Response) else answer()
        if request.headers.get("apikey") != self.anon_key:
            return httpx.Response(401, json={"message": "Invalid API key"})
        authorization = request.headers.get("authorization", "")
        user = self.tokens.get(authorization.removeprefix("Bearer ")) if authorization else None
        if name in {"catalog_editions", "catalog_sections"}:
            return self._catalog(name, request)
        if user is None:
            return httpx.Response(
                401, json={"code": "PGRST301", "message": "JWT expired", "details": None}
            )
        if name.startswith("rpc/"):
            return self._rpc(name.removeprefix("rpc/"), body or {}, user)
        return self._select(name, request, user)

    # -- reads -------------------------------------------------------------------------------

    @staticmethod
    def _filtered(rows: list[dict[str, Any]], request: httpx.Request) -> list[dict[str, Any]]:
        for key, value in request.url.params.multi_items():
            if key in {"select", "order", "limit"}:
                continue
            assert value.startswith("eq."), f"the fake supports eq filters only, got {key}={value}"
            wanted = value.removeprefix("eq.").lower()
            rows = [row for row in rows if str(row.get(key)).lower() == wanted]
        return rows

    def _catalog(self, name: str, request: httpx.Request) -> httpx.Response:
        rows: list[dict[str, Any]] = []
        for edition, _ in self.entries:
            if name == "catalog_editions":
                rows.append(
                    {
                        "edition_id": str(edition.edition_id),
                        "edition_key": edition.edition_key,
                        "edition_label": edition.edition_label,
                        "language": "ar",
                        "catalog_version": edition.catalog_version,
                        "book_title_ar": edition.title_ar,
                        "book_title_en": edition.title_en,
                        "author": edition.author,
                        "content_format": edition.content_format,
                        "category_slug": edition.category_slug,
                        "category_label_ar": edition.category_label_ar,
                        "category_label_en": edition.category_label_en,
                        # the view orders paths alphabetically
                        "available_paths": sorted(edition.available_paths),
                        "path_word_counts": dict(edition.path_words),
                        "path_passage_counts": dict(edition.path_passages),
                    }
                )
            else:
                for section in edition.sections:
                    rows.append(
                        {
                            "edition_id": str(edition.edition_id),
                            "section_id": section.section_id,
                            "ordinal": section.ordinal,
                            "kind": section.kind,
                            "reference": section.reference,
                            "title_ar": section.title_ar,
                            "title_en": section.title_en,
                            "available_paths": sorted(section.path_words),
                            "path_stats": {
                                path: {
                                    "words": section.path_words[path],
                                    "passages": section.path_passages.get(path, 0),
                                }
                                for path in section.path_words
                            },
                        }
                    )
        return httpx.Response(200, json=self._filtered(rows, request))

    def _select_rows(self, name: str) -> list[dict[str, Any]]:
        """All rows of the passage table (tests use it to build a damaged answer)."""
        assert name == "passages"
        return [
            {
                "id": str(row.passage_id),
                "edition_id": str(edition.edition_id),
                "bank_version": edition.catalog_version,
                "section_id": next(
                    s.section_id for s in edition.sections if s.ordinal == row.section_ordinal
                ),
                "path": row.path,
                "ordinal": row.ordinal,
                "word_count": row.words,
            }
            for edition, passages in self.entries
            for row in passages
        ]

    def _select(self, name: str, request: httpx.Request, user: UUID) -> httpx.Response:
        mine = str(user)
        rows: list[dict[str, Any]]
        if name == "passages":
            rows = self._select_rows(name)
        elif name == "profiles":
            rows = [{"user_id": mine, **self.profiles[user]}] if user in self.profiles else []
        elif name == "learning_sessions":
            rows = [row for row in self.sessions if row["user_id"] == mine]
        elif name == "attempts":
            rows = [row for row in self.attempts if row["user_id"] == mine]
        elif name == "master_plans":
            rows = [self._plan_row(row) for row in self.plans.values() if row["user_id"] == mine]
        elif name == "plan_versions":
            rows = [row for row in self.versions if row["user_id"] == mine]
        else:
            return db_error(404, "42P01")
        return httpx.Response(200, json=self._filtered(rows, request))

    def _plan_row(self, row: dict[str, Any]) -> dict[str, Any]:
        edition = next(e for e, _ in self.entries if str(e.edition_id) == row["edition_id"])
        return {
            **row,
            "book_editions": {
                "books": {"title_ar": edition.title_ar, "title_en": edition.title_en}
            },
        }

    # -- the app_* functions -----------------------------------------------------------------

    def _rpc(self, function: str, args: dict[str, Any], user: UUID) -> httpx.Response:
        mine = str(user)
        if function == "app_create_plan":
            given = set(args)
            if not CREATE_REQUIRED <= given <= CREATE_REQUIRED | CREATE_OPTIONAL:
                return db_error(404, "PGRST202")
            rejected = self._check_plan_args(args)
            if rejected is not None:
                return rejected
            if not any(str(e.edition_id) == args["p_edition_id"] for e, _ in self.entries):
                return db_error(409, "23503")
            for plan in self.plans.values():
                if plan["user_id"] == mine and plan["status"] == "active":
                    plan["status"] = "paused"
            plan_id = str(uuid.uuid4())
            self.plans[plan_id] = {
                "id": plan_id,
                "user_id": mine,
                "edition_id": args["p_edition_id"],
                "target_scope": args["p_target_scope"],
                "paths": args["p_paths"],
                "plan_order": args["p_plan_order"],
                "session_minutes": args["p_session_minutes"],
                "preferred_date": args["p_preferred_date"],
                "agreed_estimate": args["p_agreed_estimate"],
                "current_version": 1,
                "status": "active",
                "created_at": "2026-10-04T09:00:00.123456+00:00",
            }
            self._add_version(plan_id, mine, 1, args)
            return httpx.Response(200, json=plan_id)
        if function == "app_revise_plan":
            if set(args) != REVISE_ARGS:
                return db_error(404, "PGRST202")
            rejected = self._check_plan_args(args)
            if rejected is not None:
                return rejected
            plan = self.plans.get(str(args["p_plan_id"]))
            if plan is None or plan["user_id"] != mine:
                return db_error(500, "P0002", "plan_not_found")
            if plan["current_version"] != args["p_expected_version"]:
                return db_error(400, "QT002", "version_conflict")
            plan.update(
                target_scope=args["p_target_scope"],
                paths=args["p_paths"],
                plan_order=args["p_plan_order"],
                session_minutes=args["p_session_minutes"],
                preferred_date=args["p_preferred_date"],
                agreed_estimate=args["p_agreed_estimate"],
                current_version=args["p_expected_version"] + 1,
            )
            self._add_version(plan["id"], mine, plan["current_version"], args)
            return httpx.Response(200, json=plan["current_version"])
        if function == "app_resume_plan":
            if set(args) != {"p_plan"}:
                return db_error(404, "PGRST202")
            plan = self.plans.get(str(args["p_plan"]))
            if plan is None or plan["user_id"] != mine:
                return db_error(500, "P0002", "plan_not_found")
            if plan["status"] == "completed":
                return db_error(400, "QT003", "invalid_state")
            if plan["status"] == "active":
                return httpx.Response(200, json=plan["current_version"])
            for other in self.plans.values():
                if other["user_id"] == mine and other["status"] == "active":
                    other["status"] = "paused"
            plan["status"] = "active"
            return httpx.Response(200, json=plan["current_version"])
        return db_error(404, "PGRST202")

    def _check_plan_args(self, args: dict[str, Any]) -> httpx.Response | None:
        """The table constraints and the guard trigger that the functions' inserts run into."""
        ok = (
            args["p_session_minutes"] in (5, 10, 15)
            and isinstance(args["p_paths"], list)
            and args["p_paths"]
            and set(args["p_paths"]) <= {"quran", "matn", "sanad", "grade"}
            and args["p_plan_order"] in ("book", "reverse")
            and isinstance(args["p_target_scope"].get("sectionOrdinals"), list)
            and isinstance(args["p_agreed_estimate"], dict)
            and isinstance(args["p_policy_json"], dict)
            and isinstance(args["p_phases"], list)
            and bool(args["p_reason_code"])
        )
        if not ok:
            return db_error(400, "23514")
        for phase in args["p_phases"]:
            window = WINDOW.match(str(phase.get("estimated_window")))
            valid = (
                window is not None
                and window.group(1) < window.group(2)
                and phase.get("goal_size", 0) > 0
                and isinstance(phase.get("section_refs"), list)
                and isinstance(phase.get("unit_range"), dict)
                and phase.get("ordinal", 0) >= 1
            )
            if not valid:
                return db_error(400, "23514")
        if args["p_plan_order"] == "reverse":
            edition_id = args.get("p_edition_id")
            if edition_id is None:
                plan = self.plans.get(str(args["p_plan_id"]))
                edition_id = plan["edition_id"] if plan else None
            edition = next((e for e, _ in self.entries if str(e.edition_id) == edition_id), None)
            if edition is not None and edition.content_format != "quran":
                return db_error(400, "23514")
        return None

    def _add_version(self, plan_id: str, user: str, number: int, args: dict[str, Any]) -> None:
        self.versions.append(
            {
                "id": str(uuid.uuid4()),
                "plan_id": plan_id,
                "user_id": user,
                "version_no": number,
                "reason_code": args["p_reason_code"],
                "policy_json": args["p_policy_json"],
                "effective_learning_date": args["p_effective_learning_date"],
            }
        )
        version_id = self.versions[-1]["id"]
        for phase in args["p_phases"]:
            self.phases.append({**phase, "plan_version_id": version_id, "user_id": user})
