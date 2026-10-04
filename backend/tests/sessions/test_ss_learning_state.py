from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import UUID

import pytest

from app.domain.learning_state import (
    AttemptRecord,
    PartEvidence,
    PassageMastery,
    parse_date,
    parse_datetime,
    require_date,
    require_datetime,
)
from tests.sessions.ss_policy_support import PLAN, uid

PASSAGE = uid("passage")
PART_A, PART_B = uid("part", "a"), uid("part", "b")

# The 14 keys the app_apply_events header documents for the "mastery" object.
MASTERY_PAYLOAD_KEYS = {
    "plan_id",
    "passage_id",
    "status",
    "consecutive_correct",
    "initial_success_at",
    "initial_learning_date",
    "review_stage",
    "next_review_due",
    "last_review_date",
    "confirmed_at",
    "first_confirmed_at",
    "maintenance_stage",
    "lapse_count",
    "error_part_ids",
}


def row(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "plan_id": str(PLAN),
        "passage_id": str(PASSAGE),
        "status": "reviewing",
        "consecutive_correct": 3,
        "initial_success_at": "2026-09-30T08:15:00+00:00",
        "initial_learning_date": "2026-09-30",
        "review_stage": 1,
        "next_review_due": "2026-10-01",
        "last_review_date": None,
        "confirmed_at": None,
        "first_confirmed_at": None,
        "maintenance_stage": 0,
        "lapse_count": 0,
        "error_part_ids": [str(PART_A)],
    }
    base.update(overrides)
    return base


def test_a_new_mastery_is_consistent_and_never_due() -> None:
    new = PassageMastery(plan_id=PLAN, passage_id=PASSAGE)
    assert new.status == "new"
    assert new.violations() == ()
    assert not new.is_due(date(2030, 1, 1))


def test_from_row_parses_postgrest_text_values() -> None:
    mastery = PassageMastery.from_row(row())
    assert mastery.plan_id == PLAN and mastery.passage_id == PASSAGE
    assert mastery.initial_success_at == datetime(2026, 9, 30, 8, 15, tzinfo=UTC)
    assert mastery.initial_learning_date == date(2026, 9, 30)
    assert mastery.next_review_due == date(2026, 10, 1)
    assert mastery.error_part_ids == (PART_A,)
    assert mastery.violations() == ()


def test_to_payload_has_exactly_the_documented_keys_and_round_trips() -> None:
    mastery = PassageMastery.from_row(row())
    payload = mastery.to_payload()
    assert set(payload) == MASTERY_PAYLOAD_KEYS
    assert payload["plan_id"] == str(PLAN)
    assert payload["initial_learning_date"] == "2026-09-30"
    assert payload["error_part_ids"] == [str(PART_A)]
    assert payload["confirmed_at"] is None
    assert PassageMastery.from_row(payload) == mastery


def test_is_due_covers_the_ladder_statuses_only_and_keeps_overdue_rounds_due() -> None:
    reviewing = PassageMastery.from_row(row(next_review_due="2026-10-05"))
    assert reviewing.is_due(date(2026, 10, 5))
    assert reviewing.is_due(date(2026, 10, 9))  # overdue stays due, without penalty
    assert not reviewing.is_due(date(2026, 10, 4))
    learning = PassageMastery(plan_id=PLAN, passage_id=PASSAGE, status="learning")
    assert not learning.is_due(date(2030, 1, 1))
    no_date = PassageMastery.from_row(row(next_review_due=None))
    assert not no_date.is_due(date(2030, 1, 1))


@pytest.mark.parametrize(
    ("overrides", "violation"),
    [
        ({"status": "bogus"}, "status_value"),
        ({"consecutive_correct": -1}, "consecutive_correct_range"),
        ({"review_stage": 4}, "review_stage_range"),
        ({"maintenance_stage": -1}, "maintenance_stage_range"),
        ({"lapse_count": -1}, "lapse_count_range"),
        ({"status": "confirmed"}, "confirmed_at_matches_status"),
        (
            {"confirmed_at": "2026-10-01T00:00:00+00:00"},
            "confirmed_at_matches_status",
        ),
        (
            {
                "status": "confirmed",
                "confirmed_at": "2026-10-01T00:00:00+00:00",
                "first_confirmed_at": None,
            },
            "first_confirmed_at_required",
        ),
        ({"status": "needs_refresh"}, "needs_refresh_requires_first_confirmation"),
        ({"status": "reviewing", "review_stage": 0}, "review_stage_for_status"),
        ({"initial_learning_date": None}, "initial_success_pair"),
        (
            {"initial_success_at": None, "initial_learning_date": None},
            "initial_success_required",
        ),
    ],
)
def test_violations_mirror_the_target_mastery_check_constraints(
    overrides: dict[str, object], violation: str
) -> None:
    assert violation in PassageMastery.from_row(row(**overrides)).violations()


def test_a_confirmed_row_with_both_timestamps_is_consistent() -> None:
    confirmed = PassageMastery.from_row(
        row(
            status="confirmed",
            review_stage=3,
            confirmed_at="2026-10-01T00:00:00+00:00",
            first_confirmed_at="2026-10-01T00:00:00+00:00",
        )
    )
    assert confirmed.violations() == ()


def test_part_evidence_round_trips_and_names_the_covering_attempt_in_the_row_only() -> None:
    evidence = PartEvidence.from_row(
        {
            "plan_id": str(PLAN),
            "passage_id": str(PASSAGE),
            "part_id": str(PART_A),
            "attempt_id": str(uid("attempt")),
            "learning_date": "2026-10-01",
        }
    )
    assert evidence.learning_date == date(2026, 10, 1)
    # The attempt of the app_apply_events element is the covering attempt: it is not in the payload.
    assert evidence.to_payload() == {
        "plan_id": str(PLAN),
        "passage_id": str(PASSAGE),
        "part_id": str(PART_A),
        "learning_date": "2026-10-01",
    }


def test_attempt_record_from_row_needs_an_owner_and_keeps_no_answer_text() -> None:
    raw = {
        "id": str(uid("a")),
        "session_id": str(uid("s")),
        "edition_id": str(uid("e")),
        "client_event_id": str(uid("c")),
        "question_id": str(uid("q")),
        "passage_id": str(PASSAGE),
        "correct": False,
        "assisted": True,
        "duration_ms": 1200,
        "occurred_at": "2026-10-01T08:00:00Z",
        "created_at": "2026-10-01T08:00:01+00:00",
        "error_kind": "wrong_choice",
        "wrong_token_ref": "3:1",
        "review_round_id": None,
    }
    owner = uid("user")
    attempt = AttemptRecord.from_row(raw, user_id=owner)
    assert attempt.user_id == owner and attempt.assisted and not attempt.correct
    assert attempt.review_round_id is None
    assert attempt.occurred_at == datetime(2026, 10, 1, 8, tzinfo=UTC)
    assert "text" not in {field for field in AttemptRecord.__slots__}
    with pytest.raises(KeyError):
        AttemptRecord.from_row(raw)  # no user_id in the row and none given


def test_parse_helpers_accept_none_and_typed_values() -> None:
    now = datetime(2026, 10, 1, tzinfo=UTC)
    assert parse_datetime(None) is None and parse_datetime(now) is now
    assert parse_date(None) is None
    assert parse_date(date(2026, 10, 1)) == date(2026, 10, 1)
    assert parse_date("2026-10-01T00:00:00+00:00") == date(2026, 10, 1)
    assert isinstance(uid("x"), UUID)


def test_a_missing_required_value_is_a_value_error_not_an_assertion() -> None:
    now = datetime(2026, 10, 1, tzinfo=UTC)
    assert require_datetime(now) is now and require_datetime("2026-10-01T00:00:00Z") == now
    assert require_date("2026-10-01") == date(2026, 10, 1)
    for call in (
        lambda: require_date(None),
        lambda: require_datetime(None),
        lambda: PartEvidence.from_row(
            {
                "plan_id": str(PLAN),
                "passage_id": str(PASSAGE),
                "part_id": str(PART_A),
                "attempt_id": str(uid("attempt")),
                "learning_date": None,
            }
        ),
        lambda: AttemptRecord.from_row(
            {"id": str(uid("a")), "occurred_at": None, "created_at": None}, user_id=uid("user")
        ),
    ):
        with pytest.raises(ValueError):
            call()
