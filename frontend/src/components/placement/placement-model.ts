import type { TextKind } from "@/components/questions";
import type { Path, Question, SessionSnapshot } from "@/lib/api/types";

// E20 `selfRating` (API-spec 4.7): the learner's own estimate, asked before the questions because E20 takes it only at creation (O-21).
export type SelfRating = "none" | "some" | "most";

export const SELF_RATINGS: readonly SelfRating[] = ["none", "some", "most"];

// A placement snapshot holds question steps only (up to 8, one word_choice or word_recall each); anything else in it is not part of the test.
export function placementQuestions(snapshot: SessionSnapshot): Question[] {
  return snapshot.steps.flatMap((step) => (step.type === "question" ? [step.question] : []));
}

// The snapshot does not carry the edition format (O-39): a Quran edition has the single path "quran", a hadith edition never does.
export function textKindOf(paths: readonly Path[]): TextKind {
  return paths.includes("quran") ? "quran" : "hadith";
}

// The calm line of the done step: only after «أغلبه», and only when no answered passage was correct (no new threshold, D64). A skipped question is not
// answered, so a test of skips alone qualifies. `verdicts` holds the correctness of the answered questions, by question id.
export function showsCalmLine(rating: SelfRating | null, verdicts: Readonly<Record<string, boolean>>): boolean {
  return rating === "most" && !Object.values(verdicts).some((correct) => correct);
}
