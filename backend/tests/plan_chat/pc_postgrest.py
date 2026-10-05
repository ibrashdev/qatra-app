"""A fake Supabase project that also holds the plan conversation (migration 0006), for the
supabase-mode tests of B13. ``httpx.MockTransport``, no network.

``ChatProject`` extends the project fake of the integration tests (catalog, profiles, plans,
versions, the bank and the learner state) with ``plan_chats``, ``plan_chat_messages`` and the three
learner functions ``app_plan_chat_open``, ``app_plan_chat_append`` and ``app_plan_chat_confirm``,
with the semantics of ``supabase/migrations/0006_plan_chats.sql``: argument names are checked (a
misspelt one is ``PGRST202``), a function validates everything before it changes anything (the
rollback of a failing call), and the confirmation writes the plan through the plan functions of the
plan fake, so the plan and the closing of the conversation stand or fall together.

It is a test double, not proof that the real database behaves the same: nothing here was run
against a Supabase project.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import httpx

from tests.integration.fake_project import FakeProject
from tests.plans.fake_postgrest import db_error
from tests.sessions.ss_postgrest import ANON

OPEN_CHAT_MESSAGE = 'duplicate key value violates unique constraint "plan_chats_user_id_open_key"'
CHAT_TABLES = {"plan_chats", "plan_chat_messages"}
FUNCTIONS = {
    "rpc/app_plan_chat_open": (
        {"p_language", "p_first_learner_text", "p_first_assistant"},
        {"p_plan", "p_proposal"},
    ),
    "rpc/app_plan_chat_append": (
        {"p_chat", "p_messages"},
        {"p_proposal", "p_model_turns_increment"},
    ),
    "rpc/app_plan_chat_confirm": (
        {"p_chat", "p_expected_proposal_version", "p_plan_args"},
        set(),
    ),
}
KINDS = {"text", "proposal", "refusal", "redirect", "fallback", "quick_reply"}
SOURCES = {"learner", "rules", "model", "fixed"}
ROLES = {"learner", "assistant"}
RESERVED = {"select", "order", "limit", "offset"}
Fault = httpx.Response | Exception | Callable[[], httpx.Response]


def stamp(now: datetime) -> str:
    """A PostgREST timestamp: microseconds and an explicit offset."""
    return now.astimezone(UTC).isoformat(timespec="microseconds")


class ChatProject(FakeProject):
    def __init__(self) -> None:
        super().__init__()
        self.chats: dict[str, dict[str, Any]] = {}
        self.messages: list[dict[str, Any]] = []
        self.now = datetime(2026, 10, 5, 7, 0, 0, 123456, tzinfo=UTC)
        self.chat_faults: dict[str, list[Fault]] = {}
        self.chat_calls: list[tuple[str, dict[str, Any] | None]] = []
        self.race_on_open = False  # a second E31 of the account loses on the open-chat index
        self.before_confirm: Callable[[], None] | None = None  # runs as the function starts

    # -- helpers for tests -----------------------------------------------------------------------

    def fail(self, name: str, *answers: Fault) -> None:
        """Queue one-shot answers for ``plan_chats``, ``plan_chat_messages`` or ``rpc/app_...``;
        a callable runs when the request arrives (to simulate a race)."""
        self.chat_faults.setdefault(name, []).extend(answers)

    def rpc_calls(self, function: str) -> list[dict[str, Any]]:
        return [body or {} for name, body in self.chat_calls if name == f"rpc/{function}"]

    def messages_of(self, chat_id: str) -> list[dict[str, Any]]:
        return sorted(
            (m for m in self.messages if m["chat_id"] == chat_id), key=lambda m: m["ordinal"]
        )

    def chats_of(self, user_id: UUID) -> list[dict[str, Any]]:
        return [c for c in self.chats.values() if c["user_id"] == str(user_id)]

    # -- the transport ---------------------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.removeprefix("/rest/v1/")
        if name not in CHAT_TABLES and name not in FUNCTIONS:
            return super().handle(request)
        self.requests.append(request)
        body = json.loads(request.content) if request.content else None
        self.chat_calls.append((name, body))
        queued = self.chat_faults.get(name)
        if queued:
            answer = queued.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer if isinstance(answer, httpx.Response) else answer()
        if request.headers.get("apikey") != ANON:
            return httpx.Response(401, json={"message": "Invalid API key"})
        authorization = request.headers.get("authorization", "")
        user = (
            self.plans.tokens.get(authorization.removeprefix("Bearer ")) if authorization else None
        )
        if user is None:
            return httpx.Response(
                401, json={"code": "PGRST301", "message": "JWT expired", "details": None}
            )
        if name in CHAT_TABLES:
            return self._select(name, request, user)
        required, optional = FUNCTIONS[name]
        given = set(body or {})
        if not required <= given <= required | optional:
            return db_error(404, "PGRST202")
        handler = {
            "rpc/app_plan_chat_open": self._open,
            "rpc/app_plan_chat_append": self._append,
            "rpc/app_plan_chat_confirm": self._confirm,
        }[name]
        return handler(body or {}, user)

    # -- reads (row-level security: the caller's own rows) --------------------------------------

    def _select(self, name: str, request: httpx.Request, user: UUID) -> httpx.Response:
        rows = list(self.chats.values()) if name == "plan_chats" else list(self.messages)
        rows = [row for row in rows if row["user_id"] == str(user)]
        for key, value in request.url.params.multi_items():
            if key in RESERVED:
                continue
            operator, _, wanted = value.partition(".")
            assert operator == "eq", f"the fake supports eq only, got {key}={value}"
            rows = [row for row in rows if str(row.get(key)).lower() == wanted.lower()]
        order = request.url.params.get("order")
        if order:
            column, _, direction = order.partition(".")
            rows = sorted(rows, key=lambda row: row[column], reverse=direction == "desc")
        offset = int(request.url.params.get("offset", 0))
        limit = request.url.params.get("limit")
        rows = rows[offset : offset + int(limit)] if limit else rows[offset:]
        return httpx.Response(200, json=rows)

    # -- the functions --------------------------------------------------------------------------

    @staticmethod
    def _messages_valid(messages: list[dict[str, Any]], *, with_role: bool) -> bool:
        for message in messages:
            text = message.get("text")
            if message.get("kind") not in KINDS or message.get("source") not in SOURCES:
                return False
            if not isinstance(text, str) or len(text) > 2000:
                return False
            if with_role and message.get("role") not in ROLES:
                return False
        return True

    def _insert(
        self, chat: dict[str, Any], user: UUID, rows: list[tuple[str, dict[str, Any]]]
    ) -> None:
        ordinal = max(
            (m["ordinal"] for m in self.messages if m["chat_id"] == chat["id"]), default=0
        )
        for role, message in rows:
            ordinal += 1
            self.messages.append(
                {
                    "id": str(uuid.uuid4()),
                    "chat_id": chat["id"],
                    "user_id": str(user),
                    "ordinal": ordinal,
                    "role": role,
                    "kind": message["kind"],
                    "text": message["text"],
                    "source": message["source"],
                    "payload": message.get("payload"),
                    "created_at": stamp(self.now),
                }
            )

    def _open(self, args: dict[str, Any], user: UUID) -> httpx.Response:
        first = args["p_first_assistant"]
        messages = [first] if isinstance(first, dict) else first
        if not isinstance(messages, list) or not messages:
            return db_error(400, "22023", "p_first_assistant")
        proposal = args.get("p_proposal")
        plan_id = args.get("p_plan")
        learner_text = args["p_first_learner_text"]
        if args["p_language"] not in ("ar", "en") or not self._messages_valid(
            messages, with_role=False
        ):
            return db_error(400, "23514")
        if learner_text is not None and len(learner_text) > 2000:
            return db_error(400, "23514")
        if plan_id is not None:
            plan = self.plans.plans.get(str(plan_id))
            if plan is not None and plan["user_id"] == str(user) and plan["status"] == "completed":
                return db_error(400, "QT003", "plan_not_active")
            if plan is None or plan["user_id"] != str(user):
                return db_error(409, "23503")
        replaced = None
        for chat in self.chats.values():
            if chat["user_id"] == str(user) and chat["status"] == "open":
                if self.race_on_open:
                    return db_error(409, "23505", OPEN_CHAT_MESSAGE)
                chat.update(
                    status="abandoned", closed_at=stamp(self.now), updated_at=stamp(self.now)
                )
                replaced = chat["id"]
        chat = {
            "id": str(uuid.uuid4()),
            "user_id": str(user),
            "plan_id": plan_id,
            "status": "open",
            "language": args["p_language"],
            "proposal": proposal,
            "proposal_version": 0 if proposal is None else 1,
            "model_turns": 0,
            "created_at": stamp(self.now),
            "updated_at": stamp(self.now),
            "closed_at": None,
        }
        self.chats[chat["id"]] = chat
        rows = [("learner", {"kind": "text", "text": learner_text, "source": "learner"})]
        if learner_text is None:
            rows = []
        rows += [("assistant", message) for message in messages]
        self._insert(chat, user, rows)
        return httpx.Response(200, json=[{"chat_id": chat["id"], "replaced_chat_id": replaced}])

    def _own(self, chat_id: Any, user: UUID) -> dict[str, Any] | None:
        chat = self.chats.get(str(chat_id))
        return chat if chat is not None and chat["user_id"] == str(user) else None

    def _append(self, args: dict[str, Any], user: UUID) -> httpx.Response:
        messages = args["p_messages"]
        increment = args.get("p_model_turns_increment") or 0
        if not isinstance(messages, list) or increment < 0:
            return db_error(400, "22023")
        chat = self._own(args["p_chat"], user)
        if chat is None:
            return db_error(500, "P0002", "chat_not_found")
        if chat["status"] != "open":
            return db_error(400, "QT003", "invalid_state")
        if not self._messages_valid(messages, with_role=True):
            return db_error(400, "23514")
        self._insert(chat, user, [(m["role"], m) for m in messages])
        proposal = args.get("p_proposal")
        if proposal is not None:
            chat["proposal"] = proposal
            chat["proposal_version"] += 1
        chat["model_turns"] += increment
        chat["updated_at"] = stamp(self.now)
        return httpx.Response(200, json=chat["proposal_version"])

    def _confirm(self, args: dict[str, Any], user: UUID) -> httpx.Response:
        if self.before_confirm is not None:
            self.before_confirm()
        plan_args = args["p_plan_args"]
        if not isinstance(plan_args, dict) or not isinstance(plan_args.get("phases"), list):
            return db_error(400, "22023")
        chat = self._own(args["p_chat"], user)
        if chat is None:
            return db_error(500, "P0002", "chat_not_found")
        if chat["status"] != "open" or chat["proposal"] is None:
            return db_error(400, "QT003", "invalid_state")
        if chat["proposal_version"] != args["p_expected_proposal_version"]:
            return db_error(400, "QT002", "version_conflict")
        proposal = chat["proposal"]
        values = {
            "p_target_scope": proposal["targetScope"],
            "p_paths": proposal["paths"],
            "p_plan_order": proposal["order"],
            "p_session_minutes": proposal["sessionMinutes"],
            "p_preferred_date": proposal["preferredDate"],
            "p_agreed_estimate": proposal["estimate"],
            "p_reason_code": plan_args["reason_code"],
            "p_policy_json": plan_args.get("policy_json") or {},
            "p_effective_learning_date": plan_args["effective_learning_date"],
            "p_phases": plan_args["phases"],
        }
        if chat["plan_id"] is None:
            answer = self.plans._rpc(
                "app_create_plan",
                {
                    "p_edition_id": proposal["editionId"],
                    **values,
                    "p_sessions": plan_args.get("sessions"),
                    "p_plan_id": plan_args.get("plan_id"),
                },
                user,
            )
            result = None if answer.status_code != 200 else answer.json()
        else:
            plan = self.plans.plans.get(str(chat["plan_id"]))
            if plan is not None and plan["status"] == "completed":
                return db_error(400, "QT003", "plan_not_active")
            expected = plan_args.get("expected_version")
            answer = self.plans._rpc(
                "app_revise_plan",
                {
                    "p_plan_id": chat["plan_id"],
                    "p_expected_version": plan["current_version"] if expected is None else expected,
                    **values,
                },
                user,
            )
            result = None if answer.status_code != 200 else chat["plan_id"]
        if result is None:
            return answer  # the call rolls back: the conversation stays open
        chat.update(status="confirmed", closed_at=stamp(self.now), updated_at=stamp(self.now))
        return httpx.Response(200, json=result)
