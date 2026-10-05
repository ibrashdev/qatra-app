import { getStartMessages } from "@/i18n/start-messages";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import type { PlanOverviewMessages } from "@/i18n/plan-overview-messages";
import type { CatalogEdition, CatalogResponse, ISODate, Path, Plan, PlanProgress, ProgressResponse, Today } from "@/lib/api/types";
import { formatLearningDate, upcomingReviewDate } from "@/components/today/today-model";

// What S-12 derives from E18, E19 and E14 (UI-screens S-12 section 3). No plan number is computed here: values print as received.

export type StageStatus = PlanProgress["sections"][number]["status"];

export interface StageRow {
  ordinal: number;
  reference: string;
  titleAr: string;
  titleEn: string;
  percent: number;
  status: StageStatus;
  current: boolean;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.trunc(value)));

export const planProgressOf = (progress: ProgressResponse | null, planId: string): PlanProgress | null => progress?.plans.find((entry) => entry.planId === planId) ?? null;

export function editionOf(catalog: CatalogResponse | null, plan: Plan): CatalogEdition | null {
  return catalog?.editions.find((entry) => entry.editionId === plan.editionId) ?? null;
}

// The section of `nextNewPassage` is the current stage. Titles may repeat, so the reference («79:1-5» belongs to section «79») breaks a tie.
function currentOrdinal(today: Today, sections: PlanProgress["sections"]): number | null {
  const passage = today.nextNewPassage;
  if (passage === null) return null;
  const sameTitle = sections.filter((section) => section.titleAr === passage.sectionTitleAr);
  const sectionReference = passage.reference.split(":")[0]?.trim();
  const match = sameTitle.find((section) => section.reference === sectionReference) ?? sameTitle[0];
  return match?.ordinal ?? null;
}

// Stages in plan order: E19 lists the sections in book order, so the reverse order (Quran only, D72) reverses the list.
export function stageRows(plan: Plan, progress: ProgressResponse | null, today: Today): StageRow[] {
  const sections = planProgressOf(progress, plan.planId)?.sections ?? [];
  const ordered = plan.order === "reverse" ? [...sections].reverse() : [...sections];
  const current = currentOrdinal(today, sections);
  return ordered.map((section) => ({
    ordinal: section.ordinal,
    reference: section.reference,
    titleAr: section.titleAr,
    titleEn: section.titleEn,
    percent: clampPercent(section.percent),
    status: section.status,
    current: section.ordinal === current,
  }));
}

// The English interface shows the English title; an Arabic one keeps its own language so it is read and laid out as Arabic.
export function stageLabel(locale: Locale, row: Pick<StageRow, "titleAr" | "titleEn">): { text: string; lang: Locale } {
  return locale === "en" && row.titleEn !== "" ? { text: row.titleEn, lang: "en" } : { text: row.titleAr, lang: "ar" };
}

// The plans E18 does not carry: paused ones first (they can be resumed), then completed ones.
export function otherPlans(progress: ProgressResponse | null, activePlanId: string | null): PlanProgress[] {
  const rest = (progress?.plans ?? []).filter((entry) => entry.planId !== activePlanId && entry.status !== "active");
  return [...rest.filter((entry) => entry.status === "paused"), ...rest.filter((entry) => entry.status === "completed")];
}

// «كل الأقسام» or «{n} من {m} سورة»; the wording is the one of the S-08 sentence. Without the edition the scope is not stated.
export function scopeLine(locale: Locale, plan: Plan, edition: CatalogEdition | null): string | null {
  if (edition === null) return null;
  const sentence = getStartMessages(locale).sentence;
  const chosen = plan.targetScope.sectionOrdinals.length;
  const total = edition.sections.length;
  if (chosen >= total) return sentence.all;
  return sentence.someOf(formatInteger(locale, chosen), formatInteger(locale, total), edition.sections[0]?.kind ?? "surah");
}

const HADITH_PATH_ORDER: readonly Path[] = ["matn", "sanad", "grade"];

// The labels of the hadith paths in their fixed order; the Quran path has no label and no line (S-12 c3).
export function pathLabels(locale: Locale, paths: readonly Path[]): string[] {
  const names = getStartMessages(locale).paths; // the labels of the S-08 boxes: «متن»، «سند»، «الدرجة»
  return HADITH_PATH_ORDER.filter((path): path is "matn" | "sanad" | "grade" => path !== "quran" && paths.includes(path)).map((path) => names[path]);
}

export const isQuranPlan = (plan: Plan): boolean => plan.paths.includes("quran");

// c3: the title with its edition, then one line with the scope, the paths, the order (Quran only) and the date.
export function goalLines(locale: Locale, t: PlanOverviewMessages, plan: Plan, edition: CatalogEdition | null): { head: string; detail: string } {
  const title = locale === "ar" ? plan.titleAr : plan.titleEn;
  const separator = locale === "ar" ? "، " : ", ";
  const parts: string[] = [];
  const scope = scopeLine(locale, plan, edition);
  if (scope !== null) parts.push(scope);
  const labels = pathLabels(locale, plan.paths);
  if (labels.length > 0) parts.push(t.goal.paths(labels.join(separator)));
  if (isQuranPlan(plan)) parts.push(t.goal.order[plan.order]);
  parts.push(plan.preferredDate === null ? t.goal.noDate : t.goal.date(formatLearningDate(locale, plan.preferredDate)));
  return { head: edition === null ? title : t.goal.titleEdition(title, edition.editionLabel), detail: parts.join(t.goal.separator) };
}

export type NextStepKind = { kind: "passage"; section: string; reference: string } | { kind: "review"; date: ISODate } | { kind: "none" };

// c8: the next passage, else the next review date, else the maintenance line.
export function nextStep(today: Today, progress: ProgressResponse | null, planId: string): NextStepKind {
  if (today.nextNewPassage !== null) return { kind: "passage", section: today.nextNewPassage.sectionTitleAr, reference: today.nextNewPassage.reference };
  const date = upcomingReviewDate(progress, planId, today.learningDate);
  return date === null ? { kind: "none" } : { kind: "review", date };
}

// The G-32 line applies while a pending value exists; the day it starts is the next learning day (O-24).
export const hasPendingMinutes = (plan: Plan): boolean => typeof plan.pendingSessionMinutes === "number";
