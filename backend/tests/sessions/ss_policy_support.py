"""Hand-built, synthetic fixtures for the pure session-policy tests (no text, no database).

``passage(...)`` makes a ``PassageInfo`` with parts of the given word counts; ``questions_for``
makes bank questions per part and type. Ids are deterministic (UUIDv5 over readable labels), so a
failing assertion names what went wrong.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from uuid import UUID

from app.domain.learning_state import PassageMastery
from app.domain.session_policy import (
    DailyComposition,
    DailyInputs,
    PartInfo,
    PassageData,
    PassageInfo,
    PassageLoader,
    PlannedLearn,
    PlannedQuestion,
    QuestionInfo,
    compose_daily,
)

_NS = uuid.UUID("5e55a1ab-0000-4000-8000-000000000b05")
PLAN = uuid.uuid5(_NS, "plan")
SESSION = uuid.uuid5(_NS, "session")
TODAY = date(2026, 10, 5)
SEED = 6  # review_game_type(6) is word_choice: every part of full_bank has one

NAMES: dict[UUID, str] = {}


def uid(*label: object) -> UUID:
    return uuid.uuid5(_NS, "/".join(str(item) for item in label))


def passage(
    name: str,
    *,
    section: int = 1,
    path: str = "quran",
    words: Sequence[int] = (4, 4, 4),
    start: tuple[int, int] | None = None,
    ordinal: int = 1,
) -> PassageInfo:
    """A passage whose parts have the given word counts (``len(words)`` parts)."""
    parts = tuple(
        PartInfo(id=uid(name, "part", n), ordinal=n, word_count=count)
        for n, count in enumerate(words, start=1)
    )
    NAMES[uid(name)] = name
    return PassageInfo(
        id=uid(name),
        section_ordinal=section,
        path=path,
        ordinal=ordinal,
        start=start or (section * 100 + ordinal, 0),
        word_count=sum(words),
        parts=parts,
    )


def part_id(passage_: PassageInfo, ordinal: int) -> UUID:
    return passage_.parts[ordinal - 1].id


def question(
    passage_: PassageInfo,
    label: str,
    kind: str,
    parts: Sequence[int] = (1,),
    variant: str | None = None,
) -> QuestionInfo:
    return QuestionInfo(
        id=uid(passage_.id, "q", label),
        passage_id=passage_.id,
        type=kind,
        variant=variant,
        covered_part_ids=tuple(passage_.parts[n - 1].id for n in parts),
    )


def full_bank(passage_: PassageInfo, *, extra_choice: int = 1) -> list[QuestionInfo]:
    """Per part one question of each of word_choice, word_recall and word_order, plus
    ``extra_choice`` additional word_choice questions per part."""
    questions: list[QuestionInfo] = []
    for n in range(1, len(passage_.parts) + 1):
        questions.append(question(passage_, f"c{n}", "word_choice", (n,), "word"))
        questions.append(question(passage_, f"r{n}", "word_recall", (n,), "keyword"))
        questions.append(question(passage_, f"o{n}", "word_order", (n,)))
        for extra in range(extra_choice):
            questions.append(question(passage_, f"c{n}x{extra}", "word_choice", (n,), "segment"))
    return questions


def loader(
    banks: Mapping[UUID, Sequence[QuestionInfo]],
    *,
    last_tested: Mapping[UUID, datetime] | None = None,
    last_type: Mapping[UUID, str] | None = None,
    calls: list[list[UUID]] | None = None,
):
    """A ``PassageLoader`` over ``banks``; every call is recorded in ``calls`` when given."""

    def load(passage_ids: Sequence[UUID]) -> PassageData:
        if calls is not None:
            calls.append(list(passage_ids))
        return PassageData(
            questions={pid: tuple(banks.get(pid, ())) for pid in passage_ids},
            last_tested=dict(last_tested or {}),
            last_type=dict(last_type or {}),
        )

    return load


def at(day: int, hour: int = 8) -> datetime:
    return datetime(2026, 9, day, hour, tzinfo=UTC)


def mastery(
    passage_: PassageInfo,
    status: str = "reviewing",
    *,
    due: date | None = None,
    errors: Sequence[int] = (),
    initial: date | None = None,
    **fields: object,
) -> PassageMastery:
    """A consistent mastery row for ``passage_`` (reviewing rows get stage 1 and an initial
    success; ``initial`` sets ``initial_learning_date``)."""
    started = initial or date(2026, 9, 1)
    base: dict[str, object] = {
        "plan_id": PLAN,
        "passage_id": passage_.id,
        "status": status,
        "error_part_ids": tuple(passage_.parts[n - 1].id for n in errors),
        "next_review_due": due,
    }
    if status in ("reviewing", "confirmed", "needs_refresh"):
        base.update(
            initial_success_at=datetime(started.year, started.month, started.day, 9, tzinfo=UTC),
            initial_learning_date=started,
            review_stage=1,
        )
    if status == "confirmed":
        confirmed = datetime(2026, 9, 20, 9, tzinfo=UTC)
        base.update(confirmed_at=confirmed, first_confirmed_at=confirmed, review_stage=3)
    if status == "needs_refresh":
        base.update(first_confirmed_at=datetime(2026, 9, 20, 9, tzinfo=UTC))
    base.update(fields)
    return PassageMastery(**base)  # type: ignore[arg-type]


def describe(composition: DailyComposition) -> list[tuple[str, str]]:
    """The steps as ``(role or "learn", passage name)`` pairs."""
    out: list[tuple[str, str]] = []
    for step in composition.steps:
        if isinstance(step, PlannedLearn):
            out.append(("learn", NAMES[step.passage_id]))
        else:
            out.append((step.role, NAMES[step.passage_id]))
    return out


def questions_of(composition: DailyComposition, role: str) -> list[PlannedQuestion]:
    return [s for s in composition.steps if isinstance(s, PlannedQuestion) and s.role == role]


def compose(
    passages: Sequence[PassageInfo],
    banks: Mapping[UUID, Sequence[QuestionInfo]] | None = None,
    *,
    minutes: int = 10,
    status: str = "active",
    order: str = "book",
    rows: Mapping[UUID, PassageMastery] | None = None,
    covered: Sequence[UUID] = (),
    known: Sequence[UUID] = (),
    last_active: date | None = None,
    seed: int = SEED,
    session_id: UUID = SESSION,
    load: PassageLoader | None = None,
) -> DailyComposition:
    """``compose_daily`` with test defaults. Without ``banks`` every passage gets ``full_bank``."""
    bank = banks if banks is not None else {p.id: full_bank(p) for p in passages}
    return compose_daily(
        DailyInputs(
            learning_date=TODAY,
            session_minutes=minutes,
            plan_status=status,
            order=order,
            passages=tuple(passages),
            mastery=dict(rows or {}),
            covered_part_ids=frozenset(covered),
            known_passage_ids=frozenset(known),
            last_active_date=last_active,
            seed=seed,
            session_id=session_id,
        ),
        load or loader(bank),
    )
