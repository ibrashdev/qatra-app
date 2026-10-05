import type { AnswerPayload, AnswerResult, TokenRef } from "@/lib/api/types";

// The edition format decides the original-text font (UI-screens P-20, O-39); both formats use the original-text font (Scheherazade New, D90) at their own size.
// The snapshot does not carry it, so the screen passes it from the plan's edition.
export type TextKind = "quran" | "hadith";

// The fixed effect of the single hint of a question (contract 2.4, UI-tokens 6.16). The screen stores it once the hint is used and passes it back,
// so a removed option stays removed and a locked token stays locked.
export type HintEffect =
  | { kind: "first_letter"; letter: string }
  | { kind: "remove_option"; optionId: string }
  | { kind: "place_first"; ref: TokenRef };

export type QuestionErrorKind = "incomplete" | "empty" | "multiple_words";

// A message override is for screens whose copy differs (S-09 asks the learner to choose an answer or skip the question).
export interface QuestionError {
  kind: QuestionErrorKind;
  message?: string;
}

// What the screen knows after an answer: the local verdict from the snapshot's answer key, replaced by the server's `results[]` entry when it differs.
export interface QuestionResult {
  correct: boolean;
  assisted: boolean;
  expected: AnswerResult["expected"];
  // P-22: a rejected answer or a pending one is shown as a calm line; the default is counted.
  status?: "counted" | "rejected" | "pending";
  // O-41: the server's verdict replaced the local one.
  updated?: boolean;
}

export interface QuestionViewHandle {
  // Moves focus to the first control that still needs an answer (P-21: an incomplete answer sends nothing).
  focusAnswer: () => void;
}

export type { AnswerPayload };
