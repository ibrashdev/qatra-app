"""CLI registration, exit codes and the registered-but-not-implemented commands."""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

import scripts.content_tools as cli
from app.workflow.errors import ExitCode
from app.workflow.jobs import LocalJobRepository, new_job
from app.workflow.paths import BuildPaths
from tests.workflow.wf_support import (
    HADITH_ED,
    QURAN_ED,
    quran_args,
    run_cli,
)

BACKEND = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
ORDER = ["acquired", "verified", "segmented", "bank_built", "validated", "approved", "published"]
PASSED = {"method": "m", "result": "passed", "details": ""}
FAILED = {"method": "m", "result": "failed", "details": ""}
SECRET = "service-role-secret-do-not-leak"
ALL_COMMANDS = [
    "acquire",
    "verify",
    "segment",
    "propose-questions",
    "build-bank",
    "validate",
    "approve",
    "publish",
    "withdraw",
    "archive",
    "delete-unused-draft",
]
EXTRA = {
    "approve": [
        "--reviewer",
        "owner",
        "--review-scope",
        "automated gates only",
        "--note",
        "note",
        "--owner-words",
        "words typed by the owner",
        "--source",
        "https://claude.ai/code/session_test",
        "--at",
        "2026-10-04T12:02:00+00:00",
    ],
    "withdraw": ["--reason", "rights"],
    "acquire": ["--records", "unused.json"],
}
APPROVAL = {
    "who": "owner",
    "at": "2026-10-04T12:00:00Z",
    "note": "n",
    "scope": "s",
    "words": "w",
    "source": "https://claude.ai/code/session_test",
}


def seed(
    build: Path,
    steps: list[str],
    *,
    verification: dict[str, Any] | None = PASSED,
    approval: dict[str, Any] | None = None,
) -> None:
    repo = LocalJobRepository(BuildPaths(build))
    for step in steps:
        job = new_job(QURAN_ED, 1, step, now=NOW, status="succeeded")
        summary: dict[str, Any] = {}
        if step == "verified" and verification is not None:
            summary["verification"] = verification
        if step == "approved":
            summary["approval"] = approval if approval is not None else APPROVAL
        repo.save_job(job.model_copy(update={"validation_summary": summary or None}))


def stub(command: str, build: Path, *, interactive: bool = True) -> int:
    extra = EXTRA.get(command, [])
    if command == "publish":
        extra = ["--sql-out", str(build / "publish-final.sql")]
    argv = [command, "--edition", QURAN_ED, "--bank-version", "1", *extra]
    return run_cli(argv, build, interactive=interactive)


def files(build: Path) -> list[str]:
    return sorted(str(p.relative_to(build)) for p in build.rglob("*")) if build.exists() else []


def test_all_commands_are_registered_with_help() -> None:
    parser = cli.build_parser()
    action = next(
        a for a in parser._actions if getattr(a, "choices", None) and "acquire" in a.choices
    )
    assert sorted(action.choices) == sorted(ALL_COMMANDS)
    assert tuple(cli.COMMANDS) == tuple(ALL_COMMANDS)
    for command in ALL_COMMANDS:
        with pytest.raises(SystemExit) as exit_info:
            parser.parse_args([command, "--help"])
        assert exit_info.value.code == 0


def test_usage_errors_exit_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    run = lambda argv: run_cli(argv, tmp_path)  # noqa: E731
    assert run([]) == 2
    assert run(["frobnicate"]) == 2
    assert run(["segment"]) == 2  # --edition and --bank-version are required
    assert run(["segment", "--edition", "no-such-edition", "--bank-version", "1"]) == 2
    assert run(["segment", "--edition", QURAN_ED]) == 2
    for bad in ("0", "-1", "abc", "1.5"):
        assert run(["segment", "--edition", QURAN_ED, "--bank-version", bad]) == 2
    assert (
        run(["acquire", "--edition", QURAN_ED, "--bank-version", "1"]) == 2
    )  # no --records/--http
    assert (
        run(["acquire", "--edition", QURAN_ED, "--bank-version", "1", "--records", "a", "--http"])
        == 2
    )
    assert run(["approve", "--edition", QURAN_ED, "--bank-version", "1"]) == 2
    assert run(["withdraw", "--edition", QURAN_ED, "--bank-version", "1"]) == 2
    assert run(["withdraw", "--edition", QURAN_ED, "--bank-version", "1", "--reason", "other"]) == 2
    capsys.readouterr()
    assert files(tmp_path) == []


def test_exit_code_table_is_documented_and_stable() -> None:
    assert {c.name: int(c) for c in ExitCode} == {
        "OK": 0,
        "UNEXPECTED": 1,
        "USAGE": 2,
        "PRECONDITION": 3,
        "VERIFICATION_FAILED": 4,
        "NOT_CONFIGURED": 5,
        "NOT_IMPLEMENTED": 6,
        "SOURCE_UNREACHABLE": 7,
    }
    doc = cli.__doc__ or ""
    for code in range(8):
        assert re.search(rf"^{code}\s+\S", doc, re.MULTILINE), f"exit code {code} is not documented"
    assert "not implemented in B7 (B8/C6)" in doc


@pytest.mark.parametrize(
    "command", ["segment", "build-bank", "validate", "approve", "publish", "withdraw", "archive"]
)
def test_registered_commands_refuse_a_step_order_violation_with_exit_3(
    tmp_path: Path, command: str, capsys: pytest.CaptureFixture[str]
) -> None:
    assert stub(command, tmp_path) == ExitCode.PRECONDITION
    err = capsys.readouterr().err
    assert "refused" in err and "not implemented" not in err
    assert files(tmp_path) == []  # nothing was written


@pytest.mark.parametrize(
    ("command", "done"),
    [
        ("withdraw", ORDER),
        ("archive", ORDER),
    ],
)
def test_registered_commands_exit_6_when_their_preconditions_hold(
    tmp_path: Path, command: str, done: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    seed(tmp_path, done)
    before = (tmp_path / QURAN_ED / "jobs.json").read_bytes()
    assert stub(command, tmp_path) == ExitCode.NOT_IMPLEMENTED
    assert "not implemented in B7 (B8/C6)" in capsys.readouterr().err
    assert (tmp_path / QURAN_ED / "jobs.json").read_bytes() == before  # nothing recorded


def test_approve_and_publish_are_implemented_and_no_longer_exit_6(tmp_path: Path) -> None:
    seed(tmp_path, ORDER[:5])
    assert stub("approve", tmp_path) != ExitCode.NOT_IMPLEMENTED
    assert stub("publish", tmp_path) != ExitCode.NOT_IMPLEMENTED


def test_approve_needs_a_validated_edition_and_passed_verification(tmp_path: Path) -> None:
    seed(tmp_path, ORDER[:5], verification=FAILED)
    assert stub("approve", tmp_path) == ExitCode.PRECONDITION
    other = tmp_path / "no-verification"
    seed(other, ORDER[:5], verification=None)
    assert stub("approve", other) == ExitCode.PRECONDITION


def test_publish_refuses_without_a_recorded_approval(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    seed(tmp_path, ORDER[:5])  # validated and verified, but nobody approved
    assert stub("publish", tmp_path) == ExitCode.PRECONDITION
    assert "approved" in capsys.readouterr().err
    assert not (tmp_path / "publish-final.sql").exists()


def test_publish_refuses_an_approval_entry_that_is_incomplete(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    old_shape = {"who": "owner", "at": "2026-10-04T12:00:00Z", "note": "n"}
    seed(tmp_path, ORDER[:6], approval=old_shape)
    assert stub("publish", tmp_path) == ExitCode.PRECONDITION
    assert "approval_incomplete" in capsys.readouterr().err
    assert not (tmp_path / "publish-final.sql").exists()


def test_published_versions_cannot_be_rerun_or_republished(tmp_path: Path) -> None:
    seed(tmp_path, ORDER)
    assert stub("publish", tmp_path) == ExitCode.PRECONDITION
    assert stub("segment", tmp_path) == ExitCode.PRECONDITION
    assert stub("approve", tmp_path) == ExitCode.PRECONDITION


def test_withdraw_and_archive_audit_rules(tmp_path: Path) -> None:
    seed(tmp_path, [*ORDER, "withdrawn"])
    assert stub("archive", tmp_path) == ExitCode.PRECONDITION  # a revoked edition is not published
    assert stub("withdraw", tmp_path) == ExitCode.PRECONDITION  # already withdrawn
    other = tmp_path / "archived"
    seed(other, [*ORDER, "archived"])
    assert stub("archive", other) == ExitCode.PRECONDITION
    assert stub("withdraw", other) == ExitCode.NOT_IMPLEMENTED


def test_delete_unused_draft_rules(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert stub("delete-unused-draft", tmp_path) == ExitCode.NOT_IMPLEMENTED  # an unused draft
    assert "not implemented in B7 (B8/C6)" in capsys.readouterr().err
    assert files(tmp_path) == []
    validated = tmp_path / "validated"
    seed(validated, ORDER[:5])
    assert stub("delete-unused-draft", validated) == ExitCode.PRECONDITION
    published = tmp_path / "published"
    seed(published, ORDER)
    assert stub("delete-unused-draft", published) == ExitCode.PRECONDITION
    assert "ever published" in capsys.readouterr().err


# --- configuration -------------------------------------------------------------------------


@pytest.mark.parametrize("command", ["acquire", "verify", "segment"])
def test_supabase_backend_without_variables_is_exit_5(
    tmp_path: Path, command: str, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = [command, "--edition", QURAN_ED, "--bank-version", "1", "--data-backend", "supabase"]
    if command == "acquire":
        argv += ["--records", "unused.json"]
    assert run_cli(argv, tmp_path, environ={}) == ExitCode.NOT_CONFIGURED
    assert files(tmp_path) == []


def test_supabase_backend_with_variables_is_still_exit_5_in_b7_and_never_prints_the_key(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    environ = {"SUPABASE_URL": "https://project.example", "SUPABASE_SERVICE_ROLE_KEY": SECRET}
    argv = quran_args("segment", "--data-backend", "supabase")
    assert run_cli(argv, tmp_path, environ=environ) == ExitCode.NOT_CONFIGURED
    captured = capsys.readouterr()
    assert "not available in B7" in captured.err
    assert SECRET not in captured.out + captured.err


def test_qatra_data_backend_variable_selects_supabase_when_the_flag_is_absent(
    tmp_path: Path,
) -> None:
    code = run_cli(quran_args("segment"), tmp_path, environ={"QATRA_DATA_BACKEND": "supabase"})
    assert code == ExitCode.NOT_CONFIGURED
    assert run_cli(quran_args("segment"), tmp_path, environ={"QATRA_DATA_BACKEND": "memory"}) == 3


def test_a_malformed_supabase_url_is_exit_5_without_echoing_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    environ = {"SUPABASE_URL": "http://leaky.example/path", "SUPABASE_SERVICE_ROLE_KEY": SECRET}
    assert (
        run_cli(quran_args("segment", "--data-backend", "supabase"), tmp_path, environ=environ) == 5
    )
    captured = capsys.readouterr()
    assert (
        "leaky.example" not in captured.out + captured.err
        and SECRET not in captured.out + captured.err
    )


def test_unexpected_errors_print_only_the_exception_type(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(ctx: Any) -> int:
        raise RuntimeError("this message could contain source text")

    monkeypatch.setattr(cli, "_cmd_not_implemented", boom)
    assert stub("archive", tmp_path) == ExitCode.UNEXPECTED
    captured = capsys.readouterr()
    assert "RuntimeError" in captured.err and "source text" not in captured.err + captured.out


# --- entry points --------------------------------------------------------------------------


def test_script_and_module_entry_points_work(tmp_path: Path) -> None:
    as_script = subprocess.run(
        [sys.executable, "scripts/content_tools.py", "--help"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        check=False,
    )
    assert as_script.returncode == 0
    assert "acquire" in as_script.stdout and "delete-unused-draft" in as_script.stdout
    as_module = subprocess.run(
        [sys.executable, "-m", "scripts.content_tools", "segment"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        check=False,
    )
    assert as_module.returncode == 2 and "--edition" in as_module.stderr
    elsewhere = subprocess.run(
        [sys.executable, str(BACKEND / "scripts" / "content_tools.py"), "verify"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert elsewhere.returncode == 2  # the path shim finds ``app`` from any directory


def test_hadith_edition_commands_use_the_same_rules(tmp_path: Path) -> None:
    argv = ["segment", "--edition", HADITH_ED, "--bank-version", "1"]
    assert run_cli(argv, tmp_path) == ExitCode.PRECONDITION
