"""Q7-08 / NFR-15: reply latency of the plan conversation, measured with fake providers.

Plan-conversation.md section 1.2, NFR-15: p95 <= 1 s for rules replies (quick replies, the input
guard, the fallback) and p95 <= 10 s when the model answers (8 s provider timeout plus 2 s of
processing). QA-and-evaluation.md Q7-08 asks to measure first with a mock provider with known
delays. The model delays here are small (tens of milliseconds) and the timeout is lowered through
the settings, so the whole file stays fast; the bounds asserted are the specified ones, expressed
as ``timeout + processing budget``. Synthetic data only, no network.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.contracts_plan_chat import CreatePlanChatRequest, PlanChat, SendMessageRequest
from app.providers.llm import ProviderUnavailable
from app.services.plan_chat import build_plan_chat_service
from tests.plan_chat.pc_support import (
    Env,
    FakeProvider,
    composed_body,
    ctx,
    login_as,
    make_app,
    make_env,
    model_reply,
)
from tests.support import FRONTEND_ORIGIN

RUNS = 20  # samples per path (the task asks for at least 20)
RULES_P95_SEC = 1.0  # NFR-15, rules replies
MODEL_P95_SEC = 10.0  # NFR-15, replies with the model: 8 s timeout + 2 s processing
PROCESSING_BUDGET_SEC = 2.0  # NFR-15: what is allowed on top of the provider timeout
LOGISTICS_TEXT = "please make the plan shorter"


def p95(samples: list[float]) -> float:
    """Nearest-rank 95th percentile."""
    ordered = sorted(samples)
    return ordered[max(math.ceil(0.95 * len(ordered)) - 1, 0)]


def open_chat(env: Env) -> PlanChat:
    return env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body())
    )


def timed_turn(env: Env, **payload: str) -> tuple[float, PlanChat]:
    """One E32 turn through the real service: (wall seconds, the resulting conversation)."""
    chat = open_chat(env)  # not part of the measurement
    request = SendMessageRequest.model_validate(payload)
    started = time.perf_counter()
    result = env.service.send_message(ctx(), chat.chat_id, request)
    return time.perf_counter() - started, result


# --- the rules paths (service level) ---

RULES_PATHS: list[tuple[str, Callable[[], Env], dict[str, str], str]] = [
    ("quick reply", make_env, {"quickReply": "fewer_minutes"}, "proposal"),
    ("guard, religious (ar)", make_env, {"text": "ما حكم هذا؟"}, "refusal"),
    ("guard, religious (en)", make_env, {"text": "Is this halal or haram?"}, "refusal"),
    ("guard, out of scope", make_env, {"text": "write me a poem"}, "redirect"),
    (
        "fallback, provider raises",
        lambda: make_env(ProviderUnavailable("error", model="free/m:free")),
        {"text": LOGISTICS_TEXT},
        "fallback",
    ),
    (
        "fallback, provider disabled",
        lambda: make_env(provider=False),
        {"text": LOGISTICS_TEXT},
        "fallback",
    ),
    (
        "fallback, provider switched off",
        lambda: make_env(ProviderUnavailable("disabled")),
        {"text": LOGISTICS_TEXT},
        "fallback",
    ),
    (
        "model switched off for learners",
        lambda: make_env(learner_model=False),
        {"text": LOGISTICS_TEXT},
        "text",
    ),
]


@pytest.mark.parametrize(
    ("make", "payload", "kind"),
    [path[1:] for path in RULES_PATHS],
    ids=[path[0] for path in RULES_PATHS],
)
def test_rules_replies_p95_is_within_one_second(
    make: Callable[[], Env], payload: dict[str, str], kind: str
) -> None:
    samples: list[float] = []
    for _ in range(RUNS):
        env = make()
        elapsed, result = timed_turn(env, **payload)
        assert result.messages[-1].kind == kind
        samples.append(elapsed)
    assert len(samples) >= 20
    assert p95(samples) <= RULES_P95_SEC


def test_the_rules_paths_make_no_model_call_for_a_quick_reply_or_the_guard() -> None:
    """The latency bound for these paths holds because no provider is involved at all."""
    for payload in ({"quickReply": "fewer_minutes"}, {"text": "ما حكم هذا؟"}):
        env = make_env()
        timed_turn(env, **payload)
        assert env.provider is not None and env.provider.calls == []


# --- the rules paths (E32 route) ---


@pytest.mark.parametrize(
    ("body", "kind"),
    [
        ({"quickReply": "fewer_minutes"}, "proposal"),
        ({"text": "ما حكم هذا؟"}, "refusal"),
        ({"text": "write me a poem"}, "redirect"),
    ],
    ids=["quick reply", "guard religious", "guard out of scope"],
)
def test_e32_route_rules_replies_p95_is_within_one_second(body: dict[str, str], kind: str) -> None:
    samples: list[float] = []
    for _ in range(RUNS):
        app = make_app(make_env())  # a fresh app each time: E31 has its own rate limiter
        login_as(app)  # TEST ONLY: a fake SessionContext instead of a real cookie
        with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
            chat = client.post("/api/plan-chats", json=composed_body())
            assert chat.status_code == 201
            url = f"/api/plan-chats/{chat.json()['chatId']}/messages"
            started = time.perf_counter()
            response = client.post(url, json=body)
            samples.append(time.perf_counter() - started)
        assert response.status_code == 200
        assert response.json()["messages"][-1]["kind"] == kind
    assert len(samples) >= 20
    assert p95(samples) <= RULES_P95_SEC


# --- the model path: a provider with a known delay and a timeout it honours ---


class DelayedProvider:
    """A provider that takes ``delay`` seconds to answer, as the real client does: when the
    delay exceeds the ``timeout_sec`` it is given, it gives up at the timeout and raises."""

    name = "fake"

    def __init__(self, delay: float, reply: str = "The plan stays as it is.") -> None:
        self.delay = delay
        self.reply = reply
        self.timeouts: list[float] = []
        self.calls: list[dict[str, Any]] = []

    def is_enabled(self) -> bool:
        return True

    def complete(self, payload: dict[str, Any], *, max_tokens: int, timeout_sec: float):
        self.calls.append(payload)
        self.timeouts.append(timeout_sec)
        if self.delay > timeout_sec:
            time.sleep(timeout_sec)
            raise ProviderUnavailable("timeout", model="free/model:free")
        time.sleep(self.delay)
        return model_reply("question", self.reply)


def env_with(provider: DelayedProvider, **settings: Any) -> Env:
    """The service of ``make_env`` rebuilt around ``provider``."""
    base = make_env(provider=False, **settings)
    service = build_plan_chat_service(
        base.settings,
        planning=base.planning,
        writer=base.writer,
        learning=base.learning,
        repository=base.repo,
        ledger=base.ledger,
        provider=provider,
        clock=base.clock,
    )
    base.service = service
    return base


MODEL_DELAY_SEC = 0.05
TEST_TIMEOUT_SEC = 0.1


def test_the_specified_defaults_give_the_ten_second_bound() -> None:
    """NFR-15 arithmetic: the shipped timeout is 8 s and 8 + 2 s of processing is the 10 s bound."""
    assert Settings.model_fields["QATRA_CHAT_MODEL_TIMEOUT_SEC"].default == 8
    assert 8 + PROCESSING_BUDGET_SEC == MODEL_P95_SEC


def test_a_slow_but_answering_model_p95_is_within_the_bound() -> None:
    samples: list[float] = []
    for _ in range(RUNS):
        provider = DelayedProvider(MODEL_DELAY_SEC)
        env = env_with(provider, QATRA_CHAT_MODEL_TIMEOUT_SEC=TEST_TIMEOUT_SEC)
        elapsed, result = timed_turn(env, text=LOGISTICS_TEXT)
        assert result.messages[-1].source == "model"  # the model's reply was shown
        assert provider.timeouts == [TEST_TIMEOUT_SEC]
        assert elapsed >= MODEL_DELAY_SEC
        samples.append(elapsed)
    assert p95(samples) <= TEST_TIMEOUT_SEC + PROCESSING_BUDGET_SEC
    assert p95(samples) <= MODEL_P95_SEC


def test_a_model_that_exceeds_the_timeout_falls_back_within_the_bound() -> None:
    samples: list[float] = []
    for _ in range(RUNS):
        provider = DelayedProvider(delay=30.0)  # would take 30 s; the timeout cuts it at 0.1 s
        env = env_with(provider, QATRA_CHAT_MODEL_TIMEOUT_SEC=TEST_TIMEOUT_SEC)
        elapsed, result = timed_turn(env, text=LOGISTICS_TEXT)
        assert result.messages[-1].kind == "fallback" and result.messages[-1].source == "rules"
        assert result.proposal is not None and result.proposal.proposal_version == 1
        assert provider.timeouts == [TEST_TIMEOUT_SEC]
        assert [row.status for row in env.ledger.rows] == ["timed_out"]
        assert elapsed >= TEST_TIMEOUT_SEC * 0.9  # the wait was the timeout, not a shortcut
        samples.append(elapsed)
    assert p95(samples) <= TEST_TIMEOUT_SEC + PROCESSING_BUDGET_SEC
    assert p95(samples) <= MODEL_P95_SEC


def test_the_service_passes_the_configured_timeout_to_the_provider() -> None:
    env = make_env(model_reply("question", "ok"), QATRA_CHAT_MODEL_TIMEOUT_SEC=3.5)
    assert isinstance(env.provider, FakeProvider)
    seen: list[float] = []
    real = env.provider.complete

    def spy(payload: dict[str, Any], *, max_tokens: int, timeout_sec: float):
        seen.append(timeout_sec)
        return real(payload, max_tokens=max_tokens, timeout_sec=timeout_sec)

    env.provider.complete = spy  # type: ignore[method-assign]
    timed_turn(env, text=LOGISTICS_TEXT)
    assert seen == [3.5]
