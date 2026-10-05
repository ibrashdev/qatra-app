import { describe, expect, it } from "vitest";
import { classifyTodayError, isAlertFailure } from "@/components/today/today-failure";
import { addDays, currentStage, daysBetween, formatLearningDate, inactivePlan, isReturnAfterAbsence, minutesOf, pendingMinutes, upcomingReviewDate } from "@/components/today/today-model";
import { todayMessages } from "@/i18n/today-messages";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { mockToday } from "@/lib/api/mock/fixtures";
import { mockProgress } from "@/lib/api/mock/today-handlers";
import type { PlanProgress, ProgressResponse, Today } from "@/lib/api/types";

// The mock progress always holds its one plan and two sections; the helpers say so once, because indexed reads may be undefined.
function onlyPlan(): PlanProgress {
  const plan = mockProgress.plans[0];
  if (plan === undefined) throw new Error("The mock progress has no plan.");
  return plan;
}

const apiError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  new ApiError({ status, code, message: "x", details, retryAfterSec: typeof details.retryAfterSec === "number" ? details.retryAfterSec : null });

describe("S-11 current stage (the section of nextNewPassage)", () => {
  it("takes the title and percent of the matching E19 section", () => {
    expect(currentStage(mockToday, mockProgress)).toEqual({ titleAr: "اسم القسم (عنصر نائب) ١", titleEn: "Section placeholder 1", percent: 40 });
  });

  it("breaks a tie between sections with the same title by the reference", () => {
    const plan = onlyPlan();
    const twin = { ...plan, sections: plan.sections.map((section) => ({ ...section, titleAr: "«اسم السورة»" })) };
    const today: Today = { ...mockToday, nextNewPassage: { reference: "2:1-5", sectionTitleAr: "«اسم السورة»" } };
    expect(currentStage(today, { ...mockProgress, plans: [twin] })?.titleEn).toBe("Section placeholder 2");
    expect(currentStage(today, { ...mockProgress, plans: [twin] })?.percent).toBe(0);
  });

  it("loses the percent when E19 failed, and keeps the title from E18", () => {
    expect(currentStage(mockToday, null)).toEqual({ titleAr: "اسم القسم (عنصر نائب) ١", titleEn: null, percent: null });
  });

  it("is null with no plan or no next passage (near horizon)", () => {
    expect(currentStage({ ...mockToday, nextNewPassage: null }, mockProgress)).toBeNull();
    expect(currentStage({ ...mockToday, plan: null }, mockProgress)).toBeNull();
  });

  it("caps a percent above 100", () => {
    const plan = onlyPlan();
    const high: ProgressResponse = { ...mockProgress, plans: [{ ...plan, sections: plan.sections.map((section) => ({ ...section, percent: 140 })) }] };
    expect(currentStage(mockToday, high)?.percent).toBe(100);
  });
});

describe("S-11 plans that E18 does not carry, and the next review date", () => {
  it("finds a completed or paused plan in E19", () => {
    const plan = onlyPlan();
    const progress: ProgressResponse = { ...mockProgress, plans: [{ ...plan, status: "completed" }, { ...plan, planId: "p2", status: "paused" }] };
    expect(inactivePlan(progress, "completed")?.planId).toBe(plan.planId);
    expect(inactivePlan(progress, "paused")?.planId).toBe("p2");
    expect(inactivePlan(null, "paused")).toBeNull();
  });

  it("shows only a review date that is still ahead", () => {
    const planId = onlyPlan().planId;
    expect(upcomingReviewDate(mockProgress, planId, "2026-10-05")).toBe("2026-10-06");
    expect(upcomingReviewDate(mockProgress, planId, "2026-10-06")).toBeNull();
    expect(upcomingReviewDate(null, planId, "2026-10-05")).toBeNull();
  });
});

describe("S-11 dates", () => {
  it("adds days and counts them from the date parts", () => {
    expect(addDays("2026-10-05", 1)).toBe("2026-10-06");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(daysBetween("2026-10-01", "2026-10-05")).toBe(4);
    expect(daysBetween("bad", "2026-10-05")).toBeNull();
  });

  it("writes a learning date in the digits of the language, without a time zone", () => {
    expect(formatLearningDate("ar", "2026-10-06")).toBe("٦ أكتوبر ٢٠٢٦");
    expect(formatLearningDate("en", "2026-10-06")).toBe("October 6, 2026");
    expect(formatLearningDate("en", "not a date")).toBe("not a date");
  });

  it("reads whole minutes", () => {
    expect(minutesOf(420_000)).toBe(7);
    expect(minutesOf(59_999)).toBe(0);
  });
});

describe("S-11 return after absence (G-30, derived from E19 history, O-25)", () => {
  const idle: Today = { ...mockToday, dailyActiveMs: 0, dailyPercent: 0, openSessionId: null };
  const history = (date: string, activeMs = 300_000): ProgressResponse => ({ ...mockProgress, history: [{ date, activeMs, goalMs: 600_000, completed: false }] });

  it("is true after three or more days without activity", () => {
    expect(isReturnAfterAbsence(idle, history("2026-10-02"))).toBe(true);
    expect(isReturnAfterAbsence(idle, history("2026-10-01"))).toBe(true);
  });

  it("is false after a shorter gap, a new plan, activity today, an open session or a failed E19", () => {
    expect(isReturnAfterAbsence(idle, history("2026-10-03"))).toBe(false);
    expect(isReturnAfterAbsence(idle, { ...mockProgress, history: [] })).toBe(false);
    expect(isReturnAfterAbsence(idle, history("2026-10-01", 0))).toBe(false);
    expect(isReturnAfterAbsence({ ...idle, dailyActiveMs: 60_000 }, history("2026-10-01"))).toBe(false);
    expect(isReturnAfterAbsence({ ...idle, openSessionId: "s" }, history("2026-10-01"))).toBe(false);
    expect(isReturnAfterAbsence(idle, null)).toBe(false);
  });

  it("uses the latest active day, whatever the order of the list", () => {
    const progress: ProgressResponse = {
      ...mockProgress,
      history: [
        { date: "2026-10-04", activeMs: 1000, goalMs: 1, completed: false },
        { date: "2026-09-20", activeMs: 1000, goalMs: 1, completed: false },
      ],
    };
    expect(isReturnAfterAbsence(idle, progress)).toBe(false);
  });
});

describe("S-11 pending setting (G-32)", () => {
  it("reads the plan's pending minutes only when set", () => {
    expect(pendingMinutes(mockToday)).toBeNull();
    expect(pendingMinutes({ ...mockToday, plan: mockToday.plan === null ? null : { ...mockToday.plan, pendingSessionMinutes: 5 } })).toBe(5);
    expect(pendingMinutes({ ...mockToday, plan: mockToday.plan === null ? null : { ...mockToday.plan, pendingSessionMinutes: null } })).toBeNull();
  });
});

describe("S-11 failures", () => {
  it("maps the documented answers of E18, E19 and E20", () => {
    expect(classifyTodayError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
    expect(classifyTodayError(apiError(401, "unauthenticated"))).toEqual({ kind: "session_ended" });
    expect(classifyTodayError(apiError(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyTodayError(apiError(500, "internal"))).toEqual({ kind: "internal" });
    expect(classifyTodayError(apiError(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifyTodayError(apiError(429, "throttled", { retryAfterSec: 12 }))).toEqual({ kind: "throttled", retryAfterSec: 12 });
    expect(classifyTodayError(apiError(409, "version_conflict", { reason: "plan_version", currentVersion: 3 }))).toEqual({ kind: "plan_version" });
    expect(classifyTodayError(apiError(409, "version_conflict", { reason: "plan_not_active" }))).toEqual({ kind: "plan_not_active" });
    expect(classifyTodayError(Object.assign(new Error("x"), { name: "AbortError" }))).toEqual({ kind: "aborted" });
  });

  it("reads edition_not_available from a code, a reason or a field rule", () => {
    expect(classifyTodayError(apiError(422, "edition_not_available"))).toEqual({ kind: "revoked" });
    expect(classifyTodayError(apiError(422, "validation_error", { reason: "edition_not_available" }))).toEqual({ kind: "revoked" });
    expect(classifyTodayError(apiError(422, "validation_error", { fields: [{ field: "planId", rule: "edition_not_available" }] }))).toEqual({ kind: "revoked" });
    expect(classifyTodayError(apiError(422, "validation_error", { fields: [{ field: "kind", rule: "kind_invalid" }] }))).toEqual({ kind: "internal" });
  });

  it("treats an unknown answer as internal, and reads the errors raised by a press as alerts", () => {
    expect(classifyTodayError(apiError(409, "version_conflict", { reason: "estimate_changed" }))).toEqual({ kind: "internal" });
    expect(classifyTodayError(new TypeError("boom"))).toEqual({ kind: "internal" });
    expect(isAlertFailure({ kind: "internal" })).toBe(true);
    expect(isAlertFailure({ kind: "revoked" })).toBe(true);
    expect(isAlertFailure({ kind: "unavailable" })).toBe(false);
  });
});

describe("S-11 catalog", () => {
  it("has Arabic and English for the same keys, and no em dash in either", () => {
    const ar = JSON.stringify(todayMessages("ar"), (_key, value) => (typeof value === "function" ? value.toString() : value));
    const en = JSON.stringify(todayMessages("en"), (_key, value) => (typeof value === "function" ? value.toString() : value));
    expect(Object.keys(todayMessages("ar"))).toEqual(Object.keys(todayMessages("en")));
    const dash = String.fromCharCode(0x2014);
    expect(ar).not.toContain(dash);
    expect(en).not.toContain(dash);
  });

  it("builds the plural nouns of the minutes and words line", () => {
    const { daily } = todayMessages("ar");
    expect(daily.text("٥", 5, "٢٥", 25)).toBe("٥ دقائق يوميًا، وحتى ٢٥ كلمة جديدة في اليوم");
    expect(daily.text("١٥", 15, "٨", 8)).toBe("١٥ دقيقة يوميًا، وحتى ٨ كلمات جديدة في اليوم");
    expect(todayMessages("en").daily.text("10", 10, "1", 1)).toBe("10 minutes a day, up to 1 new word a day");
  });
});
