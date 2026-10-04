"""Sliding-window rate limiting policy (pure: no framework or database imports).

State is per process. The free Render web service runs one instance (D48/D72), so an
in-memory window is sufficient for the per-client-IP classes of API-spec §1.8.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RateDecision:
    allowed: bool
    retry_after_sec: int = 0


class SlidingWindowLimiter:
    """Allow at most ``limit`` hits per ``window_sec`` for each key. Thread-safe.

    Rejected attempts are not recorded, so a blocked client is released as soon as its
    oldest recorded hit leaves the window. The number of tracked keys is bounded.
    """

    def __init__(
        self,
        limit: int,
        window_sec: float = 60.0,
        *,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if limit < 1:
            raise ValueError("limit must be at least 1")
        self._limit = limit
        self._window = window_sec
        self._max_keys = max_keys
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> RateDecision:
        now = self._clock()
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                self._make_room(now)
                hits = self._hits[key] = deque()
            cutoff = now - self._window
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self._limit:
                wait = hits[0] + self._window - now
                return RateDecision(False, max(1, math.ceil(wait)))
            hits.append(now)
            return RateDecision(True)

    def _make_room(self, now: float) -> None:
        if len(self._hits) < self._max_keys:
            return
        cutoff = now - self._window
        for key in [k for k, h in self._hits.items() if not h or h[-1] <= cutoff]:
            del self._hits[key]
        while len(self._hits) >= self._max_keys:
            del self._hits[next(iter(self._hits))]
