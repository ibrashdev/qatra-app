"""OpenRouter provider against ``httpx.MockTransport``: eligibility, structured output, failures."""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from app.providers.llm import PLAN_CHAT_SYSTEM_PROMPT, ProviderUnavailable
from app.providers.openrouter import MODELS_TTL_SEC, OpenRouterProvider, is_free_pricing
from tests.support import make_settings

ZERO = {"prompt": "0", "completion": "0", "request": "0", "image": "0"}
PAID = {"prompt": "0.000001", "completion": "0.000002"}
PAYLOAD = {"conversationId": "t", "language": "en", "messages": [{"role": "learner", "text": "hi"}]}
GOOD = {"intent": "set_parameters", "parameters": {"sessionMinutes": 15}, "reply": "Done."}


def completion(content: object, usage: dict | None = None) -> dict:
    body = {"choices": [{"message": {"content": content}}]}
    body["usage"] = usage if usage is not None else {"prompt_tokens": 120, "completion_tokens": 30}
    return body


class Router:
    """A fake OpenRouter: models listing and chat completions, with call records."""

    def __init__(
        self,
        models: list[dict] | None = None,
        reply: Callable[[httpx.Request], httpx.Response] | None = None,
    ) -> None:
        self.models = (
            models
            if models is not None
            else [
                {"id": "free/a:free", "pricing": ZERO, "supported_parameters": ["response_format"]}
            ]
        )
        self.reply = reply or (
            lambda request: httpx.Response(200, json=completion(json.dumps(GOOD)))
        )
        self.model_calls = 0
        self.completion_calls: list[httpx.Request] = []
        self.model_requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            self.model_calls += 1
            self.model_requests.append(request)
            return httpx.Response(200, json={"data": self.models})
        assert request.url.path.endswith("/chat/completions")
        self.completion_calls.append(request)
        return self.reply(request)


def provider(
    router: Router, models: str = "free/a:free", key: str | None = "dummy-key", clock=None
):
    values = {"OPENROUTER_API_KEY": key, "OPENROUTER_MODELS": models}
    kwargs = {"clock": clock} if clock else {}
    return OpenRouterProvider(make_settings(**values), httpx.MockTransport(router), **kwargs)


def run(p: OpenRouterProvider):
    return p.complete(PAYLOAD, max_tokens=400, timeout_sec=8)


def test_free_model_is_called_with_structured_output() -> None:
    router = Router()
    reply = run(provider(router))
    assert reply.output.intent == "set_parameters"
    assert reply.output.parameters.as_patch() == {"sessionMinutes": 15}
    assert reply.model == "free/a:free"
    assert (reply.input_tokens, reply.output_tokens, reply.cost_usd) == (120, 30, None)
    (call,) = router.completion_calls
    body = json.loads(call.content)
    assert body["model"] == "free/a:free" and body["max_tokens"] == 400
    assert body["response_format"]["type"] == "json_schema"
    assert body["messages"][0] == {"role": "system", "content": PLAN_CHAT_SYSTEM_PROMPT}
    assert json.loads(body["messages"][1]["content"]) == PAYLOAD
    assert call.headers["authorization"] == "Bearer dummy-key"
    # The public pricing lookup carries no credential.
    assert "authorization" not in router.model_requests[0].headers


def test_paid_or_unverifiable_pricing_is_never_called() -> None:
    router = Router(models=[{"id": "paid/b", "pricing": PAID}])
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router, "paid/b"))
    assert caught.value.reason == "ineligible" and not caught.value.request_made
    assert caught.value.usage_status == "rules_fallback"
    assert router.completion_calls == []


@pytest.mark.parametrize(
    "pricing",
    [
        None,
        {},
        {"prompt": "0"},
        {"prompt": "-1", "completion": "-1"},
        {"prompt": "x", "completion": "0"},
        {"prompt": "0", "completion": "0", "request": "0.01"},
    ],
)
def test_only_zero_pricing_is_free(pricing) -> None:
    assert not is_free_pricing(pricing)
    router = Router(models=[{"id": "m", "pricing": pricing}])
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router, "m"))
    assert caught.value.reason == "ineligible"
    assert router.completion_calls == []


def test_zero_pricing_forms_are_free() -> None:
    assert is_free_pricing({"prompt": "0", "completion": "0"})
    assert is_free_pricing({"prompt": 0, "completion": "0.0"})


def test_unknown_candidate_is_ineligible() -> None:
    router = Router()
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router, "not/listed"))
    assert caught.value.reason == "ineligible"


def test_candidates_are_tried_in_order_and_the_first_free_one_wins() -> None:
    router = Router(
        models=[
            {"id": "paid/b", "pricing": PAID},
            {"id": "free/c:free", "pricing": ZERO, "supported_parameters": []},
        ]
    )
    reply = run(provider(router, "paid/b, free/c:free"))
    assert reply.model == "free/c:free"


def test_model_without_documented_structured_output_gets_a_plain_request() -> None:
    router = Router(
        models=[{"id": "free/a:free", "pricing": ZERO, "supported_parameters": ["tools"]}]
    )
    run(provider(router))
    body = json.loads(router.completion_calls[0].content)
    assert "response_format" not in body


def test_fenced_json_is_accepted() -> None:
    router = Router(
        reply=lambda r: httpx.Response(
            200, json=completion("```json\n" + json.dumps(GOOD) + "\n```")
        )
    )
    assert run(provider(router)).output.reply == "Done."


@pytest.mark.parametrize(
    "content",
    [
        "not json at all",
        "[1, 2]",
        json.dumps({"intent": "dance", "reply": "x"}),
        json.dumps({"intent": "question", "reply": "x", "extra": 1}),
        json.dumps({"intent": "set_parameters", "reply": "x", "parameters": {"userId": "u"}}),
        None,
    ],
)
def test_invalid_output_is_an_invalid_output_failure(content) -> None:
    router = Router(reply=lambda r: httpx.Response(200, json=completion(content)))
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router))
    assert caught.value.reason == "invalid_output"
    assert caught.value.request_made and caught.value.usage_status == "failed"
    assert caught.value.input_tokens == 120


def test_reply_may_be_empty_for_fixed_message_intents() -> None:
    router = Router(
        reply=lambda r: httpx.Response(200, json=completion(json.dumps({"intent": "religious"})))
    )
    assert run(provider(router)).output.reply == ""


def test_timeout_is_reported_and_counts_as_a_request() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(Router(reply=boom)))
    assert caught.value.reason == "timeout" and caught.value.request_made
    assert caught.value.usage_status == "timed_out"
    assert caught.value.model == "free/a:free"


@pytest.mark.parametrize("status", [400, 401, 429, 500, 503])
def test_http_errors_are_failures_without_provider_text(status: int) -> None:
    router = Router(
        reply=lambda r: httpx.Response(status, json={"error": {"message": "secret text"}})
    )
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router))
    assert caught.value.reason == "error"
    assert "secret text" not in str(caught.value) and caught.value.__cause__ is None


def test_error_body_with_status_200_is_a_failure() -> None:
    router = Router(reply=lambda r: httpx.Response(200, json={"error": {"code": 429}}))
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router))
    assert caught.value.reason == "invalid_output"


def test_models_listing_failure_means_ineligible() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            raise httpx.ConnectError("down")
        raise AssertionError("must not call completions")

    p = OpenRouterProvider(
        make_settings(OPENROUTER_API_KEY="k", OPENROUTER_MODELS="free/a:free"),
        httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderUnavailable) as caught:
        run(p)
    assert caught.value.reason == "ineligible"


def test_without_key_or_models_the_provider_is_disabled() -> None:
    router = Router()
    for p in (provider(router, key=None), provider(router, models="")):
        assert not p.is_enabled()
        with pytest.raises(ProviderUnavailable) as caught:
            run(p)
        assert caught.value.reason == "disabled" and not caught.value.request_made
    assert router.model_calls == 0 and router.completion_calls == []


def test_models_listing_is_cached_until_the_ttl() -> None:
    now = [0.0]
    router = Router()
    p = provider(router, clock=lambda: now[0])
    run(p)
    run(p)
    assert router.model_calls == 1
    now[0] += MODELS_TTL_SEC + 1
    run(p)
    assert router.model_calls == 2


def test_cost_is_recorded_only_when_the_provider_reports_it() -> None:
    router = Router(
        reply=lambda r: httpx.Response(
            200,
            json=completion(
                json.dumps(GOOD), {"prompt_tokens": 1, "completion_tokens": 2, "cost": 0}
            ),
        )
    )
    assert run(provider(router)).cost_usd == 0.0


def test_repr_hides_the_key() -> None:
    assert "dummy-key" not in repr(provider(Router()))


# -- total wall-clock deadline (httpx timeouts are per phase; keep-alive bytes defeat them) -------


class TrickleStream(httpx.SyncByteStream):
    """A body delivered in chunks; a fake clock advances by ``step`` seconds per chunk."""

    def __init__(self, chunks: list[bytes], now: list[float], step: float) -> None:
        self.chunks = chunks
        self.now = now
        self.step = step
        self.delivered = 0

    def __iter__(self):
        for chunk in self.chunks:
            self.now[0] += self.step
            self.delivered += 1
            yield chunk


def trickle_router(chunks: list[bytes], now: list[float], step: float):
    streams: list[TrickleStream] = []

    def reply(request: httpx.Request) -> httpx.Response:
        stream = TrickleStream(chunks, now, step)
        streams.append(stream)
        return httpx.Response(200, headers={"content-type": "application/json"}, stream=stream)

    return Router(reply=reply), streams


def good_body() -> bytes:
    return json.dumps(completion(json.dumps(GOOD))).encode()


def test_body_trickling_past_the_deadline_is_a_timeout() -> None:
    now = [0.0]
    chunks = [b" "] * 5 + [good_body()]
    router, streams = trickle_router(chunks, now, step=3.0)
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(router, clock=lambda: now[0]))
    assert caught.value.reason == "timeout" and caught.value.request_made
    assert caught.value.usage_status == "timed_out"
    assert caught.value.model == "free/a:free"
    # Gave up at the first chunk past 8 s (the third), without reading the rest.
    assert streams[0].delivered == 3


def test_keep_alive_whitespace_then_a_valid_body_within_the_deadline_succeeds() -> None:
    now = [0.0]
    chunks = [b" ", b"\n", b" ", good_body()]
    router, _ = trickle_router(chunks, now, step=1.0)
    reply = run(provider(router, clock=lambda: now[0]))
    assert reply.output.parameters.as_patch() == {"sessionMinutes": 15}
    assert (reply.input_tokens, reply.output_tokens) == (120, 30)


def test_a_body_split_across_chunks_is_reassembled() -> None:
    now = [0.0]
    body = good_body()
    router, _ = trickle_router([b"  ", body[:20], body[20:]], now, step=0.5)
    assert run(provider(router, clock=lambda: now[0])).output.reply == "Done."


def test_catalog_lookup_that_uses_up_the_budget_is_a_timeout() -> None:
    now = [0.0]

    def slow_models(request: httpx.Request) -> httpx.Response:
        now[0] += 9.0
        return httpx.Response(200, json={"data": [{"id": "free/a:free", "pricing": ZERO}]})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return slow_models(request)
        raise AssertionError("must not call completions after the budget is gone")

    p = OpenRouterProvider(
        make_settings(OPENROUTER_API_KEY="k", OPENROUTER_MODELS="free/a:free"),
        httpx.MockTransport(handler),
        clock=lambda: now[0],
    )
    with pytest.raises(ProviderUnavailable) as caught:
        run(p)
    assert caught.value.reason == "timeout" and caught.value.model == "free/a:free"


def test_non_200_status_is_an_error_without_reading_the_body() -> None:
    now = [0.0]

    def reply(request: httpx.Request) -> httpx.Response:
        stream = TrickleStream([b"secret text"], now, 0.0)
        streams.append(stream)
        return httpx.Response(503, stream=stream)

    streams: list[TrickleStream] = []
    with pytest.raises(ProviderUnavailable) as caught:
        run(provider(Router(reply=reply), clock=lambda: now[0]))
    assert caught.value.reason == "error" and streams[0].delivered == 0
