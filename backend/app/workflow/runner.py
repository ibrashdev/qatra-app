"""Resumable, idempotent step runner (Programming-guide §5 ``workflow/runner.py``).

``run_content_job(edition_key, bank_version, step, ...)`` runs one step of the web-edition
workflow. It is invoked only by the operator CLI (D48), keyed by ``(edition, bank_version,
step)``:

- The step order is checked first through ``content_policy.assert_step_allowed``.
- A step with no handler (``segmented`` ... ``archived`` in B7) raises
  ``StepNotImplementedError`` without changing any state.
- A handler receives the existing row (its ``cursor`` is the resume position) and returns a
  ``StepOutcome``: ``succeeded``, or ``running`` when valid progress is stored and more input is
  needed (for example hadith pass 2).
- Re-running a step with an unchanged result (same ``digest``) changes nothing. A changed result
  resets every later ordered step to ``pending`` (an approval never survives changed inputs).
- ``StepFailure`` and unexpected exceptions record the step as ``failed`` with the cursor and
  reset later steps; refusals (``InputError``, ``PreconditionError``, ``NotConfiguredError``,
  ``SourceUnreachableError``) leave every row untouched. Nothing is ever published partially.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from app.domain.content_policy import SKIPPED_STEPS, WEB_STEP_ORDER, assert_step_allowed
from app.workflow.editions import edition_spec
from app.workflow.errors import (
    InputError,
    NotConfiguredError,
    PreconditionError,
    SourceUnreachableError,
    StepFailure,
    StepNotImplementedError,
)
from app.workflow.jobs import (
    PIPELINE_VERSION,
    JobRepository,
    completed_steps,
    new_job,
)
from app.workflow.models import ContentJob

Clock = Callable[[], datetime]

_SKIP_REASON = "web edition: no printed pages (D68) and embeddings postponed (D69)"
_REFUSALS = (InputError, PreconditionError, NotConfiguredError, SourceUnreachableError)


@dataclass(frozen=True, slots=True)
class StepOutcome:
    """What a handler reports. ``digest`` fingerprints the step output (idempotency check);
    ``counts`` are printed by the CLI; ``summary`` must never contain source text."""

    status: Literal["succeeded", "running"]
    cursor: dict[str, Any] | None = None
    summary: dict[str, Any] | None = None
    digest: str | None = None
    counts: Mapping[str, int] = field(default_factory=dict)


StepHandler = Callable[[ContentJob], StepOutcome]


@dataclass(frozen=True, slots=True)
class JobResult:
    step: str
    status: str
    changed: bool
    resumed: bool
    counts: Mapping[str, int]
    job: ContentJob


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _reset_later_steps(
    jobs: JobRepository, edition_key: str, bank_version: int, step: str, now: datetime
) -> None:
    if step not in WEB_STEP_ORDER:
        return
    for later in WEB_STEP_ORDER[WEB_STEP_ORDER.index(step) + 1 :]:
        row = jobs.get_job(edition_key, bank_version, later)
        if row is not None and row.status != "pending":
            jobs.save_job(
                row.model_copy(
                    update={
                        "status": "pending",
                        "cursor": None,
                        "validation_summary": None,
                        "published_at": None,
                        "updated_at": now,
                    }
                )
            )


def _ensure_skipped_rows(
    jobs: JobRepository, edition_key: str, bank_version: int, now: datetime
) -> None:
    """Record ``page_mapped`` and ``embedded`` as ``skipped`` (D68, D69), once."""
    for step in SKIPPED_STEPS:
        if jobs.get_job(edition_key, bank_version, step) is None:
            row = new_job(edition_key, bank_version, step, now=now, status="skipped")
            jobs.save_job(row.model_copy(update={"validation_summary": {"reason": _SKIP_REASON}}))


def run_content_job(
    edition_key: str,
    bank_version: int,
    step: str,
    *,
    jobs: JobRepository,
    handlers: Mapping[str, StepHandler],
    clock: Clock = _utc_now,
) -> JobResult:
    """Run one step; see the module docstring for the contract."""
    edition_spec(edition_key)
    if bank_version < 1:
        raise InputError("bank version must be 1 or greater")
    existing = jobs.list_jobs(edition_key, bank_version)
    assert_step_allowed(completed_steps(existing), step)
    handler = handlers.get(step)
    if handler is None:
        raise StepNotImplementedError(f"not implemented in B7 (B8/C6): step {step!r}")

    now = clock()
    row = jobs.get_job(edition_key, bank_version, step)
    if row is None:
        row = new_job(edition_key, bank_version, step, now=now)
    prior_status = row.status
    prior_digest = (row.validation_summary or {}).get("digest")
    resumed = prior_status in ("running", "failed") and row.cursor is not None

    try:
        outcome = handler(row)
    except StepFailure as exc:
        failed = row.model_copy(
            update={
                "status": "failed",
                "cursor": exc.cursor if exc.cursor is not None else row.cursor,
                "validation_summary": exc.summary,
                "updated_at": now,
            }
        )
        _ensure_skipped_rows(jobs, edition_key, bank_version, now)
        jobs.save_job(failed)
        _reset_later_steps(jobs, edition_key, bank_version, step, now)
        raise
    except _REFUSALS:
        raise
    except Exception as exc:
        failed = row.model_copy(
            update={
                "status": "failed",
                "validation_summary": {"error": type(exc).__name__},
                "updated_at": now,
            }
        )
        _ensure_skipped_rows(jobs, edition_key, bank_version, now)
        jobs.save_job(failed)
        _reset_later_steps(jobs, edition_key, bank_version, step, now)
        raise

    summary = dict(outcome.summary or {})
    if outcome.digest is not None:
        summary["digest"] = outcome.digest
    unchanged = (
        prior_status == outcome.status == "succeeded"
        and outcome.digest is not None
        and prior_digest == outcome.digest
    )
    if unchanged:
        return JobResult(step, "succeeded", False, resumed, outcome.counts, row)

    saved = row.model_copy(
        update={
            "status": outcome.status,
            "cursor": outcome.cursor,
            "validation_summary": summary or None,
            "updated_at": now,
        }
    )
    _ensure_skipped_rows(jobs, edition_key, bank_version, now)
    jobs.save_job(saved)
    _reset_later_steps(jobs, edition_key, bank_version, step, now)
    return JobResult(step, outcome.status, True, resumed, outcome.counts, saved)


__all__ = [
    "PIPELINE_VERSION",
    "JobResult",
    "StepHandler",
    "StepOutcome",
    "run_content_job",
]
