import { describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { estimatePlan, resumePlan, revisePlan } from "@/lib/api/plan-endpoints";
import { MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockHandlers, mockToday } from "@/lib/api/mock";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_COMPLETED_PLAN_ID, MOCK_PAUSED_PLAN_ID, planMockHandlers } from "@/lib/api/mock/plan-handlers";
import { todayMockHandlers } from "@/lib/api/mock/today-handlers";
import type { MockScenario } from "@/lib/api/mock";
import type { Plan } from "@/lib/api/types";

const plan = mockToday.plan as Plan;

function clientFor(scenario: Partial<MockScenario> = {}) {
  const fetchImpl = createMockFetch({ latencyMs: 0, handlers: { ...mockHandlers, ...todayMockHandlers, ...planMockHandlers }, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  return createApiClient({ fetch: fetchImpl });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The call was expected to fail.");
}

const base = { editionId: MOCK_QURAN_EDITION_ID, targetScope: { sectionOrdinals: [1, 2] }, paths: ["quran" as const], sessionMinutes: 10 as const };
const rulesOf = (error: ApiError): string[] => (error.details.fields as { rule: string }[]).map((field) => field.rule);

describe("E15 mock (POST /plans/estimate)", () => {
  it("answers with the capacity of the minutes and the review buffer of API-spec 4.5", async () => {
    const answer = await estimatePlan(clientFor(), base);
    expect(answer.estimate).toMatchObject({ newWordsPerDay: 25, totalWords: 100, days: 5, sessionMinutes: 10, knownWords: 0 });
    // D92: the pace stays in words; the learner-facing amount is whole ayat (20 synthetic ayat over 5 days)
    expect(answer.estimate.dailyNew).toEqual({ unit: "ayah", perDay: 4, everyDays: null });
    expect(answer.alternatives).toEqual([]);
    expect(answer.reasonCode).toBe("no_preferred_date");
    expect((await estimatePlan(clientFor(), { ...base, sessionMinutes: 5 })).estimate.newWordsPerDay).toBe(12);
    expect((await estimatePlan(clientFor(), { ...base, sessionMinutes: 15 })).estimate.newWordsPerDay).toBe(40);
  });

  it("says whether the estimate fits the preferred date", async () => {
    expect((await estimatePlan(clientFor(), { ...base, preferredDate: "2026-10-20" })).reasonCode).toBe("fits_preferred_date");
    expect((await estimatePlan(clientFor(), { ...base, preferredDate: "2026-10-05" })).reasonCode).toBe("exceeds_preferred_date");
  });

  it("applies the shared plan rules", async () => {
    expect(rulesOf(await failure(estimatePlan(clientFor(), { ...base, preferredDate: "2026-10-01" })))).toEqual(["date_invalid"]);
    expect(rulesOf(await failure(estimatePlan(clientFor(), { ...base, order: "reverse", editionId: "11111111-1111-4111-8111-0000000000e2", paths: ["matn"], targetScope: { sectionOrdinals: [1] } })))).toEqual(["order_not_available"]);
    expect(rulesOf(await failure(estimatePlan(clientFor(), { ...base, paths: ["matn"] })))).toEqual(["paths_invalid"]);
    expect(rulesOf(await failure(estimatePlan(clientFor(), { ...base, targetScope: { sectionOrdinals: [9] } })))).toEqual(["scope_invalid"]);
    expect((await failure(estimatePlan(clientFor(), { ...base, editionId: "00000000-0000-4000-8000-000000000000" }))).details.fields).toEqual([{ field: "editionId", rule: "edition_not_available" }]);
  });

  it("needs a session", async () => {
    expect((await failure(estimatePlan(clientFor({ signedIn: false }), base))).code).toBe("unauthenticated");
  });
});

describe("E17 mock (POST /plans/:id/revise)", () => {
  it("applies the changed fields, appends a version and replaces the agreed estimate when the confirmed one matches", async () => {
    const client = clientFor();
    const fresh = (await estimatePlan(client, { ...base, sessionMinutes: 15 })).estimate;
    const next = await revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1, sessionMinutes: 15, confirmedEstimate: fresh });
    expect(next).toMatchObject({ currentVersion: 2, sessionMinutes: 15, status: "active", agreedEstimate: fresh });
  });

  it("refuses a second revision with the old version as `plan_version` with the current one", async () => {
    const client = clientFor();
    await revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1, sessionMinutes: 5 });
    const error = await failure(revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1, sessionMinutes: 15 }));
    expect(error.details).toMatchObject({ reason: "plan_version", currentVersion: 2 });
  });

  it("answers `estimate_changed` with the fresh estimate when the confirmed one differs", async () => {
    const client = clientFor();
    const stale = (await estimatePlan(client, base)).estimate;
    const error = await failure(revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1, sessionMinutes: 15, confirmedEstimate: stale }));
    expect(error.details.reason).toBe("estimate_changed");
    expect(error.details.estimate).toMatchObject({ sessionMinutes: 15, newWordsPerDay: 40 });
  });

  it("needs at least one field and knows the field rules", async () => {
    const client = clientFor();
    expect(rulesOf(await failure(revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1 })))).toEqual(["no_fields"]);
    expect(rulesOf(await failure(revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1, preferredDate: "2026-10-01" })))).toEqual(["date_invalid"]);
    expect(rulesOf(await failure(revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 1, paths: ["matn"] })))).toEqual(["paths_invalid"]);
    expect(rulesOf(await failure(revisePlan(client, MOCK_PLAN_ID, { expectedVersion: 0, sessionMinutes: 5 })))).toEqual(["invalid_type"]);
  });

  it("refuses a completed plan, an unknown plan and a request with an unknown field", async () => {
    const client = clientFor();
    expect((await failure(revisePlan(client, MOCK_COMPLETED_PLAN_ID, { expectedVersion: 3, sessionMinutes: 5 }))).details.reason).toBe("plan_not_active");
    expect((await failure(revisePlan(client, "44444444-4444-4444-8444-0000000000ff", { expectedVersion: 1, sessionMinutes: 5 }))).code).toBe("not_found");
    const odd = { expectedVersion: 1, sessionMinutes: 5, scope: [1] } as unknown as Parameters<typeof revisePlan>[2];
    expect(rulesOf(await failure(revisePlan(client, MOCK_PLAN_ID, odd)))).toEqual(["forbidden_field"]);
  });
});

describe("E30 mock (POST /plans/:id/resume)", () => {
  it("resumes the paused plan, leaves its version and returns it active", async () => {
    const resumed = await resumePlan(clientFor(), MOCK_PAUSED_PLAN_ID);
    expect(resumed).toMatchObject({ planId: MOCK_PAUSED_PLAN_ID, status: "active", currentVersion: 2 });
  });

  it("returns the active plan unchanged", async () => {
    expect((await resumePlan(clientFor(), MOCK_PLAN_ID)).planId).toBe(plan.planId);
  });

  it("answers 403 to a demo account, 409 to a completed plan and 404 to an unknown one", async () => {
    expect((await failure(resumePlan(clientFor({ isDemo: true }), MOCK_PAUSED_PLAN_ID))).code).toBe("forbidden");
    expect((await failure(resumePlan(clientFor(), MOCK_COMPLETED_PLAN_ID))).details.reason).toBe("plan_not_active");
    expect((await failure(resumePlan(clientFor(), "44444444-4444-4444-8444-0000000000ff"))).code).toBe("not_found");
    expect((await failure(resumePlan(clientFor({ signedIn: false }), MOCK_PAUSED_PLAN_ID))).code).toBe("unauthenticated");
  });
});
