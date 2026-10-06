import { gradeLocally } from "@/components/session/local-grade";
import type { AnswerPayload, Question } from "@/lib/api/types";
import type { ProvisionalFeedback } from "@/lib/offline/types";

// The local, provisional feedback of PWA-design 2 and 4: a thin wrapper over `gradeLocally` that first checks the normalisation policy the snapshot was
// built with. A policy this app does not know, or none, means «feedback unavailable» and never a guess. The result is never authoritative: the server grades
// every answer again from the pinned snapshot and its `results[]` replace this verdict (D58, D72).

export const SUPPORTED_NORMALIZATION_POLICY = "arabic-norm-v1";

export function evaluateProvisionalAnswer(
  question: Question,
  answer: AnswerPayload,
  normalizationPolicy: string | null | undefined,
  options: { hintUsed?: boolean } = {},
): ProvisionalFeedback {
  if (normalizationPolicy === undefined || normalizationPolicy === null || normalizationPolicy === "") {
    return { available: false, provisional: true, reason: "policy_missing" };
  }
  if (normalizationPolicy !== SUPPORTED_NORMALIZATION_POLICY || question.policy.normalizationPolicyVersion !== SUPPORTED_NORMALIZATION_POLICY) {
    return { available: false, provisional: true, reason: "policy_unsupported" };
  }
  const verdict = gradeLocally(question, answer, options.hintUsed ?? false);
  return { available: true, provisional: true, correct: verdict.correct, assisted: verdict.assisted, expected: verdict.expected };
}
