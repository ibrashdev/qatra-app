from __future__ import annotations

import pytest

from app.domain.rate_limit import SlidingWindowLimiter


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_allows_up_to_the_limit_then_blocks_with_retry_after() -> None:
    clock = FakeClock()
    limiter = SlidingWindowLimiter(3, 60, clock=clock)
    assert all(limiter.check("a").allowed for _ in range(3))
    clock.now += 10
    decision = limiter.check("a")
    assert not decision.allowed
    assert decision.retry_after_sec == 50


def test_window_slides_and_blocked_attempts_are_not_recorded() -> None:
    clock = FakeClock()
    limiter = SlidingWindowLimiter(2, 60, clock=clock)
    assert limiter.check("a").allowed
    clock.now += 30
    assert limiter.check("a").allowed
    assert not limiter.check("a").allowed  # blocked attempt, not recorded
    clock.now += 31  # first hit (t=0) has left the window
    assert limiter.check("a").allowed
    assert not limiter.check("a").allowed


def test_keys_are_independent() -> None:
    limiter = SlidingWindowLimiter(1, 60, clock=FakeClock())
    assert limiter.check("a").allowed
    assert limiter.check("b").allowed
    assert not limiter.check("a").allowed


def test_retry_after_is_at_least_one_second() -> None:
    clock = FakeClock()
    limiter = SlidingWindowLimiter(1, 60, clock=clock)
    limiter.check("a")
    clock.now += 59.9
    assert limiter.check("a").retry_after_sec == 1


def test_tracked_keys_are_bounded() -> None:
    limiter = SlidingWindowLimiter(1, 60, max_keys=5, clock=FakeClock())
    for index in range(50):
        assert limiter.check(f"key-{index}").allowed
    assert len(limiter._hits) <= 5


def test_limit_must_be_positive() -> None:
    with pytest.raises(ValueError):
        SlidingWindowLimiter(0)
