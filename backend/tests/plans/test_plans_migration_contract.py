"""The backend reads and calls only what the migrations define.

A mocked HTTP layer cannot notice a misspelt column or argument name, so these tests read the
SQL of ``supabase/migrations`` (0001-0006) and compare it with what B4 sends: the named arguments
of ``app_create_plan``, ``app_revise_plan`` and ``app_resume_plan``, the columns it selects, the
catalog view columns, the SQLSTATEs it maps and the name of the one-active-plan index. They are
skipped when the migrations folder is not part of the checkout (for example in a backend-only
build). They do not prove that the functions work: nothing was run against a database.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.providers.postgrest import SIGNAL_CODES
from app.repositories.catalog import EDITION_COLUMNS, PASSAGE_COLUMNS, SECTION_COLUMNS
from app.repositories.plans import (
    ACTIVE_PLAN_CONSTRAINT,
    IN_FORCE_PLAN_COLUMNS,
    IN_FORCE_VERSION_COLUMNS,
    PLAN_COLUMNS,
)
from tests.plans.fake_postgrest import CREATE_OPTIONAL, CREATE_REQUIRED, REVISE_ARGS

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"

pytestmark = pytest.mark.skipif(
    not MIGRATIONS.is_dir(), reason="supabase/migrations is not part of this checkout"
)


@pytest.fixture(scope="module")
def sql() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(MIGRATIONS.glob("*.sql")))


def table_columns(sql: str, table: str) -> set[str]:
    block = re.search(rf"create table {re.escape(table)} \((.*?)\n\);", sql, re.DOTALL)
    assert block, f"{table} is not created by the migrations"
    columns = set()
    for line in block.group(1).splitlines():
        match = re.match(r"  ([a-z_][a-z0-9_]*)\s+\S", line)
        if match and match.group(1) not in {"constraint", "primary", "foreign", "unique", "check"}:
            columns.add(match.group(1))
    return columns


def view_aliases(sql: str, view: str) -> set[str]:
    block = re.search(rf"create view {re.escape(view)}\b(.*?)\nwhere ", sql, re.DOTALL)
    assert block, f"{view} is not created by the migrations"
    return set(re.findall(r"\bas\s+([a-z_][a-z0-9_]*)\b", block.group(1)))


def function_parameters(sql: str, name: str) -> tuple[set[str], set[str]]:
    """``(required, optional)`` parameter names of ``public.<name>``."""
    match = re.search(rf"create function public\.{name}\((.*?)\)\s*returns", sql, re.DOTALL)
    assert match, f"{name} is not created by the migrations"
    required: set[str] = set()
    optional: set[str] = set()
    for part in re.split(r",\s*\n", match.group(1)):
        part = part.strip()
        if not part:
            continue
        (optional if re.search(r"\bdefault\b", part) else required).add(part.split()[0])
    return required, optional


def function_body(sql: str, name: str) -> str:
    match = re.search(rf"create function public\.{name}\(.*?\n\$\$;", sql, re.DOTALL)
    assert match, f"{name} is not created by the migrations"
    return match.group(0)


def test_app_create_plan_arguments(sql: str) -> None:
    required, optional = function_parameters(sql, "app_create_plan")
    assert required == CREATE_REQUIRED
    assert optional == CREATE_OPTIONAL


def test_app_revise_plan_arguments(sql: str) -> None:
    required, optional = function_parameters(sql, "app_revise_plan")
    assert required == REVISE_ARGS and optional == set()


def test_app_resume_plan_arguments(sql: str) -> None:
    required, optional = function_parameters(sql, "app_resume_plan")
    assert required == {"p_plan"} and optional == set()


def test_the_functions_signal_what_the_repository_maps(sql: str) -> None:
    revise = function_body(sql, "app_revise_plan")
    assert "errcode = 'QT002'" in revise and "errcode = 'no_data_found'" in revise
    resume = function_body(sql, "app_resume_plan")
    assert "errcode = 'QT003'" in resume and "errcode = 'no_data_found'" in resume
    for body in (revise, resume, function_body(sql, "app_create_plan")):
        assert "errcode = 'insufficient_privilege'" in body
    assert {"QT002", "QT003", "P0002", "23505"} <= SIGNAL_CODES
    assert "QT002" in sql and "QT003" in sql
    # PostgREST reports no_data_found with its SQLSTATE
    assert re.search(r"P0002\s+no_data_found", sql) or "no_data_found" in sql


def test_the_one_active_plan_index_has_the_name_the_repository_expects(sql: str) -> None:
    assert re.search(
        rf"create unique index {ACTIVE_PLAN_CONSTRAINT}\s+on public\.master_plans \(user_id\)\s+"
        r"where status = 'active'",
        sql,
    )


def test_the_catalog_view_columns_exist(sql: str) -> None:
    assert set(EDITION_COLUMNS.split(",")) <= view_aliases(sql, "public.catalog_editions")
    assert set(SECTION_COLUMNS.split(",")) <= view_aliases(sql, "public.catalog_sections")
    sections = re.search(r"create view public\.catalog_sections.*?\nwhere ", sql, re.DOTALL)
    assert sections and "jsonb_build_object('words'" in sections.group(0)
    assert "'passages', x.passages" in sections.group(0)


@pytest.mark.parametrize(
    "table,columns",
    [
        ("public.passages", PASSAGE_COLUMNS.split(",")),
        (
            "public.master_plans",
            PLAN_COLUMNS.split(",book_editions(")[0].split(",") + ["user_id"],
        ),
        ("public.plan_versions", ["policy_json", "plan_id", "user_id", "version_no"]),
        (
            "public.master_plans",
            IN_FORCE_PLAN_COLUMNS.split(",book_editions(")[0].split(",") + ["user_id"],
        ),
        (
            "public.plan_versions",
            IN_FORCE_VERSION_COLUMNS.split(",") + ["plan_id", "user_id", "effective_learning_date"],
        ),
        ("public.book_editions", ["bank_version"]),
        ("public.books", ["title_ar", "title_en"]),
        ("public.profiles", ["user_id", "time_zone", "pending_settings"]),
        ("public.learning_sessions", ["id", "edition_id", "user_id", "kind"]),
        ("public.attempts", ["passage_id", "session_id", "user_id", "correct", "assisted"]),
    ],
)
def test_the_selected_columns_exist(sql: str, table: str, columns: list[str]) -> None:
    missing = set(columns) - table_columns(sql, table)
    assert not missing, f"{table} has no column {sorted(missing)}"


def test_the_plan_read_embeds_the_book_through_the_edition(sql: str) -> None:
    """``book_editions(books(...))``: master_plans -> book_editions -> books are single foreign
    keys, so PostgREST resolves the embedding without a hint."""
    assert "foreign key (edition_id) references public.book_editions (id)" in sql
    assert re.search(
        r"book_editions_book_id_fkey\s+foreign key \(book_id\) references public\.books", sql
    )


def test_the_learner_may_read_what_the_repositories_select(sql: str) -> None:
    grants = sql.split("-- 3.3 authenticated")[1].split("-- 3.5 qatra_server")[0]
    for table in (
        "public.books",
        "public.passages",
        "public.master_plans",
        "public.plan_versions",
        "public.profiles",
        "public.learning_sessions",
        "public.attempts",
    ):
        assert table in grants, f"authenticated has no select grant on {table}"
    assert "grant select (" in grants and "id, book_id" in grants  # book_editions columns
    assert "bank_version" in grants.split("public.book_editions")[0].rsplit("grant select (", 1)[1]


def test_the_in_force_read_embeds_the_edition_through_one_foreign_key(sql: str) -> None:
    """``book_editions(bank_version)`` needs no hint: master_plans has a single key to it."""
    assert IN_FORCE_PLAN_COLUMNS.endswith("book_editions(bank_version)")
    assert sql.count("foreign key (edition_id) references public.book_editions (id)") >= 1
