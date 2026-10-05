"""Plain result containers shared by content management and the reports (no source text)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from app.workflow.editions import EditionScope
from app.workflow.models import VerificationRecord


@dataclass(frozen=True, slots=True)
class Gap:
    """A Forty hadith left out of the build: reported, never filled from another source."""

    forty_number: int
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {"fortyNumber": self.forty_number, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class ObjectInfo:
    """Facts about one stored raw object (ids and counts only)."""

    name: str
    pass_number: int | None
    record_ids: tuple[str, ...]
    raw_sha256: str
    retrieved_at: datetime
    acquisition: str
    canonical_url: str


@dataclass(frozen=True, slots=True)
class AcquisitionSnapshot:
    """State of an acquisition after a run, for the acquisition report and the job summary."""

    edition_key: str
    bank_version: int
    scope: EditionScope
    complete: bool
    objects: tuple[ObjectInfo, ...]
    created: int
    unchanged: int
    missing_surahs: tuple[int, ...] = ()
    passes_present: tuple[int, ...] = ()
    source_raw_sha256: str = ""
    source_retrieved_at: datetime | None = None
    source_acquisition: str = ""
    tool_name: str = ""
    generated_at: datetime | None = None


@dataclass(slots=True)
class VerificationOutcome:
    """Result of ``verify_verbatim``: per-source and per-unit records, gaps, review flags."""

    edition_key: str
    bank_version: int
    scope: EditionScope
    source: VerificationRecord
    units: list[VerificationRecord]
    gaps: list[Gap] = field(default_factory=list)
    suspected: list[dict[str, Any]] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    digest: str = ""
    generated_at: datetime | None = None
    # source-only mode (D83): the decision id and the text-free evidence (hashes, ids, times)
    decision: str | None = None
    evidence: dict[str, Any] = field(default_factory=dict)

    @property
    def result(self) -> Literal["passed", "failed"]:
        return self.source.result

    def failed_refs(self) -> list[str]:
        return sorted({u.unit_ref for u in self.units if u.result == "failed" and u.unit_ref})
