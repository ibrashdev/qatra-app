"""OpenRouter structured-output provider with the D60 free-eligibility check.

Policy (D54/D60, AI-agent.md, Plan-conversation §2.4):
- Only candidates from ``OPENROUTER_MODELS`` (in order) whose LIVE pricing is zero are called;
  the pricing comes from ``GET /api/v1/models``, cached for a short TTL. A pricing lookup that
  fails means "cannot verify", which means ineligible: no completion request is made.
- Structured output (JSON schema) is requested only when the model documents support for it;
  otherwise the reply must still validate as JSON, and a parse failure is a fallback.
- One request per turn, a shared deadline of ``timeout_sec`` over the network calls, then
  ``ProviderUnavailable``. Payloads, replies and provider error text are never logged or kept:
  every failure is reduced to a reason code. The API key is read from settings and used only
  in the ``Authorization`` header; without it the provider is disabled.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.providers.llm import (
    PLAN_CHAT_SYSTEM_PROMPT,
    REPLY_JSON_SCHEMA,
    ModelOutput,
    ModelReply,
    ProviderUnavailable,
)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
MODELS_TTL_SEC = 300.0
_STRUCTURED_PARAMETERS = frozenset({"structured_outputs", "response_format"})


def _is_zero_price(value: Any) -> bool:
    try:
        return Decimal(str(value)) == 0
    except (InvalidOperation, ValueError):
        return False


def is_free_pricing(pricing: Any) -> bool:
    """True only when ``prompt`` and ``completion`` are present and every listed price is
    exactly zero. Missing, negative (variable) or unparsable prices are not free."""
    if not isinstance(pricing, dict):
        return False
    if "prompt" not in pricing or "completion" not in pricing:
        return False
    return all(_is_zero_price(value) for value in pricing.values())


class OpenRouterProvider:
    name = "openrouter"

    def __init__(
        self,
        settings: Settings,
        transport: httpx.BaseTransport | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        base_url: str = OPENROUTER_BASE_URL,
    ) -> None:
        key = settings.OPENROUTER_API_KEY
        self._api_key = key.get_secret_value().strip() if key is not None else ""
        raw = settings.OPENROUTER_MODELS or ""
        self._candidates = [item.strip() for item in raw.split(",") if item.strip()]
        self._transport = transport
        self._clock = clock
        self._base_url = base_url.rstrip("/")
        self._lock = threading.Lock()
        self._catalog: dict[str, dict[str, Any]] = {}
        self._catalog_at: float | None = None

    def __repr__(self) -> str:
        return "OpenRouterProvider(<redacted>)"

    def is_enabled(self) -> bool:
        return bool(self._api_key) and bool(self._candidates)

    # -- eligibility -----------------------------------------------------------------------------

    def _client(self, timeout: float) -> httpx.Client:
        return httpx.Client(transport=self._transport, timeout=httpx.Timeout(max(timeout, 0.05)))

    def _load_catalog(self, timeout: float) -> dict[str, dict[str, Any]]:
        with self._lock:
            now = self._clock()
            if self._catalog_at is not None and now - self._catalog_at < MODELS_TTL_SEC:
                return self._catalog
            try:
                with self._client(timeout) as client:
                    response = client.get(f"{self._base_url}/models")
                if response.status_code != 200:
                    raise ValueError("status")
                data = response.json().get("data")
                if not isinstance(data, list):
                    raise ValueError("shape")
                catalog = {
                    str(item["id"]): item
                    for item in data
                    if isinstance(item, dict) and "id" in item
                }
            except Exception:
                # Cannot verify live pricing: treat as ineligible, never call blind.
                raise ProviderUnavailable("ineligible") from None
            self._catalog = catalog
            self._catalog_at = now
            return catalog

    def eligible_model(self, timeout: float) -> tuple[str, bool]:
        """The first candidate with zero live pricing and whether it documents structured output."""
        catalog = self._load_catalog(timeout)
        for candidate in self._candidates:
            entry = catalog.get(candidate)
            if entry is None or not is_free_pricing(entry.get("pricing")):
                continue
            supported = entry.get("supported_parameters")
            structured = isinstance(supported, list) and bool(
                _STRUCTURED_PARAMETERS & set(map(str, supported))
            )
            return candidate, structured
        raise ProviderUnavailable(
            "ineligible", model=self._candidates[0] if self._candidates else None
        )

    # -- completion ------------------------------------------------------------------------------

    def complete(
        self, payload: dict[str, Any], *, max_tokens: int, timeout_sec: float
    ) -> ModelReply:
        if not self.is_enabled():
            raise ProviderUnavailable("disabled")
        started = self._clock()

        def remaining() -> float:
            return timeout_sec - (self._clock() - started)

        model, structured = self.eligible_model(remaining())
        if remaining() <= 0:
            raise ProviderUnavailable("timeout", model=model)

        body: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": PLAN_CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.2,
        }
        if structured:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "plan_chat_reply",
                    "strict": False,
                    "schema": REPLY_JSON_SCHEMA,
                },
            }
            body["provider"] = {"require_parameters": True}
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        try:
            with self._client(remaining()) as client:
                response = client.post(
                    f"{self._base_url}/chat/completions", json=body, headers=headers
                )
        except httpx.TimeoutException:
            raise ProviderUnavailable("timeout", model=model) from None
        except Exception:
            raise ProviderUnavailable("error", model=model) from None
        if response.status_code != 200:
            raise ProviderUnavailable("error", model=model)

        input_tokens = output_tokens = None
        try:
            data = response.json()
            usage = data.get("usage") if isinstance(data, dict) else None
            if isinstance(usage, dict):
                input_tokens = _as_count(usage.get("prompt_tokens"))
                output_tokens = _as_count(usage.get("completion_tokens"))
            if not isinstance(data, dict) or "error" in data:
                raise ValueError("error body")
            content = data["choices"][0]["message"]["content"]
            output = ModelOutput.model_validate(_parse_json(content))
        except (ValueError, KeyError, IndexError, TypeError, ValidationError):
            raise ProviderUnavailable(
                "invalid_output",
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            ) from None
        cost = usage.get("cost") if isinstance(usage, dict) else None
        cost_usd = (
            float(cost) if isinstance(cost, int | float) and not isinstance(cost, bool) else None
        )
        return ModelReply(
            output=output,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
        )


def _as_count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _parse_json(content: Any) -> Any:
    if not isinstance(content, str):
        raise ValueError("content")
    text = content.strip()
    if text.startswith("```"):
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    return json.loads(text)


def build_default_provider(settings: Settings) -> OpenRouterProvider | None:
    """The provider for this deployment, or ``None`` when no key/candidate is configured."""
    provider = OpenRouterProvider(settings)
    return provider if provider.is_enabled() else None
