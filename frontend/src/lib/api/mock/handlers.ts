import type { HealthResponse, LoginResponse } from "../types";
import { MOCK_LOGINS, MOCK_PASSWORD, mockCatalog, mockProfile, mockToday, mockTodayWithoutPlan } from "./fixtures";

export interface MockRequest {
  method: string;
  path: string; // without the /api prefix, for example /health
  body: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

export interface MockScenario {
  signedIn: boolean; // false: session routes answer 401 unauthenticated (G-03)
  hasPlan: boolean; // false: E18 returns plan null (G-24)
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

// Keys are "METHOD /path". E01, E04, E11, E14 and E18; later packages add theirs.
export const mockHandlers: Readonly<Record<string, MockHandler>> = {
  "GET /health": () => {
    const body: HealthResponse = { status: "ok", version: "mock", time: new Date().toISOString() };
    return { status: 200, body };
  },
  "POST /auth/login": login,
  "GET /me": (_request, scenario) => (scenario.signedIn ? { status: 200, body: mockProfile } : unauthenticated()),
  "GET /catalog": () => ({ status: 200, body: mockCatalog }),
  "GET /today": (_request, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    return { status: 200, body: scenario.hasPlan ? mockToday : mockTodayWithoutPlan };
  },
};
