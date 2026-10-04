"""The usage ledger of supabase mode: rows through ``srv_record_ai_usage`` over the restricted
role, counters in process memory, and the rules that keep text and accounts out of both."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest

from app.repositories.ai_usage import (
    InMemoryUsageLedger,
    PostgresUsageLedger,
    UsageLedger,
    UsageRecord,
)
from tests.plan_chat.pc_supabase_support import DSN, UsageDatabase

NOW = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)
USER = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")
OTHER = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")
MIGRATION = (
    Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0005_rls_functions.sql"
)


def record(status: str = "succeeded", at: datetime = NOW, **values: object) -> UsageRecord:
    return UsageRecord("openrouter", "free/a:free", "plan-chat-v1", status, at, **values)  # type: ignore[arg-type]


def test_a_row_is_written_through_the_function_with_the_documented_arguments(
    usage_database: UsageDatabase,
) -> None:
    ledger = PostgresUsageLedger(DSN)
    ledger.record(
        record(input_tokens=11, output_tokens=4, cost_usd=0.0, quota_record={"reason": "timeout"}),
        account=USER,
    )
    (dsn, options) = usage_database.connects[0]
    assert dsn == DSN and options == {"connect_timeout": 5, "prepare_threshold": None}
    timeout, call = usage_database.statements
    assert timeout[0] == "set local statement_timeout = '5s'"
    assert call[0].startswith("select public.srv_record_ai_usage(")
    assert call[1] == (
        "openrouter",
        "free/a:free",
        "plan-chat-v1",
        11,
        4,
        Decimal("0.0"),
        "succeeded",
        '{"reason": "timeout"}',
    )


def test_unknown_values_stay_null_and_never_become_zero(usage_database: UsageDatabase) -> None:
    PostgresUsageLedger(DSN).record(record("rules_fallback"), account=USER)
    assert usage_database.writes == [
        ("openrouter", "free/a:free", "plan-chat-v1", None, None, None, "rules_fallback", None)
    ]


def test_the_statement_matches_the_signature_of_the_migration(
    usage_database: UsageDatabase,
) -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    found = re.search(r"create function public\.srv_record_ai_usage\((.*?)\)\s*returns", sql, re.S)
    assert found is not None
    declared = [tuple(part.split()) for part in found.group(1).split(",")]
    PostgresUsageLedger(DSN).record(record(), account=USER)
    statement = usage_database.statements[1][0]
    casts = re.findall(r"%s::(\w+)", statement)
    assert casts == [typ for _, typ in declared]
    assert len(usage_database.writes[0]) == len(declared) == 8


def test_no_account_and_no_text_reach_the_database(usage_database: UsageDatabase) -> None:
    PostgresUsageLedger(DSN).record(record(input_tokens=1, output_tokens=2), account=USER)
    sent = repr(usage_database.statements)
    assert str(USER) not in sent and "account" not in sent.lower()


def test_the_counters_are_those_of_the_memory_ledger(usage_database: UsageDatabase) -> None:
    postgres, memory = PostgresUsageLedger(DSN), InMemoryUsageLedger()
    for ledger in (postgres, memory):
        ledger.record(record("succeeded"), account=USER)
        ledger.record(record("failed", NOW + timedelta(seconds=5)), account=USER)
        ledger.record(record("timed_out", NOW + timedelta(seconds=10)), account=OTHER)
        ledger.record(record("rules_fallback", NOW + timedelta(seconds=15)), account=USER)
        ledger.record(record("succeeded", NOW - timedelta(days=1)), account=USER)
    later = NOW + timedelta(seconds=30)
    for who in (USER, OTHER):
        assert postgres.counts(who, later) == memory.counts(who, later)
    counts = postgres.counts(USER, later)
    assert (counts.global_day, counts.global_minute, counts.account_day) == (3, 3, 2)
    assert len(usage_database.writes) == 5  # every row is stored, only counted ones count


def test_an_invalid_status_is_refused_and_nothing_is_written(
    usage_database: UsageDatabase,
) -> None:
    with pytest.raises(ValueError):
        PostgresUsageLedger(DSN).record(record("exploded"), account=USER)
    assert usage_database.connects == []


def test_a_failed_write_is_logged_by_name_only_and_still_counted(
    usage_database: UsageDatabase, log_lines: list[str]
) -> None:
    usage_database.fail = RuntimeError(f"could not connect to server using {DSN}")
    ledger = PostgresUsageLedger(DSN)
    ledger.record(record(), account=USER)  # does not raise
    assert ledger.counts(USER, NOW).account_day == 1
    joined = "\n".join(log_lines)
    assert "ai_usage_write_failed" in joined and "SENTINEL" not in joined
    assert "db.sentinel-host" not in joined


def test_without_the_restricted_role_the_row_is_not_stored(
    usage_database: UsageDatabase, log_lines: list[str]
) -> None:
    ledger = PostgresUsageLedger(None)
    ledger.record(record(), account=USER)
    assert usage_database.connects == [] and ledger.counts(USER, NOW).global_day == 1
    assert "ai_usage_not_stored" in "\n".join(log_lines)


def test_the_repr_hides_the_connection_string() -> None:
    assert "SENTINEL" not in repr(PostgresUsageLedger(DSN))


def test_both_ledgers_satisfy_the_port() -> None:
    ledgers: list[UsageLedger] = [InMemoryUsageLedger(), PostgresUsageLedger(None)]
    assert all(hasattr(ledger, "record") and hasattr(ledger, "counts") for ledger in ledgers)
