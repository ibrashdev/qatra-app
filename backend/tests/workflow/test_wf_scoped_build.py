"""Scoped builds: ``segment``, ``build-bank`` and ``validate`` follow the scope recorded by
``acquire`` and never expect the whole of Juz' Amma or all 42 hadiths.

The one place where a narrow scope used to fail was the grade path: its question is a choice among
the distinct grade phrases of the edition, so an edition with fewer than two cannot test it. A
sample build now makes no grade passage in that case; a full build is unchanged. Synthetic text
only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.workflow.bundle import assemble_bundle, with_bank
from app.workflow.editions import (
    EDITION_HADITH,
    EDITION_QURAN,
    EditionScope,
    default_scope,
    edition_spec,
    is_full_scope,
)
from app.workflow.errors import ExitCode
from app.workflow.labels import load_labels
from app.workflow.lesson_question_builder import build_question_bank
from app.workflow.models import HadithRecord
from app.workflow.segmentation import MIN_GRADE_PHRASES, distinct_grade_phrases, segment_hadith
from app.workflow.validation import validate_bank
from tests.workflow.wf_d83_support import (
    BOUNDARIES,
    LABELS,
    hadith_to_validated,
    quran_to_validated,
    rows,
)
from tests.workflow.wf_support import (
    DATA,
    HADITH_ED,
    QURAN_ED,
    hadith_args,
    load_json,
    run_cli,
    write_json,
)


def passage_paths(build: Path, edition: str) -> list[str]:
    bundle = json.loads((build / edition / "bundle.json").read_text(encoding="utf-8"))
    return [p["path"] for p in bundle["passages"]]


def synthetic_record(number: int, grade: str | None = None) -> HadithRecord:
    base = load_json(DATA / "synthetic_hadith_records_pass1.json")["records"][0]
    data = dict(base, fortyNumber=number, hadeethencId=990000 + number)
    data["url"] = f"https://hadeethenc.com/ar/browse/hadith/{990000 + number}"
    if grade is not None:
        data["grade"] = grade
    return HadithRecord.model_validate(data)


def segment_sample(records: dict[int, HadithRecord], *, sample: bool) -> Any:
    return segment_hadith(
        edition_key=HADITH_ED,
        bank_version=1,
        records=records,
        numbers=sorted(records),
        labels=load_labels(HADITH_ED, LABELS),
        boundaries={},
        sample=sample,
    )


def bank_report(segment: Any) -> Any:
    bundle = assemble_bundle(
        spec=edition_spec(HADITH_ED),
        bank_version=1,
        labels=load_labels(HADITH_ED, LABELS),
        segment=segment,
        provenance={
            "acquisition": "mcp_tool",
            "toolName": "get_hadith",
            "rawSha256": "0" * 64,
            "retrievedAt": "2026-10-04T10:00:00Z",
        },
        verification={"method": "m", "result": "passed"},
        known_gaps=[],
        suspected=[],
    )
    result = build_question_bank(bundle)
    return validate_bank(with_bank(bundle, result.lessons, result.questions))


# --- the scope helper ----------------------------------------------------------------------


def test_is_full_scope_is_true_only_for_the_whole_edition() -> None:
    assert is_full_scope(EDITION_QURAN, default_scope(EDITION_QURAN))
    assert is_full_scope(EDITION_HADITH, default_scope(EDITION_HADITH))
    assert not is_full_scope(EDITION_QURAN, EditionScope(surahs=(112,)))
    assert not is_full_scope(EDITION_QURAN, EditionScope(surahs=tuple(range(78, 114))))
    assert not is_full_scope(EDITION_HADITH, EditionScope(forty_numbers=(1,)))
    assert not is_full_scope(EDITION_HADITH, EditionScope(forty_numbers=tuple(range(1, 42))))


# --- a one-surah sample --------------------------------------------------------------------


def test_a_one_surah_sample_is_built_and_validated_on_its_own_scope(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    quran_to_validated(build)
    out = capsys.readouterr().out
    assert "segment" in out and "sections=1 units=4" in out
    assert "validate" in out and "issues=0" in out
    jobs = rows(build, QURAN_ED)
    assert jobs["validated"].status == "succeeded"
    assert jobs["segmented"].validation_summary["sampleBuild"] is True
    assert jobs["segmented"].validation_summary["scope"] == {"surahs": [112], "fortyNumbers": []}
    assert set(passage_paths(build, QURAN_ED)) == {"quran"}


# --- a one-hadith sample -------------------------------------------------------------------


def test_a_one_hadith_sample_makes_no_untestable_grade_passage_and_validates(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    hadith_to_validated(build, tmp_path)
    out = capsys.readouterr().out
    assert "grade_passages_omitted=[forty:1:grade]" in out
    assert "validate" in out and "issues=0" in out
    paths = passage_paths(build, HADITH_ED)
    assert "grade" not in paths and {"matn", "sanad"} <= set(paths)

    bundle = json.loads((build / HADITH_ED / "bundle.json").read_text(encoding="utf-8"))
    assert [u["kind"] for u in bundle["units"]].count("hadith_grade") == 1  # the grade is kept
    assert bundle["units"][0]["hadithMeta"]["gradeRecorded"] is True
    (flag,) = [
        s
        for s in bundle["edition"]["reviewRecord"]["suspectedErrors"]
        if s["kind"] == "grade_path_unavailable"
    ]
    assert flag["unit"] == "forty:1:grade" and "fewer than two" in flag["details"]
    summary = rows(build, HADITH_ED)["segmented"].validation_summary
    assert summary["sampleBuild"] is True and summary["passagesByPath"].get("grade") is None
    report = (build / HADITH_ED / "report.md").read_text(encoding="utf-8")
    assert "grade_path_unavailable" in report and "Result: **passed**" in report


def test_a_sample_with_two_distinct_grade_phrases_keeps_the_grade_passages(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    paths = []
    for number in (1, 2):
        data = load_json(DATA / f"synthetic_bundle_hadith_pass{number}.json")
        data["records"] = [r for r in data["records"] if r["fortyNumber"] in (1, 2)]
        paths.append(write_json(tmp_path / f"two_pass{number}.json", data))
    steps = [
        hadith_args("acquire", "--pass", "1", "--records", str(paths[0]), "--forty", "1-2"),
        hadith_args("acquire", "--pass", "2", "--records", str(paths[1])),
        hadith_args("verify"),
        hadith_args("segment", "--labels", str(LABELS), "--boundaries", str(BOUNDARIES)),
        hadith_args("build-bank"),
        hadith_args("validate"),
    ]
    for argv in steps:
        assert run_cli(argv, build) == 0, argv[0]
    out = capsys.readouterr().out
    assert "grade_passages_omitted" not in out and "issues=0" in out
    assert passage_paths(build, HADITH_ED).count("grade") == 2


# --- the full-scope default is unchanged ---------------------------------------------------


def test_the_grade_rule_is_scope_dependent_and_the_full_default_is_unchanged() -> None:
    one_phrase = {n: synthetic_record(n) for n in (1, 2)}
    assert distinct_grade_phrases(one_phrase, [1, 2]) == 1 < MIN_GRADE_PHRASES

    full = segment_sample(one_phrase, sample=False)  # the default
    sample = segment_sample(one_phrase, sample=True)
    assert [p["path"] for p in full.passages].count("grade") == 2
    assert [p["path"] for p in sample.passages].count("grade") == 0
    assert not [s for s in full.suspected if s["kind"] == "grade_path_unavailable"]
    assert len([s for s in sample.suspected if s["kind"] == "grade_path_unavailable"]) == 2

    two_phrases = {1: synthetic_record(1), 2: synthetic_record(2, grade=load_other_grade())}
    assert distinct_grade_phrases(two_phrases, [1, 2]) == 2
    kept = segment_sample(two_phrases, sample=True)
    assert [p["path"] for p in kept.passages].count("grade") == 2


def load_other_grade() -> str:
    """A grade phrase that differs from the synthetic one (taken from the 4-hadith fixture)."""
    records = load_json(DATA / "synthetic_bundle_hadith_pass1.json")["records"]
    return records[1]["grade"]


def test_a_full_build_still_fails_closed_when_a_grade_cannot_be_tested() -> None:
    """The validation rule is not weakened: a grade passage without a question is refused."""
    one_phrase = {n: synthetic_record(n) for n in (1, 2)}
    full_report = bank_report(segment_sample(one_phrase, sample=False))
    assert {i.code for i in full_report.issues} == {"part_uncovered"}
    assert all(i.ref.startswith("grade:") for i in full_report.issues)
    assert bank_report(segment_sample(one_phrase, sample=True)).ok


def test_a_full_scope_build_through_the_cli_keeps_every_grade_passage(tmp_path: Path) -> None:
    """42 hadiths with one grade phrase: segmentation makes all 42 grade passages (no sample
    exception) and ``validate`` fails closed on them."""
    build = tmp_path / "build"
    labels = load_json(LABELS)
    titles = labels["editions"][HADITH_ED]["sectionTitlesAr"]
    titles.update({str(n): titles["1"] for n in range(1, 43)})
    labels_path = write_json(tmp_path / "labels42.json", labels)
    base = load_json(DATA / "synthetic_hadith_records_pass1.json")
    files = []
    for number in (1, 2):
        data = dict(base, retrievedAt=f"2026-10-04T10:{number:02d}:00Z")
        data["records"] = [
            dict(
                base["records"][0],
                fortyNumber=n,
                hadeethencId=990000 + n,
                url=f"https://hadeethenc.com/ar/browse/hadith/{990000 + n}",
            )
            for n in range(1, 43)
        ]
        files.append(write_json(tmp_path / f"full_pass{number}.json", data))
    steps = [
        hadith_args("acquire", "--pass", "1", "--records", str(files[0])),
        hadith_args("acquire", "--pass", "2", "--records", str(files[1])),
        hadith_args("verify"),
        hadith_args("segment", "--labels", str(labels_path), "--boundaries", str(BOUNDARIES)),
        hadith_args("build-bank"),
    ]
    for argv in steps:
        assert run_cli(argv, build) == 0, argv[0]
    summary = rows(build, HADITH_ED)["segmented"].validation_summary
    assert summary["sampleBuild"] is False
    assert summary["passagesByPath"]["grade"] == 42
    assert run_cli(hadith_args("validate"), build) == ExitCode.VERIFICATION_FAILED
    report = (build / HADITH_ED / "report.md").read_text(encoding="utf-8")
    assert "| part_uncovered | grade:1:1 |" in report
