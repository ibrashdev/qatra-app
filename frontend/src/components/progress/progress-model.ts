import type { SectionKind } from "@/i18n/progress-messages";
import type { PlanProgress, ProgressResponse } from "@/lib/api/types";

// What S-21 derives from E19 (UI-screens S-21 section 3, "Rules"). Numbers print as received: nothing here recomputes a percentage.

export type ProgressView = { kind: "plan"; plan: PlanProgress; completed: boolean } | { kind: "none"; hasPausedPlan: boolean };

// The plan shown is the active one; with none active but a completed one, that plan (G-31); otherwise there is no plan to show (G-24).
export function selectPlan(progress: ProgressResponse): ProgressView {
  const active = progress.plans.find((plan) => plan.status === "active");
  if (active !== undefined) return { kind: "plan", plan: active, completed: false };
  const completed = progress.plans.find((plan) => plan.status === "completed");
  if (completed !== undefined) return { kind: "plan", plan: completed, completed: true };
  return { kind: "none", hasPausedPlan: progress.plans.some((plan) => plan.status === "paused") };
}

export type GroupId = "needsRefresh" | "progress" | "confirmed";
export type PlanSection = PlanProgress["sections"][number];

export interface SectionGroup {
  id: GroupId;
  rows: PlanSection[];
  open: boolean; // O-22: needs refresh and in progress start open when not empty, confirmed starts closed
}

const GROUPS: readonly { id: GroupId; statuses: readonly PlanSection["status"][]; open: boolean }[] = [
  { id: "needsRefresh", statuses: ["needs_refresh"], open: true },
  { id: "progress", statuses: ["learning", "reviewing"], open: true },
  { id: "confirmed", statuses: ["confirmed"], open: false },
];

// `new` sections are in no group (O-27); empty groups are not shown.
export function groupSections(plan: PlanProgress): SectionGroup[] {
  return GROUPS.map(({ id, statuses, open }) => ({ id, open, rows: plan.sections.filter((section) => statuses.includes(section.status)) })).filter((group) => group.rows.length > 0);
}

export const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.trunc(value)));

// E19 carries no section kind. The English labels are numeric ("Surah 78", "Hadith 1", UA-05), so the noun for "N of M confirmed" is read from them.
export function sectionKind(plan: PlanProgress): SectionKind {
  const label = plan.sections[0]?.titleEn ?? "";
  if (/^Hadith\b/i.test(label)) return "hadith";
  if (/^Surah\b/i.test(label)) return "surah";
  return "section";
}
