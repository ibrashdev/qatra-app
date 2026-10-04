"""The memory-mode stores: the semantics of the database functions (one active plan, versions,
pause and resume), ownership, thread safety, and the seedable placement and profile readers."""

from __future__ import annotations

import threading
from datetime import date, timedelta
from uuid import UUID

import pytest

from app.domain import plan_policy as pp
from app.domain.planning_port import (
    PlacementNotFound,
    PlanNotActive,
    PlanNotFound,
    PlanVersionConflict,
)
from app.repositories.catalog import edition_from_bundle
from app.repositories.plans import (
    DEFAULT_TIME_ZONE,
    LearningZone,
    MemoryPlacementReader,
    MemoryPlanRepository,
    MemoryProfileReader,
)
from tests.plans.plans_support import (
    HADITH_ID,
    OTHER_USER_ID,
    QURAN_ID,
    TODAY,
    UNKNOWN_ID,
    USER_ID,
    Clock,
    pid,
    quran_bundle,
    session_context,
)

DATA, PASSAGES = edition_from_bundle(quran_bundle())


def make_commit(scope: tuple[int, ...] = (1, 2), minutes: int = 5, reason: str = "plan_created"):
    estimate = pp.compute_estimate(
        DATA, ordinals=scope, paths=["quran"], session_minutes=minutes, today=TODAY
    )
    values = pp.PlanValues(DATA.edition_id, scope, ("quran",), "book", minutes, None, estimate)
    return pp.build_plan_commit(
        values,
        reason_code=reason,
        edition=DATA,
        passages=PASSAGES,
        known=pp.KnownPassages(),
        planner_source="rules",
        planner_model=None,
        today=TODAY,
        days=estimate.days,
        effective_date=TODAY,
    )


@pytest.fixture
def repo() -> MemoryPlanRepository:
    return MemoryPlanRepository(titles=lambda edition_id: ("عنوان", "Title"), clock=Clock())


CTX = session_context()
OTHER = session_context(OTHER_USER_ID)


def test_create_stores_version_one_and_the_titles(repo: MemoryPlanRepository) -> None:
    plan_id = repo.create_plan(CTX, make_commit())
    stored = repo.read_plan(CTX, plan_id)
    assert stored is not None
    assert (stored.title_ar, stored.title_en) == ("عنوان", "Title")
    assert (stored.status, stored.current_version) == ("active", 1)
    assert stored.target_scope == (1, 2) and stored.paths == ("quran",)
    assert stored.policy["planner"] == {"source": "rules"}
    assert stored.created_at.tzinfo is not None


def test_only_the_owner_can_read_a_plan(repo: MemoryPlanRepository) -> None:
    plan_id = repo.create_plan(CTX, make_commit())
    assert repo.read_plan(OTHER, plan_id) is None
    assert repo.read_plan(CTX, UNKNOWN_ID) is None


def test_a_new_plan_pauses_the_active_one_of_the_same_account_only(repo) -> None:
    mine = repo.create_plan(CTX, make_commit())
    theirs = repo.create_plan(OTHER, make_commit())
    newest = repo.create_plan(CTX, make_commit((3,)))
    assert repo.read_plan(CTX, mine).status == "paused"
    assert repo.read_plan(CTX, newest).status == "active"
    assert repo.read_plan(OTHER, theirs).status == "active"


def test_revise_appends_versions_and_keeps_the_status(repo: MemoryPlanRepository) -> None:
    first = repo.create_plan(CTX, make_commit())
    repo.create_plan(CTX, make_commit((3,)))  # pauses the first
    assert repo.revise_plan(CTX, first, 1, make_commit(minutes=10, reason="plan_revised")) == 2
    stored = repo.read_plan(CTX, first)
    assert (stored.status, stored.current_version, stored.session_minutes) == ("paused", 2, 10)
    versions = repo.versions_of(first)
    assert [v["versionNo"] for v in versions] == [1, 2]
    assert versions[0]["policy"]["sessionMinutes"] == 5  # history is not rewritten


def test_revise_checks_ownership_and_version(repo: MemoryPlanRepository) -> None:
    plan_id = repo.create_plan(CTX, make_commit())
    with pytest.raises(PlanNotFound):
        repo.revise_plan(OTHER, plan_id, 1, make_commit())
    with pytest.raises(PlanNotFound):
        repo.revise_plan(CTX, UNKNOWN_ID, 1, make_commit())
    with pytest.raises(PlanVersionConflict) as exc:
        repo.revise_plan(CTX, plan_id, 4, make_commit())
    assert exc.value.current_version == 1


def test_resume_semantics(repo: MemoryPlanRepository) -> None:
    first = repo.create_plan(CTX, make_commit())
    second = repo.create_plan(CTX, make_commit((3,)))
    assert repo.resume_plan(CTX, second) == 1  # already active: unchanged
    assert repo.read_plan(CTX, first).status == "paused"
    assert repo.resume_plan(CTX, first) == 1
    assert repo.read_plan(CTX, first).status == "active"
    assert repo.read_plan(CTX, second).status == "paused"
    repo.complete_plan(second)
    with pytest.raises(PlanNotActive):
        repo.resume_plan(CTX, second)
    with pytest.raises(PlanNotFound):
        repo.resume_plan(OTHER, first)
    with pytest.raises(PlanNotFound):
        repo.resume_plan(CTX, UNKNOWN_ID)


def test_a_completed_plan_is_not_paused_by_a_newer_one(repo: MemoryPlanRepository) -> None:
    first = repo.create_plan(CTX, make_commit())
    repo.complete_plan(first)
    repo.create_plan(CTX, make_commit((3,)))
    assert repo.read_plan(CTX, first).status == "completed"


def test_concurrent_creates_leave_exactly_one_active_plan(repo: MemoryPlanRepository) -> None:
    commit = make_commit()
    barrier = threading.Barrier(12)

    def work() -> None:
        barrier.wait()
        for _ in range(5):
            repo.create_plan(CTX, commit)

    threads = [threading.Thread(target=work) for _ in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    plans = repo.plans_of(USER_ID)
    assert len(plans) == 60
    assert [p.status for p in plans].count("active") == 1


def test_concurrent_revisions_with_the_same_version_let_exactly_one_win(repo) -> None:
    plan_id = repo.create_plan(CTX, make_commit())
    results: list[object] = []
    barrier = threading.Barrier(8)

    def work() -> None:
        barrier.wait()
        try:
            results.append(repo.revise_plan(CTX, plan_id, 1, make_commit(minutes=10)))
        except PlanVersionConflict as exc:
            results.append(exc)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count(2) == 1
    assert sum(isinstance(item, PlanVersionConflict) for item in results) == 7
    assert repo.read_plan(CTX, plan_id).current_version == 2


def test_placement_reader_knows_only_the_owners_session_of_the_same_edition() -> None:
    reader = MemoryPlacementReader()
    session = UUID(int=42)
    reader.add_session(USER_ID, session, QURAN_ID, {pid(1), pid(2)})
    assert reader.known_passage_ids(CTX, session, QURAN_ID) == {pid(1), pid(2)}
    for ctx, placement, edition in (
        (OTHER, session, QURAN_ID),
        (CTX, UNKNOWN_ID, QURAN_ID),
        (CTX, session, HADITH_ID),
    ):
        with pytest.raises(PlacementNotFound):
            reader.known_passage_ids(ctx, placement, edition)


def test_profile_reader_defaults_to_the_project_zone_and_can_be_seeded() -> None:
    profiles = MemoryProfileReader()
    assert profiles.learning_zone(CTX) == LearningZone(DEFAULT_TIME_ZONE)
    assert DEFAULT_TIME_ZONE == "Asia/Dubai"
    profiles.set_zone(USER_ID, LearningZone("UTC", "Asia/Dubai", date(2026, 11, 1)))
    assert profiles.learning_zone(CTX).pending_time_zone == "Asia/Dubai"
    assert profiles.learning_zone(OTHER) == LearningZone(DEFAULT_TIME_ZONE)


def test_creation_dates_are_utc_and_follow_the_clock() -> None:
    clock = Clock()
    repo = MemoryPlanRepository(clock=clock)
    first = repo.create_plan(CTX, make_commit())
    clock.now = clock.now + timedelta(hours=5)
    second = repo.create_plan(CTX, make_commit((3,)))
    created = [repo.read_plan(CTX, plan_id).created_at for plan_id in (first, second)]
    assert created[1] - created[0] == timedelta(hours=5)
