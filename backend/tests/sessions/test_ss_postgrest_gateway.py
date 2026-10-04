"""The session repositories on the shared PostgREST client: headers, error mapping, pagination,
privacy (``MockTransport``)."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.bank import (
    LearnerClient,
    PostgrestBankRepository,
    chunks,
    in_filter,
)
from app.repositories.learning import PostgrestLearningRepository
from app.services.sessions import build_sessions_service
from tests.sessions.ss_postgrest import ANON, BASE, TOKEN, FakePostgrest
from tests.sessions.ss_support import QURAN, QURAN_EDITION, ctx
from tests.support import make_settings


def learner_client(fake: FakePostgrest) -> LearnerClient:
    return LearnerClient(fake.client())


def learner(token: str | None = TOKEN):
    return ctx(token=token)


def refused(call) -> AppError:
    with pytest.raises(AppError) as raised:
        call()
    return raised.value


def editions(rest: LearnerClient, who=None) -> list[dict[str, Any]]:
    return rest.select(who or learner(), "book_editions", columns="id")


def test_every_request_carries_the_anon_key_and_the_learner_token_in_headers_only() -> None:
    fake = FakePostgrest()
    rows = learner_client(fake).select(
        learner(), "book_editions", columns="id", filters={"id": f"eq.{QURAN_EDITION}"}
    )
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
    rest = learner_client(fake)
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
    rest.patch(
        learner(),
        "learning_sessions",
        filters={"id": f"eq.{session_id}"},
        values={"status": "completed"},
    )
    patch = fake.requests[-1]
    assert patch.method == "PATCH" and patch.headers["prefer"] == "return=representation"
    assert fake.patch_bodies == [{"status": "completed"}]


def test_without_a_token_nothing_is_sent() -> None:
    fake = FakePostgrest()
    rest = learner_client(fake)
    for call in (
        lambda: editions(rest, learner(None)),
        lambda: rest.select_all(learner(None), "units", columns="id", order="id.asc"),
        lambda: rest.rpc(learner(None), "app_open_session", {}),
        lambda: rest.patch(
            learner(None), "learning_sessions", filters={"id": "eq.x"}, values={"status": "x"}
        ),
    ):
        assert refused(call).code is ErrorCode.unauthenticated
    assert fake.requests == []


def test_without_a_project_the_service_is_not_built_instead_of_calling_nowhere() -> None:
    supabase = make_settings(QATRA_DATA_BACKEND="supabase")
    assert build_sessions_service(supabase) is None
    fake = FakePostgrest()
    assert build_sessions_service(supabase, client=fake.client()) is not None
    assert fake.requests == []  # building a service reads nothing


@pytest.mark.parametrize(
    ("url", "key"), [("", ANON), ("not a url", ANON), (BASE, ""), (BASE, "  ")]
)
def test_the_client_refuses_a_missing_project_before_any_request(url: str, key: str) -> None:
    with pytest.raises(ValueError):
        PostgrestClient(url, key)


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
        httpx.Response(401, json={"code": "42501", "message": "permission denied"}),
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
    error = refused(lambda: editions(learner_client(fake)))
    assert error.code is code and error.details == details
    assert error.message == code.default_message  # never the server's text


def test_a_transport_failure_or_an_unreadable_answer_is_unavailable() -> None:
    fake = FakePostgrest()

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot reach {request.url.host} with {TOKEN}")

    def timed_out(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    rest = learner_client(fake)
    for failure in (unreachable, timed_out):
        fake.fail("book_editions", failure)
        error = refused(lambda: editions(rest))
        assert error.code is ErrorCode.unavailable and TOKEN not in str(error) + error.message
    fake.fail("books", lambda request: httpx.Response(200, content=b"<html>"))
    assert refused(lambda: rest.select(learner(), "books", columns="id")).code is (
        ErrorCode.unavailable
    )
    fake.fail("books", lambda request: httpx.Response(200, json={"not": "a list"}))
    assert refused(lambda: rest.select(learner(), "books", columns="id")).code is (
        ErrorCode.unavailable
    )


def test_a_row_without_the_documented_shape_is_an_internal_error() -> None:
    fake = FakePostgrest()
    fake.tables["passages"][0].pop("start_ref")
    bank = PostgrestBankRepository(fake.client())
    error = refused(
        lambda: bank.passages(
            learner(), QURAN_EDITION, bank_version=1, section_ordinals=[1], paths=["quran"]
        )
    )
    assert error.code is ErrorCode.internal


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
    client = fake.client()
    rest = LearnerClient(client)
    bank = PostgrestBankRepository(client)
    refused(lambda: editions(rest))
    refused(lambda: rest.select(learner(), "books", columns="id"))
    text = "\n".join(log_lines)
    assert "postgrest_failure" in text and '"status":500' in text and '"sqlstate":"XX000"' in text
    assert '"kind":"transport"' in text
    for secret in (TOKEN, ANON, "SECRET-SERVER-TEXT", BASE):
        assert secret not in text
    for obj in (client, rest, bank, PostgrestLearningRepository(client)):
        assert TOKEN not in repr(obj) and ANON not in repr(obj) and BASE not in repr(obj)
        assert "redacted" in repr(obj)


def test_an_unexpected_database_signal_is_logged_by_code_only(log_lines: list[str]) -> None:
    fake = FakePostgrest()
    fake.fail(
        "book_editions",
        lambda request: httpx.Response(
            400, json={"code": "23505", "message": f"duplicate key {TOKEN}"}
        ),
    )
    assert refused(lambda: editions(learner_client(fake))).code is ErrorCode.unavailable
    text = "\n".join(log_lines)
    assert "db_signal_unexpected" in text and '"sqlstate":"23505"' in text
    assert TOKEN not in text and "duplicate key" not in text


def test_the_token_is_not_part_of_the_session_context_repr() -> None:
    assert TOKEN not in repr(learner()) and TOKEN not in str(learner())


def test_select_all_pages_until_a_short_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(PostgrestClient, "PAGE_SIZE", 3)
    fake = FakePostgrest()
    rest = learner_client(fake)
    rows = rest.select_all(
        learner(),
        "units",
        columns="ordinal",
        filters={"edition_id": f"eq.{QURAN_EDITION}"},
        order="ordinal.asc",
    )
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
