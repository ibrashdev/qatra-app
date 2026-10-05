"""``list_plans`` of the plan repositories and of ``PlanService`` (E18 and E19), and the
``PlanServiceDirectory`` that package B6 builds on them: every plan of the caller, newest first,
for the memory store and for the PostgREST repository (the fake of B4, ``httpx.MockTransport``)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import httpx
import pytest

from app.contracts_plan_chat import Estimate, TargetScope
from app.dependencies import SessionContext
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.plans import MemoryPlanRepository, PlanRepository, PostgrestPlanRepository
from app.services.progress import PlanServiceDirectory
from tests.plans.fake_postgrest import ANON_KEY, FakePostgrest
from tests.plans.plans_support import (
    EXAMPLE_ESTIMATE,
    OTHER_USER_ID,
    PLACEMENT_ID,
    QURAN_ID,
    USER_ID,
    Clock,
    make_env,
    session_context,
)
from tests.plans.test_plans_in_force import D4, DATA, PASSAGES, commit

TOKEN = "learner-token-plan-listing"
OTHER_TOKEN = "other-learner-token-plan-listing"
PROJECT = "https://project.example"
T0 = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)


@dataclass
class Listing:
    mode: str
    repo: PlanRepository
    ctx: SessionContext
    stranger: SessionContext
    clock: Clock
    fake: FakePostgrest | None = None

    def add(self, minutes: int = 5, *, at: datetime, ctx: SessionContext | None = None) -> UUID:
        """Create a plan that the database stamps with ``at``."""
        who = ctx or self.ctx
        if self.fake is None:
            self.clock.now = at
            return self.repo.create_plan(who, commit(minutes=minutes, effective=D4))
        plan_id = self.repo.create_plan(who, commit(minutes=minutes, effective=D4))
        self.fake.plans[str(plan_id)]["created_at"] = at.isoformat()
        return plan_id

    def complete(self, plan_id: UUID) -> None:
        if self.fake is None:
            self.repo.complete_plan(plan_id)  # type: ignore[attr-defined]
        else:
            self.fake.plans[str(plan_id)]["status"] = "completed"


@pytest.fixture(params=["memory", "postgrest"])
def listing(request: pytest.FixtureRequest) -> Listing:
    clock = Clock(T0)
    if request.param == "memory":
        repo = MemoryPlanRepository(titles=lambda edition_id: ("title-ar", "title-en"), clock=clock)
        return Listing("memory", repo, session_context(), session_context(OTHER_USER_ID), clock)
    fake = FakePostgrest([(DATA, PASSAGES)])
    fake.add_user(USER_ID, TOKEN)
    fake.add_user(OTHER_USER_ID, OTHER_TOKEN)
    client = PostgrestClient(PROJECT, ANON_KEY, transport=fake.transport())
    return Listing(
        "postgrest",
        PostgrestPlanRepository(client),
        session_context(token=TOKEN),
        session_context(OTHER_USER_ID, token=OTHER_TOKEN),
        clock,
        fake,
    )


# --- the repositories ----------------------------------------------------------------------------


def test_an_account_without_plans_has_an_empty_list(listing: Listing) -> None:
    assert listing.repo.list_plans(listing.ctx) == []


def test_plans_are_listed_newest_first(listing: Listing) -> None:
    first = listing.add(at=T0)
    second = listing.add(at=T0 + timedelta(hours=1))
    third = listing.add(at=T0 + timedelta(days=2))
    assert [p.plan_id for p in listing.repo.list_plans(listing.ctx)] == [third, second, first]


def test_the_order_is_by_creation_time_not_by_insertion(listing: Listing) -> None:
    b = listing.add(at=T0 + timedelta(hours=2))
    a = listing.add(at=T0)
    c = listing.add(at=T0 + timedelta(days=1))
    assert [p.plan_id for p in listing.repo.list_plans(listing.ctx)] == [c, b, a]


def test_every_status_is_listed(listing: Listing) -> None:
    first = listing.add(at=T0)
    second = listing.add(at=T0 + timedelta(days=1))
    third = listing.add(at=T0 + timedelta(days=2))  # creating a plan pauses the one before
    listing.complete(first)
    found = {p.plan_id: p.status for p in listing.repo.list_plans(listing.ctx)}
    assert found == {first: "completed", second: "paused", third: "active"}


def test_only_the_callers_own_plans_are_listed(listing: Listing) -> None:
    mine = listing.add(at=T0)
    theirs = listing.add(at=T0 + timedelta(days=1), ctx=listing.stranger)
    assert [p.plan_id for p in listing.repo.list_plans(listing.ctx)] == [mine]
    assert [p.plan_id for p in listing.repo.list_plans(listing.stranger)] == [theirs]


def test_a_listed_plan_is_the_plan_that_read_plan_returns(listing: Listing) -> None:
    plan_id = listing.add(minutes=10, at=T0)
    [listed] = listing.repo.list_plans(listing.ctx)
    assert listed == listing.repo.read_plan(listing.ctx, plan_id)
    assert (listed.session_minutes, listed.current_version, listed.status) == (10, 1, "active")


def test_the_listing_follows_the_current_version_of_each_plan(listing: Listing) -> None:
    plan_id = listing.add(minutes=5, at=T0)
    listing.repo.revise_plan(
        listing.ctx, plan_id, 1, commit(minutes=15, effective=D4, reason="plan_revised")
    )
    [listed] = listing.repo.list_plans(listing.ctx)
    assert (listed.current_version, listed.session_minutes) == (2, 15)


# --- what only the PostgREST repository does -----------------------------------------------------


def make_supabase() -> tuple[PostgrestPlanRepository, FakePostgrest]:
    fake = FakePostgrest([(DATA, PASSAGES)])
    fake.add_user(USER_ID, TOKEN)
    client = PostgrestClient(PROJECT, ANON_KEY, transport=fake.transport())
    return PostgrestPlanRepository(client), fake


def test_the_postgrest_listing_reads_as_the_learner_and_writes_nothing() -> None:
    repo, fake = make_supabase()
    ctx = session_context(token=TOKEN)
    repo.create_plan(ctx, commit(minutes=5, effective=D4))
    repo.create_plan(ctx, commit(minutes=10, effective=D4))
    before = len(fake.calls)
    assert len(repo.list_plans(ctx)) == 2
    calls = fake.calls[before:]
    assert [(c.method, c.path) for c in calls] == [
        ("GET", "/master_plans"),
        ("GET", "/plan_versions"),
        ("GET", "/plan_versions"),
    ]
    assert all(c.headers["authorization"] == f"Bearer {TOKEN}" for c in calls)
    assert calls[0].params["order"] == "created_at.desc,id.desc"
    assert calls[0].params["user_id"] == f"eq.{USER_ID}"


def test_the_postgrest_listing_without_a_token_sends_nothing() -> None:
    repo, fake = make_supabase()
    with pytest.raises(AppError) as raised:
        repo.list_plans(session_context())
    assert raised.value.code is ErrorCode.unauthenticated and fake.calls == []


def test_a_damaged_plan_row_is_an_integrity_error_not_a_crash() -> None:
    repo, fake = make_supabase()
    ctx = session_context(token=TOKEN)
    plan_id = repo.create_plan(ctx, commit(minutes=5, effective=D4))
    del fake.plans[str(plan_id)]["current_version"]
    with pytest.raises(AppError) as raised:
        repo.list_plans(ctx)
    assert raised.value.code is ErrorCode.internal


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(503, json={"message": "down"}), ErrorCode.unavailable),
        (
            httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"}),
            ErrorCode.unauthenticated,
        ),
    ],
    ids=["down", "expired"],
)
def test_a_failing_postgrest_listing_is_answered_as_the_other_reads_are(
    response: httpx.Response, code: ErrorCode
) -> None:
    repo, fake = make_supabase()
    fake.faults["master_plans"] = [response]
    with pytest.raises(AppError) as raised:
        repo.list_plans(session_context(token=TOKEN))
    assert raised.value.code is code


# --- the service and the directory of B6 ---------------------------------------------------------


@pytest.fixture
def env(tmp_path: Path):
    environment = make_env(tmp_path)
    environment.seed_placement()
    return environment


def estimate_of(minutes: int) -> Estimate:
    base = dict(EXAMPLE_ESTIMATE)
    return Estimate.model_validate(base | {"sessionMinutes": minutes})


def create(env, minutes: int = 5):
    ports = env.services.plans.ports_for(session_context())
    plan = ports.create_plan(
        USER_ID,
        is_demo=False,
        edition_id=QURAN_ID,
        target_scope=TargetScope(section_ordinals=[1, 2]),
        paths=["quran"],
        order="book",
        session_minutes=minutes,
        preferred_date=None,
        placement_session_id=PLACEMENT_ID,
        confirmed_estimate=ports.estimate(
            USER_ID,
            QURAN_ID,
            TargetScope(section_ordinals=[1, 2]),
            ["quran"],
            minutes,
            None,
            PLACEMENT_ID,
            "book",
        ).estimate,
        planner_source="rules",
        planner_model=None,
    )
    return ports, plan


def test_the_service_lists_what_the_repository_lists(env) -> None:
    ports, first = create(env)
    _, second = create(env)
    listed = env.services.plans.list_plans(session_context())
    assert [p.plan_id for p in listed] == [second.plan_id, first.plan_id]
    assert [p.status for p in listed] == ["active", "paused"]  # creating a plan pauses the old one
    assert env.services.plans.list_plans(session_context(OTHER_USER_ID)) == []


def test_the_directory_gives_each_plan_its_dto_and_the_values_in_force(env) -> None:
    _, first = create(env)
    _, second = create(env, minutes=10)
    directory = PlanServiceDirectory(env.services.plans)
    entries = directory.list_plans(session_context())
    assert [e.plan.plan_id for e in entries] == [second.plan_id, first.plan_id]
    active, paused = entries
    assert (active.plan.status, active.plan.session_minutes) == ("active", 10)
    assert (active.in_force.status, active.in_force.session_minutes) == ("active", 10)
    assert (paused.plan.status, paused.in_force.status) == ("paused", "paused")
    assert active.plan.pending_session_minutes is None
    assert active.in_force.section_ordinals == (1, 2) and active.in_force.paths == ("quran",)
    assert active.in_force.edition_id == QURAN_ID and active.in_force.order == "book"


def test_a_session_minutes_change_is_pending_until_the_next_learning_day(env) -> None:
    ports, plan = create(env, minutes=5)
    revised = ports.revise_plan(
        USER_ID,
        plan.plan_id,
        expected_version=plan.current_version,
        target_scope=plan.target_scope,
        paths=list(plan.paths),
        order=plan.order,
        session_minutes=10,
        preferred_date=plan.preferred_date,
        confirmed_estimate=ports.estimate(
            USER_ID,
            QURAN_ID,
            plan.target_scope,
            ["quran"],
            10,
            plan.preferred_date,
            PLACEMENT_ID,
            "book",
        ).estimate,
    )
    assert revised.session_minutes == 10
    directory = PlanServiceDirectory(env.services.plans)
    [today] = directory.list_plans(session_context())
    assert (today.plan.session_minutes, today.plan.pending_session_minutes) == (5, 10)
    assert today.in_force.session_minutes == 5 and today.in_force.current_version == 2
    env.clock.now = env.clock.now + timedelta(days=1)  # the next learning day
    [next_day] = directory.list_plans(session_context())
    assert (next_day.plan.session_minutes, next_day.plan.pending_session_minutes) == (10, None)
    assert next_day.in_force.session_minutes == 10


def test_a_plan_that_vanishes_between_the_two_reads_is_left_out(env) -> None:
    create(env)
    service = env.services.plans
    real = service.plan_in_force
    service.plan_in_force = lambda ctx, plan_id: None  # type: ignore[method-assign]
    try:
        assert PlanServiceDirectory(service).list_plans(session_context()) == []
    finally:
        service.plan_in_force = real  # type: ignore[method-assign]


def test_the_directory_of_another_account_is_its_own(env) -> None:
    create(env)
    directory = PlanServiceDirectory(env.services.plans)
    assert directory.list_plans(session_context(OTHER_USER_ID)) == []
    assert len(directory.list_plans(session_context())) == 1
