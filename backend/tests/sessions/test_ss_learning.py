"""The learning repositories: one behaviour, two implementations (memory and PostgREST)."""

from __future__ import annotations

import threading
from datetime import timedelta
from uuid import UUID

import pytest
from pydantic import SecretStr

from app.domain.learning_state import PartEvidence
from app.errors import AppError, ErrorCode
from app.repositories.bank import PostgrestGateway
from app.repositories.learning import (
    ATTEMPT_LIMIT,
    InMemoryLearningStore,
    PostgrestLearningRepository,
)
from tests.sessions.ss_learning_support import (
    LEARNER,
    OTHER_PLAN,
    PART,
    PASSAGE,
    STRANGER,
    Harness,
    attempt,
    mastery,
    new_session,
)
from tests.sessions.ss_postgrest import ANON, FakePostgrest
from tests.sessions.ss_support import (
    NOW,
    OTHER_USER,
    PLAN_ID,
    PLAN_VERSION_ID,
    QURAN_EDITION,
    TODAY,
    USER,
    ctx,
)


@pytest.fixture(params=["memory", "postgrest"])
def harness(request: pytest.FixtureRequest) -> Harness:
    if request.param == "memory":
        store = InMemoryLearningStore()
        return Harness("memory", store, store=store)
    fake = FakePostgrest()
    gateway = PostgrestGateway("https://project.example", SecretStr(ANON), client=fake.client())
    return Harness("postgrest", PostgrestLearningRepository(gateway, in_chunk=2), fake=fake)


# --- sessions ------------------------------------------------------------------------------------


def test_a_daily_session_is_a_get_or_create(harness: Harness) -> None:
    first = harness.repo.open_session(LEARNER, new_session(1))
    again = harness.repo.open_session(LEARNER, new_session(2))  # another candidate, same date
    assert (first.created, again.created) == (True, False)
    assert again.session_id == first.session_id == new_session(1).session_id
    stored = harness.repo.read_session(LEARNER, first.session_id)
    assert stored is not None
    assert (stored.kind, stored.status, stored.plan_id, stored.plan_version_id) == (
        "daily",
        "open",
        PLAN_ID,
        PLAN_VERSION_ID,
    )
    assert (
        stored.plan_version == 2 and stored.edition_id == QURAN_EDITION and stored.bank_version == 1
    )
    assert stored.learning_date == TODAY
    # The database stamps created_at itself (the function takes no timestamp); memory mode keeps
    # the one it was given.
    expected_created = NOW + timedelta(minutes=1) if harness.kind == "memory" else NOW
    assert stored.created_at == expected_created
    assert stored.steps == new_session(1).steps and stored.offline_snapshot_id is None
    assert stored.lesson_refs == (UUID(int=7),) and stored.question_refs == (
        UUID(int=8),
        UUID(int=9),
    )
    assert stored.user_id == USER and stored.elapsed_ms == 0 and stored.self_rating is None


def test_another_date_or_another_learner_gets_its_own_daily_session(harness: Harness) -> None:
    harness.repo.open_session(LEARNER, new_session(1))
    tomorrow = harness.repo.open_session(LEARNER, new_session(2, day=TODAY + timedelta(days=1)))
    assert tomorrow.created is True
    if harness.store is not None:  # the fake PostgREST serves one learner
        theirs = harness.repo.open_session(STRANGER, new_session(3))
        assert theirs.created is True and theirs.session_id != new_session(1).session_id


def test_games_and_placements_always_create(harness: Harness) -> None:
    ids = {
        harness.repo.open_session(LEARNER, new_session(n, kind="game")).session_id for n in (1, 2)
    }
    assert len(ids) == 2
    placement = harness.repo.open_session(LEARNER, new_session(3, kind="placement", plan=False))
    assert placement.created is True
    stored = harness.repo.read_session(LEARNER, placement.session_id)
    assert stored is not None and stored.plan_id is None and stored.plan_version is None
    assert stored.self_rating == "some" and stored.kind == "placement"
    assert harness.repo.find_open_daily(LEARNER, TODAY) is None  # not daily sessions


def test_an_unknown_or_foreign_session_reads_as_none(harness: Harness) -> None:
    assert harness.repo.read_session(LEARNER, UUID(int=123)) is None
    opened = harness.repo.open_session(LEARNER, new_session(1))
    if harness.store is not None:
        assert harness.repo.read_session(STRANGER, opened.session_id) is None


def test_find_open_daily_sees_only_open_server_sessions_of_the_date(harness: Harness) -> None:
    assert harness.repo.find_open_daily(LEARNER, TODAY) is None
    opened = harness.repo.open_session(LEARNER, new_session(1))
    found = harness.repo.find_open_daily(LEARNER, TODAY)
    assert found is not None and found.id == opened.session_id
    assert harness.repo.find_open_daily(LEARNER, TODAY + timedelta(days=1)) is None
    harness.repo.mark_completed(LEARNER, opened.session_id)
    assert harness.repo.find_open_daily(LEARNER, TODAY) is None


def test_mark_completed_is_idempotent_and_touches_only_the_status(harness: Harness) -> None:
    opened = harness.repo.open_session(LEARNER, new_session(1))
    before = harness.repo.read_session(LEARNER, opened.session_id)
    harness.repo.mark_completed(LEARNER, opened.session_id)
    harness.repo.mark_completed(LEARNER, opened.session_id)
    harness.repo.mark_completed(LEARNER, UUID(int=404))  # unknown: nothing happens
    after = harness.repo.read_session(LEARNER, opened.session_id)
    assert before is not None and after is not None and after.status == "completed"
    assert after.steps == before.steps and after.created_at == before.created_at
    again = harness.repo.open_session(LEARNER, new_session(2))  # a completed daily is replaced
    assert again.created is True and again.session_id != opened.session_id


# --- reads of learner state ----------------------------------------------------------------------


def test_mastery_for_a_plan_returns_that_plans_rows_by_passage(harness: Harness) -> None:
    other_passage = UUID("66666666-6666-4666-8666-000000000002")
    harness.seed_mastery(USER, mastery())
    harness.seed_mastery(
        USER,
        mastery(
            other_passage,
            status="learning",
            consecutive_correct=1,
            initial_success_at=None,
            initial_learning_date=None,
            review_stage=0,
            next_review_due=None,
            error_part_ids=(),
        ),
    )
    harness.seed_mastery(USER, mastery(PASSAGE, plan=OTHER_PLAN))
    rows = harness.repo.mastery_for_plan(LEARNER, PLAN_ID)
    assert set(rows) == {PASSAGE, other_passage}
    assert rows[PASSAGE] == mastery()
    assert rows[other_passage].status == "learning" and rows[other_passage].error_part_ids == ()
    assert harness.repo.mastery_for_plan(LEARNER, UUID(int=1)) == {}
    if harness.store is not None:
        harness.seed_mastery(OTHER_USER, mastery(UUID(int=55)))
        assert UUID(int=55) not in harness.repo.mastery_for_plan(LEARNER, PLAN_ID)


def test_covered_parts_are_the_plans_evidence(harness: Harness) -> None:
    other_part = UUID("77777777-7777-4777-8777-000000000002")
    harness.seed_evidence(USER, PartEvidence(PLAN_ID, PASSAGE, PART, UUID(int=1), TODAY))
    harness.seed_evidence(USER, PartEvidence(PLAN_ID, PASSAGE, other_part, UUID(int=2), TODAY))
    harness.seed_evidence(USER, PartEvidence(OTHER_PLAN, PASSAGE, UUID(int=9), UUID(int=3), TODAY))
    assert harness.repo.covered_parts(LEARNER, PLAN_ID) == frozenset({PART, other_part})
    assert harness.repo.covered_parts(LEARNER, UUID(int=1)) == frozenset()


def test_attempts_come_newest_first_and_only_for_the_asked_passages(harness: Harness) -> None:
    other_passage = UUID("66666666-6666-4666-8666-000000000002")
    for n in (1, 2, 3):
        harness.seed_attempt(attempt(n))
    harness.seed_attempt(attempt(4, passage=other_passage))
    harness.seed_attempt(attempt(5, passage=UUID(int=99)))
    found = harness.repo.attempts_for_passages(LEARNER, [PASSAGE, other_passage])
    assert [a.id for a in found] == [attempt(n).id for n in (4, 3, 2, 1)]
    assert found[0] == attempt(4, passage=other_passage)
    wrong = found[2]  # attempt 2: an even attempt is a wrong choice that points at an edition word
    assert wrong.wrong_token_ref == "3:1" and wrong.error_kind == "wrong_choice"
    assert found[3].correct and found[3].error_kind is None
    assert harness.repo.attempts_for_passages(LEARNER, []) == []
    assert harness.repo.attempts_for_passages(LEARNER, [UUID(int=1234)]) == []


def test_attempt_reads_are_limited_to_the_newest(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.repositories.learning.ATTEMPT_LIMIT", 4)
    for n in range(1, 8):
        harness.seed_attempt(attempt(n))
    found = harness.repo.attempts_for_passages(LEARNER, [PASSAGE])
    assert [a.id for a in found] == [attempt(n).id for n in (7, 6, 5, 4)]
    assert ATTEMPT_LIMIT == 500


def test_the_last_active_date_ignores_idle_and_future_days(harness: Harness) -> None:
    assert harness.repo.last_active_date(LEARNER, TODAY) is None
    harness.seed_daily(USER, TODAY - timedelta(days=9), 300_000)
    harness.seed_daily(USER, TODAY - timedelta(days=4), 480_000)
    harness.seed_daily(USER, TODAY - timedelta(days=2), 0)  # opened the app, learned nothing
    harness.seed_daily(USER, TODAY + timedelta(days=3), 600_000)  # not yet
    assert harness.repo.last_active_date(LEARNER, TODAY) == TODAY - timedelta(days=4)
    assert harness.repo.last_active_date(LEARNER, TODAY - timedelta(days=5)) == TODAY - timedelta(
        days=9
    )
    harness.seed_daily(USER, TODAY, 1_000)
    assert harness.repo.last_active_date(LEARNER, TODAY) == TODAY


# --- memory store only ---------------------------------------------------------------------------


def test_the_store_refuses_a_mastery_row_the_database_would_refuse() -> None:
    store = InMemoryLearningStore()
    with pytest.raises(ValueError):
        store.put_mastery(USER, mastery(status="confirmed"))  # confirmed without confirmed_at


def test_the_store_hands_out_copies_of_the_steps() -> None:
    store = InMemoryLearningStore()
    opened = store.open_session(LEARNER, new_session(1))
    store.read_session(LEARNER, opened.session_id).steps.clear()  # type: ignore[union-attr]
    store.find_open_daily(LEARNER, TODAY).steps.append({"x": 1})  # type: ignore[union-attr]
    again = store.read_session(LEARNER, opened.session_id)
    assert again is not None and again.steps == new_session(1).steps


def test_a_repeated_session_id_is_a_caller_bug_not_a_silent_overwrite() -> None:
    store = InMemoryLearningStore()
    store.open_session(LEARNER, new_session(1, kind="game"))
    with pytest.raises(AppError) as raised:
        store.open_session(LEARNER, new_session(1, kind="game"))
    assert raised.value.code is ErrorCode.unavailable


def test_concurrent_daily_requests_create_exactly_one_session() -> None:
    store = InMemoryLearningStore()
    results: list[bool] = []
    barrier = threading.Barrier(16)

    def attempt_open(n: int) -> None:
        barrier.wait()
        results.append(store.open_session(LEARNER, new_session(n)).created)

    threads = [threading.Thread(target=attempt_open, args=(n,)) for n in range(1, 17)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count(True) == 1 and results.count(False) == 15
    assert len(store.sessions) == 1


# --- PostgREST only ------------------------------------------------------------------------------

APP_OPEN_SESSION_PARAMETERS = {
    "p_kind",
    "p_plan_id",
    "p_plan_version_id",
    "p_phase_id",
    "p_edition_id",
    "p_learning_date",
    "p_lesson_refs",
    "p_question_refs",
    "p_steps",
    "p_bank_version",
    "p_self_rating",
    "p_session_id",
}


def pg() -> tuple[PostgrestLearningRepository, FakePostgrest]:
    fake = FakePostgrest()
    gateway = PostgrestGateway("https://project.example", SecretStr(ANON), client=fake.client())
    return PostgrestLearningRepository(gateway), fake


def test_the_rpc_payload_matches_the_migrations_function_signature() -> None:
    repo, fake = pg()
    new = new_session(1)
    repo.open_session(LEARNER, new)
    (body,) = fake.rpc_bodies
    assert set(body) == APP_OPEN_SESSION_PARAMETERS  # exactly the twelve named arguments
    assert body["p_kind"] == "daily" and body["p_phase_id"] is None
    assert body["p_plan_id"] == str(PLAN_ID) and body["p_plan_version_id"] == str(PLAN_VERSION_ID)
    assert body["p_edition_id"] == str(QURAN_EDITION) and body["p_learning_date"] == "2026-10-05"
    assert body["p_lesson_refs"] == [str(UUID(int=7))]
    assert body["p_question_refs"] == [str(UUID(int=8)), str(UUID(int=9))]
    assert body["p_steps"] == new.steps and body["p_bank_version"] == 1
    assert body["p_self_rating"] is None and body["p_session_id"] == str(new.session_id)
    repo.open_session(LEARNER, new_session(2, kind="placement", plan=False))
    placement = fake.rpc_bodies[-1]
    assert placement["p_plan_id"] is None and placement["p_plan_version_id"] is None
    assert placement["p_self_rating"] == "some"


def test_the_rpc_answer_may_be_a_list_or_one_object() -> None:
    import httpx

    repo, fake = pg()
    fake.fail(
        "rpc/app_open_session",
        lambda request: httpx.Response(
            200, json={"session_id": str(UUID(int=5)), "created": False}
        ),
    )
    assert repo.open_session(LEARNER, new_session(1)).session_id == UUID(int=5)
    fake.fail("rpc/app_open_session", lambda request: httpx.Response(200, json=[]))
    with pytest.raises(AppError) as raised:
        repo.open_session(LEARNER, new_session(2))
    assert raised.value.code is ErrorCode.internal  # an answer without a row is not understood


def test_a_plan_that_moved_is_a_version_conflict_and_nothing_is_stored() -> None:
    repo, fake = pg()
    fake.plan_version_in_force = str(UUID(int=77))
    with pytest.raises(AppError) as raised:
        repo.open_session(LEARNER, new_session(1))
    assert raised.value.code is ErrorCode.version_conflict
    assert raised.value.details == {"reason": "plan_version"}
    assert fake.tables["learning_sessions"] == []


def test_an_expired_token_and_a_missing_token_are_unauthenticated() -> None:
    repo, fake = pg()
    for context in (ctx(token="expired-token"), ctx(token=None)):
        with pytest.raises(AppError) as raised:
            repo.open_session(context, new_session(1))
        assert raised.value.code is ErrorCode.unauthenticated
    assert len(fake.requests) == 1  # only the first reached the server


def test_the_session_read_resolves_the_plan_version_number_and_filters_by_owner() -> None:
    repo, fake = pg()
    repo.open_session(LEARNER, new_session(1))
    repo.read_session(LEARNER, new_session(1).session_id)
    sessions = fake.calls_to("/learning_sessions")[-1].url.params
    assert (
        sessions["user_id"] == f"eq.{USER}" and sessions["id"] == f"eq.{new_session(1).session_id}"
    )
    assert fake.calls_to("/plan_versions")  # the number comes from the plan version row
    repo.open_session(LEARNER, new_session(2, kind="game", plan=False))
    before = len(fake.calls_to("/plan_versions"))
    repo.read_session(LEARNER, new_session(2, kind="game", plan=False).session_id)
    assert len(fake.calls_to("/plan_versions")) == before  # nothing to resolve without a plan


def test_find_open_daily_asks_for_open_server_side_sessions_of_the_date() -> None:
    repo, fake = pg()
    repo.find_open_daily(LEARNER, TODAY)
    params = fake.calls_to("/learning_sessions")[-1].url.params
    assert params["kind"] == "eq.daily" and params["learning_date"] == "eq.2026-10-05"
    assert params["status"] == "in.(prepared,open)" and params["offline_snapshot_id"] == "is.null"
    assert params["user_id"] == f"eq.{USER}" and params["limit"] == "1"


def test_mark_completed_writes_only_the_status_under_the_owners_filters() -> None:
    repo, fake = pg()
    opened = repo.open_session(LEARNER, new_session(1))
    repo.mark_completed(LEARNER, opened.session_id)
    assert fake.patch_bodies == [{"status": "completed"}]
    params = fake.requests[-1].url.params
    assert params["user_id"] == f"eq.{USER}" and params["status"] == "in.(prepared,open)"
    assert fake.tables["learning_sessions"][0]["status"] == "completed"


def test_attempt_reads_are_chunked_and_merged_newest_first() -> None:
    repo, fake = pg()
    repo_small = PostgrestLearningRepository(repo._rest, in_chunk=2)
    passages = [UUID(int=1000 + n) for n in range(5)]
    harness = Harness("postgrest", repo_small, fake=fake)
    for n, passage in enumerate(passages, start=1):
        harness.seed_attempt(attempt(n, passage=passage))
    found = repo_small.attempts_for_passages(LEARNER, passages)
    assert [a.id for a in found] == [attempt(n).id for n in (5, 4, 3, 2, 1)]
    assert len(fake.calls_to("/attempts")) == 3  # five passages, two per filter


def test_malformed_rows_are_an_internal_error() -> None:
    repo, fake = pg()
    fake.tables["learning_sessions"].append(
        {"id": str(UUID(int=1)), "user_id": str(USER), "kind": "daily"}
    )
    with pytest.raises(AppError) as raised:
        repo.read_session(LEARNER, UUID(int=1))
    assert raised.value.code is ErrorCode.internal
    fake.tables["target_mastery"].append(
        {"user_id": str(USER), "plan_id": str(PLAN_ID), "passage_id": "x"}
    )
    with pytest.raises(AppError) as mastery_error:
        repo.mastery_for_plan(LEARNER, PLAN_ID)
    assert mastery_error.value.code is ErrorCode.internal


def test_a_session_row_without_its_timestamp_is_an_internal_error() -> None:
    repo, fake = pg()
    complete = {
        "id": str(UUID(int=2)),
        "user_id": str(USER),
        "plan_id": None,
        "plan_version_id": None,
        "edition_id": str(QURAN_EDITION),
        "kind": "game",
        "learning_date": "2026-10-05",
        "lesson_refs": [],
        "question_refs": [],
        "steps": [],
        "bank_version": 1,
        "status": "prepared",
        "created_at": None,  # a not null column that came back empty
        "self_rating": None,
        "elapsed_ms": 0,
        "offline_snapshot_id": None,
    }
    fake.tables["learning_sessions"].append(complete)
    with pytest.raises(AppError) as raised:
        repo.read_session(LEARNER, UUID(int=2))
    assert raised.value.code is ErrorCode.internal
