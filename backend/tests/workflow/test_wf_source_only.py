"""Source-only verification (D83): two HTTP acquisitions from the service replace the oracle and
the skeleton, for exactly surah 112 and Forty hadith 1 at bank version 1.

No network: HTTP paths use httpx.MockTransport. Synthetic placeholder text only.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.workflow import source_only
from app.workflow.editions import EDITION_HADITH, EDITION_QURAN, EditionScope
from app.workflow.errors import ExitCode, InputError, PreconditionError
from tests.workflow.wf_d83_support import (
    D83_HADITH_ID,
    HADITH_RESPONSE,
    ORACLE,
    QURAN_RECORDS,
    QURAN_RESPONSE,
    SYNTHETIC_HADITH_ID,
    McpMock,
    acquire_hadith_http,
    acquire_quran_http,
    hadith_text,
    id_map,
    not_nfc,
    quran_verses,
    rows,
    single_hadith_records,
    surah_text,
)
from tests.workflow.wf_support import (
    HADITH_ED,
    QURAN_ED,
    all_report_text,
    assert_no_source_text,
    hadith_args,
    load_json,
    quran_args,
    run_cli,
)

SOURCE_ONLY = ("--source-only-decision", "D83")
HOST = "mcp.islamiccontent.org"


def quran_server(*answers: str) -> McpMock:
    return McpMock({("get_quran_verses", 112): list(answers or [QURAN_RESPONSE])})


def hadith_server(*answers: str) -> McpMock:
    return McpMock({("get_hadith", D83_HADITH_ID): list(answers or [hadith_text(D83_HADITH_ID)])})


def verify_quran(build: Path, server: McpMock, *extra: str) -> int:
    args = quran_args("verify", *SOURCE_ONLY, "--http-recheck", *extra)
    return run_cli(args, build, transport=httpx.MockTransport(server))


# --- Quran ---------------------------------------------------------------------------------


def test_quran_two_http_acquisitions_verify_the_surah(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = quran_server()
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    capsys.readouterr()
    assert verify_quran(build, server) == 0
    out = capsys.readouterr().out
    assert "units=4" in out and "passed=4" in out and "failed=0" in out
    assert "acquisitions=2" in out and "source_only=D83" in out

    summary = rows(build, QURAN_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == "source_only(D83):http_reacquisition_byte_equality"
    assert summary["verification"]["result"] == "passed"
    assert summary["sourceOnly"]["decision"] == "D83"
    stored, again = summary["sourceOnly"]["acquisitions"]
    assert (stored["role"], again["role"]) == ("stored", "reacquired")
    assert stored["acquisition"] == again["acquisition"] == "http"
    assert stored["rawSha256"] == again["rawSha256"] and again["equalToStored"] is True
    assert summary["sourceOnly"]["priorEvidence"]["decision"] == "D68"
    assert "King Fahd" in summary["sourceOnly"]["priorEvidence"]["note"]
    assert summary["reviewRecordEntry"]["verification"]["decision"] == "D83"
    assert (
        summary["reviewRecordEntry"]["verification"]["method"] == summary["verification"]["method"]
    )

    verification = json.loads((build / QURAN_ED / "verification.json").read_text(encoding="utf-8"))
    assert verification["sourceOnlyDecision"] == "D83"
    assert {u["method"] for u in verification["units"]} == {"source_only_http_reacquisition"}
    assert all("byte-for-byte equal" in u["details"] for u in verification["units"])
    report = (build / QURAN_ED / "verification_report.md").read_text(encoding="utf-8")
    assert "Source-only decision: D83" in report
    assert_no_source_text(out, all_report_text(build))
    # one fetch for the acquisition, one for the re-acquisition, nothing from any other host
    assert server.calls == [("get_quran_verses", 112)] * 2
    assert server.hosts == {HOST}


def test_a_different_re_acquisition_blocks_the_affected_unit(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    verses = quran_verses()
    altered = QURAN_RESPONSE.replace(verses[2], verses[2][:-1], 1)
    server = quran_server(QURAN_RESPONSE, altered)
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    capsys.readouterr()
    assert verify_quran(build, server) == ExitCode.VERIFICATION_FAILED
    captured = capsys.readouterr()
    assert "1 unit(s) blocked" in captured.err
    verified = rows(build, QURAN_ED)["verified"]
    assert verified.status == "failed" and verified.cursor["blockedUnits"] == ["112:3"]
    evidence = verified.validation_summary["sourceOnly"]["acquisitions"]
    assert evidence[1]["equalToStored"] is False
    assert_no_source_text(captured.out, captured.err, all_report_text(build))
    assert run_cli(quran_args("segment"), build) == ExitCode.PRECONDITION  # nothing advances


def test_a_byte_difference_blocks_even_when_the_texts_are_equal_after_nfc(
    tmp_path: Path,
) -> None:
    build = tmp_path / "build"
    verses = quran_verses()
    decomposed = QURAN_RESPONSE.replace(verses[2], not_nfc(verses[2]), 1)
    server = quran_server(QURAN_RESPONSE, decomposed)
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    assert verify_quran(build, server) == ExitCode.VERIFICATION_FAILED
    verified = rows(build, QURAN_ED)["verified"]
    assert verified.cursor["blockedUnits"] == ["112:3"]
    units = json.loads((build / QURAN_ED / "verification.json").read_text(encoding="utf-8"))[
        "units"
    ]
    (blocked,) = [u for u in units if u["result"] == "failed"]
    assert (
        "bytes differ" in blocked["details"]
        and "after NFC the texts are equal" in blocked["details"]
    )


def test_a_missing_or_extra_ayah_in_the_re_acquisition_is_blocked(tmp_path: Path) -> None:
    build = tmp_path / "build"
    verses = quran_verses()
    five = surah_text(112, 5, verses[0])  # one ayah more than the surah has
    server = quran_server(QURAN_RESPONSE, five)
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    assert verify_quran(build, server) == ExitCode.VERIFICATION_FAILED
    assert "112:5" in rows(build, QURAN_ED)["verified"].cursor["blockedUnits"]


def test_the_quran_needs_the_http_re_acquisition_and_touches_nothing_without_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = quran_server()
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    capsys.readouterr()
    assert run_cli(quran_args("verify", *SOURCE_ONLY), build) == ExitCode.USAGE
    assert "--http-recheck" in capsys.readouterr().err
    assert "verified" not in rows(build, QURAN_ED)
    assert server.calls == [("get_quran_verses", 112)]  # no request for the refused run


@pytest.mark.parametrize("flag", ["--oracle", "--skeleton"])
def test_the_oracle_and_the_skeleton_are_refused_in_source_only_mode(
    tmp_path: Path, flag: str, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = quran_server()
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    capsys.readouterr()
    assert verify_quran(build, server, flag, str(ORACLE)) == ExitCode.USAGE
    assert "pass neither" in capsys.readouterr().err
    assert "verified" not in rows(build, QURAN_ED)
    assert server.calls == [("get_quran_verses", 112)]


def test_a_records_file_acquisition_is_not_source_only_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 0
    )
    capsys.readouterr()
    server = quran_server()
    assert verify_quran(build, server) == ExitCode.PRECONDITION
    assert "not acquired over HTTP" in capsys.readouterr().err
    assert server.calls == []  # refused before any request
    assert "verified" not in rows(build, QURAN_ED)


def test_without_the_option_the_missing_oracle_still_fails_closed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = quran_server()
    assert acquire_quran_http(build, httpx.MockTransport(server)) == 0
    capsys.readouterr()
    args = quran_args("verify", "--http-recheck")
    assert run_cli(args, build, transport=httpx.MockTransport(server)) == ExitCode.USAGE
    assert "needs an oracle file" in capsys.readouterr().err
    assert "verified" not in rows(build, QURAN_ED)
    # and the ordinary oracle path is untouched
    assert run_cli(quran_args("verify", "--oracle", str(ORACLE)), build) == 0
    summary = rows(build, QURAN_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == "nfc_equality_vs_oracle"
    assert "sourceOnly" not in summary


def test_only_the_d83_decision_exists(tmp_path: Path) -> None:
    build = tmp_path / "build"
    args = quran_args("verify", "--source-only-decision", "D84", "--http-recheck")
    assert run_cli(args, build) == ExitCode.USAGE


# --- scope: exactly surah 112 / hadith 1 / bank version 1 -----------------------------------


def test_another_surah_scope_is_refused_before_any_request(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    verse = quran_verses()[0]
    server = McpMock(
        {
            ("get_quran_verses", 112): [QURAN_RESPONSE],
            ("get_quran_verses", 113): [surah_text(113, 5, verse)],
        }
    )
    args = quran_args("acquire", "--http", "--surahs", "112-113")
    assert run_cli(args, build, transport=httpx.MockTransport(server)) == 0
    capsys.readouterr()
    server.calls.clear()
    assert verify_quran(build, server) == ExitCode.PRECONDITION
    assert "covers surah 112" in capsys.readouterr().err
    assert server.calls == []
    assert "verified" not in rows(build, QURAN_ED)


def test_another_bank_version_is_refused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = quran_server()
    transport = httpx.MockTransport(server)
    assert (
        run_cli(
            quran_args("acquire", "--http", "--surahs", "112", bank=2), build, transport=transport
        )
        == 0
    )
    capsys.readouterr()
    args = quran_args("verify", *SOURCE_ONLY, "--http-recheck", bank=2)
    assert run_cli(args, build, transport=transport) == ExitCode.PRECONDITION
    assert "bank version 1 only" in capsys.readouterr().err


def test_a_wider_hadith_scope_is_refused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    ids = id_map(tmp_path, {"1": D83_HADITH_ID, "3": 66512})
    server = McpMock(
        {
            ("get_hadith", D83_HADITH_ID): [hadith_text(D83_HADITH_ID)],
            ("get_hadith", 66512): [hadith_text(66512)],
        }
    )
    transport = httpx.MockTransport(server)
    for number in (1, 2):
        args = hadith_args(
            "acquire", "--http", "--forty", "1,3", "--pass", str(number), "--id-map", str(ids)
        )
        assert run_cli(args, build, transport=transport) == 0
    capsys.readouterr()
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == ExitCode.PRECONDITION
    assert "covers surah 112" in capsys.readouterr().err
    assert "verified" not in rows(build, HADITH_ED)


def test_a_hadith_record_other_than_the_one_named_by_d83_is_refused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    ids = id_map(tmp_path, {"1": SYNTHETIC_HADITH_ID})  # not record 66511
    server = McpMock({("get_hadith", SYNTHETIC_HADITH_ID): [HADITH_RESPONSE]})
    assert all(c == 0 for c in acquire_hadith_http(build, httpx.MockTransport(server), ids))
    capsys.readouterr()
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == ExitCode.PRECONDITION
    assert str(D83_HADITH_ID) in capsys.readouterr().err
    assert "verified" not in rows(build, HADITH_ED)


# --- hadith --------------------------------------------------------------------------------


def test_hadith_two_http_passes_identical_after_nfc_verify(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = hadith_server()
    ids = id_map(tmp_path)
    assert acquire_hadith_http(build, httpx.MockTransport(server), ids) == [0, 0]
    capsys.readouterr()
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == 0
    out = capsys.readouterr().out
    assert "units=4" in out and "passed=4" in out and "gaps=0" in out
    assert "acquisitions=2" in out and "source_only=D83" in out

    summary = rows(build, HADITH_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == "source_only(D83):two_pass_nfc_equality"
    assert summary["sourceOnly"]["decision"] == "D83"
    first, second = summary["sourceOnly"]["acquisitions"]
    assert (first["role"], second["role"]) == ("pass1", "pass2")
    assert first["acquisition"] == second["acquisition"] == "http"
    assert (first["pass"], second["pass"]) == (1, 2)
    assert summary["sourceOnly"]["passesByteIdentical"] == {
        "forty:1": {"narration": True, "takhrij": True, "grade": True}
    }
    assert "priorEvidence" not in summary["sourceOnly"]  # the D68 sample check is about the Quran
    assert summary["reviewRecordEntry"]["verification"]["decision"] == "D83"
    verification = json.loads((build / HADITH_ED / "verification.json").read_text(encoding="utf-8"))
    assert verification["sourceOnlyDecision"] == "D83"
    assert_no_source_text(out, all_report_text(build))
    assert server.calls == [("get_hadith", D83_HADITH_ID)] * 2  # one fetch per pass
    assert server.hosts == {HOST}


def test_hadith_passes_equal_after_nfc_but_not_byte_identical_still_verify(
    tmp_path: Path,
) -> None:
    build = tmp_path / "build"
    narration = load_json(single_hadith_records(tmp_path)[0])["records"][0]["narration"]
    base = hadith_text(D83_HADITH_ID)
    second = base.replace(narration, not_nfc(narration), 1)
    assert second != base
    server = hadith_server(base, second)
    assert acquire_hadith_http(build, httpx.MockTransport(server), id_map(tmp_path)) == [0, 0]
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == 0
    summary = rows(build, HADITH_ED)["verified"].validation_summary
    assert summary["sourceOnly"]["passesByteIdentical"]["forty:1"]["narration"] is False


def test_hadith_passes_that_differ_block_the_unit(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    narration = load_json(single_hadith_records(tmp_path)[0])["records"][0]["narration"]
    base = hadith_text(D83_HADITH_ID)
    server = hadith_server(base, base.replace(narration, narration[:-1], 1))
    assert acquire_hadith_http(build, httpx.MockTransport(server), id_map(tmp_path)) == [0, 0]
    capsys.readouterr()
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == ExitCode.VERIFICATION_FAILED
    assert rows(build, HADITH_ED)["verified"].cursor["blockedUnits"] == ["forty:1:narration"]


def test_hadith_records_file_passes_are_not_source_only_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    pass1, pass2 = single_hadith_records(tmp_path)
    for number, path in ((1, pass1), (2, pass2)):
        args = hadith_args("acquire", "--pass", str(number), "--records", str(path), "--forty", "1")
        assert run_cli(args, build) == 0
    capsys.readouterr()
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == ExitCode.PRECONDITION
    assert "not acquired over HTTP" in capsys.readouterr().err


def test_hadith_http_recheck_adds_a_third_acquisition(tmp_path: Path) -> None:
    build = tmp_path / "build"
    server = hadith_server()
    transport = httpx.MockTransport(server)
    assert acquire_hadith_http(build, transport, id_map(tmp_path)) == [0, 0]
    args = hadith_args("verify", *SOURCE_ONLY, "--http-recheck")
    assert run_cli(args, build, transport=transport) == 0
    summary = rows(build, HADITH_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == (
        "source_only(D83):two_pass_nfc_equality+http_byte_diff"
    )
    assert summary["counts"]["acquisitions"] == 3
    assert server.calls == [("get_hadith", D83_HADITH_ID)] * 3


def test_verify_waits_for_both_hadith_passes(tmp_path: Path) -> None:
    build = tmp_path / "build"
    server = hadith_server()
    ids = id_map(tmp_path)
    assert acquire_hadith_http(build, httpx.MockTransport(server), ids, passes=(1,)) == [0]
    # pass 2 is not stored yet: the step order refuses verify (the build is incomplete)
    assert run_cli(hadith_args("verify", *SOURCE_ONLY), build) == ExitCode.PRECONDITION
    assert "verified" not in rows(build, HADITH_ED)


# --- the module itself ----------------------------------------------------------------------


def test_module_constants_and_names() -> None:
    assert source_only.DECISION_ID == "D83" and source_only.BANK_VERSION == 1
    assert source_only.QURAN_SURAHS == (112,)
    assert dict(source_only.HADITH_IDS) == {1: 66511}
    assert source_only.method_name("x") == "source_only(D83):x"
    source_only.require_decision("D83")
    with pytest.raises(InputError):
        source_only.require_decision("D68")


@pytest.mark.parametrize(
    ("edition", "bank", "scope", "ok"),
    [
        (EDITION_QURAN, 1, EditionScope(surahs=(112,)), True),
        (EDITION_QURAN, 2, EditionScope(surahs=(112,)), False),
        (EDITION_QURAN, 1, EditionScope(surahs=(113,)), False),
        (EDITION_QURAN, 1, EditionScope(surahs=(112, 113)), False),
        (EDITION_QURAN, 1, EditionScope(surahs=tuple(range(78, 115))), False),
        (EDITION_HADITH, 1, EditionScope(forty_numbers=(1,)), True),
        (EDITION_HADITH, 1, EditionScope(forty_numbers=(2,)), False),
        (EDITION_HADITH, 1, EditionScope(forty_numbers=(1, 2)), False),
        (EDITION_HADITH, 1, EditionScope(forty_numbers=tuple(range(1, 43))), False),
        (EDITION_HADITH, 3, EditionScope(forty_numbers=(1,)), False),
        (EDITION_HADITH, 1, EditionScope(surahs=(112,), forty_numbers=(1,)), False),
    ],
)
def test_the_scope_guard_accepts_exactly_the_d83_scope(
    edition: str, bank: int, scope: EditionScope, ok: bool
) -> None:
    if ok:
        source_only.assert_scope(edition, bank, scope)
    else:
        with pytest.raises(PreconditionError):
            source_only.assert_scope(edition, bank, scope)
