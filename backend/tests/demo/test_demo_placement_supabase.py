"""The placement outcomes read (correct and incorrect passages) in memory and PostgREST mode, the
plan service when a reader has no outcomes read, and E28 end to end over a fake PostgREST (the
supabase-mode path: anon catalog views, the learner's token, ``app_create_plan``). Nothing here
was run against a real Supabase project: the fake replays documented signatures."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import SessionContext
from app.domain import demo_policy as policy
from app.domain.planning_port import PlacementNotFound
from app.errors import AppError, ErrorCode
from app.main import create_app
from app.providers.postgrest import PostgrestClient
from app.repositories.ai_usage import InMemoryUsageLedger
from app.repositories.catalog import MemoryContent
from app.repositories.plans import (
    MemoryPlacementReader,
    PlacementOutcomes,
    PostgrestPlacementReader,
)
from app.routers.demo import install_demo
from app.services.plans import build_planning_services
from tests.demo.demo_support import (
    BUNDLES,
    Clock,
    FakeJsonProvider,
    advice_reply,
    write_fixtures,
)
from tests.plans.fake_postgrest import ANON_KEY, SERVICE_ROLE_KEY, FakePostgrest
from tests.plans.plans_support import browser, login_as, session_context
from tests.support import make_settings

USER = UUID("aaaaaaaa-aaaa-4aaa-8aaa-0000000000d1")
OTHER = UUID("aaaaaaaa-aaaa-4aaa-8aaa-0000000000d2")
SESSION = UUID("33333333-3333-4333-8333-000000000011")
EDITION = UUID("11111111-1111-4111-8111-0000000000e1")
OTHER_EDITION = UUID("11111111-1111-4111-8111-0000000000e2")
P = [UUID(f"55555555-5555-4555-8555-{n:012d}") for n in range(1, 5)]
TOKEN = "learner-access-token-value"
OTHER_TOKEN = "other-learner-access-token"
PROJECT = "https://project.example"


# --- memory reader -------------------------------------------------------------------------------


def test_the_memory_reader_reports_correct_and_incorrect_passages() -> None:
    reader = MemoryPlacementReader()
    reader.add_session(USER, SESSION, EDITION, {P[0]}, {P[1], P[2]})
    ctx = session_context(USER, demo=True)
    outcomes = reader.placement_outcomes(ctx, SESSION, EDITION)
    assert outcomes == PlacementOutcomes(frozenset({P[0]}), frozenset({P[1], P[2]}))
    assert reader.known_passage_ids(ctx, SESSION, EDITION) == frozenset({P[0]})


def test_a_passage_cannot_be_both_correct_and_incorrect() -> None:
    reader = MemoryPlacementReader()
    reader.add_session(USER, SESSION, EDITION, {P[0]}, {P[0], P[1]})
    outcomes = reader.placement_outcomes(session_context(USER), SESSION, EDITION)
    assert outcomes.incorrect_ids == frozenset({P[1]})


def test_a_session_added_the_old_way_has_no_incorrect_passages() -> None:
    reader = MemoryPlacementReader()
    reader.add_session(USER, SESSION, EDITION, {P[0]})
    assert (
        reader.placement_outcomes(session_context(USER), SESSION, EDITION).incorrect_ids
        == frozenset()
    )


@pytest.mark.parametrize(
    "user, session, edition",
    [(OTHER, SESSION, EDITION), (USER, UUID(int=9), EDITION), (USER, SESSION, OTHER_EDITION)],
    ids=["foreign", "unknown", "other-edition"],
)
def test_the_memory_reader_refuses_a_session_that_is_not_the_callers(
    user: UUID, session: UUID, edition: UUID
) -> None:
    reader = MemoryPlacementReader()
    reader.add_session(USER, SESSION, EDITION, {P[0]}, {P[1]})
    with pytest.raises(PlacementNotFound):
        reader.placement_outcomes(session_context(user), session, edition)


# --- PostgREST reader ----------------------------------------------------------------------------


@pytest.fixture
def fake() -> FakePostgrest:
    content = MemoryContent.from_paths(BUNDLES)
    entries = [
        (content.edition(e.edition_id), content.passages(e.edition_id)) for e in content.editions()
    ]
    project = FakePostgrest(entries)
    project.add_user(USER, TOKEN)
    project.add_user(OTHER, OTHER_TOKEN)
    return project


def quran_edition(fake: FakePostgrest) -> tuple[UUID, list[UUID]]:
    edition, passages = next((e, p) for e, p in fake.entries if e.content_format == "quran")
    return edition.edition_id, [row.passage_id for row in passages]


def postgrest_reader(fake: FakePostgrest) -> PostgrestPlacementReader:
    return PostgrestPlacementReader(PostgrestClient(PROJECT, ANON_KEY, transport=fake.transport()))


def test_the_postgrest_reader_splits_correct_from_incorrect(fake: FakePostgrest) -> None:
    edition_id, ids = quran_edition(fake)
    fake.add_placement(
        USER,
        SESSION,
        edition_id,
        [
            (ids[0], True, False),  # known
            (ids[1], False, False),  # wrong
            (ids[2], True, True),  # right but with a hint: not known
            (ids[0], False, False),  # a later wrong attempt does not undo a correct one
        ],
    )
    outcomes = postgrest_reader(fake).placement_outcomes(
        session_context(USER, token=TOKEN), SESSION, edition_id
    )
    assert outcomes.correct_ids == frozenset({ids[0]})
    assert outcomes.incorrect_ids == frozenset({ids[1], ids[2]})
    call = fake.calls_to("/attempts")[-1]
    assert call.params["session_id"] == f"eq.{SESSION}" and call.params["user_id"] == f"eq.{USER}"
    assert "correct" not in call.params and "assisted" not in call.params  # read whole, split here
    assert call.params["select"] == "passage_id,correct,assisted"
    assert call.headers["authorization"] == f"Bearer {TOKEN}"


def test_the_postgrest_reader_agrees_with_the_known_passages_read(fake: FakePostgrest) -> None:
    edition_id, ids = quran_edition(fake)
    fake.add_placement(USER, SESSION, edition_id, [(ids[0], True, False), (ids[1], False, False)])
    reader = postgrest_reader(fake)
    ctx = session_context(USER, token=TOKEN)
    assert reader.placement_outcomes(
        ctx, SESSION, edition_id
    ).correct_ids == reader.known_passage_ids(ctx, SESSION, edition_id)


def test_a_session_without_attempts_has_no_outcomes(fake: FakePostgrest) -> None:
    edition_id, _ = quran_edition(fake)
    fake.add_placement(USER, SESSION, edition_id, [])
    outcomes = postgrest_reader(fake).placement_outcomes(
        session_context(USER, token=TOKEN), SESSION, edition_id
    )
    assert outcomes == PlacementOutcomes(frozenset(), frozenset())


@pytest.mark.parametrize("kind", ["daily", "game"])
def test_only_a_placement_session_has_outcomes(fake: FakePostgrest, kind: str) -> None:
    edition_id, ids = quran_edition(fake)
    fake.add_placement(USER, SESSION, edition_id, [(ids[0], True, False)], kind=kind)
    with pytest.raises(PlacementNotFound):
        postgrest_reader(fake).placement_outcomes(
            session_context(USER, token=TOKEN), SESSION, edition_id
        )


def test_the_postgrest_reader_refuses_foreign_unknown_and_other_edition_sessions(
    fake: FakePostgrest,
) -> None:
    edition_id, ids = quran_edition(fake)
    fake.add_placement(USER, SESSION, edition_id, [(ids[0], True, False)])
    reader = postgrest_reader(fake)
    with pytest.raises(PlacementNotFound):  # row-level security: the other learner sees nothing
        reader.placement_outcomes(session_context(OTHER, token=OTHER_TOKEN), SESSION, edition_id)
    with pytest.raises(PlacementNotFound):
        reader.placement_outcomes(session_context(USER, token=TOKEN), UUID(int=9), edition_id)
    with pytest.raises(PlacementNotFound):
        reader.placement_outcomes(session_context(USER, token=TOKEN), SESSION, OTHER_EDITION)


def test_the_postgrest_reader_needs_the_learners_token(fake: FakePostgrest) -> None:
    edition_id, _ = quran_edition(fake)
    with pytest.raises(AppError) as caught:
        postgrest_reader(fake).placement_outcomes(session_context(USER), SESSION, edition_id)
    assert caught.value.code is ErrorCode.unauthenticated


def test_a_damaged_attempt_row_is_an_internal_error(fake: FakePostgrest) -> None:
    edition_id, ids = quran_edition(fake)
    fake.add_placement(USER, SESSION, edition_id, [(ids[0], True, False)])
    fake.attempts[0]["passage_id"] = "not-a-uuid"
    with pytest.raises(AppError) as caught:
        postgrest_reader(fake).placement_outcomes(
            session_context(USER, token=TOKEN), SESSION, edition_id
        )
    assert caught.value.code is ErrorCode.internal


# --- a reader without the outcomes read -----------------------------------------------------------


class KnownOnlyReader:
    """The in-memory learning store of ``create_app`` memory mode has only ``known_passage_ids``."""

    def __init__(self, known: frozenset[UUID]) -> None:
        self.known = known

    def known_passage_ids(
        self, ctx: SessionContext, placement_session_id: UUID, edition_id: UUID
    ) -> frozenset[UUID]:
        return self.known


def recorded_basis(tmp_path: Path, reader: Any, *, demo: bool = True) -> policy.PlannerBasis:
    settings = make_settings(QATRA_CONTENT_BUNDLES=BUNDLES)
    services = build_planning_services(settings, clock=Clock(), placements=reader)
    assert services.plans is not None and services.content is not None
    edition = next(
        e
        for e in services.catalog.list_editions()
        if e.edition_key == "quran-hafs-quranenc"  # type: ignore[union-attr]
    )
    ids = [row.passage_id for row in services.content.passages(UUID(edition.edition_id))]
    reader.known = frozenset({ids[0], ids[3]})
    seen: list[policy.PlannerBasis] = []

    def planner(basis: policy.PlannerBasis) -> policy.PlannerOutcome:
        seen.append(basis)
        return policy.RULES_OUTCOME

    services.plans.create_demo_plan(
        session_context(USER, demo=demo),
        scenario_id="scenario-02",
        edition_id=UUID(edition.edition_id),
        ordinals=[1, 2, 3],
        paths=["quran"],
        order="book",
        session_minutes=5,
        preferred_offset_days=None,
        placement_session_id=SESSION,
        fallback_placement=(9, 9),
        planner=planner,
    )
    [basis] = seen
    return basis


def test_a_reader_without_outcomes_counts_the_known_passages_and_no_incorrect_ones(
    tmp_path: Path,
) -> None:
    basis = recorded_basis(tmp_path, KnownOnlyReader(frozenset()))
    assert (basis.placement_correct, basis.placement_incorrect) == (2, 0)
    assert basis.scenario_id == "scenario-02" and basis.session_minutes == 5


def test_a_non_demo_account_cannot_use_the_demo_plan_builder(tmp_path: Path) -> None:
    with pytest.raises(AppError) as caught:
        recorded_basis(tmp_path, KnownOnlyReader(frozenset()), demo=False)
    assert caught.value.code is ErrorCode.forbidden


# --- E28 over the fake PostgREST ------------------------------------------------------------------


@dataclass
class Supa:
    app: FastAPI
    fake: FakePostgrest
    provider: FakeJsonProvider
    ledger: InMemoryUsageLedger

    def client(self) -> TestClient:
        login_as(self.app, USER, demo=True, token=TOKEN)
        return browser(self.app)


@pytest.fixture
def supa(tmp_path: Path, fake: FakePostgrest) -> Supa:
    fixtures = write_fixtures(tmp_path / "fixtures")
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL=PROJECT,
        SUPABASE_ANON_KEY=ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY=SERVICE_ROLE_KEY,
        QATRA_DEMO_FIXTURES_DIR=str(fixtures),
        QATRA_RATE_SESSION_WRITE_PER_MIN=10_000,
    )
    clock = Clock()
    services = build_planning_services(settings, clock=clock, transport=fake.transport())
    app = create_app(settings)
    app.state.catalog_service = services.catalog
    app.state.plan_service = services.plans
    fake.add_user(USER, TOKEN)
    provider = FakeJsonProvider(advice_reply(newWordsPerDay=4))
    ledger = InMemoryUsageLedger()
    install_demo(app, settings, provider=provider, ledger=ledger, clock=clock)
    return Supa(app, fake, provider, ledger)


def test_e28_over_postgrest_writes_the_plan_with_the_advice(supa: Supa) -> None:
    edition_id, ids = quran_edition(supa.fake)
    supa.fake.add_placement(
        USER, SESSION, edition_id, [(ids[0], True, False), (ids[1], False, False)]
    )
    response = supa.client().post(
        "/api/demo/plans", json={"scenarioId": "scenario-02", "placementSessionId": str(SESSION)}
    )
    assert response.status_code == 201, response.text
    plan = response.json()
    assert plan["planner"] == {"source": "teaching_agent", "model": "free-model-x"}
    assert plan["agreedEstimate"]["newWordsPerDay"] == 4
    assert plan["agreedEstimate"]["knownWords"] == 12
    assert supa.provider.calls[0]["placement"] == {"correct": 1, "incorrect": 1}
    [version] = supa.fake.versions
    assert version["reason_code"] == "plan_created"
    assert version["policy_json"]["planner"]["advice"]["newWordsPerDay"] == 4
    assert version["policy_json"]["planner"]["source"] == "teaching_agent"
    [stored] = supa.fake.plans.values()
    assert stored["agreed_estimate"]["newWordsPerDay"] == 4
    assert [r.status for r in supa.ledger.rows] == ["succeeded"]


def test_e28_over_postgrest_uses_only_the_learners_token_for_learner_data(supa: Supa) -> None:
    response = supa.client().post("/api/demo/plans", json={"scenarioId": "scenario-07"})
    assert response.status_code == 201
    catalog_paths = {"/catalog_editions", "/catalog_sections"}
    assert catalog_paths <= {call.path for call in supa.fake.calls}
    for call in supa.fake.calls:
        assert call.headers["apikey"] == ANON_KEY
        if call.path in catalog_paths:
            assert "authorization" not in call.headers  # the anon role, no session
        else:
            assert call.headers["authorization"] == f"Bearer {TOKEN}"
        assert SERVICE_ROLE_KEY not in call.headers.values()
        assert SERVICE_ROLE_KEY not in str(call.body)
    rpcs = [c.path for c in supa.fake.calls if c.path.startswith("/rpc/")]
    assert rpcs == ["/rpc/app_create_plan"]


def test_e28_over_postgrest_a_foreign_placement_is_404(supa: Supa) -> None:
    edition_id, ids = quran_edition(supa.fake)
    supa.fake.add_user(OTHER, OTHER_TOKEN)
    supa.fake.add_placement(OTHER, SESSION, edition_id, [(ids[0], True, False)])
    response = supa.client().post(
        "/api/demo/plans", json={"scenarioId": "scenario-02", "placementSessionId": str(SESSION)}
    )
    assert response.status_code == 404
    assert supa.fake.plans == {} and supa.provider.calls == []


def test_e28_over_postgrest_without_a_usable_model_is_a_rules_plan(supa: Supa) -> None:
    supa.provider.enabled = False
    response = supa.client().post("/api/demo/plans", json={"scenarioId": "scenario-07"})
    assert response.status_code == 201 and response.json()["planner"] == {"source": "rules"}
    [version] = supa.fake.versions
    assert version["policy_json"]["planner"] == {"source": "rules"}
