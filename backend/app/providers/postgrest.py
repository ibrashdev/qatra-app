"""A small PostgREST client for Supabase (the learner data path of API-spec §1.3).

Two kinds of call, both synchronous (``httpx``) and both without automatic retries:

- ``select`` reads rows from a table or view. Without a token it sends only the anon ``apikey``
  (the public catalog views, API-spec E14: ``anon`` may read nothing else); with a learner access
  token it sends ``Authorization: Bearer <token>`` as well, so row-level security applies.
- ``rpc`` calls one of the ``app_*`` SECURITY INVOKER functions with the learner token (the
  atomic plan writes of Database-schema §8.3). ``service_role`` and the ``qatra_server``
  connection are never used here.

Failures are reduced to application errors and never carry database text: PostgREST messages and
``details`` can contain submitted values or ids, so neither the status text nor the body is logged
or forwarded. Only a SQLSTATE or a ``PGRST`` code, a status and a kind are logged. Mapping:

- transport error, timeout, any 5xx (``P0002`` excepted, see below) or a 429 -> ``unavailable``
- 401, SQLSTATE ``42501`` or a ``PGRST30x`` code (the token was refused) -> ``unauthenticated``
  (for a call without a token a 401 or 403 means a configuration fault and is ``internal``)
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
from collections.abc import Mapping
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
        "23514",  # check_violation
        "22023",  # invalid_parameter_value
    }
)

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
        token: SecretStr | None = None,
    ) -> list[dict[str, Any]]:
        """Rows of ``table`` (or view) where every filter holds, e.g. ``{"id": "eq.<uuid>"}``."""
        if not _NAME.match(table):
            raise ValueError("invalid table name")
        params: dict[str, str] = {"select": columns}
        params.update(filters or {})
        if order:
            params["order"] = order
        body = self._call("GET", f"/{table}", token=token, params=params)
        if not isinstance(body, list):
            self._unexpected("shape")
        return [row for row in body if isinstance(row, dict)]

    def rpc(self, function: str, arguments: Mapping[str, Any], *, token: SecretStr) -> Any:
        """Call ``function`` with named arguments under the learner's token; returns the JSON
        result (``None`` for an empty answer). Never retried: a write may have happened."""
        if not _NAME.match(function):
            raise ValueError("invalid function name")
        return self._call("POST", f"/rpc/{function}", token=require_token(token), json=arguments)

    # -- plumbing ----------------------------------------------------------------------------

    def _call(
        self,
        method: str,
        path: str,
        *,
        token: SecretStr | None,
        params: Mapping[str, str] | None = None,
        json: Mapping[str, Any] | None = None,
    ) -> Any:
        headers = {"apikey": self._key.get_secret_value(), "Accept": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token.get_secret_value()}"
        try:
            response = self._client.request(method, path, params=params, json=json, headers=headers)
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            kind = "timeout" if isinstance(exc, httpx.TimeoutException) else "transport"
            log_event(logger, "postgrest_failure", level=logging.WARNING, kind=kind)
            raise AppError(ErrorCode.unavailable) from None
        return self._handle(response, with_token=token is not None)

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
                raise AppError(ErrorCode.unauthenticated)
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
