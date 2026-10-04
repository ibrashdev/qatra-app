"""Server grading (API-spec S-5, contract §2.4-§2.5): synthetic placeholder words only."""

from __future__ import annotations

from typing import Any

import pytest

from app.domain import normalization
from app.domain.answer_policy import (
    GradingUnavailable,
    QuestionKey,
    RejectedAnswer,
    ValidatedAttempt,
    evaluate_answer,
    key_from_question,
)

NORM = "arabic-norm-v1"
SCORING = "v1"


def grade(
    key: QuestionKey,
    answer: Any,
    *,
    hint: bool = False,
    norm: str | None = NORM,
    scoring: str | None = SCORING,
):
    return evaluate_answer(
        key, answer, hint_used=hint, normalization_policy=norm, scoring_policy=scoring
    )


# --- stored questions (the ``question`` object of a snapshot step) ------------------------------


def order_question(**overrides: Any) -> dict[str, Any]:
    question: dict[str, Any] = {
        "type": "word_order",
        "tokens": [
            {"ref": "5:2", "text": "ثالث"},
            {"ref": "5:0", "text": "أول"},
            {"ref": "5:1", "text": "ثان"},
        ],
        "answerKey": {"order": ["5:0", "5:1", "5:2"]},
    }
    question.update(overrides)
    return question


def choice_question(kind: str = "word_choice") -> dict[str, Any]:
    return {
        "type": kind,
        "options": [
            {"optionId": "2:0", "text": "ا"},
            {"optionId": "7:3", "text": "ب"},
            {"optionId": "9:1", "text": "ج"},
        ],
        "answerKey": {"optionId": "7:3"},
    }


def recall_question(word: str) -> dict[str, Any]:
    norms = [normalization.normalize(word)]
    alternative = normalization.alternative_form(word)
    if alternative is not None:
        norms.append(alternative)
    return {"type": "word_recall", "answerKey": {"acceptedNorms": norms}}


# --- key_from_question ---------------------------------------------------------------------------


def test_key_from_question_reads_each_type() -> None:
    order = key_from_question(order_question())
    assert order.order == ("5:0", "5:1", "5:2")
    assert order.texts["5:1"] == "ثان"
    choice = key_from_question(choice_question())
    assert choice.option_ids == ("2:0", "7:3", "9:1") and choice.correct_option_id == "7:3"
    similar = key_from_question(choice_question("similar_distinction"))
    assert similar.type == "similar_distinction"
    recall = key_from_question(recall_question("كِتَٰب"))
    assert recall.accepted_norms == ("كتب", "كتاب")


@pytest.mark.parametrize(
    "broken",
    [
        {"type": "bogus", "answerKey": {}},
        {"type": "word_order"},  # no answerKey
        order_question(answerKey={"order": ["5:0", "5:1"]}),  # not a permutation of the tokens
        order_question(answerKey={"order": "5:0"}),
        order_question(tokens="x"),
        {"type": "word_choice", "options": "x", "answerKey": {"optionId": "a"}},
        {"type": "word_choice", "options": [{"optionId": "a"}], "answerKey": {"optionId": "b"}},
        {
            "type": "word_choice",
            "options": [{"optionId": "a"}, {"optionId": "a"}],
            "answerKey": {"optionId": "a"},
        },
        {"type": "word_recall", "answerKey": {"acceptedNorms": []}},
        {"type": "word_recall", "answerKey": {"acceptedNorms": [""]}},
        {"type": "word_recall", "answerKey": {"acceptedNorms": [1]}},
    ],
)
def test_key_from_question_rejects_an_inconsistent_snapshot_without_quoting_text(
    broken: dict[str, Any],
) -> None:
    with pytest.raises(ValueError) as raised:
        key_from_question(broken)
    assert "ثان" not in str(raised.value)


# --- word_order ----------------------------------------------------------------------------------


def test_word_order_correct_and_incorrect() -> None:
    key = key_from_question(order_question())
    right = grade(key, {"order": ["5:0", "5:1", "5:2"]})
    assert isinstance(right, ValidatedAttempt)
    assert (right.correct, right.assisted, right.error_kind) == (True, False, "none")
    assert right.expected_order == ("5:0", "5:1", "5:2")
    wrong = grade(key, {"order": ["5:2", "5:1", "5:0"]})
    assert isinstance(wrong, ValidatedAttempt)
    assert (wrong.correct, wrong.error_kind) == (False, "wrong_order")
    assert wrong.expected_order == ("5:0", "5:1", "5:2")


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        ({"order": ["5:0", "5:1"]}, "not_a_permutation"),  # a token missing
        ({"order": ["5:0", "5:1", "5:2", "5:3"]}, "not_a_permutation"),  # a token added
        ({"order": ["5:0", "5:0", "5:2"]}, "not_a_permutation"),  # a token twice
        ({"order": ["5:0", "5:1", "9:9"]}, "not_a_permutation"),  # a foreign reference
        ({"order": []}, "not_a_permutation"),
        ({"order": "5:0,5:1,5:2"}, "answer_shape"),
        ({"order": [0, 1, 2]}, "answer_shape"),
        ({"optionId": "5:0"}, "answer_shape"),  # another payload type
        ({"order": ["5:0", "5:1", "5:2"], "text": "x"}, "answer_shape"),  # extra property
        ({}, "answer_shape"),
        (None, "answer_shape"),
        ("5:0", "answer_shape"),
    ],
)
def test_word_order_shape_violations_are_rejected_not_graded(answer: Any, reason: str) -> None:
    key = key_from_question(order_question())
    assert grade(key, answer) == RejectedAnswer(reason)


def test_word_order_treats_a_repeated_word_as_one_answer() -> None:
    # Two particles with the same text have two references; their order cannot be told apart.
    question = order_question(
        tokens=[
            {"ref": "5:2", "text": "و"},
            {"ref": "5:0", "text": "كلمة"},
            {"ref": "5:1", "text": "و"},
        ],
        answerKey={"order": ["5:0", "5:1", "5:2"]},
    )
    key = key_from_question(question)
    swapped = grade(key, {"order": ["5:0", "5:2", "5:1"]})
    assert isinstance(swapped, ValidatedAttempt) and swapped.correct
    different_word_first = grade(key, {"order": ["5:1", "5:0", "5:2"]})
    assert isinstance(different_word_first, ValidatedAttempt) and not different_word_first.correct


# --- word_choice and similar_distinction ---------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "error_kind"),
    [("word_choice", "wrong_choice"), ("similar_distinction", "similar_confusion")],
)
def test_option_games_grade_by_option_id(kind: str, error_kind: str) -> None:
    key = key_from_question(choice_question(kind))
    right = grade(key, {"optionId": "7:3"})
    assert isinstance(right, ValidatedAttempt) and right.correct and right.error_kind == "none"
    assert right.expected_option_id == "7:3" and right.chosen_option_id == "7:3"
    wrong = grade(key, {"optionId": "2:0"})
    assert isinstance(wrong, ValidatedAttempt) and not wrong.correct
    assert wrong.error_kind == error_kind
    assert wrong.chosen_option_id == "2:0" and wrong.expected_option_id == "7:3"


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        ({"optionId": "1:1"}, "unknown_option"),  # not one of the question's options
        ({"optionId": ""}, "unknown_option"),
        ({"optionId": 7}, "answer_shape"),
        ({"order": ["7:3"]}, "answer_shape"),
        ({"text": "ب"}, "answer_shape"),
        ({"optionId": "7:3", "hintUsed": True}, "answer_shape"),
        ({}, "answer_shape"),
        (["7:3"], "answer_shape"),
    ],
)
def test_option_games_reject_a_foreign_option_or_shape(answer: Any, reason: str) -> None:
    key = key_from_question(choice_question())
    assert grade(key, answer) == RejectedAnswer(reason)


# --- word_recall: arabic-norm-v1 (contract §2.5) ------------------------------------------------


@pytest.mark.parametrize(
    ("target", "typed"),
    [
        ("كَلِمَةٌ", "كلمة"),  # harakat, tanwin and shadda are removed
        ("كَلِمَةٌ", "كلمه"),  # teh marbuta maps to heh
        ("كلمة", "كلـــمة"),  # tatweel is removed
        ("أمثال", "امثال"),  # hamza forms map to alef
        ("إجابة", "اجابه"),
        ("آلة", "اله"),
        ("ٱلكتاب", "الكتاب"),  # alef wasla
        ("مستشفى", "مستشفي"),  # alef maksura maps to yeh
        ("مؤشر", "موشر"),  # waw with hamza
        ("قائمة", "قايمه"),  # yeh with hamza
        ("كلمة", "كل​مة"),  # zero-width characters are removed
        ("كلمة", "كلمة،"),  # punctuation is removed
        ("كلمة", "«كلمة»"),
        ("كلمة", "كلمة١"),  # Arabic-Indic digits are removed when grading words
        ("كلمة", "  كلمة  "),  # surrounding whitespace is trimmed
        ("كلمة", " كلمة "),  # also non-breaking spaces
        ("كلمة", "كَلِمَةٌ"),  # the typed answer may carry marks as well
        ("abc", "ABC"),  # Latin is lower-cased
    ],
)
def test_recall_accepts_the_normalized_form_of_the_target(target: str, typed: str) -> None:
    key = key_from_question(recall_question(target))
    result = grade(key, {"text": typed})
    assert isinstance(result, ValidatedAttempt), result
    assert result.correct and result.error_kind == "none"


def test_recall_accepts_both_the_plain_and_the_superscript_alef_form() -> None:
    key = key_from_question(recall_question("كِتَٰب"))  # n "كتب", a "كتاب"
    for typed in ("كتب", "كتاب", "كِتَٰب"):
        result = grade(key, {"text": typed})
        assert isinstance(result, ValidatedAttempt) and result.correct, typed


def test_recall_marks_a_different_word_incorrect_with_a_valid_shape() -> None:
    key = key_from_question(recall_question("كلمة"))
    result = grade(key, {"text": "مثال"})
    assert isinstance(result, ValidatedAttempt)
    assert (result.correct, result.error_kind) == (False, "wrong_recall")
    assert result.accepted_norms == ("كلمه",)


@pytest.mark.parametrize(
    "typed",
    [
        "كلمة مثال",  # two words
        "كلمة مثال",  # two words separated by a non-breaking space
        "كلمة\tمثال",
        "",
        "   ",
        "١٢٣",  # digits only is not a word
        "،",  # punctuation only is not a word
        "۞",  # a mark is not a word
    ],
)
def test_recall_must_be_exactly_one_word(typed: str) -> None:
    key = key_from_question(recall_question("كلمة"))
    assert grade(key, {"text": typed}) == RejectedAnswer("not_one_word")


@pytest.mark.parametrize(
    "answer",
    [
        {"text": 5},
        {"text": None},
        {"optionId": "x"},
        {"order": ["1:1"]},
        {},
        {"text": "كلمة", "x": 1},
    ],
)
def test_recall_rejects_the_wrong_payload_type(answer: Any) -> None:
    key = key_from_question(recall_question("كلمة"))
    assert grade(key, answer) == RejectedAnswer("answer_shape")


def test_a_graded_recall_result_does_not_keep_the_typed_text() -> None:
    key = key_from_question(recall_question("كلمة"))
    typed = "مثالُالنصِّ"
    result = grade(key, {"text": typed})
    assert isinstance(result, ValidatedAttempt)
    assert typed not in repr(result)
    assert "مثالالنص" not in repr(result)


# --- policy versions: unavailable, never guessed -------------------------------------------------

KEYS = {
    "word_order": (order_question, {"order": ["5:0", "5:1", "5:2"]}),
    "word_choice": (choice_question, {"optionId": "7:3"}),
    "similar_distinction": (lambda: choice_question("similar_distinction"), {"optionId": "7:3"}),
    "word_recall": (lambda: recall_question("كلمة"), {"text": "كلمة"}),
}


@pytest.mark.parametrize("kind", sorted(KEYS))
@pytest.mark.parametrize(
    ("norm", "scoring", "reason"),
    [
        ("arabic-norm-v2", SCORING, "normalization_policy_unsupported"),
        ("ARABIC-NORM-V1", SCORING, "normalization_policy_unsupported"),
        (None, SCORING, "normalization_policy_missing"),
        ("", SCORING, "normalization_policy_missing"),
        (NORM, "v2", "scoring_policy_unsupported"),
        (NORM, None, "scoring_policy_missing"),
        (NORM, "", "scoring_policy_missing"),
    ],
)
def test_an_unsupported_or_missing_policy_version_makes_grading_unavailable(
    kind: str, norm: str | None, scoring: str | None, reason: str
) -> None:
    build, answer = KEYS[kind]
    key = key_from_question(build())
    assert grade(key, answer, norm=norm, scoring=scoring) == GradingUnavailable(reason)


def test_the_policy_is_checked_before_the_shape_of_the_answer() -> None:
    key = key_from_question(recall_question("كلمة"))
    assert grade(key, {"text": "كلمة مثال"}, norm="arabic-norm-v2") == GradingUnavailable(
        "normalization_policy_unsupported"
    )
    assert grade(key, {"nonsense": 1}, scoring=None) == GradingUnavailable("scoring_policy_missing")


# --- hints: assisted, still graded ---------------------------------------------------------------


@pytest.mark.parametrize("kind", sorted(KEYS))
def test_a_hint_marks_the_answer_assisted_and_it_is_still_graded(kind: str) -> None:
    build, answer = KEYS[kind]
    key = key_from_question(build())
    helped = grade(key, answer, hint=True)
    assert isinstance(helped, ValidatedAttempt)
    assert helped.assisted and helped.correct
    plain = grade(key, answer, hint=False)
    assert isinstance(plain, ValidatedAttempt) and not plain.assisted


def test_a_wrong_answer_with_a_hint_is_assisted_and_incorrect() -> None:
    key = key_from_question(choice_question())
    result = grade(key, {"optionId": "2:0"}, hint=True)
    assert isinstance(result, ValidatedAttempt)
    assert result.assisted and not result.correct and result.error_kind == "wrong_choice"


def test_an_unknown_key_type_is_an_integrity_error_not_a_grade() -> None:
    with pytest.raises(ValueError):
        grade(QuestionKey(type="bogus"), {"text": "x"})
