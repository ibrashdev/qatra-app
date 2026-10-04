"""``acquire`` and ``verify`` end to end through ``main([...])`` on the synthetic fixtures.

No network: HTTP paths use httpx.MockTransport. Nothing here proves the live host works.
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.domain.normalization import normalize
from app.workflow.errors import ExitCode
from app.workflow.jobs import LocalJobRepository
from app.workflow.models import RawObject
from app.workflow.paths import BuildPaths
from tests.workflow.wf_support import (
    DATA,
    HADITH_ED,
    QURAN_ED,
    all_report_text,
    assert_no_source_text,
    hadith_args,
    load_json,
    quran_args,
    run_cli,
    write_json,
)

QURAN_RECORDS = DATA / "synthetic_quran_records.json"
ORACLE = DATA / "synthetic_oracle.txt"
PASS1 = DATA / "synthetic_hadith_records_pass1.json"
PASS2 = DATA / "synthetic_hadith_records_pass2.json"
QURAN_RESPONSE = (DATA / "synthetic_mcp_quran_response.txt").read_text(encoding="utf-8")
HADITH_RESPONSE = (DATA / "synthetic_mcp_hadith_response.txt").read_text(encoding="utf-8")


def rows(build: Path, edition: str, bank: int = 1) -> dict[str, Any]:
    return {j.step: j for j in LocalJobRepository(BuildPaths(build)).list_jobs(edition, bank)}


def raw_names(build: Path, edition: str) -> list[str]:
    directory = build / "raw" / edition
    return sorted(p.name for p in directory.iterdir()) if directory.is_dir() else []


def not_nfc(text: str) -> str:
    """Same text with mark pairs in non-canonical order (so it is not NFC but NFC-equal)."""
    swapped = text
    for first in ("\u064e", "\u064c", "\u064f", "\u0650"):
        swapped = swapped.replace(f"{first}\u0651", f"\u0651{first}")
    assert swapped != text and not unicodedata.is_normalized("NFC", swapped)
    assert unicodedata.normalize("NFC", swapped) == text
    return swapped


def with_records(source: Path, destination: Path, edit: Any) -> Path:
    data = load_json(source)
    edit(data)
    return write_json(destination, data)


# --- Quran ---------------------------------------------------------------------------------


def test_quran_acquire_then_verify_passes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    code = run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
    out = capsys.readouterr().out
    assert code == 0
    assert "status=succeeded" in out and "objects=1" in out and "records=4" in out
    assert "created=1" in out and "missing_surahs=0" in out

    code = run_cli(quran_args("verify", "--oracle", str(ORACLE)), build)
    out2 = capsys.readouterr().out
    assert code == 0
    assert (
        "status=succeeded" in out2
        and "units=4" in out2
        and "passed=4" in out2
        and "failed=0" in out2
    )
    assert_no_source_text(out, out2, all_report_text(build))

    jobs = rows(build, QURAN_ED)
    assert jobs["acquired"].status == "succeeded" and jobs["verified"].status == "succeeded"
    assert jobs["page_mapped"].status == "skipped" and jobs["embedded"].status == "skipped"
    summary = jobs["verified"].validation_summary
    assert summary["verification"]["result"] == "passed"
    assert summary["verification"]["method"] == "nfc_equality_vs_oracle"
    assert summary["reviewRecordEntry"]["verification"]["differences"] == []
    assert "automated" in summary["reviewRecordEntry"]["verification"]["who"]
    acquired = jobs["acquired"].validation_summary
    assert acquired["source"]["toolName"] == "get_quran_verses"
    assert acquired["source"]["acquisition"] == "mcp_tool"
    assert len(acquired["source"]["rawSha256"]) == 64
    assert acquired["source"]["retrievedAt"] == "2026-10-04T10:00:00Z"
    assert acquired["reviewRecordEntry"]["acquisition"]["recordIds"] == [
        "112:1",
        "112:2",
        "112:3",
        "112:4",
    ]

    verification = json.loads((build / QURAN_ED / "verification.json").read_text(encoding="utf-8"))
    assert verification["source"]["result"] == "passed"
    assert [u["unitRef"] for u in verification["units"]] == ["112:1", "112:2", "112:3", "112:4"]
    assert all(u["result"] == "passed" for u in verification["units"])


def test_raw_objects_are_stored_unmodified_with_provenance(tmp_path: Path) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 0
    )
    assert raw_names(build, QURAN_ED) == ["bank1-surah-112.json"]
    obj = RawObject.from_bytes((build / "raw" / QURAN_ED / "bank1-surah-112.json").read_bytes())
    source = load_json(QURAN_RECORDS)
    assert obj.payload["records"] == source["records"]  # texts identical, nothing normalized
    assert obj.tool_name == "get_quran_verses"
    assert obj.arguments == {"surah": 112, "language": "ar"}
    assert obj.canonical_url == "https://islamenc.com/ar/quran/112"
    assert obj.retrieved_at.isoformat() == "2026-10-04T10:00:00+00:00"
    assert obj.acquisition == "mcp_tool" and obj.pass_number is None


def test_acquire_is_idempotent(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    build = tmp_path / "build"
    args = quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112")
    assert run_cli(args, build) == 0
    raw_before = (build / "raw" / QURAN_ED / "bank1-surah-112.json").read_bytes()
    jobs_before = (build / QURAN_ED / "jobs.json").read_bytes()
    capsys.readouterr()
    assert run_cli(args, build) == 0
    out = capsys.readouterr().out
    assert "changed=no" in out and "created=0" in out and "unchanged=1" in out
    assert (build / "raw" / QURAN_ED / "bank1-surah-112.json").read_bytes() == raw_before
    assert (build / QURAN_ED / "jobs.json").read_bytes() == jobs_before
    assert raw_names(build, QURAN_ED) == ["bank1-surah-112.json"]


def test_a_deliberately_altered_record_fails_verification_with_exit_4(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"

    def alter(data: dict[str, Any]) -> None:
        data["records"][1]["text"] = data["records"][1]["text"][:-1]  # one character lost

    altered = with_records(QURAN_RECORDS, tmp_path / "altered.json", alter)
    assert run_cli(quran_args("acquire", "--records", str(altered), "--surahs", "112"), build) == 0
    capsys.readouterr()
    code = run_cli(quran_args("verify", "--oracle", str(ORACLE)), build)
    captured = capsys.readouterr()
    assert code == ExitCode.VERIFICATION_FAILED == 4
    assert "1 unit(s) blocked" in captured.err
    assert_no_source_text(captured.out, captured.err, all_report_text(build))

    verified = rows(build, QURAN_ED)["verified"]
    assert verified.status == "failed"
    assert verified.cursor["blockedUnits"] == ["112:2"]
    assert verified.validation_summary["verification"]["result"] == "failed"
    report = (build / QURAN_ED / "verification_report.md").read_text(encoding="utf-8")
    assert "112:2" in report and "112:1 |" not in report
    units = json.loads((build / QURAN_ED / "verification.json").read_text(encoding="utf-8"))[
        "units"
    ]
    assert [u["unitRef"] for u in units if u["result"] == "failed"] == ["112:2"]

    # the edition does not advance, and the altered object cannot be overwritten: new bank version
    assert run_cli(quran_args("segment"), build) == 3
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 3
    )
    capsys.readouterr()
    assert (
        run_cli(
            quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112", bank=2), build
        )
        == 0
    )
    assert run_cli(quran_args("verify", "--oracle", str(ORACLE), bank=2), build) == 0


def test_nfc_equal_texts_pass_even_when_the_raw_text_is_not_nfc(tmp_path: Path) -> None:
    build = tmp_path / "build"

    def decompose(data: dict[str, Any]) -> None:
        data["records"][2]["text"] = not_nfc(data["records"][2]["text"])

    records = with_records(QURAN_RECORDS, tmp_path / "nfd.json", decompose)
    assert run_cli(quran_args("acquire", "--records", str(records), "--surahs", "112"), build) == 0
    assert run_cli(quran_args("verify", "--oracle", str(ORACLE)), build) == 0
    stored = RawObject.from_bytes((build / "raw" / QURAN_ED / "bank1-surah-112.json").read_bytes())
    assert not unicodedata.is_normalized("NFC", stored.payload["records"][2]["text"])  # kept as is


def test_oracle_without_an_entry_blocks_that_unit(tmp_path: Path) -> None:
    build = tmp_path / "build"
    short = tmp_path / "oracle.txt"
    short.write_text(
        "\n".join(
            line for line in ORACLE.read_text(encoding="utf-8").splitlines() if "|3|" not in line
        ),
        encoding="utf-8",
    )
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 0
    )
    assert run_cli(quran_args("verify", "--oracle", str(short)), build) == 4
    assert rows(build, QURAN_ED)["verified"].cursor["blockedUnits"] == ["112:3"]


def test_verify_input_errors_do_not_touch_the_job(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 0
    )
    capsys.readouterr()
    assert run_cli(quran_args("verify"), build) == 2  # the oracle is required
    assert "oracle" in capsys.readouterr().err
    bad = tmp_path / "bad.txt"
    bad.write_text("112|x|text\n", encoding="utf-8")
    assert run_cli(quran_args("verify", "--oracle", str(bad)), build) == 2
    assert run_cli(quran_args("verify", "--oracle", str(tmp_path / "missing.txt")), build) == 2
    assert (
        run_cli(quran_args("verify", "--oracle", str(ORACLE), "--skeleton", str(ORACLE)), build)
        == 2
    )
    assert "verified" not in rows(build, QURAN_ED)


def test_partial_acquisition_stays_running_and_blocks_verify(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    code = run_cli(
        quran_args("acquire", "--records", str(QURAN_RECORDS)), build
    )  # default scope 78-114
    out = capsys.readouterr().out
    assert code == 0 and "status=running" in out and "missing_surahs=36" in out
    assert "not complete" in out
    assert rows(build, QURAN_ED)["acquired"].status == "running"
    assert run_cli(quran_args("verify", "--oracle", str(ORACLE)), build) == 3
    assert "requires step 'acquired'" in capsys.readouterr().err
    # the scope is fixed by the first acquire
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 3
    )
    assert "scope" in capsys.readouterr().err
    report = (build / "acquisition_report.md").read_text(encoding="utf-8")
    assert "INCOMPLETE" in report and "Missing surahs" in report


def test_surah_with_missing_ayat_is_refused_and_nothing_is_stored(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    short = with_records(QURAN_RECORDS, tmp_path / "short.json", lambda d: d["records"].pop())
    code = run_cli(quran_args("acquire", "--records", str(short), "--surahs", "112"), build)
    err = capsys.readouterr().err
    assert code == 2 and "incomplete_surah@112" in err
    assert raw_names(build, QURAN_ED) == [] and rows(build, QURAN_ED) == {}


@pytest.mark.parametrize(
    "edit",
    [
        lambda d: d["records"][0].update({"tafsir": "never stored"}),
        lambda d: d["records"][0].update({"surah": "112"}),
        lambda d: d.update({"tool": "get_hadith"}),
        lambda d: d.update({"formatVersion": 2}),
        lambda d: d.update({"retrievedAt": "2026-10-04T10:00:00"}),  # no time zone
        lambda d: d.update({"extra": 1}),
        lambda d: d.update({"records": []}),
    ],
)
def test_invalid_records_files_are_refused_without_storing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], edit: Any
) -> None:
    build = tmp_path / "build"
    bad = with_records(QURAN_RECORDS, tmp_path / "bad.json", edit)
    assert run_cli(quran_args("acquire", "--records", str(bad), "--surahs", "112"), build) == 2
    err = capsys.readouterr().err
    assert "never stored" not in err
    assert raw_names(build, QURAN_ED) == [] and rows(build, QURAN_ED) == {}


def test_unreadable_or_non_json_records_file_is_a_usage_error(tmp_path: Path) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(
            quran_args("acquire", "--records", str(tmp_path / "none.json"), "--surahs", "112"),
            build,
        )
        == 2
    )
    broken = tmp_path / "broken.json"
    broken.write_text("{ not json", encoding="utf-8")
    assert run_cli(quran_args("acquire", "--records", str(broken), "--surahs", "112"), build) == 2


def test_quran_scope_and_pass_flags_are_checked(tmp_path: Path) -> None:
    build = tmp_path / "build"
    records = str(QURAN_RECORDS)
    assert run_cli(quran_args("acquire", "--records", records, "--pass", "1"), build) == 2
    assert run_cli(quran_args("acquire", "--records", records, "--forty", "1"), build) == 2
    assert run_cli(quran_args("acquire", "--records", records, "--surahs", "1-5"), build) == 2
    assert (
        run_cli(quran_args("acquire", "--records", records, "--surahs", "113"), build) == 2
    )  # 112 outside
    assert rows(build, QURAN_ED) == {}


# --- Quran over HTTP (MockTransport) -------------------------------------------------------


class McpMock:
    """Minimal MCP server answering ``tools/call`` with a prepared text per tool and argument."""

    def __init__(self, answers: dict[tuple[str, int], str | int]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, int]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "id" not in body:
            return httpx.Response(202)
        if body["method"] == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {}})
        name = body["params"]["name"]
        args = body["params"]["arguments"]
        key = (name, args["surah"] if name == "get_quran_verses" else args["id"])
        self.calls.append(key)
        answer = self.answers.get(key, 404)
        if isinstance(answer, int):
            return httpx.Response(answer)
        result = {"content": [{"type": "text", "text": answer}]}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})


def surah_response(surah: int, ayat: int) -> str:
    lines = [f'[Surah {surah}, translation "x"]', "[EXACT]"]
    for ayah in range(1, ayat + 1):
        lines += [f"[{surah}:{ayah}]", f"نص تجريبي {surah} {ayah}", "شرح", ""]
    lines += ["[/EXACT]", f"Source: https://islamenc.com/ar/quran/{surah}"]
    return "\n".join(lines) + "\n"


def oracle_for(path: Path, surahs: dict[int, int]) -> Path:
    lines = [f"{s}|{a}|نص تجريبي {s} {a}" for s, n in surahs.items() for a in range(1, n + 1)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_quran_http_acquire_verify_and_recheck(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    server = McpMock({("get_quran_verses", 112): QURAN_RESPONSE})
    transport = httpx.MockTransport(server)
    assert (
        run_cli(quran_args("acquire", "--http", "--surahs", "112"), build, transport=transport) == 0
    )
    assert server.calls == [("get_quran_verses", 112)]
    stored = RawObject.from_bytes((build / "raw" / QURAN_ED / "bank1-surah-112.json").read_bytes())
    assert stored.acquisition == "http" and stored.arguments == {"surah": 112, "language": "ar"}
    assert [r["text"] for r in stored.payload["records"]] == [
        r["text"] for r in load_json(QURAN_RECORDS)["records"]
    ]
    assert rows(build, QURAN_ED)["acquired"].validation_summary["source"]["acquisition"] == "http"

    args = quran_args("verify", "--oracle", str(ORACLE), "--http-recheck")
    assert run_cli(args, build, transport=transport) == 0
    out = capsys.readouterr().out
    assert "units=4" in out and "passed=4" in out
    summary = rows(build, QURAN_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == "nfc_equality_vs_oracle+http_byte_diff"
    units = json.loads((build / QURAN_ED / "verification.json").read_text(encoding="utf-8"))[
        "units"
    ]
    assert sorted({u["method"] for u in units}) == ["http_byte_diff", "nfc_equality_vs_oracle"]


def test_http_recheck_blocks_a_unit_whose_bytes_differ(tmp_path: Path) -> None:
    build = tmp_path / "build"
    server = McpMock({("get_quran_verses", 112): QURAN_RESPONSE})
    assert (
        run_cli(
            quran_args("acquire", "--http", "--surahs", "112"),
            build,
            transport=httpx.MockTransport(server),
        )
        == 0
    )
    changed = QURAN_RESPONSE.replace("ٌ", "ً", 1)  # tanwin variant in one verse
    assert changed != QURAN_RESPONSE
    server.answers[("get_quran_verses", 112)] = changed
    args = quran_args("verify", "--oracle", str(ORACLE), "--http-recheck")
    assert run_cli(args, build, transport=httpx.MockTransport(server)) == 4
    blocked = rows(build, QURAN_ED)["verified"].cursor["blockedUnits"]
    assert blocked and all(ref.startswith("112:") for ref in blocked)


def test_http_recheck_with_an_unreachable_host_is_exit_7_and_not_a_verification(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 0
    )

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("blocked", request=request)

    capsys.readouterr()
    args = quran_args("verify", "--oracle", str(ORACLE), "--http-recheck")
    assert (
        run_cli(args, build, transport=httpx.MockTransport(unreachable))
        == ExitCode.SOURCE_UNREACHABLE
    )
    assert "verified" not in rows(build, QURAN_ED)  # no claim that a check passed


def test_http_acquire_interrupted_keeps_its_cursor_and_resumes(tmp_path: Path) -> None:
    build = tmp_path / "build"
    server = McpMock({("get_quran_verses", 112): QURAN_RESPONSE, ("get_quran_verses", 113): 500})
    transport = httpx.MockTransport(server)
    args = quran_args("acquire", "--http", "--surahs", "112-113")
    assert run_cli(args, build, transport=transport) == ExitCode.SOURCE_UNREACHABLE
    assert raw_names(build, QURAN_ED) == ["bank1-surah-112.json"]
    acquired = rows(build, QURAN_ED)["acquired"]
    assert acquired.status == "failed" and list(acquired.cursor["objects"]) == [
        "bank1-surah-112.json"
    ]

    server.answers[("get_quran_verses", 113)] = surah_response(113, 5)
    server.calls.clear()
    assert run_cli(args, build, transport=transport) == 0
    assert server.calls == [("get_quran_verses", 113)]  # surah 112 was not fetched again
    assert raw_names(build, QURAN_ED) == ["bank1-surah-112.json", "bank1-surah-113.json"]
    assert rows(build, QURAN_ED)["acquired"].status == "succeeded"


def test_http_answer_with_a_bad_layout_stores_nothing(tmp_path: Path) -> None:
    build = tmp_path / "build"
    server = McpMock({("get_quran_verses", 112): "just some words, no blocks"})
    code = run_cli(
        quran_args("acquire", "--http", "--surahs", "112"),
        build,
        transport=httpx.MockTransport(server),
    )
    assert code == ExitCode.SOURCE_UNREACHABLE
    assert raw_names(build, QURAN_ED) == []


def test_http_acquire_with_an_incomplete_surah_answer_is_refused(tmp_path: Path) -> None:
    build = tmp_path / "build"
    server = McpMock({("get_quran_verses", 112): surah_response(112, 3)})  # 112 has 4 ayat
    code = run_cli(
        quran_args("acquire", "--http", "--surahs", "112"),
        build,
        transport=httpx.MockTransport(server),
    )
    assert code == ExitCode.SOURCE_UNREACHABLE
    assert raw_names(build, QURAN_ED) == []
    acquired = rows(build, QURAN_ED)["acquired"]
    assert acquired.status == "failed" and acquired.cursor["objects"] == {}


def test_nothing_is_written_outside_the_given_build_dir(tmp_path: Path) -> None:
    from app.workflow.paths import DEFAULT_BUILD_DIR

    def listing() -> list[str]:
        return (
            sorted(str(p) for p in DEFAULT_BUILD_DIR.rglob("*"))
            if DEFAULT_BUILD_DIR.exists()
            else []
        )

    before = listing()
    build = tmp_path / "build"
    assert (
        run_cli(quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"), build)
        == 0
    )
    assert run_cli(quran_args("verify", "--oracle", str(ORACLE)), build) == 0
    assert listing() == before
    assert (build / "raw" / QURAN_ED).is_dir()


# --- hadith --------------------------------------------------------------------------------


def acquire_both(
    build: Path, pass2: Path = PASS2, *, scope: str = "1-3", pass1: Path = PASS1
) -> None:
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", str(pass1), "--forty", scope), build
        )
        == 0
    )
    assert run_cli(hadith_args("acquire", "--pass", "2", "--records", str(pass2)), build) == 0


def test_hadith_two_passes_then_verify_passes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", str(PASS1), "--forty", "1-3"), build
        )
        == 0
    )
    out = capsys.readouterr().out
    assert "status=running" in out and "passes=1" in out and "pass=1" in out
    assert run_cli(hadith_args("verify"), build) == 3  # pass 2 is still missing
    capsys.readouterr()
    assert run_cli(hadith_args("acquire", "--pass", "2", "--records", str(PASS2)), build) == 0
    out = capsys.readouterr().out
    assert "status=succeeded" in out and "passes=2" in out and "objects=6" in out
    assert run_cli(hadith_args("verify"), build) == 0
    out = capsys.readouterr().out
    assert (
        "units=12" in out
        and "passed=12" in out
        and "gaps=0" in out
        and "gap_forty_numbers=[]" in out
    )
    assert_no_source_text(out, all_report_text(build))
    assert raw_names(build, HADITH_ED) == [
        f"bank1-pass{p}-forty-0{n}.json" for p in (1, 2) for n in (1, 2, 3)
    ]
    summary = rows(build, HADITH_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == "two_pass_nfc_equality"
    obj = RawObject.from_bytes(
        (build / "raw" / HADITH_ED / "bank1-pass2-forty-02.json").read_bytes()
    )
    assert obj.pass_number == 2 and obj.arguments == {"id": 990002, "language": "ar"}
    assert obj.canonical_url == "https://hadeethenc.com/ar/browse/hadith/990002"
    assert obj.payload["records"][0] == load_json(PASS2)["records"][1]


def test_the_same_records_file_cannot_serve_both_passes(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", str(PASS1), "--forty", "1-3"), build
        )
        == 0
    )
    capsys.readouterr()
    assert run_cli(hadith_args("acquire", "--pass", "2", "--records", str(PASS1)), build) == 3
    assert "independent" in capsys.readouterr().err
    assert not any("-pass2-" in n for n in raw_names(build, HADITH_ED))


def test_a_hadith_missing_in_pass_2_is_a_documented_gap(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    pass2 = with_records(
        PASS2, tmp_path / "pass2_short.json", lambda d: d["records"].pop()
    )  # drops 3
    acquire_both(build, pass2)
    capsys.readouterr()
    assert run_cli(hadith_args("verify"), build) == 0
    out = capsys.readouterr().out
    assert "units=8" in out and "gaps=1" in out and "gap_forty_numbers=[3]" in out
    gap_report = (build / HADITH_ED / "gap_report.md").read_text(encoding="utf-8")
    assert "| 3 | missing_in_pass_2 |" in gap_report and "Gaps: 1" in gap_report
    summary = rows(build, HADITH_ED)["verified"].validation_summary
    assert summary["gaps"] == [{"fortyNumber": 3, "reason": "missing_in_pass_2"}]
    assert (
        rows(build, HADITH_ED)["verified"].status == "succeeded"
    )  # a documented gap does not block


def test_a_hadith_without_any_record_is_a_gap_too(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    acquire_both(build, scope="1-4")
    capsys.readouterr()
    assert run_cli(hadith_args("verify"), build) == 0
    out = capsys.readouterr().out
    assert "gaps=1" in out and "gap_forty_numbers=[4]" in out
    assert "| 4 | no_record |" in (build / HADITH_ED / "gap_report.md").read_text(encoding="utf-8")


def test_passes_that_differ_after_nfc_block_only_the_affected_unit(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"

    def alter(data: dict[str, Any]) -> None:
        data["records"][1]["narration"] += " زيادة"

    pass2 = with_records(PASS2, tmp_path / "pass2_diff.json", alter)
    acquire_both(build, pass2)
    capsys.readouterr()
    code = run_cli(hadith_args("verify"), build)
    captured = capsys.readouterr()
    assert code == 4 and "1 unit(s) blocked" in captured.err
    verified = rows(build, HADITH_ED)["verified"]
    assert verified.status == "failed" and verified.cursor["blockedUnits"] == ["forty:2:narration"]
    assert_no_source_text(captured.out, captured.err, all_report_text(build))
    assert run_cli(hadith_args("segment"), build) == 3


def test_passes_that_are_equal_after_nfc_pass(tmp_path: Path) -> None:
    build = tmp_path / "build"

    def decompose(data: dict[str, Any]) -> None:
        for record in data["records"]:
            record["narration"] = not_nfc(record["narration"])

    pass2 = with_records(PASS2, tmp_path / "pass2_nfd.json", decompose)
    acquire_both(build, pass2)
    assert run_cli(hadith_args("verify"), build) == 0


def test_identity_difference_between_passes_is_blocked(tmp_path: Path) -> None:
    build = tmp_path / "build"

    def change_id(data: dict[str, Any]) -> None:
        data["records"][0]["hadeethencId"] = 990009
        data["records"][0]["url"] = "https://hadeethenc.com/ar/browse/hadith/990009"

    acquire_both(build, with_records(PASS2, tmp_path / "pass2_id.json", change_id))
    assert run_cli(hadith_args("verify"), build) == 4
    assert rows(build, HADITH_ED)["verified"].cursor["blockedUnits"] == ["forty:1:identity"]


def test_skeleton_differences_are_flagged_for_review_but_never_block(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    acquire_both(build)
    records = load_json(PASS1)["records"]
    reference = tmp_path / "skeleton.txt"
    reference.write_text(
        "\n".join(
            [
                f"1|{records[0]['narration']}",  # identical wording
                f"2|{records[1]['narration'].replace('مِثَالٌ', '', 1)}",  # one word omitted
                f"9|{records[2]['narration']}",  # number outside the scope: ignored
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    capsys.readouterr()
    assert run_cli(hadith_args("verify", "--skeleton", str(reference)), build) == 0
    out = capsys.readouterr().out
    assert "flagged=1" in out and "failed=0" in out
    summary = rows(build, HADITH_ED)["verified"].validation_summary
    assert summary["verification"]["method"] == "two_pass_nfc_equality+letter_skeleton_flag"
    (flag,) = summary["suspectedErrors"]
    assert flag["unit"] == "forty:2:narration" and flag["kind"] == "skeleton_difference"
    assert "omitted" in flag["details"] and "review only" in flag["details"]
    assert_no_source_text(out, flag["details"], all_report_text(build))


def test_hadith_flags_are_checked(tmp_path: Path) -> None:
    build = tmp_path / "build"
    records = str(PASS1)
    assert run_cli(hadith_args("acquire", "--records", records), build) == 2  # --pass is required
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", records, "--surahs", "112"), build
        )
        == 2
    )
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", records, "--forty", "1-43"), build
        )
        == 2
    )
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", records, "--forty", "2-3"), build
        )
        == 2
    )
    assert run_cli(hadith_args("acquire", "--pass", "3", "--records", records), build) == 2
    assert (
        run_cli(
            hadith_args("acquire", "--pass", "1", "--records", records, "--id-map", records), build
        )
        == 2
    )
    assert (
        run_cli(hadith_args("acquire", "--pass", "1", "--http"), build) == 2
    )  # --id-map is required
    assert (
        run_cli(hadith_args("verify", "--oracle", str(ORACLE)), build) == 3
    )  # nothing acquired yet
    assert rows(build, HADITH_ED) == {}


def test_hadith_verify_rejects_oracle_after_acquisition(tmp_path: Path) -> None:
    build = tmp_path / "build"
    acquire_both(build)
    assert run_cli(hadith_args("verify", "--oracle", str(ORACLE)), build) == 2
    assert "verified" not in rows(build, HADITH_ED)


def test_changing_the_acquisition_resets_the_verification(tmp_path: Path) -> None:
    build = tmp_path / "build"
    short1 = with_records(PASS1, tmp_path / "p1_short.json", lambda d: d["records"].pop())
    short2 = with_records(PASS2, tmp_path / "p2_short.json", lambda d: d["records"].pop())
    acquire_both(build, short2, pass1=short1)
    assert run_cli(hadith_args("verify"), build) == 0
    assert rows(build, HADITH_ED)["verified"].status == "succeeded"
    # pass 1 is repeated with the full file: a new object appears, so the earlier verification no
    # longer describes the data and must be repeated
    assert run_cli(hadith_args("acquire", "--pass", "1", "--records", str(PASS1)), build) == 0
    assert rows(build, HADITH_ED)["verified"].status == "pending"
    assert run_cli(hadith_args("segment"), build) == 3
    assert run_cli(hadith_args("verify"), build) == 0
    assert run_cli(hadith_args("segment"), build) == 0  # verified again: segmentation may start


def test_hadith_http_acquire_with_an_id_map(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    id_map = write_json(tmp_path / "ids.json", {"1": 990001})
    server = McpMock({("get_hadith", 990001): HADITH_RESPONSE})
    args = hadith_args(
        "acquire", "--pass", "1", "--http", "--id-map", str(id_map), "--forty", "1-2"
    )
    assert run_cli(args, build, transport=httpx.MockTransport(server)) == 0
    assert server.calls == [
        ("get_hadith", 990001)
    ]  # no id for number 2: never guessed, never fetched
    obj = RawObject.from_bytes(
        (build / "raw" / HADITH_ED / "bank1-pass1-forty-01.json").read_bytes()
    )
    assert obj.acquisition == "http" and obj.pass_number == 1
    assert obj.arguments == {"id": 990001, "language": "ar"}
    assert obj.payload["records"][0]["narrator"] == "رواه الراوي المثال"
    assert "شَرْحٌ" not in json.dumps(obj.payload, ensure_ascii=False)  # commentary never stored
    out = capsys.readouterr().out
    assert "status=running" in out and "objects=1" in out
    assert_no_source_text(out, all_report_text(build))


def test_reports_exist_and_hold_no_source_text(tmp_path: Path) -> None:
    build = tmp_path / "build"
    acquire_both(build)
    assert run_cli(hadith_args("verify"), build) == 0
    for name in (
        "acquisition_report.md",
        "verification_report.md",
        "verification.json",
        "gap_report.md",
        "jobs.json",
    ):
        assert (build / HADITH_ED / name).is_file(), name
    assert (build / "acquisition_report.md").is_file()
    assert_no_source_text(all_report_text(build))
    # the raw directory is the only place source text lives
    assert (
        normalize(
            (build / "raw" / HADITH_ED / "bank1-pass1-forty-01.json").read_text(encoding="utf-8")
        ).count("تجريبي")
        > 0
    )
