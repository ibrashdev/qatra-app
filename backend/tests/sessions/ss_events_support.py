"""A world for the E18 to E22 tests: one scenario runs over the memory repositories and over the
PostgREST adapters (the fake PostgREST of ``ss_postgrest``), so both modes must give the same
answers. Synthetic bundles only, no network, no Arabic text of its own.

``World`` wires ``SessionService`` and ``ProgressService`` with a fake plan port (it enforces
ownership like B4 does), a calendar with a settable date and a clock that tests move. Reads go
through the public repository methods, so they work in both modes; seeding and the raw rows are
mode specific and hidden behind the same names.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.contracts_plan_chat import Estimate, Plan, PlannerInfo, TargetScope
from app.dependencies import SessionContext, require_session
from app.domain.learning_state import (
    ActivityInterval,
    AttemptRecord,
    DailyProgressRow,
    PartEvidence,
    PassageMastery,
)
from app.main import create_app
from app.repositories.bank import InMemoryBankRepository, PostgrestBankRepository
from app.repositories.learning import (
    InMemoryLearningStore,
    PostgrestLearningRepository,
    StoredSession,
)
from app.repositories.plans import LearningZone, PostgrestPlacementReader
from app.routers.sessions import install_sessions
from app.services.progress import PlanEntry, ProgressService
from app.services.sessions import PlanSnapshot, SessionService
from tests.sessions.ss_postgrest import TOKEN, FakePostgrest
from tests.sessions.ss_support import (
    HADITH,
    NOW,
    OTHER_USER,
    PLAN_ID,
    QURAN,
    QURAN_EDITION,
    QURAN_PASSAGES,
    TODAY,
    USER,
    FakePlanAccess,
    FixedCalendar,
    ctx,
    hadith_plan,
    quran_plan,
)
from tests.support import FRONTEND_ORIGIN, make_settings

MODES = ("memory", "postgrest")
QUESTION_ROWS: dict[str, dict[str, Any]] = {
    q["id"]: q for bundle in (QURAN, HADITH) for q in bundle["questions"]
}
PART_IDS: dict[str, list[UUID]] = {
    p["id"]: [UUID(part["id"]) for part in p["parts"]]
    for bundle in (QURAN, HADITH)
    for p in bundle["passages"]
}
GOAL_MS = 600_000  # the Quran plan of ``quran_plan`` has 10 session minutes
BASE = NOW  # sessions are created at 07:00:00 UTC on 2026-10-05 (11:00 in Dubai)


class Clock:
    """The server clock of a test; ``advance`` moves it."""

    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


class ZoneCalendar(FixedCalendar):
    """A calendar that also knows the zone of the account (Asia/Dubai, UTC+4) and counts reads."""

    def __init__(self, today: date = TODAY) -> None:
        super().__init__(today)
        self.zone = LearningZone("Asia/Dubai")
        self.zone_reads = 0

    def learning_zone(self, ctx: SessionContext) -> LearningZone:
        self.zone_reads += 1
        return self.zone


def plan_of(snapshot: PlanSnapshot, *, pending: int | None = None) -> Plan:
    """The ``Plan`` DTO of a plan snapshot, with placeholder titles."""
    scope = TargetScope(section_ordinals=list(snapshot.section_ordinals))
    estimate = Estimate(
        days=10,
        end_date=date(2026, 10, 15),
        new_words_per_day=12,
        total_words=100,
        known_words=0,
        passage_count=4,
        session_minutes=snapshot.session_minutes,
        scope=scope,
        paths=list(snapshot.paths),  # type: ignore[arg-type]
    )
    return Plan(
        plan_id=snapshot.plan_id,
        edition_id=snapshot.edition_id,
        title_ar="title-ar",
        title_en="title-en",
        target_scope=scope,
        paths=list(snapshot.paths),  # type: ignore[arg-type]
        order=snapshot.order,
        session_minutes=snapshot.session_minutes,
        preferred_date=None,
        agreed_estimate=estimate,
        current_version=snapshot.current_version,
        status=snapshot.status,
        created_at=NOW,
        pending_session_minutes=pending,  # type: ignore[arg-type]
        planner=PlannerInfo(source="rules"),
    )


class FakeDirectory:
    """The ``PlanDirectory`` port over the fake plan port."""

    def __init__(self, plans: FakePlanAccess) -> None:
        self._plans = plans
        self.pending: dict[UUID, int] = {}

    def list_plans(self, ctx: SessionContext) -> list[PlanEntry]:
        return [
            PlanEntry(plan_of(plan, pending=self.pending.get(plan.plan_id)), plan)
            for plan in self._plans.owned_by(ctx.user_id)
        ]


@dataclass
class Opened:
    """A session as the learner got it: the id, the JSON snapshot and its question steps."""

    id: UUID
    json: dict[str, Any]
    questions: list[dict[str, Any]]

    def of(
        self, *, role: str | None = None, type: str | None = None, passage: UUID | None = None
    ) -> list[dict[str, Any]]:
        return [
            q
            for q in self.questions
            if (role is None or q["role"] == role)
            and (type is None or q["type"] == type)
            and (passage is None or q["passageId"] == str(passage))
        ]


def parts_covered_by(question: dict[str, Any]) -> list[UUID]:
    return [UUID(part) for part in QUESTION_ROWS[question["questionId"]]["coveredPartIds"]]


def target_word(question: dict[str, Any]) -> str:
    """The verbatim text of a recall question's target token, read from the Quran bundle."""
    ordinal, index = (
        int(n) for n in QUESTION_ROWS[question["questionId"]]["tokenRefs"][0].split(":")
    )
    unit = next(u for u in QURAN["units"] if u["ordinal"] == ordinal)
    token = unit["tokens"][index]
    return str(unit["canonicalText"][token["s"] : token["e"]])


def expected_of(question: dict[str, Any]) -> dict[str, Any]:
    """The ``expected`` object E21 must report for a question."""
    key = question["answerKey"]
    if question["type"] == "word_order":
        return {"order": list(key["order"])}
    if question["type"] == "word_recall":
        return {"word": target_word(question)}
    return {"optionId": key["optionId"]}


def correct_answer(question: dict[str, Any]) -> dict[str, Any]:
    key = question["answerKey"]
    if question["type"] == "word_order":
        return {"order": list(key["order"])}
    if question["type"] == "word_recall":
        return {"text": key["acceptedNorms"][0]}
    return {"optionId": key["optionId"]}


def wrong_answer(question: dict[str, Any]) -> dict[str, Any]:
    key = question["answerKey"]
    if question["type"] == "word_order":
        return {"order": list(reversed(key["order"]))}
    if question["type"] == "word_recall":
        return {"text": "zzzz"}
    other = next(o for o in question["options"] if o["optionId"] != key["optionId"])
    return {"optionId": other["optionId"]}


def answer_event(
    question: dict[str, Any],
    *,
    ok: bool = True,
    hint: bool = False,
    event_id: UUID | None = None,
    at: datetime | None = None,
    duration_ms: int = 3000,
    **envelope: Any,
) -> dict[str, Any]:
    return {
        "clientEventId": str(event_id or uuid.uuid4()),
        "type": "answer",
        "questionId": question["questionId"],
        "answer": correct_answer(question) if ok else wrong_answer(question),
        "hintUsed": hint,
        "occurredAt": (at or BASE + timedelta(minutes=1)).isoformat(),
        "durationMs": duration_ms,
        **envelope,
    }


def activity_event(
    start_s: float,
    end_s: float,
    *,
    active_ms: int | None = None,
    event_id: UUID | None = None,
    base: datetime = BASE,
    **envelope: Any,
) -> dict[str, Any]:
    return {
        "clientEventId": str(event_id or uuid.uuid4()),
        "type": "activity",
        "startedAt": (base + timedelta(seconds=start_s)).isoformat(),
        "endedAt": (base + timedelta(seconds=end_s)).isoformat(),
        "activeMs": int((end_s - start_s) * 1000) if active_ms is None else active_ms,
        **envelope,
    }


def envelope_of(opened: Opened, **overrides: Any) -> dict[str, Any]:
    """A complete offline envelope that matches the session's pinned values."""
    snapshot = opened.json
    values: dict[str, Any] = {
        "clientRunId": str(uuid.uuid4()),
        "snapshotId": str(OFFLINE_SNAPSHOT),
        "protocolVersion": 1,
        "planVersion": snapshot["planVersion"],
        "editionId": snapshot["editionId"],
        "bankVersion": snapshot["bankVersion"],
        "normalizationPolicyVersion": "arabic-norm-v1",
        "scoringPolicyVersion": "v1",
        "localSequence": 0,
    }
    values.update(overrides)
    return values


OFFLINE_SNAPSHOT = uuid.UUID("12121212-1212-4212-8212-121212121212")


class World:
    """The services over one backend (``memory`` or ``postgrest``) with everything reachable."""

    def __init__(
        self, mode: str = "memory", *, bundles: Sequence[dict[str, Any]] = (QURAN, HADITH)
    ):
        self.mode = mode
        self.clock = Clock()
        self.calendar = ZoneCalendar()
        self.plans = FakePlanAccess()
        self.plans.add(quran_plan())
        self.plans.add(hadith_plan())
        self.store: InMemoryLearningStore | None = None
        self.fake: FakePostgrest | None = None
        if mode == "memory":
            self.bank = InMemoryBankRepository(bundles)
            self.store = InMemoryLearningStore(clock=self.clock)
            self.learning: Any = self.store
            self.ctx = ctx()
        else:
            self.fake = FakePostgrest(bundles)
            client = self.fake.client()
            self.bank = PostgrestBankRepository(client)  # type: ignore[assignment]
            self.learning = PostgrestLearningRepository(client)
            self.ctx = ctx(token=TOKEN)
        ids = iter(uuid.UUID(f"55555555-5555-4555-8555-{n:012d}") for n in range(1, 10_000))
        self.service = SessionService(
            bank=self.bank,
            learning=self.learning,
            plans=self.plans,
            calendar=self.calendar,
            clock=self.clock,
            new_id=lambda: next(ids),
        )
        self.directory = FakeDirectory(self.plans)
        self.progress = ProgressService(
            bank=self.bank, learning=self.learning, plans=self.directory, calendar=self.calendar
        )

    # -- the application ------------------------------------------------------------------------

    def app(
        self,
        *,
        login: bool = True,
        open_chat_lookup: Callable[[SessionContext], UUID | None] | None = None,
        **settings: Any,
    ) -> FastAPI:
        """A real application (``create_app``) whose sessions and progress routes run over this
        world's repositories, plan port, calendar and clock. ``login`` fakes the session of the
        caller (a TEST-ONLY shortcut, never a real cookie); ``open_chat_lookup`` is the seam of
        ``Today.openPlanChatId``."""
        app_settings = make_settings(**settings)
        app = create_app(app_settings)
        install_sessions(
            app,
            app_settings,
            plans=self.plans,
            calendar=self.calendar,
            bank=self.bank,
            learning=self.learning,
            clock=self.clock,
            new_id=self.service._new_id,
            plan_directory=self.directory,
            open_chat_lookup=open_chat_lookup,
        )
        if login:
            app.dependency_overrides[require_session] = lambda: self.ctx
        return app

    def client(self, *, login: bool = True, **options: Any) -> TestClient:
        """A browser-like client of ``app``: it sends the allowed ``Origin`` header."""
        return TestClient(self.app(login=login, **options), headers={"Origin": FRONTEND_ORIGIN})

    # -- sessions ------------------------------------------------------------------------------

    def open(
        self,
        kind: str = "daily",
        *,
        plan_id: UUID = PLAN_ID,
        version: int = 2,
        advance_minutes: float = 10,
        **extra: Any,
    ) -> Opened:
        """Create a session now, then let ``advance_minutes`` pass so that events follow it."""
        if kind == "placement":
            body = {
                "kind": "placement",
                "editionId": str(QURAN_EDITION),
                "targetScope": {"sectionOrdinals": [1, 2, 3]},
                **extra,
            }
        else:
            body = {"kind": kind, "planId": str(plan_id), "expectedPlanVersion": version, **extra}
        created = self.service.create_session(self.ctx, self.service.parse_request(body))
        self.clock.advance(minutes=advance_minutes)
        snapshot = json.loads(created.snapshot.model_dump_json(by_alias=True))
        questions = [s["question"] for s in snapshot["steps"] if s["type"] == "question"]
        return Opened(created.snapshot.session_id, snapshot, questions)

    def game(self, passage: UUID | None = None, **extra: Any) -> Opened:
        if passage is not None:
            extra["passageIds"] = [str(passage)]
        return self.open("game", **extra)

    def post(self, session: Opened | UUID, events: list[dict[str, Any]]) -> dict[str, Any]:
        session_id = session.id if isinstance(session, Opened) else session
        response = self.service.record_events(self.ctx, session_id, {"events": events})
        return json.loads(response.model_dump_json(by_alias=True))

    def complete(self, session: Opened | UUID) -> dict[str, Any]:
        session_id = session.id if isinstance(session, Opened) else session
        response = self.service.complete_session(self.ctx, session_id)
        return json.loads(response.model_dump_json(by_alias=True))

    def today(self) -> dict[str, Any]:
        return json.loads(self.progress.read_today(self.ctx).model_dump_json(by_alias=True))

    def progress_view(self) -> dict[str, Any]:
        return json.loads(self.progress.read_progress(self.ctx).model_dump_json(by_alias=True))

    # -- reads (public repository methods, so both modes agree) -----------------------------------

    def mastery(self, passage: UUID, plan_id: UUID = PLAN_ID) -> PassageMastery | None:
        return self.learning.mastery_for_plan(self.ctx, plan_id).get(passage)

    def covered(self, plan_id: UUID = PLAN_ID) -> frozenset[UUID]:
        return self.learning.covered_parts(self.ctx, plan_id)

    def attempts(self, session: Opened | UUID) -> list[AttemptRecord]:
        session_id = session.id if isinstance(session, Opened) else session
        return self.learning.attempts_for_session(self.ctx, session_id)

    def intervals(self, day: date) -> list[ActivityInterval]:
        return self.learning.intervals_for_date(self.ctx, day)

    def daily_row(self, day: date) -> DailyProgressRow | None:
        rows = self.learning.daily_progress_between(self.ctx, day, day)
        return rows[0] if rows else None

    def completed_days(self, start: date, end: date) -> frozenset[date]:
        return self.learning.completion_dates(self.ctx, start, end)

    def known_by_placement_reader(self, session: Opened | UUID) -> frozenset[UUID]:
        """The passages the placement reader of E15 and E16 finds known in a placement session."""
        session_id = session.id if isinstance(session, Opened) else session
        if self.store is not None:
            return self.store.known_passage_ids(self.ctx, session_id, QURAN_EDITION)
        assert self.fake is not None
        reader = PostgrestPlacementReader(self.fake.client())
        return reader.known_passage_ids(self.ctx, session_id, QURAN_EDITION)

    def session_row(self, session: Opened | UUID):
        session_id = session.id if isinstance(session, Opened) else session
        return self.learning.read_session(self.ctx, session_id)

    # -- seeding ----------------------------------------------------------------------------------

    def seed_mastery(self, row: PassageMastery) -> None:
        """Set the state of a passage (a second call replaces the first)."""
        if self.store is not None:
            self.store.put_mastery(USER, row)
        else:
            assert self.fake is not None
            rows = self.fake.tables["target_mastery"]
            rows[:] = [
                r
                for r in rows
                if (r["plan_id"], r["passage_id"]) != (str(row.plan_id), str(row.passage_id))
            ]
            rows.append(
                {"user_id": str(USER), "edition_id": str(QURAN_EDITION), **row.to_payload()}
            )

    def seed_evidence(self, passage: UUID, parts: Sequence[UUID], *, day: date = TODAY) -> None:
        for part in parts:
            row = PartEvidence(PLAN_ID, passage, part, uuid.uuid4(), day)
            if self.store is not None:
                self.store.put_evidence(USER, row)
            else:
                assert self.fake is not None
                self.fake.tables["target_part_evidence"].append(
                    {"user_id": str(USER), "attempt_id": str(row.attempt_id), **row.to_payload()}
                )

    def seed_daily(self, day: date, active_ms: int, goal_ms: int = GOAL_MS) -> None:
        if self.store is not None:
            self.store.put_daily_progress(DailyProgressRow(USER, day, active_ms, goal_ms))
        else:
            assert self.fake is not None
            self.fake.tables["daily_progress"].append(
                {
                    "user_id": str(USER),
                    "learning_date": day.isoformat(),
                    "active_ms": active_ms,
                    "goal_ms": goal_ms,
                }
            )

    def seed_completion(self, day: date, plan_id: UUID = PLAN_ID) -> None:
        if self.store is not None:
            self.store.put_completion(USER, day, plan_id)
        else:
            assert self.fake is not None
            self.fake.tables["daily_completions"].append(
                {
                    "user_id": str(USER),
                    "learning_date": day.isoformat(),
                    "reached_in_plan_id": str(plan_id),
                    "completed_at": NOW.isoformat(),
                }
            )

    def seed_foreign_session(self, session_id: UUID) -> None:
        """An open game session of another account, which the caller must never reach."""
        if self.store is not None:
            self.store.sessions[session_id] = StoredSession(
                id=session_id,
                user_id=OTHER_USER,
                plan_id=None,
                plan_version_id=None,
                plan_version=None,
                edition_id=QURAN_EDITION,
                kind="game",
                learning_date=TODAY,
                lesson_refs=(),
                question_refs=(),
                steps=[],
                bank_version=1,
                status="open",
                created_at=NOW,
            )
        else:
            assert self.fake is not None
            self.fake.tables["learning_sessions"].append(
                {
                    "id": str(session_id),
                    "user_id": str(OTHER_USER),
                    "plan_id": None,
                    "plan_version_id": None,
                    "edition_id": str(QURAN_EDITION),
                    "kind": "game",
                    "learning_date": TODAY.isoformat(),
                    "lesson_refs": [],
                    "question_refs": [],
                    "steps": [],
                    "bank_version": 1,
                    "self_rating": None,
                    "status": "open",
                    "elapsed_ms": 0,
                    "offline_snapshot_id": None,
                    "created_at": NOW.isoformat(),
                }
            )

    def make_offline(self, session: Opened, *, status: str = "prepared") -> None:
        """Turn an open session into an offline-prepared one (as E23 will create it)."""
        if self.store is not None:
            stored = self.store.sessions[session.id]
            self.store.sessions[session.id] = replace(
                stored, status=status, offline_snapshot_id=OFFLINE_SNAPSHOT
            )
        else:
            assert self.fake is not None
            row = next(
                r for r in self.fake.tables["learning_sessions"] if r["id"] == str(session.id)
            )
            row.update(status=status, offline_snapshot_id=str(OFFLINE_SNAPSHOT))

    def drop_question(self, question: dict[str, Any]) -> None:
        """Remove a question from the bank, as if the pinned bank could not verify it any more."""
        question_id = question["questionId"]
        if self.mode == "memory":
            data = self.bank._editions[QURAN_EDITION]  # type: ignore[attr-defined]
            data.questions = tuple(q for q in data.questions if str(q.id) != question_id)
        else:
            assert self.fake is not None
            rows = self.fake.tables["question_items"]
            rows[:] = [r for r in rows if r["id"] != question_id]

    def revoke_edition(self) -> None:
        if self.mode == "memory":
            self.bank.set_status(QURAN_EDITION, "revoked")  # type: ignore[attr-defined]
        else:
            assert self.fake is not None
            self.fake.set_edition_status("revoked", str(QURAN_EDITION))


def due_row(passage: UUID, **fields: Any) -> PassageMastery:
    """A passage on the ladder at stage 1, due on the learning date of the tests."""
    values: dict[str, Any] = {
        "plan_id": PLAN_ID,
        "passage_id": passage,
        "status": "reviewing",
        "consecutive_correct": 3,
        "initial_success_at": datetime(2026, 10, 4, 8, tzinfo=UTC),
        "initial_learning_date": date(2026, 10, 4),
        "review_stage": 1,
        "next_review_due": TODAY,
    }
    values.update(fields)
    return PassageMastery(**values)


FIRST_PASSAGE = QURAN_PASSAGES[0]  # 4 parts, 12 words
SECOND_PASSAGE = QURAN_PASSAGES[1]  # 6 parts, 23 words
