import { describe, expect, it, vi } from "vitest";
import { classifySecurityError } from "@/components/account-security/security-failure";
import { createApiClient, THROTTLED_REQUEST_TIMEOUT_MS } from "@/lib/api/client";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { createMockFetch, MOCK_PASSWORD, mockProfile, type MockScenario } from "@/lib/api/mock";
import { MOCK_ROTATED_CODE, MOCK_SECURITY_OUTCOMES, securityMockHandlers } from "@/lib/api/mock/security-handlers";
import { changePassword, deleteAccount, DELETE_CONFIRMATION, rotateRecoveryCode } from "@/lib/api/security-endpoints";
import { recoveryCodeGroups } from "@/lib/auth/recovery-handoff";

const NEW_PASSWORD = "another synthetic passphrase for docs";

function clientWith(scenario: Partial<MockScenario> = { signedIn: true }) {
  return createApiClient({ fetch: createMockFetch({ latencyMs: 0, scenario }) });
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

const api = (status: number, code: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) => new ApiError({ status, code, message: "x", details, retryAfterSec });

describe("security endpoints (E09, E08 and E13)", () => {
  it("send the documented paths and bodies, and wait as long as the auth throttle can hold the answer", async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") timeouts.push(ms);
      return realSetTimeout(handler, ms, ...rest);
    }) as typeof setTimeout);
    const client = createApiClient({
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        return String(input).endsWith("/delete") ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ profile: mockProfile, recoveryCode: MOCK_ROTATED_CODE }), { status: 200 });
      },
    });

    await changePassword(client, { currentPassword: MOCK_PASSWORD, newPassword: NEW_PASSWORD });
    await rotateRecoveryCode(client, { password: MOCK_PASSWORD });
    await deleteAccount(client, { password: MOCK_PASSWORD, confirm: DELETE_CONFIRMATION });

    expect(calls).toEqual([
      { url: "/api/auth/password", method: "POST", body: { currentPassword: MOCK_PASSWORD, newPassword: NEW_PASSWORD } },
      { url: "/api/auth/recovery/rotate", method: "POST", body: { password: MOCK_PASSWORD } },
      { url: "/api/account/delete", method: "POST", body: { password: MOCK_PASSWORD, confirm: "DELETE" } },
    ]);
    expect(timeouts.filter((ms) => ms === THROTTLED_REQUEST_TIMEOUT_MS)).toHaveLength(3);
  });

  it("send a password exactly as typed: never trimmed or normalized", async () => {
    let sent: unknown;
    const client = createApiClient({
      fetch: async (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ profile: mockProfile }), { status: 200 });
      },
    });
    // A letter with a combining mark: normalization would change it, so the call must not.
    const padded = `  e${String.fromCharCode(0x0301)} padded passphrase  `;
    await changePassword(client, { currentPassword: padded, newPassword: padded });
    expect(sent).toEqual({ currentPassword: padded, newPassword: padded });
  });
});

describe("mock security handlers", () => {
  it("are registered by default over the shared set, under the keys of the three operations", () => {
    expect(Object.keys(securityMockHandlers).sort()).toEqual(["POST /account/delete", "POST /auth/password", "POST /auth/recovery/rotate"]);
  });

  it("E09: 200 with the profile for the right current password and a new one that follows the policy", async () => {
    const answer = await changePassword(clientWith(), { currentPassword: MOCK_PASSWORD, newPassword: NEW_PASSWORD });
    expect(answer.profile).toEqual(mockProfile);
  });

  it("E09: a demo account is allowed and stays a demo account (D71)", async () => {
    const answer = await changePassword(clientWith({ signedIn: true, isDemo: true }), { currentPassword: MOCK_PASSWORD, newPassword: NEW_PASSWORD });
    expect(answer.profile.isDemo).toBe(true);
  });

  it("E09: a wrong current password is the generic 401 invalid_credentials, and it is judged before the new password", async () => {
    const error = await failureOf(changePassword(clientWith(), { currentPassword: "not the password", newPassword: "short" }));
    expect([error.status, error.code]).toEqual([401, "invalid_credentials"]);
  });

  it("E09: the new password follows the policy of registration, with the rule names of the API", async () => {
    const tooShort = await failureOf(changePassword(clientWith(), { currentPassword: MOCK_PASSWORD, newPassword: "short" }));
    expect([tooShort.status, tooShort.code, tooShort.details]).toEqual([422, "validation_error", { fields: [{ field: "newPassword", rule: "password_min_chars" }] }]);
    const tooLong = await failureOf(changePassword(clientWith(), { currentPassword: MOCK_PASSWORD, newPassword: "ع".repeat(37) }));
    expect(tooLong.details).toEqual({ fields: [{ field: "newPassword", rule: "password_max_bytes" }] });
  });

  it("E08: 200 with a code of 32 hexadecimal characters in eight groups of four", async () => {
    const { recoveryCode } = await rotateRecoveryCode(clientWith(), { password: MOCK_PASSWORD });
    expect(recoveryCodeGroups(recoveryCode)).toHaveLength(8);
    expect(recoveryCode).toBe(MOCK_ROTATED_CODE);
  });

  it("E13: 204 for the right password and the literal, and the session is over afterwards", async () => {
    const client = clientWith();
    await expect(deleteAccount(client, { password: MOCK_PASSWORD, confirm: "DELETE" })).resolves.toBeUndefined();
    const again = await failureOf(deleteAccount(client, { password: MOCK_PASSWORD, confirm: "DELETE" }));
    expect([again.status, again.code]).toEqual([401, "unauthenticated"]);
  });

  it("E13: the password is judged first, then the literal (confirm_literal)", async () => {
    const wrong = await failureOf(deleteAccount(clientWith(), { password: "not the password", confirm: "delete" as "DELETE" }));
    expect(wrong.code).toBe("invalid_credentials");
    const literal = await failureOf(deleteAccount(clientWith(), { password: MOCK_PASSWORD, confirm: "delete" as "DELETE" }));
    expect([literal.status, literal.code, literal.details]).toEqual([422, "validation_error", { fields: [{ field: "confirm", rule: "confirm_literal" }] }]);
  });

  it("all three answer 401 unauthenticated without a session, and 422 for a body that is not the schema", async () => {
    const visitor = clientWith({ signedIn: false });
    expect((await failureOf(changePassword(visitor, { currentPassword: MOCK_PASSWORD, newPassword: NEW_PASSWORD }))).code).toBe("unauthenticated");
    expect((await failureOf(rotateRecoveryCode(visitor, { password: MOCK_PASSWORD }))).code).toBe("unauthenticated");
    expect((await failureOf(deleteAccount(visitor, { password: MOCK_PASSWORD, confirm: "DELETE" }))).code).toBe("unauthenticated");

    const client = clientWith();
    const malformed = await failureOf(client.post("/auth/recovery/rotate", { password: MOCK_PASSWORD, extra: 1 }));
    expect([malformed.status, malformed.details]).toEqual([422, { fields: [{ field: "extra", rule: "forbidden_field" }] }]);
  });

  it("the trigger passwords make each operation answer each failure of API-spec 4.2", async () => {
    const outcomes = [...MOCK_SECURITY_OUTCOMES.entries()].filter(([, outcome]) => outcome !== "silent");
    for (const [password, outcome] of outcomes) {
      for (const call of [
        () => changePassword(clientWith(), { currentPassword: password, newPassword: NEW_PASSWORD }),
        () => rotateRecoveryCode(clientWith(), { password }),
        () => deleteAccount(clientWith(), { password, confirm: "DELETE" }),
      ]) {
        const error = await failureOf(call());
        const expected = { throttled: [429, "throttled"], locked: [429, "throttled"], unavailable: [503, "unavailable"], internal: [500, "internal"], origin: [403, "forbidden_origin"] }[outcome as "throttled"];
        expect([error.status, error.code]).toEqual(expected);
      }
    }
    const locked = await failureOf(rotateRecoveryCode(clientWith(), { password: "mock outcome: locked" }));
    expect(locked.retryAfterSec).toBe(900);
  });

  it("the silent trigger gets no answer at all: the connection fails", async () => {
    await expect(rotateRecoveryCode(clientWith(), { password: "mock outcome: silent" })).rejects.toBeInstanceOf(ConnectivityError);
  });

  it("keep nothing between two mock sessions", async () => {
    const first = clientWith();
    await deleteAccount(first, { password: MOCK_PASSWORD, confirm: "DELETE" });
    await expect(rotateRecoveryCode(clientWith(), { password: MOCK_PASSWORD })).resolves.toEqual({ recoveryCode: MOCK_ROTATED_CODE });
  });
});

describe("how E09, E08 and E13 failures are read", () => {
  it("a session that ended and a wrong current password have their own kinds", () => {
    expect(classifySecurityError(api(401, "unauthenticated"))).toEqual({ kind: "session_ended" });
    expect(classifySecurityError(api(401, "invalid_credentials"))).toEqual({ kind: "credentials" });
  });

  it("the rest are the shared failures of the account screens", () => {
    expect(classifySecurityError(api(429, "throttled", {}, 20))).toEqual({ kind: "throttled", retryAfterSec: 20 });
    expect(classifySecurityError(api(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifySecurityError(api(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifySecurityError(api(500, "internal"))).toEqual({ kind: "internal" });
    expect(classifySecurityError(api(400, "some_new_code"))).toEqual({ kind: "internal" });
    expect(classifySecurityError(new DOMException("aborted", "AbortError"))).toEqual({ kind: "aborted" });
  });

  it("no answer at all is uncertain, never plain connectivity: the request may have been applied (P-10)", () => {
    expect(classifySecurityError(new ConnectivityError("network"))).toEqual({ kind: "uncertain" });
    expect(classifySecurityError(new ConnectivityError("timeout"))).toEqual({ kind: "uncertain" });
    expect(classifySecurityError(new ConnectivityError("gateway", { status: 502 }))).toEqual({ kind: "uncertain" });
  });

  it("E09 only: a password rule the learner can fix, the first by the order of the API", () => {
    const fields = [
      { field: "newPassword", rule: "password_max_bytes" },
      { field: "newPassword", rule: "password_min_chars" },
    ];
    expect(classifySecurityError(api(422, "validation_error", { fields }), { newPassword: true })).toEqual({ kind: "password", rule: "password_min_chars" });
    expect(classifySecurityError(api(422, "validation_error", { fields: "nope" }), { newPassword: true })).toEqual({ kind: "internal" });
    expect(classifySecurityError(api(422, "validation_error", { fields: [{ field: "currentPassword", rule: "invalid_type" }] }), { newPassword: true })).toEqual({ kind: "internal" });
  });

  it("E08 and E13: any validation_error is internal (confirm_literal cannot arise)", () => {
    const fields = [{ field: "confirm", rule: "confirm_literal" }];
    expect(classifySecurityError(api(422, "validation_error", { fields }))).toEqual({ kind: "internal" });
    expect(classifySecurityError(api(422, "validation_error", { fields: [{ field: "password", rule: "password_min_chars" }] }))).toEqual({ kind: "internal" });
  });
});
