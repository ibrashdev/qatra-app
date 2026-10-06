"""The admin over PostgREST: the service key on every call, content tables only, the concurrency
filter, the withdraw order and its retry, and the database refusals mapped to ``409`` reasons.

The Supabase REST API is played by ``FakePostgrest`` (``httpx.MockTransport``): no network call."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.contracts_content_admin import (
    ExpectedVersionRequest,
    PatchBookRequest,
    PatchEditionRequest,
    WithdrawEditionRequest,
)
from app.errors import AppError, ErrorCode
from app.repositories.content_admin import (
    MemoryContentAdminRepository,
    PostgrestContentAdminRepository,
)
from app.services.content_admin import ContentAdminService
from tests.content_admin.support import (
    ANON_KEY,
    APPROVAL,
    CONTENT_TABLES,
    IDS,
    NOW,
    SERVICE_KEY,
    SUPABASE_URL,
    FakeClock,
    FakePostgrest,
    seed_catalog,
    tables_from_memory,
    uid,
)
from tests.support import make_settings


@dataclass
class Env:
    fake: FakePostgrest
    repo: PostgrestContentAdminRepository
    service: ContentAdminService

    def stamp(self, table: str, row_id: UUID) -> str:
        row = next(r for r in self.fake.tables[table] if r["id"] == str(row_id))
        return str(row["updated_at"])

    def expected(self, table: str, row_id: UUID) -> ExpectedVersionRequest:
        return ExpectedVersionRequest.model_validate(
            {"expectedUpdatedAt": self.stamp(table, row_id)}
        )

    def withdraw(self, **fields: Any) -> WithdrawEditionRequest:
        payload = {
            "expectedUpdatedAt": self.stamp("book_editions", IDS.published),
            "reason": "rights",
            "note": "synthetic withdrawal note",
            **fields,
        }
        return WithdrawEditionRequest.model_validate(payload)

    def edition_row(self, edition_id: UUID = IDS.published) -> dict[str, Any]:
        return next(r for r in self.fake.tables["book_editions"] if r["id"] == str(edition_id))


@pytest.fixture
def env() -> Env:
    memory = MemoryContentAdminRepository(clock=FakeClock())
    seed_catalog(memory)
    fake = FakePostgrest(tables_from_memory(memory))
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL=SUPABASE_URL,
        SUPABASE_ANON_KEY=ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY=SERVICE_KEY,
    )
    repo = PostgrestContentAdminRepository.from_settings(settings, transport=fake.transport())
    return Env(fake, repo, ContentAdminService(settings, repo, clock=FakeClock()))


def refused(error: AppError, code: ErrorCode, reason: str | None = None) -> None:
    assert error.code is code
    if reason is not None:
        assert error.details == {"reason": reason}


def writes(env: Env) -> list[tuple[str, str]]:
    return [(c.method, c.table) for c in env.fake.requests if c.method not in {"GET", "HEAD"}]


# --- the key and the tables -----------------------------------------------------------------------


def test_every_request_carries_the_service_key_as_apikey_and_bearer(env: Env) -> None:
    env.service.overview()
    env.service.edition_detail(IDS.published)
    env.service.section_detail(IDS.section)
    env.service.books()
    env.service.categories()
    env.service.sources()
    env.service.withdraw_edition(IDS.published, env.withdraw())
    assert len(env.fake.requests) > 30
    for call in env.fake.requests:
        assert call.headers["apikey"] == SERVICE_KEY
        assert call.headers["authorization"] == f"Bearer {SERVICE_KEY}"
        assert ANON_KEY not in call.headers.get("apikey", "")


def test_only_content_tables_and_the_redaction_function_are_called(env: Env) -> None:
    env.service.overview()
    env.service.edition_detail(IDS.published)
    env.service.section_detail(IDS.section)
    env.service.withdraw_edition(IDS.published, env.withdraw())
    names = {call.table for call in env.fake.requests}
    assert names <= CONTENT_TABLES | {"rpc/srv_redact_revoked_content"}
    # nothing about accounts, plans, sessions, attempts, progress or feedback
    forbidden = ("profile", "plan", "session", "attempt", "progress", "chat", "feedback", "account")
    assert not [n for n in names if any(word in n for word in forbidden) and n != "book_sections"]


def test_the_repository_and_service_do_not_show_the_key(env: Env) -> None:
    for text in (repr(env.repo), repr(env.service), str(env.service), str(env.repo)):
        assert SERVICE_KEY not in text


def test_the_repository_needs_a_url_and_the_service_key() -> None:
    with pytest.raises(ValueError):
        PostgrestContentAdminRepository.from_settings(make_settings(SUPABASE_URL=SUPABASE_URL))
    with pytest.raises(ValueError):
        PostgrestContentAdminRepository.from_settings(
            make_settings(SUPABASE_SERVICE_ROLE_KEY=SERVICE_KEY)
        )


# --- reads ----------------------------------------------------------------------------------------


def test_the_overview_counts_with_head_requests_and_hides_the_review_record(env: Env) -> None:
    overview = env.service.overview()
    assert (overview.counts.categories, overview.counts.books, overview.counts.sources) == (2, 2, 2)
    heads = env.fake.calls("HEAD")
    assert sorted(c.table for c in heads) == ["books", "categories", "sources"]
    assert all(c.headers["prefer"] == "count=exact" for c in heads)
    (editions,) = env.fake.calls("GET", "book_editions")
    assert "review_record" not in editions.params["select"]
    assert "content_hash" not in editions.params["select"]


def test_the_edition_detail_reads_one_edition_and_its_children(env: Env) -> None:
    detail = env.service.edition_detail(IDS.published)
    assert detail.counts.model_dump() == {
        "sections": 2,
        "units": 2,
        "passages": 1,
        "lessons": 1,
        "questions": 4,
    }
    assert detail.approval is not None and detail.approval.who == APPROVAL["who"]
    (first, *_) = env.fake.calls("GET", "book_editions")
    assert first.params["id"] == f"eq.{IDS.published}" and first.params["limit"] == "1"
    banked = {
        c.table: c.params for c in env.fake.calls("HEAD") if c.table in {"passages", "lessons"}
    }
    assert banked["passages"] == {"edition_id": f"eq.{IDS.published}", "bank_version": "eq.1"}
    assert env.fake.calls("GET", "content_jobs")[0].params["edition_id"] == f"eq.{IDS.published}"


def test_question_counts_ask_for_the_units_in_chunks(env: Env) -> None:
    unit_ids = [str(uid(1000 + n)) for n in range(85)]
    for number, unit_id in enumerate(unit_ids):
        env.fake.tables["question_items"].append(
            {
                "id": str(uid(2000 + number)),
                "edition_id": str(IDS.published),
                "bank_version": 1,
                "unit_id": unit_id,
                "type": "word_recall" if number % 2 else "word_order",
            }
        )
    counts = env.repo.question_counts(unit_ids, 1)
    assert counts == {
        "word_order": 43,
        "word_choice": 0,
        "word_recall": 42,
        "similar_distinction": 0,
    }
    requests = env.fake.calls("GET", "question_items")
    assert len(requests) == 3
    assert all(r.params["bank_version"] == "eq.1" for r in requests)
    assert [
        len(r.params["unit_id"].removeprefix("in.(").removesuffix(")").split(",")) for r in requests
    ] == [
        40,
        40,
        5,
    ]


# --- optimistic concurrency -----------------------------------------------------------------------


def test_patch_sends_the_expected_updated_at_as_a_filter(env: Env) -> None:
    stamp = env.stamp("book_editions", IDS.published)
    body = PatchEditionRequest.model_validate({"expectedUpdatedAt": stamp, "editionLabel": "New"})
    detail = env.service.patch_edition(IDS.published, body)
    assert detail.edition_label == "New"
    (patch,) = env.fake.calls("PATCH", "book_editions")
    assert patch.params["id"] == f"eq.{IDS.published}"
    assert datetime.fromisoformat(patch.params["updated_at"].removeprefix("eq.")) == (
        datetime.fromisoformat(stamp)
    )
    assert patch.body == {"edition_label": "New"}
    assert patch.headers["prefer"] == "return=representation"
    assert "+00" not in patch.query  # the plus of the offset is percent-encoded


def test_a_row_changed_since_it_was_read_is_a_stale_conflict(env: Env) -> None:
    stamp = env.stamp("book_editions", IDS.published)
    env.edition_row()["updated_at"] = "2026-10-05T09:30:00.000001+00:00"  # another writer
    body = PatchEditionRequest.model_validate({"expectedUpdatedAt": stamp, "editionLabel": "New"})
    with pytest.raises(AppError) as caught:
        env.service.patch_edition(IDS.published, body)
    refused(caught.value, ErrorCode.version_conflict, "stale")
    assert env.edition_row()["edition_label"] == "Synthetic label 1"
    assert [c.method for c in env.fake.requests if c.table == "book_editions"] == [
        "GET",
        "PATCH",
        "GET",
    ]


def test_an_unknown_row_is_not_found_and_nothing_is_written(env: Env) -> None:
    body = PatchEditionRequest.model_validate(
        {"expectedUpdatedAt": "2026-10-05T09:00:00+00:00", "editionLabel": "New"}
    )
    with pytest.raises(AppError) as caught:
        env.service.patch_edition(uid(999), body)
    refused(caught.value, ErrorCode.not_found)
    assert writes(env) == []


def test_a_book_patch_carries_its_own_filter_and_only_the_sent_columns(env: Env) -> None:
    stamp = env.stamp("books", IDS.book)
    body = PatchBookRequest.model_validate(
        {"expectedUpdatedAt": stamp, "titleEn": None, "author": "A"}
    )
    env.service.patch_book(IDS.book, body)
    (patch,) = env.fake.calls("PATCH", "books")
    assert patch.body == {"title_en": None, "author": "A"}
    assert {"id", "updated_at"} <= set(patch.params)
    assert "status" not in patch.params


# --- archive --------------------------------------------------------------------------------------


def test_archive_patches_the_edition_then_upserts_the_archived_job(env: Env) -> None:
    env.service.archive_edition(IDS.published, env.expected("book_editions", IDS.published))
    assert writes(env) == [("PATCH", "book_editions"), ("POST", "content_jobs")]
    patch, upsert = env.fake.calls("PATCH")[0], env.fake.calls("POST")[0]
    assert patch.params["status"] == "eq.published" and "updated_at" in patch.params
    assert patch.body["catalog_hidden"] is True
    assert patch.body["archived_at"] == NOW.isoformat()
    assert patch.body["review_record"]["approval"] == APPROVAL
    assert patch.body["review_record"]["catalogVisibility"] == [
        {"action": "hidden", "at": "2026-10-05T09:00:00+00:00"}
    ]
    assert upsert.params == {"on_conflict": "edition_id,bank_version,step"}
    assert upsert.headers["prefer"] == "resolution=merge-duplicates,return=representation"
    assert upsert.body == [
        {
            "edition_id": str(IDS.published),
            "bank_version": 1,
            "pipeline_version": "synthetic-pipeline-1",
            "step": "archived",
            "status": "succeeded",
        }
    ]


def test_unarchive_clears_the_hidden_flag_and_writes_no_job(env: Env) -> None:
    env.service.archive_edition(IDS.published, env.expected("book_editions", IDS.published))
    env.fake.requests.clear()
    env.service.unarchive_edition(IDS.published, env.expected("book_editions", IDS.published))
    assert writes(env) == [("PATCH", "book_editions")]
    (patch,) = env.fake.calls("PATCH")
    assert patch.body["catalog_hidden"] is False and patch.body["archived_at"] is None
    assert [e["action"] for e in patch.body["review_record"]["catalogVisibility"]] == [
        "hidden",
        "shown",
    ]


# --- withdraw -------------------------------------------------------------------------------------


def test_withdraw_runs_status_then_rpc_then_the_job_upsert(env: Env) -> None:
    detail = env.service.withdraw_edition(IDS.published, env.withdraw())
    assert writes(env) == [
        ("PATCH", "book_editions"),
        ("POST", "rpc/srv_redact_revoked_content"),
        ("POST", "content_jobs"),
    ]
    patch = env.fake.calls("PATCH")[0]
    assert patch.params["status"] == "eq.published"
    assert set(patch.params) >= {"id", "status", "updated_at"}
    assert patch.body["status"] == "revoked"
    record = patch.body["review_record"]
    assert record["approval"] == APPROVAL  # the CHECK on revoked needs it
    assert record["acquisition"] == {"tool": "synthetic"}
    assert record["withdrawal"] == {
        "reason": "rights",
        "note": "synthetic withdrawal note",
        "at": "2026-10-05T09:00:00+00:00",
        "via": "admin_web",
    }
    (rpc,) = env.fake.calls("POST", "rpc/srv_redact_revoked_content")
    assert rpc.body == {"p_edition_id": str(IDS.published)}
    assert rpc.headers["apikey"] == SERVICE_KEY
    (upsert,) = env.fake.calls("POST", "content_jobs")
    assert upsert.body[0]["step"] == "withdrawn" and upsert.body[0]["status"] == "succeeded"
    assert upsert.body[0]["pipeline_version"] == "synthetic-pipeline-1"
    assert detail.status == "revoked" and detail.actions.withdraw is False
    assert env.edition_row()["review_record"]["approval"] == APPROVAL


def test_a_failed_redaction_leaves_the_edition_revoked_and_a_repeat_completes(env: Env) -> None:
    body = env.withdraw()
    env.fake.fail("POST", "rpc/srv_redact_revoked_content", status=503)
    with pytest.raises(AppError) as caught:
        env.service.withdraw_edition(IDS.published, body)
    refused(caught.value, ErrorCode.unavailable)
    assert env.edition_row()["status"] == "revoked"
    assert [c for c in env.fake.calls("POST", "content_jobs")] == []  # the job waits for step 3

    env.service.withdraw_edition(IDS.published, body)  # same body, now stale: the retry ignores it
    assert len(env.fake.calls("PATCH", "book_editions")) == 1  # the status is written once
    assert len(env.fake.calls("POST", "rpc/srv_redact_revoked_content")) == 2
    (upsert,) = env.fake.calls("POST", "content_jobs")
    assert upsert.body[0]["step"] == "withdrawn"
    assert env.service.edition_detail(IDS.published).actions.withdraw is False


def test_a_failed_job_upsert_is_unavailable_and_a_repeat_completes(env: Env) -> None:
    body = env.withdraw()
    env.fake.fail("POST", "content_jobs", status=500)
    with pytest.raises(AppError) as caught:
        env.service.withdraw_edition(IDS.published, body)
    refused(caught.value, ErrorCode.unavailable)
    assert env.edition_row()["status"] == "revoked"
    assert len(env.fake.calls("POST", "rpc/srv_redact_revoked_content")) == 1
    assert env.service.edition_detail(IDS.published).actions.withdraw is True  # repeatable

    env.service.withdraw_edition(IDS.published, body)
    assert len(env.fake.calls("PATCH", "book_editions")) == 1
    assert len(env.fake.calls("POST", "content_jobs")) == 2  # the failed try and the retry
    assert env.service.edition_detail(IDS.published).actions.withdraw is False


@pytest.mark.parametrize("code", ["P0002", "QT003", None])
def test_an_unexpected_redaction_answer_is_unavailable_too(env: Env, code: str | None) -> None:
    env.fake.fail("POST", "rpc/srv_redact_revoked_content", status=500, code=code)
    with pytest.raises(AppError) as caught:
        env.service.withdraw_edition(IDS.published, env.withdraw())
    refused(caught.value, ErrorCode.unavailable)


def test_withdraw_with_a_stale_token_writes_nothing(env: Env) -> None:
    body = env.withdraw()
    env.edition_row()["updated_at"] = "2026-10-05T09:30:00.000001+00:00"
    with pytest.raises(AppError) as caught:
        env.service.withdraw_edition(IDS.published, body)
    refused(caught.value, ErrorCode.version_conflict, "stale")
    assert env.edition_row()["status"] == "published"
    assert writes(env) == [("PATCH", "book_editions")]  # the filtered write matched no row


# --- delete ---------------------------------------------------------------------------------------


def test_delete_a_draft_sends_a_filtered_delete(env: Env) -> None:
    env.service.delete_edition(IDS.draft, env.expected("book_editions", IDS.draft))
    (delete,) = env.fake.calls("DELETE")
    assert delete.table == "book_editions"
    assert set(delete.params) == {"id", "updated_at"} and delete.params["id"] == f"eq.{IDS.draft}"
    assert delete.headers["prefer"] == "return=representation"
    assert all(r["id"] != str(IDS.draft) for r in env.fake.tables["book_editions"])


def test_a_foreign_key_refusal_is_in_use(env: Env) -> None:
    env.fake.fail("DELETE", "book_editions", status=409, code="23503")
    with pytest.raises(AppError) as caught:
        env.service.delete_edition(IDS.draft, env.expected("book_editions", IDS.draft))
    refused(caught.value, ErrorCode.version_conflict, "in_use")
    assert env.edition_row(IDS.draft)  # still there


def test_the_delete_guard_refusal_is_a_state_conflict(env: Env) -> None:
    env.fake.fail("DELETE", "book_editions", status=409, code="23001")
    with pytest.raises(AppError) as caught:
        env.service.delete_edition(IDS.draft, env.expected("book_editions", IDS.draft))
    refused(caught.value, ErrorCode.version_conflict, "state")


@pytest.mark.parametrize(
    ("table", "delete", "row_id"),
    [
        ("books", "delete_book", IDS.book),
        ("categories", "delete_category", IDS.category),
        ("sources", "delete_source", IDS.source),
    ],
)
def test_a_row_something_uses_is_in_use(env: Env, table: str, delete: str, row_id: UUID) -> None:
    env.fake.fail("DELETE", table, status=409, code="23503")
    with pytest.raises(AppError) as caught:
        getattr(env.service, delete)(row_id, env.expected(table, row_id))
    refused(caught.value, ErrorCode.version_conflict, "in_use")


def test_deleting_with_a_stale_token_is_a_stale_conflict(env: Env) -> None:
    body = env.expected("sources", IDS.empty_source)
    next(r for r in env.fake.tables["sources"] if r["id"] == str(IDS.empty_source))[
        "updated_at"
    ] = "2026-10-05T09:30:00.000001+00:00"
    with pytest.raises(AppError) as caught:
        env.service.delete_source(IDS.empty_source, body)
    refused(caught.value, ErrorCode.version_conflict, "stale")
    assert any(r["id"] == str(IDS.empty_source) for r in env.fake.tables["sources"])


def test_deleting_an_unused_source_succeeds(env: Env) -> None:
    env.service.delete_source(IDS.empty_source, env.expected("sources", IDS.empty_source))
    assert all(r["id"] != str(IDS.empty_source) for r in env.fake.tables["sources"])


# --- failures of the data layer -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "PGRST301"), (401, None), (403, "42501"), (500, None), (503, None), (429, None)],
)
def test_a_refused_key_or_an_outage_is_unavailable_never_unauthenticated(
    env: Env, status: int, code: str | None
) -> None:
    env.fake.fail("GET", "book_editions", status=status, code=code)
    with pytest.raises(AppError) as caught:
        env.service.edition_detail(IDS.published)
    refused(caught.value, ErrorCode.unavailable)


def test_a_transport_failure_is_unavailable() -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("synthetic outage", request=request)

    settings = make_settings(SUPABASE_URL=SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY=SERVICE_KEY)
    repo = PostgrestContentAdminRepository.from_settings(
        settings, transport=httpx.MockTransport(broken)
    )
    with pytest.raises(AppError) as caught:
        ContentAdminService(settings, repo, clock=FakeClock()).overview()
    refused(caught.value, ErrorCode.unavailable)


def test_an_unknown_database_signal_is_an_internal_error(env: Env) -> None:
    env.fake.fail("PATCH", "books", status=400, code="23514")
    body = PatchBookRequest.model_validate(
        {"expectedUpdatedAt": env.stamp("books", IDS.book), "author": "A"}
    )
    with pytest.raises(AppError) as caught:
        env.service.patch_book(IDS.book, body)
    refused(caught.value, ErrorCode.internal)


def test_a_category_that_vanishes_during_a_book_edit_is_a_validation_error(env: Env) -> None:
    env.fake.fail("PATCH", "books", status=409, code="23503")
    body = PatchBookRequest.model_validate(
        {
            "expectedUpdatedAt": env.stamp("books", IDS.book),
            "categoryId": str(IDS.empty_category),
        }
    )
    with pytest.raises(AppError) as caught:
        env.service.patch_book(IDS.book, body)
    assert caught.value.code is ErrorCode.validation_error
