"""E21 answer events: grading, the effect on the passage (contract §4.1, §4.2) and answer shapes.
Every scenario runs over the memory repositories and over the PostgREST adapters."""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

from app.domain.learning_state import STREAK_TARGET
from tests.sessions.ss_events_support import (
    FIRST_PASSAGE,
    MODES,
    SECOND_PASSAGE,
    World,
    answer_event,
    expected_of,
    parts_covered_by,
    target_word,
)
from tests.sessions.ss_support import QURAN_PASSAGES, TODAY


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    return World(request.param)


# --- a correct answer ----------------------------------------------------------------------------


def test_a_correct_answer_is_graded_recorded_and_credited_to_its_passage(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    question = game.questions[0]
    event = answer_event(question)
    body = world.post(game, [event])
    assert body["acknowledged"] == [event["clientEventId"]]
    assert body["duplicate"] == body["pending"] == body["rejected"] == []
    [result] = body["results"]
    assert result["clientEventId"] == event["clientEventId"]
    assert result["questionId"] == question["questionId"]
    assert (result["correct"], result["assisted"]) == (True, False)
    assert result["expected"] == expected_of(question)
    covered = parts_covered_by(question)
    assert result["passage"] == {
        "passageId": str(FIRST_PASSAGE),
        "status": "learning",
        "coveredParts": len(covered),
        "totalParts": 4,
        "consecutiveCorrect": 1,
    }
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None and row.status == "learning" and row.consecutive_correct == 1
    assert world.covered() == set(covered)
    [attempt] = world.attempts(game)
    assert (attempt.correct, attempt.assisted, attempt.error_kind) == (True, False, "none")
    assert attempt.review_round_id is None and attempt.wrong_token_ref is None
    assert (
        attempt.passage_id == FIRST_PASSAGE and str(attempt.question_id) == question["questionId"]
    )
    assert attempt.duration_ms == 3000


def test_the_response_carries_the_daily_progress_of_today(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    daily = world.post(game, [answer_event(game.questions[0])])["daily"]
    assert daily == {
        "learningDate": "2026-10-05",
        "dailyActiveMs": 0,
        "dailyGoalMs": 600_000,
        "dailyPercent": 0,
        "dailyCompleted": False,
        "extraActiveMs": 0,
    }


# --- a wrong answer ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("game_type", "kind"),
    [
        ("word_order", "wrong_order"),
        ("word_choice", "wrong_choice"),
        ("word_recall", "wrong_recall"),
        ("similar_distinction", "similar_confusion"),
    ],
)
def test_a_wrong_answer_marks_the_error_parts_and_records_the_error_kind(
    world: World, game_type: str, kind: str
) -> None:
    game = world.game(SECOND_PASSAGE, gameType=game_type)
    question = game.questions[0]
    event = answer_event(question, ok=False)
    [result] = world.post(game, [event])["results"]
    assert result["correct"] is False
    assert result["expected"] == expected_of(question)  # the original, so the UI can show it
    assert result["passage"]["status"] == "learning"
    assert result["passage"]["consecutiveCorrect"] == 0
    assert result["passage"]["coveredParts"] == 0
    row = world.mastery(SECOND_PASSAGE)
    assert row is not None and set(row.error_part_ids) == set(parts_covered_by(question))
    assert world.covered() == frozenset()
    [attempt] = world.attempts(game)
    assert (attempt.correct, attempt.error_kind) == (False, kind)
    if game_type in ("word_choice", "similar_distinction"):
        picked = event["answer"]["optionId"]
        assert attempt.wrong_token_ref == picked.split(",")[0]  # a reference, never text
    else:
        assert attempt.wrong_token_ref is None


@pytest.mark.parametrize("game_type", ["word_order", "word_choice", "word_recall"])
def test_every_game_type_is_graded_both_ways(world: World, game_type: str) -> None:
    game = world.game(SECOND_PASSAGE, gameType=game_type)
    right, wrong = game.questions[0], game.questions[1]
    body = world.post(game, [answer_event(right), answer_event(wrong, ok=False)])
    assert [r["correct"] for r in body["results"]] == [True, False]
    assert [r["expected"] for r in body["results"]] == [expected_of(right), expected_of(wrong)]


def test_a_recall_answer_shows_the_verbatim_target_word_and_the_text_is_never_kept(
    world: World, log_lines: list[str]
) -> None:
    game = world.game(FIRST_PASSAGE, gameType="word_recall")
    question = game.questions[0]
    wrong = answer_event(question, ok=False)
    typed_wrong = wrong["answer"]["text"]
    [result] = world.post(game, [wrong])["results"]
    assert result["expected"] == {"word": target_word(question)}
    right = answer_event(game.questions[1])
    typed_right = right["answer"]["text"]
    world.post(game, [right])
    stored = repr([vars(a) if hasattr(a, "__dict__") else a for a in world.attempts(game)])
    assert typed_wrong not in stored
    assert all(typed_wrong not in line and typed_right not in line for line in log_lines)
    if world.fake is not None:
        sent = json.dumps(world.fake.apply_bodies)
        assert typed_wrong not in sent and typed_right not in sent


# --- hints ---------------------------------------------------------------------------------------


def test_a_hinted_answer_is_assisted_and_changes_neither_streak_nor_evidence(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    [result] = world.post(game, [answer_event(game.questions[0], hint=True)])["results"]
    assert (result["correct"], result["assisted"]) == (True, True)
    assert result["passage"]["consecutiveCorrect"] == 0 and result["passage"]["coveredParts"] == 0
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None and row.status == "learning" and row.consecutive_correct == 0
    assert world.covered() == frozenset()
    assert [a.assisted for a in world.attempts(game)] == [True]


def test_a_hinted_wrong_answer_neither_resets_the_streak_nor_marks_error_parts(
    world: World,
) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(game.questions[0]), answer_event(game.questions[1])])
    [result] = world.post(game, [answer_event(game.questions[2], ok=False, hint=True)])["results"]
    assert result["passage"]["consecutiveCorrect"] == 2
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None and row.error_part_ids == ()


# --- the streak and the initial evidence ---------------------------------------------------------


def test_three_consecutive_correct_answers_give_the_initial_evidence(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    events = [answer_event(q) for q in game.questions[:STREAK_TARGET]]
    body = world.post(game, events)
    assert [r["passage"]["status"] for r in body["results"]] == [
        "learning",
        "learning",
        "reviewing",
    ]
    assert [r["passage"]["consecutiveCorrect"] for r in body["results"]] == [1, 2, 3]
    row = world.mastery(FIRST_PASSAGE)
    assert row is not None
    assert (row.status, row.review_stage, row.consecutive_correct) == ("reviewing", 1, 3)
    assert row.initial_learning_date == TODAY
    assert row.next_review_due == TODAY.replace(day=TODAY.day + 1)
    assert row.initial_success_at == world.clock.now  # the server's own clock stamps it


def test_the_streak_continues_across_requests_and_sessions(world: World) -> None:
    first = world.game(FIRST_PASSAGE)
    world.post(first, [answer_event(q) for q in first.questions[:2]])
    second = world.game(FIRST_PASSAGE)
    [result] = world.post(second, [answer_event(second.questions[0])])["results"]
    assert result["passage"]["status"] == "reviewing"


def test_a_wrong_answer_breaks_the_streak_so_three_more_are_needed(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    qs = game.questions
    events = [
        answer_event(qs[0]),
        answer_event(qs[1]),
        answer_event(qs[2], ok=False),
        answer_event(qs[3]),
        answer_event(qs[4]),
    ]
    statuses = [r["passage"]["status"] for r in world.post(game, events)["results"]]
    assert statuses == ["learning"] * 5
    [last] = world.post(game, [answer_event(qs[5])])["results"]
    assert last["passage"]["status"] == "reviewing"


def test_the_initial_evidence_is_recorded_once(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(q) for q in game.questions[:3]])
    first = world.mastery(FIRST_PASSAGE)
    world.clock.advance(minutes=5)
    world.post(game, [answer_event(q) for q in game.questions[3:6]])
    later = world.mastery(FIRST_PASSAGE)
    assert first is not None and later is not None
    assert later.initial_success_at == first.initial_success_at
    assert later.next_review_due == first.next_review_due


def test_later_events_of_a_request_see_the_effect_of_earlier_ones(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    events = [answer_event(game.questions[0]), answer_event(game.questions[1], ok=False)]
    results = world.post(game, events)["results"]
    assert results[0]["passage"]["consecutiveCorrect"] == 1
    assert results[1]["passage"]["consecutiveCorrect"] == 0


# --- evidence ------------------------------------------------------------------------------------


def test_a_part_gains_evidence_once_however_often_it_is_answered(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    body = world.post(game, [answer_event(q) for q in game.questions])
    union = {part for q in game.questions for part in parts_covered_by(q)}
    assert world.covered() == union
    assert body["results"][-1]["passage"]["coveredParts"] == len(union)
    if world.fake is not None:
        rows = world.fake.tables["target_part_evidence"]
        assert len(rows) == len({r["part_id"] for r in rows}) == len(union)


def test_evidence_belongs_to_the_plan_and_the_session_date(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(game.questions[0])])
    if world.store is not None:
        [row] = list(world.store.evidence.values())
        assert row.plan_id.hex and row.learning_date == TODAY
    else:
        assert world.fake is not None
        [row] = world.fake.tables["target_part_evidence"]
        assert row["learning_date"] == TODAY.isoformat()


# --- answer shapes (S-5) -------------------------------------------------------------------------


def shaped(question: dict[str, Any], answer: dict[str, Any]) -> dict[str, Any]:
    event = answer_event(question)
    event["answer"] = answer
    return event


def test_an_answer_of_the_wrong_shape_is_rejected_and_recorded_nowhere(world: World) -> None:
    game = world.game(SECOND_PASSAGE)
    choice = game.of(type="word_choice")[0]
    order = game.of(type="word_order")[0]
    recall = game.of(type="word_recall")[0]
    bad = [
        shaped(choice, {"text": "x"}),
        shaped(choice, {"optionId": "99:99"}),
        shaped(order, {"order": order["answerKey"]["order"][:-1]}),
        shaped(order, {"order": [*order["answerKey"]["order"][:-1], "9:9"]}),
        shaped(order, {"optionId": "1:0"}),
        shaped(recall, {"text": "two words"}),
        shaped(recall, {"text": "   "}),
        shaped(recall, {"order": ["1:0"]}),
    ]
    body = world.post(game, bad)
    assert body["acknowledged"] == []
    assert [r["code"] for r in body["rejected"]] == ["invalid_answer_shape"] * len(bad)
    assert [r["clientEventId"] for r in body["rejected"]] == [e["clientEventId"] for e in bad]
    assert world.attempts(game) == []
    assert world.mastery(SECOND_PASSAGE) is None


def test_a_rejected_id_may_be_sent_again_with_a_valid_answer(world: World) -> None:
    game = world.game(SECOND_PASSAGE)
    choice = game.of(type="word_choice")[0]
    event_id = uuid.uuid4()
    bad = shaped(choice, {"text": "x"})
    bad["clientEventId"] = str(event_id)
    assert world.post(game, [bad])["rejected"]
    good = answer_event(choice, event_id=event_id)
    assert world.post(game, [good])["acknowledged"] == [str(event_id)]


def test_a_question_that_is_not_a_step_of_the_session_is_rejected(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    other = world.game(SECOND_PASSAGE)
    stranger = other.questions[0]
    unknown = {**game.questions[0], "questionId": str(uuid.uuid4())}
    body = world.post(game, [answer_event(stranger), answer_event(unknown)])
    assert [r["code"] for r in body["rejected"]] == ["question_not_in_session"] * 2
    assert world.attempts(game) == [] and world.attempts(other) == []


def test_a_question_outside_the_plan_scope_is_rejected(world: World) -> None:
    game = world.game(FIRST_PASSAGE)  # section 1
    world.plans.update(game_plan_id(game), section_ordinals=(2, 3))
    body = world.post(game, [answer_event(game.questions[0])])
    assert [r["code"] for r in body["rejected"]] == ["out_of_scope"]
    assert world.attempts(game) == []


def game_plan_id(game):
    return uuid.UUID(game.json["planId"])


def test_content_the_pinned_bank_cannot_verify_stays_pending_without_credit(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.drop_question(game.questions[0])
    body = world.post(game, [answer_event(game.questions[0]), answer_event(game.questions[1])])
    assert [p["reasonCode"] for p in body["pending"]] == ["content_unverifiable"]
    assert len(body["acknowledged"]) == 1  # the other question is fine
    assert len(world.attempts(game)) == 1


def test_a_scope_with_no_readable_passages_leaves_the_events_pending(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.plans.update(game_plan_id(game), section_ordinals=(77,))
    body = world.post(game, [answer_event(game.questions[0])])
    assert [p["reasonCode"] for p in body["pending"]] == ["content_unverifiable"]
    assert world.attempts(game) == []


# --- the second passage and the other passages stay apart ----------------------------------------


def test_each_passage_has_its_own_state(world: World) -> None:
    first = world.game(FIRST_PASSAGE)
    second = world.game(SECOND_PASSAGE)
    world.post(first, [answer_event(first.questions[0])])
    world.post(second, [answer_event(second.questions[0], ok=False)])
    one, two = world.mastery(FIRST_PASSAGE), world.mastery(SECOND_PASSAGE)
    assert one is not None and two is not None
    assert (one.consecutive_correct, two.consecutive_correct) == (1, 0)
    assert one.error_part_ids == () and two.error_part_ids != ()
    assert world.mastery(QURAN_PASSAGES[2]) is None
