// Mock handlers for E15, E17 and E30, as the plan overview (S-12) and the plan revision (S-13) use them. Synthetic data only. Registered by the
// coordinator next to the others: { ...mockHandlers, ...todayMockHandlers, ...planMockHandlers }. Only types come from handlers.ts.
import type { Estimate, ISODate, Path, Plan, PlanOrder, ProgressResponse } from "../types";
import type { EstimateReason, EstimateResponse } from "../plan-endpoints";
import { MOCK_PLAN_ID, mockCatalog, mockToday } from "./fixtures";
import type { MockHandler, MockResponse, MockScenario } from "./handlers";
import { mockProgress } from "./today-handlers";

export const MOCK_PAUSED_PLAN_ID = "44444444-4444-4444-8444-000000000002";
export const MOCK_COMPLETED_PLAN_ID = "44444444-4444-4444-8444-000000000005";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => failure(422, "validation_error", "The request body is not valid.", { fields });
const conflict = (reason: string, details: Record<string, unknown> = {}): MockResponse => failure(409, "version_conflict", "The request conflicts with the current state.", { reason, ...details });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isIsoDate = (value: unknown): value is ISODate => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const WORDS_PER_DAY = { 5: 12, 10: 25, 15: 40 } as const; // API-spec 4.5 (E15 response semantics)
const REVIEW_BUFFER = 1.15;

function addDays(date: ISODate, days: number): ISODate {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const basePlan = mockToday.plan as Plan;

// The paused and the completed plan of the synthetic account, as E19 lists them. E18 never carries them (its `plan` is the active one).
export const mockProgressWithOtherPlans: ProgressResponse = {
  ...mockProgress,
  plans: [
    ...mockProgress.plans,
    {
      planId: MOCK_PAUSED_PLAN_ID,
      titleAr: "عنوان المجموعة (عنصر نائب)",
      titleEn: "Collection title (placeholder)",
      status: "paused",
      currentVersion: 2,
      overallPercent: 10,
      confirmedWords: 3,
      totalWords: 30,
      confirmedSections: 0,
      totalSections: 1,
      counts: { new: 0, learning: 1, reviewing: 0, confirmed: 0, needsRefresh: 0 },
      nextReviewDate: null,
      sections: [{ ordinal: 1, reference: "1", titleAr: "اسم القسم (عنصر نائب) ١", titleEn: "Section placeholder 1", percent: 10, status: "learning" }],
    },
    {
      planId: MOCK_COMPLETED_PLAN_ID,
      titleAr: "عنوان كتاب سابق (عنصر نائب)",
      titleEn: "Earlier book title (placeholder)",
      status: "completed",
      currentVersion: 3,
      overallPercent: 100,
      confirmedWords: 20,
      totalWords: 20,
      confirmedSections: 1,
      totalSections: 1,
      counts: { new: 0, learning: 0, reviewing: 0, confirmed: 1, needsRefresh: 0 },
      nextReviewDate: "2026-10-12",
      sections: [{ ordinal: 1, reference: "1", titleAr: "اسم القسم (عنصر نائب) ١", titleEn: "Section placeholder 1", percent: 100, status: "confirmed" }],
    },
  ],
};

function estimateOf(editionId: string, ordinals: number[], paths: Path[], minutes: 5 | 10 | 15): Estimate {
  const edition = mockCatalog.editions.find((entry) => entry.editionId === editionId);
  const sections = (edition?.sections ?? []).filter((section) => ordinals.includes(section.ordinal));
  const totalWords = sections.reduce((sum, section) => sum + section.wordCount, 0);
  const perDay = WORDS_PER_DAY[minutes];
  const days = Math.max(1, Math.ceil((totalWords / perDay) * REVIEW_BUFFER));
  return {
    days,
    endDate: addDays(mockToday.learningDate, days),
    newWordsPerDay: perDay,
    totalWords,
    knownWords: 0,
    passageCount: sections.reduce((sum, section) => sum + section.passageCount, 0),
    sessionMinutes: minutes,
    scope: { sectionOrdinals: ordinals },
    paths,
  };
}

const sameEstimate = (a: Estimate, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// The shared plan rules of API-spec 4.5 that E15 and E17 both apply to the fields they carry.
function sharedRules(fields: Record<string, unknown>, available: readonly Path[], quran: boolean): { field: string; rule: string }[] {
  const broken: { field: string; rule: string }[] = [];
  if (fields.sessionMinutes !== undefined && ![5, 10, 15].includes(fields.sessionMinutes as number)) broken.push({ field: "sessionMinutes", rule: "session_minutes_invalid" });
  if (fields.preferredDate !== undefined && (!isIsoDate(fields.preferredDate) || fields.preferredDate < mockToday.learningDate)) broken.push({ field: "preferredDate", rule: "date_invalid" });
  if (fields.paths !== undefined) {
    const paths = fields.paths;
    const valid = Array.isArray(paths) && paths.length > 0 && new Set(paths).size === paths.length && paths.every((path) => (available as readonly unknown[]).includes(path));
    if (!valid) broken.push({ field: "paths", rule: "paths_invalid" });
  }
  if (fields.order !== undefined && fields.order !== "book" && !(fields.order === "reverse" && quran)) broken.push({ field: "order", rule: "order_not_available" });
  return broken;
}

const E15_FIELDS = ["editionId", "targetScope", "paths", "sessionMinutes", "preferredDate", "placementSessionId", "order"] as const;

const estimate: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const fields = isRecord(body) ? body : {};
  const broken = Object.keys(fields)
    .filter((field) => !(E15_FIELDS as readonly string[]).includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  const scope = isRecord(fields.targetScope) && Array.isArray(fields.targetScope.sectionOrdinals) ? (fields.targetScope.sectionOrdinals as number[]) : null;
  if (typeof fields.editionId !== "string") broken.push({ field: "editionId", rule: "invalid_type" });
  if (scope === null) broken.push({ field: "targetScope", rule: "invalid_type" });
  if (!Array.isArray(fields.paths)) broken.push({ field: "paths", rule: "invalid_type" });
  if (typeof fields.sessionMinutes !== "number") broken.push({ field: "sessionMinutes", rule: "invalid_type" });
  if (broken.length > 0) return validation(broken);

  const edition = mockCatalog.editions.find((entry) => entry.editionId === fields.editionId);
  if (edition === undefined) return validation([{ field: "editionId", rule: "edition_not_available" }]);
  const rules = sharedRules(fields, edition.availablePaths, edition.contentFormat === "quran");
  if (scope !== null && (scope.length === 0 || !scope.every((ordinal) => edition.sections.some((section) => section.ordinal === ordinal)))) rules.push({ field: "targetScope", rule: "scope_invalid" });
  if (rules.length > 0) return validation(rules);

  const result = estimateOf(edition.editionId, scope ?? [], fields.paths as Path[], fields.sessionMinutes as 5 | 10 | 15);
  const date = fields.preferredDate;
  const reasonCode: EstimateReason = typeof date !== "string" ? "no_preferred_date" : result.endDate <= date ? "fits_preferred_date" : "exceeds_preferred_date";
  const answer: EstimateResponse = { estimate: result, alternatives: [], reasonCode };
  return { status: 200, body: answer };
};

// The plan in force of each mock session, so a second revision with the old version is refused like the server does.
const inForce = new WeakMap<MockScenario, Plan>();

function currentPlan(scenario: MockScenario): Plan {
  let plan = inForce.get(scenario);
  if (plan === undefined) {
    plan = basePlan;
    inForce.set(scenario, plan);
  }
  return plan;
}

const E17_FIELDS = ["expectedVersion", "sessionMinutes", "preferredDate", "paths", "order", "confirmedEstimate"] as const;
const CHANGE_FIELDS = ["sessionMinutes", "preferredDate", "paths", "order"] as const;

const revise: MockHandler = ({ body, params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const fields = isRecord(body) ? body : {};
  const broken = Object.keys(fields)
    .filter((field) => !(E17_FIELDS as readonly string[]).includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  if (!Number.isInteger(fields.expectedVersion) || (fields.expectedVersion as number) < 1) broken.push({ field: "expectedVersion", rule: "invalid_type" });
  if (broken.length > 0) return validation(broken);
  if (!CHANGE_FIELDS.some((field) => fields[field] !== undefined)) return validation([{ field: "body", rule: "no_fields" }]);

  const plan = currentPlan(scenario);
  const edition = mockCatalog.editions.find((entry) => entry.editionId === plan.editionId);
  const rules = sharedRules(fields, edition?.availablePaths ?? [], edition?.contentFormat === "quran");
  if (rules.length > 0) return validation(rules);

  const id = params?.id ?? "";
  if (id === MOCK_COMPLETED_PLAN_ID) return conflict("plan_not_active");
  if (id !== plan.planId) return failure(404, "not_found", "The plan was not found.");
  if (!scenario.hasPlan) return conflict("plan_not_active");
  if (fields.expectedVersion !== plan.currentVersion) return conflict("plan_version", { currentVersion: plan.currentVersion });

  const next: Plan = {
    ...plan,
    sessionMinutes: (fields.sessionMinutes as Plan["sessionMinutes"] | undefined) ?? plan.sessionMinutes,
    preferredDate: (fields.preferredDate as ISODate | undefined) ?? plan.preferredDate,
    paths: (fields.paths as Path[] | undefined) ?? plan.paths,
    order: (fields.order as PlanOrder | undefined) ?? plan.order,
    currentVersion: plan.currentVersion + 1,
  };
  const fresh = estimateOf(next.editionId, next.targetScope.sectionOrdinals, next.paths, next.sessionMinutes);
  if (fields.confirmedEstimate !== undefined) {
    if (!isRecord(fields.confirmedEstimate)) return validation([{ field: "confirmedEstimate", rule: "confirmed_estimate_invalid" }]);
    if (!sameEstimate(fresh, fields.confirmedEstimate)) return conflict("estimate_changed", { estimate: fresh });
    next.agreedEstimate = fresh;
  }
  inForce.set(scenario, next);
  return { status: 200, body: next };
};

const resume: MockHandler = ({ params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  if (scenario.isDemo) return failure(403, "forbidden", "This action is not available for a demo account.");
  const id = params?.id ?? "";
  if (id === MOCK_COMPLETED_PLAN_ID) return conflict("plan_not_active");
  if (id === MOCK_PLAN_ID) return { status: 200, body: currentPlan(scenario) };
  if (id !== MOCK_PAUSED_PLAN_ID) return failure(404, "not_found", "The plan was not found.");
  const resumed: Plan = { ...basePlan, planId: MOCK_PAUSED_PLAN_ID, currentVersion: 2, status: "active" };
  return { status: 200, body: resumed };
};

// Keys follow mock-fetch: ":id" matches one path segment, and the exact key of E15 wins over it.
export const planMockHandlers: Record<string, MockHandler> = {
  "POST /plans/estimate": estimate,
  "POST /plans/:id/revise": revise,
  "POST /plans/:id/resume": resume,
};
