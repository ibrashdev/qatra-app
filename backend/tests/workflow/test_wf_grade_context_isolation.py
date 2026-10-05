"""Generic single-word questions ignore grade-only passages (synthetic text only)."""

from __future__ import annotations

from app.workflow.bundle import assemble_bundle, with_bank
from app.workflow.bundle_index import BundleIndex
from app.workflow.editions import edition_spec
from app.workflow.labels import load_labels
from app.workflow.lesson_question_builder import build_question_bank
from app.workflow.models import HadithRecord
from app.workflow.segmentation import SegmentResult
from app.workflow.validation import validate_bank
from tests.workflow.test_wf_scoped_build import HADITH_ED, LABELS, segment_sample, synthetic_record


def _record(number: int, narration: str, grade: str | None = None) -> HadithRecord:
    record = synthetic_record(number, grade=grade)
    return record.model_copy(update={"narration": narration})


def _bank(segment: SegmentResult) -> dict:
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
        verification={"method": "synthetic", "result": "passed"},
        known_gaps=[],
        suspected=[],
    )
    result = build_question_bank(bundle)
    return with_bank(bundle, result.lessons, result.questions)


def test_singleton_matn_survives_distinct_singleton_grade_phrases() -> None:
    segment = segment_sample(
        {
            1: _record(1, "ماء", "موثق"),
            2: _record(2, "ماء", "حسن"),
        },
        sample=False,
    )
    bundle = _bank(segment)
    report = validate_bank(bundle)

    assert report.ok
    assert report.info["type_word_choice"] == 2
    assert report.info["questions"] == 4
    grade_passage_ids = {p["id"] for p in bundle["passages"] if p["path"] == "grade"}
    assert sum(q["passageId"] in grade_passage_ids for q in bundle["questions"]) == 2


def test_distinct_non_grade_singletons_at_empty_context_stay_ambiguous() -> None:
    segment = segment_sample(
        {1: _record(1, "ماء"), 2: _record(2, "نور")}, sample=False
    )
    bundle = _bank(segment)
    report = validate_bank(bundle)

    assert not report.ok
    assert any(issue.code == "part_uncovered" for issue in report.issues)

    index = BundleIndex(bundle)
    passage_index = next(i for i, passage in enumerate(index.passages) if passage["path"] == "matn")
    passage = index.passages[passage_index]
    word = index.passage_words(passage_index)[0]
    part_id = passage["parts"][0]["id"]
    forged = {
        "id": "forged-ambiguous-recall",
        "type": "word_recall",
        "variant": "keyword",
        "passageId": passage["id"],
        "coveredPartIds": [part_id],
        "tokenRefs": [word.ref],
        "optionRefs": None,
        "correctRef": [word.ref],
        "contextRefs": [],
        "reference": "synthetic",
    }
    bundle["questions"].append(forged)
    forged_report = validate_bank(bundle)
    assert any(
        issue.code == "ambiguous_item" and issue.ref == f"question:{len(bundle['questions'])}"
        for issue in forged_report.issues
    )
