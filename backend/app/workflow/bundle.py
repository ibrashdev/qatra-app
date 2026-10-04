"""Content bundle, format v1 (contract §2.6): assembly, deterministic serialization, hashes.

One JSON file per edition (``backend/.content-build/<editionKey>/bundle.json``, gitignored).
The serialization is deterministic (fixed key order, no timestamps of its own): two builds from
the same inputs are byte-identical. Top-level keys are one per line and arrays of objects have
one object per line, so a committed synthetic bundle diffs well.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, Final

from app.workflow.editions import MCP_SOURCE_URL, PROVIDER, EditionSpec
from app.workflow.errors import InputError
from app.workflow.ids import stable_id
from app.workflow.labels import EditionLabels
from app.workflow.models import canonical_json, sha256_hex
from app.workflow.segmentation import SegmentResult

BUNDLE_VERSION: Final = 1
TOP_LEVEL_KEYS: Final = (
    "bundleVersion",
    "editionKey",
    "bankVersion",
    "category",
    "book",
    "source",
    "edition",
    "pages",
    "sections",
    "units",
    "passages",
    "lessons",
    "questions",
)
RIGHTS_PENDING: Final = "owner_accepted_pending_verification"


def content_hash(units: Sequence[Mapping[str, Any]]) -> str:
    """Fingerprint of the verbatim text: SHA-256 of the canonical JSON of
    ``[ordinal, kind, reference, canonicalText]`` for every unit in order."""
    return sha256_hex(
        canonical_json(
            [[u["ordinal"], u["kind"], u["reference"], u["canonicalText"]] for u in units]
        )
    )


def assemble_bundle(
    *,
    spec: EditionSpec,
    bank_version: int,
    labels: EditionLabels,
    segment: SegmentResult,
    provenance: Mapping[str, Any],
    verification: Mapping[str, Any],
    known_gaps: Sequence[Mapping[str, Any]],
    suspected: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """The bundle of a segmented edition (``lessons`` and ``questions`` stay empty until
    ``build-bank``). ``provenance`` is the ``source`` entry of the ``acquired`` job summary and
    ``verification`` the verification record of the ``verified`` job summary."""
    key = spec.key
    return {
        "bundleVersion": BUNDLE_VERSION,
        "editionKey": key,
        "bankVersion": bank_version,
        "category": {
            "slug": labels.category.slug,
            "labelAr": labels.category.label_ar,
            "labelEn": labels.category.label_en,
        },
        "book": {
            "id": stable_id(key, bank_version, "book", "book"),
            "titleAr": labels.book.title_ar,
            "titleEn": labels.book.title_en,
            "author": labels.book.author,
            "contentFormat": "quran" if spec.kind == "quran" else "hadith_collection",
        },
        "source": {
            "id": stable_id(key, bank_version, "source", "source"),
            "title": spec.title,
            "provider": PROVIDER,
            "sourceUrl": MCP_SOURCE_URL,
            "acquisition": provenance["acquisition"],
            "toolName": provenance["toolName"],
            "rawSha256": provenance["rawSha256"],
            "retrievedAt": provenance["retrievedAt"],
            "rightsStatus": RIGHTS_PENDING,
            "licenseRecord": {},
            "verification": {
                "method": verification["method"],
                "result": verification["result"],
                "details": verification.get("details", ""),
            },
        },
        "edition": {
            "id": stable_id(key, bank_version, "edition", "edition"),
            "editionLabel": labels.edition_label,
            "language": "ar",
            "version": 1,
            "contentHash": content_hash(segment.units),
            "paginationRecord": {"kind": "web_edition"},
            "reviewRecord": {
                "knownGaps": [dict(g) for g in known_gaps],
                "suspectedErrors": [dict(s) for s in [*suspected, *segment.suspected]],
            },
        },
        "pages": [],
        "sections": segment.sections,
        "units": segment.units,
        "passages": segment.passages,
        "lessons": [],
        "questions": [],
    }


def structure_of(bundle: Mapping[str, Any]) -> dict[str, Any]:
    """The bundle without its bank (``lessons`` and ``questions`` emptied)."""
    copy = dict(bundle)
    copy["lessons"] = []
    copy["questions"] = []
    return copy


def with_bank(
    bundle: Mapping[str, Any],
    lessons: Sequence[Mapping[str, Any]],
    questions: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    copy = dict(bundle)
    copy["lessons"] = [dict(x) for x in lessons]
    copy["questions"] = [dict(x) for x in questions]
    return copy


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "), allow_nan=False)


def dumps_bundle(bundle: Mapping[str, Any]) -> str:
    """Deterministic, diff-friendly JSON text of a bundle (always ends with a newline)."""
    lines = ["{"]
    items = list(bundle.items())
    for position, (name, value) in enumerate(items):
        comma = "," if position < len(items) - 1 else ""
        if isinstance(value, list) and value and all(isinstance(x, dict) for x in value):
            lines.append(f"  {json.dumps(name)}: [")
            for index, entry in enumerate(value):
                lines.append("    " + _compact(entry) + ("," if index < len(value) - 1 else ""))
            lines.append("  ]" + comma)
        else:
            lines.append(f"  {json.dumps(name)}: {_compact(value)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def bundle_sha256(bundle: Mapping[str, Any]) -> str:
    return sha256_hex(dumps_bundle(bundle).encode("utf-8"))


def structure_sha256(bundle: Mapping[str, Any]) -> str:
    return bundle_sha256(structure_of(bundle))


def loads_bundle(text: str) -> dict[str, Any]:
    """Parse a bundle file; the error names only what is wrong, never text."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InputError(
            f"bundle.json is not valid JSON at line {exc.lineno} column {exc.colno}"
        ) from None
    if not isinstance(data, dict) or tuple(data) != TOP_LEVEL_KEYS:
        raise InputError("bundle.json does not have the bundle v1 top-level keys")
    return data
