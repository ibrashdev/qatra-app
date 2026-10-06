"""The storage of offline snapshots: the memory repository mirrors ``app_create_offline_snapshot``
(atomic, idempotent per operation id, QT002 and QT004), and the PostgREST repository sends the
function exactly what migration 0005 section 7.6 expects and maps its signals (package B9)."""

from __future__ import annotations

import json
import threading
import uuid
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.errors import AppError, ErrorCode
from app.repositories.learning import NewSession
from app.repositories.offline import NewSnapshot
from tests.offline.off_support import MODES, OP, OP2, OfflineWorld, reason_of
from tests.sessions.ss_postgrest import TOKEN
from tests.sessions.ss_support import (
    NOW,
    PLAN_ID,
    QURAN_EDITION,
    QURAN_PASSAGES,
    TODAY,
    USER,
    ctx,
    error_of,
)

PLAN_VERSION = 2


def new_snapshot(
    *,
    op: UUID = OP,
    refs: tuple[str, ...] = (str(QURAN_PASSAGES[0]),),
    version: int = PLAN_VERSION,
    sessions: int = 2,
) -> NewSnapshot:
    snapshot_id = uuid.uuid4()
    return NewSnapshot(
        snapshot_id=snapshot_id,
        plan_id=PLAN_ID,
        plan_version=version,
        edition_id=QURAN_EDITION,
        bank_version=1,
        client_operation_id=op,
        download_target_refs=refs,
        schema_version=1,
        protocol_version=1,
        payload={"snapshotId": str(snapshot_id), "marker": "x"},
        sessions=tuple(
            NewSession(
                session_id=uuid.uuid4(),
                kind="game" if index else "daily",
                plan_id=PLAN_ID,
                plan_version_id=None,
                plan_version=version,
                edition_id=QURAN_EDITION,
                learning_date=TODAY,
                lesson_refs=(),
                question_refs=(),
                steps=[{"type": "learn", "n": index}],
                bank_version=1,
                created_at=NOW,
            )
            for index in range(sessions)
        ),
        created_at=NOW,
    )


# --- both repositories ---------------------------------------------------------------------------


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> OfflineWorld:
    return OfflineWorld(request.param)


def test_a_snapshot_and_its_sessions_are_stored_together(world: OfflineWorld) -> None:
    new = new_snapshot()
    created = world.repo.create_snapshot(world.ctx, new, current_plan_version=PLAN_VERSION)
    assert created.created is True and created.snapshot_id == new.snapshot_id
    stored = world.repo.read_snapshot(world.ctx, new.snapshot_id)
    assert stored is not None
    assert stored.payload == new.payload and stored.user_id == USER
    assert stored.download_target_refs == new.download_target_refs
    assert (stored.plan_id, stored.plan_version, stored.edition_id) == (
        PLAN_ID,
        PLAN_VERSION,
        QURAN_EDITION,
    )
    assert set(world.repo.session_states(world.ctx, new.snapshot_id)) == {
        (s.session_id, "prepared") for s in new.sessions
    }
    assert world.repo.find_by_operation(world.ctx, OP) == stored


def test_the_same_operation_with_the_same_input_returns_the_first_snapshot(
    world: OfflineWorld,
) -> None:
    first = new_snapshot()
    world.repo.create_snapshot(world.ctx, first, current_plan_version=PLAN_VERSION)
    second = new_snapshot()  # another snapshot id and sessions, the same operation and input
    again = world.repo.create_snapshot(world.ctx, second, current_plan_version=PLAN_VERSION)
    assert again.created is False and again.snapshot_id == first.snapshot_id
    assert world.repo.read_snapshot(world.ctx, second.snapshot_id) is None
    assert world.repo.session_states(world.ctx, second.snapshot_id) == []


@pytest.mark.parametrize(
    "other",
    [
        {"refs": (str(QURAN_PASSAGES[1]),)},
        {"refs": (str(QURAN_PASSAGES[0]), str(QURAN_PASSAGES[1]))},
    ],
)
def test_the_same_operation_with_another_input_is_an_idempotency_conflict(
    world: OfflineWorld, other: dict[str, Any]
) -> None:
    world.repo.create_snapshot(world.ctx, new_snapshot(), current_plan_version=PLAN_VERSION)
    error = error_of(
        lambda: world.repo.create_snapshot(
            world.ctx, new_snapshot(**other), current_plan_version=PLAN_VERSION
        )
    )
    assert error.code is ErrorCode.version_conflict and reason_of(error) == "idempotency_input"


def test_a_new_snapshot_needs_the_plan_version_in_force(world: OfflineWorld) -> None:
    error = error_of(
        lambda: world.repo.create_snapshot(
            world.ctx, new_snapshot(version=1), current_plan_version=PLAN_VERSION
        )
    )
    assert error.code is ErrorCode.version_conflict and reason_of(error) == "plan_version"
    assert world.session_count() == 0


def test_the_idempotent_replay_comes_before_the_version_check(world: OfflineWorld) -> None:
    new = new_snapshot()
    world.repo.create_snapshot(world.ctx, new, current_plan_version=PLAN_VERSION)
    world.set_plan_version(3)
    again = world.repo.create_snapshot(world.ctx, new_snapshot(), current_plan_version=3)
    assert again.created is False and again.snapshot_id == new.snapshot_id


def test_two_operations_are_two_snapshots_and_each_keeps_its_sessions(world: OfflineWorld) -> None:
    one, two = new_snapshot(op=OP), new_snapshot(op=OP2)
    world.repo.create_snapshot(world.ctx, one, current_plan_version=PLAN_VERSION)
    world.repo.create_snapshot(world.ctx, two, current_plan_version=PLAN_VERSION)
    assert {sid for sid, _ in world.repo.session_states(world.ctx, one.snapshot_id)} == {
        s.session_id for s in one.sessions
    }
    assert {sid for sid, _ in world.repo.session_states(world.ctx, two.snapshot_id)} == {
        s.session_id for s in two.sessions
    }


def test_a_foreign_account_reads_nothing(world: OfflineWorld) -> None:
    new = new_snapshot()
    world.repo.create_snapshot(world.ctx, new, current_plan_version=PLAN_VERSION)
    other = world.foreign()
    assert world.repo.read_snapshot(other, new.snapshot_id) is None
    assert world.repo.find_by_operation(other, OP) is None
    assert world.repo.session_states(other, new.snapshot_id) == []


def test_session_states_follow_completion(world: OfflineWorld) -> None:
    new = new_snapshot()
    world.repo.create_snapshot(world.ctx, new, current_plan_version=PLAN_VERSION)
    done = new.sessions[0].session_id
    world.learning.complete_session(world.ctx, done, 1000)
    states = dict(world.repo.session_states(world.ctx, new.snapshot_id))
    assert states[done] == "completed"
    assert states[new.sessions[1].session_id] == "prepared"


def test_an_unknown_snapshot_has_no_states_and_reads_none(world: OfflineWorld) -> None:
    unknown = uuid.uuid4()
    assert world.repo.read_snapshot(world.ctx, unknown) is None
    assert world.repo.session_states(world.ctx, unknown) == []


# --- memory mode ---------------------------------------------------------------------------------


def test_prepared_sessions_never_join_the_daily_get_or_create() -> None:
    world = OfflineWorld("memory")
    world.repo.create_snapshot(world.ctx, new_snapshot(), current_plan_version=PLAN_VERSION)
    assert world.learning.find_open_daily(world.ctx, TODAY) is None
    online = world.open("daily")
    assert online.json["status"] == "open"
    assert world.learning.find_open_daily(world.ctx, TODAY).id == online.id  # type: ignore[union-attr]


def test_a_repeated_session_id_is_refused_in_memory() -> None:
    world = OfflineWorld("memory")
    new = new_snapshot()
    world.repo.create_snapshot(world.ctx, new, current_plan_version=PLAN_VERSION)
    assert world.store is not None
    with pytest.raises(AppError) as caught:
        world.store.put_prepared_session(USER, new.sessions[0], uuid.uuid4())
    assert caught.value.code is ErrorCode.unavailable


def test_parallel_downloads_of_one_operation_make_one_snapshot() -> None:
    world = OfflineWorld("memory")
    results: list[tuple[str, bool]] = []
    failures: list[BaseException] = []

    def download() -> None:
        try:
            snapshot, created = world.create()
            results.append((snapshot["snapshotId"], created))
        except BaseException as error:  # noqa: BLE001 - collected and asserted below
            failures.append(error)

    threads = [threading.Thread(target=download) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failures == []
    assert len({snapshot_id for snapshot_id, _ in results}) == 1
    assert sum(1 for _, created in results if created) == 1
    (snapshot_id,) = {sid for sid, _ in results}
    assert len(world.repo.snapshots) == 1
    stored_sessions = world.repo.session_states(world.ctx, UUID(snapshot_id))
    assert world.session_count() == len(stored_sessions) > 0


# --- PostgREST -----------------------------------------------------------------------------------


@pytest.fixture
def pg() -> OfflineWorld:
    return OfflineWorld("postgrest")


def test_the_function_gets_exactly_its_arguments(pg: OfflineWorld) -> None:
    snapshot, _ = pg.create()
    assert pg.fake is not None
    (call,) = pg.fake.snapshot_bodies
    assert set(call) == {
        "p_plan_id",
        "p_plan_version",
        "p_bank_version",
        "p_client_operation_id",
        "p_download_target_refs",
        "p_schema_version",
        "p_protocol_version",
        "p_payload",
        "p_sessions",
        "p_snapshot_id",
    }
    assert call["p_plan_id"] == str(PLAN_ID) and call["p_plan_version"] == 2
    assert call["p_bank_version"] == 1 and call["p_client_operation_id"] == str(OP)
    assert call["p_schema_version"] == call["p_protocol_version"] == 1
    assert call["p_download_target_refs"] == snapshot["downloadedTargetRefs"]
    assert call["p_snapshot_id"] == snapshot["snapshotId"] == call["p_payload"]["snapshotId"]
    assert call["p_payload"] == snapshot
    assert [e["id"] for e in call["p_sessions"]] == [
        s["sessionId"] for s in snapshot["preparedSessions"]
    ]
    for element, session in zip(call["p_sessions"], snapshot["preparedSessions"], strict=True):
        assert set(element) == {
            "id",
            "kind",
            "phase_id",
            "learning_date",
            "lesson_refs",
            "question_refs",
            "steps",
            "bank_version",
        }
        assert element["phase_id"] is None and element["steps"] == session["steps"]
        assert element["learning_date"] == session["learningDate"]
        assert all(UUID(ref) for ref in element["question_refs"] + element["lesson_refs"])
    assert TOKEN not in json.dumps(call)
    request = next(r for r in pg.fake.requests if "rpc/app_create_offline_snapshot" in str(r.url))
    assert request.headers["authorization"] == f"Bearer {TOKEN}"


def test_the_question_references_of_a_session_are_its_question_steps(pg: OfflineWorld) -> None:
    snapshot, _ = pg.create()
    assert pg.fake is not None
    (call,) = pg.fake.snapshot_bodies
    for element, session in zip(call["p_sessions"], snapshot["preparedSessions"], strict=True):
        asked = [s["question"]["questionId"] for s in session["steps"] if s["type"] == "question"]
        assert element["question_refs"] == asked


def error_response(status: int, code: str) -> Any:
    return lambda request: httpx.Response(
        status, json={"code": code, "message": "refused", "details": None, "hint": None}
    )


def test_an_idempotency_signal_is_a_conflict(pg: OfflineWorld) -> None:
    assert pg.fake is not None
    pg.fake.fail("rpc/app_create_offline_snapshot", error_response(400, "QT004"))
    error = error_of(lambda: pg.create())
    assert error.code is ErrorCode.version_conflict and reason_of(error) == "idempotency_input"


def test_a_version_signal_names_the_current_version(pg: OfflineWorld) -> None:
    assert pg.fake is not None
    pg.set_plan_version(3)
    pg.fake.fail("rpc/app_create_offline_snapshot", error_response(400, "QT002"))
    error = error_of(lambda: pg.create(version=3))
    assert error.code is ErrorCode.version_conflict
    assert reason_of(error) == "plan_version" and error.details["currentVersion"] == 3


def test_an_unknown_plan_signal_is_not_found(pg: OfflineWorld) -> None:
    assert pg.fake is not None
    pg.fake.fail("rpc/app_create_offline_snapshot", error_response(500, "P0002"))
    assert error_of(lambda: pg.create()).code is ErrorCode.not_found


@pytest.mark.parametrize("status", [500, 502, 503])
def test_a_database_failure_is_unavailable_and_stores_nothing(
    pg: OfflineWorld, status: int
) -> None:
    assert pg.fake is not None
    pg.fake.fail("rpc/app_create_offline_snapshot", lambda r: httpx.Response(status, text="down"))
    error = error_of(lambda: pg.create())
    assert error.code is ErrorCode.unavailable
    assert pg.fake.tables["offline_snapshots"] == []


def test_a_refused_token_is_unauthenticated(pg: OfflineWorld) -> None:
    stranger = ctx(token="expired-token-0001")
    request = pg.offline.parse_create(pg.body())
    error = error_of(lambda: pg.offline.create_snapshot(stranger, PLAN_ID, request))
    assert error.code in (ErrorCode.unauthenticated, ErrorCode.not_found)


def test_a_lost_response_is_retried_with_the_same_operation(pg: OfflineWorld) -> None:
    """The function committed but the answer never arrived: the retry returns that snapshot."""
    first, _ = pg.create()
    assert pg.fake is not None
    again, created = pg.create()
    assert created is False and again == first
    assert len(pg.fake.tables["offline_snapshots"]) == 1
    assert len(pg.fake.tables["learning_sessions"]) == len(first["preparedSessions"])


def test_the_dates_are_plain_iso_text(pg: OfflineWorld) -> None:
    snapshot, _ = pg.create()
    assert pg.fake is not None
    (call,) = pg.fake.snapshot_bodies
    assert date.fromisoformat(call["p_sessions"][0]["learning_date"]) == TODAY
    assert datetime.fromisoformat(snapshot["verifiedAt"]).tzinfo is UTC
