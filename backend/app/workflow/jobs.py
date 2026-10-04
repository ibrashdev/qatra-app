"""Job repository: the ``content_jobs`` rows and their cursor (Database-schema §6.1).

One row per ``(edition, bank_version, step)``. ``LocalJobRepository`` keeps them in
``backend/.content-build/<editionKey>/jobs.json`` (memory mode; gitignored). The Supabase
``content_jobs`` table repository lands after B1 is accepted and G5: ``SupabaseJobRepository``
is a stub that raises ``NotConfiguredError``.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol
from uuid import NAMESPACE_URL, UUID, uuid5

from app.domain.content_policy import STEP_VOCABULARY
from app.workflow.errors import InputError, NotConfiguredError
from app.workflow.models import ContentJob, JobStatus
from app.workflow.paths import BuildPaths
from app.workflow.settings import SupabaseConfig

PIPELINE_VERSION = "b7-0.1"
_JOB_NAMESPACE = uuid5(NAMESPACE_URL, "https://qatra.invalid/content-jobs")
_FORMAT_VERSION = 1


def job_id(edition_key: str, bank_version: int, step: str) -> UUID:
    """Deterministic local row id (the table's ``gen_random_uuid()`` default is not needed)."""
    return uuid5(_JOB_NAMESPACE, f"{edition_key}|{bank_version}|{step}")


def new_job(
    edition_key: str,
    bank_version: int,
    step: str,
    *,
    now: datetime,
    status: JobStatus = "pending",
    pipeline_version: str = PIPELINE_VERSION,
) -> ContentJob:
    return ContentJob(
        id=job_id(edition_key, bank_version, step),
        edition_key=edition_key,
        bank_version=bank_version,
        pipeline_version=pipeline_version,
        step=step,
        status=status,
        created_at=now,
        updated_at=now,
    )


def completed_steps(jobs: Iterable[ContentJob]) -> tuple[str, ...]:
    """Steps whose row is ``succeeded`` (the input of ``assert_step_allowed``)."""
    return tuple(job.step for job in jobs if job.status == "succeeded")


class JobRepository(Protocol):
    """Persistence of ``content_jobs`` rows keyed by ``(edition, bank_version, step)``."""

    def list_jobs(self, edition_key: str, bank_version: int) -> list[ContentJob]: ...

    def get_job(self, edition_key: str, bank_version: int, step: str) -> ContentJob | None: ...

    def save_job(self, job: ContentJob) -> None:
        """Insert or replace the row for the job's ``(edition, bank_version, step)``."""
        ...


def _sort_key(job: ContentJob) -> tuple[int, int]:
    return job.bank_version, STEP_VOCABULARY.index(job.step)


class InMemoryJobRepository:
    """Process-memory repository (unit tests)."""

    def __init__(self) -> None:
        self._rows: dict[tuple[str, int, str], ContentJob] = {}

    def list_jobs(self, edition_key: str, bank_version: int) -> list[ContentJob]:
        rows = [j for (e, b, _), j in self._rows.items() if e == edition_key and b == bank_version]
        return sorted((j.model_copy(deep=True) for j in rows), key=_sort_key)

    def get_job(self, edition_key: str, bank_version: int, step: str) -> ContentJob | None:
        job = self._rows.get((edition_key, bank_version, step))
        return job.model_copy(deep=True) if job else None

    def save_job(self, job: ContentJob) -> None:
        self._rows[(job.edition_key, job.bank_version, job.step)] = job.model_copy(deep=True)


class LocalJobRepository:
    """``<build>/<editionKey>/jobs.json`` with the ``content_jobs`` fields and the cursor.

    Writes are atomic (temp file + rename). There is no cross-process lock: the CLI is run by
    one operator at a time (D48).
    """

    def __init__(self, paths: BuildPaths) -> None:
        self._paths = paths

    def _load(self, edition_key: str) -> list[ContentJob]:
        path = self._paths.jobs_file(edition_key)
        if not path.is_file():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return [ContentJob.model_validate(item) for item in data["jobs"]]
        except (ValueError, KeyError, TypeError):
            raise InputError("jobs.json is malformed; fix or remove it before continuing") from None

    def _store(self, edition_key: str, jobs: list[ContentJob]) -> None:
        path = self._paths.jobs_file(edition_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {
            "formatVersion": _FORMAT_VERSION,
            "editionKey": edition_key,
            "jobs": [job.model_dump(mode="json") for job in sorted(jobs, key=_sort_key)],
        }
        handle, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as tmp:
                json.dump(payload, tmp, ensure_ascii=False, indent=2, sort_keys=True)
                tmp.write("\n")
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise

    def list_jobs(self, edition_key: str, bank_version: int) -> list[ContentJob]:
        return sorted(
            (j for j in self._load(edition_key) if j.bank_version == bank_version), key=_sort_key
        )

    def get_job(self, edition_key: str, bank_version: int, step: str) -> ContentJob | None:
        for job in self._load(edition_key):
            if job.bank_version == bank_version and job.step == step:
                return job
        return None

    def save_job(self, job: ContentJob) -> None:
        rows = [
            j
            for j in self._load(job.edition_key)
            if not (j.bank_version == job.bank_version and j.step == job.step)
        ]
        rows.append(job)
        self._store(job.edition_key, rows)


class SupabaseJobRepository:
    """Stub: the ``content_jobs`` table repository is not part of B7 (after B1 and G5)."""

    def __init__(self, config: SupabaseConfig | None) -> None:
        if config is None:
            raise NotConfiguredError(
                "Supabase content_jobs needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
            )
        raise NotConfiguredError(
            "the Supabase content_jobs repository is not available in B7 (after B1 and G5)"
        )

    def list_jobs(self, edition_key: str, bank_version: int) -> list[ContentJob]:
        raise NotConfiguredError("the Supabase content_jobs repository is not available in B7")

    def get_job(self, edition_key: str, bank_version: int, step: str) -> ContentJob | None:
        raise NotConfiguredError("the Supabase content_jobs repository is not available in B7")

    def save_job(self, job: ContentJob) -> None:
        raise NotConfiguredError("the Supabase content_jobs repository is not available in B7")
