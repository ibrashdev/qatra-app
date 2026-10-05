"""Helpers for the D83, scoped-build, approve and publish tests.

Synthetic data only, no network (httpx.MockTransport), no secrets. The placeholder text comes from
the committed fixtures in ``tests/data``; nothing here spells out real source text.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

import httpx

from app.workflow.jobs import LocalJobRepository
from app.workflow.models import ContentJob
from app.workflow.paths import BuildPaths
from tests.workflow.wf_support import (
    DATA,
    QURAN_ED,
    hadith_args,
    load_json,
    quran_args,
    run_cli,
    write_json,
)

QURAN_RECORDS = DATA / "synthetic_quran_records.json"
ORACLE = DATA / "synthetic_oracle.txt"
LABELS = DATA / "synthetic_labels.json"
BOUNDARIES = DATA / "synthetic_boundaries.json"
QURAN_RESPONSE = (DATA / "synthetic_mcp_quran_response.txt").read_text(encoding="utf-8")
HADITH_RESPONSE = (DATA / "synthetic_mcp_hadith_response.txt").read_text(encoding="utf-8")
SYNTHETIC_HADITH_ID = 990001
D83_HADITH_ID = 66511
SESSION_URL = "https://claude.ai/code/session_test"
# inside the window of the ticking test clock: after the validation, before "now" plus the skew
APPROVAL_AT = "2026-10-04T12:03:00+00:00"
OWNER_WORDS = "words typed by the owner in the chat"


def not_nfc(text: str) -> str:
    """Same text with mark pairs in a non-canonical order: NFC-equal but not byte-equal."""
    shadda = chr(0x0651)
    swapped = text
    for code in (0x064E, 0x064C, 0x064F, 0x0650):  # fatha, tanwin damma, damma, kasra
        mark = chr(code)
        swapped = swapped.replace(mark + shadda, shadda + mark)
    assert swapped != text and unicodedata.normalize("NFC", swapped) == unicodedata.normalize(
        "NFC", text
    )
    return swapped


class McpMock:
    """A minimal MCP server for ``tools/call``. An answer that is a list is consumed one entry
    per call (the last one repeats); an integer is an HTTP status."""

    def __init__(self, answers: dict[tuple[str, int], str | int | list[str]]) -> None:
        self.answers = {k: list(v) if isinstance(v, list) else v for k, v in answers.items()}
        self.calls: list[tuple[str, int]] = []
        self.hosts: set[str] = set()
        self.user_agents: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.hosts.add(request.url.host)
        self.user_agents.add(request.headers.get("user-agent", ""))
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
        if isinstance(answer, list):
            text = answer.pop(0) if len(answer) > 1 else answer[0]
        else:
            text = answer
        result = {"content": [{"type": "text", "text": text}]}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})


def surah_text(surah: int, ayat: int, verse: str) -> str:
    """A ``get_quran_verses`` answer made of ``ayat`` copies of one placeholder verse."""
    lines = [f'[Surah {surah}, translation "x"]', "[EXACT]"]
    for ayah in range(1, ayat + 1):
        lines += [f"[{surah}:{ayah}]", verse, ""]
    lines += ["[/EXACT]", f"Source: https://islamenc.com/ar/quran/{surah}"]
    return "\n".join(lines) + "\n"


def hadith_text(hadeethenc_id: int, *, base: str = HADITH_RESPONSE) -> str:
    """The synthetic ``get_hadith`` answer, carrying another record id."""
    return base.replace(str(SYNTHETIC_HADITH_ID), str(hadeethenc_id))


def quran_verses() -> list[str]:
    return [r["text"] for r in load_json(QURAN_RECORDS)["records"]]


def rows(build: Path, edition: str, bank: int = 1) -> dict[str, ContentJob]:
    return {j.step: j for j in LocalJobRepository(BuildPaths(build)).list_jobs(edition, bank)}


def id_map(tmp_path: Path, mapping: dict[str, int] | None = None) -> Path:
    return write_json(tmp_path / "ids.json", mapping or {"1": D83_HADITH_ID})


def single_hadith_records(tmp_path: Path) -> tuple[Path, Path]:
    """Records files of pass 1 and pass 2 holding the first synthetic hadith only."""
    paths = []
    for number in (1, 2):
        data = load_json(DATA / f"synthetic_hadith_records_pass{number}.json")
        data["records"] = [r for r in data["records"] if r["fortyNumber"] == 1]
        paths.append(write_json(tmp_path / f"one_pass{number}.json", data))
    return paths[0], paths[1]


def acquire_quran_http(build: Path, transport: httpx.BaseTransport, *extra: str) -> int:
    return run_cli(
        quran_args("acquire", "--http", "--surahs", "112", *extra), build, transport=transport
    )


def acquire_hadith_http(
    build: Path, transport: httpx.BaseTransport, ids: Path, *, passes: tuple[int, ...] = (1, 2)
) -> list[int]:
    return [
        run_cli(
            hadith_args(
                "acquire", "--http", "--forty", "1", "--pass", str(p), "--id-map", str(ids)
            ),
            build,
            transport=transport,
        )
        for p in passes
    ]


def quran_to_validated(build: Path) -> None:
    """acquire (records), verify (oracle), segment, build-bank, validate for surah 112."""
    steps = [
        quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"),
        quran_args("verify", "--oracle", str(ORACLE)),
        quran_args("segment", "--labels", str(LABELS)),
        quran_args("build-bank"),
        quran_args("validate"),
    ]
    for argv in steps:
        assert run_cli(argv, build) == 0, argv[0]


def hadith_to_validated(build: Path, tmp_path: Path) -> None:
    """The same for Forty hadith 1 (two records files)."""
    pass1, pass2 = single_hadith_records(tmp_path)
    steps = [
        hadith_args("acquire", "--pass", "1", "--records", str(pass1), "--forty", "1"),
        hadith_args("acquire", "--pass", "2", "--records", str(pass2)),
        hadith_args("verify"),
        hadith_args("segment", "--labels", str(LABELS), "--boundaries", str(BOUNDARIES)),
        hadith_args("build-bank"),
        hadith_args("validate"),
    ]
    for argv in steps:
        assert run_cli(argv, build) == 0, argv[0]


def approve_argv(
    edition: str = QURAN_ED,
    *,
    words: str | None = OWNER_WORDS,
    at: str | None = APPROVAL_AT,
    source: str | None = SESSION_URL,
    reviewer: str | None = "owner (recorded by the coordinator)",
    scope: str | None = "automated gates; no human text comparison",
    note: str | None = "approved after the build report",
    bank: int = 1,
) -> list[str]:
    """The ``approve`` argument list; an input that is None is left out."""
    argv = ["approve", "--edition", edition, "--bank-version", str(bank)]
    for flag, value in (
        ("--owner-words", words),
        ("--at", at),
        ("--source", source),
        ("--reviewer", reviewer),
        ("--review-scope", scope),
        ("--note", note),
    ):
        if value is not None:
            argv += [flag, value]
    return argv


ORDER = ["acquired", "verified", "segmented", "bank_built", "validated", "approved", "published"]
PASSED = {"method": "m", "result": "passed", "details": ""}
FAILED = {"method": "m", "result": "failed", "details": ""}
SEEDED_APPROVAL = {
    "who": "owner",
    "at": "2026-10-04T12:00:00Z",
    "note": "n",
    "scope": "s",
    "words": "w",
    "source": SESSION_URL,
}


def seed_rows(
    build: Path,
    steps: list[str],
    *,
    verification: dict[str, str] | None = PASSED,
    approval: dict[str, str] | None = None,
    edition: str = QURAN_ED,
) -> None:
    """Write succeeded job rows for ``steps`` without running anything (policy tests)."""
    from datetime import UTC, datetime

    from app.workflow.jobs import new_job

    repo = LocalJobRepository(BuildPaths(build))
    now = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)
    for step in steps:
        job = new_job(edition, 1, step, now=now, status="succeeded")
        summary: dict[str, object] = {}
        if step == "verified" and verification is not None:
            summary["verification"] = verification
        if step == "approved":
            summary["approval"] = approval if approval is not None else SEEDED_APPROVAL
        repo.save_job(job.model_copy(update={"validation_summary": summary or None}))


def jsonb_literals(statement: str) -> list[Any]:
    """The jsonb literals (``'...'::jsonb``) of one statement, decoded (test aid)."""
    found: list[Any] = []
    i, n = 0, len(statement)
    while i < n:
        if statement[i] != "'":
            i += 1
            continue
        j, chars = i + 1, []
        while j < n:
            if statement[j] == "'":
                if j + 1 < n and statement[j + 1] == "'":
                    chars.append("'")
                    j += 2
                    continue
                break
            chars.append(statement[j])
            j += 1
        if statement.startswith("::jsonb", j + 1):
            found.append(json.loads("".join(chars)))
        i = j + 1
    return found


def job_row_lines(statement: str) -> dict[str, str]:
    """The ``content_jobs`` value rows of the insert statement, keyed by step (test aid)."""
    steps = (
        "acquired|verified|segmented|bank_built|validated|approved|published|page_mapped|embedded"
    )
    lines: dict[str, str] = {}
    for line in statement.splitlines():
        match = re.match(
            rf"^  \('[0-9a-f-]{{36}}'::uuid, '[0-9a-f-]{{36}}'::uuid, \d+, '[^']*', '({steps})'",
            line,
        )
        if match:
            lines[match.group(1)] = line
    return lines


def sql_statements(sql: str) -> list[str]:
    """Split SQL text into statements, honouring '...' strings and $tag$ blocks (test aid)."""
    statements: list[str] = []
    current: list[str] = []
    i, n = 0, len(sql)
    in_string = False
    dollar: str | None = None
    while i < n:
        ch = sql[i]
        if dollar is not None:
            end = sql.find(dollar, i)
            assert end != -1, "unterminated dollar-quoted block"
            current.append(sql[i : end + len(dollar)])
            i = end + len(dollar)
            dollar = None
            continue
        if in_string:
            current.append(ch)
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    current.append("'")
                    i += 1
                else:
                    in_string = False
            i += 1
            continue
        if ch == "'":
            in_string = True
        elif ch == "$":
            end = sql.find("$", i + 1)
            tag = sql[i : end + 1] if end != -1 else ""
            if tag and tag[1:-1].isidentifier():
                dollar = tag
                current.append(tag)
                i += len(tag)
                continue
        elif ch == "-" and sql.startswith("--", i):
            newline = sql.find("\n", i)
            i = n if newline == -1 else newline
            continue
        if ch == ";":
            current.append(ch)
            statements.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    assert not in_string and dollar is None, "unterminated string"
    assert "".join(current).strip() == "", "text after the last statement"
    return statements
