import type { Locale } from "@/i18n/messages";
import type { ISODate, PlanProgress, ProgressResponse, Today } from "@/lib/api/types";

// What S-11 derives from E18 and E19 (UI-screens S-11 section 3, "Data"). No plan number is computed here: values print as received.

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.trunc(value)));

export interface CurrentStage {
  titleAr: string;
  titleEn: string | null; // only E19 carries the English title
  percent: number | null; // null when E19 failed or has no such section: the row then loses its percent (S-11 "Data")
}

// Current stage = the section of `nextNewPassage`. Section titles may repeat, so the reference («79:1-5» belongs to section «79») breaks a tie.
// With no next passage (near horizon) no stage can be named, and the row is left out.
export function currentStage(today: Today, progress: ProgressResponse | null): CurrentStage | null {
  const { plan, nextNewPassage } = today;
  if (plan === null || nextNewPassage === null) return null;
  const sections = progress?.plans.find((entry) => entry.planId === plan.planId)?.sections ?? [];
  const sameTitle = sections.filter((section) => section.titleAr === nextNewPassage.sectionTitleAr);
  const sectionReference = nextNewPassage.reference.split(":")[0]?.trim();
  const match = sameTitle.find((section) => section.reference === sectionReference) ?? sameTitle[0];
  if (match === undefined) return { titleAr: nextNewPassage.sectionTitleAr, titleEn: null, percent: null };
  return { titleAr: match.titleAr, titleEn: match.titleEn, percent: clampPercent(match.percent) };
}

// The plan of the account that E18 does not carry because it is not active (S-11 "Completed plan", "No active plan").
export function inactivePlan(progress: ProgressResponse | null, status: "completed" | "paused"): PlanProgress | null {
  return progress?.plans.find((entry) => entry.status === status) ?? null;
}

// The next review date of the plan in view, only while it is still ahead: a date that is today or past is a review that is due, not a date.
export function upcomingReviewDate(progress: ProgressResponse | null, planId: string | null, learningDate: ISODate): ISODate | null {
  if (progress === null) return null;
  const entry = planId === null ? progress.plans[0] : progress.plans.find((plan) => plan.planId === planId);
  const date = entry?.nextReviewDate ?? null;
  return date !== null && date > learningDate ? date : null;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function utcDay(date: ISODate): number | null {
  const parts = DATE_PATTERN.exec(date);
  if (parts === null) return null;
  return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

// Whole days from `from` to `to`; null when either is not a YYYY-MM-DD date.
export function daysBetween(from: ISODate, to: ISODate): number | null {
  const start = utcDay(from);
  const end = utcDay(to);
  return start === null || end === null ? null : Math.round((end - start) / DAY_MS);
}

export function addDays(date: ISODate, days: number): ISODate {
  const start = utcDay(date);
  if (start === null) return date;
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}

const DATE_LOCALES: Record<Locale, string> = { ar: "ar-u-ca-gregory-nu-arab", en: "en-u-ca-gregory-nu-latn" };

// A learning date is written from its parts, never through a time zone (P-16): it is built at UTC midnight and read back as UTC.
export function formatLearningDate(locale: Locale, date: ISODate): string {
  const day = utcDay(date);
  if (day === null) return date;
  return new Intl.DateTimeFormat(DATE_LOCALES[locale], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(day);
}

// G-30 (R07): three or more days since the last learning day, and nothing yet today. The trigger reaches the client in no field (O-25), so it is
// derived from E19 `history`, which lists the dates that have activity. No history means a new plan, not an absence.
export const ABSENCE_DAYS = 3;

export function isReturnAfterAbsence(today: Today, progress: ProgressResponse | null): boolean {
  if (progress === null || today.dailyActiveMs > 0 || today.openSessionId !== null) return false;
  const lastActive = progress.history.reduce<ISODate | null>((latest, entry) => (entry.activeMs > 0 && (latest === null || entry.date > latest) ? entry.date : latest), null);
  if (lastActive === null) return false;
  const gap = daysBetween(lastActive, today.learningDate);
  return gap !== null && gap >= ABSENCE_DAYS;
}

// A performance.now() value, the clock of the throttle countdown (P-06): a change of the system clock cannot stretch or cut the wait.
export const monotonicNow = (): number => performance.now();

export const minutesOf =(ms: number): number => Math.floor(ms / 60_000);

// G-32: the pending change starts on the next learning day, which is `learningDate` plus one day (O-24).
export function pendingMinutes(today: Today): number | null {
  const pending = today.plan?.pendingSessionMinutes;
  return typeof pending === "number" ? pending : null;
}
