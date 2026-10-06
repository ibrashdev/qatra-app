"""Record-level validation (Programming-guide §5 ``workflow/validation.py``, B7 part).

Checks raw records before anything is stored: required fields (types are enforced by the
strict models), canonical URL shape, scope, completeness of a surah, text hygiene. Issues carry
a stable ``code`` and an id-only ``ref`` (never source text). Edition-level and bank-level
validation (``validate_edition``, ``validate_bank``) belongs to B8.

NFC is not an error here: raw records are kept unmodified and converted to NFC when units are
built (contract §2.7); the number of records that are not yet NFC is reported as information.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.domain.normalization import has_latin_letter, tokenize
from app.workflow.bundle import BUNDLE_VERSION, TOP_LEVEL_KEYS, content_hash
from app.workflow.bundle_index import BundleIndex, Word, parse_ref, window_key
from app.workflow.editions import (
    EDITIONS,
    MCP_SOURCE_URL,
    QURAN_AYAH_COUNTS,
    EditionScope,
    edition_spec,
    hadith_url,
    hadith_url_id,
    quran_url,
)
from app.workflow.ids import stable_id
from app.workflow.lesson_question_builder import QURAN_RECALL_EXCLUDED
from app.workflow.models import HadithRecord, QuranRecord, RawObject, sha256_hex
from app.workflow.passages import Tok
from app.workflow.results import Gap
from app.workflow.segmentation import nfc


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


# Markers of the Islamic Content MCP envelope. None of them is source text: when one reaches a
# stored record or a unit, the publisher's framing was kept with the text (a defect, never data).
_ENVELOPE_MARKERS = (
    "[EXACT]",
    "[/EXACT]",
    "[ATTRIBUTION]",
    "[/ATTRIBUTION]",
    "[COMMENTARY]",
    "[/COMMENTARY]",
    "RETRIEVED",
)


def non_arabic_source_text(text: str) -> bool:
    """True when ``text`` (an ayah, narration, takhrij or grade) has a Latin letter, an MCP
    envelope marker or a box-drawing character. The sources are Arabic only, so any of these
    means the publisher's framing or a foreign string was stored with the source text."""
    return (
        has_latin_letter(text)
        or any(marker in text for marker in _ENVELOPE_MARKERS)
        or any(0x2500 <= ord(ch) <= 0x257F for ch in text)
    )


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
        texts = (record.narration, record.narrator, record.grade)
        if any(non_arabic_source_text(value) for value in texts):
            report.add(
                "non_arabic_source_text",
                ref,
                "the narration, narrator or grade has Latin letters or envelope markers",
            )
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


# =============================================================================================
# Edition and bank validation (B8): work on the bundle as plain data and trust nothing about how
# it was built. Fail closed: any issue means the step does not pass. Issues carry codes and ids.
# =============================================================================================

_BUNDLE_QUESTION_KEYS = (
    "id",
    "type",
    "variant",
    "passageId",
    "coveredPartIds",
    "tokenRefs",
    "optionRefs",
    "correctRef",
    "contextRefs",
    "reference",
)
_VARIANTS = {
    "word_order": {None},
    "word_choice": {"word", "segment"},
    "word_recall": {"keyword", "continuation"},
    "similar_distinction": {None},
}
_MAX_PART_WORDS = 8
_HADITH_META_KEYS = {
    "fortyNumber",
    "hadeethencId",
    "citesSahihayn",
    "gradeRecorded",
    "showD50Notice",
}


def originals_from_objects(
    objects: Sequence[RawObject], edition_key: str
) -> dict[tuple[str, str], str]:
    """The NFC text of every unit the raw objects can produce, keyed by ``(kind, reference)``.
    Hadith are read from pass 1 (verification proved pass 2 equal after NFC)."""
    originals: dict[tuple[str, str], str] = {}
    spec = edition_spec(edition_key)
    for obj in objects:
        if spec.kind == "quran":
            for record in obj.quran_records():
                originals[("ayah", f"{record.surah}:{record.ayah}")] = nfc(record.text)
        elif obj.pass_number == 1:
            for hadith in obj.hadith_records():
                reference = f"nawawi40:{hadith.forty_number}"
                originals[("hadith_narration", reference)] = nfc(hadith.narration)
                if hadith.narrator.strip():
                    originals[("hadith_takhrij", reference)] = nfc(hadith.narrator)
                if hadith.grade.strip():
                    originals[("hadith_grade", reference)] = nfc(hadith.grade)
    return originals


def _section_url_ok(spec_kind: str, section: Mapping[str, Any]) -> bool:
    url = section["sourceUrl"]
    if spec_kind == "quran":
        return url == quran_url(int(section["reference"]))
    return hadith_url_id(url) is not None


def validate_edition(
    bundle: Mapping[str, Any],
    *,
    originals: Mapping[tuple[str, str], str] | None = None,
    scope: EditionScope | None = None,
) -> ValidationReport:
    """Exact original and references, rights and eligibility, structure (API-spec ``validate``).

    ``originals`` is the NFC text of each unit recomputed from the raw objects: every unit must
    equal it. ``scope`` is the build scope recorded by ``acquire``.
    """
    report = ValidationReport()
    if tuple(bundle) != TOP_LEVEL_KEYS or bundle.get("bundleVersion") != BUNDLE_VERSION:
        report.add("bundle_shape", "bundle", "not a bundle v1 (top-level keys or version)")
        return report
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    if key not in EDITIONS:
        report.add("edition_key", "bundle", "unknown edition key")
        return report
    spec = EDITIONS[key]
    source, edition, book = bundle["source"], bundle["edition"], bundle["book"]

    # rights and eligibility
    if source["rightsStatus"] not in ("owner_accepted_pending_verification", "verified"):
        report.add("rights_status", "source", "rights status does not allow use")
    if source["verification"]["result"] != "passed":
        report.add("verification_not_passed", "source", "verbatim verification did not pass")
    if source["sourceUrl"] != MCP_SOURCE_URL or source["toolName"] != spec.tool_name:
        report.add("source_provenance", "source", "source URL or tool does not match the edition")
    if not re.fullmatch(r"[0-9a-f]{64}", str(source["rawSha256"])):
        report.add("raw_hash", "source", "rawSha256 is not a SHA-256")
    expected_format = "quran" if spec.kind == "quran" else "hadith_collection"
    if book["contentFormat"] != expected_format:
        report.add("content_format", "book", "content format does not match the edition")
    for name, entity, row in (
        ("source", "source", source),
        ("book", "book", book),
        ("edition", "edition", edition),
    ):
        if row["id"] != stable_id(key, bank, entity, entity):
            report.add("id_mismatch", name, "id is not the stable id")
    if edition["language"] != "ar" or edition["version"] != 1:
        report.add("edition_record", "edition", "language or version is not as expected")
    if edition["paginationRecord"] != {"kind": "web_edition"} or bundle["pages"] != []:
        report.add("pagination", "edition", "a web edition has no printed pages (D68)")

    # sections
    sections = {s["ordinal"]: s for s in bundle["sections"]}
    if sorted(sections) != list(range(1, len(bundle["sections"]) + 1)):
        report.add("section_order", "sections", "section ordinals are not 1..n")
    seen_references: set[str] = set()
    for section in bundle["sections"]:
        ref = f"section:{section['ordinal']}"
        if section["id"] != stable_id(key, bank, "section", section["ordinal"]):
            report.add("id_mismatch", ref, "section id is not the stable id")
        if section["kind"] != ("surah" if spec.kind == "quran" else "hadith"):
            report.add("section_kind", ref, "section kind does not match the edition")
        if section["reference"] in seen_references:
            report.add("duplicate_reference", ref, "section reference repeats")
        seen_references.add(section["reference"])
        if not _section_url_ok(spec.kind, section):
            report.add("url_shape", ref, "section URL is not canonical")
        if not str(section["titleAr"]).strip() or not str(section["titleEn"]).strip():
            report.add("section_title", ref, "section title is empty")
    if scope is not None:
        _check_scope(report, spec.kind, bundle, scope)

    # units
    units = bundle["units"]
    if [u["ordinal"] for u in units] != list(range(1, len(units) + 1)):
        report.add("unit_order", "units", "unit ordinals are not 1..n")
    kinds = (
        {"ayah"} if spec.kind == "quran" else {"hadith_narration", "hadith_takhrij", "hadith_grade"}
    )
    grade_sections = {u["sectionOrdinal"] for u in units if u["kind"] == "hadith_grade"}
    for unit in units:
        ref = f"unit:{unit['ordinal']}"
        text = unit["canonicalText"]
        section = sections.get(unit["sectionOrdinal"])
        if section is None:
            report.add("unit_section", ref, "unit refers to a missing section")
            continue
        if unit["id"] != stable_id(key, bank, "unit", unit["ordinal"]):
            report.add("id_mismatch", ref, "unit id is not the stable id")
        if unit["kind"] not in kinds:
            report.add("unit_kind", ref, "unit kind does not match the edition")
        if unit["sourceUrl"] != section["sourceUrl"]:
            report.add("url_shape", ref, "unit URL differs from its section URL")
        if not text.strip() or text != text.strip(" \t\r\n"):
            report.add("text_hygiene", ref, "text is empty or has leading/trailing whitespace")
        if not unicodedata.is_normalized("NFC", text):
            report.add("text_not_nfc", ref, "canonical text is not NFC")
        if any(ord(ch) > 0xFFFF for ch in text):
            report.add("non_bmp_character", ref, "token offsets assume BMP-only text")
        if non_arabic_source_text(text):
            report.add(
                "non_arabic_source_text",
                ref,
                "unit text has Latin letters or envelope markers",
            )
        if unit["textHash"] != sha256_hex(text.encode("utf-8")):
            report.add("text_hash", ref, "textHash does not match the text")
        elif unicodedata.is_normalized("NFC", text):
            if [dict(t) for t in unit["tokens"]] != [t.to_dict() for t in tokenize(text)]:
                report.add("token_mismatch", ref, "tokens differ from the tokenization of the text")
        if spec.kind == "quran":
            if (
                "hadithMeta" in unit
                or unit["reference"] != f"{section['reference']}:{ref_ayah(unit)}"
            ):
                report.add("unit_reference", ref, "ayah reference or hadithMeta is wrong")
        else:
            _check_hadith_meta(report, ref, unit, section, grade_sections)
        if originals is not None:
            expected = originals.get((unit["kind"], unit["reference"]))
            if expected is None:
                report.add("original_missing", ref, "no raw record produces this unit")
            elif expected != text:
                report.add("original_mismatch", ref, "text differs from the verified raw record")
    if originals is not None:
        present = {(u["kind"], u["reference"]) for u in units}
        expected_keys = {k for k in originals if k[0] == "ayah"} if spec.kind == "quran" else set()
        for missing in sorted(expected_keys - present):
            report.add("unit_missing", f"{missing[1]}", "a raw ayah has no unit")
    if edition["contentHash"] != content_hash(units):
        report.add("content_hash", "edition", "contentHash does not match the units")

    _check_passages(report, spec.kind, bundle, sections)
    report.info.update(sections=len(sections), units=len(units), passages=len(bundle["passages"]))
    return report


def ref_ayah(unit: Mapping[str, Any]) -> str:
    return str(unit["reference"]).rpartition(":")[2]


def _check_scope(
    report: ValidationReport, kind: str, bundle: Mapping[str, Any], scope: EditionScope
) -> None:
    if kind == "quran":
        if [int(s["reference"]) for s in bundle["sections"]] != list(scope.surahs):
            report.add("scope_mismatch", "sections", "surahs differ from the build scope")
            return
        per_section: Counter[int] = Counter(u["sectionOrdinal"] for u in bundle["units"])
        for section in bundle["sections"]:
            if per_section[section["ordinal"]] != QURAN_AYAH_COUNTS[int(section["reference"])]:
                report.add(
                    "ayat_count",
                    f"surah:{section['reference']}",
                    "ayah count differs from the surah",
                )
    else:
        numbers = [int(str(s["reference"]).rpartition(":")[2]) for s in bundle["sections"]]
        if numbers != sorted(numbers) or not set(numbers) <= set(scope.forty_numbers):
            report.add("scope_mismatch", "sections", "hadith numbers are outside the build scope")


def _check_hadith_meta(
    report: ValidationReport,
    ref: str,
    unit: Mapping[str, Any],
    section: Mapping[str, Any],
    grade_sections: set[int],
) -> None:
    meta = unit.get("hadithMeta")
    if not isinstance(meta, dict) or set(meta) != _HADITH_META_KEYS:
        report.add("hadith_meta", ref, "hadithMeta must be an object with the five keys")
        return
    if (
        unit["reference"] != section["reference"]
        or f"nawawi40:{meta['fortyNumber']}" != unit["reference"]
    ):
        report.add("unit_reference", ref, "hadith reference differs from its section")
    if meta["gradeRecorded"] != (section["ordinal"] in grade_sections):
        report.add("hadith_meta", ref, "gradeRecorded does not match the presence of a grade unit")
    if meta["showD50Notice"] != (not meta["citesSahihayn"] and not meta["gradeRecorded"]):
        report.add("hadith_meta", ref, "showD50Notice does not follow D53")


def _check_passages(
    report: ValidationReport,
    kind: str,
    bundle: Mapping[str, Any],
    sections: Mapping[int, Mapping[str, Any]],
) -> None:
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    index = BundleIndex(bundle)
    allowed = {"quran"} if kind == "quran" else {"matn", "sanad", "grade"}
    by_path: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    covered_units: dict[str, set[int]] = defaultdict(set)
    part_ids: set[str] = set()
    for passage in bundle["passages"]:
        ref = f"passage:{passage['path']}:{passage['ordinal']}"
        by_path[passage["path"]].append(passage)
        if passage["path"] not in allowed:
            report.add("passage_path", ref, "path does not belong to this edition")
            continue
        if passage["id"] != stable_id(
            key, bank, "passage", f"{passage['path']}:{passage['ordinal']}"
        ):
            report.add("id_mismatch", ref, "passage id is not the stable id")
        if passage["sectionOrdinal"] not in sections:
            report.add("passage_section", ref, "passage refers to a missing section")
        tokens = index.range_tokens(passage["startRef"], passage["endRef"])
        if tokens is None:
            report.add("passage_ref", ref, "start/end reference does not resolve")
            continue
        units_in = {t.ref[0] for t in tokens}
        if {index.units[u]["sectionOrdinal"] for u in units_in} != {passage["sectionOrdinal"]}:
            report.add("passage_section", ref, "passage range leaves its section")
        if passage["path"] != "quran" and len(units_in) != 1:
            report.add("passage_unit", ref, "a hadith passage lies inside one unit")
        covered_units[passage["path"]] |= units_in
        words = sum(1 for t in tokens if t.kind == "word")
        if passage["wordCount"] != words or words < 1:
            report.add("passage_words", ref, "wordCount differs from the number of word tokens")
        _check_parts(report, ref, passage, tokens, index, key, bank, part_ids)
    for path, items in by_path.items():
        if [p["ordinal"] for p in items] != list(range(1, len(items) + 1)):
            report.add("passage_order", f"path:{path}", "passage ordinals are not 1..n")
        ranges = sorted(
            (parse_ref(p["startRef"]), parse_ref(p["endRef"]))
            for p in items
            if parse_ref(p["startRef"])
        )
        for (_a, a_end), (b_start, _b) in zip(ranges, ranges[1:], strict=False):
            if a_end is not None and b_start is not None and a_end >= b_start:
                report.add("passage_overlap", f"path:{path}", "passages of one path overlap")
    if kind == "quran":
        ayah_units = {u["ordinal"] for u in bundle["units"] if u["kind"] == "ayah"}
        if ayah_units - covered_units["quran"]:
            report.add("unit_uncovered", "passages", "an ayah belongs to no passage")
    else:
        matn_sections = {p["sectionOrdinal"] for p in by_path["matn"]}
        for ordinal in sections:
            if ordinal not in matn_sections:
                report.add("matn_missing", f"section:{ordinal}", "a hadith has no matn passage")


def _check_parts(
    report: ValidationReport,
    ref: str,
    passage: Mapping[str, Any],
    tokens: Sequence[Tok],
    index: BundleIndex,
    key: str,
    bank: int,
    part_ids: set[str],
) -> None:
    parts = passage["parts"]
    if [p["ordinal"] for p in parts] != list(range(1, len(parts) + 1)) or not parts:
        report.add("part_order", ref, "part ordinals are not 1..m")
        return
    position = {t.ref: i for i, t in enumerate(tokens)}
    expected_start = 0
    for part in parts:
        pref = f"{ref}:part:{part['ordinal']}"
        if part["id"] in part_ids:
            report.add("duplicate_id", pref, "part id repeats")
        part_ids.add(part["id"])
        if part["id"] != stable_id(
            key, bank, "part", f"{passage['path']}:{passage['ordinal']}:{part['ordinal']}"
        ):
            report.add("id_mismatch", pref, "part id is not the stable id")
        first, last = parse_ref(part["startRef"]), parse_ref(part["endRef"])
        if first not in position or last not in position or position[first] != expected_start:
            report.add("parts_tiling", pref, "parts do not tile the passage")
            return
        chunk = tokens[position[first] : position[last] + 1]
        words = sum(1 for t in chunk if t.kind == "word")
        if part["wordCount"] != words or words < 1:
            report.add("part_words", pref, "wordCount differs from the number of word tokens")
        if words > _MAX_PART_WORDS:
            report.add("part_too_large", pref, "a part has more than 8 words")
        expected_start = position[last] + 1
    if expected_start != len(tokens):
        report.add("parts_tiling", ref, "parts do not reach the end of the passage")


def validate_bank(bundle: Mapping[str, Any]) -> ValidationReport:
    """Lessons and questions: references inside the edition, exactly one correct answer after
    normalization, no ambiguous item, coverage of every part (API-spec ``validate``)."""
    report = ValidationReport()
    if tuple(bundle) != TOP_LEVEL_KEYS:
        report.add("bundle_shape", "bundle", "not a bundle v1")
        return report
    index = BundleIndex(bundle)
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    passages = {p["id"]: i for i, p in enumerate(index.passages)}
    _check_lessons(report, bundle, key, bank, passages)

    words_by_passage = list(index.all_passage_words())
    word_of: dict[str, Word] = {w.ref: w for words in words_by_passage for w in words}
    single_targets: dict[tuple[tuple[str, ...], tuple[str, ...]], set[str]] = defaultdict(set)
    for words in words_by_passage:
        for word in words:
            single_targets[window_key(words, word.pos)].add(word.n)
    segment_targets: dict[int, dict[Any, set[tuple[str, ...]]]] = {}
    is_quran = any(u["kind"] == "ayah" for u in bundle["units"])

    def segments_for(length: int) -> dict[Any, set[tuple[str, ...]]]:
        if length not in segment_targets:
            table: dict[Any, set[tuple[str, ...]]] = defaultdict(set)
            for words in words_by_passage:
                for start in range(len(words) - length + 1):
                    table[window_key(words, start, length)].add(
                        tuple(w.n for w in words[start : start + length])
                    )
            segment_targets[length] = table
        return segment_targets[length]

    covered: set[str] = set()
    seen_ids: set[str] = set()
    type_counts: Counter[str] = Counter()
    for number, question in enumerate(bundle["questions"], start=1):
        qref = f"question:{number}"
        if tuple(question) != _BUNDLE_QUESTION_KEYS:
            report.add("question_shape", qref, "question keys are not the bundle v1 keys")
            continue
        if question["id"] in seen_ids:
            report.add("duplicate_id", qref, "question id repeats")
        seen_ids.add(question["id"])
        qtype = question["type"]
        type_counts[qtype] += 1
        if qtype not in _VARIANTS or question["variant"] not in _VARIANTS[qtype]:
            report.add("question_type", qref, "type or variant is not allowed")
            continue
        if (question["optionRefs"] is not None) != (
            qtype in ("word_choice", "similar_distinction")
        ):
            report.add("option_presence", qref, "optionRefs is present exactly for choice types")
            continue
        if not str(question["reference"]).strip():
            report.add("reference", qref, "empty reference")
        p_index = passages.get(question["passageId"])
        if p_index is None:
            report.add("passage_ref", qref, "question refers to a missing passage")
            continue
        passage = index.passages[p_index]
        passage_part_ids = {part["id"] for part in passage["parts"]}
        part_list = question["coveredPartIds"]
        if (
            not part_list
            or len(set(part_list)) != len(part_list)
            or not set(part_list) <= passage_part_ids
        ):
            report.add("covered_parts", qref, "coveredPartIds must be parts of the passage")
            continue
        covered.update(part_list)
        refs_ok = _check_refs(report, qref, question, index, word_of, p_index)
        if not refs_ok:
            continue
        part_indexes = {index.part_by_id[pid] for pid in part_list}
        token_words = [word_of[r] for r in question["tokenRefs"]]
        _check_covered_claim(report, qref, question, token_words, part_indexes, qtype)
        words = words_by_passage[p_index]
        if qtype == "word_order":
            _check_order(report, qref, question, index, part_indexes, word_of)
        elif qtype == "word_recall":
            _check_recall(report, qref, question, token_words, words, single_targets, is_quran)
        elif qtype == "word_choice":
            _check_choice(
                report,
                qref,
                question,
                token_words,
                words,
                word_of,
                passage,
                single_targets,
                segments_for,
            )
        else:
            _check_similar(report, qref, question, token_words, word_of)
    for part_index, part in enumerate(index.parts):
        if part["id"] not in covered:
            passage = index.passages[index.part_passage[part_index]]
            report.add(
                "part_uncovered",
                f"{passage['path']}:{passage['ordinal']}:{part['ordinal']}",
                "no question covers this part",
            )
    report.info.update(
        lessons=len(bundle["lessons"]),
        questions=len(bundle["questions"]),
        parts=len(index.parts),
        parts_covered=len(covered & {p["id"] for p in index.parts}),
        **{f"type_{k}": v for k, v in sorted(type_counts.items())},
    )
    return report


def _check_lessons(
    report: ValidationReport,
    bundle: Mapping[str, Any],
    key: str,
    bank: int,
    passages: Mapping[str, int],
) -> None:
    lessons = bundle["lessons"]
    if [x["ordinal"] for x in lessons] != list(range(1, len(lessons) + 1)):
        report.add("lesson_order", "lessons", "lesson ordinals are not 1..n")
    seen: Counter[str] = Counter(x["passageId"] for x in lessons)
    for lesson in lessons:
        ref = f"lesson:{lesson['ordinal']}"
        if lesson["passageId"] not in passages:
            report.add("lesson_passage", ref, "lesson refers to a missing passage")
        if lesson["id"] != stable_id(key, bank, "lesson", lesson["ordinal"]):
            report.add("id_mismatch", ref, "lesson id is not the stable id")
        duration = lesson["durationEstimateSec"]
        if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
            report.add("lesson_duration", ref, "durationEstimateSec must be a positive integer")
    for passage_id in passages:
        if seen[passage_id] != 1:
            report.add("lesson_per_passage", passage_id, "a passage needs exactly one lesson")


def _check_refs(
    report: ValidationReport,
    qref: str,
    question: Mapping[str, Any],
    index: BundleIndex,
    word_of: Mapping[str, Word],
    p_index: int,
) -> bool:
    ok = True
    groups: list[tuple[str, Sequence[str]]] = [
        ("token", question["tokenRefs"]),
        ("correct", question["correctRef"]),
    ]
    groups += [("option", option) for option in question["optionRefs"] or []]
    for label, refs in groups:
        if not refs or not isinstance(refs, list):
            report.add("empty_refs", qref, f"{label} references are empty")
            ok = False
            continue
        for ref in refs:
            if index.token(ref) is None:
                report.add("unresolved_ref", qref, f"a {label} reference is not in the edition")
                ok = False
            elif ref not in word_of:
                report.add("not_a_word", qref, f"a {label} reference is not a word of a passage")
                ok = False
    passage_tokens = {f"{t.ref[0]}:{t.ref[1]}" for t in index.passage_tokens(p_index)}
    for ref in question["contextRefs"]:
        if index.token(ref) is None:
            report.add("unresolved_ref", qref, "a context reference is not in the edition")
            ok = False
        elif ref not in passage_tokens or ref in question["tokenRefs"]:
            report.add("context_ref", qref, "context must lie in the passage and exclude the blank")
            ok = False
    if ok and any(
        r not in passage_tokens for r in [*question["tokenRefs"], *question["correctRef"]]
    ):
        report.add("outside_passage", qref, "tested tokens must lie in the passage")
        ok = False
    return ok


def _check_covered_claim(
    report: ValidationReport,
    qref: str,
    question: Mapping[str, Any],
    token_words: Sequence[Word],
    part_indexes: set[int],
    qtype: str,
) -> None:
    """Every covered part must contain tested words, and every tested word must lie in a
    covered part (context alone is never coverage)."""
    if qtype == "similar_distinction":
        tested = {w.part for w in token_words}
    else:
        tested = {w.part for w in token_words}
    if tested != part_indexes:
        report.add(
            "coverage_claim", qref, "coveredPartIds differ from the parts of the tested words"
        )


def _check_order(
    report: ValidationReport,
    qref: str,
    question: Mapping[str, Any],
    index: BundleIndex,
    part_indexes: set[int],
    word_of: Mapping[str, Word],
) -> None:
    if question["tokenRefs"] != question["correctRef"] or len(set(question["tokenRefs"])) != len(
        question["tokenRefs"]
    ):
        report.add("order_answer", qref, "the answer must be the tested words in original order")
        return
    if len(question["tokenRefs"]) < 3:
        report.add("order_size", qref, "fewer than 3 words cannot be ordered")
    expected = sorted(
        (w for w in word_of.values() if w.part in part_indexes), key=lambda w: (w.unit, w.index)
    )
    if [w.ref for w in expected] != question["tokenRefs"]:
        report.add("order_words", qref, "the words are not exactly the covered parts' words")


def _check_recall(
    report: ValidationReport,
    qref: str,
    question: Mapping[str, Any],
    token_words: Sequence[Word],
    words: Sequence[Word],
    single_targets: Mapping[Any, set[str]],
    is_quran: bool,
) -> None:
    if len(token_words) != 1 or question["correctRef"] != question["tokenRefs"]:
        report.add("recall_answer", qref, "a recall question has one word as answer")
        return
    word = token_words[0]
    if not word.n:
        report.add("recall_answer", qref, "the answer has no normalized form")
    if is_quran and any(ch in word.surface for ch in QURAN_RECALL_EXCLUDED):
        report.add("recall_excluded", qref, "Quran recall excludes spellings with these marks")
    if len(single_targets[window_key(words, word.pos)]) != 1:
        report.add("ambiguous_item", qref, "the shown context fits another answer in the edition")
    if question["variant"] == "continuation" and len(question["coveredPartIds"]) == 1:
        first_word_of_part = min((w for w in words if w.part == word.part), key=lambda w: w.pos)
        if first_word_of_part.ref != word.ref:
            report.add("recall_variant", qref, "a continuation blank is the first word of a part")


def _norm_tuple(words: Sequence[Word]) -> tuple[str, ...]:
    return tuple(w.n for w in words)


def _check_choice(
    report: ValidationReport,
    qref: str,
    question: Mapping[str, Any],
    token_words: Sequence[Word],
    words: Sequence[Word],
    word_of: Mapping[str, Word],
    passage: Mapping[str, Any],
    single_targets: Mapping[Any, set[str]],
    segments_for: Any,
) -> None:
    options = question["optionRefs"]
    correct = question["correctRef"]
    if question["tokenRefs"] != correct:
        report.add("choice_answer", qref, "tokenRefs must equal correctRef")
        return
    if len(options) < 2:
        report.add("option_count", qref, "a choice needs at least two options")
        return
    if correct not in options or options.count(correct) != 1:
        report.add("correct_answer", qref, "the correct answer must be exactly one option")
        return
    normalized = [_norm_tuple([word_of[r] for r in option]) for option in options]
    if len(set(normalized)) != len(normalized):
        report.add("ambiguous_options", qref, "two options are the same after normalization")
    own = normalized[options.index(correct)]
    if sum(1 for n in normalized if n == own) != 1:
        report.add(
            "correct_answer", qref, "more than one option equals the answer after normalization"
        )
    grade = passage["path"] == "grade"
    variant = question["variant"]
    if variant == "word" and any(len(option) != 1 for option in options):
        report.add("option_shape", qref, "word options are single words")
    if variant == "segment" and not grade:
        lengths = {len(option) for option in options}
        if len(lengths) != 1 or not 2 <= next(iter(lengths)) <= 4:
            report.add("option_shape", qref, "segment options have the same length of 2-4 words")
        positions = [word_of[r].pos for r in correct]
        if positions != list(range(positions[0], positions[0] + len(positions))):
            report.add("segment_contiguity", qref, "the segment is not contiguous words")
        elif len(segments_for(len(correct))[window_key(words, positions[0], len(correct))]) != 1:
            report.add("ambiguous_item", qref, "the shown context fits another segment")
    if variant == "word" and not grade:
        if len(single_targets[window_key(words, token_words[0].pos)]) != 1:
            report.add(
                "ambiguous_item", qref, "the shown context fits another answer in the edition"
            )
    if grade and any(word_of[r].passage != word_of[correct[0]].passage for r in correct):
        report.add("option_shape", qref, "the grade answer lies in one passage")


def _check_similar(
    report: ValidationReport,
    qref: str,
    question: Mapping[str, Any],
    token_words: Sequence[Word],
    word_of: Mapping[str, Word],
) -> None:
    options = question["optionRefs"]
    if (
        len(token_words) != 1
        or question["correctRef"] != question["tokenRefs"]
        or len(options) != 2
    ):
        report.add("similar_shape", qref, "a similar-position item has one word and two options")
        return
    if options.count(question["correctRef"]) != 1 or any(len(o) != 1 for o in options):
        report.add("correct_answer", qref, "the correct answer must be exactly one option")
        return
    other = word_of[next(o for o in options if o != question["correctRef"])[0]]
    mine = token_words[0]
    if other.part == mine.part:
        report.add("similar_position", qref, "the similar word must come from another part")
    if not _alt_differs_words(mine, other):
        report.add("similar_position", qref, "the two words are the same after normalization")


def _alt_differs_words(a: Word, b: Word) -> bool:
    if a.n == b.n:
        return False
    if a.a is not None and (a.a == b.n or a.a == b.a):
        return False
    return not (b.a is not None and b.a == a.n)
