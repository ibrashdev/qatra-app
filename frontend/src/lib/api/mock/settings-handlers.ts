// Mock handlers for the settings screen S-22 (E12 PATCH /me, and the E11 read it changes). Synthetic data only.
// Registered by the coordinator over the shared set in mock-fetch.ts: { ...mockHandlers, ...accountMockHandlers, ...settingsMockHandlers, ...securityMockHandlers }.
// handlers.ts must not import this file. GET /me wraps the key of the account set, which is looked up when a request arrives, not when the module loads,
// so that a saved value is read back by the next E11. What a save changed is kept per mock instance (the scenario object), never across instances.
import type { Profile } from "../types";
import { accountMockHandlers } from "./account-handlers";
import { mockToday } from "./fixtures";
import { errorResponse, type MockHandler, type MockRequest, type MockResponse, type MockScenario } from "./handlers";

type Overrides = Pick<Profile, "language" | "timeZone" | "sessionMinutes" | "reminderSettings" | "pendingSettings">;

const overridesOf = new WeakMap<MockScenario, Overrides>();

const ALLOWED_FIELDS = ["language", "timeZone", "sessionMinutes", "reminderSettings"] as const;
const DAY_MS = 86_400_000;

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

const unauthenticated = (): MockResponse => errorResponse(401, "unauthenticated", "Authentication is required.");

function validationError(fields: { field: string; rule: string }[]): MockResponse {
  return errorResponse(422, "validation_error", "The request body is not valid.", { fields });
}

function isKnownTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The rules of API-spec 4.3 E12, in the order the contract lists them: an unknown property, no field at all, then each field's own rule.
function violations(fields: Record<string, unknown>): { field: string; rule: string }[] {
  const found: { field: string; rule: string }[] = Object.keys(fields)
    .filter((field) => !(ALLOWED_FIELDS as readonly string[]).includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  if (Object.keys(fields).length === 0) found.push({ field: "body", rule: "no_fields" });
  if ("language" in fields && fields.language !== "ar" && fields.language !== "en") found.push({ field: "language", rule: "language_invalid" });
  if ("timeZone" in fields && !isKnownTimeZone(fields.timeZone)) found.push({ field: "timeZone", rule: "time_zone_invalid" });
  if ("sessionMinutes" in fields && fields.sessionMinutes !== 5 && fields.sessionMinutes !== 10 && fields.sessionMinutes !== 15) {
    found.push({ field: "sessionMinutes", rule: "session_minutes_invalid" });
  }
  if ("reminderSettings" in fields) {
    const reminder = asRecord(fields.reminderSettings);
    const exact = Object.keys(reminder).length === 1 && typeof reminder.inApp === "boolean";
    if (!exact) found.push({ field: "reminderSettings", rule: "reminder_settings_invalid" });
  }
  return found;
}

// The profile the account set answers, with what a save changed laid over it. An answer that is not a profile (401) is returned as it is.
function currentProfile(request: MockRequest, scenario: MockScenario): { profile: Profile } | { response: MockResponse } {
  const base = accountMockHandlers["GET /me"];
  if (base === undefined) throw new Error("The account mock set has no handler for GET /me.");
  const answer = base(request, scenario);
  if (answer.status !== 200) return { response: answer };
  return { profile: { ...(answer.body as Profile), ...overridesOf.get(scenario) } };
}

// The next learning day: the mock learning date of E18, plus one day (the time zone in force does not change it here).
function nextLearningDate(): string {
  return new Date(Date.parse(`${mockToday.learningDate}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

// E12 answers in the order of API-spec 4.3: the session, the schema, then the effect. `language` and the reminder apply at once; minutes and zone become
// `pendingSettings` for the next learning day, and a value equal to the one in force takes that field's pending value away (D57).
const updateProfile: MockHandler = (request, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const fields = asRecord(request.body);
  const broken = violations(fields);
  if (broken.length > 0) return validationError(broken);

  const current = currentProfile(request, scenario);
  if ("response" in current) return current.response;
  const { profile } = current;

  const pending: { sessionMinutes?: Profile["sessionMinutes"]; timeZone?: string } = {
    ...(profile.pendingSettings?.sessionMinutes === undefined ? {} : { sessionMinutes: profile.pendingSettings.sessionMinutes }),
    ...(profile.pendingSettings?.timeZone === undefined ? {} : { timeZone: profile.pendingSettings.timeZone }),
  };
  if ("sessionMinutes" in fields) {
    if (fields.sessionMinutes === profile.sessionMinutes) delete pending.sessionMinutes;
    else pending.sessionMinutes = fields.sessionMinutes as Profile["sessionMinutes"];
  }
  if ("timeZone" in fields) {
    if (fields.timeZone === profile.timeZone) delete pending.timeZone;
    else pending.timeZone = fields.timeZone as string;
  }

  const next: Overrides = {
    language: "language" in fields ? (fields.language as Profile["language"]) : profile.language,
    timeZone: profile.timeZone,
    sessionMinutes: profile.sessionMinutes,
    reminderSettings: "reminderSettings" in fields ? { inApp: asRecord(fields.reminderSettings).inApp as boolean } : profile.reminderSettings,
    pendingSettings: Object.keys(pending).length === 0 ? null : { ...pending, effectiveDate: profile.pendingSettings?.effectiveDate ?? nextLearningDate() },
  };
  overridesOf.set(scenario, next);
  return { status: 200, body: { ...profile, ...next } };
};

const readProfile: MockHandler = (request, scenario) => {
  const current = currentProfile(request, scenario);
  return "response" in current ? current.response : { status: 200, body: current.profile };
};

// Keys are "METHOD /path", like mockHandlers. GET /me replaces the account set's key of the same name and calls it.
export const settingsMockHandlers: Readonly<Record<string, MockHandler>> = {
  "PATCH /me": updateProfile,
  "GET /me": readProfile,
};
