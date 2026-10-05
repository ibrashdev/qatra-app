import { composeGoal } from "@/components/start/goal-sentence";
import { EMPTY_FORM, GOAL_MAX_CODE_POINTS, groupCategories, resolveCascade, selectedOrdinals, type HadithPath, type Minutes } from "@/components/start/start-model";
import type { Locale } from "@/i18n/messages";
import type { EstimateRequest, RevisePlanRequest } from "@/lib/api/plan-endpoints";
import type { CatalogEdition, CreatePlanChatRequest, Estimate, ISODate, Path, Plan, PlanOrder } from "@/lib/api/types";

// The pure rules of S-13 (UI-screens S-13 section 3, "Form rules"): what the plan in force says, what the form changed, and the three requests.

const HADITH_PATHS: readonly HadithPath[] = ["matn", "sanad", "grade"];

export const isQuranPlan = (plan: Plan): boolean => plan.paths.includes("quran");

export interface ReviseForm {
  minutes: Minutes;
  date: string; // "" when no date; E17 cannot clear a date, so an empty box means "unchanged"
  paths: HadithPath[]; // hadith plans only
  order: PlanOrder; // Quran plans only
}

export type ReviseField = "minutes" | "date" | "paths" | "order";

// The checked hadith paths in their fixed order (matn, sanad, grade).
export const hadithPathsOf = (paths: readonly Path[]): HadithPath[] => HADITH_PATHS.filter((path) => paths.includes(path));

export function formFromPlan(plan: Plan): ReviseForm {
  return { minutes: plan.sessionMinutes, date: plan.preferredDate ?? "", paths: hadithPathsOf(plan.paths), order: plan.order };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((entry) => b.includes(entry));

// The fields that differ from the plan in force: the only ones E17 receives. Scope and edition are never among them.
export type PlanChange = Pick<RevisePlanRequest, "sessionMinutes" | "preferredDate" | "paths" | "order">;

export function changedFields(plan: Plan, form: ReviseForm): PlanChange {
  const change: PlanChange = {};
  if (form.minutes !== plan.sessionMinutes) change.sessionMinutes = form.minutes;
  if (form.date !== "" && form.date !== (plan.preferredDate ?? "")) change.preferredDate = form.date;
  if (!isQuranPlan(plan) && !sameList(form.paths, hadithPathsOf(plan.paths))) change.paths = form.paths;
  if (isQuranPlan(plan) && form.order !== plan.order) change.order = form.order;
  return change;
}

export const hasChange = (plan: Plan, form: ReviseForm): boolean => Object.keys(changedFields(plan, form)).length > 0;

// E15 sends the plan's edition, scope and paths with the form's minutes, date and order, and no placement session (UG-07 is deferred).
export function estimateRequest(plan: Plan, form: ReviseForm): EstimateRequest {
  return {
    editionId: plan.editionId,
    targetScope: plan.targetScope,
    paths: isQuranPlan(plan) ? plan.paths : form.paths,
    sessionMinutes: form.minutes,
    ...(form.date === "" ? {} : { preferredDate: form.date }),
    order: isQuranPlan(plan) ? form.order : plan.order,
  };
}

export function estimateDiffers(agreed: Estimate, fresh: Estimate): boolean {
  return (
    agreed.days !== fresh.days ||
    agreed.endDate !== fresh.endDate ||
    agreed.newWordsPerDay !== fresh.newWordsPerDay ||
    agreed.totalWords !== fresh.totalWords ||
    agreed.knownWords !== fresh.knownWords ||
    agreed.passageCount !== fresh.passageCount ||
    agreed.sessionMinutes !== fresh.sessionMinutes ||
    !sameList(agreed.scope.sectionOrdinals.map(String), fresh.scope.sectionOrdinals.map(String)) ||
    !sameList(agreed.paths, fresh.paths)
  );
}

// E17: the plan's version it was shown at, only the changed fields, and the estimate the learner confirmed when the estimate changes.
export function revisionBody(plan: Plan, form: ReviseForm, estimate: Estimate | null): RevisePlanRequest {
  return {
    expectedVersion: plan.currentVersion,
    ...changedFields(plan, form),
    ...(estimate !== null && estimateDiffers(plan.agreedEstimate, estimate) ? { confirmedEstimate: estimate } : {}),
  };
}

// The E15 reason line for a fresh estimate that arrived without one (E17 `estimate_changed` carries the estimate only): the same rule as the server.
export function reasonFor(estimate: Estimate, date: string): "fits_preferred_date" | "exceeds_preferred_date" | "no_preferred_date" {
  if (date === "") return "no_preferred_date";
  return estimate.endDate <= date ? "fits_preferred_date" : "exceeds_preferred_date";
}

// The composed sentence of the plan in force (O-23): E31 requires `goalText`. It is built the way S-08 builds its sentence, from what the plan
// holds. Without the edition (E14 failed) the title stands in. At most 500 characters, as E31 requires.
export function goalTextFor(locale: Locale, plan: Plan, edition: CatalogEdition | null): string {
  const title = locale === "ar" ? plan.titleAr : plan.titleEn;
  const capped = (text: string): string => Array.from(text).slice(0, GOAL_MAX_CODE_POINTS).join("");
  if (edition === null) return capped(title);
  const groups = groupCategories([edition]);
  const form = { ...EMPTY_FORM, view: "surah" as const, ordinals: plan.targetScope.sectionOrdinals, paths: isQuranPlan(plan) ? null : hadithPathsOf(plan.paths), date: plan.preferredDate ?? "" };
  const cascade = resolveCascade(form, groups);
  const sentence = composeGoal({ locale, form, cascade, selected: selectedOrdinals(form, cascade), minutes: plan.sessionMinutes }).trim();
  return capped(sentence === "" ? title : sentence);
}

// E31 with `planId`: the plan's own edition, scope, paths and minutes, no placement session, no order (it is chosen in the conversation).
// A date that has passed would be refused as `date_invalid`, so it is left out: the conversation can set a new one.
export function startRequest(locale: Locale, plan: Plan, edition: CatalogEdition | null, learningDate: ISODate): CreatePlanChatRequest {
  const dateStillAhead = plan.preferredDate !== null && plan.preferredDate >= learningDate;
  return {
    editionId: plan.editionId,
    targetScope: plan.targetScope,
    paths: plan.paths,
    sessionMinutes: plan.sessionMinutes,
    ...(dateStillAhead && plan.preferredDate !== null ? { preferredDate: plan.preferredDate } : {}),
    goalText: goalTextFor(locale, plan, edition),
    language: locale,
    planId: plan.planId,
  };
}

export type FieldErrors = Partial<Record<ReviseField, string>>;

// The 422 rules of E15 and E17 that belong to a field of the form (P-03, G-14).
const RULE_FIELDS = new Map<string, ReviseField>([
  ["session_minutes_invalid", "minutes"],
  ["date_invalid", "date"],
  ["paths_invalid", "paths"],
  ["path_not_available", "paths"],
  ["order_not_available", "order"],
]);

// The rule that spoke for each field, keyed by the field it belongs to; a rule with no field of the form is left out.
export function fieldErrorsOf(rules: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const rule of rules) {
    const field = RULE_FIELDS.get(rule);
    if (field !== undefined && errors[field] === undefined) errors[field] = rule;
  }
  return errors;
}
