from __future__ import annotations

import pytest

from app.repositories import ai_usage as ai_usage_module
from tests.plan_chat.pc_supabase_support import UsageDatabase


@pytest.fixture
def usage_database(monkeypatch: pytest.MonkeyPatch) -> UsageDatabase:
    """The restricted database connection of the usage ledger, faked: no test opens a socket."""
    database = UsageDatabase()
    monkeypatch.setattr(ai_usage_module.psycopg, "connect", database.connect)
    return database
