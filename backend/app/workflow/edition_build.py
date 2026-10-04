"""Runner handlers of ``segment``, ``build-bank`` and ``validate`` (API-spec §5.3, B8).

Files written under ``<build>/<editionKey>/`` (gitignored; they contain source text except
``report.md``): ``bundle.json`` (the structure after ``segment``, the full bundle after
``build-bank``), ``publish.sql`` and ``report.md`` (counts, ids, codes only).

Consistency between steps: ``segment`` records the SHA-256 of the bundle structure,
``build-bank`` refuses a ``bundle.json`` that no longer has it and records the SHA-256 of the
full bundle, and ``validate`` refuses a ``bundle.json`` that no longer has that. A repeated
``segment`` with an unchanged structure leaves ``bundle.json`` (and a finished bank) untouched.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from app.workflow.bundle import (
    assemble_bundle,
    bundle_sha256,
    dumps_bundle,
    loads_bundle,
    structure_of,
    structure_sha256,
    with_bank,
)
from app.workflow.content_management import (
    hadith_pass_records,
    quran_object_name,
)
from app.workflow.editions import EditionScope, edition_spec
from app.workflow.errors import (
    InputError,
    ObjectNotFoundError,
    PreconditionError,
    ValidationFailedError,
)
from app.workflow.jobs import JobRepository
from app.workflow.labels import load_labels
from app.workflow.lesson_question_builder import build_question_bank
from app.workflow.models import ContentJob, RawObject, canonical_json, sha256_hex
from app.workflow.paths import BuildPaths
from app.workflow.publish_sql import generate_publish_sql
from app.workflow.reports import render_edition_report, write_text
from app.workflow.runner import StepHandler, StepOutcome
from app.workflow.segmentation import load_boundaries, segment_hadith, segment_quran
from app.workflow.storage import RawStorage
from app.workflow.validation import originals_from_objects, validate_bank, validate_edition

Clock = Callable[[], datetime]


def _prior(jobs: JobRepository, key: str, bank: int, step: str) -> ContentJob:
    job = jobs.get_job(key, bank, step)
    if job is None or job.status != "succeeded" or not job.cursor:
        raise PreconditionError(f"the {step!r} step has no recorded result")
    return job


def _read_bundle(paths: BuildPaths, key: str) -> dict[str, Any]:
    path = paths.bundle_json(key)
    if not path.is_file():
        raise PreconditionError("bundle.json is missing; run segment first")
    try:
        return loads_bundle(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        raise InputError("bundle.json cannot be read") from None


def _write_outputs(
    paths: BuildPaths,
    bundle: Mapping[str, Any],
    jobs: JobRepository,
    current: ContentJob,
    *,
    validation: Mapping[str, Any] | None,
    skipped: Sequence[Mapping[str, str]],
    now: datetime,
    write_bundle: bool,
) -> None:
    """Write ``bundle.json`` (optionally), ``publish.sql`` and ``report.md``."""
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    if write_bundle:
        write_text(paths.bundle_json(key), dumps_bundle(bundle))
    rows = {job.step: job for job in jobs.list_jobs(key, bank)}
    rows[current.step] = current
    review: dict[str, Any] = {}
    for step in ("acquired", "verified"):
        row = rows.get(step)
        entry = (row.validation_summary or {}).get("reviewRecordEntry") if row else None
        if entry:
            review.update(entry)
    write_text(
        paths.publish_sql(key),
        generate_publish_sql(bundle, list(rows.values()), review_entries=review),
    )
    write_text(
        paths.report_md(key),
        render_edition_report(bundle, validation=validation, skipped=skipped, generated_at=now),
    )


def _inflight(
    job: ContentJob, cursor: dict[str, Any], summary: dict[str, Any], digest: str, now: datetime
) -> ContentJob:
    """The row the runner is about to save, for ``publish.sql`` (job rows)."""
    return job.model_copy(
        update={
            "status": "succeeded",
            "cursor": cursor,
            "validation_summary": {**summary, "digest": digest},
            "updated_at": now,
        }
    )


def _counts(bundle: Mapping[str, Any]) -> dict[str, int]:
    units = bundle["units"]
    return {
        "sections": len(bundle["sections"]),
        "units": len(units),
        "words": sum(1 for u in units for t in u["tokens"] if t["k"] == "word"),
        "passages": len(bundle["passages"]),
        "parts": sum(len(p["parts"]) for p in bundle["passages"]),
    }


def make_segment_handler(
    *,
    edition_key: str,
    bank_version: int,
    jobs: JobRepository,
    storage: RawStorage,
    paths: BuildPaths,
    labels_path: Path | None,
    boundaries_path: Path | None,
    clock: Clock,
) -> StepHandler:
    """Handler of the ``segmented`` step: verified units only, gaps left out."""
    spec = edition_spec(edition_key)

    def handler(job: ContentJob) -> StepOutcome:
        acquired = _prior(jobs, edition_key, bank_version, "acquired")
        verified = _prior(jobs, edition_key, bank_version, "verified")
        scope = EditionScope.from_dict(acquired.cursor["scope"])  # type: ignore[index]
        verified_summary = verified.validation_summary or {}
        gaps = list(verified_summary.get("gaps", []))
        labels = load_labels(edition_key, labels_path)
        if spec.kind == "quran":
            records = {
                surah: RawObject.from_bytes(
                    storage.read_raw(edition_key, quran_object_name(bank_version, surah))
                ).quran_records()
                for surah in scope.surahs
            }
            segment = segment_quran(
                edition_key=edition_key,
                bank_version=bank_version,
                records_by_surah=records,
                surahs=scope.surahs,
                labels=labels,
            )
        else:
            gap_numbers = {g["fortyNumber"] for g in gaps}
            pass1 = hadith_pass_records(storage, edition_key, bank_version, 1)
            numbers = [n for n in scope.forty_numbers if n not in gap_numbers]
            if not numbers or any(n not in pass1 for n in numbers):
                raise ObjectNotFoundError("a verified hadith record is missing from storage")
            segment = segment_hadith(
                edition_key=edition_key,
                bank_version=bank_version,
                records=pass1,
                numbers=numbers,
                labels=labels,
                boundaries=load_boundaries(boundaries_path),
            )
        bundle = assemble_bundle(
            spec=spec,
            bank_version=bank_version,
            labels=labels,
            segment=segment,
            provenance=(acquired.validation_summary or {})["source"],
            verification=verified_summary["verification"],
            known_gaps=gaps,
            suspected=list(verified_summary.get("suspectedErrors", [])),
        )
        digest = structure_sha256(bundle)
        keep = None
        path = paths.bundle_json(edition_key)
        if path.is_file():
            existing = _read_bundle(paths, edition_key)
            if structure_sha256(existing) == digest:
                keep = existing  # an unchanged structure keeps a finished bank
        counts = _counts(bundle)
        cursor = {"scope": scope.to_dict(), "structureSha256": digest}
        summary = {
            "scope": scope.to_dict(),
            "structureSha256": digest,
            "contentHash": bundle["edition"]["contentHash"],
            "counts": counts,
            "passagesByPath": dict(Counter(p["path"] for p in bundle["passages"])),
            "suspectedErrors": segment.suspected,
        }
        now = clock()
        if keep is None:  # an unchanged structure leaves bundle.json, publish.sql, report.md
            _write_outputs(
                paths,
                bundle,
                jobs,
                _inflight(job, cursor, summary, digest, now),
                validation=None,
                skipped=[],
                now=now,
                write_bundle=True,
            )
        return StepOutcome(
            "succeeded", cursor=cursor, summary=summary, digest=digest, counts=counts
        )

    return handler


def make_build_bank_handler(
    *,
    edition_key: str,
    bank_version: int,
    jobs: JobRepository,
    paths: BuildPaths,
    clock: Clock,
) -> StepHandler:
    """Handler of the ``bank_built`` step: lessons and the four question templates."""

    def handler(job: ContentJob) -> StepOutcome:
        segmented = _prior(jobs, edition_key, bank_version, "segmented")
        bundle = _read_bundle(paths, edition_key)
        recorded = segmented.cursor["structureSha256"]  # type: ignore[index]
        if structure_sha256(bundle) != recorded:
            raise PreconditionError(
                "bundle.json no longer has the structure recorded by segment; run segment again"
            )
        result = build_question_bank(structure_of(bundle))
        full = with_bank(bundle, result.lessons, result.questions)
        digest = bundle_sha256(full)
        counts = {
            "lessons": len(result.lessons),
            "questions": len(result.questions),
            "skipped": len(result.skipped),
        }
        by_type = Counter(
            q["type"] + (f"/{q['variant']}" if q["variant"] else "") for q in result.questions
        )
        cursor = {"structureSha256": recorded, "bundleSha256": digest}
        summary = {
            "structureSha256": recorded,
            "bundleSha256": digest,
            "counts": counts,
            "questionsByType": dict(sorted(by_type.items())),
            "skipped": result.skipped,
        }
        now = clock()
        _write_outputs(
            paths,
            full,
            jobs,
            _inflight(job, cursor, summary, digest, now),
            validation=None,
            skipped=result.skipped,
            now=now,
            write_bundle=True,
        )
        return StepOutcome(
            "succeeded", cursor=cursor, summary=summary, digest=digest, counts=counts
        )

    return handler


def make_validate_handler(
    *,
    edition_key: str,
    bank_version: int,
    jobs: JobRepository,
    storage: RawStorage,
    paths: BuildPaths,
    clock: Clock,
) -> StepHandler:
    """Handler of the ``validated`` step. Fails closed: any issue fails the step."""

    def handler(job: ContentJob) -> StepOutcome:
        acquired = _prior(jobs, edition_key, bank_version, "acquired")
        built = _prior(jobs, edition_key, bank_version, "bank_built")
        bundle = _read_bundle(paths, edition_key)
        recorded = built.cursor["bundleSha256"]  # type: ignore[index]
        if bundle_sha256(bundle) != recorded:
            raise PreconditionError(
                "bundle.json no longer is the bundle built by build-bank; run build-bank again"
            )
        scope = EditionScope.from_dict(acquired.cursor["scope"])  # type: ignore[index]
        objects = [
            RawObject.from_bytes(storage.read_raw(edition_key, name))
            for name in sorted(acquired.cursor["objects"])  # type: ignore[index]
        ]
        originals = originals_from_objects(objects, edition_key)
        edition_report = validate_edition(bundle, originals=originals, scope=scope)
        bank_report = validate_bank(bundle)
        issues = [
            {"code": issue.code, "ref": issue.ref}
            for issue in (*edition_report.issues, *bank_report.issues)
        ]
        validation = {
            "result": "passed" if not issues else "failed",
            "issues": issues,
            "info": {**edition_report.info, **bank_report.info},
        }
        counts = {
            "issues": len(issues),
            "questions": len(bundle["questions"]),
            "parts": bank_report.info["parts"],
            "parts_covered": bank_report.info["parts_covered"],
        }
        digest = sha256_hex(
            canonical_json({"bundleSha256": recorded, "issues": issues, "info": validation["info"]})
        )
        cursor = {"bundleSha256": recorded}
        summary = {
            "bundleSha256": recorded,
            "validation": {**validation, "issues": issues[:200]},
            "counts": counts,
        }
        now = clock()
        _write_outputs(
            paths,
            bundle,
            jobs,
            _inflight(job, cursor, summary, digest, now),
            validation=validation,
            skipped=(built.validation_summary or {}).get("skipped", []),
            now=now,
            write_bundle=False,
        )
        if issues:
            raise ValidationFailedError(
                f"validation failed: {len(issues)} issue(s) (see report.md)",
                cursor=cursor,
                summary=summary,
            )
        return StepOutcome(
            "succeeded", cursor=cursor, summary=summary, digest=digest, counts=counts
        )

    return handler
