"""``publish --sql-out``: one transactional SQL file, nothing applied (API-spec §5.3, D83 session).

``publish`` has no database to write to in this build (there is no ``service_role`` key in the
build environment), so it writes ONE SQL file below the gitignored build directory and applies
nothing. The file holds, in a single transaction: the draft upserts, the recorded license, the
review record with the acquisition, verification and approval entries, the publishing statements
(lessons and question items published, earlier editions of the book superseded, the edition
published) and the ``content_jobs`` rows including ``approved`` and ``published`` with
``published_at``.

It refuses unless ``content_policy.assert_publishable`` passes (the CLI calls it first) and the
bundle on disk is exactly the one that ``validate`` accepted and the approval covers. The local
job rows are not changed: ``published`` exists in the file, and in the database once the file is
applied. Raw objects stay in the gitignored build area with their hashes in the summaries; the
private bucket upload is deferred. The file contains source text: never commit it.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from app.workflow.bundle import bundle_sha256, loads_bundle
from app.workflow.errors import InputError, PreconditionError
from app.workflow.jobs import JobRepository
from app.workflow.models import ContentJob, sha256_hex
from app.workflow.paths import BuildPaths
from app.workflow.publish_sql import FINAL_MARKER, generate_final_publish_sql

BUCKET_NOTE: Final = "bucket upload deferred: no service_role key in the build environment"
_REVIEW_STEPS: Final = ("acquired", "verified", "approved")


@dataclass(frozen=True, slots=True)
class FinalPublication:
    """The generated file text and what the CLI prints about it (counts, ids, hashes)."""

    sql: str
    sql_sha256: str
    counts: dict[str, int]
    summary: dict[str, Any]


def resolve_sql_out(path: Path, build_root: Path) -> Path:
    """The output path, which must lie below the build directory (the file holds source text)."""
    root = Path(build_root).resolve()
    target = Path(path).resolve()
    if target == root or root not in target.parents:
        raise InputError("--sql-out must be a file below the build directory (gitignored)")
    if target.is_dir():
        raise InputError("--sql-out is a directory; give a file name")
    return target


def _row(rows: Mapping[str, ContentJob], step: str) -> ContentJob:
    row = rows.get(step)
    if row is None or row.status != "succeeded" or not row.cursor:
        raise PreconditionError(f"the {step!r} step has no recorded result")
    return row


def build_final_publication(
    *,
    edition_key: str,
    bank_version: int,
    jobs: JobRepository,
    paths: BuildPaths,
    approval: Mapping[str, Any],
    license_record: Mapping[str, Any],
) -> FinalPublication:
    """Generate the final file text. ``approval`` and ``license_record`` have passed the
    publishing policy; this checks that the bundle is the validated, approved one."""
    rows = {job.step: job for job in jobs.list_jobs(edition_key, bank_version)}
    validated, approved, acquired = (
        _row(rows, "validated"),
        _row(rows, "approved"),
        _row(rows, "acquired"),
    )
    path = paths.bundle_json(edition_key)
    try:
        bundle = loads_bundle(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        raise PreconditionError("bundle.json cannot be read; run the earlier steps") from None
    digest = bundle_sha256(bundle)
    recorded = validated.cursor["bundleSha256"]  # type: ignore[index]
    if digest != recorded or approved.cursor["bundleSha256"] != recorded:  # type: ignore[index]
        raise PreconditionError(
            "bundle.json is not the bundle that validate accepted and the approval covers; "
            "run validate and approve again"
        )
    review_entries: dict[str, Any] = {}
    for step in _REVIEW_STEPS:
        row = rows.get(step)
        entry = (row.validation_summary or {}).get("reviewRecordEntry") if row else None
        if entry:
            review_entries.update(entry)
    counts = {
        "sections": len(bundle["sections"]),
        "units": len(bundle["units"]),
        "passages": len(bundle["passages"]),
        "parts": sum(len(p["parts"]) for p in bundle["passages"]),
        "lessons": len(bundle["lessons"]),
        "questions": len(bundle["questions"]),
    }
    raw_objects: dict[str, str] = dict((acquired.cursor or {}).get("objects", {}))
    summary: dict[str, Any] = {
        "mode": "sql_file",
        "bundleSha256": digest,
        "contentHash": bundle["edition"]["contentHash"],
        "counts": counts,
        "approval": {key: approval[key] for key in ("who", "at", "source")},
        "bucketUpload": BUCKET_NOTE,
        "rawObjects": {"count": len(raw_objects), "sha256": raw_objects},
    }
    ordered = [rows[step] for step in rows if step != "published"]
    sql = generate_final_publish_sql(
        bundle,
        ordered,
        review_entries=review_entries,
        license_record=license_record,
        published_summary=summary,
    )
    counts["job_rows"] = len(ordered) + 1
    return FinalPublication(sql, sha256_hex(sql.encode("utf-8")), counts, summary)


def write_sql_file(target: Path, sql: str) -> bool:
    """Write the file atomically. Returns False when it already holds exactly this text.

    A file that does not start with the final-file marker is never replaced (it could be the
    draft ``publish.sql`` or something else)."""
    data = sql.encode("utf-8")
    if target.exists():
        existing = target.read_bytes()
        if existing == data:
            return False
        if not existing.startswith(FINAL_MARKER.encode("utf-8")):
            raise PreconditionError(
                "--sql-out names an existing file that is not a final publish file; "
                "choose another name"
            )
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(handle, "wb") as tmp:
            tmp.write(data)
        os.replace(tmp_name, target)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    return True
