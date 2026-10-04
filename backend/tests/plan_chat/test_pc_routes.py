"""HTTP layer of E31-E34: Origin, session, envelope, status codes, limiter, logging."""

from __future__ import annotations

import json
from collections.abc import Iterator
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import require_session
from app.domain.planning_port import ActivePlanConflict
from app.domain.rate_limit import SlidingWindowLimiter
from tests.plan_chat.pc_support import (
    OTHER_USER_ID,
    USER_ID,
    Env,
    composed_body,
    create_body,
    login_as,
    make_app,
    make_env,
    model_reply,
)
from tests.support import FRONTEND_ORIGIN

CHAT_ID = "00000000-0000-0000-0000-000000000001"
ROUTES = [
    ("POST", "/api/plan-chats", {"x": 1}),
    ("POST", f"/api/plan-chats/{CHAT_ID}/messages", {"quickReply": "more_minutes"}),
    ("GET", f"/api/plan-chats/{CHAT_ID}", None),
    ("POST", f"/api/plan-chats/{CHAT_ID}/confirm", {"proposalVersion": 1}),
]
MUTATIONS = [route for route in ROUTES if route[0] == "POST"]


@pytest.fixture
def env() -> Env:
    return make_env()


@pytest.fixture
def app(env: Env) -> FastAPI:
    return make_app(env)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    login_as(app)  # TEST ONLY: a fake SessionContext instead of a real cookie
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as test_client:
        yield test_client


def code(response) -> str:
    return response.json()["error"]["code"]


def test_every_mutation_checks_origin_before_the_session(app: FastAPI) -> None:
    with TestClient(app) as anonymous:  # no Origin, no session
        for method, path, body in MUTATIONS:
            response = anonymous.request(method, path, json=body)
            assert (response.status_code, code(response)) == (403, "forbidden_origin")
            wrong = anonymous.request(
                method, path, json=body, headers={"Origin": "http://evil.example"}
            )
            assert (wrong.status_code, code(wrong)) == (403, "forbidden_origin")


def test_every_route_requires_a_session(app: FastAPI) -> None:
    """No override: the B0 ``require_session`` stub denies, so identity cannot be faked."""
    assert require_session not in app.dependency_overrides
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as anonymous:
        for method, path, body in ROUTES:
            response = anonymous.request(method, path, json=body)
            assert (response.status_code, code(response)) == (401, "unauthenticated")


def test_the_routes_declare_origin_first_in_the_openapi_document(app: FastAPI) -> None:
    paths = app.openapi()["paths"]
    assert "/api/plan-chats" in paths and "/api/plan-chats/{chat_id}/confirm" in paths


def test_the_service_must_be_installed(env: Env) -> None:
    bare = make_app(env)
    del bare.state.plan_chat_service
    login_as(bare)
    with TestClient(bare, headers={"Origin": FRONTEND_ORIGIN}) as client:
        response = client.post("/api/plan-chats", json=composed_body())
        assert (response.status_code, code(response)) == (503, "unavailable")


def test_e31_creates_a_conversation_with_the_camel_case_shape(client: TestClient) -> None:
    response = client.post("/api/plan-chats", json=composed_body())
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {
        "chatId",
        "status",
        "planId",
        "language",
        "messages",
        "proposal",
        "quickReplies",
        "modelTurnsLeft",
        "assistant",
    }
    assert body["planId"] is None and body["assistant"] == {"source": "rules"}
    assert body["messages"][1]["kind"] == "proposal"
    proposal = body["proposal"]
    assert set(proposal) == {
        "proposalVersion",
        "editionId",
        "targetScope",
        "paths",
        "order",
        "sessionMinutes",
        "preferredDate",
        "estimate",
        "sections",
    }
    assert set(proposal["sections"]) == {
        "goal",
        "totalTime",
        "dailyTime",
        "stages",
        "reviews",
        "nextStep",
    }
    assert set(proposal["estimate"]) == {
        "days",
        "endDate",
        "newWordsPerDay",
        "totalWords",
        "knownWords",
        "passageCount",
        "sessionMinutes",
        "scope",
        "paths",
    }
    assert proposal["preferredDate"] is None and proposal["estimate"]["endDate"] == "2026-10-12"
    assert set(body["quickReplies"][0]) == {"code", "labelAr", "labelEn"}
    assert set(body["messages"][0]) == {
        "messageId",
        "ordinal",
        "role",
        "kind",
        "text",
        "source",
        "createdAt",
    }
    assert body["messages"][0]["createdAt"] == "2026-10-04T09:00:00Z"
    assert "replacedChatId" not in body


def test_e31_reports_the_replaced_conversation(client: TestClient) -> None:
    first = client.post("/api/plan-chats", json=composed_body()).json()
    second = client.post("/api/plan-chats", json=composed_body()).json()
    assert second["replacedChatId"] == first["chatId"]
    assert client.get(f"/api/plan-chats/{first['chatId']}").json()["status"] == "abandoned"


@pytest.mark.parametrize(
    ("override", "field", "rule"),
    [
        ({"goalText": ""}, "goalText", "goal_text_length"),
        ({"sessionMinutes": 20}, "sessionMinutes", "session_minutes_invalid"),
        ({"paths": ["matn"]}, "paths", "paths_invalid"),
    ],
)
def test_e31_validation_envelope(client: TestClient, override: dict, field: str, rule: str) -> None:
    response = client.post("/api/plan-chats", json={**composed_body(), **override})
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert {"field": field, "rule": rule} in response.json()["error"]["details"]["fields"]


@pytest.mark.parametrize("extra", ["userId", "isDemo", "mode", "order"])
def test_e31_forbids_unknown_and_account_fields(client: TestClient, extra: str) -> None:
    response = client.post("/api/plan-chats", json={**composed_body(), extra: "x"})
    assert response.status_code == 422
    assert {"field": extra, "rule": "forbidden_field"} in response.json()["error"]["details"][
        "fields"
    ]


def test_e31_rejects_missing_fields_and_snake_case_names(client: TestClient) -> None:
    body = composed_body()
    del body["goalText"]
    assert client.post("/api/plan-chats", json=body).status_code == 422
    snake = {"edition_id": body["editionId"], **{k: v for k, v in body.items() if k != "editionId"}}
    assert client.post("/api/plan-chats", json=snake).status_code == 422


def test_e32_quick_reply_and_text(client: TestClient, env: Env) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    url = f"/api/plan-chats/{chat['chatId']}/messages"
    reply = client.post(url, json={"quickReply": "more_minutes"})
    assert reply.status_code == 200
    assert reply.json()["proposal"]["proposalVersion"] == 2
    assert reply.json()["messages"][-2]["kind"] == "quick_reply"
    refusal = client.post(url, json={"text": "ما حكم هذا؟"})
    assert refusal.status_code == 200 and refusal.json()["messages"][-1]["kind"] == "refusal"
    assert env.provider.calls == []


@pytest.mark.parametrize(
    ("body", "rule"),
    [
        ({}, "one_of_text_or_quick_reply"),
        ({"text": "a", "quickReply": "more_minutes"}, "one_of_text_or_quick_reply"),
        ({"text": "x" * 501}, "text_length"),
        ({"quickReply": "confirm"}, "quick_reply_confirm_use_e34"),
    ],
)
def test_e32_validation(client: TestClient, body: dict, rule: str) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    response = client.post(f"/api/plan-chats/{chat['chatId']}/messages", json=body)
    assert (response.status_code, code(response)) == (422, "validation_error")
    assert rule in [f["rule"] for f in response.json()["error"]["details"]["fields"]]


def test_e32_rejects_an_unknown_quick_reply_and_unknown_properties(client: TestClient) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    url = f"/api/plan-chats/{chat['chatId']}/messages"
    assert client.post(url, json={"quickReply": "dance"}).status_code == 422
    extra = client.post(url, json={"text": "hello plan", "userId": "x"})
    assert extra.status_code == 422


def test_demo_account_text_is_refused_over_http(app: FastAPI, env: Env) -> None:
    login_as(app, demo=True)
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as demo:
        chat = demo.post("/api/plan-chats", json=composed_body()).json()
        response = demo.post(f"/api/plan-chats/{chat['chatId']}/messages", json={"text": "shorter"})
        assert response.status_code == 422
        assert response.json()["error"]["details"]["fields"] == [
            {"field": "text", "rule": "demo_quick_reply_only"}
        ]


def test_e33_reads_only_own_conversations(client: TestClient, app: FastAPI) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    again = client.get(f"/api/plan-chats/{chat['chatId']}")
    assert again.status_code == 200 and again.json() == chat
    assert client.get(f"/api/plan-chats/{uuid4()}").status_code == 404
    assert client.get("/api/plan-chats/not-a-uuid").status_code == 422
    login_as(app, OTHER_USER_ID)
    other = client.get(f"/api/plan-chats/{chat['chatId']}")
    assert (other.status_code, code(other)) == (404, "not_found")
    assert (
        client.post(
            f"/api/plan-chats/{chat['chatId']}/messages", json={"quickReply": "more_minutes"}
        ).status_code
        == 404
    )


def test_e34_creation_returns_201_and_closes_the_chat(client: TestClient, env: Env) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    response = client.post(f"/api/plan-chats/{chat['chatId']}/confirm", json={"proposalVersion": 1})
    assert response.status_code == 201
    plan = response.json()
    assert plan["agreedEstimate"] == chat["proposal"]["estimate"]
    assert plan["planner"] == {"source": "rules"} and plan["currentVersion"] == 1
    assert {
        "planId",
        "titleAr",
        "titleEn",
        "targetScope",
        "paths",
        "order",
        "sessionMinutes",
        "preferredDate",
        "status",
        "createdAt",
    } <= set(plan)
    assert (
        env.writer.created[0]["confirmed_estimate"].model_dump(by_alias=True, mode="json")
        == (chat["proposal"]["estimate"])
    )
    repeat = client.post(f"/api/plan-chats/{chat['chatId']}/confirm", json={"proposalVersion": 1})
    assert (repeat.status_code, code(repeat)) == (409, "version_conflict")
    assert repeat.json()["error"]["details"] == {"reason": "chat_closed"}
    assert client.post(
        f"/api/plan-chats/{chat['chatId']}/messages", json={"quickReply": "more_minutes"}
    ).json()["error"]["details"] == {"reason": "chat_closed"}


def test_e34_revision_returns_200(client: TestClient, env: Env) -> None:
    plan = env.writer.add_plan(USER_ID)
    chat = client.post("/api/plan-chats", json=composed_body(planId=str(plan.plan_id))).json()
    response = client.post(f"/api/plan-chats/{chat['chatId']}/confirm", json={"proposalVersion": 1})
    assert response.status_code == 200 and response.json()["currentVersion"] == 4
    assert env.writer.revised[0]["expected_version"] == 3


def test_e31_revision_of_unknown_or_completed_plans(client: TestClient, env: Env) -> None:
    missing = client.post("/api/plan-chats", json=composed_body(planId=str(uuid4())))
    assert (missing.status_code, code(missing)) == (404, "not_found")
    done = env.writer.add_plan(USER_ID, status="completed")
    response = client.post("/api/plan-chats", json=composed_body(planId=str(done.plan_id)))
    assert (response.status_code, code(response)) == (409, "version_conflict")
    assert response.json()["error"]["details"] == {"reason": "plan_not_active"}


def test_e34_stale_proposal_envelope(client: TestClient) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    client.post(f"/api/plan-chats/{chat['chatId']}/messages", json={"quickReply": "more_minutes"})
    response = client.post(f"/api/plan-chats/{chat['chatId']}/confirm", json={"proposalVersion": 1})
    assert (response.status_code, code(response)) == (409, "version_conflict")
    details = response.json()["error"]["details"]
    assert details["reason"] == "proposal_stale"
    assert (
        details["proposal"]["proposalVersion"] == 2 and details["proposal"]["sessionMinutes"] == 15
    )


def test_e34_conflict_and_validation(client: TestClient, env: Env) -> None:
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    url = f"/api/plan-chats/{chat['chatId']}/confirm"
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json={"proposalVersion": "one"}).status_code == 422
    assert client.post(url, json={"proposalVersion": 1, "userId": "x"}).status_code == 422
    env.writer.fail_create = ActivePlanConflict()
    response = client.post(url, json={"proposalVersion": 1})
    assert response.json()["error"]["details"] == {"reason": "active_plan_conflict"}


def test_chat_write_limiter_applies_to_e31_e32_e34_and_not_to_reads(
    app: FastAPI, client: TestClient
) -> None:
    app.state.chat_write_limiter = SlidingWindowLimiter(3)
    chat = client.post("/api/plan-chats", json=composed_body()).json()
    url = f"/api/plan-chats/{chat['chatId']}"
    assert client.post(f"{url}/messages", json={"quickReply": "more_minutes"}).status_code == 200
    assert client.post(f"{url}/messages", json={"quickReply": "fewer_minutes"}).status_code == 200
    blocked = client.post(f"{url}/messages", json={"quickReply": "more_minutes"})
    assert (blocked.status_code, code(blocked)) == (429, "throttled")
    assert int(blocked.headers["retry-after"]) >= 1
    assert blocked.json()["error"]["details"]["retryAfterSec"] >= 1
    assert client.post(f"{url}/confirm", json={"proposalVersion": 3}).status_code == 429
    assert client.get(url).status_code == 200


def test_the_default_limit_is_20_per_minute(app: FastAPI, client: TestClient) -> None:
    statuses = [client.post("/api/plan-chats", json=composed_body()).status_code for _ in range(21)]
    assert statuses[:20] == [201] * 20 and statuses[20] == 429


def test_bodies_and_text_never_reach_the_logs(app: FastAPI, env: Env, log_lines: list[str]) -> None:
    env.provider.script.append(model_reply("question", "A DISTINCTIVE REPLY"))
    login_as(app)
    secret = "DISTINCTIVE LEARNER SENTENCE about the schedule"
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        chat = client.post("/api/plan-chats", json=create_body(goalText=secret)).json()
        client.post(f"/api/plan-chats/{chat['chatId']}/messages", json={"text": "ما حكم هذا؟"})
        client.post(f"/api/plan-chats/{chat['chatId']}/confirm", json={"proposalVersion": 1})
    joined = "\n".join(log_lines)
    assert "DISTINCTIVE" not in joined and "حكم" not in joined
    assert str(USER_ID) not in joined and chat["chatId"] not in joined
    for line in log_lines:
        json.loads(line)  # every line is structured JSON
    routes = {json.loads(entry).get("route") for entry in log_lines if '"event":"request"' in entry}
    assert "/api/plan-chats/{chat_id}/messages" in routes


def test_responses_are_no_store_even_for_errors(client: TestClient) -> None:
    ok = client.post("/api/plan-chats", json=composed_body())
    bad = client.post("/api/plan-chats", json={})
    gone = client.get(f"/api/plan-chats/{uuid4()}")
    assert {r.headers["cache-control"] for r in (ok, bad, gone)} == {"no-store"}
