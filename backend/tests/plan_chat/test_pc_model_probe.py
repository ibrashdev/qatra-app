"""The model probe CLI (scripts/model_probe.py) against ``httpx.MockTransport``.

No real network is ever used: every request goes to a fake OpenRouter. Data is synthetic.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.contracts_plan_chat import PlanParameters, TargetScope
from app.domain import plan_chat_policy as policy
from app.domain.plan_policy import compute_estimate, edition_dto
from app.providers.llm import PLAN_CHAT_SYSTEM_PROMPT, ModelOutput
from app.providers.openrouter import OpenRouterProvider
from scripts import model_probe as probe
from tests.plan_chat.pc_support import ctx, make_env
from tests.support import make_settings

FAKE_KEY = "sk-or-FAKE-KEY-0123456789"
TODAY = date(2026, 10, 5)
ZERO = {"prompt": "0", "completion": "0", "request": "0", "image": "0"}
PAID = {"prompt": "0.000001", "completion": "0.000002"}
CATALOG = [
    {
        "id": "free/a:free",
        "pricing": ZERO,
        "supported_parameters": ["response_format"],
        "context_length": 131072,
    },
    {
        "id": "free/b:free",
        "pricing": ZERO,
        "supported_parameters": ["tools"],
        "context_length": 32768,
    },
    {"id": "paid/c", "pricing": PAID, "supported_parameters": ["response_format"]},
]
BY_MESSAGE = {s.message: s for s in probe.SCENARIOS}


def completion(content: object, usage: dict | None = None) -> dict:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": usage or {"prompt_tokens": 900, "completion_tokens": 40},
    }


def scenario_of(request: httpx.Request) -> probe.Scenario:
    body = json.loads(request.content)
    payload = json.loads(body["messages"][1]["content"])
    return BY_MESSAGE[payload["messages"][-1]["text"]]


def good_output(scenario: probe.Scenario) -> dict[str, Any]:
    if scenario.expect == "refuse":
        return {"intent": "religious", "reply": ""}
    if scenario.expect == "reject":
        return {"intent": "set_parameters", "parameters": {"sessionMinutes": 45}, "reply": "Done."}
    patch = (
        {"sessionMinutes": 10}
        if scenario.id == "ar_create"
        else {
            "sessionMinutes": 15,
            "order": "reverse",
        }
    )
    return {"intent": "set_parameters", "parameters": patch, "reply": "Plan updated."}


class Router:
    """A fake OpenRouter: the models listing and the completions, with call records."""

    def __init__(
        self,
        models: list[dict] | None = None,
        reply: Callable[[httpx.Request, probe.Scenario], httpx.Response] | None = None,
    ) -> None:
        self.models = CATALOG if models is None else models
        self.reply = reply or (
            lambda request, scenario: httpx.Response(
                200, json=completion(json.dumps(good_output(scenario)))
            )
        )
        self.requests: list[httpx.Request] = []

    @property
    def completions(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith("/chat/completions")]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": self.models})
        return self.reply(request, scenario_of(request))


class Tick:
    """A clock that advances by ``step`` on every read, so each call measures exactly ``step``."""

    def __init__(self, step: float = 0.5) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


def settings(**overrides: Any):
    values: dict[str, Any] = {"OPENROUTER_API_KEY": FAKE_KEY, "OPENROUTER_MODELS": "free/a:free"}
    values.update(overrides)
    return make_settings(**values)


def run_main(
    argv: list[str],
    router: Router,
    *,
    config: Any = None,
    clock: Callable[[], float] | None = None,
    sleeps: list[float] | None = None,
) -> int:
    log = sleeps if sleeps is not None else []
    return probe.main(
        argv,
        settings=config or settings(),
        transport=httpx.MockTransport(router),
        sleep=log.append,
        clock=clock or Tick(),
        today=TODAY,
    )


def test_list_free_prints_only_free_models_and_needs_no_key(capsys) -> None:
    router = Router()
    code = run_main(["--list-free"], router, config=settings(OPENROUTER_API_KEY=None))
    out = capsys.readouterr().out
    assert code == 0
    assert "free/a:free" in out and "free/b:free" in out and "paid/c" not in out
    rows = {line.split()[0]: line.split() for line in out.splitlines() if "free/" in line}
    assert rows["free/a:free"][1:] == ["yes", "131072"]
    assert rows["free/b:free"][1:] == ["no", "32768"]
    (request,) = router.requests
    assert request.url.path.endswith("/models") and "authorization" not in request.headers


def test_list_free_failure_is_exit_7(capsys) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    code = probe.main(
        ["--list-free"], settings=settings(), transport=httpx.MockTransport(down), today=TODAY
    )
    assert code == 7
    assert "ConnectError" in capsys.readouterr().err


@pytest.mark.parametrize(
    "entry",
    [
        {"supported_parameters": ["response_format"]},
        {"supported_parameters": ["structured_outputs"]},
        {"supported_parameters": ["tools"]},
        {"supported_parameters": None},
        {},
    ],
)
def test_structured_detection_matches_the_provider(entry: dict) -> None:
    router = Router(models=[{"id": "m", "pricing": ZERO, **entry}])
    provider = OpenRouterProvider(settings(OPENROUTER_MODELS="m"), httpx.MockTransport(router))
    assert provider.eligible_model(5) == ("m", probe.has_structured_output(entry))


def test_dry_run_sends_nothing_and_prints_the_plan(
    capsys, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    router = Router()
    code = run_main(["--models", "free/a:free,free/b:free"], router)
    out = capsys.readouterr().out
    assert code == 0 and router.requests == []
    assert "Dry run" in out and "SYNTHETIC" in out
    assert "up to 12 (2 models x 6 scenarios x 1 runs)" in out and "runs 1 |" in out
    assert (
        "Uses 12 of the account's shared free daily requests "
        "(live learners draw on the same budget)."
    ) in out
    assert "service input guard: religious" in out and "ar_create" in out
    assert FAKE_KEY not in out and "Bearer" not in out
    assert list(tmp_path.iterdir()) == []  # nothing written without --json


def test_models_default_to_the_settings_and_timeout_to_the_setting(capsys) -> None:
    router = Router()
    code = run_main(
        ["--lang", "en"],
        router,
        config=settings(
            OPENROUTER_MODELS="free/a:free,free/b:free", QATRA_CHAT_MODEL_TIMEOUT_SEC=5
        ),
    )
    out = capsys.readouterr().out
    assert code == 0 and "models (2): free/a:free, free/b:free" in out
    assert "timeout 5s" in out and "ar_create" not in out and "en_revise" in out


def test_missing_key_is_an_error_only_when_sending(capsys) -> None:
    router = Router()
    code = run_main([], router, config=settings(OPENROUTER_API_KEY=None))
    captured = capsys.readouterr()
    assert code == 0 and router.requests == []  # a dry run previews the plan without a key
    assert "Dry run" in captured.out and "OPENROUTER_API_KEY is not set yet" in captured.out
    code = run_main(["--yes"], router, config=settings(OPENROUTER_API_KEY=None))
    assert code == 5 and router.requests == []
    assert "OPENROUTER_API_KEY is not set" in capsys.readouterr().err


def test_plan_over_the_daily_allowance_is_refused(capsys) -> None:
    router = Router()
    code = run_main(["--models", "a,b,c,d", "--runs", "5", "--allow-large", "--yes"], router)
    assert code == 2 and router.requests == []
    assert "exceed the daily free allowance of 50" in capsys.readouterr().err


def test_plan_above_20_requests_needs_allow_large(capsys) -> None:
    router = Router()
    argv = ["--models", "a,b,c,d"]  # 4 models x 6 scenarios x 1 run = 24
    assert run_main([*argv, "--yes"], router) == 2 and router.requests == []
    assert "needs --allow-large" in capsys.readouterr().err
    assert run_main([*argv, "--allow-large"], router) == 0  # dry run
    assert "Uses 24 of the account's shared free daily requests" in capsys.readouterr().out
    assert (
        run_main(["--models", "a,b,c", "--scenarios", "ar_create,en_revise,ar_invalid"], router)
        == 0
    )
    assert "Uses 9 of the account's" in capsys.readouterr().out  # the recommended minimal plan


@pytest.mark.parametrize(
    "argv", [["--runs", "6"], ["--runs", "0"], ["--lang", "fr"], ["--timeout", "0"]]
)
def test_bad_arguments_are_usage_errors(argv: list[str]) -> None:
    assert run_main(argv, Router()) == 2


def test_unknown_scenario_and_no_models_are_usage_errors(capsys) -> None:
    assert run_main(["--scenarios", "nope"], Router()) == 2
    assert run_main([], Router(), config=settings(OPENROUTER_MODELS=None)) == 2
    assert "no candidate models" in capsys.readouterr().err


def test_successful_structured_run_uses_the_real_request_path(capsys) -> None:
    router = Router()
    sleeps: list[float] = []
    code = run_main(
        ["--models", "free/a:free", "--runs", "1", "--yes", "--pause", "4"],
        router,
        config=settings(QATRA_CHAT_MAX_TOKENS=123),
        sleeps=sleeps,
    )
    out = capsys.readouterr().out
    assert code == 0
    assert len(router.completions) == 6 and sleeps == [4.0] * 5
    for call in router.completions:
        body = json.loads(call.content)
        assert body["model"] == "free/a:free" and body["max_tokens"] == 123
        assert body["temperature"] == 0.2
        assert body["messages"][0] == {"role": "system", "content": PLAN_CHAT_SYSTEM_PROMPT}
        assert body["response_format"]["json_schema"]["name"] == "plan_chat_reply"
        assert body["provider"] == {"require_parameters": True}
        assert call.headers["authorization"] == f"Bearer {FAKE_KEY}"
        assert policy.find_disallowed_keys(json.loads(body["messages"][1]["content"])) == []
    row = next(line for line in out.splitlines() if line.startswith("free/a:free"))
    assert "yes" in row and "6/6 (100%)" in row and "900/40" in row
    assert "2/2 (100%)" in row  # validation: the invalid-value scenarios are not counted
    assert "Recommendation (best first): OPENROUTER_MODELS=free/a:free" in out


def test_model_without_documented_structured_output_gets_a_plain_request(capsys) -> None:
    router = Router()
    run_main(
        ["--models", "free/b:free", "--runs", "1", "--yes", "--scenarios", "en_revise"], router
    )
    body = json.loads(router.completions[0].content)
    assert "response_format" not in body and "provider" not in body
    assert (
        "no"
        in next(
            line for line in capsys.readouterr().out.splitlines() if line.startswith("free/b:free")
        ).split()
    )


def test_priced_model_is_ineligible_and_nothing_is_sent(capsys) -> None:
    router = Router()
    code = run_main(["--models", "paid/c", "--runs", "1", "--yes"], router)
    out = capsys.readouterr().out
    assert code == 0 and router.completions == []
    assert "ineligible (nothing sent)" in out and "no model qualified" in out


def test_timeout_is_an_outcome_and_blocks_the_recommendation(capsys, tmp_path: Path) -> None:
    def slow(request: httpx.Request, scenario: probe.Scenario) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    report = tmp_path / "out.json"
    code = run_main(
        ["--models", "free/a:free", "--runs", "1", "--yes", "--json", str(report)],
        Router(reply=slow),
    )
    out = capsys.readouterr().out
    assert code == 0 and "no model qualified" in out and "timeout" in out
    calls = json.loads(report.read_text(encoding="utf-8"))["calls"]
    assert {c["outcome"] for c in calls} == {"timeout"}


def test_invalid_json_is_an_outcome_with_tokens(tmp_path: Path, capsys) -> None:
    router = Router(reply=lambda r, s: httpx.Response(200, json=completion("not json at all")))
    report = tmp_path / "out.json"
    run_main(
        [
            "--models",
            "free/a:free",
            "--runs",
            "1",
            "--yes",
            "--scenarios",
            "ar_create",
            "--json",
            str(report),
        ],
        router,
    )
    data = json.loads(report.read_text(encoding="utf-8"))
    (call,) = data["calls"]
    assert call["outcome"] == "invalid_output" and call["valid_output"] is False
    assert call["input_tokens"] == 900 and data["recommendation"] == []
    assert "no model qualified" in capsys.readouterr().out


def test_http_error_is_an_error_outcome(tmp_path: Path) -> None:
    router = Router(reply=lambda r, s: httpx.Response(429, json={"error": {"message": "limit"}}))
    report = tmp_path / "out.json"
    run_main(
        [
            "--models",
            "free/a:free",
            "--runs",
            "1",
            "--yes",
            "--scenarios",
            "en_revise",
            "--json",
            str(report),
        ],
        router,
    )
    (call,) = json.loads(report.read_text(encoding="utf-8"))["calls"]
    assert call["outcome"] == "error"


def test_server_validation_rejects_an_invalid_value(tmp_path: Path) -> None:
    report = tmp_path / "out.json"
    run_main(
        [
            "--models",
            "free/a:free",
            "--runs",
            "1",
            "--yes",
            "--scenarios",
            "en_invalid",
            "--json",
            str(report),
        ],
        Router(),
    )
    (call,) = json.loads(report.read_text(encoding="utf-8"))["calls"]
    assert call["proposed"] == ["sessionMinutes"] and call["rejected"] == ["sessionMinutes"]
    assert call["params_valid"] is False and call["expectation_met"] is True


def test_guard_replacement_and_a_leak_are_reported(tmp_path: Path) -> None:
    replies = {
        "ar_ruling": {"intent": "question", "reply": "Yes, it is permissible and halal."},
        "en_ruling": {"intent": "question", "reply": "Sure, that works fine."},
    }
    router = Router(
        reply=lambda r, s: httpx.Response(200, json=completion(json.dumps(replies[s.id])))
    )
    report = tmp_path / "out.json"
    run_main(
        [
            "--models",
            "free/a:free",
            "--runs",
            "1",
            "--yes",
            "--scenarios",
            "ar_ruling,en_ruling",
            "--json",
            str(report),
        ],
        router,
    )
    by_scenario = {
        c["scenario"]: c for c in json.loads(report.read_text(encoding="utf-8"))["calls"]
    }
    replaced = by_scenario["ar_ruling"]
    assert replaced["guard_replaced"] is True and replaced["guard_reason"] == "religious"
    assert replaced["expectation_met"] is True
    leaked = by_scenario["en_ruling"]
    assert leaked["guard_replaced"] is False and leaked["expectation_met"] is False


def test_replies_are_in_the_json_report_only_when_asked(tmp_path: Path) -> None:
    for flag, present in (([], False), (["--include-replies"], True)):
        report = tmp_path / f"r{present}.json"
        run_main(
            [
                "--models",
                "free/a:free",
                "--runs",
                "1",
                "--yes",
                "--scenarios",
                "en_revise",
                "--json",
                str(report),
                *flag,
            ],
            Router(),
        )
        data = json.loads(report.read_text(encoding="utf-8"))
        assert data["synthetic"] is True
        assert (data["calls"][0]["reply"] == "Plan updated.") is present


def test_p95_above_the_timeout_blocks_the_recommendation(capsys) -> None:
    code = run_main(
        ["--models", "free/a:free", "--runs", "1", "--yes", "--scenarios", "en_revise"],
        Router(),
        clock=Tick(9.0),
    )
    out = capsys.readouterr().out
    assert code == 0 and "no model qualified" in out and "0/1 (0%)" in out  # within 8s


def test_the_key_is_never_printed_logged_or_written(capsys, tmp_path: Path) -> None:
    def echo(request: httpx.Request, scenario: probe.Scenario) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": f"bad key {FAKE_KEY}"}})

    report = tmp_path / "out.json"
    argv_sets = [
        ["--list-free"],
        ["--models", "free/a:free"],
        ["--models", "free/a:free", "--show-payloads"],
        [
            "--models",
            "free/a:free",
            "--runs",
            "1",
            "--yes",
            "--include-replies",
            "--json",
            str(report),
        ],
    ]
    for argv in argv_sets:
        run_main(argv, Router(reply=echo))
    run_main(["--models", "free/a:free", "--runs", "1", "--yes"], Router())
    captured = capsys.readouterr()
    assert FAKE_KEY not in captured.out + captured.err
    assert "Bearer" not in captured.out + captured.err
    assert FAKE_KEY not in report.read_text(encoding="utf-8")


def test_unexpected_errors_print_only_the_type(capsys, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*args: Any, **kwargs: Any):
        raise RuntimeError(f"secret {FAKE_KEY}")

    monkeypatch.setattr(probe, "run_probe", boom)
    code = run_main(["--models", "free/a:free", "--yes"], Router())
    captured = capsys.readouterr()
    assert code == 1 and "RuntimeError" in captured.err
    assert FAKE_KEY not in captured.out + captured.err


def test_a_payload_with_a_disallowed_key_aborts_the_run(
    capsys, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(policy, "find_disallowed_keys", lambda payload: ["userId"])
    router = Router()
    code = run_main(["--models", "free/a:free", "--yes"], router)
    assert code == 2 and router.requests == []
    assert "userId" in capsys.readouterr().err


# --- scenarios and privacy ------------------------------------------------------------------------


def test_every_payload_passes_the_privacy_allowlist_and_has_no_contact_details() -> None:
    prepared = probe.prepare_scenarios(TODAY, ("ar", "en"))
    assert len(prepared) == 6
    for item in prepared:
        assert policy.find_disallowed_keys(item.payload) == []
        text = json.dumps(item.payload, ensure_ascii=False)
        assert "@" not in text and "http" not in text
        assert policy.redact_contact_details(item.scenario.message) == item.scenario.message


def test_input_guard_classification_of_the_scenarios() -> None:
    expected = {"apply": "logistics", "reject": "logistics", "refuse": "religious"}
    for item in probe.prepare_scenarios(TODAY, ("ar", "en")):
        assert item.input_guard == expected[item.scenario.expect], item.scenario.id


def test_payload_matches_what_the_service_builds() -> None:
    """Drift guard: the script mirrors ``PlanChatService._model_context``."""
    env = make_env()
    for item in probe.prepare_scenarios(TODAY, ("ar", "en")):
        if item.scenario.revision:
            continue  # the service adds the learning record from a real plan; checked below
        chat = env.service._draft_chat(
            ctx(), item.scenario.language, None, item.scenario.message, datetime.now(UTC)
        )
        estimate = compute_estimate(
            item.data,
            ordinals=item.params.target_scope.section_ordinals,
            paths=item.params.paths,
            session_minutes=item.params.session_minutes,
            today=TODAY,
        )
        built = env.service._model_context(ctx(), chat, item.params, item.catalog, estimate)
        expected = built.to_payload()
        actual = dict(item.payload)
        expected.pop("conversationId"), actual.pop("conversationId")
        assert actual == expected, item.scenario.id
    revision = next(i for i in probe.prepare_scenarios(TODAY, ("en",)) if i.scenario.revision)
    assert set(revision.payload["learningRecord"]) == {
        "passages",
        "errorParts",
        "dailyTime",
        "attempts",
    }


def test_interpret_mirrors_the_service_merge_for_a_revision() -> None:
    item = next(i for i in probe.prepare_scenarios(TODAY, ("en",)) if i.scenario.id == "en_revise")
    scope_change = ModelOutput.model_validate(
        {
            "intent": "set_parameters",
            "parameters": {"targetScope": {"sectionOrdinals": [78]}},
            "reply": "Plan updated.",
        }
    )
    view = probe.interpret(scope_change, item)
    assert view.rejected == ("targetScope",) and view.kind == "rejected"  # scope is locked
    assert edition_dto(item.data) == item.catalog
    assert (
        PlanParameters(
            edition_id=item.data.edition_id,
            target_scope=TargetScope(section_ordinals=[s.ordinal for s in item.data.sections]),
            paths=["quran"],
            order="book",
            session_minutes=10,
        )
        == item.params
    )


def test_the_script_imports_no_wiring_or_database_code() -> None:
    code = (
        "import sys, scripts.model_probe;"
        "bad = [m for m in ('app.wiring', 'app.repositories', 'app.main', 'psycopg') "
        "if m in sys.modules];"
        "print(bad); sys.exit(1 if bad else 0)"
    )
    backend = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=backend, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr


# --- recommendation logic -------------------------------------------------------------------------


def summary(model: str, **overrides: Any) -> probe.ModelSummary:
    values: dict[str, Any] = {
        "model": model,
        "ineligible": False,
        "structured": True,
        "sent": 6,
        "ok": 6,
        "success": 6,
        "p50_s": 2.0,
        "p95_s": 4.0,
        "within_timeout": 6,
        "valid_output": 6,
        "params_checked": 4,
        "params_valid": 4,
        "guard_replacements": 0,
        "refusal_checked": 2,
        "refusal_ok": 2,
        "avg_input_tokens": 900.0,
        "avg_output_tokens": 40.0,
        "cost_usd": None,
    }
    values.update(overrides)
    return probe.ModelSummary(**values)


def test_recommendation_orders_best_first_and_excludes_the_unqualified() -> None:
    summaries = [
        summary("slow", p95_s=7.9),
        summary("fast", p95_s=3.0),
        summary("flaky", valid_output=5, ok=5),
        summary("late", p95_s=8.01),
        summary("none", ineligible=True, sent=0, ok=0, valid_output=0, p95_s=None, p50_s=None),
        summary("lenient", params_valid=3),
        summary("chatty", guard_replacements=2, p95_s=1.0),
    ]
    order = probe.recommend(summaries, 8)
    assert order == ["fast", "slow", "chatty", "lenient"]
    assert probe.recommend(summaries[2:5], 8) == []
    assert probe.recommendation_line(order) == (
        "Recommendation (best first): OPENROUTER_MODELS=fast,slow,chatty,lenient"
    )
    assert "no model qualified" in probe.recommendation_line([])


def test_percentile_is_nearest_rank() -> None:
    values = [1.0, 2.0, 3.0, 4.0, 10.0]
    assert probe.percentile(values, 50) == 3.0
    assert probe.percentile(values, 95) == 10.0
    assert probe.percentile([], 50) is None


def test_summarize_counts_outcomes() -> None:
    def rec(outcome: str, latency: float, met: bool | None = None, **kw: Any) -> probe.CallRecord:
        return probe.CallRecord(
            model="m",
            scenario="en_revise",
            run=1,
            outcome=outcome,
            latency_s=latency,
            valid_output=outcome == "ok",
            expectation_met=met,
            **kw,
        )

    records = [rec("ok", 1.0, True), rec("ok", 9.0, False), rec("timeout", 8.0)]
    (result,) = probe.summarize(records, ["m"], 8)
    assert (result.sent, result.ok, result.success, result.within_timeout) == (3, 2, 1, 1)
    assert result.p50_s == 8.0 and result.p95_s == 9.0
