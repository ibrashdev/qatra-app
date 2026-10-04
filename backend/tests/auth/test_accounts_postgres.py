"""``PostgresAccountRepository``: SQL text, parameters, result mapping, SQLSTATE mapping and the
no-leak rules, against a fake ``psycopg.connect`` (no database).

The real functions are exercised by the local PostgreSQL harness in ``supabase/tests/local``; here
the contract between the repository and the ``srv_*`` signatures of ``0005_rls_functions.sql`` is
pinned: argument order, explicit casts, one transaction with a 5-second statement timeout."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from app.repositories import accounts as accounts_module
from app.repositories.accounts import (
    AccountNotFoundError,
    AccountRepository,
    ActiveRecoveryCode,
    EpochMismatchError,
    GrantTicket,
    Handle,
    InMemoryAccounts,
    InvalidAccountValueError,
    InvalidStateError,
    PostgresAccountRepository,
    RepositoryUnavailable,
    StoredSession,
    UsernameTakenError,
)

DSN = "postgresql://qatra_server:SENTINEL-password@db.sentinel-host.example:5432/postgres"
USER = UUID("11111111-1111-4111-8111-111111111111")
CODE = UUID("22222222-2222-4222-8222-222222222222")
GRANT = UUID("33333333-3333-4333-8333-333333333333")
SESSION = UUID("44444444-4444-4444-8444-444444444444")
HASH = bytes(range(32))
OTHER_HASH = bytes(range(32, 64))
LATER = datetime(2026, 10, 4, 8, 25, tzinfo=UTC)


class FakeDbError(Exception):
    """Stands in for a psycopg error: the repository reads only ``sqlstate``."""

    def __init__(self, sqlstate: str) -> None:
        super().__init__(f"database said {sqlstate} for {DSN}")
        self.sqlstate = sqlstate


class FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)


class Database:
    """A scripted connection factory: every ``connect`` pops one scripted result."""

    def __init__(self, *results: list[tuple[Any, ...]] | Exception) -> None:
        self._results = list(results)
        self.connects: list[tuple[str, dict[str, Any]]] = []
        self.statements: list[tuple[str, tuple[Any, ...] | None]] = []
        self.exits: list[object] = []

    def connect(self, dsn: str, **kwargs: Any) -> Database:
        self.connects.append((dsn, kwargs))
        return self

    def __enter__(self) -> Database:
        return self

    def __exit__(self, exc_type: object, *rest: object) -> None:
        self.exits.append(exc_type)

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> FakeCursor:
        self.statements.append((sql, params))
        if sql.startswith("set local"):
            return FakeCursor([])
        result = self._results.pop(0) if self._results else []
        if isinstance(result, Exception):
            raise result
        return FakeCursor(result)


@pytest.fixture
def database(monkeypatch: pytest.MonkeyPatch) -> Callable[..., Database]:
    def install(*results: list[tuple[Any, ...]] | Exception) -> Database:
        db = Database(*results)
        monkeypatch.setattr(accounts_module.psycopg, "connect", db.connect)
        return db

    return install


def repo() -> PostgresAccountRepository:
    return PostgresAccountRepository(DSN)


# --- every method: the function it calls and the arguments it passes ------------------------------

SESSION_ROW = (
    SESSION,
    USER,
    "Sample_User_01",
    "u.alias@qatra.invalid",
    3,
    b"\x01blob",
    LATER,
    False,
)

CASES: list[
    tuple[str, Callable[[PostgresAccountRepository], Any], str, tuple[Any, ...], Any, Any]
] = [
    (
        "find_handle",
        lambda r: r.find_handle("sample_user_01"),
        "public.srv_find_handle(%s::text)",
        ("sample_user_01",),
        [(USER, "Sample_User_01", "u.alias@qatra.invalid", 2, False)],
        Handle(USER, "Sample_User_01", "u.alias@qatra.invalid", 2, False),
    ),
    (
        "find_handle (unknown)",
        lambda r: r.find_handle("nobody"),
        "public.srv_find_handle(%s::text)",
        ("nobody",),
        [],
        None,
    ),
    (
        "register_account",
        lambda r: r.register_account(
            user_id=USER,
            username_display="Sample_User_01",
            username_normalized="sample_user_01",
            internal_auth_alias="u.alias@qatra.invalid",
            is_demo=False,
            terms_version="2026-10-04",
            language="ar",
            time_zone="Asia/Dubai",
            recovery_code_hash=HASH,
        ),
        "public.srv_register_account(%s::uuid, %s::text, %s::text, %s::text, %s::boolean, "
        "%s::text, %s::text, %s::text, %s::bytea)",
        (
            USER,
            "Sample_User_01",
            "sample_user_01",
            "u.alias@qatra.invalid",
            False,
            "2026-10-04",
            "ar",
            "Asia/Dubai",
            HASH,
        ),
        [],
        None,
    ),
    (
        "accept_terms",
        lambda r: r.accept_terms(USER, "2026-10-04"),
        "public.srv_accept_terms(%s::uuid, %s::text)",
        (USER, "2026-10-04"),
        [(LATER,)],
        LATER,
    ),
    (
        "recovery_active_code",
        lambda r: r.recovery_active_code(USER),
        "public.srv_recovery_active_code(%s::uuid)",
        (USER,),
        [(CODE, memoryview(HASH))],
        ActiveRecoveryCode(CODE, HASH),
    ),
    (
        "recovery_active_code (none)",
        lambda r: r.recovery_active_code(USER),
        "public.srv_recovery_active_code(%s::uuid)",
        (USER,),
        [],
        None,
    ),
    (
        "recovery_reserve",
        lambda r: r.recovery_reserve(
            user_id=USER,
            code_id=CODE,
            grant_id=GRANT,
            grant_hash=HASH,
            grant_expires_at=LATER,
        ),
        "public.srv_recovery_reserve(%s::uuid, %s::uuid, %s::uuid, %s::bytea, %s::timestamptz)",
        (USER, CODE, GRANT, HASH, LATER),
        [(True,)],
        True,
    ),
    (
        "recovery_reserve (held)",
        lambda r: r.recovery_reserve(
            user_id=USER, code_id=CODE, grant_id=GRANT, grant_hash=HASH, grant_expires_at=LATER
        ),
        "public.srv_recovery_reserve(%s::uuid, %s::uuid, %s::uuid, %s::bytea, %s::timestamptz)",
        (USER, CODE, GRANT, HASH, LATER),
        [(False,)],
        False,
    ),
    (
        "recovery_begin",
        lambda r: r.recovery_begin(HASH),
        "public.srv_recovery_begin(%s::bytea)",
        (HASH,),
        [(GRANT, USER)],
        GrantTicket(GRANT, USER),
    ),
    (
        "recovery_begin (invalid)",
        lambda r: r.recovery_begin(HASH),
        "public.srv_recovery_begin(%s::bytea)",
        (HASH,),
        [],
        None,
    ),
    (
        "recovery_release",
        lambda r: r.recovery_release(GRANT),
        "public.srv_recovery_release(%s::uuid)",
        (GRANT,),
        [],
        None,
    ),
    (
        "recovery_consume",
        lambda r: r.recovery_consume(GRANT, HASH),
        "public.srv_recovery_consume(%s::uuid, %s::bytea)",
        (GRANT, HASH),
        [(4,)],
        4,
    ),
    (
        "recovery_rotate",
        lambda r: r.recovery_rotate(USER, HASH),
        "public.srv_recovery_rotate(%s::uuid, %s::bytea)",
        (USER, HASH),
        [],
        None,
    ),
    (
        "create_app_session",
        lambda r: r.create_app_session(
            user_id=USER,
            session_hash=HASH,
            encrypted_auth_tokens=b"\x01blob",
            auth_epoch=3,
            expires_at=LATER,
        ),
        "public.srv_create_app_session(%s::uuid, %s::bytea, %s::bytea, %s::integer, "
        "%s::timestamptz)",
        (USER, HASH, b"\x01blob", 3, LATER),
        [(SESSION,)],
        SESSION,
    ),
    (
        "read_app_session",
        lambda r: r.read_app_session(HASH),
        "public.srv_read_app_session(%s::bytea)",
        (HASH,),
        [SESSION_ROW],
        StoredSession(
            SESSION, USER, "Sample_User_01", "u.alias@qatra.invalid", 3, b"\x01blob", LATER, False
        ),
    ),
    (
        "read_app_session (not live)",
        lambda r: r.read_app_session(HASH),
        "public.srv_read_app_session(%s::bytea)",
        (HASH,),
        [],
        None,
    ),
    (
        "update_session_tokens",
        lambda r: r.update_session_tokens(SESSION, b"\x01new"),
        "public.srv_update_app_session_tokens(%s::uuid, %s::bytea)",
        (SESSION, b"\x01new"),
        [],
        None,
    ),
    (
        "revoke_app_session",
        lambda r: r.revoke_app_session(HASH),
        "public.srv_revoke_app_session(%s::bytea)",
        (HASH,),
        [],
        None,
    ),
    (
        "bump_auth_epoch",
        lambda r: r.bump_auth_epoch(USER),
        "public.srv_bump_auth_epoch(%s::uuid)",
        (USER,),
        [(5,)],
        5,
    ),
    (
        "throttle_check",
        lambda r: r.throttle_check([HASH, OTHER_HASH]),
        "public.srv_throttle_check(%s::bytea[])",
        ([HASH, OTHER_HASH],),
        [(memoryview(HASH), 6), (OTHER_HASH, 0)],
        {HASH: 6, OTHER_HASH: 0},
    ),
    (
        "throttle_record (failure)",
        lambda r: r.throttle_record([HASH, OTHER_HASH], "failure"),
        "public.srv_throttle_record(%s::bytea[], %s::text)",
        ([HASH, OTHER_HASH], "failure"),
        [],
        None,
    ),
    (
        "throttle_record (success)",
        lambda r: r.throttle_record([HASH], "success"),
        "public.srv_throttle_record(%s::bytea[], %s::text)",
        ([HASH], "success"),
        [],
        None,
    ),
    (
        "delete_personal_rows",
        lambda r: r.delete_personal_rows(USER, HASH),
        "public.srv_delete_personal_rows(%s::uuid, %s::bytea)",
        (USER, HASH),
        [],
        None,
    ),
    (
        "delete_personal_rows (no throttle key)",
        lambda r: r.delete_personal_rows(USER, None),
        "public.srv_delete_personal_rows(%s::uuid, %s::bytea)",
        (USER, None),
        [],
        None,
    ),
]


@pytest.mark.parametrize(
    ("name", "call", "function", "params", "rows", "expected"),
    CASES,
    ids=[case[0] for case in CASES],
)
def test_each_method_calls_its_function_with_its_arguments(
    database: Callable[..., Database],
    name: str,
    call: Callable[[PostgresAccountRepository], Any],
    function: str,
    params: tuple[Any, ...],
    rows: list[tuple[Any, ...]],
    expected: Any,
) -> None:
    db = database(rows)
    assert call(repo()) == expected
    statements = [s for s in db.statements if not s[0].startswith("set local")]
    assert len(statements) == 1
    sql, sent = statements[0]
    assert function in sql
    assert sent == params


def test_every_call_is_one_transaction_with_a_statement_timeout(
    database: Callable[..., Database],
) -> None:
    db = database([(USER, "Sample_User_01", "u.alias@qatra.invalid", 0, False)])
    repo().find_handle("sample_user_01")
    assert len(db.connects) == 1  # one connection per call
    dsn, kwargs = db.connects[0]
    assert dsn == DSN and kwargs == {"connect_timeout": 5, "prepare_threshold": None}
    assert db.statements[0][0] == "set local statement_timeout = '5s'"
    assert db.exits == [None]  # leaving the block cleanly commits


def test_a_failing_call_leaves_the_transaction_with_the_exception(
    database: Callable[..., Database],
) -> None:
    db = database(FakeDbError("XX000"))
    with pytest.raises(RepositoryUnavailable):
        repo().find_handle("x")
    assert db.exits == [FakeDbError]  # the connection context manager rolls back


# --- SQLSTATE mapping -----------------------------------------------------------------------------


def register(repository: PostgresAccountRepository) -> None:
    repository.register_account(
        user_id=USER,
        username_display="Sample_User_01",
        username_normalized="sample_user_01",
        internal_auth_alias="u.alias@qatra.invalid",
        is_demo=False,
        terms_version="2026-10-04",
        language="ar",
        time_zone="Asia/Dubai",
        recovery_code_hash=HASH,
    )


@pytest.mark.parametrize(
    ("sqlstate", "error"),
    [
        ("23505", UsernameTakenError),
        ("23514", InvalidAccountValueError),
        ("XX000", RepositoryUnavailable),
    ],
)
def test_registration_sqlstates(
    database: Callable[..., Database], sqlstate: str, error: type[Exception]
) -> None:
    database(FakeDbError(sqlstate))
    with pytest.raises(error):
        register(repo())


@pytest.mark.parametrize(
    ("sqlstate", "error"),
    [
        ("QT001", EpochMismatchError),
        ("23505", RepositoryUnavailable),
        ("P0002", RepositoryUnavailable),
    ],
)
def test_session_creation_sqlstates(
    database: Callable[..., Database], sqlstate: str, error: type[Exception]
) -> None:
    database(FakeDbError(sqlstate))
    with pytest.raises(error):
        repo().create_app_session(
            user_id=USER,
            session_hash=HASH,
            encrypted_auth_tokens=b"x",
            auth_epoch=0,
            expires_at=LATER,
        )


@pytest.mark.parametrize(
    ("sqlstate", "error"),
    [
        ("QT003", InvalidStateError),
        ("P0002", AccountNotFoundError),
        ("QT001", RepositoryUnavailable),
    ],
)
def test_recovery_consume_sqlstates(
    database: Callable[..., Database], sqlstate: str, error: type[Exception]
) -> None:
    database(FakeDbError(sqlstate))
    with pytest.raises(error):
        repo().recovery_consume(GRANT, HASH)


@pytest.mark.parametrize("method", ["accept_terms", "bump_auth_epoch"])
def test_no_data_found_is_an_unknown_account(
    database: Callable[..., Database], method: str
) -> None:
    database(FakeDbError("P0002"))
    call = getattr(repo(), method)
    with pytest.raises(AccountNotFoundError):
        call(USER, "2026-10-04") if method == "accept_terms" else call(USER)


def test_an_error_without_a_sqlstate_is_unavailable(database: Callable[..., Database]) -> None:
    database(OSError("connection refused"))
    with pytest.raises(RepositoryUnavailable):
        repo().find_handle("x")


def test_no_dsn_is_unavailable_without_connecting(database: Callable[..., Database]) -> None:
    db = database()
    for dsn in (None, ""):
        with pytest.raises(RepositoryUnavailable):
            PostgresAccountRepository(dsn).find_handle("x")
    assert db.connects == []


def test_failures_never_carry_the_dsn_or_the_library_text(
    database: Callable[..., Database],
) -> None:
    database(FakeDbError("23505"), FakeDbError("XX000"), OSError(f"could not connect: {DSN}"))
    for call in (
        lambda: register(repo()),
        lambda: repo().find_handle("x"),
        lambda: repo().bump_auth_epoch(USER),
    ):
        with pytest.raises(Exception) as raised:
            call()
        assert "SENTINEL" not in str(raised.value) + repr(raised.value)
        assert raised.value.__cause__ is None and raised.value.__suppress_context__
    assert "SENTINEL" not in repr(repo()) and "redacted" in repr(repo())


# --- the Protocol is honoured by both implementations ---------------------------------------------


def public_methods(cls: type) -> dict[str, inspect.Signature]:
    return {
        name: inspect.signature(member)
        for name, member in inspect.getmembers(cls, inspect.isfunction)
        if not name.startswith("_")
    }


def test_both_implementations_offer_every_protocol_method_with_the_same_signature() -> None:
    protocol = public_methods(AccountRepository)
    assert len(protocol) == 17
    postgres, memory = public_methods(PostgresAccountRepository), public_methods(InMemoryAccounts)
    for name, signature in protocol.items():
        assert str(postgres[name]) == str(signature), name
        assert str(memory[name]) == str(signature), name
