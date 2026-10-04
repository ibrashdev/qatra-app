"""The learning store as package B4's placement reader: the same answers as the PostgREST reader."""

from __future__ import annotations

from dataclasses import replace
from uuid import UUID

import pytest

from app.domain.planning_port import PlacementNotFound
from app.repositories.learning import InMemoryLearningStore, PostgrestLearningRepository
from app.repositories.plans import PlacementReader, PostgrestPlacementReader
from tests.sessions.ss_learning_support import Harness, attempt, new_session
from tests.sessions.ss_postgrest import TOKEN, FakePostgrest
from tests.sessions.ss_support import HADITH_EDITION, OTHER_USER, QURAN_EDITION, ctx

PLACEMENT = UUID("55555555-5555-4555-8555-0000000000a1")
DAILY = UUID("55555555-5555-4555-8555-0000000000a2")
EMPTY = UUID("55555555-5555-4555-8555-0000000000a3")
PASSAGES = [UUID(int=2000 + n) for n in range(4)]
LEARNER = ctx(token=TOKEN)
STRANGER = ctx(OTHER_USER, token=TOKEN)


def open_placement(harness: Harness, session_id: UUID) -> None:
    new = new_session(1, kind="placement", plan=False)
    harness.repo.open_session(LEARNER, replace(new, session_id=session_id))


def seed(harness: Harness) -> None:
    """A placement session with one known, one wrong and one hinted passage; an empty placement
    session; and a daily session whose attempts must not count."""
    open_placement(harness, PLACEMENT)
    open_placement(harness, EMPTY)
    harness.repo.open_session(LEARNER, replace(new_session(2), session_id=DAILY))
    rows = [
        (PLACEMENT, PASSAGES[0], True, False),
        (PLACEMENT, PASSAGES[1], False, False),
        (PLACEMENT, PASSAGES[2], True, True),
        (DAILY, PASSAGES[3], True, False),
    ]
    for number, (session, passage, correct, assisted) in enumerate(rows, start=1):
        harness.seed_attempt(
            replace(
                attempt(number, passage=passage),
                session_id=session,
                correct=correct,
                assisted=assisted,
            )
        )


def memory() -> PlacementReader:
    store = InMemoryLearningStore()
    seed(Harness("memory", store, store=store))
    return store


def supabase() -> PlacementReader:
    fake = FakePostgrest()
    seed(Harness("postgrest", PostgrestLearningRepository(fake.client()), fake=fake))
    return PostgrestPlacementReader(fake.client())


@pytest.fixture(params=[memory, supabase], ids=["memory", "supabase"])
def reader(request: pytest.FixtureRequest) -> PlacementReader:
    return request.param()


def test_only_correct_and_unassisted_answers_of_the_placement_session_are_known(
    reader: PlacementReader,
) -> None:
    assert reader.known_passage_ids(LEARNER, PLACEMENT, QURAN_EDITION) == {PASSAGES[0]}


def test_a_placement_session_without_attempts_knows_nothing(reader: PlacementReader) -> None:
    assert reader.known_passage_ids(LEARNER, EMPTY, QURAN_EDITION) == frozenset()


@pytest.mark.parametrize(
    ("who", "session", "edition"),
    [
        (STRANGER, PLACEMENT, QURAN_EDITION),
        (LEARNER, UUID(int=9), QURAN_EDITION),
        (LEARNER, PLACEMENT, HADITH_EDITION),
        (LEARNER, DAILY, QURAN_EDITION),
    ],
    ids=["not the caller's", "unknown", "another edition", "not a placement"],
)
def test_an_unreadable_placement_session_is_not_found(
    reader: PlacementReader, who, session: UUID, edition: UUID
) -> None:
    with pytest.raises(PlacementNotFound):
        reader.known_passage_ids(who, session, edition)
