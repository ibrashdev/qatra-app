"""``ContentAdminService`` over the in-memory repository: every endpoint's logic, the optimistic
concurrency of spec section 3, the withdraw sequence of section 5, the AI status of section 7."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from app.contracts_content_admin import (
    ExpectedVersionRequest,
    PatchBookRequest,
    PatchCategoryRequest,
    PatchEditionRequest,
    PatchSectionRequest,
    PatchSourceRequest,
    WithdrawEditionRequest,
)
from app.errors import AppError, ErrorCode
from app.repositories.ai_usage import InMemoryUsageLedger, UsageRecord
from app.repositories.content_admin import MemoryContentAdminRepository
from app.services.content_admin import ContentAdminService
from tests.content_admin.support import (
    APPROVAL,
    IDS,
    NOW,
    FakeClock,
    seed_catalog,
    stamp_of,
    uid,
)
from tests.support import make_settings

FAKE_KEY = "sk-or-synthetic-test-key-123"


class Recording:
    """Wraps a repository and records the order of the calls that change something."""

    def __init__(self, inner: MemoryContentAdminRepository) -> None:
        self.inner = inner
        self.calls: list[tuple[str, str]] = []

    def __getattr__(self, name: str) -> Any:
        target = getattr(self.inner, name)
        if name not in {"update", "delete", "redact_revoked_content", "upsert_job"}:
            return target

        def call(*args: Any, **kwargs: Any) -> Any:
            detail = kwargs.get("step") or (args[0] if args else "")
            self.calls.append((name, str(detail)))
            return target(*args, **kwargs)

        return call


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def repo(clock: FakeClock) -> MemoryContentAdminRepository:
    memory = MemoryContentAdminRepository(clock=clock)
    seed_catalog(memory)
    return memory


@pytest.fixture
def make_service(
    repo: MemoryContentAdminRepository, clock: FakeClock
) -> Callable[..., ContentAdminService]:
    def build(**settings: Any) -> ContentAdminService:
        return ContentAdminService(make_settings(**settings), repo, clock=clock)

    return build


@pytest.fixture
def service(make_service: Callable[..., ContentAdminService]) -> ContentAdminService:
    return make_service()


def stamp(repo: MemoryContentAdminRepository, table: str, row_id: UUID) -> str:
    row = repo.get(table, row_id)
    assert row is not None
    return stamp_of(row)


def expected(
    repo: MemoryContentAdminRepository, table: str, row_id: UUID
) -> ExpectedVersionRequest:
    return ExpectedVersionRequest.model_validate({"expectedUpdatedAt": stamp(repo, table, row_id)})


def patch_of(
    model: type, repo: MemoryContentAdminRepository, table: str, row_id: UUID, **fields: Any
) -> Any:
    payload = {"expectedUpdatedAt": stamp(repo, table, row_id), **fields}
    return model.model_validate(payload)


def withdraw_body(
    repo: MemoryContentAdminRepository, row_id: UUID = IDS.published, **fields: Any
) -> WithdrawEditionRequest:
    values = {"reason": "rights", "note": "synthetic withdrawal note", **fields}
    return patch_of(WithdrawEditionRequest, repo, "book_editions", row_id, **values)


def refused(error: AppError, code: ErrorCode, reason: str | None = None) -> None:
    assert error.code is code
    if reason is not None:
        assert error.details == {"reason": reason}


# --- overview -------------------------------------------------------------------------------------


def test_overview_counts_and_orders_the_editions(service: ContentAdminService) -> None:
    overview = service.overview()
    assert (overview.counts.categories, overview.counts.books, overview.counts.sources) == (2, 2, 2)
    assert overview.counts.editions.model_dump() == {
        "draft": 1,
        "validated": 0,
        "published": 1,
        "superseded": 0,
        "revoked": 0,
    }
    # same book: version descending
    assert [e.version for e in overview.editions] == [2, 1]
    first = overview.editions[1]
    assert first.id == IDS.published
    assert first.book.title_ar == "كتاب تجريبي" and first.book.title_en == "Demo book"
    assert first.status == "published" and first.catalog_hidden is False
    assert first.archived_at is None


def test_overview_orders_by_book_title_first(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    repo.insert(
        "books",
        {
            "id": uid(13),
            "category_id": IDS.category,
            "title_ar": "أول الكتب",
            "title_en": None,
            "author": "مؤلف",
            "content_format": "quran",
        },
    )
    repo.insert(
        "book_editions",
        {
            "id": uid(33),
            "book_id": uid(13),
            "source_id": IDS.source,
            "edition_key": "synthetic-edition-3",
            "edition_label": "label",
            "language": "ar",
            "version": 1,
            "bank_version": 1,
            "status": "validated",
            "catalog_hidden": False,
            "archived_at": None,
        },
    )
    editions = service.overview().editions
    assert editions[0].id == uid(33)
    assert [e.version for e in editions[1:]] == [2, 1]


def test_an_empty_catalog_gives_zero_counts_and_no_editions() -> None:
    empty = ContentAdminService(make_settings(), MemoryContentAdminRepository())
    overview = empty.overview()
    assert overview.counts.model_dump(by_alias=True) == {
        "categories": 0,
        "books": 0,
        "sources": 0,
        "editions": {"draft": 0, "validated": 0, "published": 0, "superseded": 0, "revoked": 0},
    }
    assert overview.editions == []


# --- AI status ------------------------------------------------------------------------------------


def test_ai_status_defaults(service: ContentAdminService) -> None:
    ai = service.ai_status()
    assert ai.model_dump(by_alias=True) == {
        "chatModelForLearners": False,
        "providerConfigured": False,
        "models": [],
        "dailyCap": 50,
        "usedToday": None,
        "usedLastMinute": None,
    }


def test_ai_status_reports_configuration_without_the_key(
    make_service: Callable[..., ContentAdminService],
) -> None:
    service = make_service(
        OPENROUTER_API_KEY=FAKE_KEY,
        OPENROUTER_MODELS=" model-a:free , ,model-b:free ",
        QATRA_CHAT_MODEL_FOR_LEARNERS=True,
        QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY=7,
    )
    ai = service.ai_status()
    assert ai.provider_configured is True and ai.chat_model_for_learners is True
    assert ai.models == ["model-a:free", "model-b:free"] and ai.daily_cap == 7
    assert FAKE_KEY not in service.overview().model_dump_json()
    assert FAKE_KEY not in repr(service)


def test_a_blank_key_is_not_configured(make_service: Callable[..., ContentAdminService]) -> None:
    assert make_service(OPENROUTER_API_KEY="   ").ai_status().provider_configured is False


def test_ai_status_reads_the_global_counters_of_the_ledger(
    repo: MemoryContentAdminRepository, clock: FakeClock
) -> None:
    ledger = InMemoryUsageLedger()
    for offset_sec, status in ((0, "succeeded"), (0, "failed"), (0, "rules_fallback")):
        ledger.record(
            UsageRecord(
                provider="synthetic",
                model="m",
                prompt_version="p",
                status=status,
                created_at=NOW.replace(second=offset_sec),
            ),
            account=uid(5),
        )
    ledger.record(
        UsageRecord(
            provider="synthetic",
            model="m",
            prompt_version="p",
            status="succeeded",
            created_at=datetime(2026, 10, 5, 8, 0, tzinfo=UTC),
        )
    )
    service = ContentAdminService(make_settings(), repo, clock=clock, usage_ledger=lambda: ledger)
    ai = service.ai_status()
    # rules_fallback rows do not count; the 08:00 request is today but not in the last minute
    assert (ai.used_today, ai.used_last_minute) == (3, 2)


def test_a_missing_ledger_gives_null_counters(
    repo: MemoryContentAdminRepository, clock: FakeClock
) -> None:
    service = ContentAdminService(make_settings(), repo, clock=clock, usage_ledger=lambda: None)
    assert service.ai_status().used_today is None


# --- edition detail -------------------------------------------------------------------------------


def test_edition_detail_of_a_published_edition(service: ContentAdminService) -> None:
    detail = service.edition_detail(IDS.published)
    dump = detail.model_dump(by_alias=True, mode="json")
    assert dump["editionKey"] == "synthetic-edition-1"
    assert dump["source"] == {
        "id": str(IDS.source),
        "title": "Synthetic source",
        "provider": "Synthetic provider",
        "rightsStatus": "owner_accepted_pending_verification",
    }
    assert dump["contentHash"] == "a" * 64
    assert dump["approval"] == {
        "who": APPROVAL["who"],
        "at": APPROVAL["at"],
        "scope": APPROVAL["scope"],
        "words": APPROVAL["words"],
        "source": APPROVAL["source"],
    }
    assert dump["withdrawal"] is None
    assert dump["counts"] == {
        "sections": 2,
        "units": 2,
        "passages": 1,
        "lessons": 1,
        "questions": 4,
    }
    assert [s["ordinal"] for s in dump["sections"]] == [1, 2]
    assert set(dump["sections"][0]) == {"id", "ordinal", "kind", "reference", "titleAr", "titleEn"}
    assert [(j["step"], j["status"]) for j in dump["jobs"]] == [
        ("approved", "succeeded"),
        ("published", "succeeded"),
    ]
    assert dump["jobs"][0]["publishedAt"] is None and dump["jobs"][1]["publishedAt"] is not None
    assert dump["actions"] == {
        "editLabel": True,
        "archive": True,
        "unarchive": False,
        "withdraw": True,
        "delete": False,
    }


def test_the_approval_note_is_not_part_of_the_detail(service: ContentAdminService) -> None:
    assert "note" not in service.edition_detail(IDS.published).model_dump()["approval"]


def test_edition_detail_of_a_draft(service: ContentAdminService) -> None:
    detail = service.edition_detail(IDS.draft)
    assert detail.content_hash is None and detail.approval is None
    assert detail.counts.model_dump() == {
        "sections": 1,
        "units": 0,
        "passages": 0,
        "lessons": 0,
        "questions": 0,
    }
    assert detail.actions.delete is True and detail.actions.withdraw is False


def test_an_unknown_edition_is_not_found(service: ContentAdminService) -> None:
    with pytest.raises(AppError) as caught:
        service.edition_detail(uid(999))
    refused(caught.value, ErrorCode.not_found)


# --- edit label -----------------------------------------------------------------------------------


def test_patch_edition_changes_only_the_label(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    before = repo.get("book_editions", IDS.published)
    body = patch_of(
        PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="  New label  "
    )
    detail = service.patch_edition(IDS.published, body)
    after = repo.get("book_editions", IDS.published)
    assert detail.edition_label == "New label"
    assert after["updated_at"] > before["updated_at"]
    unchanged = {k: v for k, v in after.items() if k not in {"edition_label", "updated_at"}}
    assert unchanged == {
        k: v for k, v in before.items() if k not in {"edition_label", "updated_at"}
    }


def test_patch_edition_with_a_stale_token_is_a_version_conflict(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    first = patch_of(PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="A")
    second = patch_of(PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="B")
    service.patch_edition(IDS.published, first)
    with pytest.raises(AppError) as caught:
        service.patch_edition(IDS.published, second)
    refused(caught.value, ErrorCode.version_conflict, "stale")
    assert repo.get("book_editions", IDS.published)["edition_label"] == "A"


def test_the_label_of_a_revoked_edition_cannot_change(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    service.withdraw_edition(IDS.published, withdraw_body(repo))
    body = patch_of(PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="A")
    with pytest.raises(AppError) as caught:
        service.patch_edition(IDS.published, body)
    refused(caught.value, ErrorCode.version_conflict, "state")


def test_patch_edition_of_an_unknown_id_is_not_found(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = PatchEditionRequest.model_validate(
        {"expectedUpdatedAt": stamp(repo, "book_editions", IDS.draft), "editionLabel": "A"}
    )
    with pytest.raises(AppError) as caught:
        service.patch_edition(uid(999), body)
    refused(caught.value, ErrorCode.not_found)


# --- archive and unarchive ------------------------------------------------------------------------


def test_archive_hides_the_edition_and_records_it(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    approval_before = repo.get("book_editions", IDS.published)["review_record"]["approval"]
    detail = service.archive_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    row = repo.get("book_editions", IDS.published)
    assert detail.catalog_hidden is True and row["catalog_hidden"] is True
    assert row["archived_at"] == "2026-10-05T09:00:00+00:00"
    assert row["status"] == "published"
    assert row["review_record"]["approval"] == approval_before
    assert row["review_record"]["catalogVisibility"] == [
        {"action": "hidden", "at": "2026-10-05T09:00:00+00:00"}
    ]
    job = next(j for j in repo.list_jobs(IDS.published) if j["step"] == "archived")
    assert (job["status"], job["bank_version"]) == ("succeeded", 1)
    assert job["pipeline_version"] == "synthetic-pipeline-1"  # copied from the published job
    assert detail.actions.archive is False and detail.actions.unarchive is True


def test_the_archived_job_uses_admin_web_when_nothing_was_published(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    published_job = next(
        key for key, j in repo.tables["content_jobs"].items() if j["step"] == "published"
    )
    del repo.tables["content_jobs"][published_job]
    service.archive_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    job = next(j for j in repo.list_jobs(IDS.published) if j["step"] == "archived")
    assert job["pipeline_version"] == "admin-web"


def test_archiving_twice_or_a_draft_is_a_state_conflict(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    service.archive_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    for edition_id in (IDS.published, IDS.draft):
        with pytest.raises(AppError) as caught:
            service.archive_edition(edition_id, expected(repo, "book_editions", edition_id))
        refused(caught.value, ErrorCode.version_conflict, "state")


def test_unarchive_shows_the_edition_again(
    service: ContentAdminService, repo: MemoryContentAdminRepository, clock: FakeClock
) -> None:
    service.archive_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    clock.advance(hours=1)
    detail = service.unarchive_edition(
        IDS.published, expected(repo, "book_editions", IDS.published)
    )
    row = repo.get("book_editions", IDS.published)
    assert detail.catalog_hidden is False and detail.archived_at is None
    assert row["catalog_hidden"] is False and row["archived_at"] is None
    assert [e["action"] for e in row["review_record"]["catalogVisibility"]] == ["hidden", "shown"]
    assert row["review_record"]["catalogVisibility"][1]["at"] == "2026-10-05T10:00:00+00:00"
    assert "approval" in row["review_record"]
    # unarchive writes no job; the archived audit row stays
    assert [j["step"] for j in repo.list_jobs(IDS.published)].count("archived") == 1


def test_unarchive_of_a_visible_edition_is_a_state_conflict(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    with pytest.raises(AppError) as caught:
        service.unarchive_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    refused(caught.value, ErrorCode.version_conflict, "state")


def test_archive_with_a_stale_token_changes_nothing(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = expected(repo, "book_editions", IDS.published)
    service.patch_edition(
        IDS.published,
        patch_of(PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="A"),
    )
    with pytest.raises(AppError) as caught:
        service.archive_edition(IDS.published, body)
    refused(caught.value, ErrorCode.version_conflict, "stale")
    assert repo.get("book_editions", IDS.published)["catalog_hidden"] is False


# --- withdraw (section 5) -------------------------------------------------------------------------


def test_withdraw_runs_status_then_redaction_then_the_job(
    repo: MemoryContentAdminRepository, clock: FakeClock
) -> None:
    recording = Recording(repo)
    service = ContentAdminService(make_settings(), recording, clock=clock)  # type: ignore[arg-type]
    detail = service.withdraw_edition(IDS.published, withdraw_body(repo))

    steps = [call for call in recording.calls if call[0] != "update" or call[1] == "book_editions"]
    assert [name for name, _ in steps] == ["update", "redact_revoked_content", "upsert_job"]
    assert steps[2][1] == "withdrawn"
    row = repo.get("book_editions", IDS.published)
    assert row["status"] == "revoked"
    assert row["review_record"]["approval"] == APPROVAL  # the CHECK needs it, and it is kept
    assert row["review_record"]["acquisition"] == {"tool": "synthetic"}
    assert row["review_record"]["withdrawal"] == {
        "reason": "rights",
        "note": "synthetic withdrawal note",
        "at": "2026-10-05T09:00:00+00:00",
        "via": "admin_web",
    }
    assert repo.redacted == [str(IDS.published)]
    job = next(j for j in repo.list_jobs(IDS.published) if j["step"] == "withdrawn")
    assert (job["status"], job["pipeline_version"], job["bank_version"]) == (
        "succeeded",
        "synthetic-pipeline-1",
        1,
    )
    assert detail.status == "revoked"
    assert detail.withdrawal is not None and detail.withdrawal.reason == "rights"
    assert detail.actions.model_dump() == {
        "edit_label": False,
        "archive": False,
        "unarchive": False,
        "withdraw": False,
        "delete": False,
    }


def test_withdraw_of_a_hidden_edition_keeps_the_visibility_log(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    service.archive_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    service.withdraw_edition(IDS.published, withdraw_body(repo))
    record = repo.get("book_editions", IDS.published)["review_record"]
    assert record["catalogVisibility"][0]["action"] == "hidden"
    assert {"approval", "withdrawal"} <= set(record)


@pytest.mark.parametrize("status", ["draft", "validated", "superseded"])
def test_only_a_published_edition_can_be_withdrawn(
    service: ContentAdminService, repo: MemoryContentAdminRepository, status: str
) -> None:
    repo.update(
        "book_editions",
        IDS.draft,
        {"status": status, "content_hash": "b" * 64, "review_record": {"approval": APPROVAL}},
        expected_updated_at=None,
    )
    with pytest.raises(AppError) as caught:
        service.withdraw_edition(IDS.draft, withdraw_body(repo, IDS.draft))
    refused(caught.value, ErrorCode.version_conflict, "state")
    assert repo.redacted == []


def test_withdraw_with_a_stale_token_changes_nothing(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = withdraw_body(repo)
    service.patch_edition(
        IDS.published,
        patch_of(PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="A"),
    )
    with pytest.raises(AppError) as caught:
        service.withdraw_edition(IDS.published, body)
    refused(caught.value, ErrorCode.version_conflict, "stale")
    assert repo.get("book_editions", IDS.published)["status"] == "published"
    assert repo.redacted == []
    assert all(j["step"] != "withdrawn" for j in repo.list_jobs(IDS.published))


def test_a_failed_redaction_is_unavailable_and_a_repeat_finishes_the_job(
    repo: MemoryContentAdminRepository, clock: FakeClock
) -> None:
    recording = Recording(repo)
    service = ContentAdminService(make_settings(), recording, clock=clock)  # type: ignore[arg-type]
    body = withdraw_body(repo)
    repo.fail_on = {"redact"}
    with pytest.raises(AppError) as caught:
        service.withdraw_edition(IDS.published, body)
    refused(caught.value, ErrorCode.unavailable)
    row = repo.get("book_editions", IDS.published)
    assert row["status"] == "revoked"  # learners no longer receive it
    assert repo.redacted == [] and all(
        j["step"] != "withdrawn" for j in repo.list_jobs(IDS.published)
    )
    # the half-finished withdrawal shows up as repeatable
    assert service.edition_detail(IDS.published).actions.withdraw is True

    repo.fail_on = set()
    recording.calls.clear()
    # the manager's token is stale now (the status write moved updated_at): the retry ignores it
    detail = service.withdraw_edition(IDS.published, body)
    assert [name for name, _ in recording.calls] == ["redact_revoked_content", "upsert_job"]
    assert repo.redacted == [str(IDS.published)]
    assert detail.status == "revoked" and detail.actions.withdraw is False
    assert any(
        j["step"] == "withdrawn" and j["status"] == "succeeded"
        for j in repo.list_jobs(IDS.published)
    )


def test_a_failed_job_write_is_unavailable_and_a_repeat_finishes_it(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = withdraw_body(repo)
    repo.fail_on = {"job"}
    with pytest.raises(AppError) as caught:
        service.withdraw_edition(IDS.published, body)
    refused(caught.value, ErrorCode.unavailable)
    assert repo.get("book_editions", IDS.published)["status"] == "revoked"
    assert repo.redacted == [str(IDS.published)]

    repo.fail_on = set()
    service.withdraw_edition(IDS.published, body)
    assert repo.redacted == [str(IDS.published)] * 2  # redaction is idempotent
    assert sum(j["step"] == "withdrawn" for j in repo.list_jobs(IDS.published)) == 1


def test_a_retry_keeps_the_recorded_withdrawal(
    service: ContentAdminService, repo: MemoryContentAdminRepository, clock: FakeClock
) -> None:
    repo.fail_on = {"redact"}
    with pytest.raises(AppError):
        service.withdraw_edition(IDS.published, withdraw_body(repo, reason="rights", note="first"))
    recorded = repo.get("book_editions", IDS.published)["review_record"]["withdrawal"]
    repo.fail_on = set()
    clock.advance(hours=2)
    service.withdraw_edition(
        IDS.published, withdraw_body(repo, reason="transmission", note="second")
    )
    assert repo.get("book_editions", IDS.published)["review_record"]["withdrawal"] == recorded


def test_repeating_a_finished_withdrawal_is_harmless(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = withdraw_body(repo)
    service.withdraw_edition(IDS.published, body)
    detail = service.withdraw_edition(IDS.published, body)
    assert detail.status == "revoked"
    assert sum(j["step"] == "withdrawn" for j in repo.list_jobs(IDS.published)) == 1


# --- delete an edition ----------------------------------------------------------------------------


def test_deleting_a_draft_removes_it_with_its_dependent_rows(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    repo.insert(
        "content_jobs",
        {
            "id": uid(95),
            "edition_id": IDS.draft,
            "bank_version": 1,
            "pipeline_version": "synthetic-pipeline-1",
            "step": "verified",
            "status": "succeeded",
        },
    )
    assert service.delete_edition(IDS.draft, expected(repo, "book_editions", IDS.draft)) is None
    assert repo.get("book_editions", IDS.draft) is None
    assert repo.get("book_sections", IDS.draft_section) is None
    assert repo.list_jobs(IDS.draft) == []
    # the other edition is untouched
    assert repo.get("book_editions", IDS.published) is not None
    assert len(repo.list_sections(IDS.published)) == 2


def test_a_published_edition_is_never_deleted(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    with pytest.raises(AppError) as caught:
        service.delete_edition(IDS.published, expected(repo, "book_editions", IDS.published))
    refused(caught.value, ErrorCode.version_conflict, "state")
    assert repo.get("book_editions", IDS.published) is not None


def test_a_draft_that_was_ever_published_is_never_deleted(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    repo.insert(
        "content_jobs",
        {
            "id": uid(96),
            "edition_id": IDS.draft,
            "bank_version": 1,
            "pipeline_version": "synthetic-pipeline-1",
            "step": "published",
            "status": "failed",
        },
    )
    with pytest.raises(AppError) as caught:
        service.delete_edition(IDS.draft, expected(repo, "book_editions", IDS.draft))
    refused(caught.value, ErrorCode.version_conflict, "state")


def test_a_draft_a_learner_uses_is_in_use(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    repo.learner_edition_ids.add(str(IDS.draft))
    with pytest.raises(AppError) as caught:
        service.delete_edition(IDS.draft, expected(repo, "book_editions", IDS.draft))
    refused(caught.value, ErrorCode.version_conflict, "in_use")
    assert repo.get("book_editions", IDS.draft) is not None


def test_deleting_a_draft_with_a_stale_token_or_an_unknown_id(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = expected(repo, "book_editions", IDS.draft)
    service.patch_edition(
        IDS.draft, patch_of(PatchEditionRequest, repo, "book_editions", IDS.draft, editionLabel="A")
    )
    with pytest.raises(AppError) as stale:
        service.delete_edition(IDS.draft, body)
    refused(stale.value, ErrorCode.version_conflict, "stale")
    with pytest.raises(AppError) as missing:
        service.delete_edition(uid(999), body)
    refused(missing.value, ErrorCode.not_found)


# --- sections -------------------------------------------------------------------------------------


def test_section_detail_shows_the_units_and_the_question_counts(
    service: ContentAdminService,
) -> None:
    detail = service.section_detail(IDS.section)
    dump = detail.model_dump(by_alias=True, mode="json")
    assert dump["edition"] == {
        "id": str(IDS.published),
        "editionLabel": "Synthetic label 1",
        "status": "published",
    }
    assert (dump["ordinal"], dump["kind"], dump["reference"]) == (1, "hadith", "synthetic-ref-1")
    assert [u["text"] for u in dump["units"]] == ["نص تجريبي للوحدة 1", "نص تجريبي للوحدة 2"]
    assert set(dump["units"][0]) == {"id", "ordinal", "kind", "reference", "text"}
    assert dump["questionCounts"] == {
        "wordOrder": 1,
        "wordChoice": 2,
        "wordRecall": 0,
        "similarDistinction": 1,
    }


def test_a_section_without_units_has_zero_counts(service: ContentAdminService) -> None:
    detail = service.section_detail(IDS.section_two)
    assert detail.units == []
    assert detail.question_counts.model_dump() == {
        "word_order": 0,
        "word_choice": 0,
        "word_recall": 0,
        "similar_distinction": 0,
    }


def test_patch_section_renames_without_touching_anything_else(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    before = repo.get("book_sections", IDS.section)
    detail = service.patch_section(
        IDS.section, PatchSectionRequest.model_validate({"titleAr": " عنوان جديد "})
    )
    after = repo.get("book_sections", IDS.section)
    assert detail.title_ar == "عنوان جديد" and detail.title_en == before["title_en"]
    assert {k: v for k, v in after.items() if k != "title_ar"} == {
        k: v for k, v in before.items() if k != "title_ar"
    }
    service.patch_section(IDS.section, PatchSectionRequest.model_validate({"titleEn": "New"}))
    assert repo.get("book_sections", IDS.section)["title_en"] == "New"


def test_a_section_of_a_revoked_edition_cannot_be_renamed(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    service.withdraw_edition(IDS.published, withdraw_body(repo))
    with pytest.raises(AppError) as caught:
        service.patch_section(IDS.section, PatchSectionRequest.model_validate({"titleAr": "x"}))
    refused(caught.value, ErrorCode.version_conflict, "state")


def test_an_unknown_section_is_not_found(service: ContentAdminService) -> None:
    for call in (
        lambda: service.section_detail(uid(999)),
        lambda: service.patch_section(
            uid(999), PatchSectionRequest.model_validate({"titleAr": "x"})
        ),
    ):
        with pytest.raises(AppError) as caught:
            call()
        refused(caught.value, ErrorCode.not_found)


# --- books ----------------------------------------------------------------------------------------


def test_books_list_with_edition_counts_and_category_options(service: ContentAdminService) -> None:
    result = service.books().model_dump(by_alias=True, mode="json")
    assert [(b["titleAr"], b["editionCount"]) for b in result["books"]] == [
        ("كتاب تجريبي", 2),
        ("كتاب غير مستخدم", 0),
    ]
    book = result["books"][0]
    assert book["category"] == {"id": str(IDS.category), "labelAr": "تصنيف تجريبي"}
    assert (book["author"], book["contentFormat"], book["titleEn"]) == (
        "مؤلف تجريبي",
        "hadith_collection",
        "Demo book",
    )
    assert result["books"][1]["titleEn"] is None
    assert [c["labelAr"] for c in result["categories"]] == ["تصنيف تجريبي", "تصنيف فارغ"]


def test_patch_book(service: ContentAdminService, repo: MemoryContentAdminRepository) -> None:
    body = patch_of(
        PatchBookRequest,
        repo,
        "books",
        IDS.book,
        titleAr="عنوان جديد",
        titleEn=None,
        author="مؤلف آخر",
        categoryId=str(IDS.empty_category),
    )
    book = service.patch_book(IDS.book, body)
    row = repo.get("books", IDS.book)
    assert (row["title_ar"], row["title_en"], row["author"]) == ("عنوان جديد", None, "مؤلف آخر")
    assert (
        row["category_id"] == str(IDS.empty_category)
        and row["content_format"] == "hadith_collection"
    )
    assert book.category.id == IDS.empty_category and book.category.label_ar == "تصنيف فارغ"
    assert book.edition_count == 2


def test_patch_book_only_sets_what_was_sent(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    service.patch_book(IDS.book, patch_of(PatchBookRequest, repo, "books", IDS.book, author="A"))
    row = repo.get("books", IDS.book)
    assert (row["title_ar"], row["title_en"], row["author"]) == ("كتاب تجريبي", "Demo book", "A")


def test_patch_book_with_an_unknown_category_is_a_validation_error(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    body = patch_of(PatchBookRequest, repo, "books", IDS.book, categoryId=str(uid(999)))
    with pytest.raises(AppError) as caught:
        service.patch_book(IDS.book, body)
    assert caught.value.code is ErrorCode.validation_error
    assert caught.value.details == {
        "fields": [{"field": "categoryId", "rule": "category_not_found"}]
    }
    assert repo.get("books", IDS.book)["category_id"] == str(IDS.category)


def test_patch_book_stale_and_missing(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    old = patch_of(PatchBookRequest, repo, "books", IDS.book, author="A")
    service.patch_book(IDS.book, patch_of(PatchBookRequest, repo, "books", IDS.book, author="B"))
    with pytest.raises(AppError) as stale:
        service.patch_book(IDS.book, old)
    refused(stale.value, ErrorCode.version_conflict, "stale")
    with pytest.raises(AppError) as missing:
        service.patch_book(uid(999), old)
    refused(missing.value, ErrorCode.not_found)


def test_a_book_that_an_edition_uses_cannot_be_deleted(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    with pytest.raises(AppError) as caught:
        service.delete_book(IDS.book, expected(repo, "books", IDS.book))
    refused(caught.value, ErrorCode.version_conflict, "in_use")
    assert repo.get("books", IDS.book) is not None


def test_an_unused_book_is_deleted(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    assert service.delete_book(IDS.empty_book, expected(repo, "books", IDS.empty_book)) is None
    assert repo.get("books", IDS.empty_book) is None


# --- categories -----------------------------------------------------------------------------------


def test_categories_list_with_book_counts(service: ContentAdminService) -> None:
    result = service.categories().model_dump(by_alias=True, mode="json")
    assert [(c["slug"], c["bookCount"], c["displayOrder"]) for c in result["categories"]] == [
        ("demo-category", 2, 1),
        ("empty-category", 0, 2),
    ]
    assert result["categories"][0]["labelEn"] == "Demo category"
    assert result["categories"][1]["labelEn"] is None


def test_patch_category(service: ContentAdminService, repo: MemoryContentAdminRepository) -> None:
    body = patch_of(
        PatchCategoryRequest,
        repo,
        "categories",
        IDS.category,
        labelAr="اسم جديد",
        labelEn=None,
        displayOrder=9999,
    )
    category = service.patch_category(IDS.category, body)
    row = repo.get("categories", IDS.category)
    assert (row["label_ar"], row["label_en"], row["display_order"]) == ("اسم جديد", None, 9999)
    assert row["slug"] == "demo-category"
    assert (category.display_order, category.book_count) == (9999, 2)


def test_patch_category_stale(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    old = patch_of(PatchCategoryRequest, repo, "categories", IDS.category, displayOrder=3)
    service.patch_category(
        IDS.category,
        patch_of(PatchCategoryRequest, repo, "categories", IDS.category, displayOrder=4),
    )
    with pytest.raises(AppError) as caught:
        service.patch_category(IDS.category, old)
    refused(caught.value, ErrorCode.version_conflict, "stale")


def test_category_delete_rules(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    with pytest.raises(AppError) as caught:
        service.delete_category(IDS.category, expected(repo, "categories", IDS.category))
    refused(caught.value, ErrorCode.version_conflict, "in_use")
    service.delete_category(IDS.empty_category, expected(repo, "categories", IDS.empty_category))
    assert repo.get("categories", IDS.empty_category) is None


# --- sources --------------------------------------------------------------------------------------


def test_sources_list_with_edition_counts(service: ContentAdminService) -> None:
    result = service.sources().model_dump(by_alias=True, mode="json")
    assert [(s["title"], s["editionCount"]) for s in result["sources"]] == [
        ("Synthetic source", 2),
        ("Unused source", 0),
    ]
    first = result["sources"][0]
    assert first["sourceUrl"] == "https://example.invalid/source"
    assert first["licenseUrl"] == "https://example.invalid/license"
    assert first["checkedAt"] is None


def test_patch_source(service: ContentAdminService, repo: MemoryContentAdminRepository) -> None:
    body = patch_of(
        PatchSourceRequest,
        repo,
        "sources",
        IDS.source,
        title="Renamed source",
        provider="Another provider",
        licenseUrl=None,
        rightsStatus="verified",
    )
    source = service.patch_source(IDS.source, body)
    row = repo.get("sources", IDS.source)
    assert (row["title"], row["provider"], row["license_url"], row["rights_status"]) == (
        "Renamed source",
        "Another provider",
        None,
        "verified",
    )
    assert row["source_url"] == "https://example.invalid/source"
    assert source.license_url is None and source.edition_count == 2


def test_source_delete_rules(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    with pytest.raises(AppError) as caught:
        service.delete_source(IDS.source, expected(repo, "sources", IDS.source))
    refused(caught.value, ErrorCode.version_conflict, "in_use")
    service.delete_source(IDS.empty_source, expected(repo, "sources", IDS.empty_source))
    assert repo.get("sources", IDS.empty_source) is None


def test_source_stale_and_missing(
    service: ContentAdminService, repo: MemoryContentAdminRepository
) -> None:
    old = expected(repo, "sources", IDS.empty_source)
    service.patch_source(
        IDS.empty_source,
        patch_of(PatchSourceRequest, repo, "sources", IDS.empty_source, title="Other"),
    )
    with pytest.raises(AppError) as stale:
        service.delete_source(IDS.empty_source, old)
    refused(stale.value, ErrorCode.version_conflict, "stale")
    with pytest.raises(AppError) as missing:
        service.delete_source(uid(999), old)
    refused(missing.value, ErrorCode.not_found)


# --- the one log event ----------------------------------------------------------------------------


def events(lines: list[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in lines if '"event":"content_admin_action"' in line]


def test_each_change_logs_one_event_with_action_entity_and_outcome(
    service: ContentAdminService, repo: MemoryContentAdminRepository, log_lines: list[str]
) -> None:
    service.patch_edition(
        IDS.published,
        patch_of(
            PatchEditionRequest, repo, "book_editions", IDS.published, editionLabel="Secret label"
        ),
    )
    service.delete_source(IDS.empty_source, expected(repo, "sources", IDS.empty_source))
    assert events(log_lines) == [
        {"event": "content_admin_action", "action": "update", "entity": "edition", "outcome": "ok"},
        {"event": "content_admin_action", "action": "delete", "entity": "source", "outcome": "ok"},
    ]
    joined = "\n".join(log_lines)
    for leaked in ("Secret label", str(IDS.published), str(IDS.empty_source), "synthetic"):
        assert leaked not in joined


def test_refusals_are_logged_by_reason_only(
    service: ContentAdminService, repo: MemoryContentAdminRepository, log_lines: list[str]
) -> None:
    old = expected(repo, "books", IDS.book)
    service.patch_book(IDS.book, patch_of(PatchBookRequest, repo, "books", IDS.book, author="A"))
    for call in (
        lambda: service.delete_book(IDS.book, old),  # stale
        lambda: service.delete_book(IDS.book, expected(repo, "books", IDS.book)),  # in use
        lambda: service.delete_edition(
            IDS.published, expected(repo, "book_editions", IDS.published)
        ),
        lambda: service.delete_category(uid(999), expected(repo, "categories", IDS.category)),
    ):
        with pytest.raises(AppError):
            call()
    assert [e["outcome"] for e in events(log_lines)] == [
        "ok",
        "stale",
        "in_use",
        "state",
        "not_found",
    ]
    assert all(set(e) == {"event", "action", "entity", "outcome"} for e in events(log_lines))


def test_reads_log_no_admin_event(service: ContentAdminService, log_lines: list[str]) -> None:
    service.overview()
    service.edition_detail(IDS.published)
    service.books()
    assert events(log_lines) == []


# --- the memory repository ------------------------------------------------------------------------


def test_the_memory_repository_enforces_the_approval_check(
    repo: MemoryContentAdminRepository,
) -> None:
    with pytest.raises(ValueError, match="approval"):
        repo.update(
            "book_editions",
            IDS.draft,
            {"status": "revoked", "content_hash": "b" * 64, "review_record": {}},
            expected_updated_at=None,
        )


def test_the_memory_repository_moves_updated_at_on_every_update(
    repo: MemoryContentAdminRepository,
) -> None:
    stamps = [repo.get("categories", IDS.category)["updated_at"]]
    for order in (1, 2, 3):
        row = repo.update(
            "categories",
            IDS.category,
            {"display_order": order},
            expected_updated_at=stamps[-1],
        )
        assert row is not None
        stamps.append(row["updated_at"])
    assert stamps == sorted(set(stamps))


def test_the_memory_repository_refuses_tables_the_admin_does_not_write(
    repo: MemoryContentAdminRepository,
) -> None:
    for call in (
        lambda: repo.get("units", uid(51)),
        lambda: repo.update("units", uid(51), {"canonical_text": "x"}, expected_updated_at=None),
        lambda: repo.delete("passages", uid(61), expected_updated_at=None),
    ):
        with pytest.raises(ValueError):
            call()


def test_a_service_without_a_repository_cannot_be_built_by_accident() -> None:
    # the repository is a required argument: there is no silent default store
    with pytest.raises(TypeError):
        ContentAdminService(make_settings())  # type: ignore[call-arg]
