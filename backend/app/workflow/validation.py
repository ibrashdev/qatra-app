"""Record-level validation (Programming-guide §5 ``workflow/validation.py``, B7 part).

Checks raw records before anything is stored: required fields (types are enforced by the
strict models), canonical URL shape, scope, completeness of a surah, text hygiene. Issues carry
a stable ``code`` and an id-only ``ref`` (never source text). Edition-level and bank-level
validation (``validate_edition``, ``validate_bank``) belongs to B8.

NFC is not an error here: raw records are kept unmodified and converted to NFC when units are
built (contract §2.7); the number of records that are not yet NFC is reported as information.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field

from app.workflow.editions import QURAN_AYAH_COUNTS, hadith_url, quran_url
from app.workflow.models import HadithRecord, QuranRecord
from app.workflow.results import Gap


@dataclass(frozen=True, slots=True)
class Issue:
    code: str
    ref: str
    message: str


@dataclass(slots=True)
class ValidationReport:
    issues: list[Issue] = field(default_factory=list)
    info: dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.issues

    def add(self, code: str, ref: str, message: str) -> None:
        self.issues.append(Issue(code, ref, message))

    def summary(self, limit: int = 10) -> str:
        """Codes and refs only, for an error message."""
        shown = [f"{issue.code}@{issue.ref}" for issue in self.issues[:limit]]
        more = f" (+{len(self.issues) - limit} more)" if len(self.issues) > limit else ""
        return ", ".join(shown) + more


def _has_astral(text: str) -> bool:
    return any(ord(ch) > 0xFFFF for ch in text)


def validate_quran_records(
    records: Sequence[QuranRecord],
    scope_surahs: Collection[int],
    *,
    require_full_surah: bool = True,
) -> ValidationReport:
    """Validate Quran records against the build scope.

    One MCP call returns a whole surah, so a surah present in ``records`` must have all its
    ayat (``require_full_surah``). Surahs of the scope that are absent are not an issue here:
    see ``missing_surahs``.
    """
    report = ValidationReport()
    per_surah: dict[int, list[int]] = {}
    not_nfc = 0
    for record in records:
        ref = f"{record.surah}:{record.ayah}"
        if record.surah not in scope_surahs:
            report.add("outside_scope", ref, "the surah is not in the build scope")
            continue
        if record.url != quran_url(record.surah):
            report.add("url_shape", ref, "the URL is not the canonical QuranEnc surah URL")
        if not record.text.strip():
            report.add("empty_text", ref, "the verse text is empty")
        if "\n" in record.text or "\r" in record.text:
            report.add("newline_in_text", ref, "a verse is a single line")
        if _has_astral(record.text):
            report.add("non_bmp_character", ref, "token offsets assume BMP-only text")
        if record.ayah > QURAN_AYAH_COUNTS[record.surah]:
            report.add("ayah_out_of_range", ref, "the ayah number exceeds the surah's ayat count")
        if not unicodedata.is_normalized("NFC", record.text):
            not_nfc += 1
        per_surah.setdefault(record.surah, []).append(record.ayah)
    for surah, ayat in sorted(per_surah.items()):
        for ayah, count in Counter(ayat).items():
            if count > 1:
                report.add("duplicate_ayah", f"{surah}:{ayah}", "the ayah appears more than once")
        if require_full_surah:
            missing = sorted(set(range(1, QURAN_AYAH_COUNTS[surah] + 1)) - set(ayat))
            if missing:
                report.add(
                    "incomplete_surah",
                    str(surah),
                    f"{len(missing)} ayat are missing from the surah",
                )
    report.info.update(records=len(records), surahs=len(per_surah), not_nfc=not_nfc)
    return report


def missing_surahs(present: Iterable[int], scope_surahs: Iterable[int]) -> list[int]:
    return sorted(set(scope_surahs) - set(present))


def validate_hadith_records(
    records: Sequence[HadithRecord], scope_numbers: Collection[int]
) -> ValidationReport:
    """Validate the records of one hadith pass against the build scope."""
    report = ValidationReport()
    numbers = Counter(r.forty_number for r in records)
    ids = Counter(r.hadeethenc_id for r in records)
    not_nfc = grade_missing = narrator_missing = 0
    for record in records:
        ref = f"forty:{record.forty_number}"
        if record.forty_number not in scope_numbers:
            report.add("outside_scope", ref, "the hadith number is not in the build scope")
            continue
        if numbers[record.forty_number] > 1:
            report.add("duplicate_forty_number", ref, "the hadith number appears more than once")
        if ids[record.hadeethenc_id] > 1:
            report.add("duplicate_hadeethenc_id", ref, "the HadeethEnc id appears more than once")
        if record.url != hadith_url(record.hadeethenc_id):
            report.add(
                "url_shape",
                ref,
                "the URL must be the canonical HadeethEnc hadith URL of the record's id",
            )
        if not record.narration.strip():
            report.add("empty_text", ref, "the narration is empty")
        for value in (record.narration, record.narrator, record.grade):
            if _has_astral(value):
                report.add("non_bmp_character", ref, "token offsets assume BMP-only text")
                break
        if not record.grade.strip():
            grade_missing += 1
        if not record.narrator.strip():
            narrator_missing += 1
        if not all(
            unicodedata.is_normalized("NFC", v)
            for v in (record.narration, record.narrator, record.grade)
        ):
            not_nfc += 1
    report.info.update(
        records=len(records),
        grade_missing=grade_missing,
        narrator_missing=narrator_missing,
        not_nfc=not_nfc,
    )
    return report


def hadith_gaps(
    pass1: Collection[int], pass2: Collection[int], scope_numbers: Iterable[int]
) -> list[Gap]:
    """Forty numbers that cannot be verified: no record in the Forty's wording (both passes
    empty) or a record in one pass only. They are documented and left out, never filled."""
    gaps: list[Gap] = []
    for number in scope_numbers:
        in1, in2 = number in pass1, number in pass2
        if in1 and in2:
            continue
        reason = (
            "no_record"
            if not in1 and not in2
            else "missing_in_pass_2"
            if in1
            else "missing_in_pass_1"
        )
        gaps.append(Gap(number, reason))
    return gaps
