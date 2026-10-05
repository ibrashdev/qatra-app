"""Segmentation (API-spec §5.3 ``segment``, contract §2.2-§2.3, D66): verified records ->
sections, units (NFC text, tokens), passages and parts, as bundle-shaped dictionaries.

Pure and deterministic: no storage, no clock, no randomness. Ids come from ``ids.stable_id``.
Notes about doubtful decisions (matn boundaries, a capped passage count, hard cuts) are
returned as ``suspected`` entries (ids and kinds only, never text) for the edition's review
record.

Units: Quran = one per ayah (ordinal over the edition, ascending surah); hadith = per hadith up
to three units in order: narration, takhrij (HadeethEnc "Narrator"), grade (HadeethEnc "Grade"),
the last two only when the value is not empty. Takhrij is displayed and never a path.
"""

from __future__ import annotations

import json
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.domain.normalization import Token, normalize, tokenize
from app.workflow import passages as pa
from app.workflow.editions import quran_url
from app.workflow.errors import InputError
from app.workflow.ids import stable_id
from app.workflow.labels import EditionLabels
from app.workflow.models import HadithRecord, QuranRecord, safe_validation_summary, sha256_hex
from app.workflow.passages import Tok, ref_str

DEFAULT_BOUNDARIES_PATH: Final = (
    Path(__file__).resolve().parent / "data" / "nawawi40_boundaries.json"
)
_SAHIHAYN_WORDS: Final = frozenset({"البخاري", "بخاري", "مسلم", "الصحيحين"})
PATH_RANK: Final = {"quran": 0, "matn": 1, "sanad": 2, "grade": 3}
# The grade question is a choice among the distinct grade phrases of the edition (contract §2.3),
# so a grade passage can only be tested when the edition holds at least two of them.
MIN_GRADE_PHRASES: Final = 2


@dataclass(slots=True)
class SegmentResult:
    """Bundle fragments produced by segmentation."""

    sections: list[dict[str, Any]] = field(default_factory=list)
    units: list[dict[str, Any]] = field(default_factory=list)
    passages: list[dict[str, Any]] = field(default_factory=list)
    suspected: list[dict[str, Any]] = field(default_factory=list)


# --- boundaries file (token ranges only) ---------------------------------------------------


class _Range(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    start: int = Field(ge=0)
    end: int = Field(ge=0)


class BoundaryEntry(BaseModel):
    """One hadith listed in ``nawawi40_boundaries.json`` (token ranges only, never text)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    forty_number: int = Field(alias="fortyNumber", ge=1, le=42)
    doubt: str = Field(min_length=1)
    reviewed_by: str | None = Field(default=None, alias="reviewedBy")
    matn: _Range | None = None
    sanad: _Range | None = None


class _BoundariesFile(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    format_version: int = Field(alias="formatVersion")
    description: str = ""
    entries: list[BoundaryEntry]


Boundaries = dict[int, BoundaryEntry]


def parse_boundaries(data: Any) -> Boundaries:
    try:
        parsed = _BoundariesFile.model_validate(data)
    except ValidationError as exc:
        raise InputError(
            f"the boundaries file is invalid: {safe_validation_summary(exc)}"
        ) from None
    if parsed.format_version != 1:
        raise InputError("the boundaries file must have formatVersion 1")
    result: Boundaries = {}
    for entry in parsed.entries:
        if entry.forty_number in result:
            raise InputError("the boundaries file lists a hadith twice")
        if entry.reviewed_by and entry.matn is None:
            raise InputError("a reviewed boundaries entry needs a matn token range")
        result[entry.forty_number] = entry
    return result


def load_boundaries(path: Path | None = None) -> Boundaries:
    source = Path(path) if path is not None else DEFAULT_BOUNDARIES_PATH
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise InputError("the boundaries file cannot be read as JSON") from None
    return parse_boundaries(data)


# --- helpers -------------------------------------------------------------------------------


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def cites_sahihayn(takhrij: str) -> bool:
    """True when the edition's takhrij names al-Bukhari, Muslim or the two Sahihs (D53). Only a
    named attribution counts; no other wording is read as one."""
    for word in normalize(takhrij).split():
        bare = word[1:] if len(word) > 1 and word[0] == "و" else word
        if word in _SAHIHAYN_WORDS or bare in _SAHIHAYN_WORDS:
            return True
    return False


def hadith_meta(record: HadithRecord) -> dict[str, Any]:
    cites = cites_sahihayn(record.narrator)
    recorded = bool(record.grade.strip())
    return {
        "fortyNumber": record.forty_number,
        "hadeethencId": record.hadeethenc_id,
        "citesSahihayn": cites,
        "gradeRecorded": recorded,
        "showD50Notice": (not cites) and (not recorded),
    }


def _unit_dict(
    ids: tuple[str, int],
    ordinal: int,
    section_ordinal: int,
    kind: str,
    reference: str,
    source_url: str,
    text: str,
    tokens: Sequence[Token],
    meta: dict[str, Any] | None,
) -> dict[str, Any]:
    edition_key, bank_version = ids
    unit: dict[str, Any] = {
        "id": stable_id(edition_key, bank_version, "unit", ordinal),
        "ordinal": ordinal,
        "sectionOrdinal": section_ordinal,
        "kind": kind,
        "reference": reference,
        "sourceUrl": source_url,
        "canonicalText": text,
        "textHash": sha256_hex(text.encode("utf-8")),
        "tokens": [token.to_dict() for token in tokens],
    }
    if meta is not None:
        unit["hadithMeta"] = meta
    return unit


def _tok_list(unit_ordinal: int, text: str, tokens: Sequence[Token]) -> list[Tok]:
    return [Tok((unit_ordinal, t.i), t.k, text[t.s : t.e], t.n) for t in tokens]


def _words(toks: Sequence[Tok]) -> int:
    return sum(1 for t in toks if t.kind == "word")


def _make_passage(
    ids: tuple[str, int],
    *,
    path: str,
    ordinal: int,
    section_ordinal: int,
    reference: str,
    toks: Sequence[Tok],
    part_ranges: Sequence[tuple[int, int]],
) -> dict[str, Any]:
    edition_key, bank_version = ids
    parts = []
    for number, (first, last) in enumerate(part_ranges, start=1):
        chunk = toks[first : last + 1]
        parts.append(
            {
                "id": stable_id(edition_key, bank_version, "part", f"{path}:{ordinal}:{number}"),
                "ordinal": number,
                "startRef": ref_str(chunk[0].ref),
                "endRef": ref_str(chunk[-1].ref),
                "wordCount": _words(chunk),
            }
        )
    return {
        "id": stable_id(edition_key, bank_version, "passage", f"{path}:{ordinal}"),
        "ordinal": ordinal,
        "sectionOrdinal": section_ordinal,
        "path": path,
        "startRef": ref_str(toks[0].ref),
        "endRef": ref_str(toks[-1].ref),
        "wordCount": _words(toks),
        "reference": reference,
        "parts": parts,
    }


# --- Quran ---------------------------------------------------------------------------------


def segment_quran(
    *,
    edition_key: str,
    bank_version: int,
    records_by_surah: Mapping[int, Sequence[QuranRecord]],
    surahs: Sequence[int],
    labels: EditionLabels,
) -> SegmentResult:
    """Sections (one per surah, ascending), ayah units and ``quran`` passages with parts."""
    ids = (edition_key, bank_version)
    result = SegmentResult()
    unit_ordinal = 0
    passage_ordinal = 0
    for section_ordinal, surah in enumerate(surahs, start=1):
        records = sorted(records_by_surah[surah], key=lambda r: r.ayah)
        url = quran_url(surah)
        result.sections.append(
            {
                "id": stable_id(edition_key, bank_version, "section", section_ordinal),
                "ordinal": section_ordinal,
                "kind": "surah",
                "reference": str(surah),
                "titleAr": labels.title_ar(surah),
                "titleEn": labels.title_en(surah),
                "sourceUrl": url,
            }
        )
        ayat: list[list[Tok]] = []
        references: list[str] = []
        for record in records:
            unit_ordinal += 1
            text = nfc(record.text)
            tokens = tokenize(text)
            reference = f"{surah}:{record.ayah}"
            result.units.append(
                _unit_dict(
                    ids, unit_ordinal, section_ordinal, "ayah", reference, url, text, tokens, None
                )
            )
            ayat.append(_tok_list(unit_ordinal, text, tokens))
            references.append(reference)
        groups, capped = pa.quran_passage_groups([_words(a) for a in ayat])
        if capped:
            result.suspected.append(
                {
                    "unit": f"surah:{surah}",
                    "kind": "passage_count_capped",
                    "details": "k was capped at the number of ayat; ayat are never split",
                }
            )
        for first, last in groups:
            passage_ordinal += 1
            toks: list[Tok] = []
            part_ranges: list[tuple[int, int]] = []
            for ayah_tokens in ayat[first : last + 1]:
                offset = len(toks)
                toks.extend(ayah_tokens)
                part_ranges.extend(
                    (offset + a, offset + b) for a, b in pa.quran_ayah_parts(ayah_tokens)
                )
            first_ayah = references[first].split(":")[1]
            last_ayah = references[last].split(":")[1]
            reference = f"{surah}:{first_ayah}" + ("" if first == last else f"-{last_ayah}")
            result.passages.append(
                _make_passage(
                    ids,
                    path="quran",
                    ordinal=passage_ordinal,
                    section_ordinal=section_ordinal,
                    reference=reference,
                    toks=toks,
                    part_ranges=part_ranges,
                )
            )
    return result


# --- hadith --------------------------------------------------------------------------------


def _check_range(entry: BoundaryEntry, size: int) -> None:
    for item in (entry.matn, entry.sanad):
        if item is not None and not (item.start <= item.end < size):
            raise InputError("a boundaries entry has a token range outside the narration")
    if entry.matn is not None and entry.sanad is not None and entry.sanad.end >= entry.matn.start:
        raise InputError("a boundaries entry has a sanad range that overlaps the matn range")


def _doubt_note(number: int, doubt: str, entry: BoundaryEntry | None) -> dict[str, Any]:
    where = "listed in nawawi40_boundaries.json (unreviewed)" if entry else "not listed"
    return {
        "unit": f"forty:{number}:narration",
        "kind": "matn_boundary_doubt",
        "details": f"{doubt} «...» marks; one matn passage over the whole narration; {where}",
    }


def distinct_grade_phrases(records: Mapping[int, HadithRecord], numbers: Sequence[int]) -> int:
    """Number of distinct grade phrases (compared by their normalized words) among ``numbers``."""
    phrases: set[tuple[str, ...]] = set()
    for number in numbers:
        words = tuple(t.n for t in tokenize(nfc(records[number].grade)) if t.k == "word")
        if words:
            phrases.add(words)
    return len(phrases)


def segment_hadith(
    *,
    edition_key: str,
    bank_version: int,
    records: Mapping[int, HadithRecord],
    numbers: Sequence[int],
    labels: EditionLabels,
    boundaries: Boundaries,
    sample: bool = False,
) -> SegmentResult:
    """Sections (one per included hadith, ascending), narration/takhrij/grade units and the
    ``matn``, ``sanad`` and ``grade`` passages. ``numbers`` are the Forty numbers to include
    (gaps are already excluded by the caller).

    ``sample`` marks a build whose scope is narrower than the whole edition. A sample with fewer
    than two distinct grade phrases cannot test the grade, so it makes no grade passage (the
    grade unit is kept) and flags that in ``suspected``. A full build always makes the grade
    passage, so a missing question stays a validation failure there.
    """
    ids = (edition_key, bank_version)
    result = SegmentResult()
    unit_ordinal = 0
    counters = {"matn": 0, "sanad": 0, "grade": 0}
    grade_testable = not sample or distinct_grade_phrases(records, numbers) >= MIN_GRADE_PHRASES
    for section_ordinal, number in enumerate(numbers, start=1):
        record = records[number]
        url = record.url
        reference = f"nawawi40:{number}"
        meta = hadith_meta(record)
        result.sections.append(
            {
                "id": stable_id(edition_key, bank_version, "section", section_ordinal),
                "ordinal": section_ordinal,
                "kind": "hadith",
                "reference": reference,
                "titleAr": labels.title_ar(number),
                "titleEn": labels.title_en(number),
                "sourceUrl": url,
            }
        )
        values = [
            ("hadith_narration", nfc(record.narration)),
            ("hadith_takhrij", nfc(record.narrator)),
            ("hadith_grade", nfc(record.grade)),
        ]
        unit_toks: dict[str, list[Tok]] = {}
        for kind, text in values:
            if kind != "hadith_narration" and not text.strip():
                continue
            unit_ordinal += 1
            tokens = tokenize(text)
            result.units.append(
                _unit_dict(
                    ids, unit_ordinal, section_ordinal, kind, reference, url, text, tokens, meta
                )
            )
            unit_toks[kind] = _tok_list(unit_ordinal, text, tokens)

        narration = unit_toks["hadith_narration"]
        entry = boundaries.get(number)
        matn_range: tuple[int, int] | None
        sanad_range: tuple[int, int] | None = None
        if entry is not None and entry.reviewed_by and entry.matn is not None:
            _check_range(entry, len(narration))
            matn_range = (entry.matn.start, entry.matn.end)
            sanad_range = (entry.sanad.start, entry.sanad.end) if entry.sanad else None
        else:
            found, doubt = pa.find_matn_bounds(narration)
            if found is None or entry is not None:
                matn_range = (0, len(narration) - 1)
                kind = doubt if doubt is not None else (entry.doubt if entry else "unknown")
                result.suspected.append(_doubt_note(number, kind, entry))
            else:
                matn_range = found
                if found[0] > 0:
                    sanad_range = (0, found[0] - 1)
        matn_toks = narration[matn_range[0] : matn_range[1] + 1]
        if _words(matn_toks) == 0:
            matn_toks = narration
            result.suspected.append(_doubt_note(number, "empty", entry))
        groups, hard = pa.matn_groups(matn_toks)
        if hard:
            result.suspected.append(
                {
                    "unit": f"forty:{number}:narration",
                    "kind": "matn_hard_split",
                    "details": "no sentence-punctuation cuts allow groups of at most 60 words",
                }
            )
        for first, last in groups:
            chunk = matn_toks[first : last + 1]
            counters["matn"] += 1
            result.passages.append(
                _make_passage(
                    ids,
                    path="matn",
                    ordinal=counters["matn"],
                    section_ordinal=section_ordinal,
                    reference=reference,
                    toks=chunk,
                    part_ranges=pa.hadith_parts(chunk),
                )
            )
        if sanad_range is not None:
            sanad_toks = narration[sanad_range[0] : sanad_range[1] + 1]
            if _words(sanad_toks) > 0:
                counters["sanad"] += 1
                result.passages.append(
                    _make_passage(
                        ids,
                        path="sanad",
                        ordinal=counters["sanad"],
                        section_ordinal=section_ordinal,
                        reference=reference,
                        toks=sanad_toks,
                        part_ranges=pa.hadith_parts(sanad_toks),
                    )
                )
        grade = unit_toks.get("hadith_grade")
        if grade is not None and _words(grade) > 0 and not grade_testable:
            result.suspected.append(
                {
                    "unit": f"forty:{number}:grade",
                    "kind": "grade_path_unavailable",
                    "details": (
                        "a sample build with fewer than two distinct grade phrases cannot test "
                        "the grade; no grade passage is made and the grade unit is kept"
                    ),
                }
            )
        elif grade is not None and _words(grade) > 0:
            counters["grade"] += 1
            result.passages.append(
                _make_passage(
                    ids,
                    path="grade",
                    ordinal=counters["grade"],
                    section_ordinal=section_ordinal,
                    reference=reference,
                    toks=grade,
                    part_ranges=pa.hadith_parts(grade),
                )
            )
    return result
