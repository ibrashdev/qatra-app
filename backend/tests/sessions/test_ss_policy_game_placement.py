"""Game and placement composition (contract §5, API-spec E20): synthetic fixtures only."""

from __future__ import annotations

import pytest

from app.domain.session_policy import (
    GAME_QUESTION_CAP,
    PLACEMENT_PASSAGE_CAP,
    GameInputs,
    PlacementInputs,
    compose_game,
    compose_placement,
    placement_buckets,
    plan_order,
    sample_placement_passages,
)
from tests.sessions.ss_policy_support import (
    NAMES,
    SEED,
    at,
    full_bank,
    loader,
    mastery,
    part_id,
    passage,
    question,
    uid,
)


def bank_index(banks):
    return {q.id: q for questions in banks.values() for q in questions}


def game(passages, banks, *, game_type=None, rows=None, seed=SEED, **loader_kwargs):
    return compose_game(
        GameInputs(
            passages=tuple(passages), game_type=game_type, mastery=dict(rows or {}), seed=seed
        ),
        loader(banks, **loader_kwargs),
    )


# --- game ----------------------------------------------------------------------------------------


def test_a_game_has_at_most_ten_questions_one_per_passage_first() -> None:
    passages = [passage(f"g{n:02d}", section=n, words=(4, 4, 4)) for n in range(1, 16)]
    banks = {p.id: full_bank(p) for p in passages}
    planned = game(passages, banks)
    assert len(planned) == GAME_QUESTION_CAP == 10
    assert len({q.passage_id for q in planned}) == 10  # spread over ten passages
    assert {q.role for q in planned} == {"game"}
    assert all(q.review_round_id is None for q in planned)
    assert len({q.question_id for q in planned}) == 10


def test_a_game_over_few_passages_goes_deeper_without_repeating_a_question() -> None:
    a = passage("a", section=1, words=(4, 4, 4, 4))
    b = passage("b", section=2, words=(4, 4, 4, 4))
    banks = {p.id: full_bank(p) for p in (a, b)}
    planned = game([a, b], banks)
    assert len(planned) == 10
    assert {q.passage_id for q in planned} == {a.id, b.id}
    assert len({q.question_id for q in planned}) == 10


def test_a_game_with_fewer_available_questions_is_short_not_padded() -> None:
    a = passage("a", words=(4,))
    banks = {a.id: [question(a, "c", "word_choice", (1,)), question(a, "r", "word_recall", (1,))]}
    planned = game([a], banks)
    assert len(planned) == 2


@pytest.mark.parametrize("kind", ["word_order", "word_choice", "word_recall"])
def test_a_game_type_filters_the_questions(kind: str) -> None:
    passages = [passage(f"g{n}", section=n, words=(4, 4, 4)) for n in range(1, 5)]
    banks = {p.id: full_bank(p) for p in passages}
    index = bank_index(banks)
    planned = game(passages, banks, game_type=kind)
    assert planned and {index[q.question_id].type for q in planned} == {kind}


def test_a_game_type_without_questions_gives_an_empty_game_after_loading_every_chunk() -> None:
    passages = [passage(f"g{n:02d}", section=n, words=(4, 4, 4)) for n in range(1, 26)]
    banks = {p.id: full_bank(p) for p in passages}  # no similar_distinction question anywhere
    calls: list = []
    assert game(passages, banks, game_type="similar_distinction", calls=calls) == ()
    assert [len(c) for c in calls] == [10, 10, 5]  # chunks of ten, until the candidates ran out


def test_a_game_loads_one_chunk_when_it_already_has_ten_questions() -> None:
    passages = [passage(f"g{n:02d}", section=n, words=(4, 4, 4)) for n in range(1, 26)]
    banks = {p.id: full_bank(p) for p in passages}
    calls: list = []
    assert len(game(passages, banks, calls=calls)) == 10
    assert len(calls) == 1 and len(calls[0]) == 10


def test_a_game_finds_the_rare_type_in_a_later_chunk() -> None:
    passages = [passage(f"g{n:02d}", section=n, words=(4, 4, 4)) for n in range(1, 26)]
    banks = {p.id: full_bank(p) for p in passages}
    rare = passages[-1]
    banks[rare.id] = [*banks[rare.id], question(rare, "s", "similar_distinction", (1,))]
    planned = game(passages, banks, game_type="similar_distinction")
    assert [q.passage_id for q in planned] == [rare.id]


def test_a_game_takes_error_passages_and_error_parts_first() -> None:
    passages = [passage(f"g{n:02d}", section=n, words=(4, 4, 4, 4)) for n in range(1, 21)]
    banks = {p.id: full_bank(p) for p in passages}
    index = bank_index(banks)
    flawed = passages[13]
    rows = {flawed.id: mastery(flawed, "reviewing", errors=(3,))}
    planned = game(passages, banks, rows=rows)
    assert planned[0].passage_id == flawed.id  # a passage with error parts leads
    assert index[planned[0].question_id].covered_part_ids == (part_id(flawed, 3),)


def test_a_game_prefers_the_least_recently_tested_part() -> None:
    a = passage("a", words=(4, 4, 4))
    banks = {a.id: full_bank(a)}
    index = bank_index(banks)
    tested = {part_id(a, 1): at(20), part_id(a, 3): at(10)}  # part 2 was never tested
    planned = game([a], banks, last_tested=tested)
    parts = [index[q.question_id].covered_part_ids[0] for q in planned[:3]]
    assert parts == [part_id(a, 2), part_id(a, 3), part_id(a, 1)]


def test_a_game_never_shows_the_same_question_in_one_session_and_is_deterministic() -> None:
    passages = [passage(f"g{n}", section=n, words=(4, 4, 4)) for n in range(1, 4)]
    banks = {p.id: full_bank(p) for p in passages}
    assert game(passages, banks) == game(passages, banks)
    assert len({game(passages, banks, seed=s) for s in range(8)}) > 1


def test_a_game_without_candidates_is_empty_and_an_unknown_type_is_refused() -> None:
    assert game([], {}) == ()
    with pytest.raises(ValueError):
        game([passage("a")], {}, game_type="word_swap")


# --- placement -----------------------------------------------------------------------------------


def test_placement_samples_up_to_eight_passages_evenly_in_book_order() -> None:
    passages = [passage(f"s{n:02d}", section=n, words=(4, 4, 4)) for n in range(1, 38)]
    banks = {p.id: full_bank(p) for p in passages}
    chosen = sample_placement_passages(passages)
    ordered = plan_order(passages, "book")
    positions = [ordered.index(p) for p in chosen]
    assert len(positions) == PLACEMENT_PASSAGE_CAP == 8
    assert positions == sorted(set(positions))
    gaps = [b - a for a, b in zip(positions, positions[1:], strict=False)]
    assert max(gaps) - min(gaps) <= 1  # evenly spread
    assert positions[0] < len(ordered) // 8 and positions[-1] >= len(ordered) - len(ordered) // 8
    planned = compose_placement(PlacementInputs(tuple(passages), SEED), loader(banks))
    assert [NAMES[q.passage_id] for q in planned] == [NAMES[p.id] for p in chosen]
    assert {q.role for q in planned} == {"placement"}


@pytest.mark.parametrize("count", [1, 3, 8])
def test_placement_with_few_passages_uses_them_all(count: int) -> None:
    passages = [passage(f"s{n}", section=n) for n in range(1, count + 1)]
    banks = {p.id: full_bank(p) for p in passages}
    planned = compose_placement(PlacementInputs(tuple(passages), SEED), loader(banks))
    assert [NAMES[q.passage_id] for q in planned] == [f"s{n}" for n in range(1, count + 1)]


@pytest.mark.parametrize("count", [0, 1, 7, 8, 9, 15, 16, 37, 114])
def test_placement_buckets_partition_the_scope_exactly(count: int) -> None:
    buckets = placement_buckets(count)
    assert len(buckets) == min(count, 8)
    covered = [i for bucket in buckets for i in bucket]
    assert covered == list(range(count))
    assert all(len(bucket) >= 1 for bucket in buckets)


def test_placement_asks_one_choice_or_recall_question_per_passage_alternating() -> None:
    passages = [passage(f"s{n}", section=n, words=(4, 4, 4)) for n in range(1, 9)]
    banks = {p.id: full_bank(p) for p in passages}
    index = bank_index(banks)
    planned = compose_placement(PlacementInputs(tuple(passages), SEED), loader(banks))
    types = [index[q.question_id].type for q in planned]
    assert types == ["word_choice", "word_recall"] * 4
    assert len({q.passage_id for q in planned}) == 8  # one per passage
    assert all(index[q.question_id].type != "word_order" for q in planned)


def test_placement_prefers_the_what_comes_next_form() -> None:
    a = passage("a", words=(4, 4))
    b = passage("b", section=2, words=(4, 4))
    banks = {
        a.id: [
            question(a, "w", "word_choice", (2,), "word"),
            question(a, "s", "word_choice", (2,), "segment"),
        ],
        b.id: [
            question(b, "k", "word_recall", (2,), "keyword"),
            question(b, "n", "word_recall", (2,), "continuation"),
        ],
    }
    planned = compose_placement(PlacementInputs((a, b), SEED), loader(banks))
    assert [q.question_id for q in planned] == [uid(a.id, "q", "s"), uid(b.id, "q", "n")]


def test_placement_falls_back_to_the_other_type_and_skips_a_slice_with_nothing_usable() -> None:
    a = passage("a", section=1)
    b = passage("b", section=2)
    c = passage("c", section=3)
    d = passage("d", section=4)
    banks = {
        a.id: [question(a, "r", "word_recall", (1,), "keyword")],  # wants a choice: recall instead
        b.id: [],  # nothing at all: replaced by its neighbour in the same slice
        c.id: [question(c, "c", "word_choice", (1,), "word")],
        d.id: [question(d, "o", "word_order", (1,))],  # only an order question: unusable
    }
    planned = compose_placement(PlacementInputs((a, b, c, d), SEED), loader(banks))
    # four passages give four slices of one; b and d have nothing, so only a and c ask.
    assert [NAMES[q.passage_id] for q in planned] == ["a", "c"]


def test_placement_replaces_an_empty_passage_by_a_neighbour_in_its_own_slice() -> None:
    passages = [passage(f"s{n:02d}", section=n, words=(4, 4)) for n in range(1, 17)]
    banks = {p.id: full_bank(p) for p in passages}
    ordered = plan_order(passages, "book")
    primary = sample_placement_passages(passages)
    emptied = primary[0]
    banks[emptied.id] = []
    planned = compose_placement(PlacementInputs(tuple(passages), SEED), loader(banks))
    assert len(planned) == 8
    first_slice = {NAMES[p.id] for p in ordered[placement_buckets(16)[0].start : 2]}
    assert NAMES[planned[0].passage_id] in first_slice
    assert planned[0].passage_id != emptied.id


def test_placement_is_deterministic_and_empty_without_passages() -> None:
    passages = [passage(f"s{n}", section=n, words=(4, 4, 4)) for n in range(1, 6)]
    banks = {p.id: full_bank(p) for p in passages}
    inputs = PlacementInputs(tuple(passages), SEED)
    assert compose_placement(inputs, loader(banks)) == compose_placement(inputs, loader(banks))
    assert compose_placement(PlacementInputs((), SEED), loader({})) == ()
