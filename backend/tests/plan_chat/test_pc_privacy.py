"""R27 / NFR-17: what may leave the server, and what the usage ledger may hold."""

from __future__ import annotations

import dataclasses
import json
from datetime import timedelta

import httpx

from app.contracts_plan_chat import CreatePlanChatRequest, SendMessageRequest
from app.domain import plan_chat_policy as policy
from app.providers.llm import ModelContext
from app.providers.openrouter import OpenRouterProvider
from app.repositories.ai_usage import UsageRecord
from app.services.plan_chat import build_plan_chat_service
from tests.plan_chat import pc_support as support
from tests.plan_chat.pc_support import (
    PLACEMENT_ID,
    USER_ID,
    composed_body,
    create_body,
    ctx,
    make_env,
    model_reply,
)
from tests.support import make_settings

FORBIDDEN_NAMES = {
    "userId",
    "user_id",
    "username",
    "ip",
    "ipAddress",
    "device",
    "deviceId",
    "cookie",
    "sessionId",
    "session",
    "registeredAt",
    "createdAt",
    "chatId",
    "planId",
    "isDemo",
    "placementSessionId",
    "authEpoch",
    "email",
}
LEARNING_KEYS = {"passages", "errorParts", "dailyTime", "attempts"}


def create(env, body=None, **kwargs):
    return env.service.create_conversation(
        ctx(**kwargs), CreatePlanChatRequest.model_validate(body or composed_body())
    )


def say(env, chat, text):
    return env.service.send_message(
        ctx(), chat.chat_id, SendMessageRequest.model_validate({"text": text})
    )


def all_keys(node, found=None):
    found = set() if found is None else found
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            all_keys(value, found)
    elif isinstance(node, list):
        for item in node:
            all_keys(item, found)
    return found


def test_creation_payload_has_only_allowed_fields_and_no_learning_record() -> None:
    env = make_env(model_reply("question", "ok"))
    chat = create(
        env,
        create_body(
            goalText="a free text goal about my plan", placementSessionId=str(PLACEMENT_ID)
        ),
    )
    (payload,) = env.provider.calls
    assert policy.find_disallowed_keys(payload) == []
    assert all_keys(payload) & FORBIDDEN_NAMES == set()
    assert "learningRecord" not in payload
    assert set(payload) == {
        "conversationId",
        "language",
        "edition",
        "parameters",
        "estimate",
        "placement",
        "messages",
        "limits",
    }
    assert payload["placement"] == {
        "knownWords": 20,
        "passageCount": payload["estimate"]["passageCount"],
    }
    text = json.dumps(payload, ensure_ascii=False)
    for secret in (str(USER_ID), str(chat.chat_id), str(PLACEMENT_ID)):
        assert secret not in text
    assert payload["conversationId"] != str(chat.chat_id)
    assert payload["messages"] == [{"role": "learner", "text": "a free text goal about my plan"}]
    assert {s["ordinal"] for s in payload["edition"]["sections"]} == set(range(78, 115))


def test_revision_payload_adds_exactly_the_learning_fields_trimmed() -> None:
    env = make_env(model_reply("question", "ok"))
    plan = env.writer.add_plan(USER_ID)
    chat = create(env, composed_body(planId=str(plan.plan_id)))
    say(env, chat, "how is the schedule looking?")
    (payload,) = env.provider.calls
    record = payload["learningRecord"]
    assert set(record) == LEARNING_KEYS
    assert len(record["dailyTime"]) == 30 and len(record["attempts"]) == 50
    dates = [item["date"] for item in record["dailyTime"]]
    assert dates == sorted(dates) and dates[-1] == "2026-09-14"  # the most recent 30 of 45 days
    assert set(record["passages"][0]) == {"reference", "state", "reviewOutcomes"}
    assert set(record["attempts"][0]) == {
        "questionType",
        "reference",
        "correct",
        "assisted",
        "errorKind",
        "date",
    }
    assert policy.find_disallowed_keys(payload) == []
    text = json.dumps(payload)
    for secret in (str(USER_ID), str(chat.chat_id), str(plan.plan_id)):
        assert secret not in text
    assert env.learning.calls == [(USER_ID, plan.plan_id, False)]


def test_an_unexpected_field_in_the_payload_blocks_the_call(monkeypatch) -> None:
    env = make_env(model_reply("question", "ok"))
    chat = create(env)
    original = ModelContext.to_payload

    def leaky(self):
        payload = original(self)
        payload["userId"] = str(USER_ID)
        return payload

    monkeypatch.setattr(ModelContext, "to_payload", leaky)
    result = say(env, chat, "how is the schedule looking?")
    assert env.provider.calls == [] and env.ledger.rows == []
    assert result.messages[-1].kind == "fallback"


def test_the_real_provider_sends_only_the_allowed_payload_over_http() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            data = [
                {
                    "id": "free/a:free",
                    "pricing": {"prompt": "0", "completion": "0"},
                    "supported_parameters": ["response_format"],
                }
            ]
            return httpx.Response(200, json={"data": data})
        seen.append(request)
        content = json.dumps({"intent": "question", "reply": "Fine."})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}}],
                "usage": {"prompt_tokens": 9, "completion_tokens": 3},
            },
        )

    settings = make_settings(
        OPENROUTER_API_KEY="dummy-key",
        OPENROUTER_MODELS="free/a:free",
        QATRA_CHAT_MODEL_FOR_LEARNERS=True,
    )
    provider = OpenRouterProvider(settings, httpx.MockTransport(handler))
    base = make_env()
    service = build_plan_chat_service(
        settings,
        planning=base.planning,
        writer=base.writer,
        learning=base.learning,
        repository=base.repo,
        ledger=base.ledger,
        provider=provider,
        clock=base.clock,
    )
    chat = service.create_conversation(
        ctx(),
        CreatePlanChatRequest.model_validate(create_body(goalText="a free text goal for the plan")),
    )
    (request,) = seen
    body = json.loads(request.content)
    context = json.loads(body["messages"][1]["content"])
    assert policy.find_disallowed_keys(context) == []
    assert all_keys(context) & FORBIDDEN_NAMES == set()
    wire = request.content.decode()
    for secret in (str(USER_ID), str(chat.chat_id), "127.0.0.1", "testclient"):
        assert secret not in wire
    sent_headers = {k.lower() for k in request.headers}
    assert "cookie" not in sent_headers and "x-forwarded-for" not in sent_headers
    assert chat.assistant.source == "model"
    (row,) = base.ledger.rows
    assert (row.model, row.input_tokens, row.output_tokens) == ("free/a:free", 9, 3)


def test_contact_details_in_learner_text_never_reach_the_wire() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            data = [
                {
                    "id": "free/a:free",
                    "pricing": {"prompt": "0", "completion": "0"},
                    "supported_parameters": ["response_format"],
                }
            ]
            return httpx.Response(200, json={"data": data})
        seen.append(request)
        content = json.dumps({"intent": "question", "reply": "Fine."})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}}],
                "usage": {"prompt_tokens": 9, "completion_tokens": 3},
            },
        )

    settings = make_settings(
        OPENROUTER_API_KEY="dummy-key",
        OPENROUTER_MODELS="free/a:free",
        QATRA_CHAT_MODEL_FOR_LEARNERS=True,
    )
    provider = OpenRouterProvider(settings, httpx.MockTransport(handler))
    base = make_env()
    service = build_plan_chat_service(
        settings,
        planning=base.planning,
        writer=base.writer,
        learning=base.learning,
        repository=base.repo,
        ledger=base.ledger,
        provider=provider,
        clock=base.clock,
    )
    email, phone, link = "learner.name@example.com", "+971 50 123 4567", "https://example.org/me"
    goal = f"I want a calm plan, mail {email} or call {phone} or see {link} thanks"
    chat = service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(create_body(goalText=goal))
    )
    (request,) = seen
    wire = request.content.decode()
    for private in (email, phone, link, "learner.name", "123 4567", "example.org"):
        assert private not in wire
    assert "[redacted]" in wire
    stored = base.repo.get(USER_ID, chat.chat_id)
    assert stored is not None
    assert any(email in m.text for m in stored.messages)  # stored text is unchanged


def test_ai_usage_rows_hold_no_text_and_no_account() -> None:
    goal = "a very distinctive goal sentence about the schedule"
    env = make_env(model_reply("question", "A distinctive reply."))
    create(env, create_body(goalText=goal))
    (row,) = env.ledger.rows
    names = {f.name for f in dataclasses.fields(UsageRecord)}
    assert names == {
        "provider",
        "model",
        "prompt_version",
        "status",
        "created_at",
        "input_tokens",
        "output_tokens",
        "cost_usd",
        "quota_record",
    }
    dump = repr(row)
    assert "distinctive" not in dump and str(USER_ID) not in dump
    assert row.prompt_version == "plan-chat-v2" and row.cost_usd is None


def test_stored_messages_never_keep_raw_model_output() -> None:
    env = make_env(model_reply("set_parameters", "Done.", sessionMinutes=5))
    chat = create(env, create_body(goalText="a free text goal about the plan"))
    for record in env.repo.get(USER_ID, chat.chat_id).messages:
        blob = json.dumps(record.payload or {})
        assert "intent" not in blob and "reply" not in blob
    # Messages may not exceed the column check.
    assert all(len(m.text) <= 2000 for m in env.repo.get(USER_ID, chat.chat_id).messages)


def test_the_model_is_not_asked_about_a_day_that_has_not_moved() -> None:
    env = make_env(model_reply("question", "ok"))
    chat = create(env, create_body(goalText="a free text goal about the plan"))
    env.clock.now += timedelta(seconds=1)
    assert chat.model_turns_left == 5
    assert support.TODAY.isoformat() == "2026-10-04"
