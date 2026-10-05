"""E20 through ``SessionService`` over the synthetic bundles (memory repositories)."""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any
from uuid import UUID

import pytest

from app.contracts_sessions import refs_for_option_id
from app.domain.answer_policy import ValidatedAttempt, evaluate_answer, key_from_question
from app.domain.learning_state import DailyProgressRow, PartEvidence, PassageMastery
from app.errors import AppError, ErrorCode
from tests.sessions.ss_support import (
    HADITH,
    HADITH_EDITION,
    NOW,
    OTHER_USER,
    PLAN_B_ID,
    PLAN_ID,
    PLAN_VERSION_ID,
    QURAN,
    QURAN_EDITION,
    QURAN_PASSAGES,
    TODAY,
    USER,
    Env,
    ctx,
    error_of,
    field_rules,
    hadith_plan,
    learn_json,
    questions_json,
    quran_plan,
    steps_json,
)

QURAN_UNITS = {u["ordinal"]: u for u in QURAN["units"]}
HADITH_UNITS = {u["ordinal"]: u for u in HADITH["units"]}
QURAN_QUESTIONS = {q["id"]: q for q in QURAN["questions"]}
HADITH_QUESTIONS = {q["id"]: q for q in HADITH["questions"]}


def surface(bundle: dict[str, Any], ref: str) -> str:
    unit_ordinal, index = (int(part) for part in ref.split(":"))
    unit = next(u for u in bundle["units"] if u["ordinal"] == unit_ordinal)
    token = unit["tokens"][index]
    return unit["canonicalText"][token["s"] : token["e"]]


def kinds(snapshot) -> list[str]:
    """``learn`` or the role of each step."""
    return [
        "learn" if step["type"] == "learn" else step["question"]["role"]
        for step in steps_json(snapshot)
    ]


def mastery_row(
    passage_id: UUID,
    status: str = "reviewing",
    *,
    due: date | None = None,
    errors: tuple[UUID, ...] = (),
    initial: date = date(2026, 9, 1),
    plan_id: UUID = PLAN_ID,
    **fields: Any,
) -> PassageMastery:
    values: dict[str, Any] = {
        "plan_id": plan_id,
        "passage_id": passage_id,
        "status": status,
        "next_review_due": due,
        "error_part_ids": errors,
    }
    if status in ("reviewing", "confirmed", "needs_refresh"):
        values.update(
            initial_success_at=NOW.replace(year=initial.year, month=initial.month, day=initial.day),
            initial_learning_date=initial,
            review_stage=1,
        )
    if status == "confirmed":
        values.update(confirmed_at=NOW, first_confirmed_at=NOW, review_stage=3)
    values.update(fields)
    return PassageMastery(**values)


def part_ids(bundle: dict[str, Any], passage_index: int) -> list[UUID]:
    return [UUID(part["id"]) for part in bundle["passages"][passage_index]["parts"]]


# --- daily: the shape of a first session ----------------------------------------------------------


def test_the_first_daily_session_is_learn_then_training_then_the_end_test() -> None:
    env = Env()
    snapshot, created = env.daily()
    assert created is True
    assert snapshot.kind == "daily" and snapshot.status == "open"
    assert snapshot.plan_id == PLAN_ID and snapshot.plan_version == 2
    assert snapshot.edition_id == QURAN_EDITION and snapshot.bank_version == 1
    assert snapshot.learning_date == TODAY and snapshot.created_at == NOW
    # 10 minutes: capacity 25 words takes the 12-word first passage (the next one would make 35);
    # D90: two training batches (word choice, then word order) over its four parts, then the end
    # test of five questions.
    assert kinds(snapshot) == ["learn"] + ["training"] * 8 + ["test"] * 5


@pytest.mark.parametrize(
    ("minutes", "passages_learned", "drills", "test_questions"),
    # D90: 2/2/3 training batches over every part. 15 minutes: the second passage has six parts but
    # a merged question can cover two of them and serve both, so a batch may be one question
    # shorter.
    [(5, 1, (8, 8), 3), (10, 1, (8, 8), 5), (15, 2, (26, 28), 7)],
)
def test_capacity_and_end_test_follow_the_session_minutes(
    minutes: int, passages_learned: int, drills: tuple[int, int], test_questions: int
) -> None:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=minutes)
    snapshot, _ = env.daily()
    roles = kinds(snapshot)
    assert roles.count("learn") == passages_learned
    assert drills[0] <= roles.count("training") <= drills[1]
    assert roles.count("test") == test_questions
    assert roles.count("review") == 0


def test_the_learn_step_shows_the_whole_passage_verbatim_with_its_citation() -> None:
    env = Env()
    snapshot, _ = env.daily()
    (view,) = learn_json(snapshot)
    first = QURAN["passages"][0]
    assert view["passageId"] == first["id"] and view["path"] == "quran"
    assert view["reference"] == first["reference"]
    assert view["sectionTitleAr"] == QURAN["sections"][0]["titleAr"]
    assert [u["unitRef"] for u in view["units"]] == [1, 2, 3, 4]
    for unit in view["units"]:
        assert unit["text"] == QURAN_UNITS[unit["unitRef"]]["canonicalText"]  # exactly as stored
        assert (
            unit["kind"] == "ayah"
            and unit["reference"] == QURAN_UNITS[unit["unitRef"]]["reference"]
        )
    assert view["highlight"] == {"startRef": first["startRef"], "endRef": first["endRef"]}
    assert view["takhrij"] is None and view["grade"] is None and view["showD50Notice"] is False
    source = view["source"]
    assert source["url"] == QURAN_UNITS[1]["sourceUrl"] == "https://islamenc.com/ar/quran/112"
    assert source["editionLabel"] == QURAN["edition"]["editionLabel"]
    assert source["bookTitleAr"] == QURAN["book"]["titleAr"]
    assert source["publisher"] == QURAN["source"]["title"] and source["pages"] == []
    assert source["reference"] == first["reference"]


def test_every_question_carries_an_answer_key_that_grades_the_correct_answer_correct() -> None:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=15)
    snapshot, _ = env.daily()
    graded = {"word_order": 0, "word_choice": 0, "word_recall": 0, "similar_distinction": 0}
    for question in questions_json(snapshot):
        key = key_from_question(question)  # the stored question is internally consistent
        kind = question["type"]
        if kind == "word_order":
            answer: dict[str, Any] = {"order": question["answerKey"]["order"]}
        elif kind == "word_recall":
            target = QURAN_QUESTIONS[question["questionId"]]["tokenRefs"][0]
            answer = {"text": surface(QURAN, target)}  # the word as the source writes it
        else:
            answer = {"optionId": question["answerKey"]["optionId"]}
        result = evaluate_answer(
            key, answer, hint_used=False, normalization_policy="arabic-norm-v1", scoring_policy="v1"
        )
        assert isinstance(result, ValidatedAttempt) and result.correct, question["questionId"]
        graded[kind] += 1
    assert graded["word_order"] and graded["word_choice"] and graded["word_recall"]


def test_question_text_comes_from_the_units_and_the_context_surrounds_the_blank() -> None:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=15)
    snapshot, _ = env.daily()
    seen = set()
    for question in questions_json(snapshot):
        bank = QURAN_QUESTIONS[question["questionId"]]
        seen.add(question["type"])
        assert question["passageId"] == bank["passageId"]
        assert question["policy"] == {
            "normalizationPolicyVersion": "arabic-norm-v1",
            "scoringPolicyVersion": "v1",
        }
        assert question["source"]["reference"] == bank["reference"]
        first_unit = int(bank["tokenRefs"][0].split(":")[0])
        assert question["source"]["url"] == QURAN_UNITS[first_unit]["sourceUrl"]
        context = question["context"]
        target = [tuple(map(int, r.split(":"))) for r in bank["tokenRefs"]]
        before = [tuple(map(int, t["ref"].split(":"))) for t in context["before"]]
        after = [tuple(map(int, t["ref"].split(":"))) for t in context["after"]]
        assert all(ref < min(target) for ref in before) and all(ref > max(target) for ref in after)
        # D90: the stored window of six words is inside the whole passage that is shown
        assert set(bank["contextRefs"]) <= {t["ref"] for t in context["before"] + context["after"]}
        for token in context["before"] + context["after"]:
            assert token["text"] == surface(QURAN, token["ref"])
        if question["type"] == "word_order":
            # D90: the passage with the part's place as the gap (see test_ss_whole_passage.py)
            assert context["before"] or context["after"]
            tokens = question["tokens"]
            assert [t["ref"] for t in tokens] != bank["tokenRefs"]  # shuffled, never in order
            assert sorted(t["ref"] for t in tokens) == sorted(bank["tokenRefs"])
            assert question["answerKey"]["order"] == bank["tokenRefs"]
            assert all(t["text"] == surface(QURAN, t["ref"]) for t in tokens)
        elif question["type"] == "word_recall":
            token = QURAN_UNITS[first_unit]["tokens"][int(bank["tokenRefs"][0].split(":")[1])]
            norms = [token["n"]] + ([token["a"]] if token.get("a") else [])
            assert question["answerKey"] == {"acceptedNorms": norms}
            assert question["hintFirstLetter"] == token["n"][0]
        else:
            option_refs = {tuple(o) for o in bank["optionRefs"]}
            decoded = {tuple(refs_for_option_id(o["optionId"])) for o in question["options"]}
            assert decoded == option_refs and len(question["options"]) == len(option_refs)
            assert refs_for_option_id(question["answerKey"]["optionId"]) == bank["correctRef"]
            for option in question["options"]:
                refs = refs_for_option_id(option["optionId"])
                first, last = surface(QURAN, refs[0]), surface(QURAN, refs[-1])
                assert option["text"].startswith(first) and option["text"].endswith(last)
            if question["type"] == "word_choice":
                assert question["variant"] == bank["variant"]
    assert seen >= {"word_order", "word_choice", "word_recall"}


def test_options_are_shuffled_and_the_shuffle_is_the_same_for_the_same_session_inputs() -> None:
    env = Env()
    first, _ = env.daily()
    positions = [
        [o["optionId"] for o in q["options"]].index(q["answerKey"]["optionId"])
        for q in questions_json(first)
        if "options" in q
    ]
    assert len(set(positions)) > 1  # the correct option is not always in the same place
    again = Env()
    second, _ = again.daily()
    assert steps_json(first) == steps_json(second)  # deterministic given the same inputs


def test_session_row_facts_and_question_and_lesson_refs() -> None:
    env = Env()
    snapshot, _ = env.daily()
    row = env.store.sessions[snapshot.session_id]
    assert (row.kind, row.status, row.plan_id) == ("daily", "open", PLAN_ID)
    assert row.plan_version_id == PLAN_VERSION_ID and row.plan_version == 2
    assert row.edition_id == QURAN_EDITION and row.bank_version == 1
    assert (
        row.learning_date == TODAY and row.self_rating is None and row.offline_snapshot_id is None
    )
    assert [str(r) for r in row.question_refs] == [
        q["questionId"] for q in questions_json(snapshot)
    ]
    first_lesson = next(x for x in QURAN["lessons"] if x["passageId"] == QURAN["passages"][0]["id"])
    assert [str(r) for r in row.lesson_refs] == [first_lesson["id"]]
    assert len({str(r) for r in row.question_refs}) == len(row.question_refs)  # a step per question


# --- get-or-create and immutability ---------------------------------------------------------------


def test_a_second_daily_call_returns_the_same_open_session_and_steps() -> None:
    env = Env()
    first, created_first = env.daily()
    second, created_second = env.daily()
    assert (created_first, created_second) == (True, False)
    assert second.session_id == first.session_id
    assert second == first
    assert len(env.store.sessions) == 1


def test_a_returned_snapshot_cannot_change_the_stored_one() -> None:
    env = Env()
    first, _ = env.daily()
    stored_before = json.dumps(env.store.sessions[first.session_id].steps, sort_keys=True)
    first.steps.clear()
    second, _ = env.daily()
    assert (
        second.steps
        and json.dumps(env.store.sessions[first.session_id].steps, sort_keys=True) == stored_before
    )


def test_the_open_session_is_not_recomposed_when_the_learner_state_changes() -> None:
    env = Env()
    first, _ = env.daily()
    env.store.put_mastery(USER, mastery_row(QURAN_PASSAGES[0], "reviewing", due=TODAY))
    env.store.put_daily_progress(DailyProgressRow(USER, TODAY - timedelta(days=9), 600000, 600000))
    again, created = env.daily()
    assert created is False and again == first


def test_a_completed_daily_session_is_followed_by_a_new_one() -> None:
    env = Env()
    first, _ = env.daily()
    env.store.mark_completed(ctx(), first.session_id)
    second, created = env.daily()
    assert created is True and second.session_id != first.session_id


def test_daily_sessions_of_two_users_are_independent() -> None:
    env = Env()
    env.plans.add(quran_plan(plan_id=PLAN_B_ID), owner=OTHER_USER)
    mine, _ = env.daily()
    theirs, created = env.daily(PLAN_B_ID, context=ctx(OTHER_USER))
    assert created is True and theirs.session_id != mine.session_id
    assert env.store.read_session(ctx(OTHER_USER), mine.session_id) is None  # never visible


def test_a_leftover_open_daily_session_of_another_plan_is_retired_first() -> None:
    env = Env()
    other_plan = hadith_plan(plan_id=PLAN_B_ID, paths=("matn",), session_minutes=5)
    env.plans.add(other_plan)
    leftover, _ = env.daily(PLAN_B_ID)
    assert env.store.sessions[leftover.session_id].status == "open"
    current, created = env.daily()
    assert created is True and current.plan_id == PLAN_ID
    assert env.store.sessions[leftover.session_id].status == "completed"


def test_a_revision_of_the_plan_never_changes_an_open_session() -> None:
    env = Env()
    first, _ = env.daily(version=2)
    env.plans.update(PLAN_ID, current_version=3, session_minutes=15)
    again, created = env.daily(version=3)  # the client now holds the new version
    assert created is False
    assert again.plan_version == 2 and again.steps == first.steps  # pinned to the version it began


# --- plan state, versions, ownership --------------------------------------------------------------


def test_an_unknown_or_foreign_plan_is_not_found() -> None:
    env = Env()
    unknown = error_of(lambda: env.daily(UUID("00000000-0000-4000-8000-0000000000ff")))
    assert unknown.code is ErrorCode.not_found
    env.plans.add(quran_plan(plan_id=PLAN_B_ID), owner=OTHER_USER)
    assert error_of(lambda: env.daily(PLAN_B_ID)).code is ErrorCode.not_found  # same answer
    assert error_of(lambda: env.game(PLAN_B_ID)).code is ErrorCode.not_found


def test_a_stale_plan_version_is_a_conflict_that_names_the_current_version() -> None:
    env = Env()
    for call in (lambda: env.daily(version=1), lambda: env.game(version=5)):
        error = error_of(call)
        assert error.code is ErrorCode.version_conflict
        assert error.details == {"reason": "plan_version", "currentVersion": 2}


def test_a_paused_plan_accepts_no_new_session() -> None:
    env = Env()
    env.plans.update(PLAN_ID, status="paused")
    for call in (env.daily, env.game):
        error = error_of(call)
        assert error.code is ErrorCode.version_conflict
        assert error.details == {"reason": "plan_not_active"}


def test_a_paused_plan_is_refused_even_when_the_version_is_stale() -> None:
    env = Env()
    env.plans.update(PLAN_ID, status="paused")
    error = error_of(lambda: env.daily(version=1))
    assert error.details["reason"] == "plan_not_active"


def test_a_completed_plan_serves_daily_maintenance_but_no_game() -> None:
    env = Env()
    env.plans.update(PLAN_ID, status="completed")
    error = error_of(env.game)
    assert error.code is ErrorCode.version_conflict and error.details["reason"] == "plan_not_active"
    snapshot, created = env.daily()
    assert created is True and kinds(snapshot) == []  # nothing due: no new passage, no end test


def test_a_completed_plan_daily_session_holds_only_due_maintenance_reviews() -> None:
    env = Env()
    env.plans.update(PLAN_ID, status="completed")
    for index, passage in enumerate(QURAN_PASSAGES):
        due = TODAY - timedelta(days=index) if index < 2 else TODAY + timedelta(days=30)
        env.store.put_mastery(USER, mastery_row(passage, "confirmed", due=due))
    snapshot, _ = env.daily()
    roles = kinds(snapshot)
    assert set(roles) == {"review"}  # no learn step, no new passages, no end test
    passages = {q["passageId"] for q in questions_json(snapshot)}
    assert passages == {str(QURAN_PASSAGES[0]), str(QURAN_PASSAGES[1])}
    rounds = {q["reviewRoundId"] for q in questions_json(snapshot)}
    assert len(rounds) == 2 and None not in rounds


# --- editions and scope ---------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["revoked"])
def test_a_revoked_edition_is_never_served_not_even_from_a_stored_session(status: str) -> None:
    env = Env()
    first, _ = env.daily()
    env.bank.set_status(QURAN_EDITION, status)
    for call in (env.daily, env.game):
        error = error_of(call)
        assert error.code is ErrorCode.validation_error
        assert field_rules(error) == [("planId", "edition_not_available")]
        assert "steps" not in json.dumps(error.details)
    assert env.store.read_session(ctx(), first.session_id) is not None  # kept, never served


def test_a_superseded_or_hidden_edition_still_serves_the_pinned_plan() -> None:
    env = Env()
    env.bank.set_status(QURAN_EDITION, "superseded")
    snapshot, created = env.daily()
    assert created is True and kinds(snapshot)[0] == "learn"
    env2 = Env()
    env2.bank.set_status(QURAN_EDITION, "published", hidden=True)  # hiding stops new selection only
    assert env2.daily()[1] is True


def test_a_bank_version_that_is_no_longer_readable_is_not_available() -> None:
    env = Env()
    env.plans.update(PLAN_ID, bank_version=7)
    error = error_of(env.daily)
    assert field_rules(error) == [("planId", "edition_not_available")]


def test_the_scope_limits_which_passages_are_introduced() -> None:
    env = Env()
    env.plans.update(PLAN_ID, section_ordinals=(3,), session_minutes=5)
    snapshot, _ = env.daily()
    (view,) = learn_json(snapshot)
    assert view["passageId"] == str(QURAN_PASSAGES[2])  # first passage of section 3, 33 words
    assert {q["passageId"] for q in questions_json(snapshot)} == {str(QURAN_PASSAGES[2])}


def test_reverse_order_starts_from_the_last_section_keeping_mushaf_order_inside() -> None:
    env = Env()
    env.plans.update(PLAN_ID, order="reverse", session_minutes=15)
    snapshot, _ = env.daily()
    learned = [v["passageId"] for v in learn_json(snapshot)]
    assert learned == [str(QURAN_PASSAGES[2])]  # 33 words fill the 40-word day; 32 more do not fit
    env.plans.update(PLAN_ID, order="reverse", session_minutes=5, current_version=3)
    env.store.mark_completed(ctx(), snapshot.session_id)
    book = Env()
    book.plans.update(PLAN_ID, session_minutes=15)
    assert [v["passageId"] for v in learn_json(book.daily()[0])] == [
        str(QURAN_PASSAGES[0]),
        str(QURAN_PASSAGES[1]),
    ]


# --- composition from learner state ---------------------------------------------------------------


def test_new_material_comes_first_then_due_reviews_with_a_round_id_then_the_end_test() -> None:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=10)
    first_passage = QURAN_PASSAGES[0]
    env.store.put_mastery(
        USER,
        mastery_row(first_passage, "reviewing", due=TODAY - timedelta(days=2)),
    )
    snapshot, _ = env.daily()
    roles = kinds(snapshot)
    review = [q for q in questions_json(snapshot) if q["role"] == "review"]
    assert len(review) == 2  # a 4-part passage: a round of two questions
    # D90: the lesson and its training batches, then the due round, then the end test
    assert roles[0] == "learn"
    first_review = roles.index("review")
    assert roles[1:first_review] and set(roles[1:first_review]) == {"training"}
    assert roles[first_review : first_review + 2] == ["review", "review"]
    assert set(roles[first_review + 2 :]) == {"test"}
    assert {q["reviewRoundId"] for q in review} != {None} and len(
        {q["reviewRoundId"] for q in review}
    ) == 1
    assert {q["passageId"] for q in review} == {str(first_passage)}
    learned = [v["passageId"] for v in learn_json(snapshot)]
    assert learned == [str(QURAN_PASSAGES[1])]  # the next passage in plan order, 23 words <= 25


def test_a_round_takes_uncovered_parts_first_then_error_parts() -> None:
    env = Env()
    passage = QURAN_PASSAGES[1]  # six parts: a round of three
    parts = part_ids(QURAN, 1)
    env.store.put_mastery(
        USER, mastery_row(passage, "reviewing", due=TODAY, errors=(parts[1], parts[4]))
    )
    for part in (parts[0], parts[1]):
        env.store.put_evidence(
            USER, PartEvidence(PLAN_ID, passage, part, UUID(int=1), TODAY - timedelta(days=3))
        )
    snapshot, _ = env.daily()
    review = [q for q in questions_json(snapshot) if q["role"] == "review"]
    assert len(review) == 3
    covered = [QURAN_QUESTIONS[q["questionId"]]["coveredPartIds"][0] for q in review]
    assert covered == [str(parts[4]), str(parts[2]), str(parts[3])]  # parts 5, 3, 4


def test_three_days_of_absence_make_a_light_review_without_new_material() -> None:
    env = Env()
    env.store.put_mastery(
        USER, mastery_row(QURAN_PASSAGES[0], "reviewing", due=TODAY - timedelta(days=6))
    )
    env.store.put_daily_progress(DailyProgressRow(USER, TODAY - timedelta(days=4), 600000, 600000))
    snapshot, _ = env.daily()
    assert set(kinds(snapshot)) == {"review"}
    assert not learn_json(snapshot)


def test_two_days_of_absence_are_a_normal_session() -> None:
    env = Env()
    env.store.put_daily_progress(DailyProgressRow(USER, TODAY - timedelta(days=3), 600000, 600000))
    snapshot, _ = env.daily()
    assert kinds(snapshot)[0] == "learn"


def test_a_passage_known_from_placement_gets_a_quick_drill_instead_of_a_learn_step() -> None:
    env = Env()
    env.plans.update(PLAN_ID, known_passage_ids=frozenset({QURAN_PASSAGES[0]}), session_minutes=5)
    snapshot, _ = env.daily()
    steps = steps_json(snapshot)
    first = [q for q in questions_json(snapshot) if q["passageId"] == str(QURAN_PASSAGES[0])]
    assert len(first) >= 2  # a 4-part passage: a drill of two questions, no learn step
    assert all(q["role"] != "review" and q["reviewRoundId"] is None for q in first[:2])
    assert [v["passageId"] for v in learn_json(snapshot)] == [str(QURAN_PASSAGES[1])]
    # D90: the new passage is taught first; the known passage's quick drill comes after it
    assert steps[0]["type"] == "learn"
    drill_at = next(
        i
        for i, step in enumerate(steps)
        if step["type"] == "question" and step["question"]["passageId"] == str(QURAN_PASSAGES[0])
    )
    assert drill_at > 1 and steps[drill_at - 1]["question"]["passageId"] == str(QURAN_PASSAGES[1])


def test_capacity_already_used_today_leaves_no_new_passage_for_a_second_session() -> None:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=5)
    first, _ = env.daily()
    assert [v["passageId"] for v in learn_json(first)] == [str(QURAN_PASSAGES[0])]
    env.store.mark_completed(ctx(), first.session_id)
    env.store.put_mastery(
        USER,
        mastery_row(QURAN_PASSAGES[0], "reviewing", due=TODAY + timedelta(days=1), initial=TODAY),
    )
    second, created = env.daily()
    assert created is True and not learn_json(second)  # the day's 12 words were used
    assert set(kinds(second)) == {"test"}  # more practice on the passage still in progress


# --- game -----------------------------------------------------------------------------------------


def test_a_game_has_up_to_ten_game_questions_and_no_learn_step() -> None:
    env = Env()
    snapshot, created = env.game()
    assert created is True and snapshot.kind == "game" and snapshot.status == "open"
    assert snapshot.plan_id == PLAN_ID and snapshot.plan_version == 2
    roles = kinds(snapshot)
    assert len(roles) == 10 and set(roles) == {"game"}
    assert all(q["reviewRoundId"] is None for q in questions_json(snapshot))
    assert len({q["questionId"] for q in questions_json(snapshot)}) == 10
    assert len({q["passageId"] for q in questions_json(snapshot)}) == 4  # spread over the plan


@pytest.mark.parametrize("kind", ["word_order", "word_choice", "word_recall"])
def test_a_game_can_be_limited_to_one_type(kind: str) -> None:
    env = Env()
    snapshot, _ = env.game(gameType=kind)
    assert {q["type"] for q in questions_json(snapshot)} == {kind}
    assert len(questions_json(snapshot)) == 10


def test_a_similar_distinction_game_is_short_because_the_bank_has_two() -> None:
    env = Env()
    snapshot, _ = env.game(gameType="similar_distinction")
    assert len(questions_json(snapshot)) == 2
    assert {q["type"] for q in questions_json(snapshot)} == {"similar_distinction"}


def test_a_game_over_chosen_passages_uses_only_those_including_future_ones() -> None:
    env = Env()
    chosen = [str(QURAN_PASSAGES[3]), str(QURAN_PASSAGES[1])]  # none of them learned yet
    snapshot, _ = env.game(passageIds=chosen)
    assert {q["passageId"] for q in questions_json(snapshot)} == set(chosen)
    assert len(questions_json(snapshot)) == 10


def test_a_game_passage_outside_scope_edition_or_paths_is_out_of_scope() -> None:
    env = Env()
    env.plans.update(PLAN_ID, section_ordinals=(1, 2))
    inside, outside = str(QURAN_PASSAGES[0]), str(QURAN_PASSAGES[3])  # section 3 is out
    foreign = HADITH["passages"][0]["id"]  # another edition
    error = error_of(
        lambda: env.game(
            passageIds=[inside, outside, foreign, "00000000-0000-4000-8000-000000000000"]
        )
    )
    assert error.code is ErrorCode.validation_error
    assert field_rules(error) == [
        ("passageIds[1]", "out_of_scope"),
        ("passageIds[2]", "out_of_scope"),
        ("passageIds[3]", "out_of_scope"),
    ]
    env.plans.add(hadith_plan(paths=("matn",), session_minutes=5))
    sanad = HADITH["passages"][1]["id"]
    error = error_of(lambda: env.game(PLAN_B_ID, 2, passageIds=[sanad]))
    assert field_rules(error) == [("passageIds[0]", "out_of_scope")]  # not a selected path


def test_every_game_creates_a_new_session() -> None:
    env = Env()
    first, created_first = env.game()
    second, created_second = env.game()
    assert (created_first, created_second) == (True, True)
    assert first.session_id != second.session_id and len(env.store.sessions) == 2


def test_a_game_with_nothing_to_ask_is_an_empty_session() -> None:
    env = Env()
    env.plans.update(PLAN_ID, section_ordinals=(1,))
    snapshot, created = env.game(gameType="similar_distinction")  # section 1 has none
    assert created is True and snapshot.steps == []


# --- placement ------------------------------------------------------------------------------------


def test_a_placement_has_one_choice_or_recall_question_per_sampled_passage() -> None:
    env = Env()
    snapshot, created = env.placement(selfRating="some")
    assert created is True and snapshot.kind == "placement" and snapshot.status == "open"
    assert snapshot.plan_id is None and snapshot.plan_version is None
    assert snapshot.edition_id == QURAN_EDITION and snapshot.bank_version == 1
    questions = questions_json(snapshot)
    assert len(questions) == 4 and not learn_json(snapshot)  # four passages: all fit under eight
    assert {q["passageId"] for q in questions} == {str(p) for p in QURAN_PASSAGES}
    assert {q["role"] for q in questions} == {"placement"}
    assert {q["type"] for q in questions} <= {"word_choice", "word_recall"}
    row = env.store.sessions[snapshot.session_id]
    assert row.self_rating == "some" and row.plan_id is None and row.plan_version_id is None


def test_a_placement_needs_no_plan_and_never_asks_the_plan_port() -> None:
    env = Env()
    env.plans.calls = 0
    env.placement()
    assert env.plans.calls == 0


def test_a_placement_can_be_limited_to_part_of_the_scope() -> None:
    env = Env()
    snapshot, _ = env.placement(scope=(2,))
    assert {q["passageId"] for q in questions_json(snapshot)} == {str(QURAN_PASSAGES[1])}


def test_a_hadith_placement_samples_the_default_paths_only() -> None:
    env = Env()
    snapshot, _ = env.placement(HADITH_EDITION, scope=(1, 2, 3, 4))
    matn = {p["id"] for p in HADITH["passages"] if p["path"] == "matn"}
    asked = {q["passageId"] for q in questions_json(snapshot)}
    assert asked == matn  # the five matn passages (fewer than eight), never sanad or grade
    assert len(questions_json(snapshot)) == 5


@pytest.mark.parametrize("status", ["superseded", "revoked"])
def test_a_placement_needs_a_published_edition(status: str) -> None:
    env = Env()
    env.bank.set_status(QURAN_EDITION, status)
    error = error_of(env.placement)
    assert field_rules(error) == [("editionId", "edition_not_available")]


def test_a_hidden_or_unknown_edition_is_not_available_for_a_placement() -> None:
    env = Env()
    env.bank.set_status(QURAN_EDITION, "published", hidden=True)
    assert field_rules(error_of(env.placement)) == [("editionId", "edition_not_available")]
    unknown = UUID("11111111-1111-4111-8111-0000000000ee")
    assert field_rules(error_of(lambda: env.placement(unknown))) == [
        ("editionId", "edition_not_available")
    ]


def test_a_placement_scope_must_name_existing_sections() -> None:
    env = Env()
    error = error_of(lambda: env.placement(scope=(1, 9)))
    assert field_rules(error) == [("targetScope.sectionOrdinals", "scope_invalid")]


# --- request validation through the service -------------------------------------------------------


def test_the_service_turns_contract_violations_into_validation_errors() -> None:
    env = Env()
    error = error_of(lambda: env.service.parse_request({"kind": "weekly"}))
    assert error.code is ErrorCode.validation_error
    assert field_rules(error) == [("kind", "kind_invalid")]
    error = error_of(
        lambda: env.service.parse_request(
            {"kind": "daily", "planId": str(PLAN_ID), "expectedPlanVersion": 2, "userId": "x"}
        )
    )
    assert field_rules(error) == [("userId", "forbidden_field")]


# --- failures of the stores -----------------------------------------------------------------------


def test_unbound_ports_answer_unavailable_instead_of_guessing() -> None:
    from app.services.sessions import build_sessions_service
    from tests.support import make_settings

    service = build_sessions_service(make_settings(), bank=Env().bank, learning=Env().store)
    request = service.parse_request(
        {"kind": "daily", "planId": str(PLAN_ID), "expectedPlanVersion": 2}
    )
    assert error_of(lambda: service.create_session(ctx(), request)).code is ErrorCode.unavailable
    placement = service.parse_request(
        {
            "kind": "placement",
            "editionId": str(QURAN_EDITION),
            "targetScope": {"sectionOrdinals": [1]},
        }
    )
    assert error_of(lambda: service.create_session(ctx(), placement)).code is ErrorCode.unavailable


def test_a_plan_that_moved_while_the_session_was_committed_is_a_version_conflict() -> None:
    env = Env()
    real_open = env.store.open_session

    def moved(c, new):
        env.plans.update(PLAN_ID, current_version=3)  # a revision lands before the commit
        raise AppError(ErrorCode.version_conflict, details={"reason": "plan_version"})

    env.store.open_session = moved  # type: ignore[method-assign]
    error = error_of(env.daily)
    assert error.code is ErrorCode.version_conflict
    assert error.details == {"reason": "plan_version", "currentVersion": 3}
    env.store.open_session = real_open  # type: ignore[method-assign]
    assert not env.store.sessions  # nothing was stored


def test_losing_the_get_or_create_race_returns_the_winner() -> None:
    env = Env()
    winner, _ = env.daily()
    # A concurrent request composed its own snapshot before the winner committed: the store
    # answers with the winner's id and created = false, and that session is what is returned.
    real_find = env.store.find_open_daily
    env.store.find_open_daily = lambda c, d: None  # type: ignore[method-assign]
    try:
        loser, created = env.daily()
    finally:
        env.store.find_open_daily = real_find  # type: ignore[method-assign]
    assert created is False and loser.session_id == winner.session_id and loser == winner


def test_a_corrupt_bank_is_an_internal_error_not_a_guess() -> None:
    env = Env()
    bundle = json.loads(json.dumps(QURAN))
    bundle["units"][0]["tokens"] = []  # the first ayah loses its tokens
    broken = Env(bundles=(bundle,))
    broken.plans.update(PLAN_ID, session_minutes=5)
    assert error_of(broken.daily).code is ErrorCode.internal
    assert not broken.store.sessions
    assert env.daily()[1] is True


# --- hadith: record, grade passages, D50 notice ---------------------------------------------------


def hadith_view(passages: list[dict[str, Any]], passage_index: int) -> dict[str, Any]:
    wanted = HADITH["passages"][passage_index]["id"]
    return next(view for view in passages if view["passageId"] == wanted)


def test_hadith_learn_steps_follow_the_text_and_show_the_record_as_recorded() -> None:
    env = Env()
    snapshot, _ = env.daily(PLAN_B_ID)  # all three paths, 15 minutes: 40 words
    views = learn_json(snapshot)
    # Inside a hadith the chain comes first, then the Prophet's words, then the grade; 6 + 6 + 1 + 6
    # words fill the day (the next matn has 36).
    assert [(v["path"], v["reference"]) for v in views] == [
        ("sanad", "nawawi40:1"),
        ("matn", "nawawi40:1"),
        ("grade", "nawawi40:1"),
        ("sanad", "nawawi40:2"),
    ]
    sanad, matn, grade, second = views
    for view in (sanad, matn, grade):
        assert view["takhrij"] == HADITH_UNITS[2]["canonicalText"]  # as recorded, never rewritten
        assert view["grade"] == HADITH_UNITS[3]["canonicalText"]
        assert view["showD50Notice"] is False
        assert view["source"]["url"] == HADITH_UNITS[1]["sourceUrl"]
        assert view["source"]["url"].startswith("https://hadeethenc.com/ar/browse/hadith/")
    assert [u["unitRef"] for u in sanad["units"]] == [1] and sanad["units"][0][
        "kind"
    ] == "hadith_narration"
    assert sanad["units"][0]["text"] == HADITH_UNITS[1]["canonicalText"]
    assert matn["highlight"] == {"startRef": "1:6", "endRef": "1:11"}
    assert sanad["highlight"] == {"startRef": "1:0", "endRef": "1:5"}
    # A grade passage lies inside the hadith_grade unit.
    assert [(u["unitRef"], u["kind"]) for u in grade["units"]] == [(3, "hadith_grade")]
    assert grade["highlight"] == {"startRef": "3:0", "endRef": "3:0"}
    assert second["takhrij"] == HADITH_UNITS[5]["canonicalText"]
    assert second["grade"] == HADITH_UNITS[6]["canonicalText"]


def test_a_hadith_without_a_grade_or_sahihayn_citation_shows_the_d50_notice() -> None:
    env = Env()
    env.plans.add(hadith_plan(plan_id=PLAN_B_ID, section_ordinals=(3,), paths=("matn",)))
    snapshot, _ = env.daily(PLAN_B_ID)
    (view,) = learn_json(snapshot)
    assert view["reference"] == "nawawi40:3"
    assert view["grade"] is None  # no grade unit in this edition: the UI says it is not stated
    assert view["takhrij"] == HADITH_UNITS[8]["canonicalText"]
    assert view["showD50Notice"] is True


def test_every_bank_question_of_both_editions_renders_and_grades_its_own_answer_correct() -> None:
    """A sweep over the whole synthetic bank through games over single passages and types."""
    env = Env()
    env.plans.add(hadith_plan(paths=("matn", "sanad", "grade"), section_ordinals=(1, 2, 3, 4)))
    checked: set[str] = set()
    for plan, bundle, questions in (
        (PLAN_ID, QURAN, QURAN_QUESTIONS),
        (PLAN_B_ID, HADITH, HADITH_QUESTIONS),
    ):
        for passage in bundle["passages"]:
            for kind in ("word_order", "word_choice", "word_recall", "similar_distinction"):
                wanted = [
                    q
                    for q in questions.values()
                    if q["passageId"] == passage["id"] and q["type"] == kind
                ]
                snapshot, _ = env.game(plan, 2, passageIds=[passage["id"]], gameType=kind)
                asked = questions_json(snapshot)
                assert len(asked) == min(len(wanted), 10), (passage["id"], kind)
                for question in asked:
                    bank = questions[question["questionId"]]
                    key = key_from_question(question)
                    if kind == "word_order":
                        answer: dict[str, Any] = {"order": list(bank["tokenRefs"])}
                        assert question["answerKey"]["order"] == bank["tokenRefs"]
                    elif kind == "word_recall":
                        answer = {"text": surface(bundle, bank["tokenRefs"][0])}
                    else:
                        answer = {"optionId": question["answerKey"]["optionId"]}
                        assert refs_for_option_id(answer["optionId"]) == bank["correctRef"]
                        texts = [o["text"] for o in question["options"]]
                        assert len(set(texts)) == len(texts)  # no two options look alike
                        correct = next(
                            o for o in question["options"] if o["optionId"] == answer["optionId"]
                        )
                        assert correct["text"] == " ".join(
                            surface(bundle, ref) for ref in bank["correctRef"]
                        ) or correct["text"].startswith(surface(bundle, bank["correctRef"][0]))
                    result = evaluate_answer(
                        key,
                        answer,
                        hint_used=False,
                        normalization_policy="arabic-norm-v1",
                        scoring_policy="v1",
                    )
                    assert isinstance(result, ValidatedAttempt) and result.correct
                    checked.add(question["questionId"])
    assert len(checked) >= 0.95 * (len(QURAN_QUESTIONS) + len(HADITH_QUESTIONS))


def test_a_grade_question_offers_the_grade_phrases_of_the_edition_and_has_no_context() -> None:
    env = Env()
    grade_passage = next(p for p in HADITH["passages"] if p["path"] == "grade")
    snapshot, _ = env.game(PLAN_B_ID, 2, passageIds=[grade_passage["id"]])
    (question,) = questions_json(snapshot)
    assert question["type"] == "word_choice"
    # the grade phrase is the whole passage: nothing lies around the blank
    assert question["context"] == {"before": [], "after": [], "ayahEnds": []}
    phrases = {HADITH_UNITS[o]["canonicalText"] for o in (3, 6, 11)}
    assert {o["text"] for o in question["options"]} <= phrases and len(question["options"]) >= 2
