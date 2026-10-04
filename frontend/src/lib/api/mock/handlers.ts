import type { HealthResponse } from "../types";
import { mockCatalog, mockProfile, mockToday, mockTodayWithoutPlan } from "./fixtures";

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

// Keys are "METHOD /path". E01, E11, E14 and E18; later packages add theirs.
export const mockHandlers: Readonly<Record<string, MockHandler>> = {
  "GET /health": () => {
    const body: HealthResponse = { status: "ok", version: "mock", time: new Date().toISOString() };
    return { status: 200, body };
  },
  "GET /me": (_request, scenario) => (scenario.signedIn ? { status: 200, body: mockProfile } : unauthenticated()),
  "GET /catalog": () => ({ status: 200, body: mockCatalog }),
  "GET /today": (_request, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    return { status: 200, body: scenario.hasPlan ? mockToday : mockTodayWithoutPlan };
  },
};
