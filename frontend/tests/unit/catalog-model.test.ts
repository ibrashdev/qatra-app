import { describe, expect, it } from "vitest";
import { catalogMessages, type Counted } from "@/i18n/catalog-messages";
import { formatInteger } from "@/i18n/format";
import { sourcesMessages } from "@/i18n/sources-messages";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { mockCatalog } from "@/lib/api/mock";
import type { CatalogEdition } from "@/lib/api/types";
import { classifyCatalogError, isAlertFailure } from "@/lib/catalog/catalog-failure";
import { categoryLabel, editionTitle, groupByCategory, isPlanEditionUnavailable, planEditionOf, sectionTitle } from "@/lib/catalog/catalog-model";

const [quran, hadith] = mockCatalog.editions as [CatalogEdition, CatalogEdition];
const counted = (locale: "ar" | "en", value: number): Counted => ({ count: value, formatted: formatInteger(locale, value) });

describe("catalog model: titles by language", () => {
  it("picks the Arabic or the English title and never both", () => {
    expect(editionTitle("ar", quran)).toBe(quran.titleAr);
    expect(editionTitle("en", quran)).toBe(quran.titleEn);
    const section = quran.sections[0]!;
    expect(sectionTitle("ar", section)).toBe(section.titleAr);
    expect(sectionTitle("en", section)).toBe(section.titleEn);
    expect(categoryLabel("ar", quran.category)).toBe(quran.category.labelAr);
    expect(categoryLabel("en", quran.category)).toBe(quran.category.labelEn);
  });
});

describe("catalog model: categories", () => {
  it("lets adjacent editions of one category share its heading and keeps the order received", () => {
    const second: CatalogEdition = { ...quran, editionId: "second", editionKey: "second-edition" };
    const groups = groupByCategory([quran, second, hadith]);
    expect(groups.map((group) => group.slug)).toEqual([quran.category.slug, hadith.category.slug]);
    expect(groups[0]?.editions.map((edition) => edition.editionId)).toEqual([quran.editionId, "second"]);
    expect(groups[1]?.editions).toEqual([hadith]);
  });

  it("does not merge a category that comes back later, and does not sort", () => {
    const groups = groupByCategory([quran, hadith, { ...quran, editionId: "again" }]);
    expect(groups.map((group) => group.slug)).toEqual([quran.category.slug, hadith.category.slug, quran.category.slug]);
  });

  it("returns no group for no edition", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("catalog model: the plan's edition (S-25, O-49)", () => {
  const plan = { editionId: quran.editionId, titleAr: "عنوان", titleEn: "Title" };

  it("is unavailable only when a plan names an edition that E14 does not list", () => {
    expect(isPlanEditionUnavailable([hadith], plan)).toBe(true);
    expect(isPlanEditionUnavailable([quran, hadith], plan)).toBe(false);
    expect(isPlanEditionUnavailable([], null)).toBe(false);
    expect(isPlanEditionUnavailable([hadith], null)).toBe(false);
  });

  it("keeps only the id and the two titles of E18's plan", () => {
    expect(planEditionOf({ ...plan, extra: 1 } as typeof plan)).toEqual(plan);
    expect(planEditionOf(null)).toBeNull();
    expect(planEditionOf(undefined)).toBeNull();
  });
});

describe("catalog failures", () => {
  it("maps each way E14 can fail to what the screens show", () => {
    expect(classifyCatalogError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
    expect(classifyCatalogError(new ConnectivityError("gateway", { status: 503 }))).toEqual({ kind: "connectivity" });
    expect(classifyCatalogError(new ApiError({ status: 503, code: "unavailable", message: "Down." }))).toEqual({ kind: "unavailable" });
    expect(classifyCatalogError(new ApiError({ status: 403, code: "forbidden_origin", message: "No." }))).toEqual({ kind: "origin" });
    expect(classifyCatalogError(new ApiError({ status: 500, code: "internal", message: "Boom." }))).toEqual({ kind: "internal" });
    expect(classifyCatalogError(new Error("unknown"))).toEqual({ kind: "internal" });
    expect(classifyCatalogError(new DOMException("stop", "AbortError"))).toEqual({ kind: "aborted" });
  });

  it("reads the wait of a throttle from the error, with a fallback when the server sent none", () => {
    expect(classifyCatalogError(new ApiError({ status: 429, code: "throttled", message: "Slow.", retryAfterSec: 20 }))).toEqual({ kind: "throttled", retryAfterSec: 20 });
    expect(classifyCatalogError(new ApiError({ status: 429, code: "throttled", message: "Slow." }))).toEqual({ kind: "throttled", retryAfterSec: 60 });
  });

  it("E14 is public, so a 401 is not a session end here: it is an unexpected answer", () => {
    expect(classifyCatalogError(new ApiError({ status: 401, code: "unauthenticated", message: "Out." }))).toEqual({ kind: "internal" });
  });

  it("speaks the unexpected ones as alerts and leaves the rest polite (P-07)", () => {
    expect(isAlertFailure({ kind: "internal" })).toBe(true);
    expect(isAlertFailure({ kind: "origin" })).toBe(true);
    expect(isAlertFailure({ kind: "unavailable" })).toBe(false);
    expect(isAlertFailure({ kind: "connectivity" })).toBe(false);
    expect(isAlertFailure({ kind: "throttled", retryAfterSec: 5 })).toBe(false);
  });
});

describe("catalog messages: Arabic counted nouns (S-07 content rules)", () => {
  const ar = catalogMessages("ar");
  const sections = (value: number) => ar.facts(counted("ar", value), counted("ar", 100)).split(" · ")[0];
  const words = (value: number) => ar.facts(counted("ar", 1), counted("ar", value)).split(" · ")[1];
  const passages = (value: number) => ar.rowCounts(counted("ar", 100), counted("ar", value)).split(" · ")[1];

  it("uses the one, two, few, many and other forms of the sections noun, in Arabic-Indic digits", () => {
    expect(sections(1)).toBe("قسم واحد");
    expect(sections(2)).toBe("قسمان");
    expect(sections(3)).toBe("٣ أقسام");
    expect(sections(10)).toBe("١٠ أقسام");
    expect(sections(11)).toBe("١١ قسمًا");
    expect(sections(37)).toBe("٣٧ قسمًا");
    expect(sections(100)).toBe("١٠٠ قسم");
  });

  it("does the same for words and passages", () => {
    expect(words(1)).toBe("كلمة واحدة");
    expect(words(2)).toBe("كلمتان");
    expect(words(5)).toBe("٥ كلمات");
    expect(words(60)).toBe("٦٠ كلمةً");
    // The noun follows the last two digits of the number (CLDR), as Arabic grammar does: 1240 ends in 40, 1200 ends in 00.
    expect(words(1240)).toBe("١٢٤٠ كلمةً");
    expect(words(1200)).toBe("١٢٠٠ كلمة");
    expect(passages(1)).toBe("مقطع واحد");
    expect(passages(2)).toBe("مقطعان");
    expect(passages(4)).toBe("٤ مقاطع");
    expect(passages(12)).toBe("١٢ مقطعًا");
    expect(passages(100)).toBe("١٠٠ مقطع");
  });

  it("writes English counts with Western digits and the singular for one", () => {
    const en = catalogMessages("en");
    expect(en.facts(counted("en", 1), counted("en", 1))).toBe("1 section · 1 word");
    expect(en.facts(counted("en", 37), counted("en", 1240))).toBe("37 sections · 1240 words");
    expect(en.rowCounts(counted("en", 60), counted("en", 1))).toBe("60 words · 1 passage");
  });
});

describe("catalog messages: copy rules", () => {
  it("has the spec's fixed Arabic strings word for word", () => {
    const ar = catalogMessages("ar");
    expect(ar.screenName).toBe("تصفّح الكتب");
    expect(ar.notice).toBe("يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح.");
    expect(ar.intro).toBe("اطّلع على الكتب والأقسام المتاحة قبل إنشاء حسابك. لا يُعرض هنا نص الكتاب؛ يبدأ التعلم بعد إنشاء الحساب.");
    expect(ar.sectionsToggle("٣٧")).toBe("الأقسام (٣٧)");
    expect(ar.pathsLine("المتن، السند، الدرجة")).toBe("المسارات المتاحة: المتن، السند، الدرجة");
    expect(ar.empty).toEqual({ title: "لا توجد كتب متاحة الآن.", text: "ستظهر هنا الكتب فور نشرها." });
    expect(sourcesMessages("ar").empty).toBe("لا توجد مصادر منشورة الآن.");
    expect(sourcesMessages("ar").unavailable.chip).toBe("غير متاح");
  });

  it("has the path labels of O-18 in both languages", () => {
    expect(catalogMessages("ar").pathLabels).toEqual({ quran: "النص القرآني", matn: "المتن", sanad: "السند", grade: "الدرجة" });
    expect(catalogMessages("en").pathLabels).toEqual({ quran: "Quran text", matn: "Matn", sanad: "Sanad", grade: "Grade" });
  });

  it("writes no em dash and no en dash in any string of the two screens (D80)", () => {
    const strings: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "string") strings.push(value);
      else if (typeof value === "function") strings.push(String((value as (...args: unknown[]) => unknown)("x", "x")));
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
    };
    for (const locale of ["ar", "en"] as const) {
      collect(catalogMessages(locale));
      collect(sourcesMessages(locale));
    }
    const sample = (value: number) => counted("en", value);
    strings.push(catalogMessages("en").facts(sample(2), sample(3)), catalogMessages("ar").facts(counted("ar", 2), counted("ar", 3)));
    expect(strings.length).toBeGreaterThan(20);
    for (const text of strings) expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("never carries a link or a publisher address in a string of S-07 or S-25", () => {
    for (const locale of ["ar", "en"] as const) {
      const text = JSON.stringify([catalogMessages(locale), sourcesMessages(locale)]);
      expect(text).not.toMatch(/https?:/);
    }
  });
});
