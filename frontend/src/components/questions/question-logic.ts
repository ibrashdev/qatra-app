import type { QuestionMessages } from "@/i18n/question-messages";
import type { AnswerPayload, ChoiceOption, Question, TokenRef, TokenView } from "@/lib/api/types";
import type { HintEffect, QuestionError, QuestionResult } from "./types";

// Pure rules of the question pieces. No grading happens here: the server grades (contract 2.5), and the only comparison made on the client is the
// display of a verdict the screen already holds (the snapshot's answer key or the server's `results[]` entry).

export function orderOf(answer: AnswerPayload | null): TokenRef[] {
  return answer !== null && "order" in answer ? answer.order : [];
}

export function optionIdOf(answer: AnswerPayload | null): string | null {
  return answer !== null && "optionId" in answer ? answer.optionId : null;
}

export function textOf(answer: AnswerPayload | null): string {
  return answer !== null && "text" in answer ? answer.text : "";
}

export function joinTokens(tokens: readonly TokenView[]): string {
  return tokens.map((token) => token.text).join(" ");
}

// P-21: an incomplete answer sends nothing. Recall: outer spaces are trimmed, and a trimmed text that holds a space is more than one word (S-18).
export function validateAnswer(question: Question, answer: AnswerPayload | null): QuestionError | null {
  switch (question.type) {
    case "word_order":
      return orderOf(answer).length < question.tokens.length ? { kind: "incomplete" } : null;
    case "word_choice":
    case "similar_distinction":
      return optionIdOf(answer) === null ? { kind: "empty" } : null;
    case "word_recall": {
      const trimmed = textOf(answer).trim();
      if (trimmed === "") return { kind: "empty" };
      return /\s/u.test(trimmed) ? { kind: "multiple_words" } : null;
    }
  }
}

// What is sent: the same answer, with the recall text trimmed. Null when there is nothing valid to send.
export function finalizeAnswer(question: Question, answer: AnswerPayload | null): AnswerPayload | null {
  if (validateAnswer(question, answer) !== null) return null;
  return question.type === "word_recall" ? { text: textOf(answer).trim() } : answer;
}

export function errorMessage(question: Question, error: QuestionError, messages: QuestionMessages): string {
  if (error.message !== undefined) return error.message;
  switch (error.kind) {
    case "incomplete":
      return messages.errors.incomplete;
    case "multiple_words":
      return messages.errors.multipleWords;
    case "empty":
      return question.type === "word_recall" ? messages.errors.recallEmpty : messages.errors.empty;
  }
}

// The effect of the single hint (UI-tokens 6.16, S-15 to S-18). Null when the question has nothing to give.
export function resolveHint(question: Question, answer: AnswerPayload | null): HintEffect | null {
  switch (question.type) {
    case "word_recall":
      return question.hintFirstLetter === "" ? null : { kind: "first_letter", letter: question.hintFirstLetter };
    case "word_order": {
      const first = question.answerKey.order[0];
      return first === undefined ? null : { kind: "place_first", ref: first };
    }
    case "word_choice":
    case "similar_distinction": {
      const wrong = question.options.filter((option) => option.optionId !== question.answerKey.optionId);
      const selected = optionIdOf(answer);
      // The first wrong option in snapshot order other than the selected one. A similar distinction has one wrong option: if that is the
      // selected one it is removed anyway, and the selection is cleared by the caller (the hint never removes the correct option).
      const target = wrong.find((option) => option.optionId !== selected) ?? wrong[0];
      return target === undefined ? null : { kind: "remove_option", optionId: target.optionId };
    }
  }
}

// S-15: the hinted token goes to position 1; chips already placed stay after it, and a copy placed elsewhere moves up.
export function placeFirst(order: readonly TokenRef[], ref: TokenRef): TokenRef[] {
  return [ref, ...order.filter((placed) => placed !== ref)];
}

export function visibleOptions(options: readonly ChoiceOption[], hint: HintEffect | null): ChoiceOption[] {
  return hint !== null && hint.kind === "remove_option" ? options.filter((option) => option.optionId !== hint.optionId) : [...options];
}

export interface PromptOptions {
  // The path of a hadith grade passage (O-39); the snapshot question does not say, so the screen does.
  gradePath?: boolean;
  // S-09 words its two prompts differently from the games.
  placement?: boolean;
}

export function questionPrompt(question: Question, messages: QuestionMessages, options: PromptOptions = {}): string {
  const { prompts } = messages;
  switch (question.type) {
    case "word_order":
      return prompts.wordOrder;
    case "similar_distinction":
      return prompts.similar;
    case "word_recall":
      return options.placement ? prompts.placementRecall : prompts.recall;
    case "word_choice":
      if (options.placement) return prompts.placementChoice;
      if (options.gradePath) return prompts.wordChoiceGrade;
      return question.variant === "segment" ? prompts.wordChoiceSegment : prompts.wordChoiceWord;
  }
}

// The correct original for a needs-review block (S-15 to S-19), built only from the question and the expected value.
// Word order shows the tokens in the expected order; the other types show the context with the expected word or part in the blank.
export function expectedOriginal(question: Question, result: Pick<QuestionResult, "expected">): string | null {
  const { expected } = result;
  switch (question.type) {
    case "word_order": {
      if (expected.order === undefined) return null;
      const byRef = new Map(question.tokens.map((token) => [token.ref, token.text]));
      const words = expected.order.map((ref) => byRef.get(ref));
      return words.every((word): word is string => word !== undefined) ? words.join(" ") : null;
    }
    case "word_choice":
    case "similar_distinction": {
      const option = question.options.find((candidate) => candidate.optionId === expected.optionId);
      return option === undefined ? null : withBlankFilled(question, option.text);
    }
    case "word_recall":
      return expected.word === undefined || expected.word === "" ? null : withBlankFilled(question, expected.word);
  }
}

function withBlankFilled(question: Question, filler: string): string {
  return [joinTokens(question.context.before), filler, joinTokens(question.context.after)].filter((part) => part !== "").join(" ");
}

// D31: the original is shown for either outcome of a similar distinction; the other types show it only when the spot needs review.
export function showsOriginal(question: Question, result: QuestionResult): boolean {
  return question.type === "similar_distinction" || !result.correct;
}
