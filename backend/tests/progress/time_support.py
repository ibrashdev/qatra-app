"""Synthetic fixtures for the pure time-policy tests (no database, no network)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.time_policy import ActivityVerdict, Interval, validate_activity

BASE = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
CREATED = BASE  # the session was created at 07:00:00 UTC
SERVER_NOW = BASE + timedelta(minutes=10)  # and the server clock reads 07:10:00 UTC
ZONE = "Asia/Dubai"  # UTC+4, no daylight saving time


def ms(n: int) -> timedelta:
    return timedelta(milliseconds=n)


def sec(n: float) -> datetime:
    """An instant ``n`` seconds after ``BASE``."""
    return BASE + timedelta(seconds=n)


def span(start_s: float, end_s: float) -> Interval:
    """An interval from ``start_s`` to ``end_s`` seconds after ``BASE``."""
    return Interval(sec(start_s), sec(end_s))


def check(
    started: datetime,
    ended: datetime,
    active_ms: int,
    *,
    kind: str = "daily",
    now: datetime = SERVER_NOW,
    created: datetime = CREATED,
    **zone: Any,
) -> ActivityVerdict:
    """``validate_activity`` with the fixed session and server clock of the module."""
    return validate_activity(
        started_at=started,
        ended_at=ended,
        active_ms=active_ms,
        server_now=now,
        session_created_at=created,
        session_kind=kind,
        time_zone=zone.pop("time_zone", ZONE),
        **zone,
    )
