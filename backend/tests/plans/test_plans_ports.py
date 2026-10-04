"""The adapters that give the plan conversation (B13) its ports, bound to one request's context.

``PlanService.ports_for(ctx)`` returns an object that implements ``PlanningRules`` and
``PlanWriter`` of ``app.domain.planning_port``. These tests call it with the exact keyword
arguments the conversation uses, and finally run the real ``PlanChatService`` on top of it.
"""

from __future__ import annotations

import inspect
from datetime import date
from pathlib import Path
from uuid import UUID

import pytest

from app.contracts_plan_chat import (
    CreatePlanChatRequest,
    Estimate,
    EstimateResult,
    Plan,
    TargetScope,
)
from app.domain import plan_policy as pp
from app.domain.planning_port import (
    EstimateChanged,
    PlacementNotFound,
    PlanningRuleError,
    PlanningRules,
    PlanNotActive,
    PlanNotFound,
    PlanVersionConflict,
    PlanWriter,
    RevisablePlan,
)
from app.errors import AppError, ErrorCode
from app.repositories.plans import LearningZone
from app.services.plan_chat import build_plan_chat_service
from app.services.plans import PlanPorts
from tests.plan_chat.pc_support import FakeLearning
from tests.plans.plans_support import (
    EXAMPLE_ESTIMATE,
    HADITH_ID,
    OTHER_USER_ID,
    PLACEMENT_ID,
    QURAN_ID,
    UNKNOWN_ID,
    USER_ID,
    Env,
    make_env,
    pid,
    session_context,
)


@pytest.fixture
def env(tmp_path: Path) -> Env:
    environment = make_env(tmp_path)
    environment.seed_placement()
    return environment


@pytest.fixture
def ports(env: Env) -> PlanPorts:
    return env.services.plans.ports_for(session_context())


def example() -> Estimate:
    return Estimate.model_validate(EXAMPLE_ESTIMATE)


def create(ports: PlanPorts, **overrides) -> Plan:
    values = {
        "is_demo": False,
        "edition_id": QURAN_ID,
        "target_scope": TargetScope(section_ordinals=[1, 2]),
        "paths": ["quran"],
        "order": "book",
        "session_minutes": 5,
        "preferred_date": date(2026, 10, 20),
        "placement_session_id": PLACEMENT_ID,
        "confirmed_estimate": example(),
        "planner_source": "rules",
        "planner_model": None,
    }
    values.update(overrides)
    return ports.create_plan(USER_ID, **values)


def revise(ports: PlanPorts, plan: Plan, **overrides) -> Plan:
    values = {
        "expected_version": plan.current_version,
        "target_scope": plan.target_scope,
        "paths": list(plan.paths),
        "order": plan.order,
        "session_minutes": plan.session_minutes,
        "preferred_date": plan.preferred_date,
        "confirmed_estimate": plan.agreed_estimate,
    }
    values.update(overrides)
    return ports.revise_plan(USER_ID, plan.plan_id, **values)


# --- PlanningRules -------------------------------------------------------------------------------


def test_estimate_is_the_e15_function(ports: PlanPorts) -> None:
    result = ports.estimate(
        USER_ID,
        QURAN_ID,
        TargetScope(section_ordinals=[1, 2]),
        ["quran"],
        5,
        date(2026, 10, 20),
        PLACEMENT_ID,
        "book",
    )
    assert isinstance(result, EstimateResult)
    assert result.estimate.model_dump(by_alias=True, mode="json") == EXAMPLE_ESTIMATE
    assert len(result.alternatives) == 2 and result.reason_code == "fits_preferred_date"


def test_estimate_defaults_the_order_to_book(ports: PlanPorts) -> None:
    result = ports.estimate(
        USER_ID, QURAN_ID, TargetScope(section_ordinals=[1, 2, 3, 4]), ["quran"], 5, None, None
    )
    assert result.alternatives[-1].scope.section_ordinals == [1, 2]


def test_estimate_raises_the_port_rule_error_with_the_first_failing_field(ports: PlanPorts) -> None:
    with pytest.raises(PlanningRuleError) as exc:
        ports.estimate(USER_ID, QURAN_ID, TargetScope(section_ordinals=[99]), ["x"], 7, None, None)
    assert type(exc.value) is PlanningRuleError
    assert (exc.value.rule, exc.value.field) == ("scope_invalid", "targetScope")


def test_estimate_refuses_reverse_for_a_hadith_edition(ports: PlanPorts) -> None:
    with pytest.raises(PlanningRuleError) as exc:
        ports.estimate(
            USER_ID,
            HADITH_ID,
            TargetScope(section_ordinals=[1]),
            ["matn"],
            5,
            None,
            None,
            "reverse",
        )
    assert (exc.value.rule, exc.value.field) == ("order_not_available", "order")


def test_an_unknown_placement_session_is_placement_not_found(ports: PlanPorts, env: Env) -> None:
    env.seed_placement(OTHER_USER_ID, placement_id=UNKNOWN_ID)  # another account's session
    for placement in (UNKNOWN_ID, UUID(int=5)):  # foreign, then unknown
        with pytest.raises(PlacementNotFound):
            ports.estimate(
                USER_ID, QURAN_ID, TargetScope(section_ordinals=[1]), ["quran"], 5, None, placement
            )


def test_catalog_edition(ports: PlanPorts) -> None:
    edition = ports.catalog_edition(QURAN_ID)
    assert edition.edition_id == str(QURAN_ID) and edition.content_format == "quran"
    assert [s.ordinal for s in edition.sections] == [1, 2, 3, 4]
    with pytest.raises(PlanningRuleError) as exc:
        ports.catalog_edition(UNKNOWN_ID)
    assert (exc.value.rule, exc.value.field) == ("edition_not_available", "editionId")


def test_learning_date_follows_the_profile(env: Env, ports: PlanPorts) -> None:
    assert ports.learning_date(USER_ID) == date(2026, 10, 4)
    env.services.profiles.set_zone(USER_ID, LearningZone("Pacific/Kiritimati"))  # UTC+14
    assert ports.learning_date(USER_ID) == date(2026, 10, 4)  # 23:00 on 4 October there
    env.services.profiles.set_zone(USER_ID, LearningZone("Pacific/Auckland"))  # UTC+13
    assert ports.learning_date(USER_ID) == date(2026, 10, 4)


# --- the user id must be the context's -----------------------------------------------------------


def test_every_method_refuses_a_user_id_that_is_not_the_contexts(ports: PlanPorts) -> None:
    other = OTHER_USER_ID
    calls = [
        lambda: ports.learning_date(other),
        lambda: ports.estimate(
            other, QURAN_ID, TargetScope(section_ordinals=[1]), ["quran"], 5, None, None
        ),
        lambda: ports.load_plan(other, UNKNOWN_ID),
        lambda: ports.create_plan(
            other,
            is_demo=False,
            edition_id=QURAN_ID,
            target_scope=TargetScope(section_ordinals=[1]),
            paths=["quran"],
            order="book",
            session_minutes=5,
            preferred_date=None,
            placement_session_id=None,
            confirmed_estimate=example(),
            planner_source="rules",
            planner_model=None,
        ),
        lambda: ports.revise_plan(
            other,
            UNKNOWN_ID,
            expected_version=1,
            target_scope=TargetScope(section_ordinals=[1]),
            paths=["quran"],
            order="book",
            session_minutes=5,
            preferred_date=None,
            confirmed_estimate=example(),
        ),
    ]
    for call in calls:
        with pytest.raises(AppError) as exc:
            call()
        assert exc.value.code is ErrorCode.internal


# --- PlanWriter.create_plan ----------------------------------------------------------------------


def test_create_plan_is_the_e16_function(ports: PlanPorts, env: Env) -> None:
    plan = create(ports)
    assert plan.agreed_estimate.model_dump(by_alias=True, mode="json") == EXAMPLE_ESTIMATE
    assert (plan.current_version, plan.status, plan.planner.source) == (1, "active", "rules")
    [stored] = env.repository.plans_of(USER_ID)
    assert stored.plan_id == plan.plan_id


def test_create_plan_pauses_the_previous_active_plan(ports: PlanPorts, env: Env) -> None:
    first = create(ports)
    second = create(
        ports,
        target_scope=TargetScope(section_ordinals=[3]),
        placement_session_id=None,
        confirmed_estimate=ports.estimate(
            USER_ID, QURAN_ID, TargetScope(section_ordinals=[3]), ["quran"], 5, None, None
        ).estimate,
    )
    statuses = {p.plan_id: p.status for p in env.repository.plans_of(USER_ID)}
    assert statuses == {first.plan_id: "paused", second.plan_id: "active"}


def test_create_plan_works_for_a_demo_account(env: Env) -> None:
    """E34 creates a demo account's plan with the same function (no mode is stored)."""
    demo_ports = env.services.plans.ports_for(session_context(USER_ID, demo=True))
    plan = demo_ports.create_plan(
        USER_ID,
        is_demo=True,
        edition_id=QURAN_ID,
        target_scope=TargetScope(section_ordinals=[1, 2]),
        paths=["quran"],
        order="book",
        session_minutes=5,
        preferred_date=date(2026, 10, 20),
        placement_session_id=PLACEMENT_ID,
        confirmed_estimate=example(),
        planner_source="rules",
        planner_model=None,
    )
    assert plan.status == "active"


def test_the_demo_flag_must_match_the_context(ports: PlanPorts) -> None:
    with pytest.raises(AppError) as exc:
        create(ports, is_demo=True)
    assert exc.value.code is ErrorCode.internal


def test_create_plan_a_changed_estimate_is_estimate_changed(ports: PlanPorts, env: Env) -> None:
    with pytest.raises(EstimateChanged) as exc:
        create(ports, confirmed_estimate=example().model_copy(update={"days": 3}))
    assert type(exc.value) is EstimateChanged
    assert env.repository.plans_of(USER_ID) == []


def test_create_plan_validates_the_rules_again(ports: PlanPorts) -> None:
    with pytest.raises(PlanningRuleError) as exc:
        create(ports, session_minutes=7)
    assert exc.value.rule == "session_minutes_invalid"
    with pytest.raises(PlacementNotFound):
        create(ports, placement_session_id=UNKNOWN_ID)


def test_a_model_supplied_plan_reports_the_teaching_agent_and_its_model(
    ports: PlanPorts, env: Env
) -> None:
    plan = create(ports, planner_source="teaching_agent", planner_model="free/model:free")
    assert (plan.planner.source, plan.planner.model) == ("teaching_agent", "free/model:free")
    [version] = env.repository.versions_of(plan.plan_id)
    assert version["policy"]["planner"] == {"source": "teaching_agent", "model": "free/model:free"}
    assert ports.load_plan(USER_ID, plan.plan_id) is not None


# --- PlanWriter.load_plan and revise_plan --------------------------------------------------------


def test_load_plan_returns_what_the_conversation_needs(ports: PlanPorts) -> None:
    plan = create(ports)
    loaded = ports.load_plan(USER_ID, plan.plan_id)
    assert isinstance(loaded, RevisablePlan)
    assert loaded.plan_id == plan.plan_id and loaded.edition_id == QURAN_ID
    assert loaded.target_scope.section_ordinals == [1, 2] and loaded.paths == ["quran"]
    assert (loaded.order, loaded.session_minutes, loaded.current_version) == ("book", 5, 1)
    assert loaded.preferred_date == date(2026, 10, 20) and loaded.status == "active"
    assert loaded.placement_session_id == PLACEMENT_ID


def test_load_plan_has_no_placement_when_the_plan_had_none(ports: PlanPorts) -> None:
    estimate = ports.estimate(
        USER_ID, QURAN_ID, TargetScope(section_ordinals=[2]), ["quran"], 5, None, None
    ).estimate
    plan = create(
        ports,
        target_scope=TargetScope(section_ordinals=[2]),
        placement_session_id=None,
        confirmed_estimate=estimate,
    )
    assert ports.load_plan(USER_ID, plan.plan_id).placement_session_id is None


def test_load_plan_hides_unknown_and_foreign_plans(ports: PlanPorts, env: Env) -> None:
    plan = create(ports)
    other = env.services.plans.ports_for(session_context(OTHER_USER_ID))
    assert other.load_plan(OTHER_USER_ID, plan.plan_id) is None
    assert ports.load_plan(USER_ID, UNKNOWN_ID) is None


def test_revise_plan_is_the_e17_function(ports: PlanPorts, env: Env) -> None:
    plan = create(ports)
    estimate = ports.estimate(
        USER_ID,
        QURAN_ID,
        plan.target_scope,
        ["quran"],
        10,
        plan.preferred_date,
        PLACEMENT_ID,
        "book",
    ).estimate
    revised = revise(ports, plan, session_minutes=10, confirmed_estimate=estimate)
    assert (revised.current_version, revised.session_minutes) == (2, 10)
    assert revised.agreed_estimate == estimate
    assert [v["versionNo"] for v in env.repository.versions_of(plan.plan_id)] == [1, 2]


def test_a_revision_proposal_and_the_commit_agree_on_the_known_words(ports: PlanPorts) -> None:
    """The conversation estimates with the plan's placement id; the commit must recompute the same
    numbers, or the learner would be sent round in circles."""
    plan = create(ports)
    loaded = ports.load_plan(USER_ID, plan.plan_id)
    proposal = ports.estimate(
        USER_ID,
        loaded.edition_id,
        loaded.target_scope,
        loaded.paths,
        15,
        loaded.preferred_date,
        loaded.placement_session_id,
        loaded.order,
    )
    assert proposal.estimate.known_words == 20
    assert revise(ports, plan, session_minutes=15, confirmed_estimate=proposal.estimate)


def test_revise_plan_exceptions_are_the_port_types(ports: PlanPorts, env: Env) -> None:
    plan = create(ports)
    with pytest.raises(PlanNotFound):
        ports.revise_plan(
            USER_ID,
            UNKNOWN_ID,
            expected_version=1,
            target_scope=plan.target_scope,
            paths=["quran"],
            order="book",
            session_minutes=5,
            preferred_date=None,
            confirmed_estimate=example(),
        )
    stale = revise(ports, plan)  # version 2
    with pytest.raises(PlanVersionConflict) as conflict:
        revise(ports, plan)  # quotes version 1 again
    assert conflict.value.current_version == stale.current_version == 2
    with pytest.raises(EstimateChanged):
        revise(ports, stale, session_minutes=15, confirmed_estimate=stale.agreed_estimate)
    with pytest.raises(PlanningRuleError) as rule:
        revise(ports, stale, session_minutes=7)
    assert rule.value.rule == "session_minutes_invalid"
    env.repository.complete_plan(plan.plan_id)
    with pytest.raises(PlanNotActive):
        revise(ports, stale)


def test_revise_plan_cannot_change_the_scope(ports: PlanPorts) -> None:
    plan = create(ports)
    with pytest.raises(PlanningRuleError) as exc:
        revise(ports, plan, target_scope=TargetScope(section_ordinals=[1]))
    assert (exc.value.rule, exc.value.field) == ("scope_invalid", "targetScope")


def test_revise_plan_hides_another_accounts_plan(ports: PlanPorts, env: Env) -> None:
    plan = create(ports)
    other = env.services.plans.ports_for(session_context(OTHER_USER_ID))
    with pytest.raises(PlanNotFound):
        other.revise_plan(
            OTHER_USER_ID,
            plan.plan_id,
            expected_version=1,
            target_scope=plan.target_scope,
            paths=["quran"],
            order="book",
            session_minutes=10,
            preferred_date=None,
            confirmed_estimate=example(),
        )


# --- the real plan conversation on top of the ports ----------------------------------------------


def conversation_request(**overrides) -> CreatePlanChatRequest:
    body = {
        "editionId": str(QURAN_ID),
        "targetScope": {"sectionOrdinals": [1, 2]},
        "paths": ["quran"],
        "sessionMinutes": 5,
        "preferredDate": "2026-10-20",
        "placementSessionId": str(PLACEMENT_ID),
        "goalText": "plan",
        "language": "en",
    }
    body.update(overrides)
    return CreatePlanChatRequest.model_validate(body)


def test_the_plan_conversation_creates_and_revises_a_plan_through_the_ports(env: Env) -> None:
    context = session_context()
    ports = env.services.plans.ports_for(context)
    chat = build_plan_chat_service(
        env.settings,
        planning=ports,
        writer=ports,
        learning=FakeLearning(),
        provider=None,
        clock=env.clock,
    )
    opened = chat.create_conversation(context, conversation_request())
    assert opened.proposal is not None
    assert opened.proposal.estimate.model_dump(by_alias=True, mode="json") == EXAMPLE_ESTIMATE

    plan, created = chat.confirm_plan(context, opened.chat_id, opened.proposal.proposal_version)
    assert created is True and plan.status == "active" and plan.current_version == 1
    assert plan.agreed_estimate == opened.proposal.estimate
    assert plan.planner.source == "rules"

    revision = chat.create_conversation(
        context,
        conversation_request(planId=str(plan.plan_id), sessionMinutes=10),
    )
    assert revision.proposal is not None and revision.proposal.session_minutes == 10
    assert revision.proposal.estimate.known_words == 20  # the plan's own placement session
    revised, created = chat.confirm_plan(
        context, revision.chat_id, revision.proposal.proposal_version
    )
    assert created is False and revised.current_version == 2 and revised.session_minutes == 10
    assert revised.agreed_estimate == revision.proposal.estimate
    assert [v["versionNo"] for v in env.repository.versions_of(plan.plan_id)] == [1, 2]


def test_the_conversation_for_a_completed_plan_is_refused_through_load_plan(env: Env) -> None:
    context = session_context()
    ports = env.services.plans.ports_for(context)
    plan = create(ports)
    env.repository.complete_plan(plan.plan_id)
    chat = build_plan_chat_service(
        env.settings, planning=ports, writer=ports, learning=FakeLearning(), provider=None
    )
    with pytest.raises(AppError) as exc:
        chat.create_conversation(context, conversation_request(planId=str(plan.plan_id)))
    assert exc.value.details == {"reason": "plan_not_active"}


def test_known_passage_ids_are_recorded_for_the_conversation_plan(env: Env) -> None:
    context = session_context()
    ports = env.services.plans.ports_for(context)
    plan = create(ports)
    [version] = env.repository.versions_of(plan.plan_id)
    assert version["policy"]["knownPassages"]["passageIds"] == [str(pid(1))]


# --- the adapters keep the signatures of the protocols -------------------------------------------


@pytest.mark.parametrize("protocol", [PlanningRules, PlanWriter])
def test_the_ports_have_the_signatures_of_the_protocols(protocol) -> None:
    """A change of ``planning_port.py`` (or of the adapters) that breaks the plan conversation
    must fail here first: same method names, parameter names, kinds and defaults."""
    names = [name for name in vars(protocol) if not name.startswith("_")]
    assert names
    for name in names:
        expected = inspect.signature(getattr(protocol, name)).parameters
        actual = inspect.signature(getattr(PlanPorts, name)).parameters
        assert list(actual) == list(expected), name
        for parameter in expected:
            assert actual[parameter].kind == expected[parameter].kind, (name, parameter)
            assert actual[parameter].default == expected[parameter].default, (name, parameter)


# --- the commit can be built without writing (for the conversation's own transaction) ------------


def test_prepare_creation_builds_the_commit_and_writes_nothing(env: Env) -> None:
    service = env.services.plans
    commit = service.prepare_creation(
        session_context(),
        edition_id=QURAN_ID,
        ordinals=[2, 1],
        paths=["quran"],
        order="book",
        session_minutes=5,
        preferred_date=date(2026, 10, 20),
        placement_session_id=PLACEMENT_ID,
        confirmed=example(),
        planner_source="rules",
        planner_model=None,
    )
    assert set(commit.plan_args()) == {
        "reason_code",
        "policy_json",
        "effective_learning_date",
        "phases",
    }
    assert commit.values.scope == (1, 2) and commit.values.agreed_estimate == example()
    assert len(commit.plan_args()["phases"]) == 2
    assert env.repository.plans_of(USER_ID) == []


def test_prepare_creation_refuses_what_the_write_would_refuse(env: Env) -> None:
    with pytest.raises(pp.EstimateMismatch):
        env.services.plans.prepare_creation(
            session_context(),
            edition_id=QURAN_ID,
            ordinals=[1, 2],
            paths=["quran"],
            order="book",
            session_minutes=5,
            preferred_date=None,
            placement_session_id=None,  # without the placement the example estimate is wrong
            confirmed=example(),
            planner_source="rules",
            planner_model=None,
        )


def test_prepare_revision_builds_the_commit_and_writes_nothing(ports: PlanPorts, env: Env) -> None:
    plan = create(ports)
    commit = env.services.plans.prepare_revision(
        session_context(), plan.plan_id, expected_version=1, session_minutes=10
    )
    assert commit.reason_code == "plan_revised" and commit.values.session_minutes == 10
    assert commit.effective_learning_date == date(2026, 10, 5)
    assert [v["versionNo"] for v in env.repository.versions_of(plan.plan_id)] == [1]
    with pytest.raises(PlanVersionConflict):
        env.services.plans.prepare_revision(
            session_context(), plan.plan_id, expected_version=7, session_minutes=10
        )
