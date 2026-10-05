"""E23 through the service, in memory and PostgREST mode: the snapshot, idempotency, the checks in
their order and the error rules of API-spec E23 (offline-decisions G-01, G-02, G-07, G-12)."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any
from uuid import UUID

import pytest

from app.services.offline import OfflineService
from tests.offline.off_support import (
    MODES,
    OP,
    OP2,
    OfflineWorld,
    field_rules,
    questions_of,
    reason_of,
)
from tests.sessions.ss_support import (
    PLAN_B_ID,
    PLAN_ID,
    QURAN_EDITION,
    QURAN_PASSAGES,
    TODAY,
    USER,
    error_of,
    hadith_plan,
    quran_plan,
)

FORBIDDEN_KEYS = {
    "token",
    "accessToken",
    "access_token",
    "password",
    "recoveryCode",
    "recovery",
    "commentary",
    "translation",
    "tafsir",
    "cookie",
}


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> OfflineWorld:
    return OfflineWorld(request.param)


def walk_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {key for item in value.values() for key in walk_keys(item)}
    if isinstance(value, list):
        return {key for item in value for key in walk_keys(item)}
    return set()


# --- the snapshot --------------------------------------------------------------------------------


def test_a_new_snapshot_has_the_documented_shape(world: OfflineWorld) -> None:
    snapshot, created = world.create()
    assert created is True
    assert set(snapshot) == {
        "snapshotId",
        "schemaVersion",
        "protocolVersion",
        "userId",
        "planId",
        "planVersion",
        "editionId",
        "bankVersion",
        "targetScope",
        "downloadedTargetRefs",
        "learningTimeZone",
        "dailyGoalMs",
        "contentHashes",
        "verifiedAt",
        "contentValidity",
        "normalizationPolicyVersion",
        "scoringPolicyVersion",
        "preparedSessions",
        "lessons",
        "games",
        "references",
    }
    assert snapshot["schemaVersion"] == 1 and snapshot["protocolVersion"] == 1
    assert snapshot["userId"] == str(USER)
    assert snapshot["planId"] == str(PLAN_ID)
    assert snapshot["planVersion"] == 2 and snapshot["bankVersion"] == 1
    assert snapshot["editionId"] == str(QURAN_EDITION)
    assert snapshot["targetScope"] == {"sectionOrdinals": [1, 2, 3]}
    assert snapshot["learningTimeZone"] == "Asia/Dubai"
    assert snapshot["dailyGoalMs"] == 600_000
    assert snapshot["normalizationPolicyVersion"] == "arabic-norm-v1"
    assert snapshot["scoringPolicyVersion"] == "v1"
    assert snapshot["verifiedAt"] == "2026-10-05T07:00:00Z"
    assert snapshot["contentValidity"] == {"checkedAt": "2026-10-05T07:00:00Z", "result": "valid"}


def test_the_server_chooses_the_targets_when_the_client_sends_none(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    # every passage of the plan, in plan order (the plan has four, below the cap of 60)
    assert snapshot["downloadedTargetRefs"] == [str(p) for p in QURAN_PASSAGES]
    assert [lesson["passageId"] for lesson in snapshot["lessons"]] == snapshot[
        "downloadedTargetRefs"
    ]


def test_a_client_that_sends_refs_gets_exactly_those(world: OfflineWorld) -> None:
    refs = [QURAN_PASSAGES[2], QURAN_PASSAGES[0]]
    snapshot, _ = world.create(refs=refs)
    assert snapshot["downloadedTargetRefs"] == [str(r) for r in refs]
    assert [lesson["passageId"] for lesson in snapshot["lessons"]] == [str(r) for r in refs]


def test_one_daily_and_up_to_four_game_sessions_are_prepared(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    sessions = snapshot["preparedSessions"]
    kinds = [s["kind"] for s in sessions]
    assert kinds[0] == "daily" and kinds.count("daily") == 1
    assert set(kinds[1:]) == {"game"} and 1 <= kinds.count("game") <= 4
    assert len(sessions) <= 7
    assert len({s["sessionId"] for s in sessions}) == len(sessions)
    for session in sessions:
        assert session["status"] == "prepared"
        assert session["planId"] == str(PLAN_ID) and session["planVersion"] == 2
        assert session["editionId"] == str(QURAN_EDITION) and session["bankVersion"] == 1
        assert session["learningDate"] == TODAY.isoformat()
        assert session["steps"], "a session without steps is not prepared"


def test_the_sessions_are_stored_prepared_and_linked_to_the_snapshot(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    assert world.session_count() == len(snapshot["preparedSessions"])
    for prepared in snapshot["preparedSessions"]:
        stored = world.learning.read_session(world.ctx, UUID(prepared["sessionId"]))
        assert stored is not None
        assert stored.status == "prepared"
        assert str(stored.offline_snapshot_id) == snapshot["snapshotId"]
        assert stored.plan_version == 2 and stored.kind == prepared["kind"]
    # an offline daily session never joins the get-or-create of the online daily session
    assert world.learning.find_open_daily(world.ctx, TODAY) is None


def test_the_payload_snapshot_id_is_the_row_id(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    if world.mode == "memory":
        (stored,) = world.repo.snapshots.values()
        assert str(stored.id) == snapshot["snapshotId"] == stored.payload["snapshotId"]
    else:
        assert world.fake is not None
        (call,) = world.fake.snapshot_bodies
        (row,) = world.fake.tables["offline_snapshots"]
        assert call["p_snapshot_id"] == row["id"] == snapshot["snapshotId"]
        assert row["payload"]["snapshotId"] == snapshot["snapshotId"]


def test_every_question_carries_its_answer_key_and_all_its_options(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    seen = 0
    for session in snapshot["preparedSessions"]:
        for question in questions_of(session):
            seen += 1
            assert "answerKey" in question
            if question["type"] in ("word_choice", "similar_distinction"):
                options = {o["optionId"] for o in question["options"]}
                assert question["answerKey"]["optionId"] in options and len(options) >= 2
            if question["type"] == "word_order":
                assert sorted(question["answerKey"]["order"]) == sorted(
                    t["ref"] for t in question["tokens"]
                )
    assert seen > 10


def test_games_lists_the_questions_of_the_game_sessions_once(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    in_games = {
        q["questionId"]: q for s in world.sessions_of(snapshot, "game") for q in questions_of(s)
    }
    listed = [q["questionId"] for q in snapshot["games"]]
    assert listed and len(listed) == len(set(listed)) == len(in_games)
    assert {q["questionId"]: q for q in snapshot["games"]} == in_games
    assert all(q["role"] == "game" for q in snapshot["games"])


def test_lessons_hold_the_verbatim_text_with_its_canonical_url_and_hashes(
    world: OfflineWorld,
) -> None:
    snapshot, _ = world.create()
    assert snapshot["lessons"]
    for lesson in snapshot["lessons"]:
        assert lesson["source"]["url"], "the canonical URL is shown beside the text (D68)"
        assert lesson["units"]
        for unit in lesson["units"]:
            expected = hashlib.sha256(unit["text"].encode("utf-8")).hexdigest()
            assert snapshot["contentHashes"][f"unit:{unit['unitRef']}"] == expected
    assert all(len(v) == 64 for v in snapshot["contentHashes"].values())
    assert snapshot["references"], "the sources of the lessons are listed"


def test_the_snapshot_never_holds_a_secret_or_a_commentary_field(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    assert not walk_keys(snapshot) & FORBIDDEN_KEYS
    text = json.dumps(snapshot)
    assert "learner-access-token" not in text
    if world.fake is not None:
        sent = json.dumps(world.fake.snapshot_bodies)
        assert "learner-access-token" not in sent


def test_sessions_and_games_draw_only_from_the_downloaded_passages(world: OfflineWorld) -> None:
    only = QURAN_PASSAGES[1]
    snapshot, _ = world.create(refs=[only])
    assert [lesson["passageId"] for lesson in snapshot["lessons"]] == [str(only)]
    assert snapshot["preparedSessions"]
    for session in snapshot["preparedSessions"]:
        for step in session["steps"]:
            passage = step["passage"]["passageId"] if step["type"] == "learn" else None
            question = step["question"]["passageId"] if step["type"] == "question" else None
            assert (passage or question) == str(only)
    assert all(q["passageId"] == str(only) for q in snapshot["games"])


def test_the_hadith_plan_is_prepared_too() -> None:
    world = OfflineWorld("memory")
    snapshot, _ = world.create(plan_id=PLAN_B_ID)
    assert snapshot["planId"] == str(PLAN_B_ID)
    assert snapshot["dailyGoalMs"] == 900_000 and len(snapshot["lessons"]) == 11
    assert not walk_keys(snapshot) & FORBIDDEN_KEYS
    assert snapshot["preparedSessions"][0]["kind"] == "daily"


def test_the_goal_in_force_is_the_stored_one(world: OfflineWorld) -> None:
    world.seed_daily(TODAY, 1000, goal_ms=300_000)
    snapshot, _ = world.create()
    assert snapshot["dailyGoalMs"] == 300_000


# --- idempotency ---------------------------------------------------------------------------------


def test_the_same_operation_returns_the_same_snapshot_and_creates_no_session(
    world: OfflineWorld,
) -> None:
    first, created = world.create()
    count = world.session_count()
    again, created_again = world.create()
    assert created is True and created_again is False
    assert again == first
    assert world.session_count() == count
    if world.fake is not None:
        assert len(world.fake.snapshot_bodies) == 1, "a replay never reaches the function"


def test_a_replay_with_the_same_explicit_refs_is_the_same_snapshot(world: OfflineWorld) -> None:
    refs = [QURAN_PASSAGES[0], QURAN_PASSAGES[1]]
    first, _ = world.create(refs=refs)
    again, created = world.create(refs=refs)
    assert created is False and again == first


def test_the_same_refs_in_another_order_are_another_input(world: OfflineWorld) -> None:
    world.create(refs=[QURAN_PASSAGES[0], QURAN_PASSAGES[1]])
    error = error_of(lambda: world.create(refs=[QURAN_PASSAGES[1], QURAN_PASSAGES[0]]))
    assert error.status == 409 and reason_of(error) == "idempotency_input"


def test_a_replay_that_omits_the_refs_returns_the_snapshot(world: OfflineWorld) -> None:
    first, _ = world.create(refs=[QURAN_PASSAGES[0]])
    again, created = world.create()
    assert created is False and again == first


def test_a_replay_after_the_plan_moved_on_still_returns_the_snapshot(world: OfflineWorld) -> None:
    first, _ = world.create()
    world.set_plan_version(3)
    again, created = world.create(version=2)
    assert created is False and again == first


def test_another_plan_version_with_the_same_operation_is_an_idempotency_conflict(
    world: OfflineWorld,
) -> None:
    world.create()
    world.set_plan_version(3)
    error = error_of(lambda: world.create(version=3))
    assert error.status == 409 and reason_of(error) == "idempotency_input"


def test_another_plan_with_the_same_operation_is_an_idempotency_conflict(
    world: OfflineWorld,
) -> None:
    world.create()
    error = error_of(lambda: world.create(plan_id=PLAN_B_ID))
    assert error.status == 409 and reason_of(error) == "idempotency_input"


def test_a_new_operation_makes_a_new_snapshot(world: OfflineWorld) -> None:
    first, _ = world.create()
    second, created = world.create(op=OP2)
    assert created is True and second["snapshotId"] != first["snapshotId"]
    assert {s["sessionId"] for s in second["preparedSessions"]}.isdisjoint(
        s["sessionId"] for s in first["preparedSessions"]
    )


def test_a_replay_of_a_revoked_edition_never_delivers_the_text(world: OfflineWorld) -> None:
    world.create()
    world.set_edition_status("revoked")
    error = error_of(lambda: world.create())
    assert error.status == 422 and field_rules(error) == [("planId", "edition_not_available")]


@pytest.mark.parametrize(("status", "hidden"), [("published", True), ("superseded", False)])
def test_a_replay_is_not_refused_by_hiding_or_superseding_the_edition(
    world: OfflineWorld, status: str, hidden: bool
) -> None:
    """Hiding stops new selection only (D44); a replay creates nothing new."""
    first, _ = world.create()
    world.set_edition_status(status, hidden=hidden)
    again, created = world.create()
    assert created is False and again == first
    error = error_of(lambda: world.create(op=OP2))  # a new download still needs a selectable one
    assert field_rules(error) == [("planId", "edition_not_downloadable")]


# --- state, version, ownership ------------------------------------------------------------------


def test_a_stale_plan_version_is_a_conflict_with_the_current_version(world: OfflineWorld) -> None:
    error = error_of(lambda: world.create(version=1))
    assert error.status == 409
    assert reason_of(error) == "plan_version" and error.details["currentVersion"] == 2
    assert world.session_count() == 0


@pytest.mark.parametrize("status", ["paused", "completed"])
def test_only_an_active_plan_can_be_downloaded(world: OfflineWorld, status: str) -> None:
    world.plans.update(PLAN_ID, status=status)
    error = error_of(lambda: world.create())
    assert error.status == 409 and reason_of(error) == "plan_not_active"


def test_the_state_is_checked_before_the_version(world: OfflineWorld) -> None:
    world.plans.update(PLAN_ID, status="paused")
    assert reason_of(error_of(lambda: world.create(version=1))) == "plan_not_active"


def test_an_unknown_or_foreign_plan_is_not_found(world: OfflineWorld) -> None:
    assert error_of(lambda: world.create(plan_id=uuid.uuid4())).status == 404
    world.plans.add(quran_plan(plan_id=UUID(int=4242)), owner=world.foreign().user_id)
    assert error_of(lambda: world.create(plan_id=UUID(int=4242))).status == 404


def test_the_plan_is_checked_before_the_body_values(world: OfflineWorld) -> None:
    error = error_of(lambda: world.create(plan_id=uuid.uuid4(), refs=[uuid.uuid4()]))
    assert error.status == 404


# --- the body ------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["userId", "mode", "snapshotId"])
def test_forbidden_properties_are_refused(world: OfflineWorld, name: str) -> None:
    error = error_of(lambda: world.create(raw=world.body(**{name: "x"})))
    assert error.status == 422 and field_rules(error) == [(name, "forbidden_field")]


@pytest.mark.parametrize("refs", [[], [str(uuid.uuid4())] * 2, ["x"]])
def test_malformed_refs_are_target_refs_invalid(world: OfflineWorld, refs: list[str]) -> None:
    raw = {"clientOperationId": str(OP), "expectedPlanVersion": 2, "downloadTargetRefs": refs}
    error = error_of(lambda: world.create(raw=raw))
    assert error.status == 422
    assert field_rules(error) == [("downloadTargetRefs", "target_refs_invalid")]


def test_a_bad_operation_id_is_client_operation_id_invalid(world: OfflineWorld) -> None:
    error = error_of(lambda: world.create(raw={"clientOperationId": "x", "expectedPlanVersion": 2}))
    assert field_rules(error) == [("clientOperationId", "client_operation_id_invalid")]


def test_an_unknown_reference_is_named_by_its_position(world: OfflineWorld) -> None:
    refs = [QURAN_PASSAGES[0], uuid.uuid4(), uuid.uuid4()]
    error = error_of(lambda: world.create(refs=refs))
    assert error.status == 422
    assert field_rules(error) == [
        ("downloadTargetRefs[1]", "target_refs_invalid"),
        ("downloadTargetRefs[2]", "target_refs_invalid"),
    ]
    assert world.session_count() == 0


def test_a_passage_outside_the_scope_of_the_plan_is_invalid(world: OfflineWorld) -> None:
    world.plans.update(PLAN_ID, section_ordinals=(1,))
    error = error_of(lambda: world.create(refs=[QURAN_PASSAGES[0], QURAN_PASSAGES[1]]))
    assert field_rules(error) == [("downloadTargetRefs[1]", "target_refs_invalid")]
    snapshot, _ = world.create(op=OP2)  # the server chooses inside the narrower scope
    assert snapshot["downloadedTargetRefs"] == [str(QURAN_PASSAGES[0])]


def test_a_scope_without_passages_has_nothing_to_download(world: OfflineWorld) -> None:
    world.plans.update(PLAN_ID, paths=("sanad",))  # the Quran bundle has no sanad passage
    error = error_of(lambda: world.create())
    assert field_rules(error) == [("downloadTargetRefs", "target_refs_invalid")]


# --- the edition ---------------------------------------------------------------------------------


def test_a_revoked_edition_is_not_available(world: OfflineWorld) -> None:
    world.set_edition_status("revoked")
    error = error_of(lambda: world.create())
    assert error.status == 422 and field_rules(error) == [("planId", "edition_not_available")]


def test_a_plan_pinned_to_another_bank_version_is_not_available(world: OfflineWorld) -> None:
    world.plans.update(PLAN_ID, bank_version=2)
    error = error_of(lambda: world.create())
    assert field_rules(error) == [("planId", "edition_not_available")]


@pytest.mark.parametrize(("status", "hidden"), [("published", True), ("superseded", False)])
def test_an_edition_that_is_not_selectable_is_not_downloadable(
    world: OfflineWorld, status: str, hidden: bool
) -> None:
    world.set_edition_status(status, hidden=hidden)
    error = error_of(lambda: world.create())
    assert error.status == 422 and field_rules(error) == [("planId", "edition_not_downloadable")]


def test_a_rejected_source_is_not_downloadable_when_the_deployment_knows_it() -> None:
    world = OfflineWorld("memory")
    service = OfflineService(
        sessions=world.service,
        repository=world.repo,
        new_id=world.new_id,
        rights_rejected=lambda edition: True,
    )
    error = error_of(
        lambda: service.create_snapshot(world.ctx, PLAN_ID, service.parse_create(world.body()))
    )
    assert field_rules(error) == [("planId", "edition_not_downloadable")]


# --- size ----------------------------------------------------------------------------------------


def payload_size(snapshot: dict[str, Any]) -> int:
    return len(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode())


def test_a_payload_over_the_cap_is_rebuilt_over_fewer_passages(world: OfflineWorld) -> None:
    full, _ = world.create()
    capped = OfflineService(
        sessions=world.service,
        repository=world.repo,
        new_id=world.new_id,
        max_payload_bytes=int(payload_size(full) * 0.7),
    )
    request = capped.parse_create(world.body(op=OP2))
    result = capped.create_snapshot(world.ctx, PLAN_ID, request)
    snapshot = json.loads(result.snapshot.model_dump_json(by_alias=True))
    assert 1 <= len(snapshot["downloadedTargetRefs"]) < len(full["downloadedTargetRefs"])
    assert payload_size(snapshot) <= int(payload_size(full) * 0.7)
    assert set(snapshot["downloadedTargetRefs"]) <= set(full["downloadedTargetRefs"])


def test_client_chosen_refs_over_the_cap_are_refused(world: OfflineWorld) -> None:
    capped = OfflineService(
        sessions=world.service, repository=world.repo, new_id=world.new_id, max_payload_bytes=1000
    )
    request = capped.parse_create(world.body(refs=QURAN_PASSAGES))
    error = error_of(lambda: capped.create_snapshot(world.ctx, PLAN_ID, request))
    assert error.status == 422
    assert field_rules(error) == [("downloadTargetRefs", "target_refs_invalid")]
    assert world.session_count() == 0


def test_hadith_plan_stays_a_valid_second_plan_for_the_same_account() -> None:
    world = OfflineWorld("memory")
    world.plans.update(PLAN_B_ID)  # exists; ownership unchanged
    first, _ = world.create(op=OP)
    second, _ = world.create(op=OP2, plan_id=PLAN_B_ID)
    assert first["planId"] != second["planId"]
    assert hadith_plan().plan_id == PLAN_B_ID
