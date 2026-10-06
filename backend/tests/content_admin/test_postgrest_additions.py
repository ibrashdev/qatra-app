"""The methods added to ``PostgrestClient`` for the content admin: ``delete``, ``upsert`` and
``count``, and the new signal code ``23001``. The existing methods keep their behavior."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.errors import AppError, ErrorCode
from app.providers.postgrest import SIGNAL_CODES, DbSignal, PostgrestClient

KEY = "synthetic-service-role-key-for-tests"
TOKEN = SecretStr(KEY)
BASE = "https://synthetic-project.example"


def client_for(handler: Any) -> tuple[PostgrestClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapper(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return PostgrestClient(BASE, KEY, transport=httpx.MockTransport(wrapper)), seen


# --- count ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(("header", "total"), [("0-0/42", 42), ("*/0", 0), ("0-999/1500", 1500)])
def test_count_reads_the_total_of_content_range(header: str, total: int) -> None:
    client, seen = client_for(lambda r: httpx.Response(200, headers={"Content-Range": header}))
    assert client.count("books", filters={"category_id": "eq.x"}, token=TOKEN) == total
    (request,) = seen
    assert request.method == "HEAD" and request.url.path == "/rest/v1/books"
    assert request.headers["prefer"] == "count=exact"
    assert request.headers["apikey"] == KEY and request.headers["authorization"] == f"Bearer {KEY}"
    assert dict(request.url.params) == {"category_id": "eq.x"}


def test_count_accepts_a_partial_content_answer() -> None:
    client, _ = client_for(lambda r: httpx.Response(206, headers={"Content-Range": "0-0/7"}))
    assert client.count("books", token=TOKEN) == 7


@pytest.mark.parametrize("header", [None, "", "0-0/*", "garbage"])
def test_count_without_a_usable_total_is_an_internal_error(header: str | None) -> None:
    headers = {} if header is None else {"Content-Range": header}
    client, _ = client_for(lambda r: httpx.Response(200, headers=headers))
    with pytest.raises(AppError) as caught:
        client.count("books", token=TOKEN)
    assert caught.value.code is ErrorCode.internal


def test_count_needs_a_token_and_a_valid_table_name() -> None:
    client, seen = client_for(lambda r: httpx.Response(200, headers={"Content-Range": "*/0"}))
    with pytest.raises(AppError) as caught:
        client.count("books", token=None)
    assert caught.value.code is ErrorCode.unauthenticated
    with pytest.raises(ValueError):
        client.count("books; drop table x", token=TOKEN)
    assert seen == []


def test_count_failures_are_classified_like_every_other_call() -> None:
    client, _ = client_for(lambda r: httpx.Response(503))
    with pytest.raises(AppError) as caught:
        client.count("books", token=TOKEN)
    assert caught.value.code is ErrorCode.unavailable
    client, _ = client_for(lambda r: httpx.Response(401))
    with pytest.raises(AppError) as refused:
        client.count("books", token=TOKEN)
    assert refused.value.code is ErrorCode.unauthenticated


# --- delete ---------------------------------------------------------------------------------------


def test_delete_sends_the_filters_and_returns_the_deleted_rows() -> None:
    client, seen = client_for(lambda r: httpx.Response(200, json=[{"id": "x"}]))
    rows = client.delete("books", filters={"id": "eq.x", "updated_at": "eq.t"}, token=TOKEN)
    assert rows == [{"id": "x"}]
    (request,) = seen
    assert request.method == "DELETE" and request.url.path == "/rest/v1/books"
    assert request.headers["prefer"] == "return=representation"
    assert request.headers["apikey"] == KEY and request.headers["authorization"] == f"Bearer {KEY}"
    assert dict(request.url.params) == {"id": "eq.x", "updated_at": "eq.t"}
    assert request.content == b""


def test_delete_that_matched_nothing_returns_an_empty_list() -> None:
    client, _ = client_for(lambda r: httpx.Response(200, json=[]))
    assert client.delete("books", filters={"id": "eq.x"}, token=TOKEN) == []
    client, _ = client_for(lambda r: httpx.Response(204))
    assert client.delete("books", filters={"id": "eq.x"}, token=TOKEN) == []


def test_delete_without_a_filter_is_refused_before_anything_is_sent() -> None:
    client, seen = client_for(lambda r: httpx.Response(200, json=[]))
    with pytest.raises(ValueError):
        client.delete("books", filters={}, token=TOKEN)
    with pytest.raises(ValueError):
        client.delete("Books;", filters={"id": "eq.x"}, token=TOKEN)
    with pytest.raises(AppError):
        client.delete("books", filters={"id": "eq.x"}, token=None)
    assert seen == []


@pytest.mark.parametrize("code", ["23503", "23001"])
def test_delete_refusals_become_db_signals(code: str) -> None:
    client, _ = client_for(
        lambda r: httpx.Response(
            409, json={"code": code, "message": 'violates constraint "synthetic_fkey"'}
        )
    )
    with pytest.raises(DbSignal) as caught:
        client.delete("books", filters={"id": "eq.x"}, token=TOKEN)
    assert caught.value.sqlstate == code
    assert "synthetic" not in str(caught.value)


# --- upsert ---------------------------------------------------------------------------------------


def test_upsert_merges_duplicates_on_the_conflict_columns() -> None:
    client, seen = client_for(
        lambda r: httpx.Response(201, json=[{"id": "x", "step": "withdrawn"}])
    )
    rows = [{"edition_id": "e", "bank_version": 1, "step": "withdrawn", "status": "succeeded"}]
    stored = client.upsert(
        "content_jobs", rows=rows, on_conflict="edition_id,bank_version,step", token=TOKEN
    )
    assert stored == [{"id": "x", "step": "withdrawn"}]
    (request,) = seen
    assert request.method == "POST" and request.url.path == "/rest/v1/content_jobs"
    assert request.headers["prefer"] == "resolution=merge-duplicates,return=representation"
    assert request.headers["apikey"] == KEY and request.headers["authorization"] == f"Bearer {KEY}"
    assert dict(request.url.params) == {"on_conflict": "edition_id,bank_version,step"}
    assert json.loads(request.content) == rows


def test_upsert_refuses_bad_input_before_sending() -> None:
    client, seen = client_for(lambda r: httpx.Response(201, json=[]))
    row = [{"a": 1}]
    with pytest.raises(ValueError):
        client.upsert("content_jobs", rows=[], on_conflict="a", token=TOKEN)
    with pytest.raises(ValueError):
        client.upsert("content_jobs", rows=row, on_conflict="a;b", token=TOKEN)
    with pytest.raises(ValueError):
        client.upsert("content jobs", rows=row, on_conflict="a", token=TOKEN)
    with pytest.raises(AppError):
        client.upsert("content_jobs", rows=row, on_conflict="a", token=None)
    assert seen == []


def test_upsert_failure_is_unavailable() -> None:
    client, _ = client_for(lambda r: httpx.Response(500))
    with pytest.raises(AppError) as caught:
        client.upsert("content_jobs", rows=[{"a": 1}], on_conflict="a", token=TOKEN)
    assert caught.value.code is ErrorCode.unavailable


# --- signal codes and the unchanged methods -------------------------------------------------------


def test_the_edition_delete_guard_code_is_a_signal() -> None:
    assert "23001" in SIGNAL_CODES
    assert {"QT001", "QT002", "QT003", "QT004", "P0002", "23505", "23503", "23514", "22023"} <= (
        SIGNAL_CODES
    )


def test_patch_and_select_still_behave_as_before() -> None:
    client, seen = client_for(lambda r: httpx.Response(200, json=[{"id": "x"}]))
    assert client.patch("books", filters={"id": "eq.x"}, values={"author": "A"}, token=TOKEN) == [
        {"id": "x"}
    ]
    assert client.select("books", columns="id", token=None) == [{"id": "x"}]
    patch, select = seen
    assert patch.headers["prefer"] == "return=representation"
    assert "authorization" not in select.headers
    with pytest.raises(ValueError):
        client.patch("books", filters={}, values={"a": 1}, token=TOKEN)
