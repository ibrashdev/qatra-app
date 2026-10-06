"""The real provider path of the CLI against ``httpx.MockTransport`` (a fake OpenRouter)."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.providers.llm import ProviderUnavailable
from scripts import ai_comparison as ai
from tests.comparison.cmp_support import (
    FAKE_KEY,
    TODAY,
    Tick,
    World,
    build_world,
    settings,
)

ZERO = {"prompt": "0", "completion": "0", "request": "0", "image": "0"}
PAID = {"prompt": "0.000001", "completion": "0.000002"}
CATALOG = [
    {"id": "free/a:free", "pricing": ZERO, "supported_parameters": ["response_format"]},
    {"id": "free/b:free", "pricing": ZERO, "supported_parameters": ["tools"]},
    {"id": "paid/c", "pricing": PAID, "supported_parameters": ["response_format"]},
]
GOAL_REPLY = {"editionKey": "quran-hafs-quranenc-synthetic", "sectionOrdinals": [112]}
PLAN_REPLY = {"newWordsPerDay": 25, "reviewOffsetsDays": [1, 3, 7], "priorityReviewPassageIds": []}


def completion(content: Any, usage: dict[str, Any] | None = None) -> dict[str, Any]:
    text = content if isinstance(content, str) else json.dumps(content)
    return {
        "choices": [{"message": {"content": text}}],
        "usage": usage or {"prompt_tokens": 900, "completion_tokens": 40, "cost": 0},
    }


class FakeOpenRouter:
    """The models listing and the completions, recording every request."""

    def __init__(
        self,
        reply: Callable[[dict[str, Any]], httpx.Response] | None = None,
        models: list[dict[str, Any]] | None = None,
    ) -> None:
        self.models = CATALOG if models is None else models
        self.reply = reply or self.good
        self.requests: list[httpx.Request] = []

    @staticmethod
    def good(body: dict[str, Any]) -> httpx.Response:
        system = body["messages"][0]["content"]
        reply = GOAL_REPLY if system == ai.GOAL_SYSTEM_PROMPT else PLAN_REPLY
        return httpx.Response(200, json=completion(reply))

    @property
    def completions(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith("/chat/completions")]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": self.models})
        return self.reply(json.loads(request.content))


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> World:
    return build_world(tmp_path_factory.mktemp("world"))


def provider(fake: FakeOpenRouter, model: str = "free/a:free") -> Any:
    factory = ai.openrouter_factory(settings(), httpx.MockTransport(fake))
    return factory(model)


def complete(prov: Any, prompt: str = "system text", **changes: Any) -> Any:
    values: dict[str, Any] = {
        "system_prompt": prompt,
        "response_schema": {"type": "object"},
        "schema_name": "my_schema",
        "max_tokens": 400,
        "timeout_sec": 8.0,
    }
    values.update(changes)
    return prov.complete_json({"k": "v"}, **values)


def test_a_json_completion_returns_the_data_the_tokens_and_the_cost() -> None:
    fake = FakeOpenRouter(lambda body: httpx.Response(200, json=completion({"a": 1})))
    reply = complete(provider(fake))
    assert reply.data == {"a": 1} and reply.model == "free/a:free"
    assert (reply.input_tokens, reply.output_tokens, reply.cost_usd) == (900, 40, 0.0)


def test_the_request_carries_the_callers_prompt_schema_payload_and_key() -> None:
    fake = FakeOpenRouter()
    complete(provider(fake), prompt="MY PROMPT", schema_name="my_schema")
    (request,) = fake.completions
    body = json.loads(request.content)
    assert body["messages"][0] == {"role": "system", "content": "MY PROMPT"}
    assert json.loads(body["messages"][1]["content"]) == {"k": "v"}
    assert body["response_format"]["json_schema"]["name"] == "my_schema"
    assert body["provider"] == {"require_parameters": True} and body["max_tokens"] == 400
    assert request.headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert FAKE_KEY not in request.content.decode("utf-8")


def test_response_format_is_sent_only_when_the_model_documents_it() -> None:
    fake = FakeOpenRouter()
    complete(provider(fake, "free/b:free"))
    body = json.loads(fake.completions[0].content)
    assert "response_format" not in body and "provider" not in body


def test_a_model_that_is_not_free_is_never_called() -> None:
    fake = FakeOpenRouter()
    with pytest.raises(ProviderUnavailable) as caught:
        complete(provider(fake, "paid/c"))
    assert caught.value.reason == "ineligible" and not caught.value.request_made
    assert fake.completions == []


def test_a_catalog_that_cannot_be_read_means_ineligible() -> None:
    fake = FakeOpenRouter()
    fake.models = []
    with pytest.raises(ProviderUnavailable) as caught:
        complete(provider(fake))
    assert caught.value.reason == "ineligible" and fake.completions == []


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (httpx.Response(500, json={"error": "x"}), "error"),
        (httpx.Response(200, json={"error": {"message": f"nope {FAKE_KEY}"}}), "invalid_output"),
        (httpx.Response(200, json=completion("not json at all")), "invalid_output"),
        (httpx.Response(200, json={"choices": []}), "invalid_output"),
        (httpx.Response(200, content=b"<html>"), "invalid_output"),
    ],
)
def test_failures_are_reduced_to_a_reason_that_carries_no_text(
    response: httpx.Response, reason: str
) -> None:
    fake = FakeOpenRouter(lambda body: response)
    with pytest.raises(ProviderUnavailable) as caught:
        complete(provider(fake))
    assert caught.value.reason == reason
    assert FAKE_KEY not in str(caught.value) and "html" not in str(caught.value)


def test_an_invalid_reply_still_reports_its_tokens() -> None:
    reply = completion("oops", {"prompt_tokens": 700, "completion_tokens": 9})
    fake = FakeOpenRouter(lambda body: httpx.Response(200, json=reply))
    with pytest.raises(ProviderUnavailable) as caught:
        complete(provider(fake))
    assert (caught.value.input_tokens, caught.value.output_tokens) == (700, 9)


def test_a_fenced_json_reply_is_accepted_and_an_unknown_cost_stays_none() -> None:
    reply = {"choices": [{"message": {"content": '```json\n{"a": 2}\n```'}}], "usage": {}}
    fake = FakeOpenRouter(lambda body: httpx.Response(200, json=reply))
    got = complete(provider(fake))
    assert got.data == {"a": 2} and got.cost_usd is None and got.input_tokens is None


def test_a_timeout_is_a_timeout() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": CATALOG})
        raise httpx.ReadTimeout("slow", request=request)

    prov = ai.openrouter_factory(settings(), httpx.MockTransport(slow))("free/a:free")
    with pytest.raises(ProviderUnavailable) as caught:
        complete(prov)
    assert caught.value.reason == "timeout" and caught.value.request_made


def test_a_provider_without_a_key_is_disabled() -> None:
    fake = FakeOpenRouter()
    factory = ai.openrouter_factory(settings(OPENROUTER_API_KEY=None), httpx.MockTransport(fake))
    with pytest.raises(ProviderUnavailable) as caught:
        complete(factory("free/a:free"))
    assert caught.value.reason == "disabled" and fake.requests == []


def test_the_cli_runs_end_to_end_over_the_real_provider_code(
    world: World, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    fake = FakeOpenRouter()
    report = tmp_path / "report.json"
    code = ai.main(
        world.argv(
            "--models",
            "free/a:free",
            "--yes",
            "--only",
            "t-one",
            "--pause",
            "0",
            "--json",
            str(report),
        ),
        settings=settings(),
        transport=httpx.MockTransport(fake),
        sleep=lambda seconds: None,
        clock=Tick(),
        today=TODAY,
    )
    captured = capsys.readouterr()
    assert code == 0 and len(fake.completions) == 2
    names = [
        json.loads(r.content)["response_format"]["json_schema"]["name"] for r in fake.completions
    ]
    assert names[0] == ai.GOAL_SCHEMA_NAME and names[1] == ai.default_kit().schema_name
    assert all(r.headers["authorization"] == f"Bearer {FAKE_KEY}" for r in fake.completions)
    assert FAKE_KEY not in captured.out + captured.err + report.read_text(encoding="utf-8")
    data = json.loads(report.read_text(encoding="utf-8"))
    cell = {r["metric"]: r["cells"] for r in data["table"]["rows"]}["goal_recognition"]
    assert cell["ai:free/a:free"] == {"state": "ratio", "successes": 1, "executed": 1}


def test_a_free_model_that_is_listed_but_a_paid_second_one_is_not_run(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeOpenRouter()
    code = ai.main(
        world.argv("--models", "free/a:free,paid/c", "--yes", "--only", "t-one", "--pause", "0"),
        settings=settings(),
        transport=httpx.MockTransport(fake),
        sleep=lambda seconds: None,
        clock=Tick(),
        today=TODAY,
    )
    out = capsys.readouterr().out
    assert code == 0
    assert len(fake.completions) == 2  # nothing was sent for the paid model
    assert "| paid/c | Not run |" in out
