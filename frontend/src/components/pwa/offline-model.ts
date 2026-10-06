import type { TextKind } from "@/components/questions";
import { gradeLocally } from "@/components/session/local-grade";
import { isRenderableQuestion } from "@/components/session/session-model";
import { GAMES } from "@/components/games/game-model";
import type { DailyProgress, GameKind, ISODate, PlanSnapshot, Question, SessionSnapshot } from "@/lib/api/types";
import type { EnvelopedEvent, LocalPlanInspection, PendingEvent, RevalidationRecord } from "@/lib/offline/types";

// Pure derivations of the offline shell (S-31): what the downloaded snapshot offers, and the provisional figures the device can compute alone.
// Nothing here reads storage, the network or React, so the rules are tested without a browser.

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The sessions a snapshot offers
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type OfflineSessionKind = "daily" | GameKind;

export interface OfflineSessionEntry {
  session: SessionSnapshot;
  kind: OfflineSessionKind;
  // False when the descriptor holds no question the screens can draw, or the server's last answer no longer lists it (E25 allowedSessionRefs).
  runnable: boolean;
}

export function questionsOfSession(session: SessionSnapshot): Question[] {
  return session.steps.flatMap((step) => (step.type === "question" && isRenderableQuestion(step.question) ? [step.question] : []));
}

// A game descriptor holds the questions of one template: the first question names it. The daily descriptor has kind "daily".
export function gameKindOf(session: SessionSnapshot): GameKind | null {
  if (session.kind !== "game") return null;
  return questionsOfSession(session)[0]?.type ?? null;
}

// E25 `allowedSessionRefs` names the prepared sessions still runnable. An empty list carries no information (the server may not have listed them), so
// only a non-empty list narrows the choice.
function allowedBy(revalidation: RevalidationRecord | null, sessionId: string): boolean {
  if (revalidation === null || revalidation.status !== "available" || revalidation.allowedSessionRefs.length === 0) return true;
  return revalidation.allowedSessionRefs.includes(sessionId);
}

// The daily descriptors first, then one row per game in the order of the hub (S-14). A game with no descriptor in the snapshot has no row of its own: the
// shell says why instead (see absentGames, offline-spec 4.2).
export function sessionEntries(snapshot: PlanSnapshot, revalidation: RevalidationRecord | null): OfflineSessionEntry[] {
  const entries: OfflineSessionEntry[] = [];
  for (const session of snapshot.preparedSessions) {
    if (session.status !== "prepared") continue;
    const kind: OfflineSessionKind | null = session.kind === "daily" ? "daily" : gameKindOf(session);
    if (kind === null) continue;
    const runnable = questionsOfSession(session).length > 0 && allowedBy(revalidation, session.sessionId);
    entries.push({ session, kind, runnable });
  }
  const rank = (kind: OfflineSessionKind): number => (kind === "daily" ? -1 : GAMES.findIndex((game) => game.kind === kind));
  return entries.sort((left, right) => rank(left.kind) - rank(right.kind));
}

// The games of the hub that the snapshot has no descriptor for.
export function missingGames(entries: readonly OfflineSessionEntry[]): GameKind[] {
  const have = new Set(entries.map((entry) => entry.kind));
  return GAMES.filter((game) => !have.has(game.kind)).map((game) => game.kind);
}

// Why a game has no row of its own. "no_material": the downloaded material holds no question of that kind (a short surah can have no similar
// passages), so a connection would not help. "needs_connection": the material has such questions, but no prepared session of the kind can be started
// on this device (the descriptor is not in the prepared state any more), so the server must prepare it again.
export type AbsentReason = "no_material" | "needs_connection";

export interface AbsentGame {
  kind: GameKind;
  reason: AbsentReason;
}

// The games without a row, each with its reason. The material has a kind when the snapshot's question bank holds a question of it, or a game descriptor of
// the snapshot, in any state, is made of it. The server prepares a game session only when it has something to play, so a kind that none of these
// mention has nothing to prepare.
export function absentGames(snapshot: PlanSnapshot, entries: readonly OfflineSessionEntry[]): AbsentGame[] {
  const material = new Set<GameKind>(snapshot.games.map((question) => question.type));
  for (const session of snapshot.preparedSessions) {
    const kind = gameKindOf(session);
    if (kind !== null) material.add(kind);
  }
  return missingGames(entries).map((kind) => ({ kind, reason: material.has(kind) ? "needs_connection" : "no_material" }));
}

// The font of the book text follows the edition's format. A snapshot carries no catalog, so its lessons decide: a Quran path is "quran", any other path is
// "hadith"; a snapshot with no lessons falls back to "quran" (the last resort of session-model.textKindOf).
export function snapshotTextKind(snapshot: PlanSnapshot): TextKind {
  const first = snapshot.lessons[0];
  if (first === undefined) return "quran";
  return first.path === "quran" ? "quran" : "hadith";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Who is on the device
// ---------------------------------------------------------------------------------------------------------------------------------------------

// A visitor who never signed in on this device: the read ended with "nothing downloaded" and holds no owner, no plan and no unsent answer. A 401 for such a
// visitor is not an ended session (G-03), so the launcher invites them to log in instead. A read that failed or is locked says nothing about the past, so
// those keep the G-03 line. Null (the read has not ended) is not decided either way.
export function isNeverSignedIn(inspection: LocalPlanInspection | null): boolean {
  if (inspection === null || inspection.status !== "none") return false;
  return inspection.owner?.ownerId == null && inspection.snapshot === null && inspection.record === null && inspection.counts.total === 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Provisional figures
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Interval {
  start: number;
  end: number;
}

// The union of the activity intervals of the events that wait on the device, so two overlapping intervals count once (D40). An event the server
// refused (`blocked`) does not count. The result is a provisional figure: the server's `daily` replaces it after the replay.
export function provisionalActiveMs(events: readonly Pick<PendingEvent, "event" | "state">[]): number {
  const intervals: Interval[] = [];
  for (const entry of events) {
    if (entry.state === "blocked" || entry.event.type !== "activity") continue;
    const start = Date.parse(entry.event.startedAt);
    const end = Date.parse(entry.event.endedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ start, end });
  }
  intervals.sort((left, right) => left.start - right.start);
  let total = 0;
  let current: Interval | null = null;
  for (const interval of intervals) {
    if (current === null || interval.start > current.end) {
      if (current !== null) total += current.end - current.start;
      current = { ...interval };
    } else if (interval.end > current.end) {
      current.end = interval.end;
    }
  }
  return current === null ? total : total + (current.end - current.start);
}

// The learning date of an instant in the plan's time zone (YYYY-MM-DD). The device clock is a hint here, never proof (D40, D59): it only labels the
// provisional figure the learner sees. An unknown zone falls back to the device's own.
export function learningDateOf(ms: number, timeZone: string): ISODate {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// The provisional active time of the learner's current learning day: the activity intervals on the device that start on that date.
export function provisionalTodayMs(events: readonly Pick<PendingEvent, "event" | "state">[], timeZone: string, nowMs: number): number {
  const today = learningDateOf(nowMs, timeZone);
  return provisionalActiveMs(
    events.filter((entry) => entry.event.type === "activity" && learningDateOf(Date.parse(entry.event.startedAt), timeZone) === today),
  );
}

// The day as the device can state it: never "completed" (the server alone creates the daily completion, D40), the percentage capped at 100.
export function provisionalDaily(learningDate: ISODate, goalMs: number, activeMs: number): DailyProgress {
  const percent = goalMs > 0 ? Math.min(100, Math.floor((activeMs / goalMs) * 100)) : 0;
  return { learningDate, dailyActiveMs: activeMs, dailyGoalMs: goalMs, dailyPercent: percent, dailyCompleted: false, extraActiveMs: 0 };
}

export interface LocalRunSummary {
  answered: number;
  correct: number;
  assisted: number;
  total: number;
  activeMs: number;
}

// What the learner did in one run, from the events committed to the device. The verdict is the local first verdict from the shipped answer key.
export function summarizeRun(events: readonly EnvelopedEvent[], questions: readonly Question[]): LocalRunSummary {
  const byId = new Map(questions.map((question) => [question.questionId, question]));
  const seen = new Set<string>();
  let correct = 0;
  let assisted = 0;
  let activeMs = 0;
  for (const event of events) {
    if (event.type === "activity") {
      activeMs += event.activeMs;
      continue;
    }
    const question = byId.get(event.questionId);
    if (question === undefined || seen.has(event.questionId)) continue;
    seen.add(event.questionId);
    const graded = gradeLocally(question, event.answer, event.hintUsed);
    if (graded.correct) correct += 1;
    if (graded.assisted) assisted += 1;
  }
  return { answered: seen.size, correct, assisted, total: questions.length, activeMs };
}
