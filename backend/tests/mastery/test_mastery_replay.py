"""E21 idempotent replay and the invariants of the state machine (pure, seeded random, no I/O).

The simulation below is the loop the E21 service runs per event: an id already acknowledged is a
duplicate and nothing else happens; otherwise the attempt is applied and the id is acknowledged.
``random.Random`` with fixed seeds keeps every run reproducible (hypothesis is not a dependency).
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from uuid import UUID

import pytest

from app.domain.answer_policy import ValidatedAttempt
from app.domain.learning_state import PassageMastery
from app.domain.mastery_policy import (
    AcknowledgedIds,
    RoundAnswer,
    RoundResult,
    advance_target_streak,
    apply_round,
    is_fully_covered,
    summarize_round,
)
from tests.mastery.mastery_support import D0, NOW, Learner, at, day, right, wrong
from tests.sessions.ss_policy_support import PLAN, passage, uid

PARTS = 4
PASSAGES = [passage(f"p{n}", section=n, words=(4,) * PARTS) for n in range(1, 4)]


@dataclass(frozen=True)
class Event:
    """A synthetic answer event: an id, the passage it is about and its graded outcome."""

    event_id: UUID
    passage: int
    parts: tuple[int, ...]
    correct: bool
    assisted: bool


class Rig:
    """The passages' states, the parts with evidence and the log of what was recorded."""

    def __init__(self, ledger: AcknowledgedIds | None = None) -> None:
        self.ledger = ledger or AcknowledgedIds()
        self.states = {p.id: PassageMastery(plan_id=PLAN, passage_id=p.id) for p in PASSAGES}
        self.covered: set[UUID] = set()
        self.evidence_rows: list[UUID] = []
        self.outcomes: list[str] = []

    def process(self, events: list[Event]) -> None:
        for event in events:
            if self.ledger.is_duplicate(event.event_id):
                self.outcomes.append("duplicate")
                continue
            info = PASSAGES[event.passage]
            effect = advance_target_streak(
                self.states[info.id],
                ValidatedAttempt(event.correct, event.assisted, "none" if event.correct else "x"),
                question_part_ids=[info.parts[n].id for n in event.parts],
                passage_part_ids={part.id for part in info.parts},
                covered_part_ids=self.covered,
                learning_date=D0,
                now=NOW,
            )
            self.states[info.id] = effect.state
            self.covered.update(effect.new_evidence_part_ids)
            self.evidence_rows.extend(effect.new_evidence_part_ids)
            self.ledger.acknowledge(event.event_id)
            self.outcomes.append("acknowledged")

    def snapshot(self) -> tuple[object, ...]:
        return (
            tuple(sorted((str(k), v.to_payload().__repr__()) for k, v in self.states.items())),
            tuple(sorted(str(part) for part in self.covered)),
            tuple(sorted(str(part) for part in self.evidence_rows)),
        )


def make_events(rng: random.Random, count: int) -> list[Event]:
    return [
        Event(
            event_id=UUID(int=rng.getrandbits(128), version=4),
            passage=rng.randrange(len(PASSAGES)),
            parts=tuple(sorted(rng.sample(range(PARTS), rng.choice([1, 1, 2])))),
            correct=rng.random() < 0.75,
            assisted=rng.random() < 0.15,
        )
        for _ in range(count)
    ]


def with_duplicates(rng: random.Random, events: list[Event]) -> list[Event]:
    """The same events with copies inserted anywhere after their first occurrence."""
    stream = list(events)
    for event in events:
        for _ in range(rng.choice([0, 0, 1, 2, 3])):
            first = stream.index(event)
            stream.insert(rng.randint(first + 1, len(stream)), event)
    return stream


# --- the ledger ----------------------------------------------------------------------------------


def test_replay_an_unknown_id_is_fresh_and_an_acknowledged_id_is_a_duplicate() -> None:
    ledger = AcknowledgedIds()
    event = uid("event")
    assert not ledger.is_duplicate(event)
    ledger.acknowledge(event)
    assert ledger.is_duplicate(event)
    assert len(ledger) == 1


def test_replay_ids_the_database_already_holds_are_duplicates_from_the_start() -> None:
    known = [uid("a"), uid("b")]
    ledger = AcknowledgedIds(known)
    assert all(ledger.is_duplicate(i) for i in known)
    assert not ledger.is_duplicate(uid("c"))


def test_replay_an_id_that_was_only_rejected_or_kept_pending_may_still_be_accepted() -> None:
    ledger = AcknowledgedIds()
    event = uid("event")
    # the service does not call ``acknowledge`` for a rejected or pending event
    assert not ledger.is_duplicate(event)
    assert not ledger.is_duplicate(event)


def test_replay_the_first_event_for_an_id_wins_whatever_the_second_says() -> None:
    event_id = uid("one id")
    first = Event(event_id, 0, (0,), correct=True, assisted=False)
    second = Event(event_id, 0, (0, 1), correct=False, assisted=False)
    once, twice = Rig(), Rig()
    once.process([first])
    twice.process([first, second])
    assert twice.snapshot() == once.snapshot()
    assert twice.outcomes == ["acknowledged", "duplicate"]


def test_replay_a_duplicate_inside_one_batch_has_no_second_effect() -> None:
    event = Event(uid("e"), 1, (0, 1), correct=True, assisted=False)
    rig = Rig()
    rig.process([event, event, event])
    assert rig.outcomes == ["acknowledged", "duplicate", "duplicate"]
    assert rig.states[PASSAGES[1].id].consecutive_correct == 1


# --- properties (seeded) -------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(40))
def test_replay_random_duplicates_leave_the_same_state_as_each_event_once(seed: int) -> None:
    rng = random.Random(seed)
    events = make_events(rng, rng.randint(5, 60))
    stream = with_duplicates(rng, events)
    baseline, noisy = Rig(), Rig()
    baseline.process(events)
    noisy.process(stream)
    assert noisy.snapshot() == baseline.snapshot()
    assert noisy.outcomes.count("acknowledged") == len(events)
    assert noisy.outcomes.count("duplicate") == len(stream) - len(events)


@pytest.mark.parametrize("seed", range(25))
def test_replay_sending_the_whole_batch_again_any_number_of_times_changes_nothing(
    seed: int,
) -> None:
    rng = random.Random(1000 + seed)
    events = make_events(rng, rng.randint(5, 40))
    once, again = Rig(), Rig()
    once.process(events)
    for _ in range(rng.randint(1, 4)):
        again.process(events)
    assert again.snapshot() == once.snapshot()
    assert again.outcomes.count("acknowledged") == len(events)


@pytest.mark.parametrize("seed", range(25))
def test_replay_resending_after_a_partial_commit_completes_the_same_result(seed: int) -> None:
    """A batch that failed half way: the committed ids come back as duplicates on the resend."""
    rng = random.Random(2000 + seed)
    events = make_events(rng, rng.randint(6, 40))
    cut = rng.randint(1, len(events) - 1)
    baseline, resumed = Rig(), Rig()
    baseline.process(events)
    resumed.process(events[:cut])
    resumed.process(events)  # the client resends the whole batch with the same ids
    assert resumed.snapshot() == baseline.snapshot()
    assert resumed.outcomes[cut:].count("duplicate") == cut


@pytest.mark.parametrize("seed", range(25))
def test_replay_a_part_has_one_evidence_row_however_often_it_is_answered(seed: int) -> None:
    rng = random.Random(3000 + seed)
    events = make_events(rng, 50)
    rig = Rig()
    rig.process(with_duplicates(rng, events))
    assert len(rig.evidence_rows) == len(set(rig.evidence_rows))
    assert set(rig.evidence_rows) == rig.covered


@pytest.mark.parametrize("seed", range(15))
def test_replay_ledger_loaded_from_the_database_behaves_like_the_live_one(seed: int) -> None:
    rng = random.Random(4000 + seed)
    events = make_events(rng, 30)
    live = Rig()
    live.process(events)
    reloaded = Rig(AcknowledgedIds(e.event_id for e in events))  # a new process, ids from storage
    reloaded.process(events)
    assert reloaded.outcomes == ["duplicate"] * len(events)
    assert all(
        state == PassageMastery(plan_id=PLAN, passage_id=pid)
        for pid, state in reloaded.states.items()
    )


# --- invariants of the state machine under random play -------------------------------------------

# One call can pass through two moves: a round of three correct answers on a new passage ends
# reviewing, because its own answers are the first three consecutive correct ones.
ALLOWED_MOVES = {
    ("new", "new"),
    ("new", "learning"),
    ("new", "reviewing"),
    ("learning", "learning"),
    ("learning", "reviewing"),
    ("reviewing", "reviewing"),
    ("reviewing", "confirmed"),
    ("confirmed", "confirmed"),
    ("confirmed", "needs_refresh"),
    ("needs_refresh", "needs_refresh"),
    ("needs_refresh", "confirmed"),
}


def check_step(
    before: PassageMastery, after: PassageMastery, learner: Learner, covered_before: set
):
    assert after.violations() == ()
    assert (before.status, after.status) in ALLOWED_MOVES
    assert covered_before <= learner.covered  # evidence is never taken away
    if before.initial_success_at is not None:
        assert after.initial_success_at == before.initial_success_at
        assert after.initial_learning_date == before.initial_learning_date
    if before.first_confirmed_at is not None:
        assert after.first_confirmed_at == before.first_confirmed_at  # kept after a lapse
    assert after.lapse_count >= before.lapse_count
    assert after.lapse_count - before.lapse_count in (0, 1)
    assert after.review_stage <= before.review_stage + 1
    assert after.consecutive_correct >= 0
    if after.status == "confirmed":
        assert is_fully_covered(learner.parts, learner.covered)
        assert after.maintenance_stage >= 1
    if after.status in ("reviewing", "confirmed", "needs_refresh"):
        assert after.next_review_due is not None


def play(seed: int):
    """Random attempts and rounds over a growing calendar; yields ``(before, after, learner)``."""
    rng = random.Random(seed)
    learner = Learner(parts=rng.randint(1, 8), name=f"fuzz{seed}")
    today = 0
    for _ in range(rng.randint(40, 160)):
        today += rng.choice([0, 0, 0, 1, 1, 2, 4, 9, 40])
        before, covered_before = learner.state, set(learner.covered)
        count = rng.choice([1, 1, 2, 3])
        parts = [tuple(rng.sample(range(1, len(learner.parts) + 1), 1)) for _ in range(count)]

        def attempt():
            return ValidatedAttempt(
                correct=rng.random() < 0.8,
                assisted=rng.random() < 0.1,
                error_kind="none",
            )

        if rng.random() < 0.5:
            single = attempt()
            learner.answer(single, *parts[0], on=today)
        else:
            learner.review(*[(attempt(), p) for p in parts], on=today)
        yield before, learner.state, learner, covered_before, today


@pytest.mark.parametrize("seed", range(60))
def test_random_play_keeps_every_invariant_of_contract_4(seed: int) -> None:
    for before, after, learner, covered_before, _ in play(seed):
        check_step(before, after, learner, covered_before)


@pytest.mark.parametrize("seed", range(40))
def test_rule3_a_passing_round_applied_twice_on_one_date_equals_applied_once(seed: int) -> None:
    """At most one stage per learning date per passage, over every state random play reaches."""
    for _, after, learner, _, today in play(5000 + seed):
        if after.status not in ("reviewing", "confirmed", "needs_refresh"):
            continue
        passed = RoundResult(passed=True)
        kwargs = {
            "passage_part_ids": learner.parts,
            "covered_part_ids": learner.covered,
            "review_date": day(today),
            "now": at(today),
        }
        once = apply_round(after, passed, **kwargs)
        assert apply_round(once, passed, **kwargs) == once


@pytest.mark.parametrize("seed", range(40))
def test_rule3_a_failing_round_always_ends_at_stage_one_due_the_next_day(seed: int) -> None:
    rng = random.Random(6000 + seed)
    for _, after, learner, _, today in play(6000 + seed):
        if after.status not in ("reviewing", "confirmed", "needs_refresh"):
            continue
        part = learner.part(rng.randint(1, len(learner.parts)))
        failed = apply_round(
            after,
            summarize_round([RoundAnswer(uid("q"), False, False, (part,))]),
            passage_part_ids=learner.parts,
            covered_part_ids=learner.covered,
            review_date=day(today),
            now=at(today),
        )
        assert failed.review_stage == 1
        assert failed.next_review_due == day(today + 1)
        assert failed.lapse_count == after.lapse_count + 1
        assert failed.initial_success_at == after.initial_success_at
        assert failed.confirmed_at is None
        assert failed.first_confirmed_at == after.first_confirmed_at


def test_random_play_reaches_every_status_so_the_invariants_are_not_vacuous() -> None:
    seen: set[str] = set()
    for seed in range(60):
        for _, after, *_ in play(seed):
            seen.add(after.status)
    assert seen == {"learning", "reviewing", "confirmed", "needs_refresh"}


def test_right_and_wrong_helpers_are_the_graded_attempts_the_rules_expect() -> None:
    assert right().correct and not right().assisted
    assert not wrong().correct and not wrong().assisted
