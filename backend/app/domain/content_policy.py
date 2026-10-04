"""Content workflow policy (pure): step order, publishing gate and removal rules.

Pure module: standard library only (no FastAPI, no database client). It decides; the workflow
(``app/workflow``) executes. Sources: API-spec §5.2-§5.3, Database-schema §4.4 and §6.1
(``content_jobs``), Implementation-contract §2.7, D44, D68, D69.

Web editions (D68) run ``acquired -> verified -> segmented -> bank_built -> validated ->
approved -> published``; ``withdrawn`` and ``archived`` are audit steps that follow
``published``; ``page_mapped`` and ``embedded`` are skipped (no printed pages, embeddings
postponed, D69) and ``uploaded`` and ``extracted`` are reserved for later editions.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final

# --- value sets (Database-schema §4.4) -----------------------------------------------------

WEB_STEP_ORDER: Final[tuple[str, ...]] = (
    "acquired",
    "verified",
    "segmented",
    "bank_built",
    "validated",
    "approved",
    "published",
)
AUDIT_STEPS: Final[tuple[str, ...]] = ("withdrawn", "archived")
SKIPPED_STEPS: Final[tuple[str, ...]] = ("page_mapped", "embedded")
RESERVED_STEPS: Final[tuple[str, ...]] = ("uploaded", "extracted", *SKIPPED_STEPS)
STEP_VOCABULARY: Final[tuple[str, ...]] = (*WEB_STEP_ORDER, *AUDIT_STEPS, *RESERVED_STEPS)

JOB_STATUSES: Final[tuple[str, ...]] = ("pending", "running", "succeeded", "failed", "skipped")
EDITION_STATUSES: Final[tuple[str, ...]] = (
    "draft",
    "validated",
    "published",
    "superseded",
    "revoked",
)
RIGHTS_STATUSES: Final[tuple[str, ...]] = (
    "owner_accepted_pending_verification",
    "verified",
    "rejected",
)
VERIFICATION_RESULTS: Final[tuple[str, ...]] = ("passed", "failed")

# --- errors --------------------------------------------------------------------------------


class ContentPolicyError(Exception):
    """A policy refusal. ``code`` is a stable machine-readable reason; the message never
    contains source text."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class StepOrderError(ContentPolicyError):
    """The requested step is not allowed in the current workflow state."""


class PublishRefusedError(ContentPolicyError):
    """The edition may not be approved or published (fails closed)."""


class RemovalRefusedError(ContentPolicyError):
    """The edition may not be physically deleted."""


# --- step order ----------------------------------------------------------------------------


def assert_step_allowed(current_steps: Iterable[str], next_step: str) -> None:
    """Raise ``StepOrderError`` unless ``next_step`` may start.

    ``current_steps`` are the steps that already ``succeeded`` for one ``(edition, bank
    version)``. Re-running an earlier step of the order is allowed (the workflow is idempotent)
    until the version is published; a published version is immutable (a correction is a new
    bank version). ``withdrawn``/``archived`` need ``published`` and cannot repeat.
    """
    done = set(current_steps)
    unknown = sorted(done - set(STEP_VOCABULARY))
    if unknown:
        raise ContentPolicyError("unknown_step_recorded", f"unknown recorded step(s): {unknown}")
    if next_step not in STEP_VOCABULARY:
        raise StepOrderError("unknown_step", f"unknown step {next_step!r}")
    if next_step in RESERVED_STEPS:
        raise StepOrderError(
            "step_not_applicable",
            f"step {next_step!r} does not apply to web editions (D68, D69)",
        )
    if next_step in WEB_STEP_ORDER:
        if "published" in done:
            raise StepOrderError(
                "version_published",
                "this bank version is published and immutable; a correction needs a new version",
            )
        for earlier in WEB_STEP_ORDER[: WEB_STEP_ORDER.index(next_step)]:
            if earlier not in done:
                raise StepOrderError(
                    "step_order",
                    f"step {next_step!r} requires step {earlier!r} to be complete first",
                )
        return
    # audit steps
    if "published" not in done:
        raise StepOrderError(
            "not_published", f"step {next_step!r} requires the edition to be published"
        )
    if next_step in done:
        raise StepOrderError("already_recorded", f"step {next_step!r} is already recorded")
    if next_step == "archived" and "withdrawn" in done:
        raise StepOrderError(
            "revoked", "a withdrawn (revoked) edition cannot be archived: it is not published"
        )


# --- gates ---------------------------------------------------------------------------------


def _assert_verification_passed(verification_results: Iterable[Mapping[str, Any]]) -> None:
    results = list(verification_results)
    if not results:
        raise PublishRefusedError("verification_missing", "no verification results are recorded")
    if any(item.get("result") != "passed" for item in results):
        raise PublishRefusedError(
            "verification_not_passed", "every verification result must be 'passed'"
        )


def assert_approvable(
    edition_status: str, verification_results: Iterable[Mapping[str, Any]]
) -> None:
    """Preconditions of the owner's ``approve`` (API-spec §5.3): the edition is ``validated``
    and every verification result passed."""
    if edition_status != "validated":
        raise PublishRefusedError(
            "edition_not_validated", "approval needs an edition in status 'validated'"
        )
    _assert_verification_passed(verification_results)


def assert_publishable(
    edition_status: str,
    verification_results: Iterable[Mapping[str, Any]],
    approval: Mapping[str, Any] | None,
    license_record: Mapping[str, Any] | None,
) -> None:
    """Fails closed: the edition is ``validated``, every verification result is ``passed``,
    the owner's approval (who, when, scope and note) is recorded and the publisher's terms are
    recorded in the license record (D68, D71)."""
    assert_approvable(edition_status, verification_results)
    if not approval or not all(str(approval.get(key, "")).strip() for key in ("who", "at", "note")):
        raise PublishRefusedError(
            "approval_missing", "the owner's approval (who, at, note) must be recorded"
        )
    if not license_record:
        raise PublishRefusedError(
            "license_missing", "the publisher's terms must be recorded in the license record"
        )


# --- removal (D44) -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RemovalDecision:
    """What may be done to an edition version: physical delete, or withdraw/archive only."""

    delete_allowed: bool
    allowed_actions: tuple[str, ...]
    reason: str


def decide_removal(status: str, has_references: bool) -> RemovalDecision:
    """A draft that nothing references may be deleted; otherwise only ``withdraw`` and
    ``archive`` exist, and only for a published edition (D44, API-spec §5.3)."""
    if status not in EDITION_STATUSES:
        raise ContentPolicyError("unknown_status", f"unknown edition status {status!r}")
    if status == "draft" and not has_references:
        return RemovalDecision(True, ("delete",), "unused draft")
    if status == "published":
        return RemovalDecision(
            False,
            ("withdraw", "archive"),
            "published editions are withdrawn or archived, never deleted",
        )
    if status == "draft":
        return RemovalDecision(
            False, (), "the draft is referenced by a plan, session or progress record"
        )
    return RemovalDecision(
        False, (), f"a {status} edition cannot be deleted, withdrawn or archived"
    )


def assert_delete_unused_draft_allowed(
    status: str, has_references: bool, steps_ever_recorded: Iterable[str]
) -> None:
    """Preconditions of ``delete-unused-draft``: draft, never published, unreferenced."""
    if "published" in set(steps_ever_recorded):
        raise RemovalRefusedError(
            "was_published", "a version that was ever published is never deleted"
        )
    decision = decide_removal(status, has_references)
    if not decision.delete_allowed:
        raise RemovalRefusedError("not_deletable", decision.reason)
