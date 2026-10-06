"""A world for the E23 to E25 tests: the sessions ``World`` plus an ``OfflineService`` over the
memory repositories or over the PostgREST adapters (the fake PostgREST of
``tests.sessions.ss_postgrest`` with the function ``app_create_offline_snapshot`` added), so one
scenario runs in both modes.

Synthetic bundles only, no network, no Arabic text of its own. ``login`` fakes the session of the
caller (a TEST-ONLY shortcut, never a real cookie).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import replace
from typing import Any
from uuid import UUID

import httpx
from fastapi import FastAPI

from app.repositories.offline import InMemoryOfflineRepository, PostgrestOfflineRepository
from app.routers.offline import install_offline
from app.services.offline import OfflineService
from tests.sessions.ss_events_support import World
from tests.sessions.ss_postgrest import TOKEN, FakePostgrest
from tests.sessions.ss_support import (
    NOW,
    OTHER_USER,
    PLAN_ID,
    PLAN_VERSION_ID,
    QURAN_EDITION,
    ctx,
)
from tests.support import make_settings

MODES = ("memory", "postgrest")
OP = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")
OP2 = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")
_UNSET: Any = object()


class OfflineFakePostgrest(FakePostgrest):
    """The fake with ``app_create_offline_snapshot`` of migration 0005 section 7.6: owner check,
    idempotency per ``(user, client_operation_id)`` (QT004 for another input), QT002 for a version
    that is not the one in force, one transaction for the snapshot and its prepared sessions."""

    def init_offline(self) -> None:
        self.tables["offline_snapshots"] = []
        self.snapshot_bodies: list[dict[str, Any]] = []
        self.current_plan_versions: dict[str, int] = {str(PLAN_ID): 2}

    def _rpc(self, name: str, args: dict[str, Any]) -> httpx.Response:
        if name != "app_create_offline_snapshot":
            return super()._rpc(name, args)
        self.snapshot_bodies.append(args)
        plan = args["p_plan_id"]
        if plan not in self.current_plan_versions:
            return self._error(500, "P0002", "plan_not_found")
        for row in self.tables["offline_snapshots"]:
            if (
                row["user_id"] == self.user_id
                and row["client_operation_id"] == args["p_client_operation_id"]
            ):
                same = (
                    row["plan_id"] == plan
                    and row["plan_version"] == args["p_plan_version"]
                    and row["download_target_refs"] == args["p_download_target_refs"]
                )
                if not same:
                    return self._error(400, "QT004", "idempotency_input")
                return httpx.Response(200, json=[{"snapshot_id": row["id"], "created": False}])
        if args["p_plan_version"] != self.current_plan_versions[plan]:
            return self._error(400, "QT002", "version_conflict")
        snapshot_id = args["p_snapshot_id"] or str(uuid.uuid4())
        self.tables["offline_snapshots"].append(
            {
                "id": snapshot_id,
                "user_id": self.user_id,
                "plan_id": plan,
                "plan_version": args["p_plan_version"],
                "edition_id": str(QURAN_EDITION),
                "bank_version": args["p_bank_version"],
                "client_operation_id": args["p_client_operation_id"],
                "download_target_refs": args["p_download_target_refs"],
                "schema_version": args["p_schema_version"],
                "protocol_version": args["p_protocol_version"],
                "payload": json.loads(json.dumps(args["p_payload"])),
                "created_at": NOW.isoformat(),
            }
        )
        for element in args["p_sessions"]:
            self.tables["learning_sessions"].append(
                {
                    "id": element["id"],
                    "user_id": self.user_id,
                    "plan_id": plan,
                    "plan_version_id": str(PLAN_VERSION_ID),
                    "edition_id": str(QURAN_EDITION),
                    "kind": element["kind"],
                    "learning_date": element["learning_date"],
                    "lesson_refs": element["lesson_refs"],
                    "question_refs": element["question_refs"],
                    "steps": element["steps"],
                    "bank_version": element["bank_version"],
                    "self_rating": None,
                    "status": "prepared",
                    "elapsed_ms": 0,
                    "offline_snapshot_id": snapshot_id,
                    "created_at": NOW.isoformat(),
                }
            )
        return httpx.Response(200, json=[{"snapshot_id": snapshot_id, "created": True}])


class OfflineWorld(World):
    """The sessions world with E23 to E25 on top, in ``memory`` or ``postgrest`` mode."""

    def __init__(
        self, mode: str = "memory", *, bundles: Sequence[dict[str, Any]] | None = None, **kw: Any
    ) -> None:
        if bundles is None:
            super().__init__(mode, **kw)
        else:
            super().__init__(mode, bundles=bundles, **kw)
        ids = iter(uuid.UUID(f"99999999-9999-4999-8999-{n:012d}") for n in range(1, 100_000))
        self.new_id = lambda: next(ids)
        if self.fake is not None:
            self.fake.__class__ = OfflineFakePostgrest
            self.fake.init_offline()  # type: ignore[attr-defined]
            self.repo: Any = PostgrestOfflineRepository(self.fake.client())
        else:
            assert self.store is not None
            self.repo = InMemoryOfflineRepository(self.store)
        self.offline = OfflineService(
            sessions=self.service, repository=self.repo, new_id=self.new_id
        )

    # -- the application -------------------------------------------------------------------------

    def app(self, **options: Any) -> FastAPI:
        app = super().app(**options)
        install_offline(
            app,
            make_settings(),
            sessions=app.state.sessions_service,
            repository=self.repo,
            new_id=self.new_id,
        )
        return app

    # -- E23 to E25 through the service ----------------------------------------------------------

    @staticmethod
    def body(
        *,
        op: UUID = OP,
        version: int = 2,
        refs: Any = _UNSET,
        **extra: Any,
    ) -> dict[str, Any]:
        """An E23 body; leave ``refs`` out to let the server choose, pass ``None`` to omit it."""
        body: dict[str, Any] = {"clientOperationId": str(op), "expectedPlanVersion": version}
        if refs is not _UNSET and refs is not None:
            body["downloadTargetRefs"] = [str(r) for r in refs]
        body.update(extra)
        return body

    def create(
        self, plan_id: UUID = PLAN_ID, raw: dict[str, Any] | None = None, **body: Any
    ) -> tuple[dict[str, Any], bool]:
        request = self.offline.parse_create(raw if raw is not None else self.body(**body))
        created = self.offline.create_snapshot(self.ctx, plan_id, request)
        return json.loads(created.snapshot.model_dump_json(by_alias=True)), created.created

    def read(self, snapshot_id: UUID | str) -> dict[str, Any]:
        found = self.offline.read_snapshot(self.ctx, UUID(str(snapshot_id)))
        return json.loads(found.model_dump_json(by_alias=True))

    def revalidate(self, snapshot: dict[str, Any], **overrides: Any) -> dict[str, Any]:
        raw = {
            "snapshotId": snapshot["snapshotId"],
            "expectedPlanVersion": snapshot["planVersion"],
            "editionId": snapshot["editionId"],
            "bankVersion": snapshot["bankVersion"],
            **overrides,
        }
        result = self.offline.revalidate(self.ctx, self.offline.parse_revalidate(raw))
        return json.loads(result.model_dump_json(by_alias=True))

    # -- plan and edition changes ----------------------------------------------------------------

    def set_plan_version(self, version: int, plan_id: UUID = PLAN_ID) -> None:
        """The plan was revised: ``current_version`` moves (and the function's version in force)."""
        self.plans.update(plan_id, current_version=version)
        if self.fake is not None:
            self.fake.current_plan_versions[str(plan_id)] = version  # type: ignore[attr-defined]

    def set_edition_status(self, status: str, *, hidden: bool = False) -> None:
        if self.mode == "memory":
            self.bank.set_status(QURAN_EDITION, status, hidden=hidden)  # type: ignore[attr-defined]
        else:
            assert self.fake is not None
            for row in self.fake.tables["book_editions"]:
                if row["id"] == str(QURAN_EDITION):
                    row["status"] = status
                    row["catalog_hidden"] = hidden

    def set_bank_version(self, version: int) -> None:
        """The edition's catalog (bank) version moved on."""
        if self.mode == "memory":
            data = self.bank._editions[QURAN_EDITION]  # type: ignore[attr-defined]
            data.info = replace(data.info, bank_version=version)
        else:
            assert self.fake is not None
            for row in self.fake.tables["book_editions"]:
                if row["id"] == str(QURAN_EDITION):
                    row["bank_version"] = version

    def foreign(self) -> Any:
        """The context of another account (with the learner token in postgrest mode)."""
        return ctx(OTHER_USER, token=TOKEN if self.mode == "postgrest" else None)

    # -- snapshot content ------------------------------------------------------------------------

    def session_count(self) -> int:
        if self.store is not None:
            return len(self.store.sessions)
        assert self.fake is not None
        return len(self.fake.tables["learning_sessions"])

    def sessions_of(
        self, snapshot: dict[str, Any], kind: str | None = None
    ) -> list[dict[str, Any]]:
        return [s for s in snapshot["preparedSessions"] if kind is None or s["kind"] == kind]

    @staticmethod
    def envelope(
        snapshot: dict[str, Any], sequence: int = 0, run: UUID | None = None
    ) -> dict[str, Any]:
        """A complete offline envelope for an event of a session of ``snapshot``."""
        return {
            "clientRunId": str(run or uuid.uuid4()),
            "snapshotId": snapshot["snapshotId"],
            "protocolVersion": 1,
            "planVersion": snapshot["planVersion"],
            "editionId": snapshot["editionId"],
            "bankVersion": snapshot["bankVersion"],
            "normalizationPolicyVersion": "arabic-norm-v1",
            "scoringPolicyVersion": "v1",
            "localSequence": sequence,
        }


def questions_of(session: dict[str, Any]) -> list[dict[str, Any]]:
    return [s["question"] for s in session["steps"] if s["type"] == "question"]


def field_rules(error: Any) -> list[tuple[str, str]]:
    return [(f["field"], f["rule"]) for f in error.details["fields"]]


def reason_of(error: Any) -> str | None:
    return error.details.get("reason")
