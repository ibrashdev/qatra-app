"""Contract §7 "Activity events": overlapping intervals of the same account and date are merged
(union) before totals, so no time is credited twice. Examples and seeded properties (pure)."""

from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.domain.time_policy import (
    Interval,
    added_ms,
    merge_activity_intervals,
    session_active_ms,
    union_ms,
)
from tests.progress.time_support import BASE, ms, sec, span

# --- examples ------------------------------------------------------------------------------------


def test_union_of_no_intervals_is_zero() -> None:
    assert union_ms([]) == 0
    assert merge_activity_intervals([]) == ()


def test_disjoint_intervals_add_up() -> None:
    assert union_ms([span(0, 60), span(120, 180)]) == 120_000


def test_overlapping_intervals_are_credited_once() -> None:
    assert union_ms([span(0, 60), span(30, 90)]) == 90_000


def test_touching_intervals_merge_without_gaining_or_losing_time() -> None:
    assert merge_activity_intervals([span(0, 60), span(60, 120)]) == (span(0, 120),)
    assert union_ms([span(0, 60), span(60, 120)]) == 120_000


def test_an_interval_inside_another_adds_nothing() -> None:
    assert union_ms([span(0, 300), span(100, 200)]) == 300_000


def test_the_same_interval_sent_twice_is_credited_once() -> None:
    assert union_ms([span(10, 70), span(10, 70)]) == 60_000


def test_intervals_in_any_order_give_the_same_union() -> None:
    items = [span(200, 260), span(0, 60), span(50, 120), span(300, 301)]
    assert union_ms(items) == union_ms(list(reversed(items))) == 120_000 + 60_000 + 1_000


def test_a_zero_length_interval_adds_nothing() -> None:
    assert union_ms([span(30, 30)]) == 0
    assert union_ms([span(0, 60), span(30, 30)]) == 60_000


def test_merged_intervals_are_ascending_and_strictly_separated() -> None:
    merged = merge_activity_intervals([span(100, 130), span(0, 40), span(30, 60), span(200, 210)])
    assert merged == (span(0, 60), span(100, 130), span(200, 210))


def test_two_devices_that_were_active_at_the_same_time_are_credited_once() -> None:
    phone = [span(0, 120), span(300, 420)]
    tablet = [span(60, 180), span(300, 420)]
    assert union_ms([*phone, *tablet]) == 120_000 + 60_000 + 120_000


def test_a_replayed_event_adds_nothing_to_what_is_already_credited() -> None:
    credited = [span(0, 60), span(100, 160)]
    assert added_ms(credited, span(100, 160)) == 0
    assert added_ms(credited, span(110, 150)) == 0


def test_a_new_interval_adds_only_the_part_not_yet_credited() -> None:
    credited = [span(0, 60)]
    assert added_ms(credited, span(40, 100)) == 40_000
    assert added_ms(credited, span(200, 230)) == 30_000
    assert added_ms([], span(5, 8)) == 3_000


def test_lengths_are_whole_milliseconds_of_the_exact_sum() -> None:
    first = Interval(BASE, BASE + timedelta(microseconds=1_700))
    second = Interval(BASE + timedelta(seconds=1), BASE + timedelta(seconds=1, microseconds=1_700))
    assert first.length_ms == 1
    assert union_ms([first, second]) == 3  # 3.4 ms in total, floored once, not per interval


def test_an_interval_needs_timezone_aware_ends_in_the_right_order() -> None:
    with pytest.raises(ValueError):
        Interval(datetime(2026, 10, 5, 7, 0), datetime(2026, 10, 5, 7, 1))
    with pytest.raises(ValueError):
        Interval(sec(10), sec(5))


def test_ends_in_different_time_zones_compare_as_instants() -> None:
    local = timezone(timedelta(hours=4))
    one = Interval(
        datetime(2026, 10, 5, 11, 0, tzinfo=local), datetime(2026, 10, 5, 11, 10, tzinfo=local)
    )
    other = Interval(
        datetime(2026, 10, 5, 7, 5, tzinfo=UTC), datetime(2026, 10, 5, 7, 20, tzinfo=UTC)
    )
    assert union_ms([one, other]) == 20 * 60_000  # 07:00 to 07:20 UTC


def test_session_active_time_is_the_union_of_that_sessions_own_intervals() -> None:
    mine = [span(0, 60), span(30, 90)]
    other_session = [span(0, 600)]
    assert session_active_ms(mine) == 90_000
    assert union_ms([*mine, *other_session]) == 600_000  # the day counts the overlap only once


def test_session_active_time_is_a_function_of_the_stored_intervals_only() -> None:
    """The figure E22 reports (and stores as ``elapsed_ms``) is derived from the intervals alone, so
    completing a session cannot add time; the service test checks that E22 writes no daily row."""
    intervals = [span(0, 60), span(120, 150)]
    assert session_active_ms(intervals) == session_active_ms(list(reversed(intervals))) == 90_000


# --- seeded properties ---------------------------------------------------------------------------


def random_intervals(rng: random.Random, count: int, horizon_ms: int = 2_000) -> list[Interval]:
    items = []
    for _ in range(count):
        start = rng.randrange(horizon_ms)
        end = start + rng.randrange(0, horizon_ms // 2)
        items.append(Interval(BASE + ms(start), BASE + ms(end)))
    return items


def brute_force_ms(items: list[Interval]) -> int:
    """The union by counting covered milliseconds one by one (small horizons only)."""
    covered: set[int] = set()
    for item in items:
        start = (item.start - BASE) // ms(1)
        covered.update(range(start, start + item.length_ms))
    return len(covered)


@pytest.mark.parametrize("seed", range(40))
def test_union_matches_a_millisecond_by_millisecond_count(seed: int) -> None:
    rng = random.Random(seed)
    items = random_intervals(rng, rng.randint(0, 14))
    assert union_ms(items) == brute_force_ms(items)


@pytest.mark.parametrize("seed", range(30))
def test_union_does_not_depend_on_the_order_of_the_intervals(seed: int) -> None:
    rng = random.Random(100 + seed)
    items = random_intervals(rng, rng.randint(1, 20))
    shuffled = list(items)
    rng.shuffle(shuffled)
    assert union_ms(shuffled) == union_ms(items)
    assert merge_activity_intervals(shuffled) == merge_activity_intervals(items)


@pytest.mark.parametrize("seed", range(30))
def test_sending_every_interval_again_never_adds_time(seed: int) -> None:
    rng = random.Random(200 + seed)
    items = random_intervals(rng, rng.randint(1, 20))
    again = items + [i for i in items if rng.random() < 0.7] + items
    assert union_ms(again) == union_ms(items)


@pytest.mark.parametrize("seed", range(30))
def test_the_union_is_never_more_than_the_sum_and_never_less_than_the_longest(seed: int) -> None:
    rng = random.Random(300 + seed)
    items = random_intervals(rng, rng.randint(1, 20))
    total = union_ms(items)
    assert max(i.length_ms for i in items) <= total <= sum(i.length_ms for i in items)


@pytest.mark.parametrize("seed", range(30))
def test_merging_gives_sorted_disjoint_intervals_and_is_idempotent(seed: int) -> None:
    rng = random.Random(400 + seed)
    merged = merge_activity_intervals(random_intervals(rng, rng.randint(1, 20)))
    for left, right in zip(merged, merged[1:], strict=False):
        assert left.end < right.start
    assert merge_activity_intervals(merged) == merged


@pytest.mark.parametrize("seed", range(30))
def test_crediting_events_one_by_one_adds_up_to_the_union(seed: int) -> None:
    """The service credits each new event with ``added_ms``: the running total is the union."""
    rng = random.Random(500 + seed)
    items = random_intervals(rng, rng.randint(1, 20))
    credited: list[Interval] = []
    total = 0
    for item in items:
        total += added_ms(credited, item)
        credited.append(item)
    assert total == union_ms(items)


@pytest.mark.parametrize("seed", range(30))
def test_splitting_an_interval_into_touching_halves_changes_nothing(seed: int) -> None:
    rng = random.Random(600 + seed)
    items = random_intervals(rng, rng.randint(1, 10))
    target = rng.choice(items)
    middle = target.start + (target.end - target.start) / 2
    halves = [Interval(target.start, middle), Interval(middle, target.end)]
    rest = [i for i in items if i is not target]
    assert union_ms([*rest, *halves]) == union_ms(items)


@pytest.mark.parametrize("seed", range(30))
def test_two_devices_never_credit_more_than_their_combined_union(seed: int) -> None:
    rng = random.Random(700 + seed)
    phone = random_intervals(rng, rng.randint(1, 10))
    tablet = random_intervals(rng, rng.randint(1, 10))
    both = union_ms([*phone, *tablet])
    assert both <= union_ms(phone) + union_ms(tablet)
    assert both >= max(union_ms(phone), union_ms(tablet))
