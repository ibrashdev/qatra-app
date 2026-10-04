"""The plan on one learning date (D57): the memory store and the PostgREST repository agree.

A revision applies from its ``effective_learning_date``, so the session values of a plan come from
the newest version whose date has arrived, while ``app_open_session`` needs the row id of the
current version. Every scenario below runs against both repositories.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any
from uuid import UUID

import pytest

from app.dependencies import SessionContext
from app.domain import plan_policy as pp
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.catalog import edition_from_bundle
from app.repositories.plans import (
    MemoryPlanRepository,
    PlanInForce,
    PlanRepository,
    PostgrestPlanRepository,
)
from tests.plans.fake_postgrest import ANON_KEY, FakePostgrest
from tests.plans.plans_support import (
    OTHER_USER_ID,
    PLACEMENT_ID,
    QURAN_ID,
    UNKNOWN_ID,
    USER_ID,
    Clock,
    pid,
    quran_bundle,
    session_context,
)

DATA, PASSAGES = edition_from_bundle(quran_bundle())
TOKEN = "learner-token-in-force"
OTHER_TOKEN = "other-learner-token-in-force"
PROJECT = "https://project.example"
D3, D4, D5, D6, D9 = (date(2026, 10, day) for day in (3, 4, 5, 6, 9))


def commit(
    *,
    minutes: int,
    effective: date,
    known: tuple[UUID, ...] = (),
    order: str = "book",
    reason: str = "plan_created",
    scope: tuple[int, ...] = (1, 2),
) -> pp.PlanCommit:
    estimate = pp.compute_estimate(
        DATA, ordinals=scope, paths=["quran"], session_minutes=minutes, today=D4
    )
    values = pp.PlanValues(DATA.edition_id, scope, ("quran",), order, minutes, None, estimate)
    return pp.build_plan_commit(
        values,
        reason_code=reason,
        edition=DATA,
        passages=PASSAGES,
        known=pp.KnownPassages(PLACEMENT_ID if known else None, known),
        planner_source="rules",
        planner_model=None,
        today=D4,
        days=estimate.days,
        effective_date=effective,
    )


@dataclass
class World:
    mode: str
    repo: PlanRepository
    ctx: SessionContext
    stranger: SessionContext
    memory: MemoryPlanRepository | None = None
    fake: FakePostgrest | None = None
    unreadable: set[UUID] = field(default_factory=set)

    def revise(self, plan_id: UUID, version: int, **values: Any) -> None:
        self.repo.revise_plan(self.ctx, plan_id, version, commit(reason="plan_revised", **values))

    def version_id(self, plan_id: UUID, number: int) -> UUID:
        if self.memory is not None:
            return self.memory.versions_of(plan_id)[number - 1]["versionId"]
        assert self.fake is not None
        row = next(
            v
            for v in self.fake.versions
            if v["plan_id"] == str(plan_id) and v["version_no"] == number
        )
        return UUID(row["id"])

    def complete(self, plan_id: UUID) -> None:
        if self.memory is not None:
            self.memory.complete_plan(plan_id)
        else:
            assert self.fake is not None
            self.fake.plans[str(plan_id)]["status"] = "completed"

    def make_edition_unreadable(self) -> None:
        self.unreadable.add(QURAN_ID)
        if self.fake is not None:
            self.fake.unreadable_editions.add(str(QURAN_ID))

    def read(self, plan_id: UUID, on: date) -> PlanInForce:
        state = self.repo.read_in_force(self.ctx, plan_id, on)
        assert state is not None
        return state


def make_world(mode: str) -> World:
    if mode == "memory":
        unreadable: set[UUID] = set()
        memory = MemoryPlanRepository(
            bank_version=lambda edition_id: None if edition_id in unreadable else 1,
            clock=Clock(),
        )
        return World(
            "memory",
            memory,
            session_context(),
            session_context(OTHER_USER_ID),
            memory=memory,
            unreadable=unreadable,
        )
    fake = FakePostgrest([(DATA, PASSAGES)])
    fake.add_user(USER_ID, TOKEN)
    fake.add_user(OTHER_USER_ID, OTHER_TOKEN)
    client = PostgrestClient(PROJECT, ANON_KEY, transport=fake.transport())
    return World(
        "supabase",
        PostgrestPlanRepository(client),
        session_context(token=TOKEN),
        session_context(OTHER_USER_ID, token=OTHER_TOKEN),
        fake=fake,
    )


@pytest.fixture(params=["memory", "supabase"])
def world(request: pytest.FixtureRequest) -> World:
    return make_world(request.param)


@pytest.fixture
def supabase() -> World:
    return make_world("supabase")


def staged(world: World) -> UUID:
    """Version 1 from the 4th, version 2 from the 5th, version 3 from the 6th, each different."""
    plan_id = world.repo.create_plan(world.ctx, commit(minutes=5, effective=D4, known=(pid(1),)))
    world.revise(plan_id, 1, minutes=10, effective=D5, known=(pid(1), pid(2)))
    world.revise(plan_id, 2, minutes=15, effective=D6, order="reverse")
    return plan_id


@pytest.mark.parametrize(
    ("on", "version", "minutes", "order", "known"),
    [
        (D3, 1, 5, "book", {1}),  # before the first date the first version applies
        (D4, 1, 5, "book", {1}),
        (D5, 2, 10, "book", {1, 2}),
        (D6, 3, 15, "reverse", set()),
        (D9, 3, 15, "reverse", set()),
    ],
)
def test_the_values_come_from_the_version_in_force_on_the_date(
    world: World, on: date, version: int, minutes: int, order: str, known: set[int]
) -> None:
    plan_id = staged(world)
    state = world.read(plan_id, on)
    assert state.version_in_force == version
    assert (state.session_minutes, state.order) == (minutes, order)
    assert state.known_passage_ids == {pid(n) for n in known}
    assert state.target_scope == (1, 2) and state.paths == ("quran",)
    assert state.plan_id == plan_id and state.edition_id == QURAN_ID
    assert state.status == "active" and state.bank_version == 1


@pytest.mark.parametrize("on", [D3, D4, D5, D6, D9])
def test_the_current_version_row_is_returned_whichever_version_is_in_force(
    world: World, on: date
) -> None:
    plan_id = staged(world)
    state = world.read(plan_id, on)
    assert state.current_version == 3
    assert state.current_version_id == world.version_id(plan_id, 3)


def test_a_waiting_revision_does_not_change_the_values_but_is_the_current_version(
    world: World,
) -> None:
    plan_id = world.repo.create_plan(world.ctx, commit(minutes=5, effective=D4))
    world.revise(plan_id, 1, minutes=15, effective=D5)
    today = world.read(plan_id, D4)
    assert (today.version_in_force, today.session_minutes) == (1, 5)
    assert (today.current_version, today.current_version_id) == (2, world.version_id(plan_id, 2))
    assert today.current_version_id != world.version_id(plan_id, 1)
    tomorrow = world.read(plan_id, D5)
    assert (tomorrow.version_in_force, tomorrow.session_minutes) == (2, 15)


def test_of_two_versions_with_the_same_date_the_newest_applies(world: World) -> None:
    plan_id = world.repo.create_plan(world.ctx, commit(minutes=5, effective=D4))
    world.revise(plan_id, 1, minutes=10, effective=D6)
    world.revise(plan_id, 2, minutes=15, effective=D6)
    assert world.read(plan_id, D5).session_minutes == 5
    assert world.read(plan_id, D6).session_minutes == 15
    assert world.read(plan_id, D6).version_in_force == 3


def test_a_plan_with_one_version_is_in_force_on_every_date(world: World) -> None:
    plan_id = world.repo.create_plan(world.ctx, commit(minutes=10, effective=D4))
    for on in (D3, D4, D9):
        state = world.read(plan_id, on)
        assert (state.version_in_force, state.current_version) == (1, 1)
        assert state.current_version_id == world.version_id(plan_id, 1)


def test_known_passages_come_from_the_version_in_force_and_a_damaged_set_means_none(
    world: World,
) -> None:
    plan_id = world.repo.create_plan(
        world.ctx, commit(minutes=5, effective=D4, known=(pid(3), pid(4)))
    )
    assert world.read(plan_id, D4).known_passage_ids == {pid(3), pid(4)}
    base = commit(minutes=5, effective=D4)
    damaged = replace(base, policy_json={**base.policy_json, "knownPassages": "not an object"})
    other = world.repo.create_plan(world.ctx, damaged)
    assert world.read(other, D4).known_passage_ids == frozenset()


def test_the_status_is_the_plans_not_the_versions(world: World) -> None:
    first = world.repo.create_plan(world.ctx, commit(minutes=5, effective=D4))
    assert world.read(first, D4).status == "active"
    second = world.repo.create_plan(world.ctx, commit(minutes=5, effective=D4, scope=(3,)))
    assert world.read(first, D4).status == "paused"
    assert world.read(second, D4).status == "active"
    world.complete(second)
    assert world.read(second, D4).status == "completed"


def test_an_unknown_or_foreign_plan_is_none_and_looks_the_same(world: World) -> None:
    plan_id = staged(world)
    assert world.repo.read_in_force(world.stranger, plan_id, D6) is None
    assert world.repo.read_in_force(world.ctx, UNKNOWN_ID, D6) is None


def test_the_bank_version_is_the_editions_and_none_when_it_is_not_readable(world: World) -> None:
    plan_id = staged(world)
    assert world.read(plan_id, D6).bank_version == 1
    world.make_edition_unreadable()
    assert world.read(plan_id, D6).bank_version is None


def without(key: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    return lambda policy: {k: v for k, v in policy.items() if k != key}


DAMAGED: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "no scope": without("scope"),
    "no minutes": without("sessionMinutes"),
    "no order": without("order"),
    "no paths": without("paths"),
    "empty scope": lambda p: {**p, "scope": {"sectionOrdinals": []}},
    "scope of text": lambda p: {**p, "scope": {"sectionOrdinals": ["1"]}},
    "scope that is no list": lambda p: {**p, "scope": {"sectionOrdinals": 1}},
    "scope that is no object": lambda p: {**p, "scope": [1]},
    "negative ordinal": lambda p: {**p, "scope": {"sectionOrdinals": [-1]}},
    "empty paths": lambda p: {**p, "paths": []},
    "unknown path": lambda p: {**p, "paths": ["quran", "tafsir"]},
    "unknown order": lambda p: {**p, "order": "random"},
    "minutes outside the options": lambda p: {**p, "sessionMinutes": 7},
    "minutes as text": lambda p: {**p, "sessionMinutes": "10"},
    "minutes as a flag": lambda p: {**p, "sessionMinutes": True},
}


@pytest.mark.parametrize("name", DAMAGED)
def test_a_damaged_snapshot_is_an_internal_error_and_not_a_guess(
    world: World, name: str, log_lines: list[str]
) -> None:
    base = commit(minutes=5, effective=D4)
    damaged = replace(base, policy_json=DAMAGED[name](dict(base.policy_json)))
    plan_id = world.repo.create_plan(world.ctx, damaged)
    with pytest.raises(AppError) as raised:
        world.repo.read_in_force(world.ctx, plan_id, D4)
    assert raised.value.code is ErrorCode.internal
    assert raised.value.message == ErrorCode.internal.default_message
    assert "plan_row_invalid" in "\n".join(log_lines)


def test_only_the_version_in_force_is_judged(world: World) -> None:
    base = commit(minutes=5, effective=D4)
    plan_id = world.repo.create_plan(
        world.ctx, replace(base, policy_json={**base.policy_json, "order": "random"})
    )
    world.revise(plan_id, 1, minutes=10, effective=D6)
    with pytest.raises(AppError):
        world.repo.read_in_force(world.ctx, plan_id, D5)
    assert world.read(plan_id, D6).session_minutes == 10


def test_the_read_writes_nothing(world: World) -> None:
    plan_id = staged(world)
    before = world.repo.read_plan(world.ctx, plan_id)
    for on in (D3, D5, D9):
        world.read(plan_id, on)
    assert world.repo.read_plan(world.ctx, plan_id) == before
    if world.fake is not None:
        assert {
            c.method for c in world.fake.calls if c.path in ("/master_plans", "/plan_versions")
        } == {"GET"}


def reads(world: World) -> list[Any]:
    assert world.fake is not None
    calls = [c for c in world.fake.calls if c.path in ("/master_plans", "/plan_versions")]
    world.fake.calls.clear()
    return calls


def world_plan(world: World) -> UUID:
    """One plan whose newest version (the 2nd, from the 5th) is the one in force on the 5th."""
    plan_id = world.repo.create_plan(world.ctx, commit(minutes=5, effective=D4))
    world.revise(plan_id, 1, minutes=10, effective=D5)
    return plan_id


def test_the_usual_read_is_two_queries_with_the_learners_token(supabase: World) -> None:
    plan_id = world_plan(supabase)
    reads(supabase)
    supabase.read(plan_id, D5)
    plan, version = reads(supabase)
    assert plan.path == "/master_plans" and version.path == "/plan_versions"
    assert plan.params == {
        "select": "id,edition_id,status,current_version,book_editions(bank_version)",
        "id": f"eq.{plan_id}",
        "user_id": f"eq.{USER_ID}",
    }
    assert version.params == {
        "select": "id,version_no,policy_json",
        "plan_id": f"eq.{plan_id}",
        "user_id": f"eq.{USER_ID}",
        "effective_learning_date": "lte.2026-10-05",
        "order": "version_no.desc",
        "limit": "1",
    }
    for call in (plan, version):
        assert call.method == "GET"
        assert call.headers["authorization"] == f"Bearer {TOKEN}"
        assert call.headers["apikey"] == ANON_KEY


def test_a_waiting_revision_costs_one_more_query_for_its_row(supabase: World) -> None:
    plan_id = world_plan(supabase)
    reads(supabase)
    supabase.read(plan_id, D4)
    plan, version, current = reads(supabase)
    assert version.params["effective_learning_date"] == "lte.2026-10-04"
    assert current.path == "/plan_versions"
    assert current.params["version_no"] == "eq.2" and current.params["limit"] == "1"
    assert current.params["select"] == "id,version_no,policy_json"
    assert plan.params["id"] == f"eq.{plan_id}"


def test_before_the_first_date_the_oldest_version_is_asked_for(supabase: World) -> None:
    plan_id = world_plan(supabase)
    reads(supabase)
    state = supabase.read(plan_id, D3)
    calls = reads(supabase)
    assert state.version_in_force == 1
    assert [c.params.get("order") for c in calls[1:]] == [
        "version_no.desc",
        "version_no.asc",
        None,
    ]
    assert "effective_learning_date" not in calls[2].params


def test_a_plan_without_its_version_rows_is_an_internal_error(supabase: World) -> None:
    plan_id = world_plan(supabase)
    assert supabase.fake is not None
    supabase.fake.versions.clear()
    with pytest.raises(AppError) as raised:
        supabase.read(plan_id, D5)
    assert raised.value.code is ErrorCode.internal


def test_without_a_token_nothing_is_sent(supabase: World) -> None:
    plan_id = world_plan(supabase)
    assert supabase.fake is not None
    supabase.fake.calls.clear()
    with pytest.raises(AppError) as raised:
        supabase.repo.read_in_force(session_context(), plan_id, D5)
    assert raised.value.code is ErrorCode.unauthenticated
    assert supabase.fake.calls == []
