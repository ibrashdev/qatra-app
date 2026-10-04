import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { createEndpoints } from "@/lib/api/endpoints";
import { ApiError, ConnectivityError, isSessionEnded } from "@/lib/api/errors";
import { createMockFetch, MOCK_LOGINS, MOCK_PASSWORD, mockCatalog, mockProfile, mockToday, mockTodayWithoutPlan } from "@/lib/api/mock";
import { createApiRuntime } from "@/lib/api/runtime";
import type { CatalogEdition, Profile, Today } from "@/lib/api/types";
import { resolveApiMode } from "@/lib/config";

function mockApi(options: Parameters<typeof createMockFetch>[0] = { latencyMs: 0 }) {
  const client = createApiClient({ fetch: createMockFetch({ latencyMs: 0, ...options }) });
  return { client, api: createEndpoints(client) };
}

describe("mock layer: handlers for E01, E11, E14 and E18", () => {
  it("E01 GET /api/health", async () => {
    const health = await mockApi().api.health();
    expect(health.status).toBe("ok");
    expect(typeof health.version).toBe("string");
    expect(Number.isNaN(Date.parse(health.time))).toBe(false);
  });

  it("E11 GET /api/me returns a synthetic Profile", async () => {
    const profile: Profile = await mockApi().api.me();
    expect(profile).toEqual(mockProfile);
    expect(profile.username).toBe("sample_user_01");
    expect(profile.isDemo).toBe(false);
  });

  it("E14 GET /api/catalog returns synthetic editions with the contract shape", async () => {
    const { editions } = await mockApi().api.catalog();
    expect(editions).toHaveLength(2);
    for (const edition of editions as CatalogEdition[]) {
      expect(edition.defaultOrder).toBe("book");
      expect(edition.sections.length).toBeGreaterThan(0);
      expect(edition.totalWords).toBe(edition.sections.reduce((sum, section) => sum + section.wordCount, 0));
    }
    // The reverse order is offered for the Quran edition only (D72): the data says which edition that is.
    expect(editions.filter((edition) => edition.contentFormat === "quran")).toHaveLength(1);
  });

  it("E18 GET /api/today returns the day with a plan, or the no-plan state (G-24)", async () => {
    const withPlan: Today = await mockApi().api.today();
    expect(withPlan).toEqual(mockToday);
    expect(withPlan.plan).not.toBeNull();
    expect(withPlan.dailyPercent).toBeLessThanOrEqual(100);

    const withoutPlan = await mockApi({ latencyMs: 0, scenario: { hasPlan: false } }).api.today();
    expect(withoutPlan).toEqual(mockTodayWithoutPlan);
    expect(withoutPlan.plan).toBeNull();
  });

  it("answers session operations with 401 unauthenticated when signed out (G-03)", async () => {
    const { api } = mockApi({ latencyMs: 0, scenario: { signedIn: false } });
    for (const call of [api.me(), api.today()]) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(isSessionEnded(error)).toBe(true);
    }
    await expect(api.catalog()).resolves.toBeDefined();
  });

  it("answers an operation it does not mock with the error envelope, not a platform page", async () => {
    const error = (await mockApi().client.get("/plans").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("not_found");
  });

  it("only serves /api/*", async () => {
    await expect(createMockFetch({ latencyMs: 0 })("/somewhere")).rejects.toBeInstanceOf(TypeError);
  });

  it("behaves like a sleeping free server during the cold start window: 503 outside the envelope", async () => {
    let now = 1_000;
    const { client } = mockApi({ latencyMs: 0, coldStartMs: 5_000, now: () => now });
    const asleep = await client.get("/health").catch((e: unknown) => e);
    expect(asleep).toBeInstanceOf(ConnectivityError);
    expect((asleep as ConnectivityError).reason).toBe("gateway");
    now += 5_000;
    await expect(client.get("/health")).resolves.toMatchObject({ status: "ok" });
  });

  it("honours abort during the simulated latency", async () => {
    const controller = new AbortController();
    const result = mockApi({ latencyMs: 1_000 }).api.me({ signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(((await result) as Error).name).toBe("AbortError");
  });
});

describe("mock layer: E04 POST /api/auth/login with synthetic accounts", () => {
  const login = (api: ReturnType<typeof mockApi>["api"], username: string, password = MOCK_PASSWORD) => api.login({ username, password });
  const failure = async (promise: Promise<unknown>) => (await promise.catch((e: unknown) => e)) as ApiError;

  it("answers 200 with a profile and the consent flag, and signs the mock in", async () => {
    const { api } = mockApi({ latencyMs: 0, scenario: { signedIn: false } });
    expect(isSessionEnded(await failure(api.me()))).toBe(true);
    await expect(login(api, "sample_user_01")).resolves.toEqual({ profile: mockProfile, reconsentRequired: false });
    await expect(api.me()).resolves.toEqual(mockProfile);
    await expect(api.today()).resolves.toEqual(mockToday);
  });

  it("normalises the name like the server: NFKC, Latin letters lowercased", async () => {
    const { api } = mockApi({ latencyMs: 0, scenario: { signedIn: false } });
    await expect(login(api, "Sample_User_01")).resolves.toMatchObject({ reconsentRequired: false });
  });

  it("asks for consent with reconsentRequired, and leaves an account without a plan with an empty E18", async () => {
    const { api } = mockApi({ latencyMs: 0, scenario: { signedIn: false } });
    await expect(login(api, "reconsent_user_01")).resolves.toMatchObject({ reconsentRequired: true });
    await expect(login(api, "new_user_01")).resolves.toMatchObject({ reconsentRequired: false });
    expect((await api.today()).plan).toBeNull();
  });

  it("answers invalid_credentials for a wrong password and for an unknown name alike, and stays signed out", async () => {
    const { api } = mockApi({ latencyMs: 0, scenario: { signedIn: false } });
    for (const call of [login(api, "sample_user_01", "not the passphrase"), login(api, "nobody_here_01")]) {
      const error = await failure(call);
      expect(error).toBeInstanceOf(ApiError);
      expect([error.status, error.code]).toEqual([401, "invalid_credentials"]);
    }
    expect(isSessionEnded(await failure(api.me()))).toBe(true);
  });

  it.each([
    ["throttled_user_01", 429, "throttled", 20],
    ["locked_user_01", 429, "throttled", 900],
    ["unavailable_user_01", 503, "unavailable", null],
    ["internal_user_01", 500, "internal", null],
    ["origin_user_01", 403, "forbidden_origin", null],
  ] as const)("%s answers %i %s whatever the password is", async (username, status, code, retryAfterSec) => {
    const { api } = mockApi({ latencyMs: 0, scenario: { signedIn: false } });
    const error = await failure(login(api, username, "anything"));
    expect([error.status, error.code, error.retryAfterSec]).toEqual([status, code, retryAfterSec]);
    expect(isSessionEnded(await failure(api.me()))).toBe(true);
  });

  it("rejects a body whose fields are not strings with validation_error", async () => {
    const { client } = mockApi({ latencyMs: 0 });
    const error = await failure(client.post("/auth/login", { username: 1 }));
    expect([error.status, error.code]).toEqual([422, "validation_error"]);
    expect(error.details).toEqual({
      fields: [
        { field: "username", rule: "invalid_type" },
        { field: "password", rule: "invalid_type" },
      ],
    });
  });

  it("names every synthetic account as such and shares no real secret", () => {
    for (const name of MOCK_LOGINS.keys()) expect(name).toMatch(/^[a-z]+(_[a-z]+)*_01$/);
    expect(MOCK_PASSWORD).toBe("synthetic passphrase for docs only");
  });
});

describe("mock data is synthetic", () => {
  const serialized = JSON.stringify({ mockProfile, mockCatalog, mockToday });

  it("holds placeholders only: no source text, only fake ids and example names", () => {
    expect(serialized).toContain("(عنصر نائب)");
    expect(serialized).toContain("(placeholder)");
    expect(serialized).not.toMatch(/ۡ|ۥ|ۦ|ۢ|ۭ|۟/); // no Uthmani marks, hence no Quran text
    expect(serialized).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`));
    for (const match of serialized.matchAll(/"[a-z]*[iI]d":"([^"]+)"/g)) expect(match[1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("API mode (NEXT_PUBLIC_API_MODE)", () => {
  it("defaults to mock in development and live otherwise", () => {
    expect(resolveApiMode(undefined, "development")).toBe("mock");
    expect(resolveApiMode(undefined, "production")).toBe("live");
    expect(resolveApiMode("", "test")).toBe("live");
    expect(resolveApiMode("  ", "development")).toBe("mock");
  });

  it("accepts an explicit value in either environment and rejects anything else", () => {
    expect(resolveApiMode("live", "development")).toBe("live");
    expect(resolveApiMode("mock", "production")).toBe("mock");
    expect(() => resolveApiMode("demo", "development")).toThrow(/mock.*live/);
  });

  it("builds a runtime whose client talks to the mock layer in mock mode and to fetch in live mode", async () => {
    const mock = createApiRuntime({ mode: "mock" });
    // The mock starts as a visitor: the login screen is the way in.
    expect(isSessionEnded(await mock.api.me().catch((e: unknown) => e))).toBe(true);
    await mock.api.login({ username: "sample_user_01", password: MOCK_PASSWORD });
    await expect(mock.api.me()).resolves.toEqual(mockProfile);

    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(mockProfile), { status: 200 }));
    const live = createApiRuntime({ mode: "live", fetch: fetchSpy });
    await live.api.me();
    expect(fetchSpy).toHaveBeenCalledWith("/api/me", expect.objectContaining({ credentials: "same-origin", method: "GET" }));
    mock.wakeUp.dispose();
    live.wakeUp.dispose();
  });

  it("boot() issues the first request once, tracked, so the wake-up logic can watch it", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: "ok", version: "t", time: "x" }), { status: 200 }));
    const runtime = createApiRuntime({ mode: "live", fetch: fetchSpy });
    const started = vi.fn();
    runtime.monitor.subscribe({ onStart: started });
    runtime.boot();
    runtime.boot();
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/health", expect.anything());
    runtime.wakeUp.dispose();
  });
});
