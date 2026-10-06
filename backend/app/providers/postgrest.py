"""A small PostgREST client for Supabase (the learner data path of API-spec §1.3).

Four kinds of call, all synchronous (``httpx``) and all without automatic retries:

- ``select`` reads rows from a table or view. Without a token it sends only the anon ``apikey``
  (the public catalog views, API-spec E14: ``anon`` may read nothing else); with a learner access
  token it sends ``Authorization: Bearer <token>`` as well, so row-level security applies.
- ``select_all`` pages a ``select`` until a short page, so a result above the server's row cap is
  complete.
- ``rpc`` calls one of the ``app_*`` SECURITY INVOKER functions with the learner token (the
  atomic writes of Database-schema §8.3). ``service_role`` and the ``qatra_server``
  connection are never used here.
- ``patch`` updates the rows that match its filters with the learner token; a PATCH without a
  filter is refused before anything is sent.
- ``delete``, ``upsert`` and ``count`` serve the content manager admin (D91): the same rules with
  the ``service_role`` key as the token (the caller builds a separate client with that key as its
  ``apikey``). A DELETE without a filter is refused before anything is sent.

Failures are reduced to application errors and never carry database text: PostgREST messages and
``details`` can contain submitted values or ids, so neither the status text nor the body is logged
or forwarded. Only a SQLSTATE or a ``PGRST`` code, a status and a kind are logged. Mapping:

- transport error, timeout, any 5xx (``P0002`` excepted, see below) or a 429 -> ``unavailable``
- 401, SQLSTATE ``42501`` or a ``PGRST30x`` code (the token was refused) -> ``unauthenticated``,
  raised as ``TokenRefused`` (its ``privilege`` flag marks a missing grant or a row-level
  security refusal); for a call without a token a 401 or 403 means a configuration fault and is
  ``internal``
- a SQLSTATE that the database functions use as a business signal (``QT002``, ``QT003``,
  ``P0002``, ``23505`` ...) -> ``DbSignal``, which the repository maps to its own condition
  (PostgREST answers ``P0002``/no_data_found with HTTP 500, so the body code is read first)
- anything else -> ``internal``

``httpx`` timeouts apply per phase (connect 5 s; read, write and pool at most 8 s); httpx has no
total deadline, so the worst case of one call is the sum of the phases it passes through.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from typing import Any, NoReturn
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr

from app.errors import AppError, ErrorCode
from app.logging_config import log_event

logger = logging.getLogger("qatra.postgrest")

CONNECT_TIMEOUT_SEC = 5.0
IO_TIMEOUT_SEC = 8.0
DEFAULT_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_SEC,
    read=IO_TIMEOUT_SEC,
    write=IO_TIMEOUT_SEC,
    pool=CONNECT_TIMEOUT_SEC,
)

# SQLSTATEs that the database functions of migrations 0005 and 0006 raise on purpose.
SIGNAL_CODES = frozenset(
    {
        "QT001",  # epoch_mismatch
        "QT002",  # version_conflict
        "QT003",  # invalid_state
        "QT004",  # idempotency_input
        "P0002",  # no_data_found (unknown or foreign row)
        "23505",  # unique_violation (the one-active-plan index)
        "23503",  # foreign_key_violation
        "23001",  # restrict_violation (the edition delete guard of migration 0001, D44)
        "23514",  # check_violation
        "22023",  # invalid_parameter_value
    }
)

NOT_AUTHENTICATED = "not authenticated"  # what the app_* functions raise without auth.uid()
_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")
_CODE = re.compile(r"^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$")
_CONSTRAINT = re.compile(r'constraint "([A-Za-z0-9_]+)"')


class DbSignal(Exception):
    """The database raised one of the business SQLSTATEs (``SIGNAL_CODES``).

    Carries the SQLSTATE and, for a constraint violation, the constraint *name* (a schema
    identifier, not data). Never the message or the details.
    """

    def __init__(self, sqlstate: str, constraint: str | None = None) -> None:
        self.sqlstate = sqlstate
        self.constraint = constraint
        super().__init__(sqlstate)

    def __repr__(self) -> str:
        return f"DbSignal({self.sqlstate})"


class TokenRefused(AppError):
    """``unauthenticated`` because the learner's token was refused.

    ``privilege`` marks SQLSTATE ``42501`` that is neither a 401 nor "not authenticated" (a missing
    grant or a row-level security refusal): the token was accepted, so a caller may treat it as a
    deployment fault instead of ending the learner's session.
    """

    def __init__(self, *, privilege: bool = False) -> None:
        super().__init__(ErrorCode.unauthenticated)
        self.privilege = privilege


def require_token(token: SecretStr | None) -> SecretStr:
    """A learner call needs the learner's access token; without it the session cannot be used."""
    if token is None or not token.get_secret_value():
        raise AppError(ErrorCode.unauthenticated)
    return token


def _error_fields(response: httpx.Response) -> tuple[str | None, str | None]:
    """``(code, message)`` of a PostgREST error body; used for classification only."""
    try:
        body = response.json()
    except ValueError:
        return None, None
    if not isinstance(body, dict):
        return None, None
    code = body.get("code")
    message = body.get("message")
    return (
        code if isinstance(code, str) else None,
        message if isinstance(message, str) else None,
    )


class PostgrestClient:
    """One shared connection pool; the learner token travels per call, never as a default."""

    PAGE_SIZE = 1000  # Supabase's default response cap
    MAX_PAGES = 1000  # stops a listing that never ends

    def __init__(
        self,
        base_url: str,
        anon_key: SecretStr | str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> None:
        parts = urlsplit(base_url)
        if parts.scheme not in {"http", "https"} or not parts.netloc or "@" in parts.netloc:
            raise ValueError("base_url must be an http(s) origin")
        key = anon_key if isinstance(anon_key, SecretStr) else SecretStr(anon_key)
        if not key.get_secret_value().strip():
            raise ValueError("an anon key is required")
        self._key = key
        self._client = httpx.Client(
            base_url=f"{base_url.rstrip('/')}/rest/v1",
            transport=transport,
            timeout=timeout or DEFAULT_TIMEOUT,
            follow_redirects=False,
        )

    def __repr__(self) -> str:
        return "PostgrestClient(<redacted>)"

    def close(self) -> None:
        self._client.close()

    # -- calls -------------------------------------------------------------------------------

    def select(
        self,
        table: str,
        *,
        columns: str,
        filters: Mapping[str, str] | None = None,
        order: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        token: SecretStr | None = None,
    ) -> list[dict[str, Any]]:
        """Rows of ``table`` (or view) where every filter holds, e.g. ``{"id": "eq.<uuid>"}``."""
        return [
            row
            for row in self._page(
                table,
                columns=columns,
                filters=filters,
                order=order,
                limit=limit,
                offset=offset,
                token=token,
            )
            if isinstance(row, dict)
        ]

    def select_all(
        self,
        table: str,
        *,
        columns: str,
        filters: Mapping[str, str] | None = None,
        order: str,
        token: SecretStr | None = None,
    ) -> list[dict[str, Any]]:
        """Every matching row, paged until a short page. A stable ``order`` keeps pages from
        overlapping or skipping rows."""
        rows: list[dict[str, Any]] = []
        offset = 0
        for _ in range(self.MAX_PAGES):
            page = self._page(
                table,
                columns=columns,
                filters=filters,
                order=order,
                limit=self.PAGE_SIZE,
                offset=offset,
                token=token,
            )
            rows.extend(row for row in page if isinstance(row, dict))
            if len(page) < self.PAGE_SIZE:
                return rows
            offset += len(page)
        self._unexpected("pages")

    def rpc(self, function: str, arguments: Mapping[str, Any], *, token: SecretStr) -> Any:
        """Call ``function`` with named arguments under the learner's token; returns the JSON
        result (``None`` for an empty answer). Never retried: a write may have happened."""
        if not _NAME.match(function):
            raise ValueError("invalid function name")
        return self._call("POST", f"/rpc/{function}", token=require_token(token), json=arguments)

    def patch(
        self,
        table: str,
        *,
        filters: Mapping[str, str],
        values: Mapping[str, Any],
        token: SecretStr | None,
    ) -> list[dict[str, Any]]:
        """The rows come back, which shows what row-level security let through."""
        if not _NAME.match(table):
            raise ValueError("invalid table name")
        if not filters or not values:
            raise ValueError("a PATCH needs a filter and values")
        body = self._call(
            "PATCH",
            f"/{table}",
            token=require_token(token),
            params=filters,
            json=values,
            prefer="return=representation",
        )
        return [row for row in body if isinstance(row, dict)] if isinstance(body, list) else []

    def delete(
        self,
        table: str,
        *,
        filters: Mapping[str, str],
        token: SecretStr | None,
    ) -> list[dict[str, Any]]:
        """Delete the rows that match every filter; the deleted rows come back (an empty list
        means nothing matched). A DELETE without a filter is refused before anything is sent."""
        if not _NAME.match(table):
            raise ValueError("invalid table name")
        if not filters:
            raise ValueError("a DELETE needs a filter")
        body = self._call(
            "DELETE",
            f"/{table}",
            token=require_token(token),
            params=filters,
            prefer="return=representation",
        )
        return [row for row in body if isinstance(row, dict)] if isinstance(body, list) else []

    def upsert(
        self,
        table: str,
        *,
        rows: Sequence[Mapping[str, Any]],
        on_conflict: str,
        token: SecretStr | None,
    ) -> list[dict[str, Any]]:
        """Insert ``rows`` or merge them into the row that has the same ``on_conflict`` columns
        (comma-separated names); the stored rows come back."""
        if not _NAME.match(table):
            raise ValueError("invalid table name")
        columns = on_conflict.split(",")
        if not rows or not all(_NAME.match(column) for column in columns):
            raise ValueError("an upsert needs rows and valid conflict columns")
        body = self._call(
            "POST",
            f"/{table}",
            token=require_token(token),
            params={"on_conflict": on_conflict},
            json=[dict(row) for row in rows],
            prefer="resolution=merge-duplicates,return=representation",
        )
        return [row for row in body if isinstance(row, dict)] if isinstance(body, list) else []

    def count(
        self,
        table: str,
        *,
        filters: Mapping[str, str] | None = None,
        token: SecretStr | None,
    ) -> int:
        """The number of rows that match the filters (a HEAD request with ``Prefer: count=exact``;
        the total is the number after the slash of ``Content-Range``)."""
        if not _NAME.match(table):
            raise ValueError("invalid table name")
        response = self._request(
            "HEAD",
            f"/{table}",
            token=require_token(token),
            params=dict(filters or {}),
            prefer="count=exact",
        )
        total = response.headers.get("content-range", "").rpartition("/")[2]
        if not total.isdigit():
            self._unexpected("count", status=response.status_code)
        return int(total)

    # -- plumbing ----------------------------------------------------------------------------

    def _page(
        self,
        table: str,
        *,
        columns: str,
        filters: Mapping[str, str] | None,
        order: str | None,
        limit: int | None,
        offset: int | None,
        token: SecretStr | None,
    ) -> list[Any]:
        """One GET; the raw list, so a short page is judged before non-rows are dropped."""
        if not _NAME.match(table):
            raise ValueError("invalid table name")
        params: dict[str, str] = {"select": columns}
        params.update(filters or {})
        if order:
            params["order"] = order
        if limit is not None:
            params["limit"] = str(limit)
        if offset is not None:
            params["offset"] = str(offset)
        body = self._call("GET", f"/{table}", token=token, params=params)
        if not isinstance(body, list):
            self._unexpected("shape")
        return body

    def _call(
        self,
        method: str,
        path: str,
        *,
        token: SecretStr | None,
        params: Mapping[str, str] | None = None,
        json: Mapping[str, Any] | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = {"apikey": self._key.get_secret_value(), "Accept": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token.get_secret_value()}"
        if prefer is not None:
            headers["Prefer"] = prefer
        try:
            response = self._client.request(method, path, params=params, json=json, headers=headers)
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            kind = "timeout" if isinstance(exc, httpx.TimeoutException) else "transport"
            log_event(logger, "postgrest_failure", level=logging.WARNING, kind=kind)
            raise AppError(ErrorCode.unavailable) from None
        return self._handle(response, with_token=token is not None)

    def _request(
        self,
        method: str,
        path: str,
        *,
        token: SecretStr | None,
        params: Mapping[str, str] | None = None,
        prefer: str | None = None,
    ) -> httpx.Response:
        """One call whose response headers matter: the status is classified like ``_call`` does,
        and the successful response itself comes back."""
        headers = {"apikey": self._key.get_secret_value(), "Accept": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token.get_secret_value()}"
        if prefer is not None:
            headers["Prefer"] = prefer
        try:
            response = self._client.request(method, path, params=params, headers=headers)
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            kind = "timeout" if isinstance(exc, httpx.TimeoutException) else "transport"
            log_event(logger, "postgrest_failure", level=logging.WARNING, kind=kind)
            raise AppError(ErrorCode.unavailable) from None
        self._handle(response, with_token=token is not None)
        return response

    def _handle(self, response: httpx.Response, *, with_token: bool) -> Any:
        status = response.status_code
        if 200 <= status < 300:
            if status == 204 or not response.content:
                return None
            try:
                return response.json()
            except ValueError:
                self._unexpected("body", status=status)
        code, message = _error_fields(response)
        if code in SIGNAL_CODES:
            found = _CONSTRAINT.search(message or "")
            raise DbSignal(code, found.group(1) if found else None)
        if code == "42501" or (code or "").startswith("PGRST30") or status == 401:
            if with_token:
                raise TokenRefused(
                    privilege=code == "42501" and status != 401 and message != NOT_AUTHENTICATED
                )
            # An anonymous call that is refused is a configuration fault, not a session problem.
            self._unexpected("anon_refused", status=status, sqlstate=code)
        if status >= 500 or status == 429:
            log_event(
                logger,
                "postgrest_failure",
                level=logging.WARNING,
                kind="status",
                status=status,
                sqlstate=code if code and _CODE.match(code) else None,
            )
            raise AppError(ErrorCode.unavailable)
        self._unexpected("status", status=status, sqlstate=code)

    @staticmethod
    def _unexpected(
        kind: str, *, status: int | None = None, sqlstate: str | None = None
    ) -> NoReturn:
        log_event(
            logger,
            "postgrest_failure",
            level=logging.ERROR,
            kind=kind,
            status=status,
            sqlstate=sqlstate if sqlstate and _CODE.match(sqlstate) else None,
        )
        raise AppError(ErrorCode.internal)
