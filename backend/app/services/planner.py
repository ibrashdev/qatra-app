"""The restricted planner of E28 (API-spec §4.9): the Teaching Agent with the rules engine as the
permanent fallback (D54, D60).

``plan_with_fallback`` is the whole decision of one E28 call. It sends a model request only when
every gate passes, in this order: a provider that can do JSON completions and is enabled, the
outbound payload on its allowlist (the scenario id, passage ids with word counts and placement
counts, nothing else), and the free-budget caps (whole deployment per day and per minute, demo
account per day). The provider itself verifies that its model is free before it calls it
(``ProviderUnavailable("ineligible")`` otherwise). Everything that goes wrong (no provider, a
reached cap, ineligible model, timeout, error, a reply that is not JSON, advice outside the bounds
or with an invented passage id) ends in the rules outcome: the caller still answers ``201`` with
``planner.source = "rules"``; none of it is an error.

Every request that reached the provider, and an ineligible-model refusal, writes one ``ai_usage``
row through the shared ledger: provider, model, prompt version ``demo-planner-v1``, tokens, cost
(``None`` when unknown, never 0), status and a reason code. The row has no account, plan or text;
the account id only feeds the ledger's private per-account counter. Payloads, replies and
provider messages are never logged: events carry names and codes only.

The provider is any object with ``complete_json`` (``OpenRouterProvider`` gains it with the
question-bank branch); a provider without it is treated as absent. Production takes the provider
and ledger lazily from the plan conversation's gateway (``app.state.plan_chat_service``), so the
caps and the AI status card see demo calls too.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID

from app.config import Settings
from app.domain import demo_policy as policy
from app.logging_config import log_event
from app.providers.llm import ProviderUnavailable
from app.repositories.ai_usage import UsageLedger, UsageRecord

logger = logging.getLogger("qatra.demo")


class JsonReplyLike(Protocol):
    """What ``complete_json`` returns (``JsonReply`` of the OpenRouter provider)."""

    data: Any
    model: str
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None


class JsonCompletionProvider(Protocol):
    """One structured completion with a caller-supplied system prompt and JSON schema."""

    def is_enabled(self) -> bool:
        """False when no key or no candidate model is configured."""

    def complete_json(
        self,
        payload: dict[str, Any],
        *,
        system_prompt: str,
        response_schema: dict[str, Any],
        schema_name: str = ...,
        max_tokens: int,
        timeout_sec: float,
    ) -> JsonReplyLike:
        """Return the parsed reply or raise ``ProviderUnavailable``."""


@dataclass(frozen=True, slots=True)
class PlannerResources:
    """The provider and the usage ledger of one call (either may be absent)."""

    provider: Any | None
    ledger: UsageLedger | None


UNSET: Any = object()


class PlannerGateway:
    """Resolves the provider and the ledger when a request is served, not when the app is wired.

    ``install_plan_chat`` may be called again to replace its service, so the shared objects are
    read from ``app.state.plan_chat_service`` per call. Explicit ``provider`` and ``ledger`` (tests)
    take precedence. Without a ledger there is nothing to count against, so the planner then uses
    the rules engine only.
    """

    def __init__(
        self,
        state: Any,
        *,
        provider: Any = UNSET,
        ledger: UsageLedger | None = None,
    ) -> None:
        self._state = state
        self._provider = provider
        self._ledger = ledger

    def resources(self) -> PlannerResources:
        service = getattr(self._state, "plan_chat_service", None)
        provider = (
            self._provider if self._provider is not UNSET else getattr(service, "provider", None)
        )
        ledger = self._ledger if self._ledger is not None else getattr(service, "ledger", None)
        return PlannerResources(provider, ledger)


def plan_with_fallback(
    basis: policy.PlannerBasis,
    *,
    account: UUID,
    provider: JsonCompletionProvider | None,
    ledger: UsageLedger | None,
    settings: Settings,
    now: Callable[[], datetime] | None = None,
) -> policy.PlannerOutcome:
    """Ask the restricted agent for pace advice, or fall back to the rules engine.

    ``account`` feeds only the ledger's private per-account counter. ``provider`` may be any object
    with ``complete_json`` and ``is_enabled`` (anything else is treated as absent); without a
    ``ledger`` there is nothing to count against and the rules engine plans.
    """
    clock = now or (lambda: datetime.now(UTC))
    if provider is None or ledger is None:
        return policy.RULES_OUTCOME
    complete = getattr(provider, "complete_json", None)
    enabled = getattr(provider, "is_enabled", None)
    if complete is None or enabled is None or not enabled():
        return policy.RULES_OUTCOME

    payload = policy.build_planner_payload(basis)
    if policy.payload_violations(payload):
        log_event(logger, "demo_payload_rejected", level=logging.ERROR)
        return policy.RULES_OUTCOME
    usage = ledger.counts(account, clock())
    counts = policy.ModelCounts(usage.global_day, usage.global_minute, usage.account_day)
    if not policy.model_caps_allow(counts, settings):
        log_event(logger, "demo_planner_cap_reached")
        return policy.RULES_OUTCOME

    name = str(getattr(provider, "name", "openrouter"))
    try:
        reply = complete(
            payload,
            system_prompt=policy.DEMO_PLANNER_PROMPT,
            response_schema=policy.DEMO_PLANNER_SCHEMA,
            schema_name=policy.DEMO_PLANNER_SCHEMA_NAME,
            max_tokens=settings.QATRA_CHAT_MAX_TOKENS,
            timeout_sec=settings.QATRA_CHAT_MODEL_TIMEOUT_SEC,
        )
    except ProviderUnavailable as failure:
        if failure.reason != "disabled":
            _record(
                ledger,
                account,
                clock,
                provider=name,
                model=failure.model,
                status=failure.usage_status,
                input_tokens=failure.input_tokens,
                output_tokens=failure.output_tokens,
                reason=failure.reason,
            )
        log_event(logger, "demo_planner_fallback", reason=failure.reason)
        return policy.RULES_OUTCOME
    except Exception as exc:
        # Unknown failure of a provider that may already have made its request: counted
        # conservatively. Only the exception type is logged, never a message.
        _record(ledger, account, clock, provider=name, model=None, status="failed", reason="error")
        log_event(
            logger, "demo_planner_fallback", reason="error", exception_type=type(exc).__name__
        )
        return policy.RULES_OUTCOME

    advice = policy.validate_advice(
        reply.data,
        passage_ids=[str(item.passage_id) for item in basis.passages],
        capacity=basis.capacity,
    )
    common: dict[str, Any] = {
        "provider": name,
        "model": reply.model,
        "input_tokens": reply.input_tokens,
        "output_tokens": reply.output_tokens,
        "cost_usd": reply.cost_usd,
    }
    if advice is None:
        _record(ledger, account, clock, status="failed", reason="invalid_advice", **common)
        log_event(logger, "demo_planner_fallback", reason="invalid_advice")
        return policy.RULES_OUTCOME
    _record(ledger, account, clock, status="succeeded", reason=None, **common)
    return policy.PlannerOutcome("teaching_agent", reply.model, advice)


def _record(
    ledger: UsageLedger,
    account: UUID,
    clock: Callable[[], datetime],
    *,
    provider: str,
    model: str | None,
    status: str,
    reason: str | None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
) -> None:
    """One ``ai_usage`` row. A ledger failure never fails the learner's request."""
    try:
        ledger.record(
            UsageRecord(
                provider=provider,
                model=model or "unknown",
                prompt_version=policy.PROMPT_VERSION,
                status=status,
                created_at=clock(),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=_known_cost(cost_usd),
                quota_record={"reason": reason} if reason else None,
            ),
            account=account,
        )
    except Exception:
        log_event(logger, "demo_usage_record_failed", level=logging.WARNING)


def _known_cost(value: Any) -> float | None:
    """The provider's cost when it reported a number, otherwise ``None``: an unknown cost is never
    written as 0."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if value >= 0 else None
