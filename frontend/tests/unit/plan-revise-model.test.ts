import { describe, expect, it } from "vitest";
import {
  changedFields,
  estimateDiffers,
  estimateRequest,
  fieldErrorsOf,
  formFromPlan,
  goalTextFor,
  hadithPathsOf,
  hasChange,
  reasonFor,
  revisionBody,
  startRequest,
} from "@/components/plan-revise/revise-model";
import { MOCK_HADITH_EDITION_ID, MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockCatalog, mockToday } from "@/lib/api/mock/fixtures";
import type { Estimate, Plan } from "@/lib/api/types";

const quranPlan = mockToday.plan as Plan;
const quran = mockCatalog.editions[0] ?? null;
const hadith = mockCatalog.editions[1] ?? null;
const hadithPlan: Plan = { ...quranPlan, editionId: MOCK_HADITH_EDITION_ID, titleAr: "عنوان المجموعة (عنصر نائب)", titleEn: "Collection title (placeholder)", paths: ["matn", "sanad"], targetScope: { sectionOrdinals: [1] } };

describe("S-13 model: the form and what it changed", () => {
  it("starts from the plan in force", () => {
    expect(formFromPlan(quranPlan)).toEqual({ minutes: 10, date: "2026-10-20", paths: [], order: "book" });
    expect(formFromPlan(hadithPlan).paths).toEqual(["matn", "sanad"]);
    expect(formFromPlan({ ...quranPlan, preferredDate: null }).date).toBe("");
  });

  it("is unchanged when nothing differs, and E17 then has nothing to send", () => {
    const form = formFromPlan(quranPlan);
    expect(changedFields(quranPlan, form)).toEqual({});
    expect(hasChange(quranPlan, form)).toBe(false);
  });

  it("reports the minutes, the date and, for the Quran, the order", () => {
    expect(changedFields(quranPlan, { ...formFromPlan(quranPlan), minutes: 15 })).toEqual({ sessionMinutes: 15 });
    expect(changedFields(quranPlan, { ...formFromPlan(quranPlan), date: "2026-11-01" })).toEqual({ preferredDate: "2026-11-01" });
    expect(changedFields(quranPlan, { ...formFromPlan(quranPlan), order: "reverse" })).toEqual({ order: "reverse" });
  });

  it("does not count an emptied date as a change, because E17 cannot clear a date", () => {
    expect(hasChange(quranPlan, { ...formFromPlan(quranPlan), date: "" })).toBe(false);
  });

  it("reports hadith paths in the fixed order and only for a hadith plan", () => {
    expect(changedFields(hadithPlan, { ...formFromPlan(hadithPlan), paths: ["matn", "sanad", "grade"] })).toEqual({ paths: ["matn", "sanad", "grade"] });
    expect(changedFields(hadithPlan, { ...formFromPlan(hadithPlan), paths: ["sanad", "matn"] })).toEqual({});
    expect(changedFields(hadithPlan, { ...formFromPlan(hadithPlan), order: "reverse" })).toEqual({});
    expect(changedFields(quranPlan, { ...formFromPlan(quranPlan), paths: ["matn"] })).toEqual({});
    expect(hadithPathsOf(["grade", "quran", "matn"])).toEqual(["matn", "grade"]);
  });
});

describe("S-13 model: the three requests", () => {
  it("builds E15 from the plan's edition, scope and paths and the form's minutes, date and order, with no placement session", () => {
    expect(estimateRequest(quranPlan, { ...formFromPlan(quranPlan), minutes: 15 })).toEqual({
      editionId: MOCK_QURAN_EDITION_ID,
      targetScope: { sectionOrdinals: [1, 2] },
      paths: ["quran"],
      sessionMinutes: 15,
      preferredDate: "2026-10-20",
      order: "book",
    });
    const noDate = estimateRequest({ ...quranPlan, preferredDate: null }, formFromPlan({ ...quranPlan, preferredDate: null }));
    expect("preferredDate" in noDate).toBe(false);
    expect("placementSessionId" in noDate).toBe(false);
    expect(estimateRequest(hadithPlan, { ...formFromPlan(hadithPlan), paths: ["matn"] })).toMatchObject({ paths: ["matn"], order: "book" });
  });

  it("builds E17 with the version, only the changed fields and the confirmed estimate when the estimate changed", () => {
    const fresh: Estimate = { ...quranPlan.agreedEstimate, days: 3, endDate: "2026-10-08", newWordsPerDay: 40, sessionMinutes: 15 };
    expect(revisionBody(quranPlan, { ...formFromPlan(quranPlan), minutes: 15 }, fresh)).toEqual({ expectedVersion: 1, sessionMinutes: 15, confirmedEstimate: fresh });
    expect(revisionBody(quranPlan, { ...formFromPlan(quranPlan), minutes: 15 }, null)).toEqual({ expectedVersion: 1, sessionMinutes: 15 });
    expect(revisionBody(quranPlan, { ...formFromPlan(quranPlan), date: "2026-11-01" }, quranPlan.agreedEstimate)).toEqual({ expectedVersion: 1, preferredDate: "2026-11-01" });
  });

  it("tells a changed estimate from the one the plan already agreed", () => {
    const agreed = quranPlan.agreedEstimate;
    expect(estimateDiffers(agreed, { ...agreed })).toBe(false);
    expect(estimateDiffers(agreed, { ...agreed, days: 3 })).toBe(true);
    expect(estimateDiffers(agreed, { ...agreed, paths: ["matn"] })).toBe(true);
    expect(estimateDiffers(agreed, { ...agreed, scope: { sectionOrdinals: [1] } })).toBe(true);
  });

  it("builds E31 with the plan's own parameters and the plan id, and no placement session or order", () => {
    const request = startRequest("ar", quranPlan, quran, "2026-10-05");
    expect(request).toMatchObject({ editionId: MOCK_QURAN_EDITION_ID, targetScope: { sectionOrdinals: [1, 2] }, paths: ["quran"], sessionMinutes: 10, preferredDate: "2026-10-20", language: "ar", planId: MOCK_PLAN_ID });
    expect("placementSessionId" in request).toBe(false);
    expect("order" in request).toBe(false);
  });

  it("leaves out a preferred date that has already passed, because E31 would refuse it", () => {
    expect("preferredDate" in startRequest("ar", quranPlan, quran, "2026-10-21")).toBe(false);
    expect("preferredDate" in startRequest("ar", quranPlan, quran, "2026-10-20")).toBe(true);
    expect("preferredDate" in startRequest("ar", { ...quranPlan, preferredDate: null }, quran, "2026-10-05")).toBe(false);
  });
});

describe("S-13 model: the composed goal sentence (O-23)", () => {
  it("is the sentence of S-08 built from the plan, in the interface language", () => {
    const ar = goalTextFor("ar", quranPlan, quran);
    expect(ar).toContain("كل الأقسام");
    expect(ar).toContain("١٠ دقائق");
    expect(ar).toContain("٢٠ أكتوبر ٢٠٢٦");
    const en = goalTextFor("en", quranPlan, quran);
    expect(en).toContain("all sections");
    expect(en).toContain("10 minutes");
    expect(en).toContain("October 20, 2026");
  });

  it("names the section when one of a few is in the plan, and the hadith paths", () => {
    expect(goalTextFor("ar", { ...quranPlan, targetScope: { sectionOrdinals: [1] } }, quran)).toContain("اسم القسم (عنصر نائب) ١");
    const text = goalTextFor("ar", hadithPlan, hadith);
    expect(text).toContain("المتن");
    expect(text).toContain("السند");
  });

  it("says there is no set date for a plan with none", () => {
    expect(goalTextFor("ar", { ...quranPlan, preferredDate: null }, quran)).toContain("دون موعد محدد");
  });

  it("falls back to the plan title without the edition, and never passes 500 characters", () => {
    expect(goalTextFor("ar", quranPlan, null)).toBe("عنوان الكتاب (عنصر نائب)");
    expect(goalTextFor("en", quranPlan, null)).toBe("Book title (placeholder)");
    const long = { ...quranPlan, titleAr: "ا".repeat(900) };
    expect(Array.from(goalTextFor("ar", long, null)).length).toBeLessThanOrEqual(500);
    const longEdition = quran === null ? null : { ...quran, titleAr: "ب".repeat(900) };
    expect(Array.from(goalTextFor("ar", quranPlan, longEdition)).length).toBeLessThanOrEqual(500);
  });
});

describe("S-13 model: rules and reasons", () => {
  it("maps each 422 rule that has a field to that field, and ignores the others", () => {
    expect(fieldErrorsOf(["date_invalid", "paths_invalid", "order_not_available", "session_minutes_invalid"])).toEqual({
      date: "date_invalid",
      paths: "paths_invalid",
      order: "order_not_available",
      minutes: "session_minutes_invalid",
    });
    expect(fieldErrorsOf(["path_not_available"])).toEqual({ paths: "path_not_available" });
    expect(fieldErrorsOf(["forbidden_field", "no_fields"])).toEqual({});
  });

  it("derives the reason line of a fresh estimate the way the server does", () => {
    const estimate = { ...quranPlan.agreedEstimate, endDate: "2026-10-10" };
    expect(reasonFor(estimate, "")).toBe("no_preferred_date");
    expect(reasonFor(estimate, "2026-10-10")).toBe("fits_preferred_date");
    expect(reasonFor(estimate, "2026-10-09")).toBe("exceeds_preferred_date");
  });
});
