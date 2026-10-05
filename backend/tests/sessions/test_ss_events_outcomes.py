"""E21 outcomes: duplicates, closed sessions, plan and edition states, the offline envelope,
prepared sessions and placement sessions (API-spec E21, S-4, S-8, S-10, D59). Every scenario runs
over the memory repositories and over the PostgREST adapters."""

from __future__ import annotations

import threading
import uuid
from dataclasses import replace
from functools import cached_property
from typing import Any

import pytest

from app.errors import ErrorCode
from app.services.sessions import _EventBatch
from tests.sessions.ss_events_support import (
    FIRST_PASSAGE,
    MODES,
    Opened,
    World,
    activity_event,
    answer_event,
    envelope_of,
    expected_of,
)
from tests.sessions.ss_support import (
    PLAN_ID,
    QURAN_PASSAGES,
    TODAY,
    USER,
    error_of,
    quran_plan,
)


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    return World(request.param)


def game_plan_id(game: Opened) -> uuid.UUID:
    return uuid.UUID(game.json["planId"])


# --- duplicates (S-8) ----------------------------------------------------------------------------


def test_a_resent_batch_is_reported_as_duplicates_and_has_no_second_effect(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    events = [answer_event(q) for q in game.questions[:2]]
    first = world.post(game, events)
    before = (world.mastery(FIRST_PASSAGE), world.covered(), len(world.attempts(game)))
    second = world.post(game, events)
    assert second["acknowledged"] == [] and second["results"] == []
    assert second["duplicate"] == first["acknowledged"]
    assert (world.mastery(FIRST_PASSAGE), world.covered(), len(world.attempts(game))) == before


def test_a_repeated_id_inside_one_request_is_acknowledged_once(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    event = answer_event(game.questions[0])
    body = world.post(game, [event, event, event])
    assert body["acknowledged"] == [event["clientEventId"]]
    assert body["duplicate"] == [event["clientEventId"]] * 2
    assert len(body["results"]) == 1 and len(world.attempts(game)) == 1


def test_the_first_payload_for_an_id_wins_whatever_the_second_says(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    event_id = uuid.uuid4()
    world.post(game, [answer_event(game.questions[0], event_id=event_id)])
    again = answer_event(game.questions[1], ok=False, hint=True, event_id=event_id)
    body = world.post(game, [again])
    assert body["duplicate"] == [str(event_id)] and body["acknowledged"] == []
    [attempt] = world.attempts(game)
    assert attempt.correct and str(attempt.question_id) == game.questions[0]["questionId"]


def test_an_id_recorded_in_another_session_of_the_account_is_a_duplicate(world: World) -> None:
    first = world.game(FIRST_PASSAGE)
    second = world.game(FIRST_PASSAGE)
    event_id = uuid.uuid4()
    world.post(first, [answer_event(first.questions[0], event_id=event_id)])
    body = world.post(second, [answer_event(second.questions[0], event_id=event_id)])
    assert body["duplicate"] == [str(event_id)]
    assert world.attempts(second) == []


def test_a_replayed_activity_event_adds_no_time(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    event = activity_event(5, 185)
    world.post(game, [event])
    again = world.post(game, [event])
    assert again["duplicate"] == [event["clientEventId"]]
    assert again["daily"]["dailyActiveMs"] == 180_000
    assert len(world.intervals(TODAY)) == 1


def test_an_id_that_another_request_recorded_first_comes_back_as_a_duplicate(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two requests that share an id: the constraint decides, and the loser reports a duplicate."""
    game = world.game(FIRST_PASSAGE)
    event = answer_event(game.questions[0])
    world.post(game, [event])  # the other request
    monkeypatch.setattr(world.learning, "acknowledged_event_ids", lambda ctx, ids: frozenset())
    body = world.post(game, [event])  # this one did not see it when it looked
    assert body["duplicate"] == [event["clientEventId"]]
    assert body["acknowledged"] == [] and body["results"] == []
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None and row.consecutive_correct == 1  # the duplicate changed nothing


def test_every_outcome_keeps_the_request_order(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    ok, dup, bad_shape, no_question = (uuid.uuid4() for _ in range(4))
    q = game.questions
    world.post(game, [answer_event(q[0], event_id=dup)])
    shaped = answer_event(q[1], event_id=bad_shape)
    shaped["answer"] = {"text": "x"} if q[1]["type"] != "word_recall" else {"order": ["1:0"]}
    unknown = answer_event(q[2], event_id=no_question)
    unknown["questionId"] = str(uuid.uuid4())
    body = world.post(
        game,
        [
            answer_event(q[3], event_id=ok),
            answer_event(q[0], event_id=dup),
            shaped,
            unknown,
            activity_event(5, 65),
        ],
    )
    assert body["acknowledged"][0] == str(ok) and len(body["acknowledged"]) == 2
    assert body["duplicate"] == [str(dup)]
    assert body["rejected"] == [
        {"clientEventId": str(bad_shape), "code": "invalid_answer_shape"},
        {"clientEventId": str(no_question), "code": "question_not_in_session"},
    ]
    assert [r["clientEventId"] for r in body["results"]] == [str(ok)]


# --- two requests at once (memory mode holds the store lock for a whole request) -----------------


def test_two_requests_at_once_never_lose_a_streak_update_in_memory_mode() -> None:
    world = World("memory")
    game = world.game(FIRST_PASSAGE)
    barrier = threading.Barrier(2)
    real = world.learning.mastery_for_plan

    def meet_in_the_middle(ctx: Any, plan_id: uuid.UUID) -> Any:
        found = real(ctx, plan_id)  # both requests have read the state before either one writes
        try:
            barrier.wait(timeout=0.3)
        except threading.BrokenBarrierError:
            pass  # the other request is waiting for the lock: it cannot arrive
        return found

    world.learning.mastery_for_plan = meet_in_the_middle
    failures: list[BaseException] = []

    def send(question: dict[str, Any]) -> None:
        try:
            world.post(game, [answer_event(question)])
        except BaseException as error:  # noqa: BLE001 - reported below
            failures.append(error)

    threads = [threading.Thread(target=send, args=(q,)) for q in game.questions[:2]]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failures == []
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None and row.consecutive_correct == 2
    assert len(world.attempts(game)) == 2


def test_a_batch_has_no_class_wide_lock() -> None:
    """``functools.cached_property`` holds one lock per property for all instances in Python 3.11,
    so two requests would wait for each other's database calls inside ``_EventBatch``."""
    assert not any(isinstance(v, cached_property) for v in vars(_EventBatch).values())


# --- ownership and a closed session --------------------------------------------------------------


def test_an_unknown_session_is_not_found(world: World) -> None:
    error = error_of(lambda: world.post(uuid.uuid4(), [activity_event(0, 1)]))
    assert error.code is ErrorCode.not_found


def test_another_accounts_session_is_not_found_like_an_unknown_one(world: World) -> None:
    foreign = uuid.uuid4()
    world.seed_foreign_session(foreign)
    error = error_of(lambda: world.post(foreign, [activity_event(0, 1)]))
    assert error.code is ErrorCode.not_found


def test_the_session_is_checked_before_the_body(world: World) -> None:
    error = error_of(lambda: world.service.record_events(world.ctx, uuid.uuid4(), {"events": []}))
    assert error.code is ErrorCode.not_found  # not validation_error


def test_events_for_a_completed_session_are_rejected_but_duplicates_stay_duplicates(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    old = answer_event(game.questions[0])
    world.post(game, [old])
    world.complete(game)
    fresh = answer_event(game.questions[1])
    body = world.post(game, [old, fresh, activity_event(5, 65)])
    assert body["duplicate"] == [old["clientEventId"]]
    assert [r["code"] for r in body["rejected"]] == ["session_closed", "session_closed"]
    assert len(world.attempts(game)) == 1


# --- the plan (S-4) ------------------------------------------------------------------------------


def test_events_of_a_paused_plan_are_rejected(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.plans.update(game_plan_id(game), status="paused")
    body = world.post(game, [answer_event(game.questions[0]), activity_event(5, 65)])
    assert [r["code"] for r in body["rejected"]] == ["plan_not_active", "plan_not_active"]
    assert world.attempts(game) == [] and world.intervals(TODAY) == []


def test_events_of_a_completed_plan_are_accepted_for_its_maintenance_sessions(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.plans.update(game_plan_id(game), status="completed")
    body = world.post(game, [answer_event(game.questions[0])])
    assert len(body["acknowledged"]) == 1 and body["rejected"] == []


def test_a_demo_account_is_treated_like_a_learner(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.ctx = replace(world.ctx, is_demo=True)
    body = world.post(game, [answer_event(game.questions[0])])
    assert len(body["acknowledged"]) == 1


# --- the edition ---------------------------------------------------------------------------------


def test_events_for_a_revoked_edition_are_rejected_and_credit_nothing(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.revoke_edition()
    body = world.post(game, [answer_event(game.questions[0]), activity_event(5, 65)])
    assert [r["code"] for r in body["rejected"]] == ["edition_mismatch", "edition_mismatch"]
    assert world.attempts(game) == []


# --- prepared sessions and the offline envelope (S-10, D59) --------------------------------------


def prepared(world: World) -> Opened:
    game = world.game(FIRST_PASSAGE)
    world.make_offline(game)
    return game


def test_a_prepared_session_opens_on_its_first_accepted_event(world: World) -> None:
    game = prepared(world)
    assert world.session_row(game).status == "prepared"  # type: ignore[union-attr]
    envelope = envelope_of(game)
    world.post(game, [answer_event(game.questions[0], **envelope)])
    assert world.session_row(game).status == "open"  # type: ignore[union-attr]


def test_an_event_without_an_envelope_is_rejected_for_a_prepared_session(world: World) -> None:
    """API-spec E21 step 4: an online event needs an open session; a replay opens it."""
    game = prepared(world)
    body = world.post(game, [answer_event(game.questions[0]), activity_event(5, 65)])
    assert [r["code"] for r in body["rejected"]] == ["envelope_mismatch"] * 2
    assert world.attempts(game) == [] and world.intervals(TODAY) == []
    assert world.session_row(game).status == "prepared"  # type: ignore[union-attr]
    world.post(game, [answer_event(game.questions[1], **envelope_of(game))])  # the replay opens it
    assert world.session_row(game).status == "open"  # type: ignore[union-attr]
    online = world.post(game, [answer_event(game.questions[2])])
    assert len(online["acknowledged"]) == 1 and online["rejected"] == []


def test_a_prepared_session_stays_prepared_when_no_event_is_accepted(world: World) -> None:
    game = prepared(world)
    bad = answer_event(game.questions[0], **envelope_of(game, protocolVersion=2))
    body = world.post(game, [bad])
    assert [r["code"] for r in body["rejected"]] == ["envelope_mismatch"]
    assert world.session_row(game).status == "prepared"  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "override",
    [
        {"protocolVersion": 2},
        {"snapshotId": str(uuid.uuid4())},
        {"editionId": str(uuid.uuid4())},
        {"bankVersion": 9},
        {"planVersion": 9},
    ],
    ids=["protocol", "snapshot", "edition", "bank version", "plan version"],
)
def test_an_envelope_that_differs_from_the_pinned_values_is_rejected(
    world: World, override: dict[str, Any]
) -> None:
    game = prepared(world)
    envelope = envelope_of(game, **override)
    body = world.post(
        game,
        [answer_event(game.questions[0], **envelope), activity_event(5, 65, **envelope)],
    )
    assert [r["code"] for r in body["rejected"]] == ["envelope_mismatch"] * 2
    assert world.attempts(game) == []


def test_an_envelope_on_a_session_that_was_not_prepared_offline_is_rejected(world: World) -> None:
    game = world.game(FIRST_PASSAGE)  # created online: no offline snapshot
    envelope = envelope_of(game)
    body = world.post(game, [answer_event(game.questions[0], **envelope)])
    assert [r["code"] for r in body["rejected"]] == ["envelope_mismatch"]


def test_a_replay_whose_plan_moved_to_another_version_stays_pending(world: World) -> None:
    game = prepared(world)
    world.plans.update(game_plan_id(game), current_version=3)
    envelope = envelope_of(game)
    event = answer_event(game.questions[0], **envelope)
    body = world.post(game, [event, activity_event(5, 65, **envelope)])
    assert body["acknowledged"] == []
    assert [p["reasonCode"] for p in body["pending"]] == ["plan_changed_unverifiable"] * 2
    assert world.attempts(game) == []
    assert world.session_row(game).status == "prepared"  # type: ignore[union-attr]


def test_a_pending_event_may_be_sent_again_and_is_not_a_duplicate(world: World) -> None:
    game = prepared(world)
    world.plans.update(game_plan_id(game), current_version=3)
    event = answer_event(game.questions[0], **envelope_of(game))
    assert world.post(game, [event])["pending"]
    assert world.post(game, [event])["pending"]  # kept without credit, resent unchanged


@pytest.mark.parametrize(
    "override",
    [{"scoringPolicyVersion": "v2"}, {"normalizationPolicyVersion": "arabic-norm-v2"}],
    ids=["scoring", "normalization"],
)
def test_an_unsupported_policy_version_makes_grading_unavailable(
    world: World, override: dict[str, Any]
) -> None:
    game = prepared(world)
    event = answer_event(game.questions[0], **envelope_of(game, **override))
    body = world.post(game, [event])
    assert [p["reasonCode"] for p in body["pending"]] == ["policy_unsupported"]
    assert world.attempts(game) == [] and world.mastery(FIRST_PASSAGE) is None


def test_a_replay_is_validated_in_its_original_plan_even_when_that_plan_is_paused(
    world: World,
) -> None:
    game = prepared(world)
    world.plans.update(game_plan_id(game), status="paused")
    body = world.post(game, [answer_event(game.questions[0], **envelope_of(game))])
    assert len(body["acknowledged"]) == 1 and body["rejected"] == []
    row = world.mastery(FIRST_PASSAGE, game_plan_id(game))
    assert row is not None and row.plan_id == game_plan_id(game)  # never moved to another plan


def test_a_partial_envelope_fails_the_whole_request(world: World) -> None:
    game = prepared(world)
    event = answer_event(game.questions[0], clientRunId=str(uuid.uuid4()))
    error = error_of(lambda: world.post(game, [event]))
    assert error.code is ErrorCode.validation_error
    assert error.details["fields"][0]["rule"] == "envelope_incomplete"


# --- placement sessions --------------------------------------------------------------------------


def test_a_placement_attempt_is_recorded_for_the_estimate_and_gives_no_mastery(
    world: World,
) -> None:
    placement = world.open("placement")
    events = [answer_event(q) for q in placement.questions]
    body = world.post(placement, events)
    assert len(body["acknowledged"]) == len(placement.questions)
    for result, question in zip(body["results"], placement.questions, strict=True):
        assert result["correct"] is True and result["expected"] == expected_of(question)
        assert result["passage"] == {
            "passageId": question["passageId"],
            "status": "new",
            "coveredParts": 0,
            "totalParts": 0,
            "consecutiveCorrect": 0,
        }
    assert len(world.attempts(placement)) == len(placement.questions)
    assert all(world.mastery(p) is None for p in QURAN_PASSAGES)
    assert world.covered() == frozenset()
    assert world.known_by_placement_reader(placement) == set(QURAN_PASSAGES)  # E15 and E16 read it


def test_a_wrong_or_hinted_placement_answer_is_recorded_and_never_known(world: World) -> None:
    placement = world.open("placement")
    first, second = placement.questions[:2]
    world.post(placement, [answer_event(first, ok=False), answer_event(second, hint=True)])
    recorded = {str(a.question_id): (a.correct, a.assisted) for a in world.attempts(placement)}
    assert recorded == {first["questionId"]: (False, False), second["questionId"]: (True, True)}
    assert world.known_by_placement_reader(placement) == frozenset()  # neither one is known


def test_placement_activity_is_acknowledged_but_never_counted(world: World) -> None:
    placement = world.open("placement")
    event = activity_event(5, 185)
    body = world.post(placement, [event])
    assert body["acknowledged"] == [event["clientEventId"]]
    assert body["daily"]["dailyActiveMs"] == 0
    assert world.intervals(TODAY) == [] and world.daily_row(TODAY) is None


def test_placement_activity_is_checked_against_the_bounds_before_it_is_ignored(
    world: World,
) -> None:
    placement = world.open("placement")
    valid, late = activity_event(5, 65), activity_event(5, 661)  # ends past the skew limit
    body = world.post(placement, [valid, late])
    assert body["acknowledged"] == [valid["clientEventId"]]
    assert body["rejected"] == [
        {"clientEventId": late["clientEventId"], "code": "activity_out_of_bounds"}
    ]


def test_a_placement_recall_answer_shows_the_target_word(world: World) -> None:
    placement = world.open("placement")
    recall = next(q for q in placement.questions if q["type"] == "word_recall")
    [result] = world.post(placement, [answer_event(recall, ok=False)])["results"]
    assert result["expected"] == expected_of(recall)


def test_a_session_of_another_plan_keeps_its_own_state(world: World) -> None:
    """The passage state is per plan: a second plan of the account starts from nothing."""
    other = world.plans.add(
        quran_plan(plan_id=uuid.UUID("44444444-4444-4444-8444-0000000000b2")), owner=USER
    )
    game = world.game(FIRST_PASSAGE, plan_id=other.plan_id)
    world.post(game, [answer_event(game.questions[0])])
    assert world.mastery(FIRST_PASSAGE, other.plan_id) is not None
    assert world.mastery(FIRST_PASSAGE, PLAN_ID) is None
