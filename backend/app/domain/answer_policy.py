"""Answer policy (pure): server-side grading of one answer (API-spec §3 S-5, contract §2.4-§2.5).

The server grades every submitted answer from the question as stored in the immutable session
snapshot (S-3: the bank is never consulted for a question that is not a step of the session).
``key_from_question`` reads that stored question (the ``question`` object of a step, camelCase
JSON) into a ``QuestionKey``; ``evaluate_answer`` then returns exactly one of three results:

- ``ValidatedAttempt``: the answer is well formed and was graded (correct or not, assisted or not).
  It carries correctness, the error kind and the expected answer, and nothing about mastery or
  time: crediting streaks, evidence and daily totals is package B6 (contract §4).
- ``RejectedAnswer``: the answer has the wrong shape for the question type (a final negative
  decision, ``invalid_answer_shape`` in E21): a word-order list that is not a permutation of the
  question's token references, an option id that is not one of the question's options, a recall
  text that is not exactly one word, or a payload of another type.
- ``GradingUnavailable``: the normalization or scoring policy version is missing or unsupported,
  so correctness cannot be decided (E21 keeps the event ``pending`` without credit). Correctness
  is never guessed.

``hint_used`` is client-reported and only sets the *assisted* flag (accepted MVP risk, D72).
Raw recall text is transient: it is graded and discarded, and no result keeps it.

Pure module: standard library and ``app.domain.normalization`` only.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from app.domain import normalization

NORMALIZATION_POLICY_VERSION: Final = normalization.POLICY_VERSION
SCORING_POLICY_VERSION: Final = "v1"

WORD_ORDER: Final = "word_order"
WORD_CHOICE: Final = "word_choice"
WORD_RECALL: Final = "word_recall"
SIMILAR_DISTINCTION: Final = "similar_distinction"
GAME_TYPES: Final[tuple[str, ...]] = (WORD_ORDER, WORD_CHOICE, WORD_RECALL, SIMILAR_DISTINCTION)

# ``attempts.error_kind`` values per game (Database-schema §4.4, A-05).
ERROR_KIND_BY_TYPE: Final[Mapping[str, str]] = {
    WORD_ORDER: "wrong_order",
    WORD_CHOICE: "wrong_choice",
    WORD_RECALL: "wrong_recall",
    SIMILAR_DISTINCTION: "similar_confusion",
}
NO_ERROR: Final = "none"


@dataclass(frozen=True, slots=True)
class QuestionKey:
    """What grading needs from one stored question; nothing else of the question is read.

    ``order``/``texts`` serve ``word_order`` (the correct token references in original order and
    the text of each reference), ``option_ids``/``correct_option_id`` serve the two choice games,
    ``accepted_norms`` serves ``word_recall`` (the target token's ``n`` and, when it exists, ``a``).
    """

    type: str
    order: tuple[str, ...] = ()
    texts: Mapping[str, str] = field(default_factory=dict)
    option_ids: tuple[str, ...] = ()
    correct_option_id: str | None = None
    accepted_norms: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ValidatedAttempt:
    """A graded answer. ``error_kind`` is ``"none"`` when correct, otherwise the ``attempts``
    value of the game. ``chosen_option_id`` lets the caller derive ``wrong_token_ref`` for the two
    choice games (the option id encodes its token references, see ``contracts_sessions``)."""

    correct: bool
    assisted: bool
    error_kind: str
    expected_order: tuple[str, ...] | None = None
    expected_option_id: str | None = None
    accepted_norms: tuple[str, ...] | None = None
    chosen_option_id: str | None = None


@dataclass(frozen=True, slots=True)
class RejectedAnswer:
    """The answer cannot be graded because its shape is wrong for the question (final)."""

    reason: str  # answer_shape | not_a_permutation | unknown_option | not_one_word


@dataclass(frozen=True, slots=True)
class GradingUnavailable:
    """A policy version is missing or unsupported: the event stays pending, nothing is guessed."""

    reason: str  # normalization_policy_missing | ..._unsupported | scoring_policy_...


AnswerEvaluation = ValidatedAttempt | RejectedAnswer | GradingUnavailable


def _string_list(value: Any, what: str) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        raise ValueError(f"{what} must be a list")
    if not all(isinstance(item, str) for item in value):
        raise ValueError(f"{what} must hold strings")
    return tuple(value)


def key_from_question(question: Mapping[str, Any]) -> QuestionKey:
    """Read a stored question (the ``question`` object of a snapshot step) into a ``QuestionKey``.

    Raises ``ValueError`` when the stored question is inconsistent (an integrity problem of the
    snapshot, never caused by an answer). The message never contains question text.
    """
    kind = question.get("type")
    answer_key = question.get("answerKey")
    if not isinstance(answer_key, Mapping):
        raise ValueError("a question needs an answerKey")
    if kind == WORD_ORDER:
        order = _string_list(answer_key.get("order"), "answerKey.order")
        tokens = question.get("tokens")
        if not isinstance(tokens, Sequence) or isinstance(tokens, str):
            raise ValueError("a word-order question needs tokens")
        texts = {str(token["ref"]): str(token["text"]) for token in tokens}
        if len(texts) != len(tokens) or sorted(texts) != sorted(order):
            raise ValueError("answerKey.order must be a permutation of the question's tokens")
        return QuestionKey(type=WORD_ORDER, order=order, texts=texts)
    if kind in (WORD_CHOICE, SIMILAR_DISTINCTION):
        options = question.get("options")
        if not isinstance(options, Sequence) or isinstance(options, str):
            raise ValueError("a choice question needs options")
        option_ids = tuple(str(option["optionId"]) for option in options)
        correct = answer_key.get("optionId")
        if len(set(option_ids)) != len(option_ids) or correct not in option_ids:
            raise ValueError("answerKey.optionId must be exactly one of the options")
        return QuestionKey(type=str(kind), option_ids=option_ids, correct_option_id=str(correct))
    if kind == WORD_RECALL:
        norms = _string_list(answer_key.get("acceptedNorms"), "answerKey.acceptedNorms")
        if not norms or not all(norms):
            raise ValueError("a recall question needs accepted normalized forms")
        return QuestionKey(type=WORD_RECALL, accepted_norms=norms)
    raise ValueError("unknown question type")


def _policy_problem(normalization_policy: str | None, scoring_policy: str | None) -> str | None:
    if not normalization_policy:
        return "normalization_policy_missing"
    if normalization_policy != NORMALIZATION_POLICY_VERSION:
        return "normalization_policy_unsupported"
    if not scoring_policy:
        return "scoring_policy_missing"
    if scoring_policy != SCORING_POLICY_VERSION:
        return "scoring_policy_unsupported"
    return None


def _same_text_sequence(
    texts: Mapping[str, str], left: Sequence[str], right: Sequence[str]
) -> bool:
    """Two reference orders that show the same words in the same order are the same answer: a
    repeated word (for example a particle that occurs twice in a clause) has two references but
    the learner cannot tell its copies apart."""
    return all(ref in texts for ref in (*left, *right)) and [texts[r] for r in left] == [
        texts[r] for r in right
    ]


def _grade_order(key: QuestionKey, answer: Any, assisted: bool) -> AnswerEvaluation:
    if not isinstance(answer, Mapping) or set(answer) != {"order"}:
        return RejectedAnswer("answer_shape")
    order = answer["order"]
    if (
        not isinstance(order, Sequence)
        or isinstance(order, str | bytes)
        or not all(isinstance(ref, str) for ref in order)
    ):
        return RejectedAnswer("answer_shape")
    if sorted(order) != sorted(key.order):
        return RejectedAnswer("not_a_permutation")
    correct = tuple(order) == key.order or _same_text_sequence(key.texts, order, key.order)
    return ValidatedAttempt(
        correct=correct,
        assisted=assisted,
        error_kind=NO_ERROR if correct else ERROR_KIND_BY_TYPE[WORD_ORDER],
        expected_order=key.order,
    )


def _grade_option(key: QuestionKey, answer: Any, assisted: bool) -> AnswerEvaluation:
    if not isinstance(answer, Mapping) or set(answer) != {"optionId"}:
        return RejectedAnswer("answer_shape")
    chosen = answer["optionId"]
    if not isinstance(chosen, str):
        return RejectedAnswer("answer_shape")
    if chosen not in key.option_ids:
        return RejectedAnswer("unknown_option")
    correct = chosen == key.correct_option_id
    return ValidatedAttempt(
        correct=correct,
        assisted=assisted,
        error_kind=NO_ERROR if correct else ERROR_KIND_BY_TYPE[key.type],
        expected_option_id=key.correct_option_id,
        chosen_option_id=chosen,
    )


def _grade_recall(key: QuestionKey, answer: Any, assisted: bool) -> AnswerEvaluation:
    if (
        not isinstance(answer, Mapping)
        or set(answer) != {"text"}
        or not isinstance(answer["text"], str)
    ):
        return RejectedAnswer("answer_shape")
    trimmed = answer["text"].strip()
    if not normalization.is_single_word(trimmed, policy=NORMALIZATION_POLICY_VERSION):
        return RejectedAnswer("not_one_word")
    normalized = normalization.normalize(trimmed, policy=NORMALIZATION_POLICY_VERSION)
    correct = normalized in key.accepted_norms
    return ValidatedAttempt(
        correct=correct,
        assisted=assisted,
        error_kind=NO_ERROR if correct else ERROR_KIND_BY_TYPE[WORD_RECALL],
        accepted_norms=key.accepted_norms,
    )


def evaluate_answer(
    key: QuestionKey,
    answer: Any,
    *,
    hint_used: bool,
    normalization_policy: str | None,
    scoring_policy: str | None,
) -> AnswerEvaluation:
    """Grade ``answer`` (the ``answer`` object of an E21 answer event, camelCase) against ``key``.

    The two policy versions are those of the offline envelope, or of the question's ``policy`` for
    an online event. Anything but ``arabic-norm-v1`` and ``v1`` makes grading unavailable, before
    the answer is looked at: the shape of a recall answer depends on the normalization policy.
    """
    problem = _policy_problem(normalization_policy, scoring_policy)
    if problem is not None:
        return GradingUnavailable(problem)
    assisted = bool(hint_used)
    if key.type == WORD_ORDER:
        return _grade_order(key, answer, assisted)
    if key.type in (WORD_CHOICE, SIMILAR_DISTINCTION):
        return _grade_option(key, answer, assisted)
    if key.type == WORD_RECALL:
        return _grade_recall(key, answer, assisted)
    raise ValueError("unknown question type")
