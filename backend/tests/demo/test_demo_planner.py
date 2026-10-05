"""``services/planner.plan_with_fallback``: every gate and every failure ends in the right outcome
and the right ``ai_usage`` row. A fake provider and the in-memory ledger; no network."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from app.domain import demo_policy as policy
from app.repositories.ai_usage import InMemoryUsageLedger, UsageRecord
from app.services.planner import PlannerGateway, PlannerResources, plan_with_fallback
from tests.demo.demo_support import (
    ChatOnlyProvider,
    Clock,
    FakeJsonProvider,
    FakeJsonReply,
    advice_reply,
    good_advice,
    unavailable,
)
from tests.support import make_settings

ACCOUNT = UUID("aaaaaaaa-aaaa-4aaa-8aaa-0000000000d1")
P1 = UUID("55555555-5555-4555-8555-000000000001")
P2 = UUID("55555555-5555-4555-8555-000000000002")
NOW = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)


def basis() -> policy.PlannerBasis:
    return policy.PlannerBasis(
        "scenario-05", (policy.PassageFact(P1, 12), policy.PassageFact(P2, 30)), 2, 2, 10
    )


def run(
    provider: Any,
    ledger: InMemoryUsageLedger | None = None,
    **settings: Any,
) -> tuple[policy.PlannerOutcome, InMemoryUsageLedger]:
    usage = ledger if ledger is not None else InMemoryUsageLedger()
    outcome = plan_with_fallback(
        basis(),
        account=ACCOUNT,
        provider=provider,
        ledger=usage,
        settings=make_settings(**settings),
        now=Clock(),
    )
    return outcome, usage


def only_row(ledger: InMemoryUsageLedger) -> UsageRecord:
    assert len(ledger.rows) == 1
    return ledger.rows[0]


# --- success -------------------------------------------------------------------------------------


def test_valid_advice_is_the_teaching_agent_outcome_with_one_usage_row() -> None:
    provider = FakeJsonProvider(advice_reply(newWordsPerDay=7))
    outcome, ledger = run(provider)
    assert outcome.source == "teaching_agent" and outcome.model == "free-model-x"
    assert outcome.advice is not None and outcome.advice.new_words_per_day == 7
    row = only_row(ledger)
    assert (row.provider, row.model, row.prompt_version, row.status) == (
        "fake",
        "free-model-x",
        "demo-planner-v1",
        "succeeded",
    )
    assert (row.input_tokens, row.output_tokens, row.cost_usd) == (120, 40, None)
    assert row.quota_record is None


def test_the_request_carries_the_reviewed_prompt_schema_and_the_configured_limits() -> None:
    provider = FakeJsonProvider()
    run(provider, QATRA_CHAT_MAX_TOKENS=321, QATRA_CHAT_MODEL_TIMEOUT_SEC=3.5)
    assert provider.kwargs == [
        {
            "system_prompt": policy.DEMO_PLANNER_PROMPT,
            "response_schema": policy.DEMO_PLANNER_SCHEMA,
            "schema_name": "demo_plan_advice",
            "max_tokens": 321,
            "timeout_sec": 3.5,
        }
    ]
    assert provider.calls == [policy.build_planner_payload(basis())]


def test_a_reported_cost_is_kept_and_an_unknown_cost_is_never_zero() -> None:
    known = FakeJsonProvider(
        lambda payload: FakeJsonReply(good_advice(payload).data, cost_usd=0.002)
    )
    assert only_row(run(known)[1]).cost_usd == 0.002
    unknown = FakeJsonProvider(
        lambda payload: FakeJsonReply(good_advice(payload).data, cost_usd=None)
    )
    assert only_row(run(unknown)[1]).cost_usd is None
    junk = FakeJsonProvider(
        lambda payload: FakeJsonReply(good_advice(payload).data, cost_usd="free")
    )  # type: ignore[arg-type]
    assert only_row(run(junk)[1]).cost_usd is None
    negative = FakeJsonProvider(
        lambda payload: FakeJsonReply(good_advice(payload).data, cost_usd=-1.0)
    )
    assert only_row(run(negative)[1]).cost_usd is None


# --- no model call -------------------------------------------------------------------------------


def test_without_a_provider_or_a_ledger_the_rules_engine_plans() -> None:
    ledger = InMemoryUsageLedger()
    provider = FakeJsonProvider()
    for given_provider, given_ledger in ((None, ledger), (provider, None), (None, None)):
        outcome = plan_with_fallback(
            basis(),
            account=ACCOUNT,
            provider=given_provider,
            ledger=given_ledger,
            settings=make_settings(),
        )
        assert outcome == policy.RULES_OUTCOME
    assert ledger.rows == [] and provider.calls == []


def test_a_disabled_provider_is_not_called_and_writes_no_row() -> None:
    provider = FakeJsonProvider(enabled=False)
    outcome, ledger = run(provider)
    assert outcome.source == "rules" and provider.calls == [] and ledger.rows == []


def test_a_provider_that_raises_disabled_writes_no_row() -> None:
    outcome, ledger = run(FakeJsonProvider(unavailable("disabled")))
    assert outcome == policy.RULES_OUTCOME and ledger.rows == []


def test_a_provider_without_complete_json_is_treated_as_absent() -> None:
    chat_only = ChatOnlyProvider()
    outcome, ledger = run(chat_only)
    assert outcome == policy.RULES_OUTCOME and chat_only.calls == 0 and ledger.rows == []


@pytest.mark.parametrize(
    "settings",
    [
        {"QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY": 0},
        {"QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE": 0},
        {"QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY": 0},
    ],
)
def test_a_reached_cap_means_no_call_and_no_row(settings: dict[str, int]) -> None:
    provider = FakeJsonProvider()
    outcome, ledger = run(provider, **settings)
    assert outcome == policy.RULES_OUTCOME
    assert provider.calls == [] and ledger.rows == []


def test_the_chat_turn_cap_does_not_block_the_planner() -> None:
    provider = FakeJsonProvider()
    outcome, _ = run(provider, QATRA_CHAT_MODEL_TURNS_PER_CHAT=0)
    assert outcome.source == "teaching_agent" and len(provider.calls) == 1


def test_calls_already_in_the_ledger_count_against_the_caps() -> None:
    ledger = InMemoryUsageLedger()
    settings = {"QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY": 2}
    provider = FakeJsonProvider()
    assert run(provider, ledger, **settings)[0].source == "teaching_agent"
    assert run(provider, ledger, **settings)[0].source == "teaching_agent"
    third, _ = run(provider, ledger, **settings)
    assert third == policy.RULES_OUTCOME and len(provider.calls) == 2 and len(ledger.rows) == 2


def test_a_payload_with_an_unexpected_key_is_never_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    original = policy.build_planner_payload
    monkeypatch.setattr(
        policy, "build_planner_payload", lambda b: {**original(b), "username": "someone"}
    )
    provider = FakeJsonProvider()
    outcome, ledger = run(provider)
    assert outcome == policy.RULES_OUTCOME and provider.calls == [] and ledger.rows == []


# --- failures of the request ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "failure, status, reason",
    [
        (unavailable("timeout", model="m1"), "timed_out", "timeout"),
        (unavailable("error", model="m1"), "failed", "error"),
        (unavailable("ineligible", model="m1"), "rules_fallback", "ineligible"),
        (
            unavailable("invalid_output", model="m1", input_tokens=9, output_tokens=3),
            "failed",
            "invalid_output",
        ),
    ],
)
def test_a_provider_failure_falls_back_with_the_mapped_status(
    failure: Exception, status: str, reason: str
) -> None:
    outcome, ledger = run(FakeJsonProvider(failure))
    assert outcome == policy.RULES_OUTCOME
    row = only_row(ledger)
    assert (row.status, row.quota_record) == (status, {"reason": reason})
    assert row.model == "m1" and row.cost_usd is None


def test_a_failure_without_a_model_is_recorded_as_unknown() -> None:
    row = only_row(run(FakeJsonProvider(unavailable("ineligible")))[1])
    assert row.model == "unknown" and row.status == "rules_fallback"


def test_failed_tokens_are_kept_in_the_row() -> None:
    failure = unavailable("invalid_output", model="m1", input_tokens=9, output_tokens=3)
    row = only_row(run(FakeJsonProvider(failure))[1])
    assert (row.input_tokens, row.output_tokens) == (9, 3)


def test_an_unexpected_exception_is_a_counted_fallback_not_an_error() -> None:
    outcome, ledger = run(FakeJsonProvider(RuntimeError("boom with a secret value")))
    assert outcome == policy.RULES_OUTCOME
    row = only_row(ledger)
    assert (row.status, row.model, row.quota_record) == ("failed", "unknown", {"reason": "error"})
    assert "boom" not in json.dumps(asdict(row), default=str)


def test_only_counted_requests_count_against_the_account_cap() -> None:
    ledger = InMemoryUsageLedger()
    settings = {"QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY": 1}
    # an ineligible refusal made no request: it is a ``rules_fallback`` row and does not count
    outcome, _ = run(FakeJsonProvider(unavailable("ineligible")), ledger, **settings)
    assert outcome.source == "rules"
    again, _ = run(FakeJsonProvider(), ledger, **settings)
    assert again.source == "teaching_agent"
    blocked, _ = run(FakeJsonProvider(), ledger, **settings)
    assert blocked.source == "rules"
    assert [r.status for r in ledger.rows] == ["rules_fallback", "succeeded"]


# --- replies that are not usable -----------------------------------------------------------------


def bad(**overrides: Any) -> Callable[[dict[str, Any]], FakeJsonReply]:
    return advice_reply(**overrides)


@pytest.mark.parametrize(
    "script",
    [
        lambda payload: FakeJsonReply("just text"),
        lambda payload: FakeJsonReply(None),
        lambda payload: FakeJsonReply([1, 2, 3]),
        lambda payload: FakeJsonReply({"newWordsPerDay": 5}),
        bad(newWordsPerDay=0),
        bad(newWordsPerDay=26),  # capacity of 10 minutes is 25
        bad(reviewOffsetsDays=[7, 3, 1]),
        bad(reviewOffsetsDays=[1, 2, 3, 4, 5, 6]),
        bad(reviewOffsetsDays=[1, 40]),
        bad(priorityReviewPassageIds=["55555555-5555-4555-8555-0000000000ff"]),
        lambda payload: FakeJsonReply({**good_advice(payload).data, "extra": 1}),
    ],
)
def test_advice_that_breaks_the_bounds_falls_back_but_the_call_is_counted(script: Any) -> None:
    outcome, ledger = run(FakeJsonProvider(script))
    assert outcome == policy.RULES_OUTCOME
    row = only_row(ledger)
    assert (row.status, row.quota_record) == ("failed", {"reason": "invalid_advice"})
    assert (row.model, row.input_tokens, row.output_tokens) == ("free-model-x", 120, 40)


def test_the_usage_row_has_no_account_and_no_text() -> None:
    _, ledger = run(FakeJsonProvider())
    dumped = json.dumps(asdict(only_row(ledger)), default=str)
    assert str(ACCOUNT) not in dumped and str(P1) not in dumped and "scenario" not in dumped
    assert set(asdict(only_row(ledger))) == {
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


def test_the_account_only_feeds_the_private_counter() -> None:
    _, ledger = run(FakeJsonProvider())
    assert ledger.counts(ACCOUNT, NOW).account_day == 1
    assert ledger.counts(UUID(int=7), NOW).account_day == 0


def test_a_failing_ledger_never_fails_the_request(caplog: pytest.LogCaptureFixture) -> None:
    class BrokenLedger(InMemoryUsageLedger):
        def record(self, entry: UsageRecord, *, account: UUID | None = None) -> None:
            raise RuntimeError("database down")

    outcome, _ = run(FakeJsonProvider(), BrokenLedger())
    assert outcome.source == "teaching_agent"


# --- logging -------------------------------------------------------------------------------------


def test_nothing_of_the_payload_or_the_reply_is_logged(
    log_lines: list[str], caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="qatra")
    marker_reply = FakeJsonReply(
        {
            "newWordsPerDay": 5,
            "reviewOffsetsDays": [1, 3],
            "priorityReviewPassageIds": [str(P1)],
        },
        model="model-marker-1234",
    )
    run(FakeJsonProvider(marker_reply))
    run(FakeJsonProvider(unavailable("timeout", model="model-marker-1234")))
    run(FakeJsonProvider(RuntimeError("provider text that must not be logged")))
    run(FakeJsonProvider(bad(newWordsPerDay=0)))
    text = " ".join(log_lines)
    assert "demo_planner_fallback" in text  # the events were captured
    for secret in (str(P1), str(P2), "scenario-05", "provider text", "wordCount", "model-marker"):
        assert secret not in text


# --- the lazy gateway ----------------------------------------------------------------------------


class _State:
    pass


class _Service:
    def __init__(self, provider: Any, ledger: Any) -> None:
        self.provider = provider
        self.ledger = ledger


def test_the_gateway_reads_the_plan_conversation_lazily() -> None:
    state = _State()
    gateway = PlannerGateway(state)
    assert gateway.resources() == PlannerResources(None, None)
    first = _Service("p1", "l1")
    state.plan_chat_service = first  # type: ignore[attr-defined]
    assert gateway.resources() == PlannerResources("p1", "l1")
    state.plan_chat_service = _Service("p2", "l2")  # type: ignore[attr-defined]  # replaced later
    assert gateway.resources() == PlannerResources("p2", "l2")


def test_explicit_resources_win_over_the_plan_conversation() -> None:
    state = _State()
    state.plan_chat_service = _Service("p1", "l1")  # type: ignore[attr-defined]
    ledger = InMemoryUsageLedger()
    gateway = PlannerGateway(state, provider=None, ledger=ledger)
    assert gateway.resources() == PlannerResources(None, ledger)
