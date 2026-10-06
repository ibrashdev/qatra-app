"""Privacy of the demo path (nothing identifying leaves the server or reaches a log or an
``ai_usage`` row), the settings of the package, and how ``create_app`` wires it."""

from __future__ import annotations

import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.domain import demo_policy as policy
from app.main import create_app
from app.routers.demo import install_demo
from tests.demo.demo_support import (
    PASSWORD,
    Env,
    FakeJsonProvider,
    advice_reply,
    build_env,
    real_scenarios,
)
from tests.support import make_settings

PLACEMENT = "33333333-3333-4333-8333-000000000021"


def full_flow(env: Env) -> dict[str, Any]:
    """Register a demo account, read E27 and E29, build two plans (one with a placement)."""
    demo = env.demo("demo_private_name")
    content = env.services.content
    assert content is not None and env.services.placements is not None
    edition = next(e for e in content.editions() if e.edition_key == "quran-hafs-quranenc")
    ids = [row.passage_id for row in content.passages(edition.edition_id)]
    env.services.placements.add_session(
        demo.user_id, UUID(PLACEMENT), edition.edition_id, {ids[0]}, {ids[1]}
    )
    demo.client.get("/api/demo/scenarios")
    demo.client.get("/api/demo/simulations")
    first = demo.client.post("/api/demo/plans", json={"scenarioId": "scenario-05"})
    second = demo.client.post(
        "/api/demo/plans", json={"scenarioId": "scenario-02", "placementSessionId": PLACEMENT}
    )
    assert first.status_code == second.status_code == 201
    return {"demo": demo, "ids": [str(i) for i in ids]}


def test_no_log_line_carries_account_model_or_plan_data(
    tmp_path: Path, log_lines: list[str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    provider = FakeJsonProvider(advice_reply(newWordsPerDay=6))
    env = build_env(tmp_path, provider=provider)
    flow = full_flow(env)
    demo = flow["demo"]
    text = " ".join([*log_lines, *caplog.messages])
    assert "demo_plan_created" in text and "demo_account_created" in text
    forbidden = [
        PASSWORD,
        demo.recovery_code,
        demo.username,
        str(demo.user_id),
        "203.0.113.9",
        PLACEMENT,
        "free-model-x",
        "priorityReviewPassageIds",
        "wordCount",
        "system_prompt",
        *flow["ids"],
    ]
    for entry in real_scenarios()["scenarios"]:
        forbidden += [entry["titleEn"], entry["goalTextEn"]]
    for secret in forbidden:
        assert secret not in text, secret


def test_every_payload_that_leaves_is_on_the_allowlist_and_anonymous(tmp_path: Path) -> None:
    provider = FakeJsonProvider()
    env = build_env(tmp_path, provider=provider)
    flow = full_flow(env)
    demo = flow["demo"]
    assert len(provider.calls) == 2

    def keys(node: Any) -> set[str]:
        found: set[str] = set()
        if isinstance(node, dict):
            found.update(node)
            for value in node.values():
                found |= keys(value)
        elif isinstance(node, list):
            for item in node:
                found |= keys(item)
        return found

    for payload in provider.calls:
        assert keys(payload) <= policy.DEMO_PAYLOAD_KEYS
        dumped = json.dumps(payload)
        for private in (demo.username, str(demo.user_id), "203.0.113.9", PLACEMENT, PASSWORD):
            assert private not in dumped
        for entry in real_scenarios()["scenarios"]:
            assert entry["goalTextEn"] not in dumped and entry["titleEn"] not in dumped


def test_usage_rows_hold_no_account_and_no_text(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=FakeJsonProvider())
    flow = full_flow(env)
    demo = flow["demo"]
    assert len(env.ledger.rows) == 2
    for row in env.ledger.rows:
        dumped = json.dumps(asdict(row), default=str)
        for private in (demo.username, str(demo.user_id), PLACEMENT, "scenario-", *flow["ids"]):
            assert private not in dumped
        assert row.cost_usd is None  # unknown stays unknown, it is never written as 0
        assert row.quota_record is None and row.status == "succeeded"
        assert row.prompt_version == "demo-planner-v1"


def test_the_error_envelope_never_echoes_what_the_client_sent(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    demo = env.demo()
    secret = "scenario-with-a-secret-value"
    response = demo.client.post("/api/demo/plans", json={"scenarioId": secret, "isDemo": secret})
    assert response.status_code == 422
    assert secret not in response.text


# --- settings ------------------------------------------------------------------------------------


def test_the_demo_settings_have_the_documented_defaults(clean_env: pytest.MonkeyPatch) -> None:
    settings = make_settings()
    assert settings.QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY == 5
    assert settings.QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY == 10
    assert settings.QATRA_DEMO_FIXTURES_DIR is None


def test_the_demo_settings_come_from_the_environment(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY", "7")
    clean_env.setenv("QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY", "3")
    clean_env.setenv("QATRA_DEMO_FIXTURES_DIR", "/some/where")
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY == 7
    assert settings.QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY == 3
    assert settings.QATRA_DEMO_FIXTURES_DIR == "/some/where"


@pytest.mark.parametrize(
    "name", ["QATRA_DEMO_ACCOUNTS_PER_IP_PER_DAY", "QATRA_DEMO_PLANS_PER_ACCOUNT_PER_DAY"]
)
def test_a_zero_or_negative_limit_is_refused(name: str) -> None:
    for value in (0, -1):
        with pytest.raises(ValidationError):
            make_settings(**{name: value})


# --- wiring --------------------------------------------------------------------------------------


def test_create_app_serves_the_four_operations(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    schema = env.visitor().get("/openapi.json").json()["paths"]
    assert set(schema["/api/demo/accounts"]) == {"post"}
    assert set(schema["/api/demo/scenarios"]) == {"get"}
    assert set(schema["/api/demo/plans"]) == {"post"}
    assert set(schema["/api/demo/simulations"]) == {"get"}
    assert "201" in schema["/api/demo/accounts"]["post"]["responses"]
    assert "201" in schema["/api/demo/plans"]["post"]["responses"]
    assert env.app.state.demo_service is not None


def test_a_plain_create_app_has_the_demo_service_without_a_provider() -> None:
    app = create_app(make_settings())
    assert app.state.demo_service is not None
    assert getattr(app.state, "plan_chat_service", None) is not None


def test_installing_again_replaces_the_service_and_keeps_one_set_of_routes(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    before = len(env.app.routes)
    first = env.app.state.demo_service
    install_demo(env.app, env.settings)
    assert env.app.state.demo_service is not first
    assert len(env.app.routes) == before


def test_the_other_endpoints_are_untouched_by_the_demo_package(tmp_path: Path) -> None:
    env = build_env(tmp_path, provider=None)
    assert env.visitor().get("/api/health").status_code == 200
    assert env.visitor().get("/api/catalog").status_code == 200
    learner = env.learner()
    assert learner.client.get("/api/me").status_code == 200
