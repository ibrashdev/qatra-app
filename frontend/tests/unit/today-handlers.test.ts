import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { MOCK_PLAN_ID, mockToday } from "@/lib/api/mock/fixtures";
import { mockHandlers, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_SESSION_ID, mockProgress, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { dailySessionBody, getProgress, startDailySession } from "@/lib/api/today-endpoints";

function setup(scenario: Partial<MockScenario> = {}) {
  const fetchImpl = vi.fn(createMockFetch({ latencyMs: 0, handlers: { ...mockHandlers, ...todayMockHandlers }, scenario }));
  const client = createApiClient({ fetch: fetchImpl });
  return { client, fetchImpl };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The call was expected to fail.");
}

describe("E19 GET /api/progress (todayMockHandlers)", () => {
  it("returns the synthetic ProgressResponse of the active plan, whose sections carry E18's current stage", async () => {
    const progress = await getProgress(setup().client);
    expect(progress).toEqual(mockProgress);
    const plan = progress.plans[0];
    if (plan === undefined) throw new Error("The mock progress has no plan.");
    expect(plan.planId).toBe(MOCK_PLAN_ID);
    expect(plan.currentVersion).toBe(mockToday.plan?.currentVersion);
    expect(plan.sections.map((section) => section.titleAr)).toContain(mockToday.nextNewPassage?.sectionTitleAr);
    expect(progress.daily.dailyPercent).toBe(mockToday.dailyPercent);
  });

  it("lists no plan for an account without one, and answers 401 for a visitor", async () => {
    const empty = await getProgress(setup({ hasPlan: false }).client);
    expect(empty.plans).toEqual([]);
    expect(empty.daily.dailyPercent).toBe(0);
    const error = await failureOf(getProgress(setup({ signedIn: false }).client));
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthenticated");
  });

  it("is a plain GET without a body", async () => {
    const { client, fetchImpl } = setup();
    await getProgress(client);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/progress");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });
});

describe("E20 POST /api/sessions kind daily (todayMockHandlers)", () => {
  const request = { planId: MOCK_PLAN_ID, planVersion: 1 };

  it("sends exactly the three properties of API-spec 4.7", async () => {
    expect(dailySessionBody(request)).toEqual({ kind: "daily", planId: MOCK_PLAN_ID, expectedPlanVersion: 1 });
    const { client, fetchImpl } = setup();
    await startDailySession(client, request);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/sessions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ kind: "daily", planId: MOCK_PLAN_ID, expectedPlanVersion: 1 });
  });

  it("answers a snapshot of an open daily session", async () => {
    const snapshot = await startDailySession(setup().client, request);
    expect(snapshot).toMatchObject({ sessionId: MOCK_SESSION_ID, kind: "daily", planId: MOCK_PLAN_ID, planVersion: 1, status: "open" });
    expect(Array.isArray(snapshot.steps)).toBe(true);
  });

  it("answers 409 version_conflict with reason plan_version and currentVersion for a stale version", async () => {
    const error = await failureOf(startDailySession(setup().client, { ...request, planVersion: 7 }));
    expect([error.status, error.code]).toEqual([409, "version_conflict"]);
    expect(error.details).toEqual({ reason: "plan_version", currentVersion: 1 });
  });

  it("answers 409 plan_not_active when the account has no active plan, and 404 for another plan", async () => {
    const inactive = await failureOf(startDailySession(setup({ hasPlan: false }).client, request));
    expect([inactive.status, inactive.details.reason]).toEqual([409, "plan_not_active"]);
    const unknown = await failureOf(startDailySession(setup().client, { planId: "99999999-9999-4999-8999-999999999999", planVersion: 1 }));
    expect([unknown.status, unknown.code]).toEqual([404, "not_found"]);
  });

  it("answers 422 for another kind or an extra field, and 401 for a visitor", async () => {
    const { client } = setup();
    const kind = await failureOf(client.post("/sessions", { kind: "game", planId: MOCK_PLAN_ID, expectedPlanVersion: 1 }));
    expect([kind.status, kind.code]).toEqual([422, "validation_error"]);
    const extra = await failureOf(client.post("/sessions", { kind: "daily", planId: MOCK_PLAN_ID, expectedPlanVersion: 1, gameType: "word_order" }));
    expect(extra.details.fields).toEqual([{ field: "gameType", rule: "forbidden_field" }]);
    const visitor = await failureOf(startDailySession(setup({ signedIn: false }).client, request));
    expect(visitor.status).toBe(401);
  });
});
