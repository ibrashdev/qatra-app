"""``approve``: the owner's approval recorded only from explicit inputs.

The owner types the approval in the Claude Code chat; those words, recorded verbatim with their
source, time, reviewer, review scope and a note, are the confirmation (coordinator decision). Any
missing or empty input is a refusal; nothing is inferred from silence, a timeout or a default.
Synthetic data only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import scripts.content_tools as cli
from app.workflow.errors import ExitCode
from app.workflow.models import derive_edition_state
from tests.workflow.wf_d83_support import (
    FAILED,
    LABELS,
    ORDER,
    OWNER_WORDS,
    SESSION_URL,
    approve_argv,
    quran_to_validated,
    rows,
    seed_rows,
)
from tests.workflow.wf_support import QURAN_ED, load_json, quran_args, run_cli, write_json

APPROVAL_KEYS = ["who", "at", "note", "scope", "words", "source"]
TRICKY_WORDS = 'Approved: "go ahead", it\'s fine; `no` $shell ‘quotes’ and\nline two'


@pytest.fixture
def validated(tmp_path: Path) -> Path:
    build = tmp_path / "build"
    quran_to_validated(build)
    return build


def approved_entry(build: Path) -> dict[str, Any]:
    return rows(build, QURAN_ED)["approved"].validation_summary["approval"]


def test_approve_records_the_six_explicit_inputs_verbatim(
    validated: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle_before = (validated / QURAN_ED / "bundle.json").read_bytes()
    capsys.readouterr()
    argv = approve_argv(words=TRICKY_WORDS, at="2026-10-04T16:03:00+04:00")
    assert run_cli(argv, validated) == 0
    captured = capsys.readouterr()
    assert "approve quran-hafs-quranenc bank_version=1 status=succeeded changed=yes" in captured.out
    assert "approvals=1" in captured.out and "units=4" in captured.out
    assert TRICKY_WORDS not in captured.out + captured.err  # the CLI never prints the words
    assert "go ahead" not in captured.out + captured.err

    entry = approved_entry(validated)
    assert sorted(entry) == sorted(APPROVAL_KEYS)  # exactly these six (jobs.json sorts its keys)
    assert entry == {
        "who": "owner (recorded by the coordinator)",
        "at": "2026-10-04T16:03:00+04:00",
        "note": "approved after the build report",
        "scope": "automated gates; no human text comparison",
        "words": TRICKY_WORDS,
        "source": SESSION_URL,
    }
    jobs = rows(validated, QURAN_ED)
    approved = jobs["approved"]
    assert approved.status == "succeeded"
    assert approved.validation_summary["reviewRecordEntry"] == {"approval": entry}
    # the approval is bound to the exact bundle that validate accepted
    assert approved.cursor["bundleSha256"] == jobs["validated"].cursor["bundleSha256"]
    assert (
        approved.validation_summary["contentHash"]
        == json.loads((validated / QURAN_ED / "bundle.json").read_text(encoding="utf-8"))[
            "edition"
        ]["contentHash"]
    )
    assert approved.validation_summary["verification"]["result"] == "passed"
    assert (validated / QURAN_ED / "bundle.json").read_bytes() == bundle_before
    state = derive_edition_state(QURAN_ED, 1, list(jobs.values()))
    assert state.approval_recorded and state.status == "validated"


def test_a_non_interactive_run_is_fine_because_the_recorded_words_are_the_confirmation(
    validated: Path,
) -> None:
    assert cli.CliRuntime(stdin_isatty=lambda: False).interactive() is False
    assert run_cli(approve_argv(), validated, interactive=False) == 0


def test_the_words_may_come_from_a_utf8_file(validated: Path, tmp_path: Path) -> None:
    words_file = tmp_path / "words.txt"
    words_file.write_text(TRICKY_WORDS + "\n", encoding="utf-8")
    argv = approve_argv(words=None) + ["--owner-words-file", str(words_file)]
    assert run_cli(argv, validated) == 0
    assert approved_entry(validated)["words"] == TRICKY_WORDS  # the final line break is dropped


def test_words_that_start_with_a_hyphen_use_the_equals_form_or_a_file(validated: Path) -> None:
    hyphen = "-approved"  # no space: the argument parser takes it for an option
    assert run_cli(approve_argv(words=hyphen), validated) == ExitCode.USAGE
    assert "approved" not in rows(validated, QURAN_ED)
    argv = approve_argv(words=None) + [f"--owner-words={hyphen}"]
    assert run_cli(argv, validated) == 0
    assert approved_entry(validated)["words"] == hyphen


@pytest.mark.parametrize("omitted", ["words", "at", "source", "reviewer", "scope", "note"])
def test_every_missing_input_is_a_refusal_and_records_nothing(
    validated: Path, omitted: str, capsys: pytest.CaptureFixture[str]
) -> None:
    before = (validated / QURAN_ED / "jobs.json").read_bytes()
    argv = approve_argv(**{omitted: None})
    assert run_cli(argv, validated) == ExitCode.USAGE
    capsys.readouterr()
    assert (validated / QURAN_ED / "jobs.json").read_bytes() == before
    assert "approved" not in rows(validated, QURAN_ED)


@pytest.mark.parametrize("empty", ["words", "at", "source", "reviewer", "scope", "note"])
@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_every_empty_input_is_a_refusal_and_records_nothing(
    validated: Path, empty: str, blank: str, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run_cli(approve_argv(**{empty: blank}), validated) == ExitCode.USAGE
    err = capsys.readouterr().err
    assert "missing or empty" in err and OWNER_WORDS not in err
    assert "approved" not in rows(validated, QURAN_ED)


def test_words_and_a_words_file_together_or_an_unreadable_file_are_refused(
    validated: Path, tmp_path: Path
) -> None:
    words_file = tmp_path / "words.txt"
    words_file.write_text("x", encoding="utf-8")
    both = approve_argv() + ["--owner-words-file", str(words_file)]
    assert run_cli(both, validated) == ExitCode.USAGE
    missing = approve_argv(words=None) + ["--owner-words-file", str(tmp_path / "none.txt")]
    assert run_cli(missing, validated) == ExitCode.USAGE
    empty = tmp_path / "empty.txt"
    empty.write_text("\n", encoding="utf-8")
    assert run_cli(approve_argv(words=None) + ["--owner-words-file", str(empty)], validated) == 2
    binary = tmp_path / "binary.txt"
    binary.write_bytes(b"\xff\xfe\x00")
    assert run_cli(approve_argv(words=None) + ["--owner-words-file", str(binary)], validated) == 2
    nul = tmp_path / "nul.txt"
    nul.write_bytes(b"ok\x00ok")
    assert run_cli(approve_argv(words=None) + ["--owner-words-file", str(nul)], validated) == 2
    assert "approved" not in rows(validated, QURAN_ED)


@pytest.mark.parametrize(
    "at",
    [
        "yesterday",
        "2026-10-04",  # a date, no time
        "2026-10-04T12:03:00",  # no time zone
        "04/10/2026 12:03 +04:00",
        "2026-10-04T13:00:00+00:00",  # in the future (the clock reads 12:01)
    ],
)
def test_the_time_must_be_iso_8601_with_a_zone_and_not_in_the_future(
    validated: Path, at: str
) -> None:
    assert run_cli(approve_argv(at=at), validated) == ExitCode.USAGE
    assert "approved" not in rows(validated, QURAN_ED)


def test_a_utc_z_suffix_is_accepted_and_kept_as_z(validated: Path) -> None:
    assert run_cli(approve_argv(at="2026-10-04T12:03:00Z"), validated) == 0
    assert approved_entry(validated)["at"] == "2026-10-04T12:03:00Z"


def test_an_approval_that_predates_the_validation_it_would_cover_is_refused(
    validated: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run_cli(approve_argv(at="2026-10-04T11:59:00+00:00"), validated) == 3
    assert "earlier than the validation" in capsys.readouterr().err
    assert "approved" not in rows(validated, QURAN_ED)


@pytest.mark.parametrize(
    "source",
    [
        "http://claude.ai/code/session_test",  # not https
        "claude.ai/code/session_test",
        "https://user:secret@claude.ai/code/session_test",
        "https://claude.ai/code/session test",
        "https:///code/session_test",
    ],
)
def test_the_source_must_be_an_https_session_url_without_credentials(
    validated: Path, source: str, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run_cli(approve_argv(source=source), validated) == ExitCode.USAGE
    assert "secret" not in capsys.readouterr().err
    assert "approved" not in rows(validated, QURAN_ED)


def test_an_over_long_input_is_refused(validated: Path) -> None:
    assert run_cli(approve_argv(words="w" * 5001), validated) == ExitCode.USAGE
    assert run_cli(approve_argv(note="n" * 2001), validated) == ExitCode.USAGE
    assert run_cli(approve_argv(words="w" * 5000), validated) == 0


# --- preconditions (content_policy.assert_approvable) ---------------------------------------


def test_approve_needs_a_validated_edition(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    seed_rows(build, ORDER[:4])  # up to bank_built: not validated
    assert run_cli(approve_argv(), build) == ExitCode.PRECONDITION
    assert "'approved' requires step 'validated'" in capsys.readouterr().err


def test_approve_needs_every_verification_result_to_be_passed(tmp_path: Path) -> None:
    build = tmp_path / "build"
    seed_rows(build, ORDER[:5], verification=FAILED)
    assert run_cli(approve_argv(), build) == ExitCode.PRECONDITION
    assert "approved" not in rows(build, QURAN_ED)


def test_approve_is_refused_on_a_published_version(tmp_path: Path) -> None:
    build = tmp_path / "build"
    seed_rows(build, ORDER)
    assert run_cli(approve_argv(), build) == ExitCode.PRECONDITION


def test_approve_refuses_a_bundle_that_changed_after_validation(
    validated: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = validated / QURAN_ED / "bundle.json"
    text = bundle.read_text(encoding="utf-8")
    assert '"bankVersion": 1,' in text
    bundle.write_text(text.replace('"bankVersion": 1,', '"bankVersion": 2,', 1), encoding="utf-8")
    capsys.readouterr()
    assert run_cli(approve_argv(), validated) == ExitCode.PRECONDITION
    assert "no longer is the bundle" in capsys.readouterr().err
    assert "approved" not in rows(validated, QURAN_ED)


# --- idempotency ----------------------------------------------------------------------------


def test_repeating_the_same_approval_changes_nothing_and_new_words_replace_it(
    validated: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run_cli(approve_argv(), validated) == 0
    before = (validated / QURAN_ED / "jobs.json").read_bytes()
    capsys.readouterr()
    assert run_cli(approve_argv(), validated) == 0
    assert "changed=no" in capsys.readouterr().out
    assert (validated / QURAN_ED / "jobs.json").read_bytes() == before
    assert run_cli(approve_argv(words="other words"), validated) == 0
    assert "changed=yes" in capsys.readouterr().out
    assert approved_entry(validated)["words"] == "other words"


def test_a_changed_earlier_step_removes_the_approval(validated: Path, tmp_path: Path) -> None:
    """An approval never survives changed inputs: a different segmentation resets it."""
    assert run_cli(approve_argv(), validated) == 0
    assert rows(validated, QURAN_ED)["approved"].status == "succeeded"
    labels = load_json(LABELS)
    titles = labels["editions"][QURAN_ED]["sectionTitlesAr"]
    titles["112"] = titles["112"] + "x"  # another section title: another structure
    changed = write_json(tmp_path / "labels2.json", labels)
    assert run_cli(quran_args("segment", "--labels", str(changed)), validated) == 0
    jobs = rows(validated, QURAN_ED)
    assert jobs["approved"].status == "pending" and jobs["approved"].validation_summary is None
    assert jobs["validated"].status == "pending"
    assert not derive_edition_state(QURAN_ED, 1, list(jobs.values())).approval_recorded
