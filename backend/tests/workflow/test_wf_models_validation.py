"""Models, raw-object integrity, edition constants and record-level validation."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import get_args

import pytest
from pydantic import ValidationError

from app.domain.content_policy import JOB_STATUSES, STEP_VOCABULARY
from app.workflow.editions import (
    QURAN_AYAH_COUNTS,
    EditionScope,
    default_scope,
    edition_spec,
    hadith_url,
    hadith_url_id,
    parse_number_spec,
    quran_url,
    quran_url_surah,
)
from app.workflow.errors import InputError, IntegrityError
from app.workflow.jobs import new_job
from app.workflow.models import (
    ContentJob,
    HadithRecord,
    JobStatus,
    JobStep,
    QuranRecord,
    RawObject,
    VerificationRecord,
    derive_edition_state,
    safe_validation_summary,
)
from app.workflow.validation import (
    hadith_gaps,
    missing_surahs,
    validate_hadith_records,
    validate_quran_records,
)

NOW = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


def quran(
    surah: int = 112, ayah: int = 1, text: str = "كلمة", url: str | None = None
) -> QuranRecord:
    return QuranRecord(surah=surah, ayah=ayah, text=text, url=url or quran_url(surah))


def hadith(number: int = 1, hid: int = 990001, **overrides: object) -> HadithRecord:
    values: dict[str, object] = {
        "hadeethenc_id": hid,
        "forty_number": number,
        "title": "t",
        "narration": "نص",
        "narrator": "رواه",
        "grade": "درجة",
        "url": hadith_url(hid),
        "languages": ["ar"],
    }
    values.update(overrides)
    return HadithRecord(**values)  # type: ignore[arg-type]


def test_edition_constants() -> None:
    assert len(QURAN_AYAH_COUNTS) == 37
    assert sorted(QURAN_AYAH_COUNTS) == list(range(78, 115))
    assert sum(QURAN_AYAH_COUNTS.values()) == 564
    assert default_scope("quran-hafs-quranenc").ayah_total() == 564
    assert default_scope("nawawi40-hadeethenc").forty_numbers == tuple(range(1, 43))
    assert edition_spec("quran-hafs-quranenc").tool_name == "get_quran_verses"
    assert edition_spec("nawawi40-hadeethenc").tool_name == "get_hadith"
    with pytest.raises(InputError):
        edition_spec("../etc")


def test_url_helpers() -> None:
    assert quran_url(112) == "https://islamenc.com/ar/quran/112"
    assert quran_url_surah("https://islamenc.com/ar/quran/112") == 112
    assert quran_url_surah("https://islamenc.com/ar/quran/112/") is None
    assert quran_url_surah("http://islamenc.com/ar/quran/112") is None
    assert hadith_url(66511) == "https://hadeethenc.com/ar/browse/hadith/66511"
    assert hadith_url_id("https://hadeethenc.com/ar/browse/hadith/66511") == 66511
    assert hadith_url_id("https://hadeethenc.com/en/browse/hadith/66511") is None


def test_parse_number_spec() -> None:
    assert parse_number_spec("112", low=78, high=114, label="x") == (112,)
    assert parse_number_spec("78-80,112", low=78, high=114, label="x") == (78, 79, 80, 112)
    assert parse_number_spec("3, 1", low=1, high=42, label="x") == (1, 3)
    for bad in ("", "a", "5-3", "1,,2", "0", "43", "1-43"):
        with pytest.raises(InputError):
            parse_number_spec(bad, low=1, high=42, label="x")


def test_scope_round_trip() -> None:
    scope = EditionScope(surahs=(112,))
    assert EditionScope.from_dict(scope.to_dict()) == scope
    with pytest.raises(InputError):
        EditionScope.from_dict({"surahs": "x"})


def test_records_are_strict_and_refuse_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        QuranRecord.model_validate(
            {"surah": 112, "ayah": 1, "text": "x", "url": "u", "tafsir": "t"}
        )
    with pytest.raises(ValidationError):
        QuranRecord.model_validate({"surah": "112", "ayah": 1, "text": "x", "url": "u"})
    with pytest.raises(ValidationError):
        QuranRecord.model_validate({"surah": 115, "ayah": 1, "text": "x", "url": "u"})
    with pytest.raises(ValidationError):
        HadithRecord.model_validate(
            {"hadeethencId": 1, "fortyNumber": 1, "narration": "n", "url": "u", "commentary": "c"}
        )
    with pytest.raises(ValidationError):
        HadithRecord.model_validate(
            {"hadeethencId": 1, "fortyNumber": 43, "narration": "n", "url": "u"}
        )
    record = HadithRecord.model_validate(
        {"hadeethencId": 1, "fortyNumber": 2, "narration": "n", "url": "u"}
    )
    assert (record.narrator, record.grade, record.title, record.languages) == ("", "", "", [])
    assert record.model_dump(by_alias=True)["hadeethencId"] == 1


def test_validation_summary_never_echoes_values() -> None:
    with pytest.raises(ValidationError) as error:
        QuranRecord.model_validate({"surah": 112, "ayah": 1, "text": 5, "url": "SECRET-VALUE"})
    summary = safe_validation_summary(error.value)
    assert "SECRET-VALUE" not in summary and "text:string_type" in summary


def make_raw(**overrides: object) -> RawObject:
    values: dict[str, object] = {
        "tool_name": "get_quran_verses",
        "arguments": {"surah": 112, "language": "ar"},
        "retrieved_at": NOW,
        "canonical_url": quran_url(112),
        "payload": {"records": [quran().model_dump()]},
    }
    values.update(overrides)
    return RawObject.build(**values)  # type: ignore[arg-type]


def test_raw_object_round_trip_and_hash() -> None:
    raw = make_raw()
    again = RawObject.from_bytes(raw.to_bytes())
    assert again == raw
    assert len(raw.raw_sha256) == 64
    assert make_raw().raw_sha256 == raw.raw_sha256  # deterministic
    assert make_raw(payload={"records": []}).raw_sha256 != raw.raw_sha256
    data = json.loads(raw.to_bytes())
    assert set(data) == {
        "toolName",
        "arguments",
        "retrievedAt",
        "canonicalUrl",
        "rawSha256",
        "payload",
        "acquisition",
        "passNumber",
    }
    assert data["retrievedAt"] == "2026-10-04T12:00:00Z"


def test_raw_object_detects_tampering_and_bad_shapes() -> None:
    raw = make_raw()
    data = json.loads(raw.to_bytes())
    data["payload"]["records"][0]["text"] = "tampered"
    with pytest.raises(IntegrityError):
        RawObject.from_bytes(json.dumps(data).encode())
    with pytest.raises(IntegrityError):
        RawObject.from_bytes(b"not json")
    with pytest.raises(IntegrityError):
        RawObject.from_bytes(b'{"toolName": "x"}')
    with pytest.raises(ValidationError):
        make_raw(retrieved_at=datetime(2026, 10, 4, 12, 0))  # naive time is refused


def test_verification_record_values() -> None:
    assert VerificationRecord(method="m", result="passed").details == ""
    with pytest.raises(ValidationError):
        VerificationRecord(method="m", result="maybe")  # type: ignore[arg-type]


def test_job_literals_match_policy_constants() -> None:
    assert set(get_args(JobStep)) == set(STEP_VOCABULARY)
    assert set(get_args(JobStatus)) == set(JOB_STATUSES)


def test_content_job_columns_and_rules() -> None:
    job = new_job("quran-hafs-quranenc", 1, "acquired", now=NOW)
    assert set(ContentJob.model_fields) == {
        "id",
        "edition_id",
        "edition_key",
        "bank_version",
        "pipeline_version",
        "step",
        "cursor",
        "status",
        "validation_summary",
        "published_at",
        "created_at",
        "updated_at",
    }
    assert job.status == "pending" and job.cursor is None and job.edition_id is None
    with pytest.raises(ValidationError):
        new_job("quran-hafs-quranenc", 0, "acquired", now=NOW)
    with pytest.raises(ValidationError):
        new_job("quran-hafs-quranenc", 1, "teleport", now=NOW)
    with pytest.raises(ValidationError):
        job.model_validate({**job.model_dump(), "status": "done"})
    with pytest.raises(ValidationError):
        job.model_validate({**job.model_dump(), "published_at": NOW})  # only on 'published'
    published = new_job("quran-hafs-quranenc", 1, "published", now=NOW)
    ContentJob.model_validate({**published.model_dump(), "published_at": NOW})
    with pytest.raises(ValidationError):
        job.model_validate({**job.model_dump(), "pipeline_version": ""})
    # ids are deterministic per (edition, bank version, step)
    assert job.id == new_job("quran-hafs-quranenc", 1, "acquired", now=NOW).id
    assert job.id != new_job("quran-hafs-quranenc", 2, "acquired", now=NOW).id


def test_edition_state_follows_api_spec_section_5_2() -> None:
    def rows(*steps: str) -> list[ContentJob]:
        return [new_job("e", 1, s, now=NOW, status="succeeded") for s in steps]

    assert derive_edition_state("e", 1, rows("acquired", "verified")).status == "draft"
    validated = derive_edition_state("e", 1, rows("acquired", "validated"))
    assert validated.status == "validated" and not validated.approval_recorded
    approved = derive_edition_state("e", 1, rows("acquired", "validated", "approved"))
    assert approved.status == "validated" and approved.approval_recorded
    published = derive_edition_state("e", 1, rows("validated", "approved", "published"))
    assert published.status == "published"
    archived = derive_edition_state("e", 1, rows("published", "archived"))
    assert archived.status == "published" and archived.catalog_hidden
    assert derive_edition_state("e", 1, rows("published", "withdrawn")).status == "revoked"
    failed = [new_job("e", 1, "validated", now=NOW, status="failed")]
    assert derive_edition_state("e", 1, failed).status == "draft"


# --- record validation ---------------------------------------------------------------------


def full_surah(surah: int = 112) -> list[QuranRecord]:
    return [quran(surah, a, f"نص{a}") for a in range(1, QURAN_AYAH_COUNTS[surah] + 1)]


def codes(report: object) -> set[str]:
    return {issue.code for issue in report.issues}  # type: ignore[attr-defined]


def test_valid_quran_records_pass() -> None:
    report = validate_quran_records(full_surah(), [112])
    assert report.ok and report.info["records"] == 4 and report.info["surahs"] == 1


def test_quran_validation_issues() -> None:
    assert "outside_scope" in codes(validate_quran_records(full_surah(112), [113]))
    bad_url = [quran(112, 1, "x", url="https://example.invalid/112"), *full_surah()[1:]]
    assert codes(validate_quran_records(bad_url, [112])) == {"url_shape"}
    assert "empty_text" in codes(
        validate_quran_records([quran(text="  "), *full_surah()[1:]], [112])
    )
    assert "newline_in_text" in codes(
        validate_quran_records([quran(text="a\nb"), *full_surah()[1:]], [112])
    )
    assert "non_bmp_character" in codes(
        validate_quran_records([quran(text="\U0001f600"), *full_surah()[1:]], [112])
    )
    assert "ayah_out_of_range" in codes(
        validate_quran_records([*full_surah(), quran(112, 5)], [112])
    )
    assert "duplicate_ayah" in codes(validate_quran_records([*full_surah(), quran(112, 2)], [112]))
    incomplete = validate_quran_records(full_surah()[:3], [112])
    assert codes(incomplete) == {"incomplete_surah"}
    assert validate_quran_records(full_surah()[:3], [112], require_full_surah=False).ok


def test_quran_validation_reports_nfc_as_information_only() -> None:
    decomposed = quran(text="آ")  # not NFC
    report = validate_quran_records([decomposed, *full_surah()[1:]], [112])
    assert report.ok and report.info["not_nfc"] == 1


def test_issue_summary_has_codes_and_refs_only() -> None:
    report = validate_quran_records([quran(text="")], [112])
    text = report.summary()
    assert "empty_text@112:1" in text


def test_missing_surahs() -> None:
    assert missing_surahs([112], [112, 113, 114]) == [113, 114]
    assert missing_surahs([], []) == []


def test_valid_hadith_records_pass_and_info_counts() -> None:
    report = validate_hadith_records(
        [hadith(1, 990001), hadith(2, 990002, grade="", narrator="")], [1, 2, 3]
    )
    assert report.ok
    assert report.info["grade_missing"] == 1 and report.info["narrator_missing"] == 1


def test_hadith_validation_issues() -> None:
    assert "outside_scope" in codes(validate_hadith_records([hadith(5, 990005)], [1, 2]))
    assert codes(
        validate_hadith_records(
            [hadith(1, 990001, url="https://hadeethenc.com/ar/browse/hadith/1")], [1]
        )
    ) == {"url_shape"}
    assert "duplicate_forty_number" in codes(
        validate_hadith_records([hadith(1, 990001), hadith(1, 990002)], [1])
    )
    assert "duplicate_hadeethenc_id" in codes(
        validate_hadith_records(
            [hadith(1, 990001), hadith(2, 990001, url=hadith_url(990001))], [1, 2]
        )
    )
    assert "empty_text" in codes(validate_hadith_records([hadith(1, narration=" ")], [1]))
    assert "non_bmp_character" in codes(
        validate_hadith_records([hadith(1, grade="\U0001f600")], [1])
    )


def test_hadith_gaps_reasons() -> None:
    gaps = hadith_gaps({1, 2}, {1, 3}, [1, 2, 3, 4])
    assert [(g.forty_number, g.reason) for g in gaps] == [
        (2, "missing_in_pass_2"),
        (3, "missing_in_pass_1"),
        (4, "no_record"),
    ]
    assert hadith_gaps({1}, {1}, [1]) == []
