"""E24 and E25 through the service, in memory and PostgREST mode: reads never write, a revoked
edition is never served, and the status derivation of API-spec E25 (A-04, A-12; G-05, G-12)."""

from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

import pytest

from app.services.offline import OfflineService
from tests.offline.off_support import MODES, OP2, OfflineWorld, field_rules
from tests.sessions.ss_support import PLAN_ID, QURAN_EDITION, error_of


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> OfflineWorld:
    return OfflineWorld(request.param)


@pytest.fixture
def snapshot(world: OfflineWorld) -> dict[str, Any]:
    return world.create()[0]


# --- E24 -----------------------------------------------------------------------------------------


def test_the_snapshot_can_be_read_again_unchanged(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    assert world.read(snapshot["snapshotId"]) == snapshot


def test_a_read_never_creates_or_changes_a_session(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    before = world.session_count()
    states = world.repo.session_states(world.ctx, UUID(snapshot["snapshotId"]))
    for _ in range(3):
        world.read(snapshot["snapshotId"])
    assert world.session_count() == before
    assert world.repo.session_states(world.ctx, UUID(snapshot["snapshotId"])) == states
    assert {status for _, status in states} == {"prepared"}
    if world.fake is not None:
        assert len(world.fake.snapshot_bodies) == 1


def test_an_unknown_or_foreign_snapshot_is_not_found(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    assert error_of(lambda: world.read(uuid.uuid4())).status == 404
    foreign = error_of(
        lambda: world.offline.read_snapshot(world.foreign(), UUID(snapshot["snapshotId"]))
    )
    assert foreign.status == 404 and foreign.details == {}


def test_a_snapshot_of_a_revoked_edition_is_not_found(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_edition_status("revoked")
    assert error_of(lambda: world.read(snapshot["snapshotId"])).status == 404


@pytest.mark.parametrize(("status", "hidden"), [("published", True), ("superseded", False)])
def test_a_hidden_or_superseded_edition_still_serves_its_snapshot(
    world: OfflineWorld, snapshot: dict[str, Any], status: str, hidden: bool
) -> None:
    """Hiding stops new selection only (D44): the stored snapshot is still served."""
    world.set_edition_status(status, hidden=hidden)
    assert world.read(snapshot["snapshotId"]) == snapshot


def test_a_snapshot_whose_source_rights_were_rejected_is_not_found(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    service = OfflineService(
        sessions=world.service,
        repository=world.repo,
        new_id=world.new_id,
        rights_rejected=lambda edition: True,
    )
    error = error_of(lambda: service.read_snapshot(world.ctx, UUID(snapshot["snapshotId"])))
    assert error.status == 404


def test_a_snapshot_stays_the_snapshot_after_the_plan_moved_on(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_plan_version(3)
    assert world.read(snapshot["snapshotId"]) == snapshot  # immutable; E25 reports the change


# --- E25 -----------------------------------------------------------------------------------------


def test_a_current_snapshot_is_available_with_its_runnable_sessions(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    result = world.revalidate(snapshot)
    assert result == {
        "status": "available",
        "currentPlanVersion": 2,
        "allowedSessionRefs": [s["sessionId"] for s in snapshot["preparedSessions"]],
        "catalogVersion": 1,
        "reasonCode": "current",
    }


def test_a_completed_session_is_no_longer_runnable(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    done, *rest = snapshot["preparedSessions"]
    world.complete(UUID(done["sessionId"]))
    result = world.revalidate(snapshot)
    assert result["status"] == "available"
    assert result["allowedSessionRefs"] == [s["sessionId"] for s in rest]


def test_a_revised_plan_makes_the_snapshot_stale(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_plan_version(3)
    assert world.revalidate(snapshot) == {
        "status": "stale",
        "currentPlanVersion": 3,
        "allowedSessionRefs": [],
        "catalogVersion": 1,
        "reasonCode": "plan_version_changed",
    }


@pytest.mark.parametrize("status", ["paused", "completed"])
def test_a_plan_that_is_no_longer_active_makes_the_snapshot_stale(
    world: OfflineWorld, snapshot: dict[str, Any], status: str
) -> None:
    world.plans.update(PLAN_ID, status=status)
    result = world.revalidate(snapshot)
    assert (result["status"], result["reasonCode"]) == ("stale", "plan_version_changed")
    assert result["currentPlanVersion"] == 2 and result["allowedSessionRefs"] == []


def test_a_new_bank_version_makes_the_snapshot_stale(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_bank_version(2)
    result = world.revalidate(snapshot)
    assert (result["status"], result["reasonCode"]) == ("stale", "bank_version_changed")
    assert result["catalogVersion"] == 2 and result["allowedSessionRefs"] == []


def test_a_revoked_edition_is_revoked_with_content_revoked(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_edition_status("revoked")
    assert world.revalidate(snapshot) == {
        "status": "revoked",
        "currentPlanVersion": 2,
        "allowedSessionRefs": [],
        "catalogVersion": 1,
        "reasonCode": "content_revoked",
    }


def test_a_hidden_edition_changes_nothing(world: OfflineWorld, snapshot: dict[str, Any]) -> None:
    """Hiding stops new selection only (D44): the snapshot stays available."""
    world.set_edition_status("published", hidden=True)
    assert world.revalidate(snapshot) == {
        "status": "available",
        "currentPlanVersion": 2,
        "allowedSessionRefs": [s["sessionId"] for s in snapshot["preparedSessions"]],
        "catalogVersion": 1,
        "reasonCode": "current",
    }


def test_a_superseded_edition_makes_the_snapshot_stale_with_bank_version_changed(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_edition_status("superseded")
    assert world.revalidate(snapshot) == {
        "status": "stale",
        "currentPlanVersion": 2,
        "allowedSessionRefs": [],
        "catalogVersion": 1,
        "reasonCode": "bank_version_changed",
    }


def test_a_plan_change_is_reported_before_a_superseded_edition(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_edition_status("superseded")
    world.set_plan_version(3)
    assert world.revalidate(snapshot)["reasonCode"] == "plan_version_changed"


def test_a_snapshot_whose_source_rights_were_rejected_is_revoked(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    service = OfflineService(
        sessions=world.service,
        repository=world.repo,
        new_id=world.new_id,
        rights_rejected=lambda edition: True,
    )
    raw = service.parse_revalidate(
        {
            "snapshotId": snapshot["snapshotId"],
            "expectedPlanVersion": 2,
            "editionId": snapshot["editionId"],
            "bankVersion": 1,
        }
    )
    result = service.revalidate(world.ctx, raw)
    assert (result.status, result.reason_code) == ("revoked", "content_revoked")


def test_revoked_wins_over_stale(world: OfflineWorld, snapshot: dict[str, Any]) -> None:
    world.set_plan_version(3)
    world.set_edition_status("revoked")
    assert world.revalidate(snapshot)["status"] == "revoked"


def test_expired_is_never_reported(world: OfflineWorld, snapshot: dict[str, Any]) -> None:
    """No source or session data says validity ended, so no TTL is invented (A-04, G-05)."""
    seen = {world.revalidate(snapshot)["status"]}
    world.set_plan_version(3)
    seen.add(world.revalidate(snapshot)["status"])
    world.set_edition_status("revoked")
    seen.add(world.revalidate(snapshot)["status"])
    assert seen == {"available", "stale", "revoked"}


@pytest.mark.parametrize(
    ("field", "value", "name"),
    [
        ("expectedPlanVersion", 1, "expectedPlanVersion"),
        ("editionId", str(uuid.uuid4()), "editionId"),
        ("bankVersion", 9, "bankVersion"),
    ],
)
def test_what_the_device_holds_must_equal_the_snapshot(
    world: OfflineWorld, snapshot: dict[str, Any], field: str, value: Any, name: str
) -> None:
    error = error_of(lambda: world.revalidate(snapshot, **{field: value}))
    assert error.status == 422 and field_rules(error) == [(name, "snapshot_mismatch")]


def test_every_mismatching_field_is_named(world: OfflineWorld, snapshot: dict[str, Any]) -> None:
    error = error_of(
        lambda: world.revalidate(
            snapshot, expectedPlanVersion=5, editionId=str(uuid.uuid4()), bankVersion=7
        )
    )
    assert field_rules(error) == [
        ("expectedPlanVersion", "snapshot_mismatch"),
        ("editionId", "snapshot_mismatch"),
        ("bankVersion", "snapshot_mismatch"),
    ]


def test_a_mismatch_is_reported_before_the_current_state(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    world.set_edition_status("revoked")
    error = error_of(lambda: world.revalidate(snapshot, bankVersion=9))
    assert error.status == 422


def test_an_unknown_or_foreign_snapshot_is_not_found_on_revalidation(
    world: OfflineWorld, snapshot: dict[str, Any]
) -> None:
    assert error_of(lambda: world.revalidate(snapshot, snapshotId=str(uuid.uuid4()))).status == 404
    raw = world.offline.parse_revalidate(
        {
            "snapshotId": snapshot["snapshotId"],
            "expectedPlanVersion": 2,
            "editionId": str(QURAN_EDITION),
            "bankVersion": 1,
        }
    )
    assert error_of(lambda: world.offline.revalidate(world.foreign(), raw)).status == 404


def test_revalidation_writes_nothing(world: OfflineWorld, snapshot: dict[str, Any]) -> None:
    before = (
        world.session_count(),
        world.repo.session_states(world.ctx, UUID(snapshot["snapshotId"])),
    )
    for _ in range(3):
        world.revalidate(snapshot)
    after = (
        world.session_count(),
        world.repo.session_states(world.ctx, UUID(snapshot["snapshotId"])),
    )
    assert before == after


def test_a_second_snapshot_is_revalidated_on_its_own(world: OfflineWorld) -> None:
    first, _ = world.create()
    second, _ = world.create(op=OP2)
    result = world.revalidate(second)
    assert result["allowedSessionRefs"] == [s["sessionId"] for s in second["preparedSessions"]]
    assert set(result["allowedSessionRefs"]).isdisjoint(
        s["sessionId"] for s in first["preparedSessions"]
    )


def test_runnable_sessions_are_listed_in_the_order_of_the_snapshot(world: OfflineWorld) -> None:
    """The database returns the sessions of one transaction in no meaningful order (random ids)."""
    world.offline._new_id = uuid.uuid4  # type: ignore[attr-defined]
    for operation in range(3):
        snapshot, _ = world.create(op=uuid.uuid4())
        listed = [s["sessionId"] for s in snapshot["preparedSessions"]]
        assert world.revalidate(snapshot)["allowedSessionRefs"] == listed, operation
