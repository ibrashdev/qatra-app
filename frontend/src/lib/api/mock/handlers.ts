import { passwordViolations, usernameViolations } from "@/lib/auth/account-rules";
import type { HealthResponse, LoginResponse, RegisterResponse } from "../types";
import { MOCK_LOGINS, MOCK_PASSWORD, MOCK_RECOVERY_CODE, MOCK_REGISTRATIONS, MOCK_TERMS_VERSION, mockCatalog, mockProfile, mockToday, mockTodayWithoutPlan } from "./fixtures";
import { planChatHandlers, type MockPlanChatStore } from "./plan-chat";
import { planMockHandlers } from "./plan-handlers";
import { sessionMockHandlers } from "./session-handlers";
import { todayMockHandlers } from "./today-handlers";

export interface MockRequest {
  method: string;
  path: string; // without the /api prefix, for example /health
  body: unknown;
  params?: Readonly<Record<string, string>>; // the values of ":name" segments of the handler key, for example /plan-chats/:id
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

export interface MockScenario {
  signedIn: boolean; // false: session routes answer 401 unauthenticated (G-03)
  hasPlan: boolean; // false: E18 returns plan null (G-24)
  isDemo?: boolean; // true: E11 answers a demo account (D71)
  planChats?: MockPlanChatStore; // the conversations of this mock session, created on first use (E31 to E34)
}

export type MockHandler = (request: MockRequest, scenario: MockScenario) => MockResponse;

export function errorResponse(status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse {
  return { status, body: { error: { code, message, details } } };
}

const unauthenticated = (): MockResponse => errorResponse(401, "unauthenticated", "Authentication is required.");

// E04 normalises the name like the server: NFKC, Latin letters lowercased, nothing else folded.
const normalizeUsername = (name: string): string => name.normalize("NFKC").toLowerCase();

function login({ body }: MockRequest, scenario: MockScenario): MockResponse {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const invalid = ["username", "password"].filter((field) => typeof fields[field] !== "string");
  if (invalid.length > 0) {
    return errorResponse(422, "validation_error", "The request body is not valid.", { fields: invalid.map((field) => ({ field, rule: "invalid_type" })) });
  }
  const outcome = MOCK_LOGINS.get(normalizeUsername(fields.username as string));
  switch (outcome) {
    case "throttled":
      return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: 20 });
    case "locked":
      return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: 900 });
    case "unavailable":
      return errorResponse(503, "unavailable", "The service is temporarily unavailable.");
    case "internal":
      return errorResponse(500, "internal", "Unexpected error.");
    case "origin":
      return errorResponse(403, "forbidden_origin", "The request origin is not allowed.");
    case "ok":
    case "ok_no_plan":
    case "reconsent": {
      if (fields.password !== MOCK_PASSWORD) break;
      scenario.signedIn = true;
      scenario.hasPlan = outcome !== "ok_no_plan";
      const answer: LoginResponse = { profile: mockProfile, reconsentRequired: outcome === "reconsent" };
      return { status: 200, body: answer };
    }
  }
  return errorResponse(401, "invalid_credentials", "The username or password is not correct.");
}

const REGISTER_FIELDS = ["username", "password", "timeZone", "language", "termsAccepted", "termsVersion"] as const;

function validationError(fields: { field: string; rule: string }[]): MockResponse {
  return errorResponse(422, "validation_error", "The request body is not valid.", { fields });
}

// E03 answers in the order of API-spec 4.2: schema, terms, field rules, then uniqueness. The names of MOCK_REGISTRATIONS stand in for the
// outcomes that depend on the server (a throttle, an outage, a taken name); the rules themselves are judged by the shared client rules.
function register({ body }: MockRequest, scenario: MockScenario): MockResponse {
  const fields: Record<string, unknown> = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const schema = REGISTER_FIELDS.flatMap((field) => {
    const type = field === "termsAccepted" ? "boolean" : "string";
    return typeof fields[field] === type ? [] : [{ field, rule: "invalid_type" }];
  });
  const unknown = Object.keys(fields).filter((field) => !(REGISTER_FIELDS as readonly string[]).includes(field));
  if (schema.length > 0 || unknown.length > 0) {
    return validationError([...schema, ...unknown.map((field) => ({ field, rule: "forbidden_field" }))]);
  }

  const username = fields.username as string;
  const outcome = MOCK_REGISTRATIONS.get(normalizeUsername(username));
  switch (outcome) {
    case "origin":
      return errorResponse(403, "forbidden_origin", "The request origin is not allowed.");
    case "throttled":
      return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: 20 });
    case "locked":
      return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: 900 });
    case "unavailable":
      return errorResponse(503, "unavailable", "The service is temporarily unavailable.");
    case "internal":
      return errorResponse(500, "internal", "Unexpected error.");
    case "silent":
      // No answer at all: the connection fails, as when a response is lost after the commit.
      throw new TypeError("The mock connection failed.");
  }

  const requiredVersion = outcome === "terms" ? "2099-01-01" : MOCK_TERMS_VERSION;
  if (fields.termsAccepted !== true || fields.termsVersion !== requiredVersion) {
    return errorResponse(400, "terms_required", "The current terms must be accepted.", { requiredVersion });
  }

  const broken = [
    ...usernameViolations(username).map((rule) => ({ field: "username", rule })),
    ...passwordViolations(fields.password as string).map((rule) => ({ field: "password", rule })),
    ...(fields.timeZone === "" ? [{ field: "timeZone", rule: "time_zone_invalid" }] : []),
    ...(fields.language === "ar" || fields.language === "en" ? [] : [{ field: "language", rule: "language_invalid" }]),
  ];
  if (broken.length > 0) return validationError(broken);

  if (outcome === "taken") return errorResponse(409, "username_taken", "The username is not available.");

  scenario.signedIn = true;
  scenario.hasPlan = false;
  const answer: RegisterResponse = {
    profile: { ...mockProfile, username: username.normalize("NFKC"), language: fields.language as "ar" | "en", timeZone: fields.timeZone as string },
    recoveryCode: MOCK_RECOVERY_CODE,
  };
  return { status: 201, body: answer };
}

// Keys are "METHOD /path"; a ":name" segment matches any one segment. E01, E03, E04, E11, E14, E18 and E31 to E34; later packages add theirs.
export const mockHandlers: Readonly<Record<string, MockHandler>> = {
  "GET /health": () => {
    const body: HealthResponse = { status: "ok", version: "mock", time: new Date().toISOString() };
    return { status: 200, body };
  },
  "POST /auth/register": register,
  "POST /auth/login": login,
  "GET /me": (_request, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    return { status: 200, body: scenario.isDemo ? { ...mockProfile, isDemo: true } : mockProfile };
  },
  ...planChatHandlers,
  ...todayMockHandlers, // E19 and E20 `daily` (S-11)
  ...planMockHandlers, // E15, E17 and E30 (S-12, S-13)
  ...sessionMockHandlers, // E20 daily snapshot, E21, E22 (S-19); after today's handlers so its POST /sessions wins
  "GET /catalog": () => ({ status: 200, body: mockCatalog }),
  "GET /today": (_request, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    return { status: 200, body: scenario.hasPlan ? mockToday : mockTodayWithoutPlan };
  },
};
