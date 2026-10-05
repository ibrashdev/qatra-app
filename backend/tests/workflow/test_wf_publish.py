"""``publish --sql-out``: ONE transactional SQL file below the build directory, nothing applied.

The file holds the draft upserts, the recorded license (with ``owner_acceptance`` taken from the
approval), the review record with the acquisition, verification and approval entries, the
publishing statements and the ``content_jobs`` rows including ``approved`` and ``published`` with
``published_at``. Synthetic data only; no database exists in these tests, so the SQL is checked as
text (statement structure, literals), not executed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.domain.content_policy import PublishRefusedError
from app.workflow import license_record as lr
from app.workflow.approval import APPROVAL_KEYS, is_complete_approval
from app.workflow.errors import ExitCode
from app.workflow.publication import BUCKET_NOTE, resolve_sql_out
from app.workflow.publish_sql import FINAL_MARKER
from tests.workflow.wf_d83_support import (
    ORDER,
    OWNER_WORDS,
    SEEDED_APPROVAL,
    SESSION_URL,
    approve_argv,
    hadith_to_validated,
    job_row_lines,
    jsonb_literals,
    quran_to_validated,
    rows,
    seed_rows,
    sql_statements,
)
from tests.workflow.wf_support import (
    HADITH_ED,
    QURAN_ED,
    assert_no_source_text,
    run_cli,
)

QUR_AN_SENTENCE = (
    "This server provides read-only programmatic access to published Islamic texts: the Holy "
    "Qur’an with translations, the Prophetic Hadith collection, and the IslamHouse library, "
    "for use by AI assistants via the Model Context Protocol. It is provided free of charge."
)
GRADINGS_SENTENCE = (
    "Translations and authenticity gradings are the work of the publishing institutions."
)


def publish_argv(
    build: Path, edition: str = QURAN_ED, name: str = "publish-final.sql"
) -> list[str]:
    return [
        "publish",
        "--edition",
        edition,
        "--bank-version",
        "1",
        "--sql-out",
        str(build / edition / name),
    ]


@pytest.fixture
def approved(tmp_path: Path) -> Path:
    build = tmp_path / "build"
    quran_to_validated(build)
    assert run_cli(approve_argv(), build) == 0
    return build


def sql_of(build: Path, edition: str = QURAN_ED, name: str = "publish-final.sql") -> str:
    return (build / edition / name).read_text(encoding="utf-8")


def statement(statements: list[str], prefix: str) -> str:
    (found,) = [s for s in statements if s.startswith(prefix)]
    return found


def files(build: Path) -> list[str]:
    return sorted(p.relative_to(build).as_posix() for p in build.rglob("*") if p.is_file())


# --- the file ------------------------------------------------------------------------------


def test_publish_writes_one_transactional_file_and_applies_nothing(
    approved: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    jobs_before = (approved / QURAN_ED / "jobs.json").read_bytes()
    draft_before = (approved / QURAN_ED / "publish.sql").read_bytes()
    bundle_before = (approved / QURAN_ED / "bundle.json").read_bytes()
    files_before = files(approved)
    capsys.readouterr()

    assert run_cli(publish_argv(approved), approved) == 0
    captured = capsys.readouterr()
    assert (
        "publish quran-hafs-quranenc bank_version=1 status=sql_written changed=yes" in captured.out
    )
    assert "applied=no" in captured.out and re.search(r"sql_sha256=[0-9a-f]{64}", captured.out)
    assert "units=4" in captured.out and "questions=17" in captured.out
    assert (
        "job_rows=9" in captured.out
    )  # 7 recorded steps with the two skipped ones, plus published

    # only the one new file; the local rows, the draft SQL and the bundle are untouched
    assert files(approved) == sorted([*files_before, f"{QURAN_ED}/publish-final.sql"])
    assert (approved / QURAN_ED / "jobs.json").read_bytes() == jobs_before
    assert (approved / QURAN_ED / "publish.sql").read_bytes() == draft_before
    assert (approved / QURAN_ED / "bundle.json").read_bytes() == bundle_before
    assert "published" not in rows(approved, QURAN_ED)

    sql = sql_of(approved)
    assert sql.startswith(FINAL_MARKER)
    statements = sql_statements(sql)
    assert statements[0] == "begin;" and statements[-1] == "commit;"
    assert statements.count("begin;") == 1 and statements.count("commit;") == 1
    assert statements[2].startswith("do $guard$ begin") and "status <> 'draft'" in statements[2]
    assert not [s for s in statements if re.match(r"(drop|truncate|alter|grant|revoke)\b", s)]
    assert not [s for s in statements if re.match(r"(set|reset)\s+(local\s+)?role\b", s)]


def test_the_publishing_statements_follow_the_upserts_in_one_transaction(approved: Path) -> None:
    assert run_cli(publish_argv(approved), approved) == 0
    statements = sql_statements(sql_of(approved))
    heads = [s.split("\n", 1)[0] for s in statements]

    def index(prefix: str) -> int:
        (position,) = [i for i, head in enumerate(heads) if head.startswith(prefix)]
        return position

    lessons = index("update public.lessons set status = 'published'")
    questions = index("update public.question_items set status = 'published'")
    superseded = index("update public.book_editions as earlier set status = 'superseded'")
    published = index("update public.book_editions set status = 'published'")
    last_insert = max(i for i, head in enumerate(heads) if head.startswith("insert into"))
    jobs = index("insert into public.content_jobs")
    assert index("insert into public.book_editions") < lessons < questions < superseded < published
    assert published < jobs == last_insert  # the job rows close the transaction
    assert "and bank_version = 1;" in statements[lessons]
    assert "earlier.status = 'published'" in statements[superseded]
    assert "earlier.id <> " in statements[superseded]
    assert "earlier_book.title_ar = this_book.title_ar" in statements[superseded]
    assert re.search(r"where id = '[0-9a-f-]{36}'::uuid;$", statements[published])


def test_the_license_record_holds_the_terms_the_register_and_the_owners_acceptance(
    approved: Path,
) -> None:
    assert run_cli(publish_argv(approved), approved) == 0
    statements = sql_statements(sql_of(approved))
    eligibility, license_record = jsonb_literals(
        statement(statements, "insert into public.sources")
    )
    assert eligibility["decision"] == "D68"
    entry = rows(approved, QURAN_ED)["approved"].validation_summary["approval"]
    assert set(license_record) == {
        "terms_title",
        "terms_url",
        "terms_last_updated_text",
        "terms_last_updated",
        "terms_retrieved",
        "terms_quotes",
        "publisher_pages_note",
        "register",
        "owner_acceptance",
    }
    assert license_record["terms_url"] == "https://mcp.islamiccontent.org/terms.html"
    assert license_record["terms_title"] == "Islamic Content MCP Server Terms of Use"
    assert license_record["terms_last_updated_text"] == "Last updated 14 September 2026"
    assert license_record["terms_last_updated"] == "2026-09-14"
    assert license_record["terms_retrieved"] == "2026-10-05"
    assert license_record["terms_quotes"] == [QUR_AN_SENTENCE, GRADINGS_SENTENCE]
    assert (
        "not reachable from the build environment on 5 October 2026"
        in (license_record["publisher_pages_note"])
    )
    assert license_record["register"] == {
        "path": "references/source-acquisition/publisher-terms-register.md",
        "version": "v0.1 Draft",
    }
    acceptance = license_record["owner_acceptance"]
    assert {k: acceptance[k] for k in ("who", "at", "source", "words")} == {
        "who": entry["who"],
        "at": entry["at"],
        "source": SESSION_URL,
        "words": OWNER_WORDS,
    }
    assert "recorded for this edition" in acceptance["basis"]
    # the source row keeps the pending rights status: the terms grant no reuse right
    assert "owner_accepted_pending_verification" in statement(
        statements, "insert into public.sources"
    )


def test_the_review_record_carries_the_acquisition_verification_and_approval_entries(
    approved: Path,
) -> None:
    assert run_cli(publish_argv(approved), approved) == 0
    statements = sql_statements(sql_of(approved))
    _pagination, review = jsonb_literals(statement(statements, "insert into public.book_editions"))
    entry = rows(approved, QURAN_ED)["approved"].validation_summary["approval"]
    assert set(review) == {
        "knownGaps",
        "suspectedErrors",
        "acquisition",
        "verification",
        "approval",
    }
    assert review["approval"] == entry and set(entry) == set(APPROVAL_KEYS)
    assert review["verification"]["result"] == "passed"
    assert review["acquisition"]["recordIds"] == ["112:1", "112:2", "112:3", "112:4"]


def test_the_job_rows_include_approved_and_published_with_published_at(approved: Path) -> None:
    assert run_cli(publish_argv(approved), approved) == 0
    jobs_statement = statement(sql_statements(sql_of(approved)), "insert into public.content_jobs")
    header = jobs_statement.split("values", 1)[0]
    assert "published_at" in header and header.count(",") == 8  # nine columns
    assert jobs_statement.rstrip(";").endswith("published_at = excluded.published_at")
    lines = job_row_lines(jobs_statement)
    assert set(lines) == {
        "acquired",
        "verified",
        "segmented",
        "bank_built",
        "validated",
        "approved",
        "page_mapped",
        "embedded",
        "published",
    }
    for step, line in lines.items():
        if step == "published":  # the last row also carries the conflict clause
            assert ", now()) on conflict (edition_id, bank_version, step)" in line
        else:
            assert line.rstrip(",").endswith(", null)"), step  # no published_at
        assert ("'succeeded'" in line) or step in {"page_mapped", "embedded"}
    assert lines["approved"].count("'succeeded'") == 1
    approved_summary = jsonb_literals(lines["approved"])[-1]
    assert approved_summary["approval"]["words"] == OWNER_WORDS

    summary = jsonb_literals(lines["published"])[-1]
    assert summary["bucketUpload"] == BUCKET_NOTE
    assert BUCKET_NOTE == "bucket upload deferred: no service_role key in the build environment"
    assert summary["mode"] == "sql_file"
    assert summary["counts"] == {
        "sections": 1,
        "units": 4,
        "passages": 1,
        "parts": 4,
        "lessons": 1,
        "questions": 17,
    }
    assert set(summary["rawObjects"]["sha256"]) == {"bank1-surah-112.json"}
    assert re.fullmatch(r"[0-9a-f]{64}", summary["rawObjects"]["sha256"]["bank1-surah-112.json"])
    assert summary["approval"] == {
        key: rows(approved, QURAN_ED)["approved"].validation_summary["approval"][key]
        for key in ("who", "at", "source")
    }
    assert "words" not in summary["approval"]


def test_publishing_the_hadith_edition_records_the_omitted_grade_in_the_review_record(
    tmp_path: Path,
) -> None:
    build = tmp_path / "build"
    hadith_to_validated(build, tmp_path)
    assert run_cli(approve_argv(HADITH_ED), build) == 0
    assert run_cli(publish_argv(build, HADITH_ED), build) == 0
    statements = sql_statements(sql_of(build, HADITH_ED))
    _pagination, review = jsonb_literals(statement(statements, "insert into public.book_editions"))
    assert [s["kind"] for s in review["suspectedErrors"]] == ["grade_path_unavailable"]
    assert review["approval"]["source"] == SESSION_URL
    assert not [
        s for s in statements if "'grade'" in s and s.startswith("insert into public.passages")
    ]


def test_the_file_is_deterministic_and_a_repeat_writes_nothing(
    approved: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run_cli(publish_argv(approved), approved) == 0
    first = (approved / QURAN_ED / "publish-final.sql").read_bytes()
    capsys.readouterr()
    assert run_cli(publish_argv(approved), approved) == 0
    assert "changed=no" in capsys.readouterr().out
    assert (approved / QURAN_ED / "publish-final.sql").read_bytes() == first
    assert b", now()) on conflict" in first  # published_at is the database time, not the CLI's


def test_a_new_approval_replaces_a_final_file_this_command_wrote(approved: Path) -> None:
    assert run_cli(publish_argv(approved), approved) == 0
    first = (approved / QURAN_ED / "publish-final.sql").read_bytes()
    assert run_cli(approve_argv(words="other words"), approved) == 0
    assert run_cli(publish_argv(approved), approved) == 0
    second = (approved / QURAN_ED / "publish-final.sql").read_bytes()
    assert second != first and b"other words" in second and b"other words" not in first


def test_the_cli_prints_and_reports_no_source_text(
    approved: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    capsys.readouterr()
    assert run_cli(publish_argv(approved), approved) == 0
    out = capsys.readouterr().out
    # the reports and job files stay text-free; bundle.json and the two SQL files hold the text
    reports = ["acquisition_report.md", "verification_report.md", "report.md", "jobs.json"]
    texts = [(approved / QURAN_ED / name).read_text(encoding="utf-8") for name in reports]
    assert_no_source_text(out, *texts, (approved / "acquisition_report.md").read_text("utf-8"))
    assert "publish-final.sql" not in "".join(texts)
    assert OWNER_WORDS not in out


# --- refusals ------------------------------------------------------------------------------


def test_publish_refuses_when_no_approval_exists(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    quran_to_validated(build)
    capsys.readouterr()
    assert run_cli(publish_argv(build), build) == ExitCode.PRECONDITION
    assert "'published' requires step 'approved'" in capsys.readouterr().err
    assert not (build / QURAN_ED / "publish-final.sql").exists()


def test_publish_refuses_an_approved_row_without_an_approval_entry(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    seed_rows(build, ORDER[:6], approval={})  # the approved step exists, its entry is empty
    assert run_cli(publish_argv(build), build) == ExitCode.PRECONDITION
    assert "approval_missing" in capsys.readouterr().err
    assert not (build / QURAN_ED / "publish-final.sql").exists()


@pytest.mark.parametrize("missing", ["words", "source", "scope"])
def test_publish_refuses_an_approval_entry_that_lacks_a_recorded_input(
    tmp_path: Path, missing: str, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    approval = {k: v for k, v in SEEDED_APPROVAL.items() if k != missing}
    seed_rows(build, ORDER[:6], approval=approval)
    assert run_cli(publish_argv(build), build) == ExitCode.PRECONDITION
    assert "approval_incomplete" in capsys.readouterr().err
    assert not (build / QURAN_ED / "publish-final.sql").exists()


def test_publish_refuses_an_unvalidated_edition_and_a_failed_verification(tmp_path: Path) -> None:
    build = tmp_path / "build"
    seed_rows(build, ["acquired", "verified", "segmented", "bank_built", "approved"])
    assert run_cli(publish_argv(build), build) == ExitCode.PRECONDITION
    other = tmp_path / "other"
    seed_rows(
        other,
        ORDER[:6],
        verification={"method": "m", "result": "failed", "details": ""},
    )
    assert run_cli(publish_argv(other), other) == ExitCode.PRECONDITION
    assert not (other / QURAN_ED / "publish-final.sql").exists()


def test_publish_refuses_a_version_that_is_already_published(tmp_path: Path) -> None:
    build = tmp_path / "build"
    seed_rows(build, ORDER)
    assert run_cli(publish_argv(build), build) == ExitCode.PRECONDITION


def test_publish_refuses_a_bundle_that_changed_after_the_approval(
    approved: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bundle = approved / QURAN_ED / "bundle.json"
    text = bundle.read_text(encoding="utf-8")
    bundle.write_text(text.replace('"bankVersion": 1,', '"bankVersion": 2,', 1), encoding="utf-8")
    capsys.readouterr()
    assert run_cli(publish_argv(approved), approved) == ExitCode.PRECONDITION
    assert "not the bundle that validate accepted" in capsys.readouterr().err
    assert not (approved / QURAN_ED / "publish-final.sql").exists()


def test_sql_out_is_required_and_must_lie_below_the_build_directory(
    approved: Path, tmp_path: Path
) -> None:
    base = ["publish", "--edition", QURAN_ED, "--bank-version", "1"]
    assert run_cli(base, approved) == ExitCode.USAGE  # --sql-out is required
    outside = tmp_path / "elsewhere.sql"
    assert run_cli([*base, "--sql-out", str(outside)], approved) == ExitCode.USAGE
    assert not outside.exists()
    traversal = str(approved / QURAN_ED / ".." / ".." / "escape.sql")
    assert run_cli([*base, "--sql-out", traversal], approved) == ExitCode.USAGE
    assert run_cli([*base, "--sql-out", str(approved)], approved) == ExitCode.USAGE  # the root
    assert run_cli([*base, "--sql-out", str(approved / QURAN_ED)], approved) == ExitCode.USAGE
    assert not (tmp_path / "escape.sql").exists()


def test_an_existing_file_that_is_not_a_final_publish_file_is_never_replaced(
    approved: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    draft = approved / QURAN_ED / "publish.sql"  # the draft SQL of the build
    before = draft.read_bytes()
    capsys.readouterr()
    assert run_cli(publish_argv(approved, name="publish.sql"), approved) == ExitCode.PRECONDITION
    assert "not a final publish file" in capsys.readouterr().err
    assert draft.read_bytes() == before


def test_resolve_sql_out_rules(tmp_path: Path) -> None:
    root = tmp_path / "build"
    root.mkdir()
    assert resolve_sql_out(root / "a" / "x.sql", root) == (root / "a" / "x.sql").resolve()
    from app.workflow.errors import InputError

    for bad in (tmp_path / "x.sql", root, root / ".." / "x.sql"):
        with pytest.raises(InputError):
            resolve_sql_out(bad, root)


# --- the license record --------------------------------------------------------------------


def test_the_license_record_is_built_only_from_a_complete_approval() -> None:
    with pytest.raises(PublishRefusedError) as missing:
        lr.build_license_record(None)
    assert missing.value.code == "approval_missing"
    for key in APPROVAL_KEYS:
        partial = {k: v for k, v in SEEDED_APPROVAL.items() if k != key}
        assert not is_complete_approval(partial)
        with pytest.raises(PublishRefusedError) as incomplete:
            lr.build_license_record(partial)
        assert incomplete.value.code == "approval_incomplete"
    blank = dict(SEEDED_APPROVAL, words="  ")
    with pytest.raises(PublishRefusedError):
        lr.build_license_record(blank)
    record = lr.build_license_record(SEEDED_APPROVAL)
    assert record["owner_acceptance"]["words"] == SEEDED_APPROVAL["words"]
    assert record["owner_acceptance"]["source"] == SEEDED_APPROVAL["source"]
    assert is_complete_approval(SEEDED_APPROVAL)


def test_the_recorded_terms_are_exactly_the_wording_of_the_brief() -> None:
    assert lr.TERMS_QUOTES == (QUR_AN_SENTENCE, GRADINGS_SENTENCE)
    assert "’" in lr.TERMS_QUOTES[0]  # the typographic apostrophe of the page
    assert json.dumps(lr.REGISTER) == json.dumps(
        {
            "path": "references/source-acquisition/publisher-terms-register.md",
            "version": "v0.1 Draft",
        }
    )


def test_no_arabic_letter_is_in_any_new_module_source() -> None:
    """The new modules hold no source text and no Arabic letters at all."""
    root = Path(__file__).resolve().parents[2]

    def has_arabic(text: str) -> bool:
        return any(0x0600 <= ord(ch) <= 0x06FF or 0x0750 <= ord(ch) <= 0x077F for ch in text)

    names = [
        "app/workflow/source_only.py",
        "app/workflow/approval.py",
        "app/workflow/license_record.py",
        "app/workflow/publication.py",
    ]
    for name in names:
        assert not has_arabic((root / name).read_text(encoding="utf-8")), name
