import { describe, expect, it } from "vitest";
import { classifyAdminError, isAlertFailure, needsReload } from "@/components/admin/admin-failure";
import { ApiError, ConnectivityError } from "@/lib/api/errors";

const api = (status: number, code: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) =>
  new ApiError({ status, code, message: "a message that is never shown", details, retryAfterSec });

describe("the failures of the admin API (docs/Content-admin.md section 4, Errors)", () => {
  it("maps each documented answer to one kind", () => {
    expect(classifyAdminError(api(401, "unauthenticated"))).toEqual({ kind: "session_ended" });
    expect(classifyAdminError(api(403, "forbidden"))).toEqual({ kind: "forbidden" });
    expect(classifyAdminError(api(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifyAdminError(api(404, "not_found"))).toEqual({ kind: "not_found" });
    expect(classifyAdminError(api(422, "validation_error", { fields: [] }))).toEqual({ kind: "invalid" });
    expect(classifyAdminError(api(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyAdminError(api(500, "internal"))).toEqual({ kind: "internal" });
  });

  it("tells the three reasons of a 409 version_conflict apart", () => {
    expect(classifyAdminError(api(409, "version_conflict", { reason: "stale" }))).toEqual({ kind: "stale" });
    expect(classifyAdminError(api(409, "version_conflict", { reason: "in_use" }))).toEqual({ kind: "in_use" });
    expect(classifyAdminError(api(409, "version_conflict", { reason: "state" }))).toEqual({ kind: "state" });
    // A reason this build does not know is a generic failure, not a guess.
    expect(classifyAdminError(api(409, "version_conflict", { reason: "something_new" }))).toEqual({ kind: "internal" });
    expect(classifyAdminError(api(409, "version_conflict"))).toEqual({ kind: "internal" });
  });

  it("reads the wait of a throttle, and sorts connectivity, aborts and unknown errors", () => {
    expect(classifyAdminError(api(429, "throttled", {}, 20))).toEqual({ kind: "throttled", retryAfterSec: 20 });
    expect(classifyAdminError(api(429, "throttled"))).toEqual({ kind: "throttled", retryAfterSec: 60 });
    expect(classifyAdminError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
    expect(classifyAdminError(new ConnectivityError("gateway", { status: 502 }))).toEqual({ kind: "connectivity" });
    expect(classifyAdminError(Object.assign(new Error("stopped"), { name: "AbortError" }))).toEqual({ kind: "aborted" });
    expect(classifyAdminError(new Error("boom"))).toEqual({ kind: "internal" });
    expect(classifyAdminError(api(418, "a_code_this_build_does_not_know"))).toEqual({ kind: "internal" });
  });

  it("asks for a reload only when the row moved, vanished or changed state", () => {
    expect(needsReload({ kind: "stale" })).toBe(true);
    expect(needsReload({ kind: "state" })).toBe(true);
    expect(needsReload({ kind: "not_found" })).toBe(true);
    expect(needsReload({ kind: "in_use" })).toBe(false);
    expect(needsReload({ kind: "internal" })).toBe(false);
  });

  it("reads out the failures a press raised and leaves the waiting ones polite", () => {
    for (const kind of ["internal", "origin", "forbidden", "invalid", "stale", "in_use", "state", "not_found"] as const) {
      expect(isAlertFailure({ kind }), kind).toBe(true);
    }
    expect(isAlertFailure({ kind: "unavailable" })).toBe(false);
    expect(isAlertFailure({ kind: "connectivity" })).toBe(false);
    expect(isAlertFailure({ kind: "throttled", retryAfterSec: 5 })).toBe(false);
  });
});
