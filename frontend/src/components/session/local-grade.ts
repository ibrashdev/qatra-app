import type { QuestionResult } from "@/components/questions";
import type { AnswerPayload, Question } from "@/lib/api/types";
import { normalizeArabicWord } from "./arabic-norm";

const sameOrder = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((ref, index) => ref === right[index]);

// The first verdict of an answer, from the answer key the snapshot ships (S-19 "Answer flow", P-21). It is shown at once; the server's `results[]` entry is
// authoritative and replaces it when it differs. A recall answer carries no `expected.word` here: the key holds only normalised forms, so the original
// word arrives with the server's answer.
export function gradeLocally(question: Question, answer: AnswerPayload, hintUsed: boolean): QuestionResult {
  switch (question.type) {
    case "word_order": {
      const order = "order" in answer ? answer.order : [];
      return { correct: sameOrder(order, question.answerKey.order), assisted: hintUsed, expected: { order: question.answerKey.order } };
    }
    case "word_choice":
    case "similar_distinction": {
      const optionId = "optionId" in answer ? answer.optionId : null;
      return { correct: optionId === question.answerKey.optionId, assisted: hintUsed, expected: { optionId: question.answerKey.optionId } };
    }
    case "word_recall": {
      const text = "text" in answer ? normalizeArabicWord(answer.text) : "";
      return { correct: text !== "" && question.answerKey.acceptedNorms.includes(text), assisted: hintUsed, expected: {} };
    }
  }
}
