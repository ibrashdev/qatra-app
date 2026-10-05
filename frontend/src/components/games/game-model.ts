import type { IconName } from "@/components/ui/Icon";
import { classifySessionError, type SessionFailure } from "@/components/session/session-failure";
import { isRenderableQuestion } from "@/components/session/session-model";
import type { TodayFailure } from "@/components/today/today-failure";
import type { TextKind } from "@/components/questions";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import { ApiError } from "@/lib/api/errors";
import type { GameKind, Question, SessionSnapshot } from "@/lib/api/types";

// What the games hub (S-14) and the four rounds (S-15 to S-18) derive from the plan and the E20 snapshot. Pure: no network, no React.

export interface GameEntry {
  kind: GameKind;
  route: string; // the round route of the game (UI-screens S-15 to S-18, "Entry")
  // FC-12: a distinct supplemental icon per game, one glyph each in the shared adapter. The text label carries the meaning, never the glyph.
  icon: IconName;
}

// The order of the inventory (S-14 c4 to c7): word order, word or segment choice, similar distinction, word recall.
export const GAMES: readonly GameEntry[] = [
  { kind: "word_order", route: "/games/word-order", icon: "order" },
  { kind: "word_choice", route: "/games/word-choice", icon: "choose" },
  { kind: "similar_distinction", route: "/games/similar-distinction", icon: "similar" },
  { kind: "word_recall", route: "/games/word-recall", icon: "recall" },
];

export function gameEntry(kind: GameKind): GameEntry {
  const entry = GAMES.find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new RangeError(`Unknown game type: ${kind}`);
  return entry;
}

// The plan the round was started for (E18 `plan.planId`, `plan.currentVersion`); «العب مرة أخرى» starts the next round with it (P-19).
export interface RoundPlan {
  planId: string;
  planVersion: number;
}

export interface GameRound {
  snapshot: SessionSnapshot;
  gameType: GameKind;
  plan: RoundPlan;
  textKind: TextKind;
}

// UG-02: the snapshot lives in page memory only. A reload or a direct visit finds nothing held and the round route goes back to S-14 (guard 7).
let held: GameRound | null = null;

export function holdRound(round: GameRound): void {
  held = round;
}

export function peekRound(gameType: GameKind): GameRound | null {
  return held !== null && held.gameType === gameType ? held : null;
}

export function clearRound(): void {
  held = null;
}

// The questions the pieces can draw, in snapshot order. A step that fails the check is left out, and nothing is sent for it (S-19 "Question not valid").
export function roundQuestions(snapshot: SessionSnapshot): Question[] {
  if (!Array.isArray(snapshot.steps)) return [];
  return snapshot.steps.flatMap((step) => (step.type === "question" && isRenderableQuestion(step.question) ? [step.question] : []));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// `out_of_scope` is a G-20 case beside `edition_not_available` (P-19): the plan's material is no longer there, and a retry cannot succeed.
function isOutOfScope(error: ApiError): boolean {
  if (error.code === "out_of_scope" || error.details.reason === "out_of_scope") return true;
  const { fields } = error.details;
  return Array.isArray(fields) && fields.some((field) => isRecord(field) && field.rule === "out_of_scope");
}

// P-19 and P-22 map the failures of E20, E21 and E22 as S-19 does; E20 adds `out_of_scope` to the revoked kind.
export function classifyGameError(error: unknown): SessionFailure {
  if (error instanceof ApiError && isOutOfScope(error)) return { kind: "revoked" };
  return classifySessionError(error);
}

// The banners of S-11 draw a TodayFailure. A round never meets the two session-only kinds before E21 (an unknown session, a request too large), and
// "any other validation_error cannot come from the UI" (P-19), so on the hub they are treated as `internal`.
export function toTodayFailure(failure: SessionFailure): TodayFailure {
  return failure.kind === "not_found" || failure.kind === "too_large" ? { kind: "internal" } : failure;
}

// m:ss in the digits of the interface language; the caller keeps it in <bdi dir="ltr"> so the order never flips.
export function formatActiveTime(locale: Locale, activeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(activeMs / 1000));
  const seconds = new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-arab" : "en-u-nu-latn", { useGrouping: false, minimumIntegerDigits: 2 }).format(totalSeconds % 60);
  return `${formatInteger(locale, Math.floor(totalSeconds / 60))}:${seconds}`;
}
