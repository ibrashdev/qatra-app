"""Plan-conversation storage: the port and its two implementations (memory mode and PostgREST).

Mirrors Plan-conversation.md §2.1 (``plan_chats`` and ``plan_chat_messages``): one ``open``
conversation per user, messages with an increasing ordinal, ``proposal_version`` and
``model_turns``. Every method takes ``user_id`` and only ever returns the caller's rows, as RLS
does in the database.

- ``InMemoryPlanChatRepository`` (memory mode): thread-safe, process lifetime only. It also
  implements ``commit_and_close``, which writes the plan and closes the conversation under one
  lock (``LocalPlanChatRepository``).
- ``PostgrestPlanChatRepository`` (supabase mode): one instance per request, bound to the
  learner's session. Writes go only through the SECURITY INVOKER functions of migration 0006
  (``app_plan_chat_open``, ``app_plan_chat_append``, ``app_plan_chat_confirm``) under the learner's
  own access token, so row-level security applies; reads are plain selects of the learner's own
  rows. ``service_role`` and the ``qatra_server`` connection are never used here. The database
  stamps ids and timestamps of stored messages.

The first turn of E31 is stored in one call (``open_chat``): the database function writes the new
conversation, the learner's goal text, the assistant messages and the first proposal together and
abandons the previous open conversation only if all of that succeeded. The confirmation of E34 is
one database function as well (``confirm``: the plan write and the closing share a transaction).

Database signals map to the exception types below and to those of ``app.domain.planning_port``.
Messages and details of the database are never read, logged or forwarded.
"""

from __future__ import annotations

import copy
import logging
import threading
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol, TypeVar
from uuid import UUID

from pydantic import SecretStr

from app.dependencies import SessionContext
from app.domain.planning_port import ActivePlanConflict, PlanNotActive, PlanNotFound
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.postgrest import DbSignal, PostgrestClient, require_token
from app.repositories.plans import ACTIVE_PLAN_CONSTRAINT

logger = logging.getLogger("qatra.plan_chat_store")

MAX_MESSAGE_TEXT = 2000  # check constraint on plan_chat_messages.text
OPEN_CHAT_CONSTRAINT = "plan_chats_user_id_open_key"
CHAT_COLUMNS = (
    "id,plan_id,status,language,proposal,proposal_version,model_turns,created_at,updated_at,"
    "closed_at"
)
MESSAGE_COLUMNS = "id,ordinal,role,kind,text,source,payload,created_at"

T = TypeVar("T")


class ChatNotFoundError(KeyError):
    """The conversation does not exist or is not the caller's (maps to 404)."""


class ChatClosedError(Exception):
    """The conversation is not ``open`` (maps to 409 reason ``chat_closed``)."""


class ProposalStaleError(Exception):
    """The quoted proposal version is not the current one (409 reason ``proposal_stale``)."""


class PlanVersionMoved(Exception):
    """The revision step of a confirmation found the plan at another version than the
    conversation's snapshot. The caller reads the plan's current version (409 reason
    ``plan_version``)."""


@dataclass
class MessageRecord:
    id: UUID
    chat_id: UUID
    user_id: UUID
    ordinal: int
    role: str  # learner | assistant
    kind: str  # text | proposal | refusal | redirect | fallback | quick_reply
    text: str
    source: str  # learner | rules | model | fixed
    payload: dict[str, Any] | None
    created_at: datetime


@dataclass
class ChatRecord:
    id: UUID
    user_id: UUID
    plan_id: UUID | None
    status: str  # open | confirmed | abandoned
    language: str
    proposal: dict[str, Any] | None
    proposal_version: int
    model_turns: int
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None = None
    messages: list[MessageRecord] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class OpenedChat:
    chat: ChatRecord
    replaced_chat_id: UUID | None


@dataclass(frozen=True, slots=True)
class NewMessage:
    """A message to store. ``payload`` is the proposal snapshot or the quick-reply code, never a
    model's raw output."""

    role: str
    kind: str
    text: str
    source: str
    payload: dict[str, Any] | None = None


class PlanChatRepository(Protocol):
    """What the conversation needs in every mode."""

    def open_chat(
        self,
        user_id: UUID,
        *,
        plan_id: UUID | None,
        language: str,
        learner_text: str,
        assistant: Sequence[NewMessage],
        proposal: dict[str, Any],
        model_turns: int,
        now: datetime,
    ) -> OpenedChat:
        """Store a new ``open`` conversation with its whole first turn: the learner's goal text,
        the assistant messages in order (all with role ``assistant``), the proposal (version 1)
        and the model turns the first turn used. An existing open conversation becomes
        ``abandoned`` in the same unit of work. Raises ``PlanNotActive`` for a completed plan and
        ``PlanNotFound`` for an unknown or foreign plan."""

    def get(self, user_id: UUID, chat_id: UUID) -> ChatRecord | None:
        """The caller's conversation with its messages, or ``None``."""

    def append_message(
        self,
        user_id: UUID,
        chat_id: UUID,
        *,
        role: str,
        kind: str,
        text: str,
        source: str,
        payload: dict[str, Any] | None,
        now: datetime,
    ) -> None:
        """Append with the next ordinal. Raises ``ChatClosedError`` or ``ChatNotFoundError``."""

    def save_proposal(
        self, user_id: UUID, chat_id: UUID, proposal: dict[str, Any], now: datetime
    ) -> int:
        """Store the proposal and increment ``proposal_version``; return the new version."""

    def add_model_turn(self, user_id: UUID, chat_id: UUID, now: datetime) -> None:
        """Count one model call against the conversation."""


class LocalPlanChatRepository(PlanChatRepository, Protocol):
    """Memory mode: the plan write and the closing of the conversation under one lock."""

    def commit_and_close(
        self,
        user_id: UUID,
        chat_id: UUID,
        proposal_version: int,
        commit: Callable[[ChatRecord], T],
        now: datetime,
    ) -> T:
        """Atomic confirm (Plan-conversation §2.9 item 7): re-check ``open`` and the quoted
        version, run ``commit`` (the plan write) and mark the conversation ``confirmed`` in the
        same unit of work. If ``commit`` raises, nothing is closed. Raises ``ChatClosedError``,
        ``ProposalStaleError`` or ``ChatNotFoundError``."""


# --- memory mode ----------------------------------------------------------------------------------


class InMemoryPlanChatRepository:
    """Thread-safe memory-mode store keyed by user. Data lives for the process only."""

    def __init__(self) -> None:
        self._chats: dict[UUID, ChatRecord] = {}
        self._open_by_user: dict[UUID, UUID] = {}
        self._lock = threading.RLock()

    def _owned(self, user_id: UUID, chat_id: UUID) -> ChatRecord:
        chat = self._chats.get(chat_id)
        if chat is None or chat.user_id != user_id:
            raise ChatNotFoundError("chat not found")
        return chat

    def open_new(
        self, user_id: UUID, *, plan_id: UUID | None, language: str, now: datetime
    ) -> OpenedChat:
        """An empty ``open`` conversation; an existing open one becomes ``abandoned``."""
        with self._lock:
            replaced: UUID | None = None
            previous_id = self._open_by_user.pop(user_id, None)
            if previous_id is not None:
                previous = self._chats[previous_id]
                previous.status = "abandoned"
                previous.closed_at = now
                previous.updated_at = now
                replaced = previous_id
            chat = ChatRecord(
                id=uuid.uuid4(),
                user_id=user_id,
                plan_id=plan_id,
                status="open",
                language=language,
                proposal=None,
                proposal_version=0,
                model_turns=0,
                created_at=now,
                updated_at=now,
            )
            self._chats[chat.id] = chat
            self._open_by_user[user_id] = chat.id
            return OpenedChat(copy.deepcopy(chat), replaced)

    def open_chat(
        self,
        user_id: UUID,
        *,
        plan_id: UUID | None,
        language: str,
        learner_text: str,
        assistant: Sequence[NewMessage],
        proposal: dict[str, Any],
        model_turns: int,
        now: datetime,
    ) -> OpenedChat:
        if not assistant or any(m.role != "assistant" for m in assistant):
            raise ValueError("the first turn is the goal text followed by assistant messages")
        messages = [NewMessage("learner", "text", learner_text, "learner"), *assistant]
        if any(len(m.text) > MAX_MESSAGE_TEXT for m in messages):
            raise ValueError("message text exceeds the column check")
        with self._lock:
            opened = self.open_new(user_id, plan_id=plan_id, language=language, now=now)
            chat = self._chats[opened.chat.id]
            for message in messages:
                self._store(chat, message, now)
            chat.proposal = copy.deepcopy(proposal)
            chat.proposal_version = 1
            chat.model_turns = model_turns
            chat.updated_at = now
            return OpenedChat(copy.deepcopy(chat), opened.replaced_chat_id)

    def get(self, user_id: UUID, chat_id: UUID) -> ChatRecord | None:
        with self._lock:
            chat = self._chats.get(chat_id)
            if chat is None or chat.user_id != user_id:
                return None
            return copy.deepcopy(chat)

    @staticmethod
    def _store(chat: ChatRecord, message: NewMessage, now: datetime) -> None:
        chat.messages.append(
            MessageRecord(
                id=uuid.uuid4(),
                chat_id=chat.id,
                user_id=chat.user_id,
                ordinal=len(chat.messages) + 1,
                role=message.role,
                kind=message.kind,
                text=message.text,
                source=message.source,
                payload=copy.deepcopy(message.payload),
                created_at=now,
            )
        )
        chat.updated_at = now

    def append_message(
        self,
        user_id: UUID,
        chat_id: UUID,
        *,
        role: str,
        kind: str,
        text: str,
        source: str,
        payload: dict[str, Any] | None,
        now: datetime,
    ) -> None:
        if len(text) > MAX_MESSAGE_TEXT:
            raise ValueError("message text exceeds the column check")
        with self._lock:
            chat = self._owned(user_id, chat_id)
            if chat.status != "open":
                raise ChatClosedError
            self._store(chat, NewMessage(role, kind, text, source, payload), now)

    def save_proposal(
        self, user_id: UUID, chat_id: UUID, proposal: dict[str, Any], now: datetime
    ) -> int:
        with self._lock:
            chat = self._owned(user_id, chat_id)
            chat.proposal_version += 1
            chat.proposal = copy.deepcopy(proposal)
            chat.updated_at = now
            return chat.proposal_version

    def add_model_turn(self, user_id: UUID, chat_id: UUID, now: datetime) -> None:
        with self._lock:
            chat = self._owned(user_id, chat_id)
            chat.model_turns += 1
            chat.updated_at = now

    def close(
        self, user_id: UUID, chat_id: UUID, status: str, now: datetime, plan_id: UUID | None = None
    ) -> None:
        """Set ``confirmed`` or ``abandoned`` and ``closed_at``."""
        with self._lock:
            chat = self._owned(user_id, chat_id)
            chat.status = status
            chat.closed_at = now
            chat.updated_at = now
            if plan_id is not None:
                chat.plan_id = plan_id
            if self._open_by_user.get(user_id) == chat_id:
                del self._open_by_user[user_id]

    def commit_and_close(
        self,
        user_id: UUID,
        chat_id: UUID,
        proposal_version: int,
        commit: Callable[[ChatRecord], T],
        now: datetime,
    ) -> T:
        with self._lock:
            chat = self._owned(user_id, chat_id)
            if chat.status != "open":
                raise ChatClosedError
            if chat.proposal is None or chat.proposal_version != proposal_version:
                raise ProposalStaleError
            result = commit(copy.deepcopy(chat))
            chat.status = "confirmed"
            chat.closed_at = now
            chat.updated_at = now
            if self._open_by_user.get(user_id) == chat_id:
                del self._open_by_user[user_id]
            return result


# --- supabase mode --------------------------------------------------------------------------------


def _unexpected(signal: DbSignal) -> AppError:
    """A database signal this call does not expect: logged by code only, answered ``internal``."""
    log_event(logger, "db_signal_unexpected", level=logging.ERROR, sqlstate=signal.sqlstate)
    return AppError(ErrorCode.internal)


def _bad_row(kind: str) -> AppError:
    log_event(logger, "plan_chat_row_invalid", level=logging.ERROR, kind=kind)
    return AppError(ErrorCode.internal)


def _timestamp(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value))
    aware = parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return aware.astimezone(UTC).replace(microsecond=0)


def _optional_timestamp(value: Any) -> datetime | None:
    return None if value is None else _timestamp(value)


def _object_or_none(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _message_json(message: NewMessage) -> dict[str, Any]:
    """One element of ``p_messages`` / ``p_first_assistant``. A missing payload is left out: the
    function reads it as null, and no JSON null reaches a jsonb argument."""
    body: dict[str, Any] = {
        "role": message.role,
        "kind": message.kind,
        "text": message.text,
        "source": message.source,
    }
    if message.payload is not None:
        body["payload"] = message.payload
    return body


def _chat_of(
    user_id: UUID, row: Mapping[str, Any], messages: Sequence[Mapping[str, Any]]
) -> ChatRecord:
    try:
        chat_id = UUID(str(row["id"]))
        plan_id = row.get("plan_id")
        return ChatRecord(
            id=chat_id,
            user_id=user_id,
            plan_id=None if plan_id is None else UUID(str(plan_id)),
            status=str(row["status"]),
            language=str(row["language"]),
            proposal=_object_or_none(row.get("proposal")),
            proposal_version=int(row["proposal_version"]),
            model_turns=int(row["model_turns"]),
            created_at=_timestamp(row["created_at"]),
            updated_at=_timestamp(row["updated_at"]),
            closed_at=_optional_timestamp(row.get("closed_at")),
            messages=[
                MessageRecord(
                    id=UUID(str(item["id"])),
                    chat_id=chat_id,
                    user_id=user_id,
                    ordinal=int(item["ordinal"]),
                    role=str(item["role"]),
                    kind=str(item["kind"]),
                    text=str(item["text"]),
                    source=str(item["source"]),
                    payload=_object_or_none(item.get("payload")),
                    created_at=_timestamp(item["created_at"]),
                )
                for item in messages
            ],
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        raise _bad_row("chat_shape") from None


def _rpc_int(result: Any) -> int:
    if isinstance(result, bool) or not isinstance(result, int):
        raise _bad_row("rpc_result")
    return result


def _opened_ids(result: Any) -> tuple[UUID, UUID | None]:
    """``app_plan_chat_open`` returns one ``(chat_id, replaced_chat_id)`` row."""
    row = result[0] if isinstance(result, list) and result else result
    try:
        replaced = row.get("replaced_chat_id")
        return UUID(str(row["chat_id"])), None if replaced is None else UUID(str(replaced))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise _bad_row("rpc_result") from None


class PostgrestPlanChatRepository:
    """The learner's own conversations over PostgREST, bound to one request's session."""

    def __init__(self, client: PostgrestClient, ctx: SessionContext) -> None:
        self._client = client
        self._ctx = ctx

    def __repr__(self) -> str:
        return "PostgrestPlanChatRepository(<redacted>)"

    def _token(self) -> SecretStr:
        return require_token(self._ctx.access_token)

    def _own(self, user_id: UUID) -> None:
        if user_id != self._ctx.user_id:
            raise AppError(ErrorCode.internal)  # a programming error, never a client condition

    # -- reads ---------------------------------------------------------------------------------

    def get(self, user_id: UUID, chat_id: UUID) -> ChatRecord | None:
        self._own(user_id)
        token = self._token()
        own = {"id": f"eq.{chat_id}", "user_id": f"eq.{user_id}"}
        rows = self._client.select("plan_chats", columns=CHAT_COLUMNS, filters=own, token=token)
        if not rows:
            return None
        messages = self._client.select_all(
            "plan_chat_messages",
            columns=MESSAGE_COLUMNS,
            filters={"chat_id": f"eq.{chat_id}", "user_id": f"eq.{user_id}"},
            order="ordinal.asc",
            token=token,
        )
        return _chat_of(user_id, rows[0], messages)

    # -- writes: one database function each -----------------------------------------------------

    def open_chat(
        self,
        user_id: UUID,
        *,
        plan_id: UUID | None,
        language: str,
        learner_text: str,
        assistant: Sequence[NewMessage],
        proposal: dict[str, Any],
        model_turns: int,
        now: datetime,
    ) -> OpenedChat:
        self._own(user_id)
        # Optional arguments are left out, not sent as null: they default to null in the function.
        arguments: dict[str, Any] = {
            "p_language": language,
            "p_first_learner_text": learner_text,
            "p_first_assistant": [_message_json(message) for message in assistant],
            "p_proposal": proposal,
        }
        if plan_id is not None:
            arguments["p_plan"] = str(plan_id)
        try:
            result = self._client.rpc("app_plan_chat_open", arguments, token=self._token())
        except DbSignal as signal:
            if signal.sqlstate == "QT003":  # the plan completed after the service read it
                raise PlanNotActive from None
            if signal.sqlstate == "23503":  # an unknown or foreign plan
                raise PlanNotFound from None
            if signal.sqlstate == "23505" and signal.constraint == OPEN_CHAT_CONSTRAINT:
                # Two simultaneous E31 calls of one account: the later one loses.
                log_event(logger, "plan_chat_open_race", level=logging.WARNING)
                raise AppError(ErrorCode.unavailable) from None
            raise _unexpected(signal) from None
        chat_id, replaced = _opened_ids(result)
        if model_turns:
            self._append(chat_id, [], None, model_turns)
        chat = self.get(user_id, chat_id)
        if chat is None:
            raise _bad_row("chat_missing")
        return OpenedChat(chat, replaced)

    def _append(
        self,
        chat_id: UUID,
        messages: list[dict[str, Any]],
        proposal: dict[str, Any] | None,
        model_turns: int,
    ) -> int:
        """``app_plan_chat_append``: messages, an optional new proposal (version + 1) and the
        model-turn increment in one call; returns the proposal version after the call."""
        arguments: dict[str, Any] = {
            "p_chat": str(chat_id),
            "p_messages": messages,
            "p_model_turns_increment": model_turns,
        }
        if proposal is not None:
            arguments["p_proposal"] = proposal
        try:
            result = self._client.rpc("app_plan_chat_append", arguments, token=self._token())
        except DbSignal as signal:
            if signal.sqlstate == "P0002":
                raise ChatNotFoundError("chat not found") from None
            if signal.sqlstate == "QT003":
                raise ChatClosedError from None
            raise _unexpected(signal) from None
        return _rpc_int(result)

    def append_message(
        self,
        user_id: UUID,
        chat_id: UUID,
        *,
        role: str,
        kind: str,
        text: str,
        source: str,
        payload: dict[str, Any] | None,
        now: datetime,
    ) -> None:
        self._own(user_id)
        message = NewMessage(role, kind, text, source, payload)
        self._append(chat_id, [_message_json(message)], None, 0)

    def save_proposal(
        self, user_id: UUID, chat_id: UUID, proposal: dict[str, Any], now: datetime
    ) -> int:
        self._own(user_id)
        return self._append(chat_id, [], proposal, 0)

    def add_model_turn(self, user_id: UUID, chat_id: UUID, now: datetime) -> None:
        self._own(user_id)
        self._append(chat_id, [], None, 1)

    def confirm(
        self,
        user_id: UUID,
        chat_id: UUID,
        proposal_version: int,
        plan_args: Mapping[str, Any],
        now: datetime,
    ) -> UUID:
        """``app_plan_chat_confirm``: the plan write (creation, or the revision of the chat's
        plan) and the closing of the conversation in one transaction; returns the plan id.

        ``plan_args`` is ``PlanCommit.plan_args()`` (plus ``expected_version`` for a revision).
        The plan values come from the stored proposal inside the function. Raises
        ``ChatClosedError``, ``ProposalStaleError``, ``PlanVersionMoved``, ``PlanNotActive``,
        ``PlanNotFound``, ``ActivePlanConflict`` or ``ChatNotFoundError``."""
        self._own(user_id)
        arguments = {
            "p_chat": str(chat_id),
            "p_expected_proposal_version": proposal_version,
            "p_plan_args": dict(plan_args),
        }
        try:
            result = self._client.rpc("app_plan_chat_confirm", arguments, token=self._token())
        except DbSignal as signal:
            raise self._confirm_failure(signal, user_id, chat_id, proposal_version) from None
        try:
            return UUID(str(result))
        except ValueError:
            raise _bad_row("rpc_result") from None

    def _confirm_failure(
        self, signal: DbSignal, user_id: UUID, chat_id: UUID, proposal_version: int
    ) -> Exception:
        """The function raises the same SQLSTATE for several causes, so the conversation is read
        again (the call rolled back, so its state is unchanged) to tell them apart."""
        if signal.sqlstate == "23505" and signal.constraint == ACTIVE_PLAN_CONSTRAINT:
            return ActivePlanConflict()
        if signal.sqlstate not in ("QT002", "QT003", "P0002"):
            return _unexpected(signal)
        chat = self.get(user_id, chat_id)
        if chat is None:
            return ChatNotFoundError("chat not found")
        if signal.sqlstate == "P0002":
            return PlanNotFound()  # the chat exists, so the plan of a revision is gone
        if chat.status != "open":
            return ChatClosedError()
        if signal.sqlstate == "QT002":
            if chat.proposal_version != proposal_version:
                return ProposalStaleError()
            return PlanVersionMoved()  # app_revise_plan: the plan moved since the snapshot
        # QT003 with an open conversation: no proposal, or a completed plan
        return PlanNotActive() if chat.proposal is not None else ProposalStaleError()
