"""Restricted database provider (D34/D69, API-spec §1.4).

``open_restricted_database`` returns a handle for the separate limited login role
(secret ``QATRA_SERVER_DB``). In B0 it supports one operation: ``ping()``, used by the
readiness probe (E02). The connection string is never logged, echoed or chained into an
exception: library messages can contain host names and user names.
"""

from __future__ import annotations

from typing import Protocol

import psycopg

from app.config import Settings

CONNECT_TIMEOUT_SEC = 5  # statement timeout: 5 s, set per transaction in ``ping``


class DatabaseUnavailableError(Exception):
    """The database cannot be reached or did not answer. Carries no connection details."""


class RestrictedDatabase(Protocol):
    def ping(self) -> None:
        """Run a trivial query. Raise ``DatabaseUnavailableError`` on any failure."""


class MemoryDatabase:
    """Memory mode (``QATRA_DATA_BACKEND=memory``): there is no database, so ping succeeds."""

    def ping(self) -> None:
        return None


class PostgresRestrictedDatabase:
    """``select 1`` over the ``qatra_server`` connection. Needs no table privilege."""

    def __init__(self, dsn: str | None) -> None:
        self._dsn = dsn

    def __repr__(self) -> str:
        return "PostgresRestrictedDatabase(<redacted>)"

    def ping(self) -> None:
        if not self._dsn:
            raise DatabaseUnavailableError("restricted database is not configured")
        try:
            # ``set local`` keeps the statement timeout inside this transaction, so it also
            # works behind a transaction pooler (no startup ``options`` parameter is sent).
            with psycopg.connect(self._dsn, connect_timeout=CONNECT_TIMEOUT_SEC) as connection:
                connection.execute("set local statement_timeout = '5s'")
                connection.execute("select 1").fetchone()
        except Exception:
            # Replace the library error: its text can include the host or user name.
            raise DatabaseUnavailableError("restricted database unavailable") from None


def open_restricted_database(settings: Settings) -> RestrictedDatabase:
    if settings.QATRA_DATA_BACKEND == "memory":
        return MemoryDatabase()
    dsn = settings.QATRA_SERVER_DB
    return PostgresRestrictedDatabase(dsn.get_secret_value() if dsn is not None else None)
