import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { holdRecoveryCode, peekRecoveryCode, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft, readRegisterDraft, saveRegisterDraft } from "@/lib/auth/register-draft";
import { classifyRegisterError } from "@/lib/auth/register-failure";
import { retryAfterSeconds } from "@/lib/auth/retry-after";
import { browserTimeZone } from "@/lib/browser";

const BUNDLED = "2026-10-04";

const api = (status: number, code: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) =>
  new ApiError({ status, code, message: "Safe text.", details, retryAfterSec });

const invalid = (...rules: string[]) => api(422, "validation_error", { fields: rules.map((rule) => ({ field: "x", rule })) });

describe("classifyRegisterError: the E03 mapping of S-02", () => {
  it("maps the documented outcomes that have one answer each", () => {
    expect(classifyRegisterError(api(409, "username_taken"), BUNDLED)).toEqual({ kind: "username_taken" });
    expect(classifyRegisterError(api(503, "unavailable"), BUNDLED)).toEqual({ kind: "unavailable" });
    expect(classifyRegisterError(api(403, "forbidden_origin"), BUNDLED)).toEqual({ kind: "origin" });
    expect(classifyRegisterError(api(500, "internal"), BUNDLED)).toEqual({ kind: "internal" });
  });

  it("sends a code it has no copy for to internal, including a login code that cannot come from E03", () => {
    for (const code of ["unauthenticated", "invalid_credentials", "not_found", "something_new"]) {
      expect(classifyRegisterError(api(400, code), BUNDLED), code).toEqual({ kind: "internal" });
    }
    expect(classifyRegisterError(new Error("boom"), BUNDLED)).toEqual({ kind: "internal" });
    expect(classifyRegisterError("boom", BUNDLED)).toEqual({ kind: "internal" });
  });

  describe("terms_required (O-09)", () => {
    it("asks for a reload when the server wants a version this build has not shown", () => {
      expect(classifyRegisterError(api(400, "terms_required", { requiredVersion: "2099-01-01" }), BUNDLED)).toEqual({ kind: "terms_outdated" });
    });

    it("puts the error at the box when the version is the one this build shows", () => {
      expect(classifyRegisterError(api(400, "terms_required", { requiredVersion: BUNDLED }), BUNDLED)).toEqual({ kind: "terms_missing" });
    });

    it("cannot tell what it was shown without a bundled version, or a version it was not told: it reloads", () => {
      expect(classifyRegisterError(api(400, "terms_required", { requiredVersion: BUNDLED }), null)).toEqual({ kind: "terms_outdated" });
      expect(classifyRegisterError(api(400, "terms_required"), BUNDLED)).toEqual({ kind: "terms_outdated" });
      expect(classifyRegisterError(api(400, "terms_required", { requiredVersion: 20261004 }), BUNDLED)).toEqual({ kind: "terms_outdated" });
    });
  });

  describe("validation_error", () => {
    it("maps the username and password rules to their fields", () => {
      expect(classifyRegisterError(invalid("username_length"), BUNDLED)).toEqual({ kind: "fields", username: "username_length", password: null });
      expect(classifyRegisterError(invalid("password_min_chars"), BUNDLED)).toEqual({ kind: "fields", username: null, password: "password_min_chars" });
      expect(classifyRegisterError(invalid("username_chars", "password_max_bytes"), BUNDLED)).toEqual({
        kind: "fields",
        username: "username_chars",
        password: "password_max_bytes",
      });
    });

    it("shows one rule per field, by the order of the spec", () => {
      expect(classifyRegisterError(invalid("username_length", "username_chars", "username_invisible_or_space"), BUNDLED)).toEqual({
        kind: "fields",
        username: "username_invisible_or_space",
        password: null,
      });
    });

    it("treats the rules a learner cannot fix as an internal error", () => {
      for (const rule of ["time_zone_invalid", "language_invalid", "forbidden_field", "invalid_type"]) {
        expect(classifyRegisterError(invalid(rule), BUNDLED), rule).toEqual({ kind: "internal" });
      }
    });

    it("still shows the field errors a learner can fix when a rule they cannot fix comes with them", () => {
      expect(classifyRegisterError(invalid("time_zone_invalid", "username_length"), BUNDLED)).toEqual({ kind: "fields", username: "username_length", password: null });
    });

    it("does not trust the shape of the details", () => {
      for (const details of [{}, { fields: "username_length" }, { fields: [null, 3, "x", {}] }, { fields: [{ rule: 5 }] }, { fields: { rule: "username_length" } }]) {
        expect(classifyRegisterError(api(422, "validation_error", details), BUNDLED), JSON.stringify(details)).toEqual({ kind: "internal" });
      }
    });
  });

  describe("throttled", () => {
    it("takes the wait from the error, rounded up, with the same fallback and ceiling as the login screen", () => {
      expect(classifyRegisterError(api(429, "throttled", {}, 20), BUNDLED)).toEqual({ kind: "throttled", retryAfterSec: 20 });
      expect(classifyRegisterError(api(429, "throttled", {}, 2.2), BUNDLED)).toEqual({ kind: "throttled", retryAfterSec: 3 });
      for (const wait of [null, 0, -5, Number.NaN]) {
        expect(classifyRegisterError(api(429, "throttled", {}, wait), BUNDLED), String(wait)).toEqual({ kind: "throttled", retryAfterSec: 60 });
      }
      expect(classifyRegisterError(api(429, "throttled", {}, 86_400), BUNDLED)).toEqual({ kind: "throttled", retryAfterSec: 3600 });
    });
  });

  it("calls any answer outside the envelope uncertain: the account may exist (P-10)", () => {
    for (const reason of ["network", "timeout", "gateway", "invalid_response"] as const) {
      expect(classifyRegisterError(new ConnectivityError(reason), BUNDLED), reason).toEqual({ kind: "uncertain" });
    }
    expect(classifyRegisterError(new ConnectivityError("gateway", { status: 502 }), BUNDLED)).toEqual({ kind: "uncertain" });
  });

  it("does not call a caller's own abort a failure", () => {
    expect(classifyRegisterError(new DOMException("aborted", "AbortError"), BUNDLED)).toEqual({ kind: "aborted" });
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up, falls back to a minute, and stops at an hour", () => {
    expect(retryAfterSeconds(api(429, "throttled", {}, 0.1))).toBe(1);
    expect(retryAfterSeconds(api(429, "throttled", {}, Number.POSITIVE_INFINITY))).toBe(60);
    expect(retryAfterSeconds(api(429, "throttled", {}, 3600))).toBe(3600);
    expect(retryAfterSeconds(api(429, "throttled", {}, 3601))).toBe(3600);
  });
});

describe("the registration draft kept while S-03 is read (S-02 Dialogs)", () => {
  afterEach(clearRegisterDraft);

  it("holds nothing at first", () => {
    expect(readRegisterDraft()).toBeNull();
  });

  it("keeps every value, passwords and the box included, and gives back what it was given", () => {
    saveRegisterDraft({ username: "sample_user_01", password: "a synthetic passphrase", confirmation: "a synthetic passphrase", consent: true });
    expect(readRegisterDraft()).toEqual({ username: "sample_user_01", password: "a synthetic passphrase", confirmation: "a synthetic passphrase", consent: true });
  });

  it("replaces the earlier draft, and is empty again once cleared", () => {
    saveRegisterDraft({ username: "a", password: "b", confirmation: "c", consent: true });
    saveRegisterDraft({ username: "x", password: "", confirmation: "", consent: false });
    expect(readRegisterDraft()).toEqual({ username: "x", password: "", confirmation: "", consent: false });
    clearRegisterDraft();
    expect(readRegisterDraft()).toBeNull();
  });

  it("hands out copies: changing one does not change what is kept, and changing the saved object afterwards does not either", () => {
    const values = { username: "a", password: "b", confirmation: "c", consent: false };
    saveRegisterDraft(values);
    values.username = "changed";
    const copy = readRegisterDraft();
    expect(copy?.username).toBe("a");
    if (copy) copy.password = "changed";
    expect(readRegisterDraft()?.password).toBe("b");
  });

  it("never reaches the browser's storage or the address", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    saveRegisterDraft({ username: "sample_user_01", password: "synthetic secret phrase", confirmation: "synthetic secret phrase", consent: true });
    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("secret");
    expect(JSON.stringify(window.history.state)).not.toContain("secret");
    expect(document.cookie).not.toContain("secret");
  });
});

describe("the recovery code on its way to S-04 (UA-06)", () => {
  afterEach(wipeRecoveryCode);

  it("holds nothing at first", () => {
    expect(peekRecoveryCode()).toBeNull();
  });

  it("holds the code with the screen that asked for it, until it is wiped", () => {
    holdRecoveryCode("0123-4567-89ab-cdef-0123-4567-89ab-cdef", "register");
    expect(peekRecoveryCode()).toEqual({ code: "0123-4567-89ab-cdef-0123-4567-89ab-cdef", host: "register" });
    wipeRecoveryCode();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("replaces an earlier code and hands out copies", () => {
    holdRecoveryCode("old", "register");
    holdRecoveryCode("new", "settings");
    const copy = peekRecoveryCode();
    if (copy) copy.code = "changed";
    expect(peekRecoveryCode()).toEqual({ code: "new", host: "settings" });
  });

  it("never reaches storage, the address, the history state or the title", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    document.title = "Title";
    holdRecoveryCode("0123-4567-89ab-cdef-0123-4567-89ab-cdef", "register");
    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("0123");
    expect(JSON.stringify(window.history.state)).not.toContain("0123");
    expect(document.title).toBe("Title");
    expect(document.body.textContent).not.toContain("0123");
  });
});

describe("browserTimeZone: the zone for E03, with the fallback of O-15", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function reportZone(timeZone: string | undefined) {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone }) }) as unknown as Intl.DateTimeFormat,
    );
  }

  it("is the zone the browser reports", () => {
    reportZone("Asia/Dubai");
    expect(browserTimeZone()).toBe("Asia/Dubai");
  });

  it("is UTC when the browser reports none", () => {
    reportZone(undefined);
    expect(browserTimeZone()).toBe("UTC");
    reportZone("");
    expect(browserTimeZone()).toBe("UTC");
  });

  it("is UTC when asking throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new RangeError("no zone");
    });
    expect(browserTimeZone()).toBe("UTC");
  });

  it("is a real zone name in this environment", () => {
    expect(browserTimeZone()).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/);
  });
});
