import { describe, expect, it } from "vitest";
import { classifyPlanError, isAlertPlanFailure, isTodayFailure } from "@/components/plan-overview/plan-failure";
import { editionOf, goalLines, nextStep, otherPlans, pathLabels, scopeLine, stageLabel, stageRows } from "@/components/plan-overview/plan-overview-model";
import { daysPhrase, planOverviewMessages } from "@/i18n/plan-overview-messages";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { mockCatalog, mockToday } from "@/lib/api/mock/fixtures";
import { MOCK_COMPLETED_PLAN_ID, MOCK_PAUSED_PLAN_ID, mockProgressWithOtherPlans } from "@/lib/api/mock/plan-handlers";
import { mockProgress } from "@/lib/api/mock/today-handlers";
import type { Plan, Today } from "@/lib/api/types";

const plan = mockToday.plan as Plan;
const quran = mockCatalog.editions[0] ?? null;
const hadith = mockCatalog.editions[1] ?? null;

const apiError = (code: string, details: Record<string, unknown> = {}, status = 409) => new ApiError({ status, code, message: "x", details });

describe("S-12 model: stages", () => {
  it("lists the sections of E19 in book order and marks the section of the next passage as current", () => {
    const rows = stageRows(plan, mockProgress, mockToday);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(rows.map((row) => row.current)).toEqual([true, false]);
    expect(rows[0]).toMatchObject({ percent: 40, status: "learning" });
  });

  it("reverses the list for the reverse order and keeps the current marker on its section", () => {
    const rows = stageRows({ ...plan, order: "reverse" }, mockProgress, mockToday);
    expect(rows.map((row) => row.ordinal)).toEqual([2, 1]);
    expect(rows.map((row) => row.current)).toEqual([false, true]);
  });

  it("marks nothing when there is no next passage, and lists nothing without E19", () => {
    const near: Today = { ...mockToday, nextNewPassage: null };
    expect(stageRows(plan, mockProgress, near).some((row) => row.current)).toBe(false);
    expect(stageRows(plan, null, mockToday)).toEqual([]);
  });

  it("breaks a tie between sections with the same title by the reference of the passage", () => {
    const progress = {
      ...mockProgress,
      plans: mockProgress.plans.map((entry) => ({ ...entry, sections: entry.sections.map((section) => ({ ...section, titleAr: "العنوان نفسه" })) })),
    };
    const today: Today = { ...mockToday, nextNewPassage: { reference: "2:1-5", sectionTitleAr: "العنوان نفسه" } };
    expect(stageRows(plan, progress, today).map((row) => row.current)).toEqual([false, true]);
  });

  it("clamps a percent that is out of range", () => {
    const progress = { ...mockProgress, plans: mockProgress.plans.map((entry) => ({ ...entry, sections: entry.sections.map((section) => ({ ...section, percent: 140 })) })) };
    expect(stageRows(plan, progress, mockToday).every((row) => row.percent === 100)).toBe(true);
  });

  it("shows the English title in the English interface, and an Arabic one with its own language when there is no English title", () => {
    expect(stageLabel("en", { titleAr: "أ", titleEn: "A" })).toEqual({ text: "A", lang: "en" });
    expect(stageLabel("en", { titleAr: "أ", titleEn: "" })).toEqual({ text: "أ", lang: "ar" });
    expect(stageLabel("ar", { titleAr: "أ", titleEn: "A" })).toEqual({ text: "أ", lang: "ar" });
  });
});

describe("S-12 model: other plans, goal lines and next step", () => {
  it("lists the paused plans first, then the completed ones, and never the active plan", () => {
    const rows = otherPlans(mockProgressWithOtherPlans, plan.planId);
    expect(rows.map((row) => row.planId)).toEqual([MOCK_PAUSED_PLAN_ID, MOCK_COMPLETED_PLAN_ID]);
    expect(otherPlans(mockProgressWithOtherPlans, null).map((row) => row.status)).toEqual(["paused", "completed"]);
    expect(otherPlans(null, null)).toEqual([]);
  });

  it("states the scope as «all sections» or «n of m», and not at all without the edition", () => {
    expect(scopeLine("ar", plan, quran)).toBe("كل الأقسام");
    expect(scopeLine("ar", { ...plan, targetScope: { sectionOrdinals: [1] } }, quran)).toBe("١ من ٢ سورة");
    expect(scopeLine("en", { ...plan, targetScope: { sectionOrdinals: [1] } }, quran)).toBe("1 of 2 surahs");
    expect(scopeLine("ar", plan, null)).toBeNull();
  });

  it("labels the hadith paths in the fixed order and gives the Quran path no label", () => {
    expect(pathLabels("ar", ["grade", "matn"])).toEqual(["متن", "الدرجة"]);
    expect(pathLabels("en", ["quran"])).toEqual([]);
  });

  it("builds the goal lines: title and edition, then scope, order (Quran only) and the date", () => {
    const t = planOverviewMessages("ar");
    expect(goalLines("ar", t, plan, quran)).toEqual({
      head: "عنوان الكتاب (عنصر نائب) · تسمية الطبعة (عنصر نائب)",
      detail: "كل الأقسام؛ ترتيب الكتاب؛ الموعد المفضل: ٢٠ أكتوبر ٢٠٢٦",
    });
    const hadithPlan: Plan = { ...plan, editionId: hadith?.editionId ?? "", paths: ["matn", "sanad"], preferredDate: null };
    expect(goalLines("ar", t, hadithPlan, hadith).detail).toBe("كل الأقسام؛ المسارات: متن، سند؛ دون موعد محدد");
    expect(goalLines("en", planOverviewMessages("en"), plan, null)).toEqual({ head: "Book title (placeholder)", detail: "Book order; Preferred date: October 20, 2026" });
  });

  it("finds the edition of the plan in E14, or null", () => {
    expect(editionOf({ editions: [...mockCatalog.editions] }, plan)?.editionId).toBe(plan.editionId);
    expect(editionOf(null, plan)).toBeNull();
    expect(editionOf({ editions: [] }, plan)).toBeNull();
  });

  it("chooses the next passage, else the next review date, else the maintenance line", () => {
    expect(nextStep(mockToday, mockProgress, plan.planId)).toEqual({ kind: "passage", section: "اسم القسم (عنصر نائب) ١", reference: "1" });
    expect(nextStep({ ...mockToday, nextNewPassage: null }, mockProgress, plan.planId)).toEqual({ kind: "review", date: "2026-10-06" });
    expect(nextStep({ ...mockToday, nextNewPassage: null }, null, plan.planId)).toEqual({ kind: "none" });
  });

  it("writes the days in the Arabic number forms and the English noun", () => {
    expect(daysPhrase("ar", 1, "١")).toBe("يوم واحد");
    expect(daysPhrase("ar", 2, "٢")).toBe("يومين");
    expect(daysPhrase("ar", 3, "٣")).toBe("٣ أيام");
    expect(daysPhrase("ar", 16, "١٦")).toBe("١٦ يومًا");
    expect(daysPhrase("en", 1, "1")).toBe("1 day");
    expect(daysPhrase("en", 16, "16")).toBe("16 days");
  });
});

describe("S-12 and S-13 model: failures", () => {
  it("reads the codes of a write of the plan", () => {
    expect(classifyPlanError(apiError("forbidden", {}, 403))).toEqual({ kind: "forbidden" });
    expect(classifyPlanError(apiError("not_found", {}, 404))).toEqual({ kind: "not_found" });
    expect(classifyPlanError(apiError("version_conflict", { reason: "plan_not_active" }))).toEqual({ kind: "plan_not_active" });
    expect(classifyPlanError(apiError("version_conflict", { reason: "plan_version", currentVersion: 2 }))).toEqual({ kind: "plan_version" });
    expect(classifyPlanError(apiError("unauthenticated", {}, 401))).toEqual({ kind: "session_ended" });
    expect(classifyPlanError(apiError("unavailable", {}, 503))).toEqual({ kind: "unavailable" });
    expect(classifyPlanError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
  });

  it("carries the fresh estimate of `estimate_changed` and drops one that is not an estimate", () => {
    const estimate = { days: 8, endDate: "2026-10-13", newWordsPerDay: 25, sessionMinutes: 10 };
    expect(classifyPlanError(apiError("version_conflict", { reason: "estimate_changed", estimate }))).toEqual({ kind: "estimate_changed", estimate });
    expect(classifyPlanError(apiError("version_conflict", { reason: "estimate_changed", estimate: "no" }))).toEqual({ kind: "estimate_changed", estimate: null });
  });

  it("separates revoked content from field rules in a 422", () => {
    const revoked = apiError("validation_error", { fields: [{ field: "editionId", rule: "edition_not_available" }] }, 422);
    expect(classifyPlanError(revoked)).toEqual({ kind: "revoked" });
    const fields = apiError("validation_error", { fields: [{ field: "preferredDate", rule: "date_invalid" }, { field: "x", rule: 5 }] }, 422);
    expect(classifyPlanError(fields)).toEqual({ kind: "validation", rules: ["date_invalid"] });
    expect(classifyPlanError(apiError("validation_error", {}, 422))).toEqual({ kind: "validation", rules: [] });
  });

  it("keeps an unknown answer generic and tells the failures of S-11 from the new ones", () => {
    const unknown = classifyPlanError(apiError("something_else", {}, 418));
    expect(unknown).toEqual({ kind: "internal" });
    expect(isTodayFailure(unknown)).toBe(true);
    expect(isTodayFailure({ kind: "forbidden" })).toBe(false);
    expect(isAlertPlanFailure({ kind: "internal" })).toBe(true);
    expect(isAlertPlanFailure({ kind: "validation", rules: [] })).toBe(true);
    expect(isAlertPlanFailure({ kind: "forbidden" })).toBe(false);
    expect(isAlertPlanFailure({ kind: "plan_not_active" })).toBe(false);
  });
});
