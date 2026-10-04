"""E20 through ``SessionService`` over the PostgREST adapters (fake PostgREST, no network).

The same request must give the same snapshot as memory mode; the writes are the RPC
``app_open_session`` and the status PATCH only; and no token, key or body leaks.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import SecretStr

from app.domain.learning_state import AttemptRecord, PartEvidence
from app.errors import AppError, ErrorCode
from app.repositories.bank import PostgrestBankRepository, PostgrestGateway
from app.repositories.learning import PostgrestLearningRepository
from app.services.sessions import PlanSnapshot, SessionService
from tests.sessions.ss_learning_support import Harness, mastery
from tests.sessions.ss_postgrest import ANON, TOKEN, FakePostgrest
from tests.sessions.ss_support import (
    HADITH_EDITION,
    NOW,
    PLAN_B_ID,
    PLAN_ID,
    QURAN,
    QURAN_EDITION,
    QURAN_PASSAGES,
    TODAY,
    USER,
    Env,
    FakePlanAccess,
    FixedCalendar,
    ctx,
    error_of,
    hadith_plan,
    quran_plan,
    steps_json,
)

DAILY = {"kind": "daily", "planId": str(PLAN_ID), "expectedPlanVersion": 2}
GAME = {"kind": "game", "planId": str(PLAN_ID), "expectedPlanVersion": 2}
PLACEMENT = {
    "kind": "placement",
    "editionId": str(QURAN_EDITION),
    "targetScope": {"sectionOrdinals": [1, 2, 3]},
    "selfRating": "some",
}


class PgEnv:
    """The service over the PostgREST repositories and a fake PostgREST."""

    def __init__(self, *, in_chunk: int = 40) -> None:
        self.fake = FakePostgrest()
        gateway = PostgrestGateway(
            "https://project.example", SecretStr(ANON), client=self.fake.client()
        )
        self.bank = PostgrestBankRepository(gateway, in_chunk=in_chunk)
        self.learning = PostgrestLearningRepository(gateway, in_chunk=in_chunk)
        self.plans = FakePlanAccess()
        self.plans.add(quran_plan())
        self.plans.add(hadith_plan())
        ids = iter(uuid.UUID(f"55555555-5555-4555-8555-{n:012d}") for n in range(1, 10_000))
        self.service = SessionService(
            bank=self.bank,
            learning=self.learning,
            plans=self.plans,
            calendar=FixedCalendar(),
            clock=lambda: NOW,
            new_id=lambda: next(ids),
        )
        self.harness = Harness("postgrest", self.learning, fake=self.fake)

    def create(self, body: dict[str, Any], *, token: str | None = TOKEN):
        context = ctx(token=token)
        return self.service.create_session(context, self.service.parse_request(body))


def seed_learner_state(*harnesses: Harness) -> None:
    """The same history in every harness: a due passage with an error part and some evidence, an
    attempt on one of its questions, and activity two days ago."""
    first = QURAN["passages"][0]
    parts = [UUID(p["id"]) for p in first["parts"]]
    recall = next(
        q
        for q in QURAN["questions"]
        if q["passageId"] == first["id"] and q["type"] == "word_recall"
    )
    for harness in harnesses:
        harness.seed_mastery(
            USER,
            mastery(QURAN_PASSAGES[0], next_review_due=TODAY, error_part_ids=(parts[1],)),
        )
        harness.seed_evidence(
            USER,
            PartEvidence(
                PLAN_ID, QURAN_PASSAGES[0], parts[0], UUID(int=3), TODAY - timedelta(days=3)
            ),
        )
        harness.seed_attempt(
            AttemptRecord(
                id=UUID(int=11),
                user_id=USER,
                session_id=UUID(int=1),
                edition_id=QURAN_EDITION,
                client_event_id=UUID(int=12),
                question_id=UUID(recall["id"]),
                passage_id=QURAN_PASSAGES[0],
                correct=True,
                assisted=False,
                duration_ms=900,
                occurred_at=datetime(2026, 10, 3, 8, tzinfo=UTC),
                created_at=datetime(2026, 10, 3, 8, 0, 1, tzinfo=UTC),
            )
        )
        harness.seed_daily(USER, TODAY - timedelta(days=2), 400_000)


# --- the same snapshot as memory mode ------------------------------------------------------------


@pytest.mark.parametrize("body", [DAILY, GAME, PLACEMENT], ids=["daily", "game", "placement"])
def test_a_postgrest_backed_session_equals_the_memory_backed_one(body: dict[str, Any]) -> None:
    memory, pg = Env(), PgEnv()
    expected, expected_created = memory.create(body)
    got = pg.create(body)
    assert got.created is expected_created is True
    assert got.snapshot == expected
    assert steps_json(got.snapshot) == steps_json(expected)


def test_the_same_holds_with_a_learners_history_shaping_the_session() -> None:
    memory, pg = Env(), PgEnv()
    seed_learner_state(Harness("memory", memory.store, store=memory.store), pg.harness)
    expected, _ = memory.create(DAILY)
    got = pg.create(DAILY)
    assert got.snapshot == expected
    steps = steps_json(got.snapshot)
    roles = [s["question"]["role"] for s in steps if s["type"] == "question"]
    assert roles[:2] == ["review", "review"]  # the due round leads, as the history demands
    assert "learn" in [s["type"] for s in steps]


def test_a_second_daily_call_reads_the_stored_session_and_writes_nothing() -> None:
    pg = PgEnv()
    first = pg.create(DAILY)
    second = pg.create(DAILY)
    assert (first.created, second.created) == (True, False)
    assert second.snapshot == first.snapshot
    assert len(pg.fake.rpc_bodies) == 1  # no second RPC, no second row
    assert len(pg.fake.tables["learning_sessions"]) == 1
    row = pg.fake.tables["learning_sessions"][0]
    assert row["steps"] == steps_json(first.snapshot)  # the stored snapshot is what is served


def test_the_rpc_carries_the_references_of_the_snapshot() -> None:
    pg = PgEnv()
    snapshot = pg.create(DAILY).snapshot
    (body,) = pg.fake.rpc_bodies
    assert body["p_session_id"] == str(snapshot.session_id) and body["p_kind"] == "daily"
    assert body["p_question_refs"] == [
        s["question"]["questionId"] for s in steps_json(snapshot) if s["type"] == "question"
    ]
    lesson = next(x for x in QURAN["lessons"] if x["passageId"] == QURAN["passages"][0]["id"])
    assert body["p_lesson_refs"] == [lesson["id"]]
    assert body["p_plan_version_id"] == str(quran_plan().plan_version_id)
    assert body["p_bank_version"] == 1


def test_a_placement_stores_no_plan_and_reads_no_learner_state() -> None:
    pg = PgEnv()
    created = pg.create(PLACEMENT)
    assert created.snapshot.plan_id is None
    row = pg.fake.tables["learning_sessions"][0]
    assert row["plan_id"] is None and row["plan_version_id"] is None
    assert row["self_rating"] == "some"
    for table in (
        "/attempts",
        "/target_mastery",
        "/target_part_evidence",
        "/daily_progress",
        "/plan_versions",
    ):
        assert not pg.fake.calls_to(table), table


def test_a_daily_session_reads_each_piece_of_learner_state_once() -> None:
    pg = PgEnv()
    seed_learner_state(pg.harness)
    pg.create(DAILY)
    for table in ("/target_mastery", "/target_part_evidence", "/daily_progress", "/attempts"):
        assert len(pg.fake.calls_to(table)) == 1, table
    assert len(pg.fake.requests) <= 30  # a handful of reads, not one per question


def test_only_the_rpc_and_the_status_patch_write() -> None:
    pg = PgEnv()
    pg.create(DAILY)
    pg.create(GAME)
    pg.create(PLACEMENT)
    other = pg.plans.add(hadith_plan(plan_id=PLAN_B_ID, paths=("matn",), session_minutes=5))
    pg.create({"kind": "daily", "planId": str(other.plan_id), "expectedPlanVersion": 2})
    pg.create(DAILY)  # retires the leftover of the other plan
    writes = {(r.method, r.url.path) for r in pg.fake.requests if r.method != "GET"}
    assert writes == {
        ("POST", "/rest/v1/rpc/app_open_session"),
        ("PATCH", "/rest/v1/learning_sessions"),
    }


# --- plan state through the adapters -------------------------------------------------------------


def test_a_leftover_daily_session_of_another_plan_is_retired_through_a_patch() -> None:
    pg = PgEnv()
    other = pg.plans.add(hadith_plan(plan_id=PLAN_B_ID, paths=("matn",), session_minutes=5))
    first = pg.create({"kind": "daily", "planId": str(other.plan_id), "expectedPlanVersion": 2})
    second = pg.create(DAILY)
    assert second.created is True and second.snapshot.plan_id == PLAN_ID
    assert pg.fake.patch_bodies == [{"status": "completed"}]
    rows = {r["id"]: r for r in pg.fake.tables["learning_sessions"]}
    assert rows[str(first.snapshot.session_id)]["status"] == "completed"
    assert rows[str(second.snapshot.session_id)]["status"] == "open"


class MovingPlans(FakePlanAccess):
    """The plan is revised while the session is being committed: the second read is version 3."""

    def __init__(self, plan: PlanSnapshot) -> None:
        super().__init__()
        self.add(plan)

    def load_for_session(self, ctx, plan_id):  # type: ignore[no-untyped-def]
        plan = super().load_for_session(ctx, plan_id)
        if self.calls > 1:
            self.update(plan_id, current_version=3)
            return super().load_for_session(ctx, plan_id)
        return plan


def test_a_plan_revised_during_the_commit_is_a_version_conflict_with_the_new_version() -> None:
    pg = PgEnv()
    pg.service._plans = MovingPlans(quran_plan())  # type: ignore[assignment]
    pg.fake.plan_version_in_force = str(uuid.UUID(int=4242))  # the function sees another version
    error = error_of(lambda: pg.create(DAILY))
    assert error.code is ErrorCode.version_conflict
    assert error.details == {"reason": "plan_version", "currentVersion": 3}
    assert pg.fake.tables["learning_sessions"] == []


def test_a_revoked_edition_is_never_served_and_nothing_else_is_read() -> None:
    pg = PgEnv()
    pg.create(DAILY)  # a stored session exists
    pg.fake.set_edition_status("revoked", str(QURAN_EDITION))
    before = len(pg.fake.requests)
    error = error_of(lambda: pg.create(DAILY))
    assert error.code is ErrorCode.validation_error
    assert error.details == {"fields": [{"field": "planId", "rule": "edition_not_available"}]}
    later = {r.url.path for r in pg.fake.requests[before:]}
    assert later <= {"/rest/v1/book_editions"}  # the edition read said no; no text was fetched
    placement = error_of(lambda: pg.create(PLACEMENT))
    assert placement.details["fields"][0]["field"] == "editionId"


def test_a_superseded_edition_still_serves_its_pinned_plan_but_not_a_placement() -> None:
    pg = PgEnv()
    pg.fake.set_edition_status("superseded", str(QURAN_EDITION))
    assert pg.create(DAILY).created is True
    assert error_of(lambda: pg.create(PLACEMENT)).code is ErrorCode.validation_error


def test_the_hadith_edition_flows_through_the_adapters_with_its_record() -> None:
    pg = PgEnv()
    memory = Env()
    body = {"kind": "daily", "planId": str(PLAN_B_ID), "expectedPlanVersion": 2}
    got = pg.create(body).snapshot
    assert got == memory.create(body)[0]
    learn = [s["passage"] for s in steps_json(got) if s["type"] == "learn"]
    assert learn[0]["takhrij"] and learn[0]["grade"]
    assert "hadeethenc.com" in learn[0]["source"]["url"]
    hadith = {
        "kind": "placement",
        "editionId": str(HADITH_EDITION),
        "targetScope": {"sectionOrdinals": [1, 2, 3, 4]},
    }
    assert pg.create(hadith).snapshot == memory.create(hadith)[0]


# --- credentials and failures --------------------------------------------------------------------


def test_the_session_needs_the_learners_token_and_an_expired_one_ends_it() -> None:
    pg = PgEnv()
    error = error_of(lambda: pg.create(DAILY, token=None))
    assert error.code is ErrorCode.unauthenticated and pg.fake.requests == []
    pg.fake.token = "a-newer-token"  # the stored token is no longer accepted
    assert error_of(lambda: pg.create(DAILY)).code is ErrorCode.unauthenticated


@pytest.mark.parametrize(
    "fragment",
    ["/book_editions", "/passages", "/question_items", "/target_mastery", "rpc/app_open_session"],
)
def test_a_failing_dependency_is_unavailable_and_stores_nothing(fragment: str) -> None:
    pg = PgEnv()
    pg.fake.fail(fragment, lambda request: httpx.Response(503, text="down"))
    assert error_of(lambda: pg.create(DAILY)).code is ErrorCode.unavailable
    assert pg.fake.tables["learning_sessions"] == []
    assert pg.create(DAILY).created is True  # and the next try works


def test_a_dropped_connection_is_unavailable() -> None:
    pg = PgEnv()

    def drop(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset")

    pg.fake.fail("/units", drop)
    assert error_of(lambda: pg.create(DAILY)).code is ErrorCode.unavailable
    assert pg.fake.tables["learning_sessions"] == []


def test_every_request_is_the_learners_and_nothing_secret_is_logged(log_lines: list[str]) -> None:
    pg = PgEnv()
    seed_learner_state(pg.harness)
    pg.create(DAILY)
    pg.create(GAME)
    pg.create(PLACEMENT)
    pg.fake.fail("/units", lambda request: httpx.Response(500, json={"message": f"x {TOKEN}"}))
    with pytest.raises(AppError):
        pg.create(GAME)  # a game always reads units, so the injected failure is hit
    assert {r.headers["authorization"] for r in pg.fake.requests} == {f"Bearer {TOKEN}"}
    assert {r.headers["apikey"] for r in pg.fake.requests} == {ANON}
    text = "\n".join(log_lines)
    assert "postgrest_failure" in text
    for secret in (TOKEN, ANON, QURAN["units"][0]["canonicalText"], str(USER)):
        assert secret not in text
