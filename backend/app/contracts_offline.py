"""DTOs of the offline endpoints E23 to E25 (Implementation-contract §7, API-spec §4.8, D46, D58,
D59). Package B9.

Pure pydantic (no FastAPI, Starlette or database client), like ``contracts_sessions``, whose base
classes and response pieces it reuses. JSON names are camelCase; Python names are snake_case.
Responses are built by field name and serialized by alias; request models accept the camelCase
names only and forbid unknown properties (API-spec S-1: ``userId``, ``mode`` and the like are
``forbidden_field``).

The Python class of the contract's ``PlanSnapshot`` is ``OfflinePlanSnapshot``, because
``app.services.sessions.PlanSnapshot`` already names the plan facts of E20.

Decisions where the contract is silent or open (offline-decisions G-01, G-07, all recorded in the
package report):

- ``downloadTargetRefs`` is optional on E23 (G-01). When it is absent or ``null`` the server selects
  the passages and returns them as ``downloadedTargetRefs``. An empty array, a duplicate, a value
  that is not a UUID, or more than 60 entries is ``target_refs_invalid``.
- ``contentHashes["unit:<unitRef>"]`` is the ``textHash`` (sha256 of the unit text, contract §2.6)
  of every unit shown in ``lessons`` (G-07). ``contentValidity`` is ``{"checkedAt", "result"}``.
- ``games`` holds the questions of the prepared ``game`` sessions, each once, with all options and
  its ``answerKey`` (the same objects as in those sessions' ``steps``), so a client can list the
  game questions without walking the steps. The daily session's questions stay in its steps: the
  same question can appear there with another ``role`` and option order.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, ValidationError, field_validator
from pydantic_core import PydanticCustomError

from app.contracts_plan_chat import CamelModel, RequestModel, TargetScope
from app.contracts_sessions import (
    NORMALIZATION_POLICY_VERSION,
    SCORING_POLICY_VERSION,
    PassageView,
    Question,
    RequestViolation,
    SessionSnapshot,
    SourceRef,
    violations_of,
)

SCHEMA_VERSION = 1
PROTOCOL_VERSION = 1
MAX_TARGET_REFS = 60  # API-spec A-12
MAX_PREPARED_SESSIONS = 7  # API-spec A-12

OfflineStatus = Literal["available", "stale", "revoked", "expired"]
RevalidationReason = Literal[
    "current",
    "plan_version_changed",
    "bank_version_changed",
    "content_revoked",
    "validity_ended",
]

_StrictVersion = Annotated[int, Field(strict=True, ge=1)]


# --- requests ------------------------------------------------------------------------------------


class CreateSnapshotRequest(RequestModel):
    """E23 body. ``download_target_refs`` is ``None`` when the client leaves the choice to the
    server (G-01)."""

    client_operation_id: UUID
    expected_plan_version: _StrictVersion
    download_target_refs: list[UUID] | None = None

    @field_validator("download_target_refs", mode="before")
    @classmethod
    def _valid_refs(cls, value: Any) -> Any:
        """Non-empty, at most 60 unique passage ids (a UUID each)."""
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or not 0 < len(value) <= MAX_TARGET_REFS
            or not all(isinstance(item, str) and _is_uuid(item) for item in value)
            or len({item.lower() for item in value}) != len(value)
        ):
            raise PydanticCustomError("target_refs_invalid", "the target references are not valid")
        return value


class RevalidateRequest(RequestModel):
    """E25 body: what the device holds."""

    snapshot_id: UUID
    expected_plan_version: _StrictVersion
    edition_id: UUID
    bank_version: _StrictVersion


def _is_uuid(text: str) -> bool:
    try:
        UUID(text)
    except ValueError:
        return False
    return True


def _violations(error: ValidationError) -> list[tuple[str, str]]:
    """``(field, rule)`` pairs with the rule names of API-spec E23: any fault of the operation id is
    ``client_operation_id_invalid`` (a forbidden property keeps ``forbidden_field``)."""
    pairs: list[tuple[str, str]] = []
    for field, rule in violations_of(error):
        if field == "clientOperationId" and rule != "forbidden_field":
            rule = "client_operation_id_invalid"
        elif field.startswith("downloadTargetRefs") and rule != "forbidden_field":
            field, rule = "downloadTargetRefs", "target_refs_invalid"
        pairs.append((field, rule))
    return list(dict.fromkeys(pairs))


def parse_create_snapshot_request(raw: Any) -> CreateSnapshotRequest:
    """Validate an E23 body. Raises ``RequestViolation`` (values are never echoed)."""
    if not isinstance(raw, dict):
        raise RequestViolation([("body", "object_required")])
    try:
        return CreateSnapshotRequest.model_validate(raw)
    except ValidationError as error:
        raise RequestViolation(_violations(error)) from None


def parse_revalidate_request(raw: Any) -> RevalidateRequest:
    """Validate an E25 body. Raises ``RequestViolation`` (values are never echoed)."""
    if not isinstance(raw, dict):
        raise RequestViolation([("body", "object_required")])
    try:
        return RevalidateRequest.model_validate(raw)
    except ValidationError as error:
        raise RequestViolation(violations_of(error)) from None


# --- responses -----------------------------------------------------------------------------------


class OfflinePlanSnapshot(CamelModel):
    """The ``PlanSnapshot`` of contract §7: an immutable download of part of one active plan.

    ``user_id`` is a non-secret ownership binding, not a credential. The snapshot never holds a
    token, a password, a recovery code, HadeethEnc commentary or QuranEnc translation or tafsir.
    """

    snapshot_id: UUID
    schema_version: int = SCHEMA_VERSION
    protocol_version: int = PROTOCOL_VERSION
    user_id: UUID
    plan_id: UUID
    plan_version: int
    edition_id: UUID
    bank_version: int
    target_scope: TargetScope
    downloaded_target_refs: list[UUID]
    learning_time_zone: str
    daily_goal_ms: int
    content_hashes: dict[str, str]
    verified_at: AwareDatetime
    content_validity: dict[str, Any]
    normalization_policy_version: str = NORMALIZATION_POLICY_VERSION
    scoring_policy_version: str = SCORING_POLICY_VERSION
    prepared_sessions: list[SessionSnapshot]
    lessons: list[PassageView]
    games: list[Question]
    references: list[SourceRef]


class RevalidationResult(CamelModel):
    """E25 answer. The status lives in the body and is never an HTTP error."""

    status: OfflineStatus
    current_plan_version: int
    allowed_session_refs: list[UUID]
    catalog_version: int
    reason_code: RevalidationReason
