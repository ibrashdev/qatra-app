"""E31-E34 end to end on the production wiring in memory mode, with the real session.

An account registers through E03 and its cookie identifies it: nothing here overrides
``require_session``. The provider is a mocked OpenRouter (``httpx.MockTransport``); no test calls a
live provider.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.dependencies import SessionContext
from app.repositories.ai_usage import InMemoryUsageLedger
from app.repositories.plan_chats import InMemoryPlanChatRepository
from app.services.plan_chat import PlanChatGateway
from tests.auth.auth_support import PASSWORD, USERNAME
from tests.plan_chat.pc_e2e_support import (
    FREE_GOAL,
    MODEL_ID,
    FakeOpenRouter,
    Journey,
    build_journey,
    with_model,
)
from tests.sessions.ss_support import HADITH_EDITION

SECOND_USERNAME = "second_user"
MODEL_SETTINGS = {
    "OPENROUTER_API_KEY": "dummy-key-for-tests",
    "OPENROUTER_MODELS": MODEL_ID,
}


def code(response: Any) -> str:
    return str(response.json()["error"]["code"])


def post(client: TestClient, chat_id: str, tail: str, body: dict[str, Any]) -> Any:
    return client.post(f"/api/plan-chats/{chat_id}/{tail}", json=body)


def stored_plan(journey: Journey, plan_id: str) -> Any:
    context = SessionContext(user_id=journey.user_id(), is_demo=False, auth_epoch=1)
    plan = journey.app.state.plan_service.read_plan(context, UUID(plan_id))
    assert plan is not None
    return plan


def test_create_app_installs_the_conversation_for_the_memory_backend() -> None:
    journey = build_journey(signed_in=False)
    gateway = journey.gateway
    assert isinstance(gateway, PlanChatGateway)
    assert isinstance(gateway.ledger, InMemoryUsageLedger)
    assert gateway.provider is None  # no key and no model configured: every turn is a rules turn


def test_the_rules_journey_from_first_turn_to_confirmation() -> None:
    journey = build_journey()
    client = journey.client
    chat = journey.create_chat()
    assert chat["status"] == "open" and chat["planId"] is None
    assert [m["kind"] for m in chat["messages"]] == ["text", "proposal"]
    assert chat["messages"][0]["role"] == "learner" and chat["messages"][1]["source"] == "rules"
    assert chat["proposal"]["proposalVersion"] == 1 and chat["assistant"] == {"source": "rules"}

    codes = [q["code"] for q in chat["quickReplies"]]
    assert "more_minutes" in codes and "confirm" in codes
    turn = post(client, chat["chatId"], "messages", {"quickReply": "more_minutes"})
    assert turn.status_code == 200
    updated = turn.json()
    assert updated["proposal"]["proposalVersion"] == 2
    assert updated["proposal"]["sessionMinutes"] == 10
    assert [m["ordinal"] for m in updated["messages"]] == [1, 2, 3, 4]

    assert client.get(f"/api/plan-chats/{chat['chatId']}").json() == updated

    confirmed = post(client, chat["chatId"], "confirm", {"proposalVersion": 2})
    assert confirmed.status_code == 201
    plan = confirmed.json()
    assert plan["agreedEstimate"] == updated["proposal"]["estimate"]
    assert plan["planner"] == {"source": "rules"} and plan["status"] == "active"
    assert plan["currentVersion"] == 1 and plan["sessionMinutes"] == 10
    row = stored_plan(journey, plan["planId"])
    assert row.target_scope == (1, 2, 3) and row.paths == ("quran",)

    closed = client.get(f"/api/plan-chats/{chat['chatId']}").json()
    assert closed["status"] == "confirmed" and closed["quickReplies"] == []
    again = post(client, chat["chatId"], "confirm", {"proposalVersion": 2})
    assert (again.status_code, code(again)) == (409, "version_conflict")
    assert again.json()["error"]["details"] == {"reason": "chat_closed"}
    late = post(client, chat["chatId"], "messages", {"quickReply": "fewer_minutes"})
    assert late.json()["error"]["details"] == {"reason": "chat_closed"}


def test_a_revision_conversation_revises_the_plan_through_e17_semantics() -> None:
    journey = build_journey()
    client = journey.client
    first = journey.create_chat()
    plan = post(client, first["chatId"], "confirm", {"proposalVersion": 1}).json()

    revision = journey.create_chat(planId=plan["planId"], sessionMinutes=10)
    assert revision["planId"] == plan["planId"]
    assert revision["proposal"]["sessionMinutes"] == 10
    done = post(client, revision["chatId"], "confirm", {"proposalVersion": 1})
    assert done.status_code == 200  # a revision answers 200, a creation 201
    revised = done.json()
    assert revised["planId"] == plan["planId"] and revised["currentVersion"] == 2
    assert revised["sessionMinutes"] == 10 and revised["status"] == "active"
    assert stored_plan(journey, plan["planId"]).current_version == 2
    plans = journey.app.state.plan_service._plans.plans_of(journey.user_id())
    assert len(plans) == 1  # one plan, two versions


def test_a_hadith_plan_chooses_its_paths_in_the_conversation() -> None:
    journey = build_journey()
    client = journey.client
    chat = journey.create_chat(
        editionId=str(HADITH_EDITION), targetScope={"sectionOrdinals": [1, 2]}, paths=["matn"]
    )
    assert chat["proposal"]["paths"] == ["matn"]
    assert {"paths_all", "confirm"} <= {q["code"] for q in chat["quickReplies"]}
    wider = post(client, chat["chatId"], "messages", {"quickReply": "paths_all"}).json()
    assert wider["proposal"]["paths"] == ["matn", "sanad", "grade"]
    assert wider["proposal"]["estimate"]["totalWords"] > chat["proposal"]["estimate"]["totalWords"]
    plan = post(client, chat["chatId"], "confirm", {"proposalVersion": 2})
    assert plan.status_code == 201
    assert plan.json()["paths"] == ["matn", "sanad", "grade"]
    assert stored_plan(journey, plan.json()["planId"]).paths == ("matn", "sanad", "grade")


def test_a_new_conversation_replaces_the_open_one() -> None:
    journey = build_journey()
    first = journey.create_chat()
    second = journey.create_chat()
    assert second["replacedChatId"] == first["chatId"]
    old = journey.client.get(f"/api/plan-chats/{first['chatId']}").json()
    assert old["status"] == "abandoned"
    late = post(journey.client, first["chatId"], "messages", {"quickReply": "more_minutes"})
    assert late.json()["error"]["details"] == {"reason": "chat_closed"}


def test_another_account_cannot_read_write_or_confirm_a_conversation() -> None:
    journey = build_journey()
    chat = journey.create_chat()
    other = journey.other_browser(SECOND_USERNAME)
    assert journey.user_id(SECOND_USERNAME) != journey.user_id()
    path = f"/api/plan-chats/{chat['chatId']}"
    assert other.get(path).status_code == 404
    assert (
        post(other, chat["chatId"], "messages", {"quickReply": "more_minutes"}).status_code == 404
    )
    assert post(other, chat["chatId"], "confirm", {"proposalVersion": 1}).status_code == 404
    mine = journey.client.get(path).json()
    assert mine["status"] == "open" and len(mine["messages"]) == 2  # untouched


def test_another_accounts_plan_and_placement_session_cannot_be_used() -> None:
    journey = build_journey()
    first = journey.create_chat()
    plan = post(journey.client, first["chatId"], "confirm", {"proposalVersion": 1}).json()
    other = journey.other_browser(SECOND_USERNAME)
    revision = other.post("/api/plan-chats", json=journey.body(planId=plan["planId"]))
    assert (revision.status_code, code(revision)) == (404, "not_found")
    unknown = str(UUID(int=12345))
    placement = other.post("/api/plan-chats", json=journey.body(placementSessionId=unknown))
    assert (placement.status_code, code(placement)) == (404, "not_found")
    assert journey.client.get(f"/api/plan-chats/{first['chatId']}").json()["status"] == "confirmed"


def test_the_second_account_has_its_own_open_conversation() -> None:
    journey = build_journey()
    mine = journey.create_chat()
    other = journey.other_browser(SECOND_USERNAME)
    theirs = journey.create_chat(other)
    assert "replacedChatId" not in theirs and theirs["chatId"] != mine["chatId"]
    assert journey.client.get(f"/api/plan-chats/{mine['chatId']}").json()["status"] == "open"


def test_a_preferred_date_that_has_passed_is_a_validation_error_at_confirmation() -> None:
    journey = build_journey()
    today = (journey.clock.now + timedelta(hours=4)).date()  # the account zone is Asia/Dubai
    chat = journey.create_chat(preferredDate=(today + timedelta(days=1)).isoformat())
    journey.clock.now += timedelta(days=3)
    response = post(journey.client, chat["chatId"], "confirm", {"proposalVersion": 1})
    assert (response.status_code, code(response)) == (422, "validation_error")
    fields = response.json()["error"]["details"]["fields"]
    assert fields == [{"field": "preferredDate", "rule": "date_invalid"}]
    assert journey.client.get(f"/api/plan-chats/{chat['chatId']}").json()["status"] == "open"


def test_the_session_read_class_limits_e33() -> None:
    journey = build_journey(QATRA_RATE_SESSION_READ_PER_MIN=2)
    chat = journey.create_chat()
    statuses = [
        journey.client.get(f"/api/plan-chats/{chat['chatId']}").status_code for _ in range(3)
    ]
    assert statuses == [200, 200, 429]


def test_an_anonymous_visitor_is_denied_before_the_service_is_reached() -> None:
    journey = build_journey(signed_in=False)
    for method, path, body in [
        ("POST", "/api/plan-chats", {}),
        ("GET", "/api/plan-chats/00000000-0000-0000-0000-000000000001", None),
    ]:
        response = journey.client.request(method, path, json=body)
        assert (response.status_code, code(response)) == (401, "unauthenticated")


# --- the model path on the production wiring -----------------------------------------------------


def test_the_model_path_runs_through_the_wired_provider_and_ledger() -> None:
    fake = FakeOpenRouter({"intent": "set_parameters", "parameters": {"sessionMinutes": 10}})
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    chat = journey.create_chat(goal=FREE_GOAL)
    assert len(fake.completions) == 1
    assert chat["assistant"]["source"] == "rules"  # the model gave no usable reply text
    assert chat["proposal"]["sessionMinutes"] == 10  # the model's parameter, validated by rules
    assert chat["modelTurnsLeft"] == 5
    (row,) = journey.gateway.ledger.rows
    assert (row.status, row.model, row.prompt_version) == ("succeeded", MODEL_ID, "plan-chat-v1")
    assert (row.input_tokens, row.output_tokens) == (11, 4)

    plan = post(journey.client, chat["chatId"], "confirm", {"proposalVersion": 1}).json()
    assert plan["planner"] == {"source": "teaching_agent", "model": MODEL_ID}


def test_a_model_failure_falls_back_to_the_rules_reply_without_an_error() -> None:
    class Failing(FakeOpenRouter):
        def handler(self, request):  # type: ignore[no-untyped-def]
            import httpx

            if request.url.path.endswith("/models"):
                return super().handler(request)
            self.completions.append(request)
            return httpx.Response(500, json={"error": "boom"})

    fake = Failing()
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    chat = journey.create_chat(goal=FREE_GOAL)
    assert [m["kind"] for m in chat["messages"]] == ["text", "proposal", "fallback"]
    (row,) = journey.gateway.ledger.rows
    assert row.status == "failed" and row.quota_record == {"reason": "error"}
    assert (
        post(journey.client, chat["chatId"], "confirm", {"proposalVersion": 1}).status_code == 201
    )


def test_with_the_default_setting_a_learner_conversation_makes_no_provider_call() -> None:
    """D76: the code default of QATRA_CHAT_MODEL_FOR_LEARNERS is false, so a real account's
    conversation is rules-only even when a key and a model are configured."""
    fake = FakeOpenRouter()
    journey = with_model(build_journey(**MODEL_SETTINGS), fake)
    assert journey.settings.QATRA_CHAT_MODEL_FOR_LEARNERS is False
    assert journey.gateway.provider is not None and journey.gateway.provider.is_enabled()

    chat = journey.create_chat(goal=FREE_GOAL)
    turn = post(journey.client, chat["chatId"], "messages", {"text": "make the days shorter"})
    assert turn.status_code == 200
    after = turn.json()
    assert after["modelTurnsLeft"] == 0 and after["assistant"] == {"source": "rules"}
    assert fake.requests == []  # not even the models list was fetched
    assert journey.gateway.ledger.rows == []
    kinds = [m["kind"] for m in after["messages"]]
    assert "fallback" not in kinds  # switched off by configuration: no "unavailable" notice
    assert after["proposal"]["proposalVersion"] == 1  # free text is only partly understood

    quick = post(journey.client, chat["chatId"], "messages", {"quickReply": "more_minutes"})
    assert quick.json()["proposal"]["sessionMinutes"] == 10
    assert (
        post(journey.client, chat["chatId"], "confirm", {"proposalVersion": 2}).status_code == 201
    )
    assert fake.requests == []


def test_a_demo_account_with_a_real_session_uses_quick_replies_and_confirms() -> None:
    """D29: no text of a demo account reaches the model, whatever the switch says."""
    fake = FakeOpenRouter()
    journey = with_model(
        build_journey(signed_in=False, QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake
    )
    demo = journey.app.state.auth_service.register_account(
        username="demo_learner",
        password=PASSWORD,
        time_zone="Asia/Dubai",
        language="en",
        terms_accepted=True,
        terms_version=journey.settings.TERMS_VERSION,
        is_demo=True,
    )
    journey.client.cookies.set("qatra_session", demo.cookie_value)
    chat = journey.create_chat(goal=FREE_GOAL)  # free text from a demo account: rules only
    assert [m["kind"] for m in chat["messages"]] == ["text", "proposal"]
    typed = post(journey.client, chat["chatId"], "messages", {"text": "make it shorter"})
    assert (typed.status_code, code(typed)) == (422, "validation_error")
    assert typed.json()["error"]["details"]["fields"] == [
        {"field": "text", "rule": "demo_quick_reply_only"}
    ]
    quick = post(journey.client, chat["chatId"], "messages", {"quickReply": "more_minutes"})
    assert quick.json()["proposal"]["sessionMinutes"] == 10
    confirmed = post(journey.client, chat["chatId"], "confirm", {"proposalVersion": 2})
    assert confirmed.status_code == 201 and confirmed.json()["planner"] == {"source": "rules"}
    assert fake.requests == [] and journey.gateway.ledger.rows == []


def test_the_guard_answers_before_any_provider_call_even_when_the_model_is_on() -> None:
    fake = FakeOpenRouter()
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    chat = journey.create_chat()
    asked = post(
        journey.client, chat["chatId"], "messages", {"text": "what is the ruling on this?"}
    )
    assert asked.json()["messages"][-1]["kind"] == "refusal"
    assert fake.requests == [] and journey.gateway.ledger.rows == []


# --- privacy of the outbound request --------------------------------------------------------------


@pytest.mark.parametrize("revision", [False, True])
def test_the_outbound_model_request_holds_no_account_data(revision: bool) -> None:
    """NFR-17: serialize every request that would reach the provider (URL, headers, body) and
    look for the account, the session and the cookie."""
    fake = FakeOpenRouter()
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    secrets = journey.sensitive_values()
    extra: dict[str, Any] = {}
    if revision:
        plan = post(
            journey.client, journey.create_chat()["chatId"], "confirm", {"proposalVersion": 1}
        )
        extra["planId"] = plan.json()["planId"]
        secrets["plan id"] = plan.json()["planId"]
    chat = journey.create_chat(goal=FREE_GOAL, **extra)
    secrets["chat id"] = chat["chatId"]
    post(journey.client, chat["chatId"], "messages", {"text": "a question about the schedule"})
    assert len(fake.completions) == 2
    wire = fake.wire()
    for name, value in secrets.items():
        assert value not in wire, name
    assert USERNAME not in wire and "testclient" not in wire.lower()
    sent_headers = {key.lower() for request in fake.requests for key in request.headers}
    assert "cookie" not in sent_headers and "x-forwarded-for" not in sent_headers
    assert str(journey.user_id()) not in wire


def test_the_temporary_conversation_id_is_stable_for_one_conversation_and_unrelated_to_it() -> None:
    import json

    fake = FakeOpenRouter()
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    chat = journey.create_chat(goal=FREE_GOAL)
    post(journey.client, chat["chatId"], "messages", {"text": "another question about the days"})
    ids = [
        json.loads(json.loads(r.content)["messages"][1]["content"])["conversationId"]
        for r in fake.completions
    ]
    assert len(ids) == 2 and ids[0] == ids[1]  # E31 and E32 share one temporary id
    assert ids[0] != chat["chatId"] and UUID(ids[0])


def test_no_conversation_text_reaches_the_logs(log_lines: list[str]) -> None:
    fake = FakeOpenRouter({"intent": "question", "reply": "A DISTINCTIVE MODEL REPLY"})
    journey = with_model(build_journey(QATRA_CHAT_MODEL_FOR_LEARNERS=True, **MODEL_SETTINGS), fake)
    secrets = journey.sensitive_values()
    chat = journey.create_chat(goal="DISTINCTIVE LEARNER GOAL about the schedule")
    post(journey.client, chat["chatId"], "messages", {"text": "DISTINCTIVE FOLLOW UP about days"})
    post(journey.client, chat["chatId"], "confirm", {"proposalVersion": 1})
    joined = "\n".join(log_lines)
    assert "DISTINCTIVE" not in joined
    for name, value in secrets.items():
        assert value not in joined, name
    assert chat["chatId"] not in joined


def test_the_repository_of_memory_mode_is_the_in_memory_one() -> None:
    journey = build_journey()
    chat = journey.create_chat()
    repository = journey.gateway.binding(  # the per-request binding of the gateway
        SessionContext(user_id=journey.user_id(), is_demo=False, auth_epoch=1)
    ).repository
    assert isinstance(repository, InMemoryPlanChatRepository)
    assert repository.get(journey.user_id(), UUID(chat["chatId"])) is not None
