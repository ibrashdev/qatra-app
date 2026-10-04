"""Job repository (content_jobs fields and cursor) and the resumable idempotent runner."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.domain.content_policy import StepOrderError
from app.workflow.errors import (
    InputError,
    NotConfiguredError,
    ObjectConflictError,
    SourceUnreachableError,
    StepFailure,
    StepNotImplementedError,
)
from app.workflow.jobs import (
    PIPELINE_VERSION,
    InMemoryJobRepository,
    JobRepository,
    LocalJobRepository,
    SupabaseJobRepository,
    completed_steps,
    new_job,
)
from app.workflow.models import ContentJob
from app.workflow.paths import BuildPaths
from app.workflow.runner import StepOutcome, run_content_job
from app.workflow.settings import SupabaseConfig

EDITION = "quran-hafs-quranenc"
T0 = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        self.now += timedelta(minutes=1)
        return self.now


def ok(digest: str = "d1", cursor: dict[str, Any] | None = None, **summary: Any) -> Any:
    def handler(job: ContentJob) -> StepOutcome:
        return StepOutcome(
            "succeeded",
            cursor=cursor,
            summary=summary or {"note": "ok"},
            digest=digest,
            counts={"n": 1},
        )

    return handler


def repositories(tmp_path: Path) -> list[JobRepository]:
    return [InMemoryJobRepository(), LocalJobRepository(BuildPaths(tmp_path))]


@pytest.fixture(params=["memory", "local"])
def repo(request: pytest.FixtureRequest, tmp_path: Path) -> JobRepository:
    return (
        InMemoryJobRepository()
        if request.param == "memory"
        else LocalJobRepository(BuildPaths(tmp_path))
    )


def test_repository_round_trip(repo: JobRepository) -> None:
    job = new_job(EDITION, 1, "acquired", now=T0).model_copy(
        update={"status": "running", "cursor": {"surahs": [112]}, "validation_summary": {"a": 1}}
    )
    repo.save_job(job)
    assert repo.get_job(EDITION, 1, "acquired") == job
    assert repo.get_job(EDITION, 2, "acquired") is None
    assert repo.get_job(EDITION, 1, "verified") is None
    assert repo.list_jobs(EDITION, 1) == [job]
    updated = job.model_copy(update={"status": "succeeded"})
    repo.save_job(updated)  # same (edition, bank version, step): replaced, not duplicated
    assert repo.list_jobs(EDITION, 1) == [updated]
    repo.save_job(new_job(EDITION, 1, "verified", now=T0))
    repo.save_job(new_job(EDITION, 2, "acquired", now=T0))
    assert [j.step for j in repo.list_jobs(EDITION, 1)] == ["acquired", "verified"]
    assert [j.bank_version for j in repo.list_jobs(EDITION, 2)] == [2]


def test_local_repository_writes_content_jobs_fields_and_cursor(tmp_path: Path) -> None:
    repo = LocalJobRepository(BuildPaths(tmp_path))
    repo.save_job(
        new_job(EDITION, 1, "acquired", now=T0).model_copy(
            update={"cursor": {"objects": {"a": "b"}}}
        )
    )
    path = tmp_path / EDITION / "jobs.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["editionKey"] == EDITION and data["formatVersion"] == 1
    (row,) = data["jobs"]
    assert set(row) == {
        "id",
        "edition_id",
        "edition_key",
        "bank_version",
        "pipeline_version",
        "step",
        "cursor",
        "status",
        "validation_summary",
        "published_at",
        "created_at",
        "updated_at",
    }
    assert row["pipeline_version"] == PIPELINE_VERSION and row["status"] == "pending"
    assert row["cursor"] == {"objects": {"a": "b"}}
    assert list(tmp_path.glob("**/.tmp-*")) == []  # atomic write left nothing behind


def test_local_repository_survives_a_new_process_instance(tmp_path: Path) -> None:
    LocalJobRepository(BuildPaths(tmp_path)).save_job(new_job(EDITION, 1, "acquired", now=T0))
    again = LocalJobRepository(BuildPaths(tmp_path))
    assert again.get_job(EDITION, 1, "acquired") is not None


def test_malformed_jobs_file_is_an_input_error(tmp_path: Path) -> None:
    path = tmp_path / EDITION / "jobs.json"
    path.parent.mkdir(parents=True)
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(InputError):
        LocalJobRepository(BuildPaths(tmp_path)).list_jobs(EDITION, 1)


def test_supabase_repository_is_a_stub() -> None:
    with pytest.raises(NotConfiguredError):
        SupabaseJobRepository(None)
    with pytest.raises(NotConfiguredError, match="not available in B7"):
        SupabaseJobRepository(SupabaseConfig(url="https://p.example", service_role_key="k"))


def test_completed_steps_counts_only_succeeded_rows() -> None:
    rows = [
        new_job(EDITION, 1, "acquired", now=T0, status="succeeded"),
        new_job(EDITION, 1, "verified", now=T0, status="failed"),
        new_job(EDITION, 1, "page_mapped", now=T0, status="skipped"),
        new_job(EDITION, 1, "segmented", now=T0, status="running"),
    ]
    assert completed_steps(rows) == ("acquired",)


# --- runner --------------------------------------------------------------------------------


def test_runner_runs_a_step_and_records_the_row(repo: JobRepository) -> None:
    result = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok(cursor={"k": 1})}, clock=Clock()
    )
    assert (result.step, result.status, result.changed, result.resumed) == (
        "acquired",
        "succeeded",
        True,
        False,
    )
    assert result.counts == {"n": 1}
    row = repo.get_job(EDITION, 1, "acquired")
    assert row is not None and row.status == "succeeded" and row.cursor == {"k": 1}
    assert row.validation_summary == {"note": "ok", "digest": "d1"}
    assert row.pipeline_version == PIPELINE_VERSION


def test_runner_records_skipped_steps_for_web_editions(repo: JobRepository) -> None:
    run_content_job(EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok()}, clock=Clock())
    for step in ("page_mapped", "embedded"):
        row = repo.get_job(EDITION, 1, step)
        assert row is not None and row.status == "skipped"
        assert "D68" in row.validation_summary["reason"]  # type: ignore[index]
    assert completed_steps(repo.list_jobs(EDITION, 1)) == ("acquired",)


def test_runner_enforces_step_order_before_anything_else(repo: JobRepository) -> None:
    called: list[str] = []

    def handler(job: ContentJob) -> StepOutcome:
        called.append(job.step)
        return StepOutcome("succeeded")

    with pytest.raises(StepOrderError):
        run_content_job(
            EDITION, 1, "verified", jobs=repo, handlers={"verified": handler}, clock=Clock()
        )
    assert called == [] and repo.list_jobs(EDITION, 1) == []


def test_step_without_a_handler_is_not_implemented_and_changes_nothing(repo: JobRepository) -> None:
    clock = Clock()
    run_content_job(EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok()}, clock=clock)
    run_content_job(EDITION, 1, "verified", jobs=repo, handlers={"verified": ok("v")}, clock=clock)
    before = repo.list_jobs(EDITION, 1)
    with pytest.raises(StepNotImplementedError, match="not implemented in B7"):
        run_content_job(EDITION, 1, "segmented", jobs=repo, handlers={}, clock=clock)
    assert repo.list_jobs(EDITION, 1) == before


def test_identical_rerun_changes_nothing(repo: JobRepository) -> None:
    clock = Clock()
    first = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok("same")}, clock=clock
    )
    run_content_job(EDITION, 1, "verified", jobs=repo, handlers={"verified": ok("v")}, clock=clock)
    snapshot = repo.list_jobs(EDITION, 1)
    again = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok("same")}, clock=clock
    )
    assert again.changed is False and again.status == "succeeded"
    assert repo.list_jobs(EDITION, 1) == snapshot  # no new rows, no timestamps touched, verify kept
    assert first.job.id == again.job.id


def test_changed_rerun_resets_every_later_step(repo: JobRepository) -> None:
    clock = Clock()
    for step in ("acquired", "verified", "segmented"):
        run_content_job(EDITION, 1, step, jobs=repo, handlers={step: ok(step)}, clock=clock)
    assert completed_steps(repo.list_jobs(EDITION, 1)) == ("acquired", "verified", "segmented")
    result = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok("new")}, clock=clock
    )
    assert result.changed
    assert completed_steps(repo.list_jobs(EDITION, 1)) == ("acquired",)
    for step in ("verified", "segmented"):
        row = repo.get_job(EDITION, 1, step)
        assert row is not None and row.status == "pending"
        assert row.cursor is None and row.validation_summary is None


def test_partial_progress_is_kept_as_running_and_resumed_from_the_cursor(
    repo: JobRepository,
) -> None:
    clock = Clock()
    seen: list[dict[str, Any] | None] = []

    def first(job: ContentJob) -> StepOutcome:
        seen.append(job.cursor)
        return StepOutcome("running", cursor={"done": ["a"]}, digest="p1", counts={"n": 1})

    def second(job: ContentJob) -> StepOutcome:
        seen.append(job.cursor)
        return StepOutcome("succeeded", cursor={"done": ["a", "b"]}, digest="p2", counts={"n": 2})

    one = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": first}, clock=clock
    )
    assert one.status == "running" and not one.resumed
    assert completed_steps(repo.list_jobs(EDITION, 1)) == ()
    with pytest.raises(StepOrderError):  # a running step does not unlock the next one
        run_content_job(EDITION, 1, "verified", jobs=repo, handlers={"verified": ok()}, clock=clock)
    two = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": second}, clock=clock
    )
    assert two.status == "succeeded" and two.resumed
    assert seen == [None, {"done": ["a"]}]
    assert completed_steps(repo.list_jobs(EDITION, 1)) == ("acquired",)


def test_step_failure_records_failed_step_and_cursor_and_resets_later_steps(
    repo: JobRepository,
) -> None:
    clock = Clock()
    for step in ("acquired", "verified"):
        run_content_job(EDITION, 1, step, jobs=repo, handlers={step: ok(step)}, clock=clock)

    def failing(job: ContentJob) -> StepOutcome:
        raise StepFailure("boom", cursor={"at": 3}, summary={"blocked": ["112:2"]})

    with pytest.raises(StepFailure):
        run_content_job(
            EDITION, 1, "acquired", jobs=repo, handlers={"acquired": failing}, clock=clock
        )
    acquired = repo.get_job(EDITION, 1, "acquired")
    assert acquired is not None and acquired.status == "failed"
    assert acquired.cursor == {"at": 3} and acquired.validation_summary == {"blocked": ["112:2"]}
    verified = repo.get_job(EDITION, 1, "verified")
    assert verified is not None and verified.status == "pending"
    assert completed_steps(repo.list_jobs(EDITION, 1)) == ()


def test_failed_step_resumes_with_its_recorded_cursor(repo: JobRepository) -> None:
    clock = Clock()
    seen: list[Any] = []

    def failing(job: ContentJob) -> StepOutcome:
        raise StepFailure("interrupted", cursor={"stored": 2})

    def resume(job: ContentJob) -> StepOutcome:
        seen.append(job.cursor)
        return StepOutcome("succeeded", cursor=job.cursor, digest="r")

    with pytest.raises(StepFailure):
        run_content_job(
            EDITION, 1, "acquired", jobs=repo, handlers={"acquired": failing}, clock=clock
        )
    result = run_content_job(
        EDITION, 1, "acquired", jobs=repo, handlers={"acquired": resume}, clock=clock
    )
    assert result.resumed and seen == [{"stored": 2}]


def test_unexpected_exception_is_recorded_by_type_only(repo: JobRepository) -> None:
    def crash(job: ContentJob) -> StepOutcome:
        raise ValueError("message with source text must not be stored")

    with pytest.raises(ValueError):
        run_content_job(
            EDITION, 1, "acquired", jobs=repo, handlers={"acquired": crash}, clock=Clock()
        )
    row = repo.get_job(EDITION, 1, "acquired")
    assert row is not None and row.status == "failed"
    assert row.validation_summary == {"error": "ValueError"}


@pytest.mark.parametrize(
    "error",
    [
        InputError("x"),
        ObjectConflictError("x"),
        NotConfiguredError("x"),
        SourceUnreachableError("x"),
    ],
)
def test_refusals_leave_every_row_untouched(repo: JobRepository, error: Exception) -> None:
    clock = Clock()
    run_content_job(EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok("a")}, clock=clock)
    before = repo.list_jobs(EDITION, 1)

    def refuse(job: ContentJob) -> StepOutcome:
        raise error

    with pytest.raises(type(error)):
        run_content_job(
            EDITION, 1, "acquired", jobs=repo, handlers={"acquired": refuse}, clock=clock
        )
    assert repo.list_jobs(EDITION, 1) == before


def test_runner_rejects_bad_keys_and_versions(repo: JobRepository) -> None:
    with pytest.raises(InputError):
        run_content_job("unknown", 1, "acquired", jobs=repo, handlers={}, clock=Clock())
    with pytest.raises(InputError):
        run_content_job(EDITION, 0, "acquired", jobs=repo, handlers={}, clock=Clock())


def test_published_version_cannot_be_rerun(repo: JobRepository) -> None:
    for step in (
        "acquired",
        "verified",
        "segmented",
        "bank_built",
        "validated",
        "approved",
        "published",
    ):
        repo.save_job(new_job(EDITION, 1, step, now=T0, status="succeeded"))
    with pytest.raises(StepOrderError):
        run_content_job(
            EDITION, 1, "acquired", jobs=repo, handlers={"acquired": ok()}, clock=Clock()
        )
    # a different bank version is independent
    result = run_content_job(
        EDITION, 2, "acquired", jobs=repo, handlers={"acquired": ok()}, clock=Clock()
    )
    assert result.status == "succeeded"
