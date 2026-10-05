import { describe, expect, it } from "vitest";
import { mockProfile } from "@/lib/api/mock/fixtures";
import type { Profile } from "@/lib/api/types";
import { classifySaveError } from "@/lib/settings/save-failure";
import { changedValues, chosenValues, pendingMinutes, pendingTimeZone } from "@/lib/settings/settings-model";
import { ApiError, ConnectivityError } from "@/lib/api/errors";

const withPending = (pendingSettings: Profile["pendingSettings"]): Profile => ({ ...mockProfile, pendingSettings });

describe("S-22 chosen values (the controls show what the learner chose last)", () => {
  it("shows the values in force when nothing is pending", () => {
    expect(chosenValues(mockProfile)).toEqual({ language: "ar", sessionMinutes: 10, timeZone: "Asia/Dubai", inApp: true });
  });

  it("shows the pending minutes and zone instead of the values in force, and keeps the language and the reminder", () => {
    const profile = { ...withPending({ sessionMinutes: 15, timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" }), language: "en" as const, reminderSettings: { inApp: false } };
    expect(chosenValues(profile)).toEqual({ language: "en", sessionMinutes: 15, timeZone: "Asia/Riyadh", inApp: false });
  });

  it("falls back per field: a pending zone alone leaves the minutes in force", () => {
    expect(chosenValues(withPending({ timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" }))).toMatchObject({ sessionMinutes: 10, timeZone: "Asia/Riyadh" });
  });
});

describe("S-22 changed values (E12 receives only what changed)", () => {
  const chosen = chosenValues(mockProfile);

  it("is empty when nothing changed", () => {
    expect(changedValues(chosen, { ...chosen })).toEqual({});
  });

  it("names each changed field once, and the reminder as exactly { inApp }", () => {
    expect(changedValues(chosen, { ...chosen, language: "en" })).toEqual({ language: "en" });
    expect(changedValues(chosen, { ...chosen, sessionMinutes: 15 })).toEqual({ sessionMinutes: 15 });
    expect(changedValues(chosen, { ...chosen, timeZone: "Asia/Riyadh" })).toEqual({ timeZone: "Asia/Riyadh" });
    expect(changedValues(chosen, { ...chosen, inApp: false })).toEqual({ reminderSettings: { inApp: false } });
    expect(changedValues(chosen, { language: "en", sessionMinutes: 5, timeZone: "Europe/London", inApp: false })).toEqual({
      language: "en",
      sessionMinutes: 5,
      timeZone: "Europe/London",
      reminderSettings: { inApp: false },
    });
  });

  it("compares with the pending value, so putting the value in force back is a change", () => {
    const pendingChosen = chosenValues(withPending({ sessionMinutes: 15, effectiveDate: "2026-10-06" }));
    expect(changedValues(pendingChosen, { ...pendingChosen })).toEqual({});
    expect(changedValues(pendingChosen, { ...pendingChosen, sessionMinutes: 10 })).toEqual({ sessionMinutes: 10 });
  });
});

describe("S-22 pending changes (c13)", () => {
  it("is null without pending settings, or when the pending object lacks the field", () => {
    expect(pendingMinutes(mockProfile)).toBeNull();
    expect(pendingTimeZone(mockProfile)).toBeNull();
    expect(pendingMinutes(withPending({ timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" }))).toBeNull();
    expect(pendingTimeZone(withPending({ sessionMinutes: 15, effectiveDate: "2026-10-06" }))).toBeNull();
  });

  it("names the value in force and the day the change starts", () => {
    const profile = withPending({ sessionMinutes: 15, timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" });
    expect(pendingMinutes(profile)).toEqual({ inForce: 10, effectiveDate: "2026-10-06" });
    expect(pendingTimeZone(profile)).toEqual({ inForce: "Asia/Dubai", effectiveDate: "2026-10-06" });
  });
});

describe("S-22 E12 failure classes", () => {
  const api = (code: string, status = 500) => new ApiError({ status, code, message: "x" });

  it("maps the codes that have their own copy", () => {
    expect(classifySaveError(api("unauthenticated", 401))).toEqual({ kind: "session_ended" });
    expect(classifySaveError(api("unavailable", 503))).toEqual({ kind: "unavailable" });
    expect(classifySaveError(api("forbidden_origin", 403))).toEqual({ kind: "origin" });
  });

  it("treats internal, validation, a throttle, an unknown code and no answer as the one save failure", () => {
    for (const error of [api("internal"), api("validation_error", 422), api("throttled", 429), api("something_new"), new ConnectivityError("network"), new TypeError("x")]) {
      expect(classifySaveError(error)).toEqual({ kind: "failed" });
    }
  });

  it("leaves a caller abort alone", () => {
    expect(classifySaveError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toEqual({ kind: "aborted" });
  });
});
