// Mock handlers for E26 to E29, as the demo screens (S-28, S-29, S-30) use them. Synthetic data only: placeholder titles, fake ids, no source text
// and no real learner. Like the server, E27 to E29 answer 401 to a visitor and 403 to an account that is not a demo account, E28 refuses any
// field but the scenario, and nothing here ever reads `isDemo` or a mode from a request. Registered with one spread in handlers.ts.
import { passwordViolations, usernameViolations } from "@/lib/auth/account-rules";
import type { DemoScenario, DemoScenariosResponse, DemoSimulation, DemoSimulationDay, DemoSimulationsResponse, SimulationAdjustment } from "../demo-endpoints";
import type { Plan, RegisterResponse } from "../types";
import { MOCK_RECOVERY_CODE, MOCK_REGISTRATIONS, MOCK_TERMS_VERSION, mockProfile, mockToday } from "./fixtures";
import type { MockHandler, MockResponse, MockScenario } from "./handlers";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");
const notDemo = (): MockResponse => failure(403, "forbidden", "This operation is only for demo accounts.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => failure(422, "validation_error", "The request body is not valid.", { fields });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The limits of the server (API-spec 4.9), counted per mock session: five demo accounts per client and day (E26) and ten plans per account
// and day (E28). The wait is the largest the screens show (one hour).
export const MOCK_DEMO_ACCOUNTS_PER_DAY = 5;
export const MOCK_DEMO_PLANS_PER_DAY = 10;
const DAILY_RETRY_AFTER_SEC = 3600;

const created = new WeakMap<MockScenario, number>();
const built = new WeakMap<MockScenario, number>();
const bump = (counter: WeakMap<MockScenario, number>, scenario: MockScenario): number => {
  const next = (counter.get(scenario) ?? 0) + 1;
  counter.set(scenario, next);
  return next;
};

const normalizeUsername = (name: string): string => name.normalize("NFKC").toLowerCase();

const REGISTER_FIELDS = ["username", "password", "timeZone", "language", "termsAccepted", "termsVersion"] as const;

// E26 takes the body of E03 and answers in the same order: schema, terms, field rules, uniqueness. `isDemo` or `mode` in the body is a
// `forbidden_field`, so a client that sent one would fail here as it does on the server.
const registerDemo: MockHandler = ({ body }, scenario) => {
  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const schema = REGISTER_FIELDS.flatMap((field) => {
    const type = field === "termsAccepted" ? "boolean" : "string";
    return typeof fields[field] === type ? [] : [{ field, rule: "invalid_type" }];
  });
  const unknown = Object.keys(fields).filter((field) => !(REGISTER_FIELDS as readonly string[]).includes(field));
  if (schema.length > 0 || unknown.length > 0) return validation([...schema, ...unknown.map((field) => ({ field, rule: "forbidden_field" }))]);

  const username = fields.username as string;
  const outcome = MOCK_REGISTRATIONS.get(normalizeUsername(username));
  switch (outcome) {
    case "origin":
      return failure(403, "forbidden_origin", "The request origin is not allowed.");
    case "throttled":
      return failure(429, "throttled", "Too many attempts.", { retryAfterSec: 20 });
    case "locked":
      return failure(429, "throttled", "Too many attempts.", { retryAfterSec: 900 });
    case "unavailable":
      return failure(503, "unavailable", "The service is temporarily unavailable.");
    case "internal":
      return failure(500, "internal", "Unexpected error.");
    case "silent":
      throw new TypeError("The mock connection failed.");
  }

  const requiredVersion = outcome === "terms" ? "2099-01-01" : MOCK_TERMS_VERSION;
  if (fields.termsAccepted !== true || fields.termsVersion !== requiredVersion) return failure(400, "terms_required", "The current terms must be accepted.", { requiredVersion });

  const broken = [
    ...usernameViolations(username).map((rule) => ({ field: "username", rule })),
    ...passwordViolations(fields.password as string).map((rule) => ({ field: "password", rule })),
    ...(fields.timeZone === "" ? [{ field: "timeZone", rule: "time_zone_invalid" }] : []),
    ...(fields.language === "ar" || fields.language === "en" ? [] : [{ field: "language", rule: "language_invalid" }]),
  ];
  if (broken.length > 0) return validation(broken);
  if (outcome === "taken") return failure(409, "username_taken", "The username is not available.");

  // Only a creation that succeeds counts against the day.
  if ((created.get(scenario) ?? 0) >= MOCK_DEMO_ACCOUNTS_PER_DAY) return failure(429, "throttled", "Too many demo accounts today.", { retryAfterSec: DAILY_RETRY_AFTER_SEC });
  bump(created, scenario);

  scenario.signedIn = true;
  scenario.hasPlan = false;
  scenario.isDemo = true;
  const answer: RegisterResponse = {
    profile: { ...mockProfile, username: username.normalize("NFKC"), language: fields.language as "ar" | "en", timeZone: fields.timeZone as string, isDemo: true },
    recoveryCode: MOCK_RECOVERY_CODE,
  };
  return { status: 201, body: answer };
};

// The scenarios the server could resolve against the published catalog: generic titles for the synthetic cases of the QA plan (a vague goal, a
// near date, little time, a long absence, a large plan, one surah), never a title of a book or any text of one.
export const MOCK_DEMO_SCENARIOS: readonly DemoScenario[] = [
  { scenarioId: "scenario-01", titleAr: "هدف عام غير محدد", titleEn: "A general, vague goal", editionKey: "placeholder-quran-edition", targetScope: { sectionOrdinals: [1] } },
  { scenarioId: "scenario-02", titleAr: "موعد قريب جدًا", titleEn: "A very near date", editionKey: "placeholder-quran-edition", targetScope: { sectionOrdinals: [1, 2] } },
  { scenarioId: "scenario-03", titleAr: "وقت يومي قصير", titleEn: "Very little daily time", editionKey: "placeholder-quran-edition", targetScope: { sectionOrdinals: [1] } },
  { scenarioId: "scenario-04", titleAr: "غياب عدة أيام", titleEn: "An absence of several days", editionKey: "placeholder-quran-edition", targetScope: { sectionOrdinals: [1, 2] } },
  { scenarioId: "scenario-06", titleAr: "خطة كبيرة", titleEn: "A large plan", editionKey: "placeholder-quran-edition", targetScope: { sectionOrdinals: [1, 2] } },
  { scenarioId: "scenario-08", titleAr: "حديث واحد", titleEn: "One hadith", editionKey: "placeholder-hadith-edition", targetScope: { sectionOrdinals: [1] } },
];

// Which planner built each mock plan: the rules engine, or the constrained planner (the model leg that passed its checks).
const MOCK_PLANNERS: Readonly<Record<string, Plan["planner"]>> = {
  "scenario-02": { source: "teaching_agent", model: "synthetic-free-model" },
  "scenario-06": { source: "teaching_agent", model: "synthetic-free-model" },
};

const listScenarios: MockHandler = (_request, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  if (!scenario.isDemo) return notDemo();
  const answer: DemoScenariosResponse = { scenarios: [...MOCK_DEMO_SCENARIOS] };
  return { status: 200, body: answer };
};

const E28_FIELDS = ["scenarioId", "placementSessionId"] as const;

const createPlan: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  if (!scenario.isDemo) return notDemo();
  const fields = isRecord(body) ? body : {};
  const broken = Object.keys(fields)
    .filter((field) => !(E28_FIELDS as readonly string[]).includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  if (typeof fields.scenarioId !== "string") broken.push({ field: "scenarioId", rule: "invalid_type" });
  if (fields.placementSessionId !== undefined && typeof fields.placementSessionId !== "string") broken.push({ field: "placementSessionId", rule: "invalid_type" });
  if (broken.length > 0) return validation(broken);

  const chosen = MOCK_DEMO_SCENARIOS.find((entry) => entry.scenarioId === fields.scenarioId);
  if (chosen === undefined) return validation([{ field: "scenarioId", rule: "unknown_scenario" }]);
  // No placement session of this mock belongs to the caller.
  if (typeof fields.placementSessionId === "string") return failure(404, "not_found", "The placement session was not found.");
  if ((built.get(scenario) ?? 0) >= MOCK_DEMO_PLANS_PER_DAY) return failure(429, "throttled", "Too many plans today.", { retryAfterSec: DAILY_RETRY_AFTER_SEC });
  const count = bump(built, scenario);

  const base = mockToday.plan as Plan;
  const plan: Plan = {
    ...base,
    planId: `44444444-4444-4444-8444-${String(100 + count).padStart(12, "0")}`,
    titleAr: chosen.titleAr,
    titleEn: chosen.titleEn,
    targetScope: chosen.targetScope,
    status: "active",
    currentVersion: 1,
    planner: MOCK_PLANNERS[chosen.scenarioId] ?? { source: "rules" },
  };
  scenario.hasPlan = true;
  return { status: 201, body: plan };
};

// The days of a scripted learner, computed here with plain arithmetic so the mock needs no fixture file. `absent` days add nothing; the day after an
// absence is a light review with no new material; `errors` days hold the new words back and say so.
function simulate(options: { totalWords: number; perDay: number; days: number; absent: number[]; errors: number[] }): DemoSimulationDay[] {
  const rows: DemoSimulationDay[] = [];
  let confirmed = 0;
  let afterAbsence = false;
  for (let day = 1; day <= options.days; day += 1) {
    const absent = options.absent.includes(day);
    const light = afterAbsence && !absent;
    const hadErrors = options.errors.includes(day);
    const newWords = absent || light ? 0 : hadErrors ? Math.floor(options.perDay / 2) : Math.min(options.perDay, options.totalWords - confirmed);
    confirmed = Math.min(options.totalWords, confirmed + newWords);
    const adjustment: SimulationAdjustment | null = light ? "absence_light_review" : hadErrors ? "pace_reduced" : null;
    rows.push({
      day,
      newWords,
      reviews: day === 1 ? 0 : absent ? 0 : Math.min(8, day),
      lightReviewDay: light,
      adjustment,
      confirmedWordsCumulative: confirmed,
      overallPercent: Math.floor((100 * confirmed) / options.totalWords),
    });
    afterAbsence = absent;
  }
  return rows;
}

export const MOCK_DEMO_SIMULATIONS: readonly DemoSimulation[] = [
  {
    simulationId: "sim-01",
    scenarioId: "scenario-04",
    titleAr: "غياب ثلاثة أيام ثم عودة",
    titleEn: "A three-day absence, then a return",
    label: "precomputed_synthetic",
    profile: { name: "synthetic-profile-a", totalWords: 300, sessionMinutes: 10 },
    learnerScript: { dailyCorrectRate: 0.8, absentDays: [5, 6, 7], errorDays: [] },
    days: simulate({ totalWords: 300, perDay: 25, days: 10, absent: [5, 6, 7], errors: [] }),
  },
  {
    simulationId: "sim-02",
    scenarioId: "scenario-06",
    titleAr: "أخطاء متكررة في الأسبوع الأول",
    titleEn: "Repeated mistakes in the first week",
    label: "precomputed_synthetic",
    profile: { name: "synthetic-profile-b", totalWords: 400, sessionMinutes: 15 },
    learnerScript: { dailyCorrectRate: 0.6, absentDays: [], errorDays: [3, 4] },
    days: simulate({ totalWords: 400, perDay: 40, days: 8, absent: [], errors: [3, 4] }),
  },
];

const listSimulations: MockHandler = (_request, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  if (!scenario.isDemo) return notDemo();
  const answer: DemoSimulationsResponse = { simulations: [...MOCK_DEMO_SIMULATIONS] };
  return { status: 200, body: answer };
};

export const demoMockHandlers: Readonly<Record<string, MockHandler>> = {
  "POST /demo/accounts": registerDemo,
  "GET /demo/scenarios": listScenarios,
  "POST /demo/plans": createPlan,
  "GET /demo/simulations": listSimulations,
};
