from __future__ import annotations

from typing import Any

import pytest

from app.providers import database as database_provider
from app.providers.database import (
    DatabaseUnavailableError,
    MemoryDatabase,
    PostgresRestrictedDatabase,
    open_restricted_database,
)
from tests.support import make_settings

DSN = "postgresql://qatra_server:SENTINEL-password@db.sentinel-host.example:5432/postgres"


def test_memory_mode_returns_a_database_whose_ping_succeeds() -> None:
    database = open_restricted_database(make_settings(QATRA_DATA_BACKEND="memory"))
    assert isinstance(database, MemoryDatabase)
    assert database.ping() is None


def test_supabase_mode_without_a_dsn_is_unavailable() -> None:
    database = open_restricted_database(make_settings(QATRA_DATA_BACKEND="supabase"))
    assert isinstance(database, PostgresRestrictedDatabase)
    with pytest.raises(DatabaseUnavailableError):
        database.ping()


def test_ping_runs_select_one_with_timeouts_and_never_shows_the_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executed: list[str] = []
    seen: dict[str, Any] = {}

    class FakeResult:
        def fetchone(self) -> tuple[int]:
            return (1,)

    class FakeConnection:
        def __enter__(self) -> FakeConnection:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def execute(self, sql: str) -> FakeResult:
            executed.append(sql)
            return FakeResult()

    def fake_connect(dsn: str, **kwargs: Any) -> FakeConnection:
        seen["dsn"] = dsn
        seen.update(kwargs)
        return FakeConnection()

    monkeypatch.setattr(database_provider.psycopg, "connect", fake_connect)
    database = open_restricted_database(
        make_settings(QATRA_DATA_BACKEND="supabase", QATRA_SERVER_DB=DSN)
    )
    database.ping()
    assert seen["dsn"] == DSN
    assert seen["connect_timeout"] == 5
    assert executed == ["set local statement_timeout = '5s'", "select 1"]
    assert "SENTINEL" not in repr(database)


def test_ping_failure_is_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_connect(dsn: str, **kwargs: Any) -> None:
        raise OSError(f"could not connect using {dsn}")

    monkeypatch.setattr(database_provider.psycopg, "connect", failing_connect)
    database = PostgresRestrictedDatabase(DSN)
    with pytest.raises(DatabaseUnavailableError) as raised:
        database.ping()
    assert "SENTINEL" not in str(raised.value)
    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__ is True


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql://user:SENTINEL-pw@127.0.0.1:9/none",  # nothing listens: refused
        "this is SENTINEL-not a valid dsn",  # rejected by the driver itself
    ],
)
def test_real_driver_failures_are_sanitized(dsn: str) -> None:
    with pytest.raises(DatabaseUnavailableError) as raised:
        PostgresRestrictedDatabase(dsn).ping()
    assert "SENTINEL" not in str(raised.value)
    assert raised.value.__cause__ is None
