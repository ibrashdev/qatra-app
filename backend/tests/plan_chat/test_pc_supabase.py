"""E31-E34 on the production wiring in supabase mode, against a fake Supabase project.

The conversation lives in ``plan_chats`` and ``plan_chat_messages`` behind the three learner
functions of migration 0006, read and written with the learner's own access token. The usage
ledger writes ``srv_record_ai_usage`` over a fake restricted connection. Nothing here was run
against a real project: ``ChatProject`` is a test double.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.dependencies import SessionContext
from app.domain.plan_policy import REASON_CREATED, REASON_REVISED
from app.main import create_app
from app.repositories import ai_usage as ai_usage_module
from app.repositories.ai_usage import PostgresUsageLedger
from app.repositories.plan_chats import PostgrestPlanChatRepository
from app.services.plan_chat import (
    AtomicPlanConfirmer,
    PlanChatGateway,
    build_plan_chat_gateway,
)
from tests.plan_chat.pc_e2e_support import FREE_GOAL, MODEL_ID, FakeOpenRouter
from tests.plan_chat.pc_supabase_support import (
    DSN,
    MODEL_SETTINGS,
    SupabaseJourney,
    UsageDatabase,
    build_supabase_journey,
)
from tests.plans.fake_postgrest import ACTIVE_KEY_MESSAGE, db_error
from tests.plans.plans_support import login_as
from tests.sessions.ss_postgrest import ANON, TOKEN
from tests.sessions.ss_support import OTHER_USER, QURAN, QURAN_EDITION, USER
from tests.support import FRONTEND_ORIGIN, make_settings, production_values


def code(response: httpx.Response) -> str:
    return str(response.json()["error"]["code"])


def reason(response: httpx.Response) -> str:
    return str(response.json()["error"]["details"]["reason"])


@pytest.fixture
def journey(usage_database: UsageDatabase) -> SupabaseJourney:
    return build_supabase_journey(usage_database)


# --- the wiring --------------------------------------------------------------------------------


def test_supabase_mode_installs_the_conversation_with_the_database_ledger(
    journey: SupabaseJourney,
) -> None:
    assert isinstance(journey.gateway.ledger, PostgresUsageLedger)
    assert journey.gateway.provider is None  # no key and no model configured


def test_without_the_supabase_configuration_the_endpoints_answer_503() -> None:
    app = create_app(make_settings(QATRA_DATA_BACKEND="supabase"))
    assert app.state.plan_chat_service is None
    login_as(app, USER, token=TOKEN)
    client = TestClient(app, headers={"Origin": FRONTEND_ORIGIN})
    response = client.post("/api/plan-chats", json={})
    assert (response.status_code, code(response)) == (503, "unavailable")


def test_the_production_wiring_uses_the_database_stores_and_connects_to_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_connection(*args: object, **kwargs: object) -> None:
        raise AssertionError("installing the conversation must not open a database connection")

    monkeypatch.setattr(ai_usage_module.psycopg, "connect", no_connection)
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        **production_values(OPENROUTER_API_KEY="dummy-key", OPENROUTER_MODELS=MODEL_ID),
    )
    app = create_app(settings)
    gateway = app.state.plan_chat_service
    assert isinstance(gateway, PlanChatGateway)
    assert isinstance(gateway.ledger, PostgresUsageLedger) and "dummy" not in repr(gateway.ledger)
    assert gateway.provider is not None and gateway.provider.is_enabled()
    binding = gateway.binding(SessionContext(user_id=USER, is_demo=False, auth_epoch=1))
    assert isinstance(binding.repository, PostgrestPlanChatRepository)
    assert isinstance(binding.confirmer, AtomicPlanConfirmer)
    assert settings.QATRA_CHAT_MODEL_FOR_LEARNERS is False  # the model stays off unless enabled


def test_production_never_falls_back_to_process_memory(usage_database: UsageDatabase) -> None:
    journey = build_supabase_journey(usage_database)
    plans = journey.app.state.plan_service
    production = make_settings(
        APP_ENV="production",
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL="https://project.example",
        SUPABASE_ANON_KEY=ANON,
    )
    client = journey.app.state.postgrest_client
    with pytest.raises(RuntimeError, match="must be provided in production"):
        build_plan_chat_gateway(production, plans=plans, client=client)
    memory = make_settings(APP_ENV="production", QATRA_DATA_BACKEND="memory")
    with pytest.raises(RuntimeError, match="refused in production"):
        build_plan_chat_gateway(memory, plans=plans)
    with pytest.raises(ValueError, match="PostgREST client"):
        build_plan_chat_gateway(make_settings(QATRA_DATA_BACKEND="supabase"), plans=plans)


# --- the rules journey -------------------------------------------------------------------------


def test_the_first_turn_is_one_database_call(journey: SupabaseJourney) -> None:
    goal = journey.goal_for(journey.body())
    chat = journey.create_chat()
    assert chat["status"] == "open" and chat["assistant"] == {"source": "rules"}
    (call,) = journey.project.rpc_calls("app_plan_chat_open")
    assert set(call) == {"p_language", "p_first_learner_text", "p_first_assistant", "p_proposal"}
    assert (call["p_language"], call["p_first_learner_text"]) == ("en", goal)
    assert "p_plan" not in call  # a creation: the optional argument is left out
    assert [m["kind"] for m in call["p_first_assistant"]] == ["proposal"]
    assert call["p_first_assistant"][0]["source"] == "rules"
    assert call["p_proposal"]["proposalVersion"] == 1
    assert call["p_first_assistant"][0]["payload"]["proposal"] == call["p_proposal"]
    assert journey.project.rpc_calls("app_plan_chat_append") == []  # no model turn to count
    stored = journey.project.chats[chat["chatId"]]
    assert stored["proposal_version"] == 1 and stored["model_turns"] == 0
    assert [m["ordinal"] for m in chat["messages"]] == [1, 2]


def test_every_chat_call_uses_the_learner_token(journey: SupabaseJourney) -> None:
    chat = journey.create_chat()
    journey.post(chat["chatId"], "messages", {"quickReply": "more_minutes"})
    journey.client.get(f"/api/plan-chats/{chat['chatId']}")
    journey.post(chat["chatId"], "confirm", {"proposalVersion": 2})
    requests = journey.chat_requests()
    assert len(requests) >= 6
    for request in requests:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert request.headers["apikey"] == ANON
    assert journey.usage.connects == []  # no model call: nothing to meter


def test_no_json_null_reaches_a_function_argument(journey: SupabaseJourney) -> None:
    """Optional arguments are left out and an absent payload has no key, so no JSON null is sent
    for a jsonb argument (where it could be read as the JSON value null, not as no value)."""
    chat = journey.create_chat()
    journey.post(chat["chatId"], "messages", {"quickReply": "more_minutes"})
    journey.post(
        chat["chatId"], "messages", {"quickReply": "more_minutes"}
    )  # no change: no proposal
    journey.post(chat["chatId"], "confirm", {"proposalVersion": 2})
    assert len(journey.project.chat_calls) >= 8
    for name, body in journey.project.chat_calls:
        arguments = body or {}
        assert None not in arguments.values(), name
        for message in [*arguments.get("p_messages", []), *arguments.get("p_first_assistant", [])]:
            assert None not in message.values(), name


def test_quick_replies_and_the_confirmation(journey: SupabaseJourney) -> None:
    chat = journey.create_chat()
    turn = journey.post(chat["chatId"], "messages", {"quickReply": "more_minutes"})
    assert turn.status_code == 200
    updated = turn.json()
    assert updated["proposal"]["proposalVersion"] == 2
    assert updated["proposal"]["sessionMinutes"] == 10
    assert [m["ordinal"] for m in updated["messages"]] == [1, 2, 3, 4]
    assert [m["kind"] for m in updated["messages"]] == [
        "text",
        "proposal",
        "quick_reply",
        "proposal",
    ]
    assert journey.client.get(f"/api/plan-chats/{chat['chatId']}").json() == updated

    confirmed = journey.post(chat["chatId"], "confirm", {"proposalVersion": 2})
    assert confirmed.status_code == 201
    plan = confirmed.json()
    assert plan["planner"] == {"source": "rules"} and plan["status"] == "active"
    assert plan["agreedEstimate"] == updated["proposal"]["estimate"]
    assert plan["sessionMinutes"] == 10 and plan["currentVersion"] == 1

    # One transaction inside the database function: the plan is not written by another call.
    (call,) = journey.project.rpc_calls("app_plan_chat_confirm")
    assert call["p_chat"] == chat["chatId"] and call["p_expected_proposal_version"] == 2
    assert set(call["p_plan_args"]) == {
        "reason_code",
        "policy_json",
        "effective_learning_date",
        "phases",
    }
    assert call["p_plan_args"]["reason_code"] == REASON_CREATED
    assert journey.project.plans.calls_to("/rpc/app_create_plan") == []
    stored = journey.project.plans.plans[plan["planId"]]
    assert stored["user_id"] == str(USER) and stored["status"] == "active"
    assert journey.project.chats[chat["chatId"]]["status"] == "confirmed"
    assert journey.client.get(f"/api/plan-chats/{chat['chatId']}").json()["status"] == "confirmed"

    again = journey.post(chat["chatId"], "confirm", {"proposalVersion": 2})
    assert (again.status_code, reason(again)) == (409, "chat_closed")
    late = journey.post(chat["chatId"], "messages", {"quickReply": "fewer_minutes"})
    assert (late.status_code, reason(late)) == (409, "chat_closed")


def test_a_revision_confirms_the_plan_snapshot_inside_the_function(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    revision = journey.create_chat(planId=plan["planId"], sessionMinutes=10)
    assert journey.project.rpc_calls("app_plan_chat_open")[1]["p_plan"] == plan["planId"]
    done = journey.post(revision["chatId"], "confirm", {"proposalVersion": 1})
    assert done.status_code == 200 and done.json()["currentVersion"] == 2
    call = journey.project.rpc_calls("app_plan_chat_confirm")[1]
    assert call["p_plan_args"]["expected_version"] == 1  # the plan's version when the chat began
    assert call["p_plan_args"]["reason_code"] == REASON_REVISED
    versions = [v for v in journey.project.plans.versions if v["plan_id"] == plan["planId"]]
    assert [v["version_no"] for v in versions] == [1, 2]
    assert len(journey.project.plans.plans) == 1
    assert journey.project.plans.calls_to("/rpc/app_revise_plan") == []


def test_a_new_conversation_abandons_the_open_one_in_the_database(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    second = journey.create_chat()
    assert second["replacedChatId"] == first["chatId"]
    old = journey.project.chats[first["chatId"]]
    assert old["status"] == "abandoned" and old["closed_at"] is not None
    assert [c["status"] for c in journey.project.chats_of(USER)].count("open") == 1
    late = journey.post(first["chatId"], "messages", {"quickReply": "more_minutes"})
    assert reason(late) == "chat_closed"


def test_a_failed_first_turn_stores_nothing_and_keeps_the_previous_conversation(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    journey.project.fail("rpc/app_plan_chat_open", httpx.ConnectError("down"))
    response = journey.client.post("/api/plan-chats", json=journey.body())
    assert (response.status_code, code(response)) == (503, "unavailable")
    assert len(journey.project.chats) == 1
    assert journey.project.chats[first["chatId"]]["status"] == "open"


def test_the_loser_of_two_simultaneous_first_turns_is_told_to_try_again(
    journey: SupabaseJourney,
) -> None:
    journey.create_chat()
    journey.project.race_on_open = True  # the open-chat index refuses the second insert
    response = journey.client.post("/api/plan-chats", json=journey.body())
    assert (response.status_code, code(response)) == (503, "unavailable")
    assert [c["status"] for c in journey.project.chats_of(USER)] == ["open"]


# --- ownership: the database is the arbiter ----------------------------------------------------


def test_another_learners_token_sees_no_row_of_the_conversation(journey: SupabaseJourney) -> None:
    chat = journey.create_chat()
    journey.as_other_learner()
    path = f"/api/plan-chats/{chat['chatId']}"
    assert journey.client.get(path).status_code == 404
    quick = journey.post(chat["chatId"], "messages", {"quickReply": "more_minutes"})
    assert quick.status_code == 404
    assert journey.post(chat["chatId"], "confirm", {"proposalVersion": 1}).status_code == 404
    journey.as_learner()
    assert journey.client.get(path).json()["status"] == "open"
    assert OTHER_USER not in {UUID(c["user_id"]) for c in journey.project.chats.values()}


def test_an_unknown_conversation_is_404(journey: SupabaseJourney) -> None:
    response = journey.client.get("/api/plan-chats/00000000-0000-0000-0000-000000000009")
    assert (response.status_code, code(response)) == (404, "not_found")


def test_a_refused_token_is_401_and_a_database_outage_is_503(journey: SupabaseJourney) -> None:
    chat = journey.create_chat()
    path = f"/api/plan-chats/{chat['chatId']}"
    expired = httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"})
    journey.project.fail("plan_chats", expired)
    refused = journey.client.get(path)
    assert (refused.status_code, code(refused)) == (401, "unauthenticated")
    journey.project.fail("plan_chats", httpx.ReadTimeout("slow"))
    outage = journey.client.get(path)
    assert (outage.status_code, code(outage)) == (503, "unavailable")


# --- confirmation failures ---------------------------------------------------------------------


def test_a_stale_proposal_is_refused_before_the_database_and_saves_nothing(
    journey: SupabaseJourney,
) -> None:
    chat = journey.create_chat()
    journey.post(chat["chatId"], "messages", {"quickReply": "more_minutes"})
    response = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "proposal_stale")
    assert response.json()["error"]["details"]["proposal"]["proposalVersion"] == 2
    assert journey.project.rpc_calls("app_plan_chat_confirm") == []
    assert journey.project.plans.plans == {}


def test_a_proposal_that_changed_in_the_database_is_stale(journey: SupabaseJourney) -> None:
    chat = journey.create_chat()

    def race() -> httpx.Response:  # another process changed the proposal after our read
        journey.project.chats[chat["chatId"]]["proposal_version"] = 2
        return db_error(400, "QT002", "version_conflict")

    journey.project.fail("rpc/app_plan_chat_confirm", race)
    response = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "proposal_stale")
    assert journey.project.plans.plans == {}


def test_a_conversation_closed_in_the_database_is_chat_closed(journey: SupabaseJourney) -> None:
    chat = journey.create_chat()

    def race() -> httpx.Response:
        journey.project.chats[chat["chatId"]]["status"] = "abandoned"
        return db_error(400, "QT003", "invalid_state")

    journey.project.fail("rpc/app_plan_chat_confirm", race)
    response = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "chat_closed")


def test_the_one_active_plan_race_is_reported_and_leaves_the_conversation_open(
    journey: SupabaseJourney,
) -> None:
    chat = journey.create_chat()
    journey.project.fail("rpc/app_plan_chat_confirm", db_error(409, "23505", ACTIVE_KEY_MESSAGE))
    response = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "active_plan_conflict")
    assert journey.project.chats[chat["chatId"]]["status"] == "open"
    assert journey.post(chat["chatId"], "confirm", {"proposalVersion": 1}).status_code == 201


def test_a_plan_that_moved_since_the_snapshot_is_a_plan_version_conflict(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    revision = journey.create_chat(planId=plan["planId"], sessionMinutes=10)
    journey.project.plans.plans[plan["planId"]]["current_version"] = 2  # revised elsewhere
    response = journey.post(revision["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "plan_version")
    assert response.json()["error"]["details"]["currentVersion"] == 2
    assert (
        journey.project.rpc_calls("app_plan_chat_confirm")[1:] == []
    )  # refused before the function
    assert journey.project.chats[revision["chatId"]]["status"] == "open"


def test_the_database_noticing_a_moved_plan_is_a_plan_version_conflict_too(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    revision = journey.create_chat(planId=plan["planId"], sessionMinutes=10)

    def moves() -> None:  # the plan moves between the service's check and the function
        journey.project.plans.plans[plan["planId"]]["current_version"] = 5

    journey.project.before_confirm = moves
    response = journey.post(revision["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "plan_version")
    assert response.json()["error"]["details"]["currentVersion"] == 5
    assert journey.project.chats[revision["chatId"]]["status"] == "open"


def test_a_plan_completed_after_the_conversation_began_is_plan_not_active(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    revision = journey.create_chat(planId=plan["planId"], sessionMinutes=10)
    journey.project.plans.plans[plan["planId"]]["status"] = "completed"
    response = journey.post(revision["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "plan_not_active")
    assert journey.project.chats[revision["chatId"]]["status"] == "open"


def test_the_database_refusing_a_plan_that_completed_during_the_function_is_plan_not_active(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    revision = journey.create_chat(planId=plan["planId"], sessionMinutes=10)
    journey.project.fail("rpc/app_plan_chat_confirm", db_error(400, "QT003", "plan_not_active"))
    response = journey.post(revision["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "plan_not_active")


def test_a_revision_of_a_completed_plan_cannot_be_opened(journey: SupabaseJourney) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    journey.project.plans.plans[plan["planId"]]["status"] = "completed"
    body = journey.body(planId=plan["planId"], sessionMinutes=10)
    response = journey.client.post("/api/plan-chats", json=body)
    assert (response.status_code, reason(response)) == (409, "plan_not_active")
    assert len(journey.project.rpc_calls("app_plan_chat_open")) == 1


def test_the_database_refusing_a_plan_that_completed_before_the_first_turn_is_plan_not_active(
    journey: SupabaseJourney,
) -> None:
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    journey.project.fail("rpc/app_plan_chat_open", db_error(400, "QT003", "plan_not_active"))
    body = journey.body(planId=plan["planId"], sessionMinutes=10)
    response = journey.client.post("/api/plan-chats", json=body)
    assert (response.status_code, reason(response)) == (409, "plan_not_active")


def test_a_new_learning_day_rebuilds_the_proposal_and_reports_it_stale(
    journey: SupabaseJourney,
) -> None:
    chat = journey.create_chat()
    journey.clock.now += timedelta(days=1)  # the E16 recomputation now differs
    response = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, reason(response)) == (409, "proposal_stale")
    fresh = response.json()["error"]["details"]["proposal"]
    assert fresh["proposalVersion"] == 2
    assert journey.project.chats[chat["chatId"]]["proposal_version"] == 2
    assert journey.project.rpc_calls("app_plan_chat_confirm") == []  # refused before the function
    ok = journey.post(chat["chatId"], "confirm", {"proposalVersion": 2})
    assert ok.status_code == 201 and ok.json()["agreedEstimate"] == fresh["estimate"]


def test_a_preferred_date_that_has_passed_is_a_validation_error(journey: SupabaseJourney) -> None:
    now = journey.clock.now.astimezone(UTC)
    today = (now + timedelta(hours=4)).date()  # the account zone is Asia/Dubai
    chat = journey.create_chat(preferredDate=(today + timedelta(days=1)).isoformat())
    journey.clock.now += timedelta(days=3)
    response = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert response.json()["error"]["details"]["fields"] == [
        {"field": "preferredDate", "rule": "date_invalid"}
    ]
    assert journey.project.chats[chat["chatId"]]["status"] == "open"
    assert datetime.now(UTC)  # the real clock plays no part


# --- the model path, the ledger and the learning record ----------------------------------------


def test_a_model_turn_is_counted_and_recorded_through_the_restricted_role(
    usage_database: UsageDatabase,
) -> None:
    fake = FakeOpenRouter({"intent": "set_parameters", "parameters": {"sessionMinutes": 10}})
    journey = build_supabase_journey(
        usage_database, fake=fake, QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS
    )
    chat = journey.create_chat(goal=FREE_GOAL)
    assert chat["proposal"]["sessionMinutes"] == 10 and chat["modelTurnsLeft"] == 5
    assert journey.project.chats[chat["chatId"]]["model_turns"] == 1
    (increment,) = journey.project.rpc_calls("app_plan_chat_append")
    assert increment["p_messages"] == [] and increment["p_model_turns_increment"] == 1

    (write,) = usage_database.writes
    assert write == ("openrouter", MODEL_ID, "plan-chat-v2", 11, 4, None, "succeeded", None)
    assert usage_database.connects[0][0] == DSN
    recorded = json.dumps(usage_database.statements, default=str)
    for secret in (str(USER), TOKEN, chat["chatId"], FREE_GOAL):
        assert secret not in recorded
    assert journey.gateway.ledger.counts(USER, journey.clock.now).account_day == 1

    plan = journey.post(chat["chatId"], "confirm", {"proposalVersion": 1}).json()
    assert plan["planner"] == {"source": "teaching_agent", "model": MODEL_ID}


def test_a_failed_ledger_write_never_fails_the_learners_turn(
    usage_database: UsageDatabase,
) -> None:
    usage_database.fail = RuntimeError(f"cannot connect to {DSN}")
    journey = build_supabase_journey(
        usage_database,
        fake=FakeOpenRouter(),
        QATRA_CHAT_MODEL_FOR_LEARNERS=True,
        **MODEL_SETTINGS,
    )
    chat = journey.create_chat(goal=FREE_GOAL)
    assert chat["modelTurnsLeft"] == 5 and chat["status"] == "open"
    counts = journey.gateway.ledger.counts(USER, journey.clock.now)
    assert (counts.global_day, counts.account_day) == (1, 1)  # still counted for the caps


def test_the_default_setting_makes_no_provider_call_in_supabase_mode(
    usage_database: UsageDatabase,
) -> None:
    fake = FakeOpenRouter()
    journey = build_supabase_journey(usage_database, fake=fake, **MODEL_SETTINGS)
    chat = journey.create_chat(goal=FREE_GOAL)
    turn = journey.post(chat["chatId"], "messages", {"text": "make the days shorter"})
    assert turn.status_code == 200 and turn.json()["modelTurnsLeft"] == 0
    assert fake.requests == [] and usage_database.connects == []
    assert "fallback" not in {m["kind"] for m in turn.json()["messages"]}


def test_a_revision_sends_the_anonymized_learning_record_of_the_real_repositories(
    usage_database: UsageDatabase,
) -> None:
    fake = FakeOpenRouter()
    journey = build_supabase_journey(
        usage_database, fake=fake, QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS
    )
    first = journey.create_chat()
    plan = journey.post(first["chatId"], "confirm", {"proposalVersion": 1}).json()
    passage = QURAN["passages"][0]
    question = next(q for q in QURAN["questions"] if q["passageId"] == passage["id"])
    tables = journey.project.bank.tables
    tables["target_mastery"].append(
        {
            "user_id": str(USER),
            "plan_id": plan["planId"],
            "edition_id": str(QURAN_EDITION),
            "passage_id": passage["id"],
            "status": "learning",
            "consecutive_correct": 1,
            "review_stage": 0,
            "maintenance_stage": 0,
            "lapse_count": 0,
            "error_part_ids": [passage["parts"][0]["id"]],
        }
    )
    tables["attempts"].append(
        {
            "id": "99999999-9999-4999-8999-000000000001",
            "user_id": str(USER),
            "session_id": "88888888-8888-4888-8888-000000000001",
            "edition_id": str(QURAN_EDITION),
            "client_event_id": "77777777-7777-4777-8777-000000000001",
            "question_id": question["id"],
            "passage_id": passage["id"],
            "correct": False,
            "assisted": False,
            "duration_ms": 1500,
            "occurred_at": "2026-10-05T06:00:00+00:00",
            "created_at": "2026-10-05T06:00:01+00:00",
            "error_kind": "wrong_word",
            "wrong_token_ref": None,
            "review_round_id": None,
        }
    )
    revision = journey.create_chat(goal=FREE_GOAL, planId=plan["planId"])
    assert revision["planId"] == plan["planId"]
    (request,) = fake.completions
    payload = json.loads(json.loads(request.content)["messages"][1]["content"])
    record = payload["learningRecord"]
    assert set(record) == {"passages", "errorParts", "dailyTime", "attempts"}
    assert record["passages"] == [
        {"reference": passage["reference"], "state": "learning", "reviewOutcomes": []}
    ]
    assert record["errorParts"] == [
        {"reference": f"{passage['reference']} (part 1)", "errorCount": 1}
    ]
    assert record["dailyTime"] == []  # no daily progress was seeded
    assert record["attempts"] == [
        {
            "questionType": question["type"],
            "reference": passage["reference"],
            "correct": False,
            "assisted": False,
            "errorKind": "wrong_word",
            "date": "2026-10-05",
        }
    ]
    wire = fake.wire()
    for secret in (str(USER), TOKEN, plan["planId"], revision["chatId"]):
        assert secret not in wire
