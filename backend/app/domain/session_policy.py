"""Session composition policy (pure): which passages and questions a session holds
(Implementation-contract §4.3 and §5, API-spec E20 and S-2).

Three compositions, all deterministic given their inputs. Anything that varies between calls
(rotation, shuffling, tie-breaks) comes from the integer ``seed`` the caller passes in, through a
hash, never through a random number generator, so a result does not depend on the Python version.

**Daily** (``compose_daily``), in this order (owner decision D90, 5 October 2026: the lesson first,
then the game batches, then the due reviews, then the end test; D64 and D41 stay in force):

1. *New material*: the passages still being learned, then the next new passages, in plan order
   (``plan_order``), up to the day's capacity in words (12/25/40). The first passage is taken even
   when it alone exceeds the capacity (it is then introduced alone, "one passage at a time"). Words
   already introduced earlier today (``initial_learning_date`` is today) count against the
   capacity, so a second daily session of the same date does not add a second day of new material.
   Each passage gets a ``learn`` step (the whole text is read first) and then *training batches*
   (``TRAINING_BATCHES``: 2/2/3 for 5/10/15 minutes). A batch is one game type taken over all the
   ranked parts of the passage (one question per part; a question that covers several parts serves
   them all; a part with no unused question of that type is skipped, never filled with another
   type), so the questions of a batch are contiguous and of one type. The batch types follow the
   difficulty order word choice, word order, word recall, similar-text distinction, over the types
   the passage has. A batch that yields nothing does not count and the next type is tried. When
   fewer than ``STREAK_TARGET`` questions resulted, further batches (next types, wrapping, unused
   questions only) are added until the streak of D41 is reachable or no question is left.
2. *Due review rounds*, overdue first (ties: plan order). A round for a passage has ``k`` questions
   (``review_round_size``: 1 for at most 2 parts, 2 for 3-5, 3 for 6 or more) over the parts
   uncovered first, then error parts, then least recently tested. Whole rounds are added while the
   question total stays within the cap of 6/10/14 for 5/10/15 minutes; the first round that does
   not fit ends the step (later rounds must not jump the queue) and every round left over stays
   due. Passages known from the placement test that were never learned get a quick drill of the
   same size in place of new learning (contract §5, "early quick review"): no learn step, no
   capacity use, role ``training``; these follow the rounds. The day's review game type
   (``review_game_type``) rotates with the seed (D64): each part takes a question of that type when
   it has an unused one and its latest attempt did not use that type, else the usual rotation pick
   (which avoids the type last used); the rounds' questions are then grouped by
   type (the day's type first), and so are the quick drills. A round is evaluated from its own
   ``review_round_id``, so grouping does not change any outcome.
3. *End test* of 3/5/7 questions drawn in turn from three pools: today's passage parts, error
   parts, and uncovered parts of the passages in progress; the drawn questions are then grouped by
   type (the order of ``_ROTATION``).

*Absence* (R07): three or more full learning days without activity make the session a light review
(the review rounds only: no new material, no quick drills, no end test). A *completed* plan serves
maintenance reviews only (the review rounds only). Rounds that do not fit stay due for the
following days.

**Game** (``compose_game``): up to 10 questions of an optional game type, spread over the candidate
passages first (one question per passage, then deeper), error parts first.

**Placement** (``compose_placement``): up to 8 passages sampled evenly across the scope, one
``word_choice`` (preferring the "what comes next" form) or ``word_recall`` question each.

Questions never repeat inside a session, so a question id identifies a step (API-spec S-3).

Pure module: standard library, ``app.domain.answer_policy`` and ``app.domain.learning_state`` only.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Final
from uuid import UUID, uuid5

from app.domain.answer_policy import (
    SIMILAR_DISTINCTION,
    WORD_CHOICE,
    WORD_ORDER,
    WORD_RECALL,
)
from app.domain.learning_state import STREAK_TARGET, PassageMastery

# --- numbers of contract §5 and API-spec §1.7 --------------------------------------------------

SESSION_MINUTES: Final[tuple[int, ...]] = (5, 10, 15)
CAPACITY_WORDS: Final[Mapping[int, int]] = {5: 12, 10: 25, 15: 40}  # new words per learning day
REVIEW_QUESTION_CAP: Final[Mapping[int, int]] = {5: 6, 10: 10, 15: 14}
END_TEST_QUESTIONS: Final[Mapping[int, int]] = {5: 3, 10: 5, 15: 7}
GAME_QUESTION_CAP: Final = 10
PLACEMENT_PASSAGE_CAP: Final = 8
ABSENCE_THRESHOLD_DAYS: Final = 3  # PRD R07

# Implementation bounds (not learning rules): how many passages one end test may draw from, and how
# many passages a game loads at a time.
END_TEST_MAX_PASSAGES: Final = 12
GAME_LOAD_CHUNK: Final = 10

# D90 (owner, 5 October 2026): a new passage is trained in batches of one game type each, over all
# of its parts. How many batches the passage gets, by session minutes.
TRAINING_BATCHES: Final[Mapping[int, int]] = {5: 2, 10: 2, 15: 3}

# The order in which question types rotate (only the types a part actually has take part).
_ROTATION: Final[tuple[str, ...]] = (WORD_CHOICE, WORD_RECALL, WORD_ORDER, SIMILAR_DISTINCTION)
# The order of the training batches of D90: from the easiest game to the hardest.
_TRAINING_PROGRESSION: Final[tuple[str, ...]] = (
    WORD_CHOICE,
    WORD_ORDER,
    WORD_RECALL,
    SIMILAR_DISTINCTION,
)
_NEVER: Final = float("-inf")

ROLE_TRAINING: Final = "training"
ROLE_REVIEW: Final = "review"
ROLE_TEST: Final = "test"
ROLE_PLACEMENT: Final = "placement"
ROLE_GAME: Final = "game"


def stable_hash(*parts: object) -> int:
    """A platform- and version-independent 64-bit hash of ``parts`` (used for seeded ordering)."""
    data = "|".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(data).digest()[:8], "big")


# --- inputs ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PartInfo:
    id: UUID
    ordinal: int
    word_count: int


@dataclass(frozen=True, slots=True)
class PassageInfo:
    """A memorization target as the policy sees it. ``start`` is the ``(unit ordinal, token index)``
    of ``start_ref`` and gives book order inside a section; ``parts`` are in ascending ordinal."""

    id: UUID
    section_ordinal: int
    path: str
    ordinal: int
    start: tuple[int, int]
    word_count: int
    parts: tuple[PartInfo, ...]


@dataclass(frozen=True, slots=True)
class QuestionInfo:
    """A bank question as the policy sees it (the stored token references stay in the bank)."""

    id: UUID
    passage_id: UUID
    type: str
    variant: str | None
    covered_part_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class PassageData:
    """What the loader returns for a set of passages: their bank questions and the learner's
    history with their parts. ``last_tested`` maps a part to the time of its latest attempt and
    ``last_type`` to the question type of that attempt (both optional: no history, no entry)."""

    questions: Mapping[UUID, Sequence[QuestionInfo]]
    last_tested: Mapping[UUID, datetime] = field(default_factory=dict)
    last_type: Mapping[UUID, str] = field(default_factory=dict)


PassageLoader = Callable[[Sequence[UUID]], PassageData]


# --- planned steps -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlannedLearn:
    passage_id: UUID


@dataclass(frozen=True, slots=True)
class PlannedQuestion:
    question_id: UUID
    passage_id: UUID
    role: str
    review_round_id: UUID | None = None


PlannedStep = PlannedLearn | PlannedQuestion


@dataclass(frozen=True, slots=True)
class DailyInputs:
    learning_date: date
    session_minutes: int
    plan_status: str  # "active" or "completed" (a paused plan accepts no session)
    order: str  # "book" or "reverse"
    passages: tuple[PassageInfo, ...]  # every passage of the plan scope and paths
    mastery: Mapping[UUID, PassageMastery]  # by passage id; a missing row is "new"
    covered_part_ids: frozenset[UUID]  # parts with evidence
    known_passage_ids: frozenset[UUID]  # known from the placement test
    last_active_date: date | None  # latest learning date with verified activity
    seed: int
    session_id: UUID  # round ids derive from it


@dataclass(frozen=True, slots=True)
class DailyComposition:
    steps: tuple[PlannedStep, ...]
    light_review: bool
    maintenance_only: bool
    new_passage_ids: tuple[UUID, ...]
    quick_review_passage_ids: tuple[UUID, ...]


@dataclass(frozen=True, slots=True)
class GameInputs:
    passages: tuple[PassageInfo, ...]  # candidates, already limited to scope, paths and filter
    game_type: str | None
    mastery: Mapping[UUID, PassageMastery]
    seed: int


@dataclass(frozen=True, slots=True)
class PlacementInputs:
    passages: tuple[PassageInfo, ...]  # the scope's passages on the edition's default paths
    seed: int


# --- small rules -------------------------------------------------------------------------------


def review_round_size(part_count: int) -> int:
    """Questions in a review round: 1 for at most 2 parts, 2 for 3-5, 3 for 6 or more (§4.3)."""
    if part_count <= 2:
        return 1
    return 2 if part_count <= 5 else 3


def plan_order(passages: Iterable[PassageInfo], order: str) -> list[PassageInfo]:
    """Passages in the plan's order (contract §2.3, §5). ``book``: sections by ascending ordinal;
    ``reverse``: by descending ordinal. Inside a section passages keep book order (the position of
    their first token), also under ``reverse``. No passage is dropped."""
    sign = -1 if order == "reverse" else 1
    return sorted(
        passages,
        key=lambda p: (sign * p.section_ordinal, p.start, p.path, p.ordinal, str(p.id)),
    )


def absence_days(learning_date: date, last_active_date: date | None) -> int:
    """Full learning days without verified activity between the last active date and today.
    A learner who never studied has no absence (the first session is simply the first)."""
    if last_active_date is None or last_active_date >= learning_date:
        return 0
    return (learning_date - last_active_date).days - 1


def is_light_review_day(learning_date: date, last_active_date: date | None) -> bool:
    """R07: three or more days of absence start with a light review and no new material."""
    return absence_days(learning_date, last_active_date) >= ABSENCE_THRESHOLD_DAYS


def _timestamp(value: datetime | None) -> float:
    return _NEVER if value is None else value.timestamp()


def rank_parts(
    parts: Sequence[PartInfo],
    covered: frozenset[UUID] | set[UUID],
    errors: frozenset[UUID] | set[UUID],
    last_tested: Mapping[UUID, datetime],
) -> list[PartInfo]:
    """Parts in the order a review round or a training block takes them (contract §4.3):
    uncovered first, then error parts, then least recently tested (never tested first), then
    part order."""
    return sorted(
        parts,
        key=lambda part: (
            1 if part.id in covered else 0,
            0 if part.id in errors else 1,
            _timestamp(last_tested.get(part.id)),
            part.ordinal,
        ),
    )


# --- picking questions -------------------------------------------------------------------------


def _index_by_part(questions: Sequence[QuestionInfo]) -> dict[UUID, list[QuestionInfo]]:
    """Questions by each part they cover, in a fixed order (type rotation rank, then id)."""
    rank = {kind: position for position, kind in enumerate(_ROTATION)}
    index: dict[UUID, list[QuestionInfo]] = defaultdict(list)
    for question in sorted(questions, key=lambda q: (rank.get(q.type, len(rank)), str(q.id))):
        for part_id in question.covered_part_ids:
            index[part_id].append(question)
    return index


def _pick_question(
    part_id: UUID,
    by_part: Mapping[UUID, Sequence[QuestionInfo]],
    used: set[UUID],
    *,
    rotation: int,
    last_type: str | None,
    seed: int,
    only_type: str | None = None,
) -> QuestionInfo | None:
    """An unused question that covers ``part_id``. Types rotate with ``rotation`` over the types
    the part has, skipping the type its latest attempt used when another type is available; with
    ``only_type`` only that type qualifies. Ties go to the lowest seeded hash."""
    candidates = [
        q
        for q in by_part.get(part_id, ())
        if q.id not in used and (only_type is None or q.type == only_type)
    ]
    if not candidates:
        return None
    if only_type is not None:
        chosen = only_type
    else:
        available = [kind for kind in _ROTATION if any(q.type == kind for q in candidates)]
        if not available:  # a type outside the four known games: take any, deterministically
            return min(candidates, key=lambda q: (stable_hash(seed, q.id), str(q.id)))
        position = rotation % len(available)
        chosen = available[position]
        if last_type is not None and chosen == last_type and len(available) > 1:
            chosen = available[(position + 1) % len(available)]
    pool = [q for q in candidates if q.type == chosen]
    return min(pool, key=lambda q: (stable_hash(seed, q.id), str(q.id)))


def _questions_for_parts(
    passage: PassageInfo,
    ranked: Sequence[PartInfo],
    *,
    count: int,
    by_part: Mapping[UUID, Sequence[QuestionInfo]],
    used: set[UUID],
    data: PassageData,
    seed: int,
    rotation_base: int,
    role: str,
    review_round_id: UUID | None,
    stop_at_count: bool,
    only_type: str | None = None,
    prefer_type: str | None = None,
) -> list[PlannedQuestion]:
    """One question per ranked part (a question that covers several parts serves them all).

    With ``stop_at_count`` the walk ends after ``count`` questions (a review round); otherwise every
    part gets its question and ``count`` is only the target a caller tops up to. With ``only_type``
    just that question type qualifies (a training batch: a part with no unused question of the type
    is skipped); with ``prefer_type`` that type is tried first for each part and the usual rotation
    pick is the fallback (the day's review game type). A part whose latest attempt used the
    preferred type skips it, so a review still changes the template (contract §4.3, D64).
    """
    planned: list[PlannedQuestion] = []
    served: set[UUID] = set()
    for part in ranked:
        if stop_at_count and len(planned) >= count:
            break
        if part.id in served:
            continue
        question: QuestionInfo | None = None
        if (
            prefer_type is not None
            and only_type is None
            and data.last_type.get(part.id) != prefer_type
        ):
            question = _pick_question(
                part.id,
                by_part,
                used,
                rotation=rotation_base + len(planned),
                last_type=data.last_type.get(part.id),
                seed=seed,
                only_type=prefer_type,
            )
        if question is None:
            question = _pick_question(
                part.id,
                by_part,
                used,
                rotation=rotation_base + len(planned),
                last_type=data.last_type.get(part.id),
                seed=seed,
                only_type=only_type,
            )
        if question is None:
            continue
        used.add(question.id)
        served.update(question.covered_part_ids)
        planned.append(PlannedQuestion(question.id, passage.id, role, review_round_id))
    return planned


def _training_questions(
    passage: PassageInfo,
    *,
    minutes: int,
    mastery: PassageMastery | None,
    covered: frozenset[UUID],
    data: PassageData,
    used: set[UUID],
    seed: int,
) -> list[PlannedQuestion]:
    """The training batches of a new passage (D90).

    A batch is one game type over every ranked part: one unused question of that type per part,
    a question covering several parts serving them all, a part with no unused question of the type
    skipped (no other type is mixed in). The batches are taken in the difficulty order of
    ``_TRAINING_PROGRESSION`` over the types the passage has: ``TRAINING_BATCHES[minutes]`` batches
    that yield questions (a batch that yields none does not count; the next type is tried). If fewer
    than ``STREAK_TARGET`` questions resulted (the streak of D41 needs that many answers; a passage
    may have few parts), further batches follow with the next types, wrapping round, taking unused
    questions only, until the target is reached or no question is left.
    """
    errors = set(mastery.error_part_ids) if mastery is not None else set()
    ranked = rank_parts(passage.parts, covered, errors, data.last_tested)
    questions = data.questions.get(passage.id, ())
    by_part = _index_by_part(questions)
    present = {q.type for q in questions}
    kinds = [kind for kind in _TRAINING_PROGRESSION if kind in present]
    base = stable_hash(seed, "train", passage.id)

    def batch(kind: str) -> list[PlannedQuestion]:
        return _questions_for_parts(
            passage,
            ranked,
            count=STREAK_TARGET,
            by_part=by_part,
            used=used,
            data=data,
            seed=seed,
            rotation_base=base,
            role=ROLE_TRAINING,
            review_round_id=None,
            stop_at_count=False,
            only_type=kind,
        )

    planned: list[PlannedQuestion] = []
    wanted, taken, cursor = TRAINING_BATCHES[minutes], 0, 0
    while cursor < len(kinds) and taken < wanted:
        found = batch(kinds[cursor])
        cursor += 1
        if found:
            planned += found
            taken += 1
    misses = 0
    while kinds and len(planned) < STREAK_TARGET and misses < len(kinds):
        found = batch(kinds[cursor % len(kinds)])
        cursor += 1
        if not found:
            misses += 1
            continue
        misses = 0
        planned += found
    return planned


def _round_questions(
    passage: PassageInfo,
    size: int,
    *,
    role: str,
    review_round_id: UUID | None,
    mastery: PassageMastery | None,
    covered: frozenset[UUID],
    data: PassageData,
    used: set[UUID],
    seed: int,
    prefer_type: str | None = None,
) -> list[PlannedQuestion]:
    errors = set(mastery.error_part_ids) if mastery is not None else set()
    ranked = rank_parts(passage.parts, covered, errors, data.last_tested)
    return _questions_for_parts(
        passage,
        ranked,
        count=size,
        by_part=_index_by_part(data.questions.get(passage.id, ())),
        used=used,
        data=data,
        seed=seed,
        rotation_base=stable_hash(seed, "round", passage.id),
        role=role,
        review_round_id=review_round_id,
        stop_at_count=True,
        prefer_type=prefer_type,
    )


def review_game_type(seed: int) -> str:
    """The game type the day's reviews prefer. It follows the seed (which changes with the plan and
    the date), so the type rotates across days (D64)."""
    return _ROTATION[stable_hash(seed, "review-type") % len(_ROTATION)]


def _group_by_type(
    planned: Sequence[PlannedQuestion],
    kinds: Mapping[UUID, str],
    first: str | None = None,
) -> list[PlannedQuestion]:
    """``planned`` with the questions of one type side by side: ``first`` (if any), then the other
    types in ``_ROTATION`` order, a type outside the four games last. Stable inside a type, so the
    round order of the input survives in each group."""
    order = [first, *(kind for kind in _ROTATION if kind != first)] if first else list(_ROTATION)
    rank = {kind: position for position, kind in enumerate(order)}
    return sorted(planned, key=lambda item: rank.get(kinds.get(item.question_id, ""), len(rank)))


# --- daily -------------------------------------------------------------------------------------


def _status(mastery: Mapping[UUID, PassageMastery], passage_id: UUID) -> str:
    row = mastery.get(passage_id)
    return "new" if row is None else row.status


def _select_new_passages(
    ordered: Sequence[PassageInfo],
    mastery: Mapping[UUID, PassageMastery],
    known: frozenset[UUID],
    learning_date: date,
    minutes: int,
) -> list[PassageInfo]:
    """Passages still being learned, then new ones, in plan order, up to the day's capacity."""
    learning = [p for p in ordered if _status(mastery, p.id) == "learning" and p.id not in known]
    fresh = [p for p in ordered if _status(mastery, p.id) == "new" and p.id not in known]
    capacity = CAPACITY_WORDS[minutes]
    introduced_today = sum(
        p.word_count
        for p in ordered
        if (row := mastery.get(p.id)) is not None and row.initial_learning_date == learning_date
    )
    words = introduced_today
    selected: list[PassageInfo] = []
    for passage in (*learning, *fresh):
        first = not selected and introduced_today == 0
        if first or words + passage.word_count <= capacity:
            selected.append(passage)
            words += passage.word_count
        else:
            break
    return selected


def _distinct(ids: Iterable[UUID]) -> list[UUID]:
    seen: dict[UUID, None] = {}
    for passage_id in ids:
        seen.setdefault(passage_id)
    return list(seen)


def _end_test_pools(
    ordered: Sequence[PassageInfo],
    mastery: Mapping[UUID, PassageMastery],
    covered: frozenset[UUID],
    today: Sequence[PassageInfo],
) -> list[list[tuple[PassageInfo, PartInfo]]]:
    """Today's passage parts, error parts and uncovered parts, limited to ``END_TEST_MAX_PASSAGES``
    passages (today's first, then those with error parts, then those with uncovered parts)."""
    today_ids = {p.id for p in today}
    errors: list[tuple[PassageInfo, PartInfo]] = []
    uncovered: list[tuple[PassageInfo, PartInfo]] = []
    for passage in ordered:
        row = mastery.get(passage.id)
        if row is None or passage.id in today_ids:
            continue
        for part in passage.parts:
            if part.id in row.error_part_ids:
                errors.append((passage, part))
            elif (
                row.status in ("learning", "reviewing", "needs_refresh") and part.id not in covered
            ):
                uncovered.append((passage, part))
    allowed = set(
        _distinct(
            [
                *(p.id for p in today),
                *(p.id for p, _ in errors),
                *(p.id for p, _ in uncovered),
            ]
        )[:END_TEST_MAX_PASSAGES]
    )
    pool_today = [(p, part) for p in today for part in p.parts]
    return [
        pool_today,
        [item for item in errors if item[0].id in allowed],
        [item for item in uncovered if item[0].id in allowed],
    ]


def _end_test_questions(
    pools: Sequence[Sequence[tuple[PassageInfo, PartInfo]]],
    *,
    count: int,
    data: PassageData,
    used: set[UUID],
    seed: int,
) -> list[PlannedQuestion]:
    """``count`` questions drawn from the pools in turn. Each part is used once before any part
    repeats; a part that repeats gets a different question."""
    ordered_pools = [
        sorted(
            pool,
            key=lambda item: (
                _timestamp(data.last_tested.get(item[1].id)),
                stable_hash(seed, "test", item[1].id),
            ),
        )
        for pool in pools
    ]
    by_part = {
        passage_id: _index_by_part(questions) for passage_id, questions in data.questions.items()
    }
    planned: list[PlannedQuestion] = []
    drawn_parts: set[UUID] = set()
    base = stable_hash(seed, "test")
    for allow_repeat in (False, True):
        cursors = [0] * len(ordered_pools)
        exhausted = [not pool for pool in ordered_pools]
        progressed = True
        while len(planned) < count and progressed:
            progressed = False
            for index, pool in enumerate(ordered_pools):
                if len(planned) >= count:
                    break
                if exhausted[index]:
                    continue
                for _ in range(len(pool)):  # one full cycle over the pool at most
                    passage, part = pool[cursors[index] % len(pool)]
                    cursors[index] += 1
                    if not allow_repeat and part.id in drawn_parts:
                        continue
                    question = _pick_question(
                        part.id,
                        by_part.get(passage.id, {}),
                        used,
                        rotation=base + len(planned),
                        last_type=data.last_type.get(part.id),
                        seed=seed,
                    )
                    if question is None:
                        continue
                    used.add(question.id)
                    drawn_parts.add(part.id)
                    planned.append(PlannedQuestion(question.id, passage.id, ROLE_TEST, None))
                    progressed = True
                    break
                else:
                    exhausted[index] = True
    return planned


def compose_daily(inputs: DailyInputs, load: PassageLoader) -> DailyComposition:
    """The daily session of ``inputs.learning_date`` (see the module docstring).

    Step order (D90): each new passage (learn step, then its training batches), the due review
    rounds, the quick drills of known passages, the end test. A light-review day and a completed
    plan hold the review rounds only.

    ``load`` is called once with every passage the session may use (rounds, quick drills, new
    material and the end-test pools) and returns their questions and history. A paused plan is not
    a valid input: the caller rejects it before composing.
    """
    if inputs.session_minutes not in SESSION_MINUTES:
        raise ValueError("session minutes must be 5, 10 or 15")
    minutes = inputs.session_minutes
    mastery = inputs.mastery
    today = inputs.learning_date
    ordered = plan_order(inputs.passages, inputs.order)
    index = {p.id: position for position, p in enumerate(ordered)}
    active = inputs.plan_status == "active"
    light = active and is_light_review_day(today, inputs.last_active_date)
    full = active and not light

    # Selection: due rounds (overdue first, within the question cap), quick drills, new material
    # and the end-test pools. The steps are built below in the order of D90.
    due = sorted(
        (p for p in ordered if (row := mastery.get(p.id)) is not None and row.is_due(today)),
        key=lambda p: (mastery[p.id].next_review_due or today, index[p.id]),
    )
    cap = REVIEW_QUESTION_CAP[minutes]
    total = 0
    rounds: list[tuple[PassageInfo, int]] = []
    for passage in due:
        size = review_round_size(len(passage.parts))
        if total + size > cap:
            break
        rounds.append((passage, size))
        total += size
    quick: list[tuple[PassageInfo, int]] = []
    if full:
        for passage in ordered:
            if passage.id in inputs.known_passage_ids and _status(mastery, passage.id) in (
                "new",
                "learning",
            ):
                size = review_round_size(len(passage.parts))
                if total + size > cap:
                    break
                quick.append((passage, size))
                total += size

    new_passages = (
        _select_new_passages(ordered, mastery, inputs.known_passage_ids, today, minutes)
        if full
        else []
    )
    pools = _end_test_pools(ordered, mastery, inputs.covered_part_ids, new_passages) if full else []

    needed = _distinct(
        [
            *(p.id for p, _ in rounds),
            *(p.id for p, _ in quick),
            *(p.id for p in new_passages),
            *(p.id for pool in pools for p, _ in pool),
        ]
    )
    data = load(needed) if needed else PassageData(questions={})

    kind_of = {q.id: q.type for questions in data.questions.values() for q in questions}
    review_type = review_game_type(inputs.seed)
    used: set[UUID] = set()
    steps: list[PlannedStep] = []
    # (1) new material first: the lesson, then its game batches (D90)
    for passage in new_passages:
        steps.append(PlannedLearn(passage.id))
        steps += _training_questions(
            passage,
            minutes=minutes,
            mastery=mastery.get(passage.id),
            covered=inputs.covered_part_ids,
            data=data,
            used=used,
            seed=inputs.seed,
        )
    # (2) due review rounds, then the quick drills, each block grouped by game type. A round is
    # evaluated from its review_round_id (the set of its questions, each answered once), never from
    # the position of its steps, so its questions need not stay side by side.
    review_block: list[PlannedQuestion] = []
    for passage, size in rounds:
        review_block += _round_questions(
            passage,
            size,
            role=ROLE_REVIEW,
            review_round_id=uuid5(inputs.session_id, f"round:{passage.id}"),
            mastery=mastery.get(passage.id),
            covered=inputs.covered_part_ids,
            data=data,
            used=used,
            seed=inputs.seed,
            prefer_type=review_type,
        )
    drill_block: list[PlannedQuestion] = []
    for passage, size in quick:
        drill_block += _round_questions(
            passage,
            size,
            role=ROLE_TRAINING,
            review_round_id=None,
            mastery=mastery.get(passage.id),
            covered=inputs.covered_part_ids,
            data=data,
            used=used,
            seed=inputs.seed,
            prefer_type=review_type,
        )
    steps += _group_by_type(review_block, kind_of, review_type)
    steps += _group_by_type(drill_block, kind_of, review_type)
    # (3) the end test last, its questions grouped by game type
    if full:
        test_block = _end_test_questions(
            pools, count=END_TEST_QUESTIONS[minutes], data=data, used=used, seed=inputs.seed
        )
        steps += _group_by_type(test_block, kind_of)
    return DailyComposition(
        steps=tuple(steps),
        light_review=light,
        maintenance_only=not active,
        new_passage_ids=tuple(p.id for p in new_passages),
        quick_review_passage_ids=tuple(p.id for p, _ in quick),
    )


# --- game --------------------------------------------------------------------------------------


def _game_questions(
    passages: Sequence[PassageInfo],
    data: PassageData,
    inputs: GameInputs,
) -> list[PlannedQuestion]:
    """Round-robin over the passages: one question per passage first, then deeper, taking the parts
    with error history first, then the least recently tested. At most ``GAME_QUESTION_CAP``."""
    seed = inputs.seed
    ranked: dict[UUID, list[PartInfo]] = {}
    by_part: dict[UUID, dict[UUID, list[QuestionInfo]]] = {}
    for passage in passages:
        row = inputs.mastery.get(passage.id)
        errors = set(row.error_part_ids) if row is not None else set()
        ranked[passage.id] = sorted(
            passage.parts,
            key=lambda part: (
                0 if part.id in errors else 1,
                _timestamp(data.last_tested.get(part.id)),
                stable_hash(seed, "game-part", part.id),
            ),
        )
        by_part[passage.id] = _index_by_part(data.questions.get(passage.id, ()))
    planned: list[PlannedQuestion] = []
    used: set[UUID] = set()
    cursor: dict[UUID, int] = defaultdict(int)
    exhausted: set[UUID] = set()
    base = stable_hash(seed, "game")
    progressed = True
    while len(planned) < GAME_QUESTION_CAP and progressed:
        progressed = False
        for passage in passages:
            if len(planned) >= GAME_QUESTION_CAP:
                break
            parts = ranked[passage.id]
            if passage.id in exhausted or not parts:
                continue
            found: QuestionInfo | None = None
            for _ in range(len(parts)):
                part = parts[cursor[passage.id] % len(parts)]
                cursor[passage.id] += 1
                found = _pick_question(
                    part.id,
                    by_part[passage.id],
                    used,
                    rotation=base + len(planned),
                    last_type=data.last_type.get(part.id),
                    seed=seed,
                    only_type=inputs.game_type,
                )
                if found is not None:
                    break
            if found is None:
                exhausted.add(passage.id)
                continue
            used.add(found.id)
            planned.append(PlannedQuestion(found.id, passage.id, ROLE_GAME, None))
            progressed = True
    return planned


def compose_game(inputs: GameInputs, load: PassageLoader) -> tuple[PlannedQuestion, ...]:
    """Up to ``GAME_QUESTION_CAP`` questions over the candidate passages. Candidates are taken in a
    priority order (passages with error parts first, then a seeded order) and loaded a chunk at a
    time until enough questions were found or the candidates ran out."""
    if inputs.game_type is not None and inputs.game_type not in (
        WORD_ORDER,
        WORD_CHOICE,
        WORD_RECALL,
        SIMILAR_DISTINCTION,
    ):
        raise ValueError("unknown game type")
    seed = inputs.seed

    def priority(passage: PassageInfo) -> tuple[int, int, str]:
        row = inputs.mastery.get(passage.id)
        has_errors = row is not None and bool(row.error_part_ids)
        return (
            0 if has_errors else 1,
            stable_hash(seed, "game-passage", passage.id),
            str(passage.id),
        )

    candidates = sorted(inputs.passages, key=priority)
    questions: dict[UUID, Sequence[QuestionInfo]] = {}
    last_tested: dict[UUID, datetime] = {}
    last_type: dict[UUID, str] = {}
    loaded = 0
    while True:
        chunk = candidates[loaded : loaded + GAME_LOAD_CHUNK]
        if chunk:
            data = load([p.id for p in chunk])
            questions.update(data.questions)
            last_tested.update(data.last_tested)
            last_type.update(data.last_type)
            loaded += len(chunk)
        merged = PassageData(questions=questions, last_tested=last_tested, last_type=last_type)
        planned = _game_questions(candidates[:loaded], merged, inputs)
        if len(planned) >= GAME_QUESTION_CAP or loaded >= len(candidates):
            return tuple(planned)


# --- placement ---------------------------------------------------------------------------------


def placement_buckets(count: int) -> list[range]:
    """``min(count, 8)`` equal slices of ``range(count)`` (every index in exactly one slice)."""
    wanted = min(count, PLACEMENT_PASSAGE_CAP)
    return [range(i * count // wanted, (i + 1) * count // wanted) for i in range(wanted)]


def sample_placement_passages(passages: Iterable[PassageInfo]) -> list[PassageInfo]:
    """Up to ``PLACEMENT_PASSAGE_CAP`` passages spread evenly across the scope in book order: the
    middle passage of each of the equal slices of the scope."""
    ordered = plan_order(passages, "book")
    return [
        ordered[(bucket.start + bucket.stop - 1) // 2] for bucket in placement_buckets(len(ordered))
    ]


_PLACEMENT_VARIANT_RANK: Final[Mapping[str, int]] = {"segment": 0, "continuation": 0}


def _placement_question(
    passage: PassageInfo,
    position: int,
    questions: Sequence[QuestionInfo],
    seed: int,
) -> QuestionInfo | None:
    """One ``word_choice`` (the "what comes next" form first) or ``word_recall`` question; the two
    types alternate along the sample, and the other type is the fallback."""
    wanted = (WORD_CHOICE, WORD_RECALL) if position % 2 == 0 else (WORD_RECALL, WORD_CHOICE)
    for kind in wanted:
        pool = [q for q in questions if q.type == kind]
        if pool:
            return min(
                pool,
                key=lambda q: (
                    _PLACEMENT_VARIANT_RANK.get(q.variant or "", 1),
                    stable_hash(seed, "placement", q.id),
                    str(q.id),
                ),
            )
    return None


def compose_placement(inputs: PlacementInputs, load: PassageLoader) -> tuple[PlannedQuestion, ...]:
    """The placement test: one question per sampled passage, in book order. A sampled passage with
    no suitable question is replaced by its nearest neighbour inside its slice of the scope."""
    ordered = plan_order(inputs.passages, "book")
    buckets = placement_buckets(len(ordered))
    if not buckets:
        return ()
    primary = [ordered[(b.start + b.stop - 1) // 2] for b in buckets]
    questions: dict[UUID, Sequence[QuestionInfo]] = dict(load([p.id for p in primary]).questions)
    requested = {p.id for p in primary}
    planned: list[PlannedQuestion] = []
    for position, bucket in enumerate(buckets):
        centre = (bucket.start + bucket.stop - 1) // 2
        for candidate_index in sorted(bucket, key=lambda i: (abs(i - centre), i)):
            passage = ordered[candidate_index]
            if passage.id not in requested:
                requested.add(passage.id)
                questions.update(load([passage.id]).questions)
            question = _placement_question(
                passage, position, questions.get(passage.id, ()), inputs.seed
            )
            if question is not None:
                planned.append(PlannedQuestion(question.id, passage.id, ROLE_PLACEMENT, None))
                break
    return tuple(planned)
