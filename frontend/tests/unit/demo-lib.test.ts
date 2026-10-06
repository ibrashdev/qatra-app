import { describe, expect, it, vi } from "vitest";
import { classifyDemoError, isTodayKind } from "@/components/demo/demo-failure";
import { correctRatePercent, readScenarios, readSimulations, scenarioTitle } from "@/components/demo/demo-model";
import { createApiClient } from "@/lib/api/client";
import { createDemoPlan, listDemoScenarios, listDemoSimulations, registerDemo } from "@/lib/api/demo-endpoints";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { holdRecoveryCode, nextScreen, peekRecoveryCode, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";

const envelopeError = (status: number, code: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) =>
  new ApiError({ status, code, message: "Safe text.", details, retryAfterSec });

describe("classifyDemoError", () => {
  it("maps the three demo-only failures", () => {
    expect(classifyDemoError(envelopeError(403, "forbidden"))).toEqual({ kind: "forbidden" });
    expect(classifyDemoError(envelopeError(422, "validation_error", { fields: [{ field: "scenarioId", rule: "unknown_scenario" }] }))).toEqual({ kind: "unknown_scenario" });
    expect(classifyDemoError(envelopeError(422, "validation_error", { reason: "unknown_scenario" }))).toEqual({ kind: "unknown_scenario" });
    expect(classifyDemoError(envelopeError(409, "version_conflict", { reason: "active_plan_conflict" }))).toEqual({ kind: "active_plan_conflict" });
  });

  it("falls back to the failures of S-11 for everything else", () => {
    expect(classifyDemoError(envelopeError(401, "unauthenticated"))).toEqual({ kind: "session_ended" });
    expect(classifyDemoError(envelopeError(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyDemoError(envelopeError(500, "internal"))).toEqual({ kind: "internal" });
    expect(classifyDemoError(envelopeError(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifyDemoError(envelopeError(429, "throttled", {}, 42))).toEqual({ kind: "throttled", retryAfterSec: 42 });
    expect(classifyDemoError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
    expect(classifyDemoError(Object.assign(new Error("x"), { name: "AbortError" }))).toEqual({ kind: "aborted" });
  });

  it("treats another validation rule and another conflict as internal, never as the vanished scenario or the lost race", () => {
    expect(classifyDemoError(envelopeError(422, "validation_error", { fields: [{ field: "x", rule: "forbidden_field" }] })).kind).toBe("internal");
    expect(classifyDemoError(envelopeError(409, "version_conflict", { reason: "something_else" })).kind).toBe("internal");
  });

  it("tells the generic kinds from the demo kinds", () => {
    expect(isTodayKind({ kind: "internal" })).toBe(true);
    expect(isTodayKind({ kind: "forbidden" })).toBe(false);
    expect(isTodayKind({ kind: "unknown_scenario" })).toBe(false);
    expect(isTodayKind({ kind: "active_plan_conflict" })).toBe(false);
  });
});

describe("readScenarios", () => {
  it("keeps well-formed rows and drops the others", () => {
    const rows = readScenarios({
      scenarios: [
        { scenarioId: "s1", titleAr: "ع", titleEn: "E", editionKey: "k", targetScope: { sectionOrdinals: [1, 2] } },
        { scenarioId: "", titleAr: "ع", titleEn: "E" },
        { scenarioId: "s3", titleAr: 3, titleEn: "E" },
        null,
        { scenarioId: "s4", titleAr: "ع", titleEn: "E", targetScope: { sectionOrdinals: [1, "x", -1, 3] } },
      ],
    });
    expect(rows.map((row) => row.scenarioId)).toEqual(["s1", "s4"]);
    expect(rows[1]?.targetScope.sectionOrdinals).toEqual([1, 3]);
    expect(rows[1]?.editionKey).toBe("");
  });

  it("reads anything that is not the documented shape as an empty list", () => {
    expect(readScenarios(null)).toEqual([]);
    expect(readScenarios({})).toEqual([]);
    expect(readScenarios({ scenarios: "no" })).toEqual([]);
  });

  it("picks the title of the interface language", () => {
    const row = { titleAr: "عربي", titleEn: "English" };
    expect(scenarioTitle("ar", row)).toBe("عربي");
    expect(scenarioTitle("en", row)).toBe("English");
  });
});

describe("readSimulations", () => {
  const day = { day: 1, newWords: 25, reviews: 0, lightReviewDay: false, adjustment: null, confirmedWordsCumulative: 25, overallPercent: 8 };

  it("keeps the rows, forces the precomputed label and drops malformed days", () => {
    const rows = readSimulations({
      simulations: [
        {
          simulationId: "sim-01",
          scenarioId: "scenario-04",
          titleAr: "ع",
          titleEn: "E",
          label: "live_run",
          profile: { name: "synthetic-a", totalWords: 300, sessionMinutes: 10 },
          learnerScript: { dailyCorrectRate: 0.8, absentDays: [5, 6], errorDays: [] },
          days: [day, { ...day, day: 2, adjustment: "absence_light_review", lightReviewDay: true }, { day: "x" }, { ...day, day: 3, adjustment: "invented" }],
        },
        { simulationId: "sim-02", titleAr: "ع", titleEn: "E" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("precomputed_synthetic");
    expect(rows[0]?.days.map((entry) => entry.day)).toEqual([1, 2, 3]);
    expect(rows[0]?.days[1]?.adjustment).toBe("absence_light_review");
    expect(rows[0]?.days[2]?.adjustment).toBeNull();
  });

  it("clamps the percent and fills missing profile fields", () => {
    const [row] = readSimulations({ simulations: [{ simulationId: "s", titleAr: "ع", titleEn: "E", days: [{ ...day, overallPercent: 250 }] }] });
    expect(row?.days[0]?.overallPercent).toBe(100);
    expect(row?.profile).toEqual({ name: "", totalWords: 0, sessionMinutes: 0 });
    expect(row?.learnerScript).toEqual({ dailyCorrectRate: 0, absentDays: [], errorDays: [] });
  });

  it("reads a rate written as a share or as a percent", () => {
    expect(correctRatePercent(0.8)).toBe(80);
    expect(correctRatePercent(1)).toBe(100);
    expect(correctRatePercent(75)).toBe(75);
    expect(correctRatePercent(500)).toBe(100);
  });
});

describe("the demo endpoints", () => {
  function clientWith(answer: () => Response | Promise<Response>) {
    const fetchImpl = vi.fn<typeof fetch>(async () => answer());
    const client = createApiClient({ fetch: fetchImpl, sleep: async () => undefined });
    return { client, fetchImpl };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const lastCall = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) => {
    const [url, init] = fetchImpl.mock.calls.at(-1) ?? [];
    return { url: String(url), method: init?.method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
  };

  it("E26 posts the body of E03 to /api/demo/accounts and adds nothing to it", async () => {
    const { client, fetchImpl } = clientWith(() => json({ profile: {}, recoveryCode: "x" }, 201));
    const request = { username: "demo_user_01", password: "a long synthetic passphrase", timeZone: "Asia/Dubai", language: "ar" as const, termsAccepted: true as const, termsVersion: "2026-10-04" };
    await registerDemo(client, request);
    const call = lastCall(fetchImpl);
    expect(call.url).toBe("/api/demo/accounts");
    expect(call.method).toBe("POST");
    expect(Object.keys(call.body ?? {}).sort()).toEqual(Object.keys(request).sort());
    expect(call.body).not.toHaveProperty("isDemo");
    expect(call.body).not.toHaveProperty("mode");
  });

  it("E27 and E29 are plain reads", async () => {
    const { client, fetchImpl } = clientWith(() => json({ scenarios: [], simulations: [] }));
    await listDemoScenarios(client);
    expect(lastCall(fetchImpl)).toMatchObject({ url: "/api/demo/scenarios", method: "GET" });
    await listDemoSimulations(client);
    expect(lastCall(fetchImpl)).toMatchObject({ url: "/api/demo/simulations", method: "GET" });
  });

  it("E28 sends the scenario id and nothing else", async () => {
    const { client, fetchImpl } = clientWith(() => json({ planId: "p" }, 201));
    await createDemoPlan(client, { scenarioId: "scenario-01" });
    const call = lastCall(fetchImpl);
    expect(call).toMatchObject({ url: "/api/demo/plans", method: "POST", body: { scenarioId: "scenario-01" } });
    expect(Object.keys(call.body ?? {})).toEqual(["scenarioId"]);
  });

  it("E26 and E28 are never retried by the client, whatever fails", async () => {
    const failing = clientWith(() => {
      throw new TypeError("network down");
    });
    await expect(createDemoPlan(failing.client, { scenarioId: "scenario-01" })).rejects.toBeInstanceOf(ConnectivityError);
    expect(failing.fetchImpl).toHaveBeenCalledTimes(1);
    const gateway = clientWith(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(
      registerDemo(gateway.client, { username: "u", password: "p", timeZone: "Asia/Dubai", language: "en", termsAccepted: true, termsVersion: "v" }),
    ).rejects.toBeInstanceOf(ConnectivityError);
    expect(gateway.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("the recovery hand-off of the demo host", () => {
  it("continues to S-29 after S-04 and holds the code like the other hosts", () => {
    expect(nextScreen("demo")).toBe("/demo/scenario");
    expect(nextScreen("register")).toBe("/start");
    holdRecoveryCode("0123-4567-89ab-cdef-0123-4567-89ab-cdef", "demo");
    expect(peekRecoveryCode()).toEqual({ code: "0123-4567-89ab-cdef-0123-4567-89ab-cdef", host: "demo" });
    wipeRecoveryCode();
    expect(peekRecoveryCode()).toBeNull();
  });
});
