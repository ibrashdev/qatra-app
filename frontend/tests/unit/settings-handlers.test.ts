import { describe, expect, it } from "vitest";
import { createMockFetch, mockProfile, MOCK_OLD_TERMS_VERSION } from "@/lib/api/mock";
import { MOCK_PASSWORD } from "@/lib/api/mock/fixtures";
import type { MockScenario } from "@/lib/api/mock";
import type { Profile } from "@/lib/api/types";

function makeMock(scenario: Partial<MockScenario> = {}) {
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await mock(`/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  return {
    patch: (body: unknown) => call("PATCH", "/me", body),
    me: async () => (await call("GET", "/me")).body as unknown as Profile,
    call,
  };
}

const rulesOf = (body: Record<string, unknown> | undefined): { field: string; rule: string }[] =>
  ((body?.error as { details: { fields: { field: string; rule: string }[] } }).details.fields ?? []);

describe("settings mock: E12 PATCH /me", () => {
  it("answers 401 unauthenticated without a session", async () => {
    const answer = await makeMock({ signedIn: false }).patch({ language: "en" });
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("rejects a body with no field, with the rule no_fields", async () => {
    const answer = await makeMock().patch({});
    expect(answer.status).toBe(422);
    expect(rulesOf(answer.body)).toEqual([{ field: "body", rule: "no_fields" }]);
  });

  it("rejects any property outside the four, including username, isDemo and termsVersion", async () => {
    for (const field of ["username", "isDemo", "termsVersion", "unknown"]) {
      const answer = await makeMock().patch({ [field]: "x", language: "en" });
      expect(answer.status).toBe(422);
      expect(rulesOf(answer.body)).toEqual([{ field, rule: "forbidden_field" }]);
    }
  });

  it("applies the rule of each field", async () => {
    const mock = makeMock();
    expect(rulesOf((await mock.patch({ language: "fr" })).body)).toEqual([{ field: "language", rule: "language_invalid" }]);
    expect(rulesOf((await mock.patch({ timeZone: "Not/AZone" })).body)).toEqual([{ field: "timeZone", rule: "time_zone_invalid" }]);
    expect(rulesOf((await mock.patch({ timeZone: 4 })).body)).toEqual([{ field: "timeZone", rule: "time_zone_invalid" }]);
    expect(rulesOf((await mock.patch({ sessionMinutes: 7 })).body)).toEqual([{ field: "sessionMinutes", rule: "session_minutes_invalid" }]);
    expect(rulesOf((await mock.patch({ reminderSettings: { inApp: "yes" } })).body)).toEqual([{ field: "reminderSettings", rule: "reminder_settings_invalid" }]);
    expect(rulesOf((await mock.patch({ reminderSettings: { inApp: true, push: true } })).body)).toEqual([{ field: "reminderSettings", rule: "reminder_settings_invalid" }]);
    expect(rulesOf((await mock.patch({ reminderSettings: {} })).body)).toEqual([{ field: "reminderSettings", rule: "reminder_settings_invalid" }]);
  });

  it("changes nothing when the body is rejected", async () => {
    const mock = makeMock();
    await mock.patch({ language: "fr", sessionMinutes: 15 });
    expect(await mock.me()).toEqual(mockProfile);
  });

  it("applies the language and the reminder at once, and leaves pendingSettings alone", async () => {
    const mock = makeMock();
    const answer = await mock.patch({ language: "en", reminderSettings: { inApp: false } });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ language: "en", reminderSettings: { inApp: false }, pendingSettings: null, sessionMinutes: 10, timeZone: "Asia/Dubai" });
  });

  it("records minutes and zone as pending for the next learning day and keeps the values in force (D57)", async () => {
    const mock = makeMock();
    const answer = await mock.patch({ sessionMinutes: 15, timeZone: "Asia/Riyadh" });
    expect(answer.body).toMatchObject({
      sessionMinutes: 10,
      timeZone: "Asia/Dubai",
      pendingSettings: { sessionMinutes: 15, timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" },
    });
  });

  it("keeps the other pending field, replaces the same field, and drops a field put back to the value in force", async () => {
    const mock = makeMock();
    await mock.patch({ sessionMinutes: 15 });
    expect((await mock.patch({ timeZone: "Asia/Riyadh" })).body).toMatchObject({ pendingSettings: { sessionMinutes: 15, timeZone: "Asia/Riyadh" } });
    expect((await mock.patch({ sessionMinutes: 5 })).body).toMatchObject({ pendingSettings: { sessionMinutes: 5, timeZone: "Asia/Riyadh" } });
    expect((await mock.patch({ sessionMinutes: 10 })).body).toMatchObject({ pendingSettings: { timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" } });
    const last = await mock.patch({ timeZone: "Asia/Dubai" });
    expect(last.body).toMatchObject({ pendingSettings: null });
  });

  it("serves a demo account like any other (D71) and keeps isDemo read-only", async () => {
    const mock = makeMock({ isDemo: true });
    const answer = await mock.patch({ language: "en" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ isDemo: true, language: "en" });
  });
});

describe("settings mock: E11 GET /me reads back what was saved", () => {
  it("answers the base profile until something is saved", async () => {
    expect(await makeMock().me()).toEqual(mockProfile);
  });

  it("returns the saved values and the pending settings", async () => {
    const mock = makeMock();
    await mock.patch({ language: "en", sessionMinutes: 5, reminderSettings: { inApp: false } });
    expect(await mock.me()).toEqual({
      ...mockProfile,
      language: "en",
      reminderSettings: { inApp: false },
      pendingSettings: { sessionMinutes: 5, effectiveDate: "2026-10-06" },
    });
  });

  it("is kept per mock instance: a save in one is not seen by another", async () => {
    const first = makeMock();
    const second = makeMock();
    await first.patch({ language: "en" });
    expect((await first.me()).language).toBe("en");
    expect(await second.me()).toEqual(mockProfile);
  });

  it("keeps the answers of the account set: 401 without a session, the demo flag, and the old terms version after a login that asks for consent", async () => {
    expect((await makeMock({ signedIn: false }).call("GET", "/me")).status).toBe(401);
    expect((await makeMock({ isDemo: true }).me()).isDemo).toBe(true);

    const mock = makeMock({ signedIn: false });
    const login = await mock.call("POST", "/auth/login", { username: "reconsent_user_01", password: MOCK_PASSWORD });
    expect(login.status).toBe(200);
    expect((await mock.me()).termsVersion).toBe(MOCK_OLD_TERMS_VERSION);
  });
});
