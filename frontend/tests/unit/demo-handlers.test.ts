import { describe, expect, it } from "vitest";
import {
  createMockFetch,
  MOCK_DEMO_ACCOUNTS_PER_DAY,
  MOCK_DEMO_PLANS_PER_DAY,
  MOCK_DEMO_SCENARIOS,
  MOCK_DEMO_SIMULATIONS,
  MOCK_PASSWORD,
  MOCK_RECOVERY_CODE,
  MOCK_TERMS_VERSION,
  type MockScenario,
} from "@/lib/api/mock";
import type { Plan, Profile } from "@/lib/api/types";

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

function backend(scenario: Partial<MockScenario>) {
  const mock = createMockFetch({ latencyMs: 0, scenario });
  return async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await mock(`/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
}

const demoAccount = { signedIn: true, isDemo: true, hasPlan: false } as const;
const learner = { signedIn: true, isDemo: false } as const;
const visitor = { signedIn: false } as const;
const errorOf = (answer: Answer) => answer.body.error as { code: string; details: { fields?: { field: string; rule: string }[]; retryAfterSec?: number } };

const registration = (overrides: Record<string, unknown> = {}) => ({
  username: "demo_user_01",
  password: MOCK_PASSWORD,
  timeZone: "Asia/Dubai",
  language: "ar",
  termsAccepted: true,
  termsVersion: MOCK_TERMS_VERSION,
  ...overrides,
});

describe("E26 POST /demo/accounts", () => {
  it("creates a demo account: 201, the profile marks it a demo account, the recovery code comes once, the session now reads as demo", async () => {
    const call = backend(visitor);
    const answer = await call("POST", "/demo/accounts", registration());
    expect(answer.status).toBe(201);
    expect((answer.body.profile as Profile).isDemo).toBe(true);
    expect(answer.body.recoveryCode).toBe(MOCK_RECOVERY_CODE);
    expect(((await call("GET", "/me")).body as unknown as Profile).isDemo).toBe(true);
    expect((await call("GET", "/demo/scenarios")).status).toBe(200);
  });

  it("refuses `isDemo`, `mode` or any other field as forbidden_field, like the server", async () => {
    const call = backend(visitor);
    for (const field of ["isDemo", "mode", "userId"]) {
      const answer = await call("POST", "/demo/accounts", registration({ [field]: true }));
      expect(answer.status, field).toBe(422);
      expect(errorOf(answer).details.fields).toEqual([{ field, rule: "forbidden_field" }]);
    }
  });

  it("answers the failures of E03: terms, field rules, a taken name, the named outcomes", async () => {
    const call = backend(visitor);
    expect((await call("POST", "/demo/accounts", registration({ termsAccepted: false }))).status).toBe(400);
    expect(errorOf(await call("POST", "/demo/accounts", registration({ termsVersion: "1999-01-01" }))).code).toBe("terms_required");
    expect(errorOf(await call("POST", "/demo/accounts", registration({ username: "no" }))).code).toBe("validation_error");
    expect(errorOf(await call("POST", "/demo/accounts", registration({ password: "short" }))).details.fields).toEqual([{ field: "password", rule: "password_min_chars" }]);
    expect((await call("POST", "/demo/accounts", registration({ username: "taken_user_01" }))).status).toBe(409);
    expect(errorOf(await call("POST", "/demo/accounts", registration({ username: "throttled_user_01" }))).details.retryAfterSec).toBe(20);
    expect((await call("POST", "/demo/accounts", registration({ username: "unavailable_user_01" }))).status).toBe(503);
    expect((await call("POST", "/demo/accounts", registration({ username: "internal_user_01" }))).status).toBe(500);
    expect((await call("POST", "/demo/accounts", registration({ username: "origin_user_01" }))).status).toBe(403);
    await expect(call("POST", "/demo/accounts", registration({ username: "silent_user_01" }))).rejects.toBeInstanceOf(TypeError);
  });

  it("limits the day to five creations that succeeded: failures do not count, the sixth is a 429 with a wait", async () => {
    const call = backend(visitor);
    await call("POST", "/demo/accounts", registration({ username: "taken_user_01" }));
    for (let index = 0; index < MOCK_DEMO_ACCOUNTS_PER_DAY; index += 1) {
      expect((await call("POST", "/demo/accounts", registration({ username: `demo_user_${index + 10}` }))).status).toBe(201);
    }
    const sixth = await call("POST", "/demo/accounts", registration({ username: "demo_user_99" }));
    expect(sixth.status).toBe(429);
    expect(errorOf(sixth).code).toBe("throttled");
    expect(errorOf(sixth).details.retryAfterSec).toBe(3600);
  });
});

describe("E27 GET /demo/scenarios", () => {
  it("answers 401 to a visitor and 403 to an account that is not a demo account", async () => {
    expect((await backend(visitor)("GET", "/demo/scenarios")).status).toBe(401);
    const denied = await backend(learner)("GET", "/demo/scenarios");
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe("forbidden");
  });

  it("lists the scenarios with the five fields of the contract and never a goal text", async () => {
    const answer = await backend(demoAccount)("GET", "/demo/scenarios");
    expect(answer.status).toBe(200);
    const scenarios = answer.body.scenarios as Record<string, unknown>[];
    expect(scenarios.length).toBe(MOCK_DEMO_SCENARIOS.length);
    for (const scenario of scenarios) {
      expect(Object.keys(scenario).sort()).toEqual(["editionKey", "scenarioId", "targetScope", "titleAr", "titleEn"]);
      expect((scenario.targetScope as { sectionOrdinals: number[] }).sectionOrdinals.length).toBeGreaterThan(0);
    }
  });
});

describe("E28 POST /demo/plans", () => {
  it("answers 401 to a visitor and 403 to a learner", async () => {
    expect((await backend(visitor)("POST", "/demo/plans", { scenarioId: "scenario-01" })).status).toBe(401);
    expect((await backend(learner)("POST", "/demo/plans", { scenarioId: "scenario-01" })).status).toBe(403);
  });

  it("builds a plan from a scenario and says which planner built it", async () => {
    const call = backend(demoAccount);
    const rules = await call("POST", "/demo/plans", { scenarioId: "scenario-01" });
    expect(rules.status).toBe(201);
    expect((rules.body as unknown as Plan).planner).toEqual({ source: "rules" });
    expect((rules.body as unknown as Plan).status).toBe("active");
    const planner = await call("POST", "/demo/plans", { scenarioId: "scenario-02" });
    expect((planner.body as unknown as Plan).planner.source).toBe("teaching_agent");
    expect((await call("GET", "/today")).body.plan).not.toBeNull();
  });

  it("refuses any field but the scenario (forbidden_field), a missing id (invalid_type) and an unknown id (unknown_scenario)", async () => {
    const call = backend(demoAccount);
    for (const field of ["isDemo", "mode", "goalText", "correct"]) {
      const answer = await call("POST", "/demo/plans", { scenarioId: "scenario-01", [field]: "x" });
      expect(answer.status, field).toBe(422);
      expect(errorOf(answer).details.fields).toEqual([{ field, rule: "forbidden_field" }]);
    }
    expect(errorOf(await call("POST", "/demo/plans", {})).details.fields).toEqual([{ field: "scenarioId", rule: "invalid_type" }]);
    const unknown = await call("POST", "/demo/plans", { scenarioId: "scenario-99" });
    expect(unknown.status).toBe(422);
    expect(errorOf(unknown).details.fields).toEqual([{ field: "scenarioId", rule: "unknown_scenario" }]);
  });

  it("answers 404 to a placement session that is not the caller's", async () => {
    const answer = await backend(demoAccount)("POST", "/demo/plans", { scenarioId: "scenario-01", placementSessionId: "11111111-1111-4111-8111-111111111111" });
    expect(answer.status).toBe(404);
  });

  it("limits the day to ten plans: the eleventh is a 429 with a wait", async () => {
    const call = backend(demoAccount);
    for (let index = 0; index < MOCK_DEMO_PLANS_PER_DAY; index += 1) {
      expect((await call("POST", "/demo/plans", { scenarioId: "scenario-01" })).status).toBe(201);
    }
    const eleventh = await call("POST", "/demo/plans", { scenarioId: "scenario-01" });
    expect(eleventh.status).toBe(429);
    expect(errorOf(eleventh).details.retryAfterSec).toBe(3600);
  });
});

describe("E29 GET /demo/simulations", () => {
  it("answers 401 to a visitor and 403 to a learner", async () => {
    expect((await backend(visitor)("GET", "/demo/simulations")).status).toBe(401);
    expect((await backend(learner)("GET", "/demo/simulations")).status).toBe(403);
  });

  it("returns precomputed, labelled, synthetic simulations whose days add up", async () => {
    const answer = await backend(demoAccount)("GET", "/demo/simulations");
    expect(answer.status).toBe(200);
    const simulations = answer.body.simulations as typeof MOCK_DEMO_SIMULATIONS;
    expect(simulations.length).toBeGreaterThan(0);
    for (const simulation of simulations) {
      expect(simulation.label).toBe("precomputed_synthetic");
      expect(simulation.profile.name).toMatch(/^synthetic-/);
      let previous = 0;
      simulation.days.forEach((day, index) => {
        expect(day.day).toBe(index + 1);
        expect(day.confirmedWordsCumulative).toBeGreaterThanOrEqual(previous);
        expect(day.overallPercent).toBeLessThanOrEqual(100);
        if (day.lightReviewDay) expect(day.newWords).toBe(0);
        previous = day.confirmedWordsCumulative;
      });
    }
    expect(simulations.some((simulation) => simulation.days.some((day) => day.adjustment === "absence_light_review"))).toBe(true);
  });
});
