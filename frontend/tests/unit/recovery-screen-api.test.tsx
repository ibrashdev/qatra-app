import { describe, expect, it, vi } from "vitest";
import { classifyCommonError } from "@/components/recovery/account-failure";
import { checkRecoveryCode, classifyResetError, classifyVerifyError, DEFAULT_GRANT_LIFETIME_SEC, grantExpired, makeResetGrant } from "@/components/recovery/recovery-model";
import { acceptTerms, logout, normalizeRecoveryCode, resetPassword, verifyRecovery } from "@/lib/api/account-endpoints";
import { createApiClient, THROTTLED_REQUEST_TIMEOUT_MS } from "@/lib/api/client";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { createMockFetch, mockHandlers, MOCK_PASSWORD, MOCK_RECOVERY_CODE, MOCK_TERMS_VERSION, mockProfile, type MockScenario } from "@/lib/api/mock";
import { accountMockHandlers, MOCK_OLD_TERMS_VERSION, MOCK_REPLACEMENT_CODE } from "@/lib/api/mock/account-handlers";

const PLAIN_CODE = "0123456789abcdef0123456789abcdef";
const NEW_PASSWORD = "another synthetic passphrase for docs";

function clientWith(scenario: Partial<MockScenario> = { signedIn: false }) {
  const fetchImpl = createMockFetch({ latencyMs: 0, scenario, handlers: { ...mockHandlers, ...accountMockHandlers } });
  return createApiClient({ fetch: fetchImpl });
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

describe("normalizeRecoveryCode (E06 rule, S-05 step 1, O-11)", () => {
  it.each([
    ["the example with dashes", MOCK_RECOVERY_CODE, PLAIN_CODE],
    ["without dashes", PLAIN_CODE, PLAIN_CODE],
    ["capitals", MOCK_RECOVERY_CODE.toUpperCase(), PLAIN_CODE],
    ["spaces and dashes mixed", "0123 4567-89ab cdef 0123 4567 89ab-cdef", PLAIN_CODE],
    ["Arabic-Indic digits", "٠١٢٣-٤٥٦٧-٨٩ab-cdef-٠١٢٣-٤٥٦٧-٨٩ab-cdef", PLAIN_CODE],
  ])("reads %s as 32 plain hexadecimal characters", (_name, raw, expected) => {
    expect(normalizeRecoveryCode(raw)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["31 characters", PLAIN_CODE.slice(1)],
    ["33 characters", `${PLAIN_CODE}0`],
    ["a letter beyond f", `${PLAIN_CODE.slice(1)}g`],
    ["a punctuation mark", `${PLAIN_CODE.slice(1)}!`],
    ["Persian digits, which the server does not map", "۰۱۲۳4567-89ab-cdef-0123-4567-89ab-cdef"],
  ])("refuses %s", (_name, raw) => {
    expect(normalizeRecoveryCode(raw)).toBeNull();
  });

  it("separates the two client messages: empty and format", () => {
    expect(checkRecoveryCode("")).toBe("empty");
    expect(checkRecoveryCode("abc")).toBe("format");
    expect(checkRecoveryCode(MOCK_RECOVERY_CODE)).toBeNull();
  });
});

describe("the reset grant (S-05 step 2)", () => {
  it("is counted from the moment the answer arrived, for 600 s", () => {
    const grant = makeResetGrant({ resetGrant: "g", expiresInSec: 600 }, 1_000);
    expect(grantExpired(grant, 1_000)).toBe(false);
    expect(grantExpired(grant, 600_999)).toBe(false);
    expect(grantExpired(grant, 601_000)).toBe(true);
  });

  it("falls back to 600 s when the answer carries no usable lifetime", () => {
    for (const expiresInSec of [0, -5, Number.NaN]) {
      expect(makeResetGrant({ resetGrant: "g", expiresInSec }, 0).expiresInSec).toBe(DEFAULT_GRANT_LIFETIME_SEC);
    }
  });
});

describe("how E06, E07 and E05 failures are read", () => {
  const api = (status: number, code: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) => new ApiError({ status, code, message: "x", details, retryAfterSec });

  it("E06: invalid_credentials is the one generic refusal; the rest are the shared failures", () => {
    expect(classifyVerifyError(api(401, "invalid_credentials"))).toEqual({ kind: "invalid" });
    expect(classifyVerifyError(api(429, "throttled", {}, 20))).toEqual({ kind: "throttled", retryAfterSec: 20 });
    expect(classifyVerifyError(api(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyVerifyError(api(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifyVerifyError(api(500, "internal"))).toEqual({ kind: "internal" });
    expect(classifyVerifyError(api(422, "validation_error"))).toEqual({ kind: "internal" });
    expect(classifyVerifyError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
  });

  it("E07: no answer is uncertain, never connectivity", () => {
    expect(classifyResetError(new ConnectivityError("timeout"))).toEqual({ kind: "uncertain" });
    expect(classifyResetError(new ConnectivityError("gateway", { status: 502 }))).toEqual({ kind: "uncertain" });
  });

  it("E07: a password rule the learner can fix is shown at the field, the first by the order of the API", () => {
    const fields = [
      { field: "newPassword", rule: "password_max_bytes" },
      { field: "newPassword", rule: "password_min_chars" },
    ];
    expect(classifyResetError(api(422, "validation_error", { fields }))).toEqual({ kind: "password", rule: "password_min_chars" });
  });

  it("E07: any other validation_error, and a malformed details object, are internal", () => {
    expect(classifyResetError(api(422, "validation_error", { fields: [{ field: "resetGrant", rule: "invalid_type" }] }))).toEqual({ kind: "internal" });
    expect(classifyResetError(api(422, "validation_error", { fields: "nope" }))).toEqual({ kind: "internal" });
    expect(classifyResetError(api(422, "validation_error"))).toEqual({ kind: "internal" });
  });

  it("E07: invalid_credentials covers an expired, used or lost grant", () => {
    expect(classifyResetError(api(401, "invalid_credentials"))).toEqual({ kind: "invalid" });
  });

  it("falls back to the longest short wait when a 429 names none, and never waits longer than an hour", () => {
    expect(classifyCommonError(api(429, "throttled"))).toEqual({ kind: "throttled", retryAfterSec: 60 });
    expect(classifyCommonError(api(429, "throttled", {}, 99_999))).toEqual({ kind: "throttled", retryAfterSec: 3600 });
  });

  it("an abort is not a failure", () => {
    expect(classifyCommonError(new DOMException("aborted", "AbortError"))).toEqual({ kind: "aborted" });
  });
});

describe("account endpoints", () => {
  it("send the documented paths and bodies, and the credential calls wait as long as the throttle can hold them", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") timeouts.push(ms);
      return realSetTimeout(handler, ms, ...rest);
    }) as typeof setTimeout);
    const client = createApiClient({
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        return new Response(JSON.stringify({ resetGrant: "g", expiresInSec: 600, recoveryCode: MOCK_REPLACEMENT_CODE, profile: mockProfile }), { status: 200 });
      },
    });

    await verifyRecovery(client, { username: "sample_user_01", recoveryCode: PLAIN_CODE });
    await resetPassword(client, { resetGrant: "g", newPassword: NEW_PASSWORD });
    await acceptTerms(client, { termsVersion: MOCK_TERMS_VERSION });

    expect(calls).toEqual([
      { url: "/api/auth/recovery/verify", body: { username: "sample_user_01", recoveryCode: PLAIN_CODE } },
      { url: "/api/auth/recovery/reset", body: { resetGrant: "g", newPassword: NEW_PASSWORD } },
      { url: "/api/auth/consent", body: { termsVersion: MOCK_TERMS_VERSION } },
    ]);
    expect(timeouts.filter((ms) => ms === THROTTLED_REQUEST_TIMEOUT_MS)).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("logout posts no body and returns nothing for a 204", async () => {
    const seen: { url: string; method: string | undefined; body: unknown }[] = [];
    const client = createApiClient({
      fetch: async (input, init) => {
        seen.push({ url: String(input), method: init?.method, body: init?.body });
        return new Response(null, { status: 204 });
      },
    });
    await expect(logout(client)).resolves.toBeUndefined();
    expect(seen).toEqual([{ url: "/api/auth/logout", method: "POST", body: undefined }]);
  });
});

describe("account mock handlers (E05, E06, E07, E10)", () => {
  it("E06 gives a grant for the example code and names the lifetime", async () => {
    const answer = await verifyRecovery(clientWith(), { username: "sample_user_01", recoveryCode: PLAIN_CODE });
    expect(answer.expiresInSec).toBe(600);
    expect(answer.resetGrant).toMatch(/^mock-grant-\d+$/);
  });

  it("E06 refuses an unknown name, a wrong code and a malformed code with the same answer", async () => {
    const client = clientWith();
    const answers = await Promise.all([
      failureOf(verifyRecovery(client, { username: "nobody_here_01", recoveryCode: PLAIN_CODE })),
      failureOf(verifyRecovery(client, { username: "sample_user_01", recoveryCode: "f".repeat(32) })),
      failureOf(verifyRecovery(client, { username: "sample_user_01", recoveryCode: "short" })),
    ]);
    for (const error of answers) expect([error.status, error.code]).toEqual([401, "invalid_credentials"]);
  });

  it.each([
    ["throttled_user_01", 429, "throttled", 20],
    ["locked_user_01", 429, "throttled", 900],
    ["unavailable_user_01", 503, "unavailable", null],
    ["internal_user_01", 500, "internal", null],
    ["origin_user_01", 403, "forbidden_origin", null],
  ])("E06 answers %s with %i %s", async (username, status, code, retryAfterSec) => {
    const error = await failureOf(verifyRecovery(clientWith(), { username, recoveryCode: PLAIN_CODE }));
    expect([error.status, error.code, error.retryAfterSec]).toEqual([status, code, retryAfterSec]);
  });

  it("E06 gives no answer at all for silent_user_01 (the connection fails)", async () => {
    await expect(verifyRecovery(clientWith(), { username: "silent_user_01", recoveryCode: PLAIN_CODE })).rejects.toBeInstanceOf(ConnectivityError);
  });

  it("E06 rejects a body with a missing, mistyped or unknown field as validation_error", async () => {
    const error = await failureOf(clientWith().post("/auth/recovery/verify", { username: "sample_user_01", extra: 1 }));
    expect([error.status, error.code]).toEqual([422, "validation_error"]);
    expect(error.details.fields).toEqual([
      { field: "recoveryCode", rule: "invalid_type" },
      { field: "extra", rule: "forbidden_field" },
    ]);
  });

  it("E07 sets the password once: the grant is spent, a second use is the generic refusal, and no session is created", async () => {
    const client = clientWith({ signedIn: true });
    const { resetGrant } = await verifyRecovery(client, { username: "sample_user_01", recoveryCode: PLAIN_CODE });
    const answer = await resetPassword(client, { resetGrant, newPassword: NEW_PASSWORD });
    expect(answer).toEqual({ recoveryCode: MOCK_REPLACEMENT_CODE });
    const again = await failureOf(resetPassword(client, { resetGrant, newPassword: NEW_PASSWORD }));
    expect([again.status, again.code]).toEqual([401, "invalid_credentials"]);
    // Every session was revoked, so a read of the profile is refused.
    const me = await failureOf(client.get("/me"));
    expect(me.code).toBe("unauthenticated");
  });

  it("E07 refuses a grant it never issued, and a password under the policy", async () => {
    const client = clientWith();
    const unknown = await failureOf(resetPassword(client, { resetGrant: "made-up", newPassword: NEW_PASSWORD }));
    expect(unknown.code).toBe("invalid_credentials");
    const { resetGrant } = await verifyRecovery(client, { username: "sample_user_01", recoveryCode: PLAIN_CODE });
    const weak = await failureOf(resetPassword(client, { resetGrant, newPassword: "too short" }));
    expect([weak.status, weak.code, weak.details.fields]).toEqual([422, "validation_error", [{ field: "newPassword", rule: "password_min_chars" }]]);
  });

  it.each([
    ["reset_expired_user_01", 401, "invalid_credentials"],
    ["reset_throttled_user_01", 429, "throttled"],
    ["reset_unavailable_user_01", 503, "unavailable"],
    ["reset_internal_user_01", 500, "internal"],
    ["reset_origin_user_01", 403, "forbidden_origin"],
  ])("E07 answers a grant of %s with %i %s", async (username, status, code) => {
    const client = clientWith();
    const { resetGrant } = await verifyRecovery(client, { username, recoveryCode: PLAIN_CODE });
    const error = await failureOf(resetPassword(client, { resetGrant, newPassword: NEW_PASSWORD }));
    expect([error.status, error.code]).toEqual([status, code]);
  });

  it("E07 gives no answer at all for reset_silent_user_01", async () => {
    const client = clientWith();
    const { resetGrant } = await verifyRecovery(client, { username: "reset_silent_user_01", recoveryCode: PLAIN_CODE });
    await expect(resetPassword(client, { resetGrant, newPassword: NEW_PASSWORD })).rejects.toBeInstanceOf(ConnectivityError);
  });

  it("E05 needs a session, the current version and nothing else", async () => {
    const visitor = await failureOf(acceptTerms(clientWith({ signedIn: false }), { termsVersion: MOCK_TERMS_VERSION }));
    expect([visitor.status, visitor.code]).toEqual([401, "unauthenticated"]);

    const client = clientWith({ signedIn: true });
    const old = await failureOf(acceptTerms(client, { termsVersion: MOCK_OLD_TERMS_VERSION }));
    expect([old.status, old.code, old.details]).toEqual([400, "terms_required", { requiredVersion: MOCK_TERMS_VERSION }]);
    const extra = await failureOf(client.post("/auth/consent", { termsVersion: MOCK_TERMS_VERSION, agreed: true }));
    expect([extra.status, extra.code]).toEqual([422, "validation_error"]);

    const { profile } = await acceptTerms(client, { termsVersion: MOCK_TERMS_VERSION });
    expect(profile.termsVersion).toBe(MOCK_TERMS_VERSION);
  });

  it("a login that asks for consent leaves the old terms version in the profile until E05 answers", async () => {
    const client = clientWith();
    const login = await client.post<{ reconsentRequired: boolean }>("/auth/login", { username: "reconsent_user_01", password: MOCK_PASSWORD });
    expect(login.reconsentRequired).toBe(true);
    expect((await client.get<{ termsVersion: string }>("/me")).termsVersion).toBe(MOCK_OLD_TERMS_VERSION);

    await acceptTerms(client, { termsVersion: MOCK_TERMS_VERSION });
    expect((await client.get<{ termsVersion: string }>("/me")).termsVersion).toBe(MOCK_TERMS_VERSION);
  });

  it("an ordinary login leaves the profile as it was", async () => {
    const client = clientWith();
    await client.post("/auth/login", { username: "sample_user_01", password: MOCK_PASSWORD });
    expect((await client.get<{ termsVersion: string }>("/me")).termsVersion).toBe(MOCK_TERMS_VERSION);
  });

  it("E10 answers 204 with or without a session, and ends the session", async () => {
    const client = clientWith({ signedIn: true });
    await expect(logout(client)).resolves.toBeUndefined();
    expect((await failureOf(client.get("/me"))).code).toBe("unauthenticated");
    await expect(logout(client)).resolves.toBeUndefined();
  });

  it("holds synthetic values only: the example codes, no real account", () => {
    expect(MOCK_REPLACEMENT_CODE).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    expect(MOCK_REPLACEMENT_CODE).not.toBe(MOCK_RECOVERY_CODE);
  });
});
