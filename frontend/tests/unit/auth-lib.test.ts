import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import type { Endpoints } from "@/lib/api/endpoints";
import type { Today } from "@/lib/api/types";
import { mockToday, mockTodayWithoutPlan } from "@/lib/api/mock";
import { homeDestination } from "@/lib/auth/destination";
import { clearLoginArrival, peekLoginArrival, raiseLoginArrival } from "@/lib/auth/flash";
import { classifyLoginError } from "@/lib/auth/login-failure";
import { setReturnPath, takeReturnPath } from "@/lib/auth/return-path";
import { safeNextPath } from "@/lib/auth/safe-path";

describe("safeNextPath: only a path inside this app may become a redirect target", () => {
  it.each([
    ["/today", "/today"],
    ["/progress?tab=week", "/progress?tab=week"],
    ["/games#top", "/games#top"],
    ["/plan/chat/abc-123", "/plan/chat/abc-123"],
    ["/consent", "/consent"],
    ["/a/./b", "/a/b"],
    ["/a/b/../c", "/a/c"],
  ])("accepts %s", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it("keeps a non-ASCII path, percent-encoded as the browser would send it", () => {
    expect(safeNextPath("/اليوم")).toBe(`/${encodeURIComponent("اليوم")}`);
  });

  it.each([
    ["nothing", null],
    ["undefined", undefined],
    ["empty", ""],
    ["no leading slash", "today"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["three slashes", "///evil.example"],
    ["an absolute URL", "https://evil.example/x"],
    ["an http URL", "http://evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,x"],
    ["a backslash host", "/\\evil.example"],
    ["a backslash anywhere", "/ok\\path"],
    ["a newline", "/a\nb"],
    ["a tab", "/a\tb"],
    ["a NUL", "/a\u0000b"],
    ["an encoded start", "%2f%2fevil.example"],
    ["the login route", "/login"],
    ["the login route with a query", "/login?next=/today"],
    ["the register route", "/register"],
    ["a recovery sub-route", "/recovery/step"],
    ["the recovery-code route", "/recovery-code"],
    ["an API path", "/api/auth/logout"],
    ["a build asset path", "/_next/static/chunk.js"],
    ["a dot segment into the login route", "/a/../login"],
    ["an encoded dot segment into the login route", "/%2e%2e/login"],
  ])("rejects %s", (_label, raw) => {
    expect(safeNextPath(raw)).toBeNull();
  });

  it("rejects a path longer than 512 characters", () => {
    expect(safeNextPath(`/${"a".repeat(511)}`)).not.toBeNull();
    expect(safeNextPath(`/${"a".repeat(512)}`)).toBeNull();
  });
});

describe("the login arrival flag (P-09): in memory, one banner, strongest first", () => {
  afterEach(clearLoginArrival);

  it("holds nothing at first", () => {
    expect(peekLoginArrival()).toBeNull();
  });

  it("returns the strongest raised kind: session ended, then reset done, then account deleted", () => {
    raiseLoginArrival("account_deleted");
    expect(peekLoginArrival()).toBe("account_deleted");
    raiseLoginArrival("reset_done");
    expect(peekLoginArrival()).toBe("reset_done");
    raiseLoginArrival("session_ended");
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("peeking does not consume it, clearing does, and clearing drops every kind", () => {
    raiseLoginArrival("session_ended");
    raiseLoginArrival("reset_done");
    expect(peekLoginArrival()).toBe("session_ended");
    expect(peekLoginArrival()).toBe("session_ended");
    clearLoginArrival();
    expect(peekLoginArrival()).toBeNull();
  });

  it("is never written to browser storage", () => {
    raiseLoginArrival("session_ended");
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});

describe("the return path kept for the re-consent gate", () => {
  afterEach(() => takeReturnPath());

  it("hands over a safe path once", () => {
    setReturnPath("/progress");
    expect(takeReturnPath()).toBe("/progress");
    expect(takeReturnPath()).toBeNull();
  });

  it("drops an unsafe path and a missing one", () => {
    setReturnPath("//evil.example");
    expect(takeReturnPath()).toBeNull();
    setReturnPath("/progress");
    setReturnPath(null);
    expect(takeReturnPath()).toBeNull();
  });
});

describe("classifyLoginError: the E04 mapping of S-01", () => {
  const api = (status: number, code: string, retryAfterSec: number | null = null) => new ApiError({ status, code, message: "Safe text.", retryAfterSec });

  it("maps each documented outcome", () => {
    expect(classifyLoginError(api(401, "invalid_credentials"))).toEqual({ kind: "credentials" });
    expect(classifyLoginError(api(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyLoginError(api(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifyLoginError(api(500, "internal"))).toEqual({ kind: "internal" });
  });

  it("treats a validation_error and a code it has no copy for as internal", () => {
    for (const code of ["validation_error", "terms_required", "unauthenticated", "something_new"]) {
      expect(classifyLoginError(api(400, code)), code).toEqual({ kind: "internal" });
    }
  });

  it("takes the wait of a throttle from the error, rounded up", () => {
    expect(classifyLoginError(api(429, "throttled", 20))).toEqual({ kind: "throttled", retryAfterSec: 20 });
    expect(classifyLoginError(api(429, "throttled", 900))).toEqual({ kind: "throttled", retryAfterSec: 900 });
    expect(classifyLoginError(api(429, "throttled", 2.2))).toEqual({ kind: "throttled", retryAfterSec: 3 });
  });

  it("falls back to 60 s when the server gives no usable wait, and never locks the form for more than an hour", () => {
    for (const wait of [null, 0, -5, Number.NaN]) {
      expect(classifyLoginError(api(429, "throttled", wait)), String(wait)).toEqual({ kind: "throttled", retryAfterSec: 60 });
    }
    expect(classifyLoginError(api(429, "throttled", 86_400))).toEqual({ kind: "throttled", retryAfterSec: 3600 });
  });

  it("separates connectivity, an abort and anything unknown", () => {
    expect(classifyLoginError(new ConnectivityError("gateway", { status: 502 }))).toEqual({ kind: "connectivity" });
    expect(classifyLoginError(new ConnectivityError("timeout"))).toEqual({ kind: "connectivity" });
    expect(classifyLoginError(new DOMException("aborted", "AbortError"))).toEqual({ kind: "aborted" });
    expect(classifyLoginError(new Error("boom"))).toEqual({ kind: "internal" });
    expect(classifyLoginError("boom")).toEqual({ kind: "internal" });
  });
});

describe("homeDestination: /start without a plan, else /today, and never a dead end", () => {
  const apiWith = (read: () => Promise<Today>): Pick<Endpoints, "today"> => ({ today: vi.fn(read) });

  it("goes to /today when E18 has a plan", async () => {
    await expect(homeDestination(apiWith(async () => mockToday))).resolves.toBe("/today");
  });

  it("goes to /start when E18 says there is no plan", async () => {
    await expect(homeDestination(apiWith(async () => mockTodayWithoutPlan))).resolves.toBe("/start");
  });

  it("falls back to /today when the read fails", async () => {
    await expect(homeDestination(apiWith(() => Promise.reject(new ConnectivityError("network"))))).resolves.toBe("/today");
    await expect(homeDestination(apiWith(() => Promise.reject(new ApiError({ status: 503, code: "unavailable", message: "x" }))))).resolves.toBe("/today");
  });

  it("passes the abort signal on", async () => {
    const today = vi.fn(async () => mockToday);
    const controller = new AbortController();
    await homeDestination({ today }, controller.signal);
    expect(today).toHaveBeenCalledWith({ signal: controller.signal });
  });
});
