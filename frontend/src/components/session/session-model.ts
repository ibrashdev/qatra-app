import type { TextKind } from "@/components/questions";
import type { CatalogEdition, PassageView, Question, SessionSnapshot, Step, TokenRef } from "@/lib/api/types";

// What S-19 derives from the immutable E20 snapshot (UI-screens S-19). Pure: no network, no React. Nothing here grades an answer.

export type Stage = "review" | "new" | "test";

// The drills belong to "new", so the indicator has at most three stages (UI-tokens 6.23).
export function stageOfStep(step: Step): Stage {
  if (step.type === "learn") return "new";
  switch (step.question.role) {
    case "review":
      return "review";
    case "test":
      return "test";
    default:
      return "new";
  }
}

// The stages the snapshot holds, in the order they first occur. D90 puts the new passage and its drills first, then the due reviews, then the end test;
// a snapshot stored with the earlier order (reviews first) and a light review (no new passage) keep their own order too.
export function stagesOf(steps: readonly Step[]): Stage[] {
  const stages: Stage[] = [];
  for (const step of steps) {
    const stage = stageOfStep(step);
    if (!stages.includes(stage)) stages.push(stage);
  }
  return stages;
}

// A question the pieces can draw. A step that fails this is skipped with a calm line, and nothing is sent for it (S-19 "Question not valid").
export function isRenderableQuestion(question: Question): boolean {
  if (typeof question.questionId !== "string" || question.questionId === "") return false;
  switch (question.type) {
    case "word_order":
      return Array.isArray(question.tokens) && question.tokens.length > 0 && question.answerKey.order.length === question.tokens.length;
    case "word_choice":
    case "similar_distinction":
      return Array.isArray(question.options) && question.options.length >= 2 && question.options.some((option) => option.optionId === question.answerKey.optionId);
    case "word_recall":
      return true;
  }
}

export function isRenderableStep(step: Step): boolean {
  if (step.type === "learn") return Array.isArray(step.passage.units) && step.passage.units.length > 0;
  return isRenderableQuestion(step.question);
}

export function renderableIndexes(steps: readonly Step[]): number[] {
  return steps.flatMap((step, index) => (isRenderableStep(step) ? [index] : []));
}

export function firstIndexFrom(steps: readonly Step[], from: number): number | null {
  const found = renderableIndexes(steps).find((index) => index >= from);
  return found ?? null;
}

// The step after `from`, and how many unrenderable question steps were skipped on the way.
export function nextStep(steps: readonly Step[], from: number): { index: number | null; skipped: number } {
  let skipped = 0;
  for (let index = from + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    if (isRenderableStep(step)) return { index, skipped };
    if (step.type === "question") skipped += 1;
  }
  return { index: null, skipped };
}

export function lastRenderableIndex(steps: readonly Step[]): number | null {
  const all = renderableIndexes(steps);
  return all[all.length - 1] ?? null;
}

export type PrimaryAction = "start_practice" | "check" | "next" | "finish";

// The one button of the action bar follows the step (S-19 "Primary action"). A learn step with no question after it has nothing to practise, so it
// finishes. The label of "check" turns into "next" in place once the answer is checked.
export function primaryAction(steps: readonly Step[], index: number, checked: boolean): PrimaryAction {
  const step = steps[index];
  const last = lastRenderableIndex(steps);
  if (step === undefined || step.type === "learn") return nextStep(steps, index).index === null ? "finish" : "start_practice";
  if (!checked) return "check";
  return index === last ? "finish" : "next";
}

// "Question k of n": n counts the renderable question steps of the snapshot, so a skipped step leaves no gap.
export function questionPosition(steps: readonly Step[], index: number): { k: number; n: number } {
  const questions = renderableIndexes(steps).filter((position) => steps[position]?.type === "question");
  const at = questions.indexOf(index);
  return { k: at < 0 ? 0 : at + 1, n: questions.length };
}

export type StepLine = "review" | "light" | "restart" | null;

// c6: a reload starts again at the first step (a re-answer is a new attempt), a snapshot that opens on reviews says how it starts, and a snapshot with
// no learn step is the light review of G-30.
export function stepLineOf(steps: readonly Step[], restarted: boolean): StepLine {
  if (restarted) return "restart";
  const first = steps.find(isRenderableStep);
  if (first === undefined || first.type !== "question" || first.question.role !== "review") return null;
  return steps.some((step) => step.type === "learn") ? "review" : "light";
}

// The font of the book text follows the edition's format (O-39). The snapshot carries an edition id and no format, so the catalog (E14) decides;
// without a catalog entry the path of the learn passage does ("quran" is a Quran edition, a hadith path is a hadith edition). The last resort is "quran".
export function textKindOf(snapshot: SessionSnapshot, editions: readonly CatalogEdition[] | null): TextKind {
  const edition = editions?.find((entry) => entry.editionId === snapshot.editionId);
  if (edition !== undefined) return edition.contentFormat === "quran" ? "quran" : "hadith";
  const passage = snapshot.steps.find((step): step is Extract<Step, { type: "learn" }> => step.type === "learn")?.passage;
  if (passage !== undefined) return passage.path === "quran" ? "quran" : "hadith";
  return "quran";
}

// What the learn steps tell about the passages of the session. A question of a passage that has no learn step here (a review) gets no D50 notice and
// no grade-path prompt: the snapshot does not say more (S-19 "Learn step").
export function passageFacts(steps: readonly Step[]): ReadonlyMap<string, Pick<PassageView, "path" | "showD50Notice">> {
  const facts = new Map<string, Pick<PassageView, "path" | "showD50Notice">>();
  for (const step of steps) {
    if (step.type === "learn") facts.set(step.passage.passageId, { path: step.passage.path, showD50Notice: step.passage.showD50Notice });
  }
  return facts;
}

// The snapshot is immutable (E20): it is frozen once, so no screen code can change it.
export function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

const parseRef = (ref: TokenRef): [number, number] | null => {
  const match = /^(\d+):(\d+)$/.exec(ref);
  return match === null ? null : [Number(match[1]), Number(match[2])];
};

const compareRef = (left: [number, number], right: [number, number]): number => left[0] - right[0] || left[1] - right[1];

export interface UnitSegment {
  text: string;
  marked: boolean;
}

// The whole unit is shown and the range of today's passage is marked (UI-tokens 6.24). Tokens are the whitespace-separated words of the unit, numbered
// from 0 (contract 1: "<unitOrdinal>:<tokenIndex>"); both ends of the range are inside it. The text is kept as received, spaces included.
export function segmentUnit(unit: PassageView["units"][number], highlight: PassageView["highlight"]): UnitSegment[] {
  const start = parseRef(highlight.startRef);
  const end = parseRef(highlight.endRef);
  const pieces = unit.text.split(/([  ]+)/u);
  const segments: UnitSegment[] = [];
  let tokenIndex = 0;
  const push = (text: string, marked: boolean) => {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.marked === marked) last.text += text;
    else segments.push({ text, marked });
  };
  let pendingSpace = "";
  let previousMarked: boolean | null = null;
  for (const piece of pieces) {
    if (piece === "") continue;
    if (/^[  ]+$/u.test(piece)) {
      pendingSpace = piece;
      continue;
    }
    const ref: [number, number] = [unit.unitRef, tokenIndex];
    const marked = start !== null && end !== null && compareRef(ref, start) >= 0 && compareRef(ref, end) <= 0;
    // A space between two marked words stays inside the mark, so the fill is continuous; any other space is plain.
    if (pendingSpace !== "") push(pendingSpace, previousMarked === true && marked);
    pendingSpace = "";
    push(piece, marked);
    previousMarked = marked;
    tokenIndex += 1;
  }
  if (pendingSpace !== "") push(pendingSpace, false);
  return segments;
}
// The word a recall question asks for, read from the learn passage of the same session when the passage carries it: the blank sits between the last
// context word before it and the first after it, and their refs ("unit:index") name its place. A review question of a passage the session did not teach
// has no learn step, so this is null and the original comes with the server's answer. It is only a first display; the server's `expected.word` replaces it.
export function recallTarget(steps: readonly Step[], question: Question): string | null {
  if (question.type !== "word_recall") return null;
  const before = question.context.before[question.context.before.length - 1];
  const after = question.context.after[0];
  const anchor = before !== undefined ? parseRef(before.ref) : after !== undefined ? parseRef(after.ref) : null;
  if (anchor === null) return null;
  const [unitRef, index] = before !== undefined ? [anchor[0], anchor[1] + 1] : [anchor[0], anchor[1] - 1];
  for (const step of steps) {
    if (step.type !== "learn") continue;
    const unit = step.passage.units.find((candidate) => candidate.unitRef === unitRef);
    if (unit === undefined) continue;
    const word = unit.text.split(/[ \u00A0]+/u).filter((piece) => piece !== "")[index];
    if (word !== undefined) return word;
  }
  return null;
}
// The legend is shown when the mark covers part of what is shown (UI-screens S-19 c8).
export function needsLegend(unitSegments: readonly (readonly UnitSegment[])[]): boolean {
  const all = unitSegments.flat();
  return all.some((segment) => segment.marked) && all.some((segment) => !segment.marked && segment.text.trim() !== "");
}
