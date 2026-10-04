"""Pydantic v2 models of the content workflow.

Raw record shapes follow contract §2.7 exactly; ``extra="forbid"`` means a record that carries
anything else (a tafsir, a translation, a commentary) is rejected instead of stored (D20, D68).
``ContentJob`` mirrors the ``content_jobs`` columns of Database-schema §6.1.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from app.domain.content_policy import (
    JOB_STATUSES,
    STEP_VOCABULARY,
    WEB_STEP_ORDER,
)
from app.workflow.errors import InputError, IntegrityError

JobStep = Literal[
    "acquired",
    "verified",
    "segmented",
    "bank_built",
    "validated",
    "approved",
    "published",
    "withdrawn",
    "archived",
    "uploaded",
    "extracted",
    "page_mapped",
    "embedded",
]
JobStatus = Literal["pending", "running", "succeeded", "failed", "skipped"]
EditionStatus = Literal["draft", "validated", "published", "superseded", "revoked"]
Acquisition = Literal["mcp_tool", "http"]


def canonical_json(value: Any) -> bytes:
    """Deterministic JSON bytes (sorted keys, no spaces, UTF-8, no ASCII escaping)."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_validation_summary(exc: ValidationError) -> str:
    """Field paths and error types only: a pydantic message can echo the offending value."""
    items = sorted({f"{'.'.join(str(p) for p in e['loc'])}:{e['type']}" for e in exc.errors()})
    return "; ".join(items[:8]) + ("; ..." if len(items) > 8 else "")


# --- raw records (contract §2.7) -----------------------------------------------------------


class QuranRecord(BaseModel):
    """``{surah, ayah, text, url}``: the verse line only, never the tafsir."""

    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)

    surah: int = Field(ge=1, le=114)
    ayah: int = Field(ge=1)
    text: str
    url: str


class HadithRecord(BaseModel):
    """``{hadeethencId, fortyNumber, title, narration, narrator, grade, url, languages}``.

    ``narrator`` (takhrij) and ``grade`` are the ``[ATTRIBUTION]`` values; an absent value is
    an empty string (a missing grade is shown as «غير مذكور في النسخة», contract §2.3).
    """

    model_config = ConfigDict(strict=True, extra="forbid", frozen=True, populate_by_name=True)

    hadeethenc_id: int = Field(alias="hadeethencId", ge=1)
    forty_number: int = Field(alias="fortyNumber", ge=1, le=42)
    title: str = ""
    narration: str
    narrator: str = ""
    grade: str = ""
    url: str
    languages: list[str] = Field(default_factory=list)


class RawObject(BaseModel):
    """One raw object as stored: the records plus tool name, arguments, retrieval time,
    canonical URL and ``rawSha256`` (SHA-256 of the canonical JSON of ``payload``)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    tool_name: str = Field(alias="toolName")
    arguments: dict[str, Any]
    retrieved_at: AwareDatetime = Field(alias="retrievedAt")
    canonical_url: str = Field(alias="canonicalUrl")
    raw_sha256: str = Field(alias="rawSha256", pattern=r"^[0-9a-f]{64}$")
    payload: dict[str, Any]
    acquisition: Acquisition = "mcp_tool"
    pass_number: int | None = Field(default=None, alias="passNumber", ge=1, le=2)

    @classmethod
    def build(
        cls,
        *,
        tool_name: str,
        arguments: dict[str, Any],
        retrieved_at: datetime,
        canonical_url: str,
        payload: dict[str, Any],
        acquisition: Acquisition = "mcp_tool",
        pass_number: int | None = None,
    ) -> RawObject:
        return cls(
            toolName=tool_name,
            arguments=arguments,
            retrievedAt=retrieved_at,
            canonicalUrl=canonical_url,
            rawSha256=sha256_hex(canonical_json(payload)),
            payload=payload,
            acquisition=acquisition,
            passNumber=pass_number,
        )

    def to_bytes(self) -> bytes:
        data = self.model_dump(mode="json", by_alias=True)
        return (json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode(
            "utf-8"
        )

    @classmethod
    def from_bytes(cls, data: bytes) -> RawObject:
        try:
            obj = cls.model_validate(json.loads(data))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise IntegrityError(
                f"stored raw object is not valid JSON ({type(exc).__name__})"
            ) from None
        except ValidationError as exc:
            raise IntegrityError(
                f"stored raw object has an invalid shape: {safe_validation_summary(exc)}"
            ) from None
        if obj.raw_sha256 != sha256_hex(canonical_json(obj.payload)):
            raise IntegrityError("stored raw object does not match its recorded rawSha256")
        return obj

    def quran_records(self) -> list[QuranRecord]:
        return [QuranRecord.model_validate(item) for item in self.payload.get("records", [])]

    def hadith_records(self) -> list[HadithRecord]:
        return [HadithRecord.model_validate(item) for item in self.payload.get("records", [])]


# --- verification --------------------------------------------------------------------------


class VerificationRecord(BaseModel):
    """``{method, result, details}`` (bundle ``source.verification``); per-unit records add
    ``unit_ref``. ``details`` holds counts and positions only, never source text."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    method: str
    result: Literal["passed", "failed"]
    details: str = ""
    unit_ref: str | None = None


# --- jobs ----------------------------------------------------------------------------------


class ContentJob(BaseModel):
    """One ``content_jobs`` row (Database-schema §6.1): unique per
    ``(edition, bank_version, step)``. ``edition_key`` is local (the table joins on
    ``edition_id``, unknown until the draft rows exist)."""

    model_config = ConfigDict(extra="forbid")

    id: UUID
    edition_id: UUID | None = None
    edition_key: str
    bank_version: int = Field(ge=1)
    pipeline_version: str = Field(min_length=1)
    step: JobStep
    cursor: dict[str, Any] | None = None
    status: JobStatus = "pending"
    validation_summary: dict[str, Any] | None = None
    published_at: AwareDatetime | None = None
    created_at: AwareDatetime
    updated_at: AwareDatetime

    @field_validator("step")
    @classmethod
    def _step_in_vocabulary(cls, value: str) -> str:
        if value not in STEP_VOCABULARY:  # keeps the Literal and the policy constants in sync
            raise ValueError("unknown step")
        return value

    @field_validator("status")
    @classmethod
    def _status_in_vocabulary(cls, value: str) -> str:
        if value not in JOB_STATUSES:
            raise ValueError("unknown status")
        return value

    @model_validator(mode="after")
    def _published_at_only_when_published(self) -> ContentJob:
        if self.published_at is not None and self.step != "published":
            raise ValueError("published_at is only allowed on the 'published' step")
        return self


class EditionState(BaseModel):
    """Edition state derived from the jobs (API-spec §5.2 "Edition state afterwards")."""

    model_config = ConfigDict(extra="forbid")

    edition_key: str
    bank_version: int
    status: EditionStatus
    completed_steps: list[str]
    catalog_hidden: bool = False
    approval_recorded: bool = False


def derive_edition_state(
    edition_key: str, bank_version: int, jobs: list[ContentJob]
) -> EditionState:
    """``draft`` until ``validated``; ``published`` after ``published``; ``revoked`` after
    ``withdrawn``; ``archived`` hides the edition without changing the status."""
    done = {job.step for job in jobs if job.status == "succeeded"}
    if "withdrawn" in done:
        status: EditionStatus = "revoked"
    elif "published" in done:
        status = "published"
    elif "validated" in done:
        status = "validated"
    else:
        status = "draft"
    ordered = [step for step in (*WEB_STEP_ORDER, "withdrawn", "archived") if step in done]
    return EditionState(
        edition_key=edition_key,
        bank_version=bank_version,
        status=status,
        completed_steps=ordered,
        catalog_hidden="archived" in done,
        approval_recorded="approved" in done,
    )


def parse_json_object(data: bytes, *, what: str) -> dict[str, Any]:
    """Parse a JSON object from bytes; the error names only the position, never the text."""
    try:
        value = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        position = (
            f" at line {exc.lineno} column {exc.colno}"
            if isinstance(exc, json.JSONDecodeError)
            else ""
        )
        raise InputError(f"{what} is not valid JSON{position}") from None
    if not isinstance(value, dict):
        raise InputError(f"{what} must be a JSON object")
    return value
