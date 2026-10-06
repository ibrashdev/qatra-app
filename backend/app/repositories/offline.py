"""Offline snapshot storage (package B9): E23 creates one, E24 and E25 read it.

``OfflineRepository`` has two implementations:

- ``InMemoryOfflineRepository`` (memory mode) keeps the snapshots next to an
  ``InMemoryLearningStore`` and inserts the prepared sessions into that store under its lock, so a
  later E21 replay finds them exactly as the supabase function leaves them (``status = prepared``,
  ``offline_snapshot_id`` set). It mirrors ``app_create_offline_snapshot``: the same operation id
  with the same plan, plan version and target references returns the existing snapshot and creates
  nothing, any other input is ``idempotency_input`` (QT004), a new snapshot needs the plan version
  in force (QT002).
- ``PostgrestOfflineRepository`` (supabase mode) commits through the function
  ``app_create_offline_snapshot`` (migration 0005, one transaction for the snapshot and its
  sessions) as the learner, so row-level security applies, and reads ``offline_snapshots`` and the
  status of ``learning_sessions``. ``p_snapshot_id`` is passed so that ``payload.snapshotId`` equals
  the row id.

Error mapping is the one of ``repositories/bank.py`` (``unavailable``, ``unauthenticated``,
``not_found`` for P0002 and ``version_conflict`` ``plan_version`` for QT002) plus QT004, which is
``version_conflict`` with ``details.reason = "idempotency_input"``. Neither a payload, a token nor
an answer is logged.
"""

from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from app.dependencies import SessionContext
from app.domain.learning_state import require_datetime
from app.errors import AppError, ErrorCode
from app.providers.postgrest import DbSignal, PostgrestClient, require_token
from app.repositories.bank import LearnerClient, parse_or_internal
from app.repositories.learning import InMemoryLearningStore, NewSession

_SNAPSHOT_COLUMNS = (
    "id,user_id,plan_id,plan_version,edition_id,bank_version,client_operation_id,"
    "download_target_refs,schema_version,protocol_version,payload,created_at"
)


@dataclass(frozen=True, slots=True)
class NewSnapshot:
    """A snapshot to persist with its prepared sessions. ``payload`` is the ``PlanSnapshot`` as JSON
    (camelCase, as served) and ``payload["snapshotId"]`` equals ``snapshot_id``."""

    snapshot_id: UUID
    plan_id: UUID
    plan_version: int
    edition_id: UUID
    bank_version: int
    client_operation_id: UUID
    download_target_refs: tuple[str, ...]
    schema_version: int
    protocol_version: int
    payload: dict[str, Any]
    sessions: tuple[NewSession, ...]
    created_at: datetime  # memory mode stamps the row with it; the database uses ``now()``


@dataclass(frozen=True, slots=True)
class StoredSnapshot:
    """One ``offline_snapshots`` row."""

    id: UUID
    user_id: UUID
    plan_id: UUID
    plan_version: int
    edition_id: UUID
    bank_version: int
    client_operation_id: UUID
    download_target_refs: tuple[str, ...]
    schema_version: int
    protocol_version: int
    payload: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class CreatedSnapshot:
    """Result of ``create_snapshot``: ``created`` is false when the operation id had a snapshot."""

    snapshot_id: UUID
    created: bool


class OfflineRepository(Protocol):
    def create_snapshot(
        self, ctx: SessionContext, new: NewSnapshot, *, current_plan_version: int
    ) -> CreatedSnapshot:
        """Insert the snapshot and its ``prepared`` sessions in one step, idempotent per
        ``(user, client operation id)``. Raises ``version_conflict`` with ``details.reason``
        ``idempotency_input`` (same operation id, other input) or ``plan_version`` (the plan is no
        longer at ``new.plan_version``; ``current_plan_version`` is the version in force the caller
        read) and ``not_found`` for an unknown or foreign plan."""

    def find_by_operation(
        self, ctx: SessionContext, client_operation_id: UUID
    ) -> StoredSnapshot | None:
        """The caller's snapshot of that operation id, or ``None``."""

    def read_snapshot(self, ctx: SessionContext, snapshot_id: UUID) -> StoredSnapshot | None:
        """The caller's snapshot, or ``None`` (unknown and foreign are indistinguishable)."""

    def session_states(self, ctx: SessionContext, snapshot_id: UUID) -> list[tuple[UUID, str]]:
        """``(session id, status)`` of the caller's sessions of the snapshot, oldest first."""


# --- memory mode ---------------------------------------------------------------------------------


class InMemoryOfflineRepository:
    """Thread-safe memory-mode snapshots over the learning store of the application. Data lives
    for the process only."""

    def __init__(self, store: InMemoryLearningStore) -> None:
        self._store = store
        self._lock: threading.RLock = store.lock  # one writer: snapshot and sessions together
        self.snapshots: dict[UUID, StoredSnapshot] = {}

    def create_snapshot(
        self, ctx: SessionContext, new: NewSnapshot, *, current_plan_version: int
    ) -> CreatedSnapshot:
        with self._lock:
            existing = self._by_operation(ctx.user_id, new.client_operation_id)
            if existing is not None:
                same = (
                    existing.plan_id == new.plan_id
                    and existing.plan_version == new.plan_version
                    and existing.download_target_refs == new.download_target_refs
                )
                if not same:
                    raise AppError(
                        ErrorCode.version_conflict, details={"reason": "idempotency_input"}
                    )
                return CreatedSnapshot(existing.id, False)
            if new.plan_version != current_plan_version:
                raise AppError(ErrorCode.version_conflict, details={"reason": "plan_version"})
            if new.snapshot_id in self.snapshots:
                raise AppError(ErrorCode.unavailable)  # a repeated id is a caller bug
            for session in new.sessions:
                self._store.put_prepared_session(ctx.user_id, session, new.snapshot_id)
            self.snapshots[new.snapshot_id] = StoredSnapshot(
                id=new.snapshot_id,
                user_id=ctx.user_id,
                plan_id=new.plan_id,
                plan_version=new.plan_version,
                edition_id=new.edition_id,
                bank_version=new.bank_version,
                client_operation_id=new.client_operation_id,
                download_target_refs=new.download_target_refs,
                schema_version=new.schema_version,
                protocol_version=new.protocol_version,
                payload=copy.deepcopy(new.payload),
                created_at=new.created_at,
            )
            return CreatedSnapshot(new.snapshot_id, True)

    def _by_operation(self, user_id: UUID, operation_id: UUID) -> StoredSnapshot | None:
        return next(
            (
                s
                for s in self.snapshots.values()
                if s.user_id == user_id and s.client_operation_id == operation_id
            ),
            None,
        )

    @staticmethod
    def _copy(snapshot: StoredSnapshot) -> StoredSnapshot:
        return replace(snapshot, payload=copy.deepcopy(snapshot.payload))

    def find_by_operation(
        self, ctx: SessionContext, client_operation_id: UUID
    ) -> StoredSnapshot | None:
        with self._lock:
            found = self._by_operation(ctx.user_id, client_operation_id)
            return None if found is None else self._copy(found)

    def read_snapshot(self, ctx: SessionContext, snapshot_id: UUID) -> StoredSnapshot | None:
        with self._lock:
            found = self.snapshots.get(snapshot_id)
            if found is None or found.user_id != ctx.user_id:
                return None
            return self._copy(found)

    def session_states(self, ctx: SessionContext, snapshot_id: UUID) -> list[tuple[UUID, str]]:
        with self._lock:
            rows = [
                s
                for s in self._store.sessions.values()
                if s.user_id == ctx.user_id and s.offline_snapshot_id == snapshot_id
            ]
        rows.sort(key=lambda s: (s.created_at, str(s.id)))
        return [(s.id, s.status) for s in rows]


# --- PostgREST -----------------------------------------------------------------------------------


class PostgrestOfflineRepository:
    """Supabase-mode snapshots through PostgREST as the learner (row-level security)."""

    def __init__(self, client: PostgrestClient) -> None:
        self._client = client
        self._rest = LearnerClient(client)

    def __repr__(self) -> str:
        return "PostgrestOfflineRepository(<redacted>)"

    def create_snapshot(
        self, ctx: SessionContext, new: NewSnapshot, *, current_plan_version: int
    ) -> CreatedSnapshot:
        arguments = {
            "p_plan_id": str(new.plan_id),
            "p_plan_version": new.plan_version,
            "p_bank_version": new.bank_version,
            "p_client_operation_id": str(new.client_operation_id),
            "p_download_target_refs": list(new.download_target_refs),
            "p_schema_version": new.schema_version,
            "p_protocol_version": new.protocol_version,
            "p_payload": new.payload,
            "p_sessions": [
                {
                    "id": str(session.session_id),
                    "kind": session.kind,
                    "phase_id": None,
                    "learning_date": session.learning_date.isoformat(),
                    "lesson_refs": [str(ref) for ref in session.lesson_refs],
                    "question_refs": [str(ref) for ref in session.question_refs],
                    "steps": session.steps,
                    "bank_version": session.bank_version,
                }
                for session in new.sessions
            ],
            "p_snapshot_id": str(new.snapshot_id),
        }

        def call() -> Any:
            try:
                return self._client.rpc(
                    "app_create_offline_snapshot", arguments, token=require_token(ctx.access_token)
                )
            except DbSignal as signal:
                if signal.sqlstate == "QT004":
                    raise AppError(
                        ErrorCode.version_conflict, details={"reason": "idempotency_input"}
                    ) from None
                raise

        result = self._rest._run(call)  # noqa: SLF001 - the shared error mapping
        # ``returns table`` comes back as a one-element array (an object is tolerated).
        row = result[0] if isinstance(result, list) and result else result
        return parse_or_internal(
            lambda: CreatedSnapshot(
                snapshot_id=UUID(str(row["snapshot_id"])), created=bool(row["created"])
            )
        )

    @staticmethod
    def _snapshot(row: dict[str, Any]) -> StoredSnapshot:
        def build() -> StoredSnapshot:
            payload = row["payload"]
            refs = row["download_target_refs"]
            if not isinstance(payload, dict) or not isinstance(refs, list):
                raise ValueError("payload and refs must be an object and an array")
            return StoredSnapshot(
                id=UUID(str(row["id"])),
                user_id=UUID(str(row["user_id"])),
                plan_id=UUID(str(row["plan_id"])),
                plan_version=int(row["plan_version"]),
                edition_id=UUID(str(row["edition_id"])),
                bank_version=int(row["bank_version"]),
                client_operation_id=UUID(str(row["client_operation_id"])),
                download_target_refs=tuple(str(ref) for ref in refs),
                schema_version=int(row["schema_version"]),
                protocol_version=int(row["protocol_version"]),
                payload=payload,
                created_at=require_datetime(row["created_at"]),
            )

        return parse_or_internal(build)

    def find_by_operation(
        self, ctx: SessionContext, client_operation_id: UUID
    ) -> StoredSnapshot | None:
        rows = self._rest.select(
            ctx,
            "offline_snapshots",
            columns=_SNAPSHOT_COLUMNS,
            filters={
                "client_operation_id": f"eq.{client_operation_id}",
                "user_id": f"eq.{ctx.user_id}",
            },
            limit=1,
        )
        return self._snapshot(rows[0]) if rows else None

    def read_snapshot(self, ctx: SessionContext, snapshot_id: UUID) -> StoredSnapshot | None:
        rows = self._rest.select(
            ctx,
            "offline_snapshots",
            columns=_SNAPSHOT_COLUMNS,
            filters={"id": f"eq.{snapshot_id}", "user_id": f"eq.{ctx.user_id}"},
            limit=1,
        )
        return self._snapshot(rows[0]) if rows else None

    def session_states(self, ctx: SessionContext, snapshot_id: UUID) -> list[tuple[UUID, str]]:
        rows = self._rest.select_all(
            ctx,
            "learning_sessions",
            columns="id,status",
            filters={
                "offline_snapshot_id": f"eq.{snapshot_id}",
                "user_id": f"eq.{ctx.user_id}",
            },
            order="created_at.asc,id.asc",
        )
        return [
            parse_or_internal(lambda row=row: (UUID(str(row["id"])), str(row["status"])))
            for row in rows
        ]
