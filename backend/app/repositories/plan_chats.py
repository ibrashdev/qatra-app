"""Plan-conversation storage port and its in-memory implementation (memory mode).

Mirrors Plan-conversation.md §2.1 (``plan_chats`` and ``plan_chat_messages``): one ``open``
conversation per user, messages with an increasing ordinal, ``proposal_version`` and
``model_turns``. Every method takes ``user_id`` and only ever returns the caller's rows, as RLS
does in the database. The Supabase implementation arrives with B2b/B4; the contract of this
Protocol is what it must honour.
"""

from __future__ import annotations

import copy
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, TypeVar
from uuid import UUID

MAX_MESSAGE_TEXT = 2000  # check constraint on plan_chat_messages.text

T = TypeVar("T")


class ChatClosedError(Exception):
    """The conversation is not ``open`` (maps to 409 reason ``chat_closed``)."""


class ProposalStaleError(Exception):
    """The quoted proposal version is not the current one (409 reason ``proposal_stale``)."""


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


@dataclass(frozen=True)
class OpenedChat:
    chat: ChatRecord
    replaced_chat_id: UUID | None


class PlanChatRepository(Protocol):
    def open_new(
        self, user_id: UUID, *, plan_id: UUID | None, language: str, now: datetime
    ) -> OpenedChat:
        """Create an ``open`` conversation; an existing open one becomes ``abandoned``."""

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
    ) -> MessageRecord:
        """Append with the next ordinal."""

    def save_proposal(
        self, user_id: UUID, chat_id: UUID, proposal: dict[str, Any], now: datetime
    ) -> int:
        """Store the proposal and increment ``proposal_version``; return the new version."""

    def add_model_turn(self, user_id: UUID, chat_id: UUID, now: datetime) -> int:
        """Count one model call against the conversation; return the new ``model_turns``."""

    def close(
        self, user_id: UUID, chat_id: UUID, status: str, now: datetime, plan_id: UUID | None = None
    ) -> None:
        """Set ``confirmed`` or ``abandoned`` and ``closed_at``."""

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
        ``ProposalStaleError`` or ``KeyError`` (unknown)."""


class InMemoryPlanChatRepository:
    """Thread-safe memory-mode store keyed by user. Data lives for the process only."""

    def __init__(self) -> None:
        self._chats: dict[UUID, ChatRecord] = {}
        self._open_by_user: dict[UUID, UUID] = {}
        self._lock = threading.RLock()

    def _owned(self, user_id: UUID, chat_id: UUID) -> ChatRecord:
        chat = self._chats.get(chat_id)
        if chat is None or chat.user_id != user_id:
            raise KeyError("chat not found")
        return chat

    def open_new(
        self, user_id: UUID, *, plan_id: UUID | None, language: str, now: datetime
    ) -> OpenedChat:
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

    def get(self, user_id: UUID, chat_id: UUID) -> ChatRecord | None:
        with self._lock:
            chat = self._chats.get(chat_id)
            if chat is None or chat.user_id != user_id:
                return None
            return copy.deepcopy(chat)

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
    ) -> MessageRecord:
        if len(text) > MAX_MESSAGE_TEXT:
            raise ValueError("message text exceeds the column check")
        with self._lock:
            chat = self._owned(user_id, chat_id)
            record = MessageRecord(
                id=uuid.uuid4(),
                chat_id=chat_id,
                user_id=user_id,
                ordinal=len(chat.messages) + 1,
                role=role,
                kind=kind,
                text=text,
                source=source,
                payload=copy.deepcopy(payload),
                created_at=now,
            )
            chat.messages.append(record)
            chat.updated_at = now
            return copy.deepcopy(record)

    def save_proposal(
        self, user_id: UUID, chat_id: UUID, proposal: dict[str, Any], now: datetime
    ) -> int:
        with self._lock:
            chat = self._owned(user_id, chat_id)
            chat.proposal_version += 1
            chat.proposal = copy.deepcopy(proposal)
            chat.updated_at = now
            return chat.proposal_version

    def add_model_turn(self, user_id: UUID, chat_id: UUID, now: datetime) -> int:
        with self._lock:
            chat = self._owned(user_id, chat_id)
            chat.model_turns += 1
            chat.updated_at = now
            return chat.model_turns

    def close(
        self, user_id: UUID, chat_id: UUID, status: str, now: datetime, plan_id: UUID | None = None
    ) -> None:
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
