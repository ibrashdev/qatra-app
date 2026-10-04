"""The PostgREST provider against ``httpx.MockTransport`` (no network): headers, error mapping,
no retries, redaction."""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from pydantic import SecretStr

from app.errors import AppError, ErrorCode
from app.providers import postgrest
from app.providers.postgrest import (
    DEFAULT_TIMEOUT,
    DbSignal,
    PostgrestClient,
    TokenRefused,
    require_token,
)

URL = "https://project.example"
ANON = "anon-key-secret-value"
TOKEN = SecretStr("learner-token-secret-value")
LEAK = "message and details that must never leak"


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> PostgrestClient:
    return PostgrestClient(URL, ANON, transport=httpx.MockTransport(handler))


def db_error(status: int, code: str, message: str = LEAK) -> httpx.Response:
    return httpx.Response(
        status,
        json={"code": code, "details": f"Key (user_id)=({LEAK})", "hint": None, "message": message},
    )


# --- requests ------------------------------------------------------------------------------------


def test_a_select_without_a_token_sends_only_the_anon_key() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[{"edition_id": "x"}, "not a row"])

    rows = make_client(handler).select(
        "catalog_editions",
        columns="edition_id,edition_key",
        filters={"edition_id": "eq.1"},
        order="edition_key.asc",
    )
    assert rows == [{"edition_id": "x"}]  # only objects are rows
    [request] = seen
    assert request.method == "GET"
    assert request.url.path == "/rest/v1/catalog_editions"
    assert dict(request.url.params) == {
        "select": "edition_id,edition_key",
        "edition_id": "eq.1",
        "order": "edition_key.asc",
    }
    assert request.headers["apikey"] == ANON
    assert "authorization" not in request.headers
    assert request.headers["accept"] == "application/json"


def test_a_learner_select_sends_the_bearer_token_and_the_anon_key() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])

    make_client(handler).select("master_plans", columns="id", token=TOKEN)
    assert seen[0].headers["apikey"] == ANON
    assert seen[0].headers["authorization"] == f"Bearer {TOKEN.get_secret_value()}"


def test_rpc_posts_the_named_arguments_under_the_learner_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=3)

    result = make_client(handler).rpc("app_resume_plan", {"p_plan": "abc"}, token=TOKEN)
    assert result == 3
    request = seen[0]
    assert (request.method, request.url.path) == ("POST", "/rest/v1/rpc/app_resume_plan")
    assert request.read() == b'{"p_plan":"abc"}'
    assert request.headers["authorization"] == f"Bearer {TOKEN.get_secret_value()}"
    assert request.headers["apikey"] == ANON
    assert "application/json" in request.headers["content-type"]


@pytest.mark.parametrize("token", [None, SecretStr(""), SecretStr("")])
def test_a_learner_call_without_a_token_is_unauthenticated(token) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request may be sent without a token")

    with pytest.raises(AppError) as exc:
        make_client(handler).rpc("app_resume_plan", {}, token=token)
    assert exc.value.code is ErrorCode.unauthenticated
    with pytest.raises(AppError):
        require_token(None)
    assert require_token(TOKEN) is TOKEN


def test_an_empty_answer_is_none() -> None:
    client = make_client(lambda request: httpx.Response(204))
    assert client.rpc("app_x", {}, token=TOKEN) is None
    assert (
        make_client(lambda request: httpx.Response(200, content=b"")).rpc("f", {}, token=TOKEN)
        is None
    )


# --- failures never retry ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(503, text="upstream"),
        httpx.ConnectError("refused"),
        httpx.ReadTimeout("slow"),
    ],
    ids=["503", "connect error", "timeout"],
)
def test_there_are_no_automatic_retries(answer: httpx.Response | Exception) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if isinstance(answer, Exception):
            raise answer
        return answer

    with pytest.raises(AppError) as exc:
        make_client(handler).rpc("app_create_plan", {}, token=TOKEN)
    assert exc.value.code is ErrorCode.unavailable
    assert len(calls) == 1


# --- error mapping -------------------------------------------------------------------------------

UNAVAILABLE = ErrorCode.unavailable
UNAUTH = ErrorCode.unauthenticated
INTERNAL = ErrorCode.internal

MAPPING = [
    # transport-level and 5xx answers
    (httpx.Response(502, text="bad gateway"), True, UNAVAILABLE),
    (httpx.Response(503, json={"code": "PGRST002", "message": LEAK}), True, UNAVAILABLE),
    (httpx.Response(500, json={"code": "XX000", "message": LEAK}), True, UNAVAILABLE),
    (httpx.Response(500, json={"code": "57014", "message": LEAK}), True, UNAVAILABLE),
    (httpx.Response(429, json={"message": LEAK}), True, UNAVAILABLE),
    (httpx.Response(503, text="x"), False, UNAVAILABLE),
    # the token was refused
    (httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"}), True, UNAUTH),
    (httpx.Response(403, json={"code": "42501", "message": LEAK}), True, UNAUTH),
    (httpx.Response(401, text="nope"), True, UNAUTH),
    (httpx.Response(400, json={"code": "PGRST303", "message": LEAK}), True, UNAUTH),
    # an anonymous call that is refused is a configuration fault, not a session problem
    (httpx.Response(401, json={"message": "Invalid API key"}), False, INTERNAL),
    (httpx.Response(403, json={"code": "42501", "message": LEAK}), False, INTERNAL),
    # anything else
    (httpx.Response(400, json={"code": "22P02", "message": LEAK}), True, INTERNAL),
    (httpx.Response(404, json={"code": "PGRST202", "message": LEAK}), True, INTERNAL),
    (httpx.Response(404, json={"code": "42P01", "message": LEAK}), True, INTERNAL),
    (httpx.Response(302, headers={"location": "https://elsewhere.example"}), True, INTERNAL),
    (httpx.Response(200, text="<html>not json</html>"), True, INTERNAL),
]


@pytest.mark.parametrize("answer,with_token,expected", MAPPING)
def test_error_mapping(answer: httpx.Response, with_token: bool, expected: ErrorCode) -> None:
    client = make_client(lambda request: answer)
    with pytest.raises(AppError) as exc:
        if with_token:
            client.rpc("app_x", {}, token=TOKEN)
        else:
            client.select("catalog_editions", columns="*")
    assert exc.value.code is expected
    assert exc.value.message == expected.default_message  # never the database's text
    assert exc.value.details == {}


def test_a_select_whose_body_is_not_a_list_is_internal() -> None:
    client = make_client(lambda request: httpx.Response(200, json={"rows": []}))
    with pytest.raises(AppError) as exc:
        client.select("catalog_editions", columns="*")
    assert exc.value.code is INTERNAL


@pytest.mark.parametrize(
    "status,code", [(400, "QT002"), (400, "QT003"), (500, "P0002"), (409, "23503")]
)
def test_function_signals_are_reported_by_sqlstate(status: int, code: str) -> None:
    client = make_client(lambda request: db_error(status, code))
    with pytest.raises(DbSignal) as exc:
        client.rpc("app_revise_plan", {}, token=TOKEN)
    assert exc.value.sqlstate == code and exc.value.constraint is None


def test_a_unique_violation_names_the_constraint_and_nothing_else() -> None:
    message = 'duplicate key value violates unique constraint "master_plans_user_id_active_key"'
    client = make_client(lambda request: db_error(409, "23505", message))
    with pytest.raises(DbSignal) as exc:
        client.rpc("app_create_plan", {}, token=TOKEN)
    assert exc.value.sqlstate == "23505"
    assert exc.value.constraint == "master_plans_user_id_active_key"
    assert LEAK not in repr(exc.value) + str(exc.value)


def test_not_found_is_a_signal_even_though_postgrest_answers_500() -> None:
    """``no_data_found`` (P0002) is a PL/pgSQL error class, which PostgREST reports as HTTP 500."""
    client = make_client(lambda request: db_error(500, "P0002", "plan_not_found"))
    with pytest.raises(DbSignal) as exc:
        client.rpc("app_resume_plan", {"p_plan": "x"}, token=TOKEN)
    assert exc.value.sqlstate == "P0002"


# --- redaction -----------------------------------------------------------------------------------


def test_the_client_never_shows_its_key_or_a_token() -> None:
    client = make_client(lambda request: httpx.Response(200, json=[]))
    assert ANON not in repr(client) and ANON not in str(client)
    assert TOKEN.get_secret_value() not in repr(TOKEN)


def test_failures_are_logged_by_kind_status_and_code_only(log_lines: list[str]) -> None:
    answers = iter(
        [
            db_error(500, "XX000"),
            httpx.ReadTimeout("slow"),
            httpx.ConnectError("refused"),
            db_error(400, "22P02"),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer

    client = make_client(handler)
    for _ in range(4):
        with pytest.raises(AppError):
            client.rpc("app_create_plan", {"p_secret": LEAK}, token=TOKEN)
    joined = "\n".join(log_lines)
    for private in (ANON, TOKEN.get_secret_value(), LEAK, "refused", "slow", "project.example"):
        assert private not in joined
    assert '"kind":"status"' in joined and '"kind":"timeout"' in joined
    assert '"kind":"transport"' in joined and '"sqlstate":"XX000"' in joined


def test_a_hostile_error_code_is_not_logged(log_lines: list[str]) -> None:
    client = make_client(
        lambda request: httpx.Response(500, json={"code": f"<script>{LEAK}", "message": LEAK})
    )
    with pytest.raises(AppError):
        client.select("catalog_editions", columns="*")
    assert LEAK not in "\n".join(log_lines)


# --- construction --------------------------------------------------------------------------------


def test_timeouts_are_explicit() -> None:
    assert DEFAULT_TIMEOUT.connect == postgrest.CONNECT_TIMEOUT_SEC == 5.0
    assert DEFAULT_TIMEOUT.read == DEFAULT_TIMEOUT.write == postgrest.IO_TIMEOUT_SEC == 8.0
    client = make_client(lambda request: httpx.Response(200, json=[]))
    assert client._client.timeout == DEFAULT_TIMEOUT
    assert client._client.follow_redirects is False


@pytest.mark.parametrize(
    "url",
    ["", "project.example", "ftp://project.example", "https://user:pw@project.example", "https://"],
)
def test_the_base_url_must_be_an_http_origin(url: str) -> None:
    with pytest.raises(ValueError):
        PostgrestClient(url, ANON)


def test_an_anon_key_is_required_and_a_secret_is_accepted() -> None:
    with pytest.raises(ValueError):
        PostgrestClient(URL, "  ")
    PostgrestClient(URL, SecretStr(ANON)).close()


def test_the_base_url_may_end_with_a_slash() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json=[])

    PostgrestClient(URL + "/", ANON, transport=httpx.MockTransport(handler)).select(
        "t", columns="*"
    )
    assert seen == ["/rest/v1/t"]


@pytest.mark.parametrize("name", ["", "a/b", "../x", "Table", "a b", "x;drop"])
def test_table_and_function_names_are_checked(name: str) -> None:
    client = make_client(lambda request: httpx.Response(200, json=[]))
    with pytest.raises(ValueError):
        client.select(name, columns="*")
    with pytest.raises(ValueError):
        client.rpc(name, {}, token=TOKEN)


def test_select_sends_limit_and_offset_only_when_given() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[])

    client = make_client(handler)
    client.select("learning_sessions", columns="id", limit=1, offset=0, token=TOKEN)
    client.select("learning_sessions", columns="id", token=TOKEN)
    assert dict(seen[0].url.params) == {"select": "id", "limit": "1", "offset": "0"}
    assert dict(seen[1].url.params) == {"select": "id"}


def paged_client(total: int, page: int) -> tuple[PostgrestClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        start = int(request.url.params["offset"])
        size = min(int(request.url.params["limit"]), page)
        return httpx.Response(200, json=[{"n": n} for n in range(start, min(start + size, total))])

    return make_client(handler), seen


def test_select_all_pages_until_a_short_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(PostgrestClient, "PAGE_SIZE", 3)
    client, seen = paged_client(total=7, page=3)
    rows = client.select_all("units", columns="n", filters={"edition_id": "eq.1"}, order="n.asc")
    assert [row["n"] for row in rows] == list(range(7))
    assert [r.url.params["offset"] for r in seen] == ["0", "3", "6"]
    assert {r.url.params["limit"] for r in seen} == {"3"}
    assert {r.url.params["order"] for r in seen} == {"n.asc"}
    assert all(r.url.params["edition_id"] == "eq.1" for r in seen)


def test_select_all_reads_one_more_page_after_an_exact_multiple(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(PostgrestClient, "PAGE_SIZE", 3)
    client, seen = paged_client(total=6, page=3)
    assert len(client.select_all("units", columns="n", order="n.asc")) == 6
    assert [r.url.params["offset"] for r in seen] == ["0", "3", "6"]


def test_select_all_judges_a_short_page_before_non_rows_are_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(PostgrestClient, "PAGE_SIZE", 2)
    answers = iter([[{"n": 1}, "not a row"], [{"n": 2}]])
    client = make_client(lambda request: httpx.Response(200, json=next(answers)))
    assert client.select_all("units", columns="n", order="n.asc") == [{"n": 1}, {"n": 2}]


def test_select_all_stops_a_listing_that_never_ends(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(PostgrestClient, "PAGE_SIZE", 1)
    monkeypatch.setattr(PostgrestClient, "MAX_PAGES", 5)
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json=[{"n": 1}])

    with pytest.raises(AppError) as exc:
        make_client(handler).select_all("units", columns="n", order="n.asc")
    assert exc.value.code is INTERNAL and len(calls) == 5


def test_select_all_maps_failures_like_select() -> None:
    client = make_client(lambda request: httpx.Response(503, text="x"))
    with pytest.raises(AppError) as exc:
        client.select_all("units", columns="n", order="n.asc", token=TOKEN)
    assert exc.value.code is UNAVAILABLE


def test_patch_sends_filters_in_the_query_the_values_as_json_and_asks_for_the_rows() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[{"id": "1"}, "not a row"])

    rows = make_client(handler).patch(
        "learning_sessions",
        filters={"id": "eq.1", "status": "in.(prepared,open)"},
        values={"status": "completed"},
        token=TOKEN,
    )
    assert rows == [{"id": "1"}]
    [request] = seen
    assert (request.method, request.url.path) == ("PATCH", "/rest/v1/learning_sessions")
    assert dict(request.url.params) == {"id": "eq.1", "status": "in.(prepared,open)"}
    assert request.read() == b'{"status":"completed"}'
    assert request.headers["prefer"] == "return=representation"
    assert request.headers["authorization"] == f"Bearer {TOKEN.get_secret_value()}"
    assert request.headers["apikey"] == ANON


def test_patch_answers_an_empty_list_when_nothing_comes_back() -> None:
    client = make_client(lambda request: httpx.Response(204))
    assert client.patch("t", filters={"id": "eq.1"}, values={"a": 1}, token=TOKEN) == []


@pytest.mark.parametrize("token", [None, SecretStr("")])
def test_patch_without_a_token_sends_nothing(token) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request may be sent without a token")

    with pytest.raises(AppError) as exc:
        make_client(handler).patch("t", filters={"id": "eq.1"}, values={"a": 1}, token=token)
    assert exc.value.code is UNAUTH


@pytest.mark.parametrize(
    "filters,values", [({}, {"a": 1}), ({"id": "eq.1"}, {})], ids=["no filter", "no values"]
)
def test_patch_needs_a_filter_and_values(filters: dict[str, str], values: dict[str, int]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("an unfiltered PATCH must never be sent")

    with pytest.raises(ValueError):
        make_client(handler).patch("t", filters=filters, values=values, token=TOKEN)


def test_patch_failures_are_mapped_like_every_other_call() -> None:
    cases = [
        (httpx.Response(500, json={"code": "XX000", "message": LEAK}), UNAVAILABLE),
        (httpx.Response(404, json={"code": "PGRST205", "message": LEAK}), INTERNAL),
        (httpx.Response(401, json={"code": "PGRST301", "message": LEAK}), UNAUTH),
    ]
    for answer, expected in cases:
        client = make_client(lambda request, answer=answer: answer)
        with pytest.raises(AppError) as exc:
            client.patch("t", filters={"id": "eq.1"}, values={"a": 1}, token=TOKEN)
        assert exc.value.code is expected and LEAK not in exc.value.message


def test_a_check_violation_of_a_patch_is_a_signal() -> None:
    client = make_client(lambda request: db_error(400, "23514"))
    with pytest.raises(DbSignal) as exc:
        client.patch("t", filters={"id": "eq.1"}, values={"a": 1}, token=TOKEN)
    assert exc.value.sqlstate == "23514"


@pytest.mark.parametrize("name", ["", "a/b", "Table", "x;drop"])
def test_the_new_calls_check_table_names(name: str) -> None:
    client = make_client(lambda request: httpx.Response(200, json=[]))
    with pytest.raises(ValueError):
        client.select_all(name, columns="*", order="id.asc")
    with pytest.raises(ValueError):
        client.patch(name, filters={"id": "eq.1"}, values={"a": 1}, token=TOKEN)


@pytest.mark.parametrize(
    "answer,privilege",
    [
        (httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"}), False),
        (httpx.Response(401, text="nope"), False),
        (httpx.Response(400, json={"code": "PGRST303", "message": LEAK}), False),
        (httpx.Response(400, json={"code": "42501", "message": "not authenticated"}), False),
        (httpx.Response(401, json={"code": "42501", "message": "permission denied"}), False),
        (
            httpx.Response(403, json={"code": "42501", "message": "permission denied for table x"}),
            True,
        ),
        (httpx.Response(403, json={"code": "42501", "message": LEAK}), True),
    ],
)
def test_a_refused_token_says_whether_it_was_a_missing_privilege(
    answer: httpx.Response, privilege: bool
) -> None:
    client = make_client(lambda request: answer)
    with pytest.raises(TokenRefused) as exc:
        client.rpc("app_x", {}, token=TOKEN)
    assert exc.value.privilege is privilege
    assert exc.value.code is UNAUTH and exc.value.message == UNAUTH.default_message
    assert LEAK not in str(exc.value) and exc.value.details == {}


def test_a_refused_token_is_an_ordinary_unauthenticated_error_for_other_callers() -> None:
    assert isinstance(TokenRefused(), AppError)
    assert TokenRefused().code is UNAUTH and TokenRefused().privilege is False
