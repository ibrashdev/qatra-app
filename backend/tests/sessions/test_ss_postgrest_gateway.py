"""The PostgREST gateway: headers, error mapping, pagination, privacy (``MockTransport``)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from app.errors import AppError, ErrorCode
from app.repositories.bank import (
    PostgrestBankRepository,
    PostgrestGateway,
    chunks,
    in_filter,
)
from app.repositories.learning import PostgrestLearningRepository
from tests.sessions.ss_postgrest import ANON, TOKEN, FakePostgrest
from tests.sessions.ss_support import QURAN, QURAN_EDITION, ctx

BASE = "https://project.example"


def gateway(fake: FakePostgrest, **kwargs: Any) -> PostgrestGateway:
    return PostgrestGateway(BASE, SecretStr(ANON), client=fake.client(), **kwargs)


def learner(token: str | None = TOKEN):
    return ctx(token=token)


def refused(call) -> AppError:
    with pytest.raises(AppError) as raised:
        call()
    return raised.value


# --- headers -------------------------------------------------------------------------------------


def test_every_request_carries_the_anon_key_and_the_learner_token_in_headers_only() -> None:
    fake = FakePostgrest()
    rest = gateway(fake)
    rows = rest.get(learner(), "book_editions", {"id": f"eq.{QURAN_EDITION}", "select": "id"})
    assert rows == [{"id": str(QURAN_EDITION)}]
    (request,) = fake.requests
    assert request.method == "GET" and request.url.path == "/rest/v1/book_editions"
    assert request.headers["apikey"] == ANON
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.headers["accept"] == "application/json"
    assert TOKEN not in str(request.url) and ANON not in str(request.url)
    assert request.content == b"" and "prefer" not in request.headers


def test_rpc_posts_the_arguments_as_json_and_patch_asks_for_the_representation() -> None:
    fake = FakePostgrest()
    rest = gateway(fake)
    session_id = "55555555-5555-4555-8555-0000000000aa"
    rest.rpc(
        learner(),
        "app_open_session",
        {
            "p_kind": "game",
            "p_plan_id": None,
            "p_plan_version_id": None,
            "p_phase_id": None,
            "p_edition_id": str(QURAN_EDITION),
            "p_learning_date": "2026-10-05",
            "p_lesson_refs": [],
            "p_question_refs": [],
            "p_steps": [],
            "p_bank_version": 1,
            "p_self_rating": None,
            "p_session_id": session_id,
        },
    )
    (call,) = fake.calls_to("rpc/app_open_session")
    assert call.method == "POST" and call.headers["content-type"] == "application/json"
    rest.patch(learner(), "learning_sessions", {"id": f"eq.{session_id}"}, {"status": "completed"})
    patch = fake.requests[-1]
    assert patch.method == "PATCH" and patch.headers["prefer"] == "return=representation"
    assert fake.patch_bodies == [{"status": "completed"}]


def test_without_a_token_nothing_is_sent() -> None:
    fake = FakePostgrest()
    rest = gateway(fake)
    for call in (
        lambda: rest.get(learner(None), "book_editions", {}),
        lambda: rest.rpc(learner(None), "app_open_session", {}),
        lambda: rest.patch(learner(None), "learning_sessions", {}, {"status": "completed"}),
    ):
        assert refused(call).code is ErrorCode.unauthenticated
    assert fake.requests == []


@pytest.mark.parametrize(
    ("url", "key"), [(None, ANON), ("", ANON), (BASE, None), (BASE, SecretStr(""))]
)
def test_without_configuration_nothing_is_sent(url: str | None, key: Any) -> None:
    fake = FakePostgrest()
    anon = key if key is None or isinstance(key, SecretStr) else SecretStr(key)
    rest = PostgrestGateway(url, anon, client=fake.client())
    assert refused(lambda: rest.get(learner(), "book_editions", {})).code is ErrorCode.unavailable
    assert fake.requests == []


# --- error mapping -------------------------------------------------------------------------------

RESPONSES: list[tuple[httpx.Response, ErrorCode, dict[str, Any]]] = [
    (
        httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"}),
        ErrorCode.unauthenticated,
        {},
    ),
    (httpx.Response(401, text="Unauthorized"), ErrorCode.unauthenticated, {}),
    (
        httpx.Response(400, json={"code": "PGRST303", "message": "JWT invalid"}),
        ErrorCode.unauthenticated,
        {},
    ),
    (
        httpx.Response(400, json={"code": "PGRST302", "message": "anon"}),
        ErrorCode.unauthenticated,
        {},
    ),
    (
        httpx.Response(400, json={"code": "42501", "message": "not authenticated"}),
        ErrorCode.unauthenticated,
        {},
    ),
    (
        httpx.Response(403, json={"code": "42501", "message": "permission denied"}),
        ErrorCode.unavailable,
        {},
    ),
    (
        httpx.Response(400, json={"code": "QT002", "message": "version_conflict"}),
        ErrorCode.version_conflict,
        {"reason": "plan_version"},
    ),
    (
        httpx.Response(400, json={"code": "P0002", "message": "plan_not_found"}),
        ErrorCode.not_found,
        {},
    ),
    (
        httpx.Response(404, json={"code": "PGRST205", "message": "no table"}),
        ErrorCode.unavailable,
        {},
    ),
    (
        httpx.Response(400, json={"code": "23505", "message": "duplicate"}),
        ErrorCode.unavailable,
        {},
    ),
    (httpx.Response(500, json={"message": "boom"}), ErrorCode.unavailable, {}),
    (httpx.Response(502, text="<html>bad gateway</html>"), ErrorCode.unavailable, {}),
    (httpx.Response(503, content=b""), ErrorCode.unavailable, {}),
    (httpx.Response(400, text="not json at all"), ErrorCode.unavailable, {}),
]


@pytest.mark.parametrize(("response", "code", "details"), RESPONSES)
def test_failures_are_mapped_to_the_closed_error_codes(
    response: httpx.Response, code: ErrorCode, details: dict[str, Any]
) -> None:
    fake = FakePostgrest()
    fake.fail("book_editions", lambda request: response)
    error = refused(lambda: gateway(fake).get(learner(), "book_editions", {"select": "id"}))
    assert error.code is code and error.details == details
    assert error.message == code.default_message  # never the server's text


def test_a_transport_failure_or_an_unreadable_answer_is_unavailable() -> None:
    fake = FakePostgrest()

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url.host} with {TOKEN}")

    def timed_out(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    rest = gateway(fake)
    for failure in (unreachable, timed_out):
        fake.fail("book_editions", failure)
        error = refused(lambda: rest.get(learner(), "book_editions", {"select": "id"}))
        assert error.code is ErrorCode.unavailable and TOKEN not in str(error) + error.message
    fake.fail("books", lambda request: httpx.Response(200, content=b"<html>"))
    assert (
        refused(lambda: rest.get(learner(), "books", {"select": "id"})).code
        is ErrorCode.unavailable
    )
    fake.fail("books", lambda request: httpx.Response(200, json={"not": "a list"}))
    assert (
        refused(lambda: rest.get(learner(), "books", {"select": "id"})).code
        is ErrorCode.unavailable
    )


def test_a_row_without_the_documented_shape_is_an_internal_error() -> None:
    fake = FakePostgrest()
    fake.tables["passages"][0].pop("start_ref")
    bank = PostgrestBankRepository(gateway(fake))
    error = refused(
        lambda: bank.passages(
            learner(), QURAN_EDITION, bank_version=1, section_ordinals=[1], paths=["quran"]
        )
    )
    assert error.code is ErrorCode.internal


# --- privacy -------------------------------------------------------------------------------------


def test_no_token_key_body_or_server_text_reaches_the_logs_or_the_repr(
    log_lines: list[str],
) -> None:
    fake = FakePostgrest()
    secret_message = f"SECRET-SERVER-TEXT with {TOKEN}"
    fake.fail(
        "book_editions",
        lambda request: httpx.Response(500, json={"code": "XX000", "message": secret_message}),
    )

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"{TOKEN} {ANON}")

    fake.fail("books", unreachable)
    rest = gateway(fake)
    bank = PostgrestBankRepository(rest)
    refused(lambda: rest.get(learner(), "book_editions", {"select": "id"}))
    refused(lambda: rest.get(learner(), "books", {"select": "id"}))
    text = "\n".join(log_lines)
    assert "postgrest_failure" in text and '"status":500' in text and '"code":"XX000"' in text
    assert "postgrest_unreachable" in text
    for secret in (TOKEN, ANON, "SECRET-SERVER-TEXT", BASE):
        assert secret not in text
    for obj in (rest, bank, PostgrestLearningRepository(rest)):
        assert TOKEN not in repr(obj) and ANON not in repr(obj) and BASE not in repr(obj)
        assert "redacted" in repr(obj)


def test_the_token_is_not_part_of_the_session_context_repr() -> None:
    assert TOKEN not in repr(learner()) and TOKEN not in str(learner())


# --- pagination and helpers ----------------------------------------------------------------------


def test_get_all_pages_until_a_short_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(PostgrestGateway, "PAGE_SIZE", 3)
    fake = FakePostgrest()
    rest = gateway(fake)
    params = {"edition_id": f"eq.{QURAN_EDITION}", "select": "ordinal", "order": "ordinal.asc"}
    rows = rest.get_all(learner(), "units", params)
    assert [r["ordinal"] for r in rows] == list(range(1, 16))
    offsets = [r.url.params["offset"] for r in fake.calls_to("/units")]
    assert offsets == ["0", "3", "6", "9", "12", "15"]
    assert {r.url.params["limit"] for r in fake.calls_to("/units")} == {"3"}
    assert len(rows) == len(QURAN["units"])


def test_in_filter_and_chunks() -> None:
    assert in_filter(["a", "b"]) == "in.(a,b)"
    assert in_filter(iter([1, 2, 3])) == "in.(1,2,3)"
    assert chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert chunks([], 3) == []
    assert len(chunks(list(range(100)))) == 3  # forty ids per filter by default
