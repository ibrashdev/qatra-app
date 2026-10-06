"""The pure offline policy: download targets, the sessions of a snapshot, the downloadable rule, the
mismatch check and the status derivation (API-spec E23 to E25; offline-decisions G-01, G-02, G-05,
G-12)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import UUID

import pytest

from app.domain.learning_state import PassageMastery
from app.domain.offline_policy import (
    MAX_PREPARED_SESSIONS,
    MAX_TARGET_REFS,
    Current,
    Held,
    derive_status,
    edition_downloadable,
    prepared_session_kinds,
    runnable_session_ids,
    select_download_targets,
    snapshot_mismatches,
)
from app.domain.session_policy import PassageInfo

TODAY = date(2026, 10, 5)
PLAN = UUID(int=900)
EDITION = UUID(int=901)


def passage(n: int, section: int = 1) -> PassageInfo:
    return PassageInfo(
        id=UUID(int=n),
        section_ordinal=section,
        path="quran",
        ordinal=n,
        start=(n, 0),
        word_count=10,
        parts=(),
    )


def row(n: int, status: str, *, due: date | None = None) -> PassageMastery:
    return PassageMastery(
        plan_id=PLAN,
        passage_id=UUID(int=n),
        status=status,
        initial_success_at=datetime(2026, 10, 1, tzinfo=UTC) if status != "new" else None,
        initial_learning_date=date(2026, 10, 1) if status != "new" else None,
        next_review_due=due,
    )


def ids(*numbers: int) -> list[UUID]:
    return [UUID(int=n) for n in numbers]


# --- targets -------------------------------------------------------------------------------------


def test_new_passages_come_in_plan_order_and_stop_at_the_limit() -> None:
    scope = [passage(n) for n in range(1, 101)]
    chosen = select_download_targets(scope, "book", {}, TODAY)
    assert len(chosen) == MAX_TARGET_REFS == 60
    assert chosen == ids(*range(1, 61))


def test_a_small_scope_is_taken_whole_in_plan_order() -> None:
    scope = [passage(3, section=2), passage(1), passage(2)]
    assert select_download_targets(scope, "book", {}, TODAY) == ids(1, 2, 3)
    assert select_download_targets(scope, "reverse", {}, TODAY) == ids(3, 1, 2)


def test_due_reviews_and_passages_in_learning_come_before_new_ones() -> None:
    scope = [passage(n) for n in range(1, 11)]
    mastery = {
        UUID(int=9): row(9, "reviewing", due=date(2026, 10, 4)),  # overdue
        UUID(int=7): row(7, "learning"),
        UUID(int=2): row(2, "reviewing", due=date(2026, 10, 9)),  # not due yet
        UUID(int=1): row(1, "confirmed", due=date(2026, 11, 1)),
    }
    chosen = select_download_targets(scope, "book", mastery, TODAY, limit=4)
    # due (9), learning (7), then the first new ones (3, 4): returned in plan order
    assert chosen == ids(3, 4, 7, 9)


def test_passages_that_are_not_due_fill_the_rest_when_nothing_is_new() -> None:
    scope = [passage(n) for n in range(1, 5)]
    mastery = {UUID(int=n): row(n, "confirmed", due=date(2026, 12, 1)) for n in range(1, 5)}
    assert select_download_targets(scope, "book", mastery, TODAY) == ids(1, 2, 3, 4)


def test_the_choice_is_deterministic_and_has_no_duplicates() -> None:
    scope = [passage(n) for n in range(1, 30)]
    mastery = {UUID(int=5): row(5, "learning")}
    first = select_download_targets(scope, "book", mastery, TODAY, limit=10)
    assert first == select_download_targets(list(reversed(scope)), "book", mastery, TODAY, limit=10)
    assert len(set(first)) == len(first) == 10


def test_an_empty_scope_gives_no_targets() -> None:
    assert select_download_targets([], "book", {}, TODAY) == []


# --- sessions ------------------------------------------------------------------------------------


def test_one_daily_and_one_game_per_type_and_within_the_cap() -> None:
    kinds = prepared_session_kinds()
    assert [kind for kind, _ in kinds].count("daily") == 1
    games = [game_type for kind, game_type in kinds if kind == "game"]
    assert sorted(games) == sorted(
        ["word_order", "word_choice", "word_recall", "similar_distinction"]
    )
    assert len(kinds) == 5 <= MAX_PREPARED_SESSIONS == 7


def test_only_completed_sessions_are_not_runnable() -> None:
    states = [(UUID(int=1), "prepared"), (UUID(int=2), "open"), (UUID(int=3), "completed")]
    assert runnable_session_ids(states) == ids(1, 2)


# --- downloadable --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("selectable", "rejected", "expected"),
    [(True, False, True), (False, False, False), (True, True, False), (False, True, False)],
)
def test_an_edition_is_downloadable_when_selectable_and_its_rights_are_not_rejected(
    selectable: bool, rejected: bool, expected: bool
) -> None:
    assert edition_downloadable(selectable=selectable, rights_rejected=rejected) is expected


# --- mismatch ------------------------------------------------------------------------------------

HELD = Held(plan_version=2, edition_id=EDITION, bank_version=1)


def test_a_snapshot_that_matches_has_no_mismatch() -> None:
    assert snapshot_mismatches(HELD, HELD) == []


def test_every_differing_field_is_named_by_its_api_name() -> None:
    other = Held(plan_version=3, edition_id=UUID(int=902), bank_version=2)
    assert snapshot_mismatches(other, HELD) == ["expectedPlanVersion", "editionId", "bankVersion"]
    assert snapshot_mismatches(Held(2, EDITION, 5), HELD) == ["bankVersion"]


# --- status --------------------------------------------------------------------------------------


def current(**changes: object) -> Current:
    values: dict[str, object] = {
        "plan_status": "active",
        "plan_version": 2,
        "edition_readable": True,
        "bank_version": 1,
    }
    values.update(changes)
    return Current(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("changes", "status", "reason"),
    [
        ({}, "available", "current"),
        ({"plan_version": 3}, "stale", "plan_version_changed"),
        ({"plan_status": "paused"}, "stale", "plan_version_changed"),
        ({"plan_status": "completed"}, "stale", "plan_version_changed"),
        ({"bank_version": 2}, "stale", "bank_version_changed"),
        ({"plan_version": 3, "bank_version": 2}, "stale", "plan_version_changed"),
        ({"edition_readable": False, "bank_version": None}, "revoked", "content_revoked"),
        ({"rights_withdrawn": True}, "revoked", "content_revoked"),
        ({"rights_withdrawn": True, "plan_version": 3}, "revoked", "content_revoked"),
        ({"rights_withdrawn": True, "edition_superseded": True}, "revoked", "content_revoked"),
        ({"edition_superseded": True}, "stale", "bank_version_changed"),
        ({"edition_superseded": True, "plan_version": 3}, "stale", "plan_version_changed"),
        ({"validity_ended": True}, "expired", "validity_ended"),
        ({"validity_ended": True, "plan_version": 3}, "expired", "validity_ended"),
    ],
)
def test_status_derivation_matrix(changes: dict[str, object], status: str, reason: str) -> None:
    assert derive_status(HELD, current(**changes)) == (status, reason)
