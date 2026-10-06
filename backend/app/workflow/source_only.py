"""Decision-scoped verification using independent acquisitions from the service itself.

D83 (owner, 5 October 2026) accepts, for exactly one scope, evidence from the Islamic Content
service alone in place of the KFGQPC Hafs oracle and the OpenITI skeleton (contract §2.7 items 1
and 2). No other source is fetched, not even as a check. The scope is fixed here and nothing else
qualifies:

- ``quran-hafs-quranenc``, bank version 1, surah 112 only;
- ``nawawi40-hadeethenc``, bank version 1, Forty hadith 1 only (HadeethEnc record 66511).

D95 (owner, 6 October 2026) adds exactly one Quran scope: ``quran-hafs-quranenc``, bank version 4,
all Juz' Amma surahs 78–114. It authorizes the same-source two-HTTP-acquisition comparison only;
it does not establish comparison with KFGQPC or authorize hadith, another bank, publication or a
different scope. D83 constants and guards remain unchanged.

The evidence is two acquisitions made over HTTP from ``mcp.islamiccontent.org`` with the
workflow's own client (no assistant transcription). Quran: the stored acquisition and a
re-acquisition made during ``verify``, compared byte for byte (and after NFC). Hadith: pass 1 and
pass 2, compared after NFC. Everything recorded here (units, counts, hashes, ids, times) is free
of source text.

This module holds the fixed scope, the guards and the evidence helpers. The comparisons live in
``content_management`` next to the other verification code.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from app.workflow.editions import EDITION_HADITH, EDITION_QURAN, EditionScope
from app.workflow.errors import InputError, PreconditionError
from app.workflow.models import HadithRecord, RawObject

DECISION_ID: Final = "D83"
DECISION_IDS: Final = ("D83", "D95")
BANK_VERSION: Final = 1
QURAN_SURAHS: Final = (112,)
HADITH_IDS: Final[Mapping[int, int]] = {1: 66511}  # Forty number -> HadeethEnc record id
D95_QURAN_BANK_VERSION: Final = 4
D95_QURAN_SURAHS: Final = tuple(range(78, 115))
PRIOR_EVIDENCE: Final[Mapping[str, str]] = {
    "decision": "D68",
    "note": (
        "a sample check recorded in D68 found QuranEnc surah 112 equal to the King Fahd Complex "
        "Hafs text after Unicode normalization; cited as prior evidence, not re-fetched or "
        "repeated here"
    ),
}


def method_name(base: str, decision: str = DECISION_ID) -> str:
    """The verification method string that carries the decision id everywhere it is copied
    (the bundle, the review record, the eligibility record)."""
    return f"source_only({decision}):{base}"


def require_decision(value: str) -> None:
    if value not in DECISION_IDS:
        allowed = ", ".join(DECISION_IDS)
        raise InputError(f"unknown source-only decision (allowed: {allowed})")


def assert_scope(
    edition_key: str, bank_version: int, scope: EditionScope, decision: str = DECISION_ID
) -> None:
    """Refuse every build that is not exactly the scope of the named decision."""
    require_decision(decision)
    if decision == "D95":
        covered = (
            edition_key == EDITION_QURAN
            and bank_version == D95_QURAN_BANK_VERSION
            and scope.surahs == D95_QURAN_SURAHS
            and not scope.forty_numbers
        )
        if not covered:
            if bank_version != D95_QURAN_BANK_VERSION:
                raise PreconditionError(f"D95 covers bank version {D95_QURAN_BANK_VERSION} only")
            raise PreconditionError(
                f"D95 covers all surahs 78-114 of {EDITION_QURAN} only; "
                "the scope of this build differs"
            )
        return

    if bank_version != BANK_VERSION:
        raise PreconditionError(f"{DECISION_ID} covers bank version {BANK_VERSION} only")
    if edition_key == EDITION_QURAN:
        covered = scope.surahs == QURAN_SURAHS and not scope.forty_numbers
    elif edition_key == EDITION_HADITH:
        covered = scope.forty_numbers == tuple(HADITH_IDS) and not scope.surahs
    else:
        covered = False
    if not covered:
        raise PreconditionError(
            f"{DECISION_ID} covers surah {QURAN_SURAHS[0]} of {EDITION_QURAN} and Forty hadith "
            f"{next(iter(HADITH_IDS))} of {EDITION_HADITH} only; the scope of this build differs"
        )


def prior_evidence(decision: str = DECISION_ID) -> Mapping[str, str]:
    """Return the accurate basis recorded for each source-only decision."""
    require_decision(decision)
    if decision == DECISION_ID:
        return PRIOR_EVIDENCE
    return {
        "decision": "D95",
        "note": (
            "the owner authorized the two-HTTP-acquisition source-only comparison for the full "
            "Juz' Amma Quran scope at bank version 4; this is not a KFGQPC Hafs v18 comparison"
        ),
    }


def assert_http_acquired(objects: Mapping[str, RawObject], decision: str = DECISION_ID) -> None:
    """Every stored object must be an HTTP acquisition: a records file was transcribed by an
    assistant and cannot serve as source-only evidence."""
    for name, obj in sorted(objects.items()):
        if obj.acquisition != "http":
            raise PreconditionError(
                f"stored object {name} was not acquired over HTTP; {decision} accepts "
                "HTTP acquisitions only (no assistant transcription)"
            )


def assert_hadith_ids(records: Mapping[int, HadithRecord]) -> None:
    """The record of each covered hadith must be the HadeethEnc record named by D83."""
    for number, expected in HADITH_IDS.items():
        record = records.get(number)
        if record is not None and record.hadeethenc_id != expected:
            raise PreconditionError(
                f"forty:{number} was acquired from HadeethEnc record {record.hadeethenc_id}; "
                f"{DECISION_ID} names record {expected}"
            )


def _iso(value: Any) -> str:
    return value.isoformat().replace("+00:00", "Z")


def acquisition_entry(role: str, name: str, obj: RawObject) -> dict[str, Any]:
    """One acquisition of the evidence: object name, hash and time (no text)."""
    entry: dict[str, Any] = {
        "role": role,
        "object": name,
        "acquisition": obj.acquisition,
        "rawSha256": obj.raw_sha256,
        "retrievedAt": _iso(obj.retrieved_at),
    }
    if obj.pass_number is not None:
        entry["pass"] = obj.pass_number
    return entry
