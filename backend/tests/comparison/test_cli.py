"""The operator CLI: dry run, refusals, key handling, selection, report and exit codes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from scripts import ai_comparison as ai
from tests.comparison.cmp_support import (
    FAKE_KEY,
    TODAY,
    Factory,
    Tick,
    World,
    build_world,
    oracle,
    settings,
)


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> World:
    return build_world(tmp_path_factory.mktemp("world"))


def call(
    world: World,
    *extra: str,
    factory: Factory | None = None,
    sleeps: list[float] | None = None,
    transport: httpx.BaseTransport | None = None,
    **setting_values: Any,
) -> int:
    return ai.main(
        world.argv(*extra),
        settings=settings(**setting_values),
        transport=transport,
        provider_factory=factory,
        sleep=(sleeps if sleeps is not None else []).append,
        clock=Tick(),
        today=TODAY,
    )


def no_network(request: httpx.Request) -> httpx.Response:
    pytest.fail(f"a request was sent: {request.url.host}")


# --- dry run --------------------------------------------------------------------------------------


def test_the_default_is_a_dry_run_that_prints_the_plan_and_the_request_count(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = Factory(oracle(world))
    sleeps: list[float] = []
    code = call(world, "--models", "free/a:free", factory=factory, sleeps=sleeps)
    out = capsys.readouterr().out
    assert code == 0
    assert factory.providers == {} and sleeps == []
    assert "Dry run: nothing was sent" in out
    assert "requests to send: up to 12 (1 models x 6 scenarios x 1 runs x 2 calls" in out
    assert "SYNTHETIC scenarios only" in out
    assert "t-late-error (QA case 5): will run" in out
    assert "| المقياس" not in out  # no results in a dry run


def test_a_dry_run_opens_no_connection_even_with_a_key_and_models(world: World) -> None:
    transport = httpx.MockTransport(no_network)
    assert call(world, "--models", "free/a:free", transport=transport) == 0


def test_the_dry_run_with_two_models_asks_for_allow_large(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    transport = httpx.MockTransport(no_network)
    code = call(world, "--models", "a/x:free,b/y:free", transport=transport)
    err = capsys.readouterr().err
    assert code == 2 and "--allow-large" in err  # 24 requests are more than 20


def test_a_dry_run_says_when_no_key_is_set_yet(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    code = call(world, "--models", "free/a:free", OPENROUTER_API_KEY=None)
    out = capsys.readouterr().out
    assert code == 0 and "OPENROUTER_API_KEY is not set yet" in out


def test_without_models_the_dry_run_points_to_the_options(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    code = call(world, OPENROUTER_MODELS=None)
    out = capsys.readouterr().out
    assert code == 0 and "No candidate models" in out and "--local-only" in out


# --- refusals -------------------------------------------------------------------------------------


def test_a_plan_above_the_daily_free_requests_is_refused_even_with_yes(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = Factory(oracle(world))
    code = call(
        world,
        "--models",
        "free/a:free",
        "--yes",
        factory=factory,
        QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY=10,
    )
    err = capsys.readouterr().err
    assert code == 2 and "exceed the daily free allowance of 10" in err
    assert factory.providers == {}


def test_the_refusal_also_applies_to_a_dry_run(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    code = call(world, "--models", "free/a:free", QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY=11)
    assert code == 2 and "exceed" in capsys.readouterr().err


def test_more_than_twenty_requests_need_allow_large(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = Factory(oracle(world))
    code = call(world, "--models", "a/x:free,b/y:free", "--yes", factory=factory)
    assert code == 2 and "--allow-large" in capsys.readouterr().err
    assert factory.providers == {}
    code = call(world, "--models", "a/x:free,b/y:free", "--yes", "--allow-large", factory=factory)
    assert code == 0 and len(factory.calls) == 24


def test_yes_without_a_key_sends_nothing(world: World, capsys: pytest.CaptureFixture[str]) -> None:
    code = call(
        world,
        "--models",
        "free/a:free",
        "--yes",
        transport=httpx.MockTransport(no_network),
        OPENROUTER_API_KEY=None,
    )
    err = capsys.readouterr().err
    assert code == 5 and "OPENROUTER_API_KEY is not set" in err


@pytest.mark.parametrize("argument", [["--runs", "4"], ["--runs", "0"], ["--pause", "-1"]])
def test_bad_numbers_are_usage_errors(world: World, argument: list[str]) -> None:
    assert call(world, *argument) == 2


def test_an_unknown_scenario_in_only_is_a_usage_error(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    assert call(world, "--only", "t-one,nope", "--local-only") == 2
    assert "nope" in capsys.readouterr().err


# --- the key is never printed ---------------------------------------------------------------------


def test_the_key_never_appears_in_any_output_or_report(
    world: World, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    report = tmp_path / "report.json"
    sources = {
        "dry run": (["--models", "free/a:free", "--show-payloads"], Factory(oracle(world))),
        "error text": (
            ["--models", "free/a:free", "--yes", "--json", str(report)],
            Factory(lambda kind, payload: RuntimeError(f"upstream said {FAKE_KEY}")),
        ),
        "normal": (
            ["--models", "free/a:free", "--yes", "--json", str(report), "--show-payloads"],
            Factory(oracle(world)),
        ),
    }
    for argv, factory in sources.values():
        assert call(world, *argv, factory=factory) == 0
        captured = capsys.readouterr()
        assert FAKE_KEY not in captured.out and FAKE_KEY not in captured.err
        if report.exists():
            assert FAKE_KEY not in report.read_text(encoding="utf-8")
    assert FAKE_KEY not in repr(settings())  # the secret type hides it in a repr as well


def test_an_unexpected_failure_prints_only_the_exception_type(
    world: World, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError(f"leaked {FAKE_KEY}")

    monkeypatch.setattr(ai, "plan_scenarios", boom)
    assert call(world, "--local-only") == 1
    captured = capsys.readouterr()
    assert "RuntimeError" in captured.err and FAKE_KEY not in captured.err + captured.out


# --- running --------------------------------------------------------------------------------------


def test_a_real_run_with_a_fake_model_prints_the_two_tables(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = Factory(oracle(world))
    sleeps: list[float] = []
    code = call(
        world, "--models", "free/a:free", "--yes", "--pause", "1", factory=factory, sleeps=sleeps
    )
    out = capsys.readouterr().out
    assert code == 0 and len(factory.calls) == 12 and sleeps == [1.0] * 11
    assert "| المقياس | الخطة الثابتة | خطة القواعد | خطة AI (free/a:free) |" in out
    assert "| النموذج | عدد الاستدعاءات المقاسة |" in out
    assert "| free/a:free | 12 | 900 | 40 | 0 | 6/6 | 0/6 |" in out
    assert f"expectations sha256: {ai.load_expectations(world.expectations_path)[1]}" in out


def test_local_only_scores_the_baselines_without_a_model_or_a_key(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    code = call(
        world,
        "--local-only",
        transport=httpx.MockTransport(no_network),
        OPENROUTER_API_KEY=None,
        OPENROUTER_MODELS=None,
    )
    out = capsys.readouterr().out
    assert code == 0
    assert "N/A | N/A | Not run" in out and "requests to send: up to 0" in out


def test_only_selects_scenarios_and_marks_the_rest_not_run(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    factory = Factory(oracle(world))
    code = call(world, "--models", "free/a:free", "--yes", "--only", "t-absent,5", factory=factory)
    out = capsys.readouterr().out
    assert code == 0 and len(factory.calls) == 4  # t-absent and QA case 5 (t-late-error)
    assert "t-one (not_selected)" in out and "Not run (excluded from every denominator)" in out


def test_the_json_report_has_the_tables_the_runs_and_the_pin(world: World, tmp_path: Path) -> None:
    report_path = tmp_path / "out" / "report.json"
    report_path.parent.mkdir()
    code = call(
        world,
        "--models",
        "free/a:free",
        "--yes",
        "--json",
        str(report_path),
        "--runs",
        "2",
        "--only",
        "t-one",
        factory=Factory(oracle(world)),
    )
    assert code == 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["tool"] == "ai_comparison" and report["synthetic"] is True
    assert report["expectationsSha256"] == ai.load_expectations(world.expectations_path)[1]
    assert report["requestsSent"] == 4 and report["settings"]["runs"] == 2
    assert report["settings"]["localOnly"] is False and "key" not in json.dumps(report).lower()
    assert report["costTable"][0]["model"] == "free/a:free" and report["costTable"][0]["calls"] == 4
    assert {"fixed", "rules", "ai:free/a:free"} == set(report["table"]["columns"])
    assert sum(1 for r in report["runs"] if r["alternative"] == "ai") == 2


def test_an_unwritable_report_path_is_a_usage_error(
    world: World, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = call(world, "--local-only", "--json", str(tmp_path / "missing" / "dir" / "r.json"))
    assert code == 2 and "cannot write the --json report" in capsys.readouterr().err


def test_the_goal_language_chooses_the_synthetic_sentence(world: World) -> None:
    factory = Factory(oracle(world))
    code = call(
        world,
        "--models",
        "free/a:free",
        "--yes",
        "--only",
        "t-one",
        "--goal-lang",
        "ar",
        factory=factory,
    )
    goal = next(c for c in factory.calls if c["kind"] == "goal")
    assert goal["payload"]["goalText"] == world.prepared["t-one"].scenario.goal_text_ar
    assert code == 0  # the oracle knows only the English sentence: that run just fails the goal


# --- fixtures and the free catalog ----------------------------------------------------------------


def test_missing_or_damaged_fixture_files_exit_4_and_name_no_value(
    world: World, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing = ai.main(
        [
            "--scenarios-file",
            str(tmp_path / "none.json"),
            "--expectations",
            str(world.expectations_path),
        ],
        settings=settings(),
    )
    assert missing == 4 and "unreadable" in capsys.readouterr().err
    broken = tmp_path / "broken.json"
    broken.write_text('{"scenarios": [{"scenarioId": "x"}]}', encoding="utf-8")
    code = ai.main(
        ["--scenarios-file", str(broken), "--expectations", str(world.expectations_path)],
        settings=settings(),
    )
    assert code == 4 and capsys.readouterr().err.startswith("error: fixture broken.json")


def test_list_free_prints_the_free_catalog_without_a_key(
    capsys: pytest.CaptureFixture[str],
) -> None:
    zero = {"prompt": "0", "completion": "0", "request": "0"}
    catalog = {
        "data": [
            {"id": "free/a:free", "pricing": zero, "supported_parameters": ["response_format"]},
            {"id": "paid/c", "pricing": {"prompt": "0.001", "completion": "0.002"}},
        ]
    }
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=catalog))
    code = ai.main(["--list-free"], settings=settings(OPENROUTER_API_KEY=None), transport=transport)
    out = capsys.readouterr().out
    assert code == 0 and "free/a:free" in out and "paid/c" not in out


def test_list_free_reports_an_unreadable_catalog(capsys: pytest.CaptureFixture[str]) -> None:
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    assert ai.main(["--list-free"], settings=settings(), transport=transport) == 7
    assert "could not read the OpenRouter catalog" in capsys.readouterr().err


def test_a_clean_run_of_the_committed_fixtures_is_a_dry_run_by_default(
    capsys: pytest.CaptureFixture[str],
) -> None:
    code = ai.main(["--models", "free/a:free"], settings=settings(), today=TODAY)
    out = capsys.readouterr().out
    assert code == 0 and "requests to send: up to 20 (1 models x 10 scenarios" in out
    assert "Dry run: nothing was sent" in out
