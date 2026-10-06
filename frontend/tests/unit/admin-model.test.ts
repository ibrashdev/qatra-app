import { describe, expect, it } from "vitest";
import {
  bookDeletable,
  bookErrors,
  bookPatch,
  bookTitle,
  bookValues,
  categoryDeletable,
  categoryErrors,
  categoryLabel,
  categoryPatch,
  categoryValues,
  editionLabelErrors,
  editionLabelPatch,
  fieldRuleText,
  formatCount,
  formatTimestamp,
  hasEditionActions,
  hasErrors,
  presentRows,
  sectionErrors,
  sectionPatch,
  sectionRenameAllowed,
  sectionTitle,
  sourceDeletable,
  sourceErrors,
  sourcePatch,
  sourceValues,
  statusTone,
  unitFace,
  withdrawErrors,
  withdrawReasonLabel,
} from "@/components/admin/admin-model";
import { adminMessages } from "@/i18n/admin-messages";
import type { AdminBook, AdminCategory, AdminSource } from "@/lib/api/admin-types";

const t = adminMessages("ar");

const book: AdminBook = {
  id: "b1",
  titleAr: "كتاب تجريبي",
  titleEn: "Sample book",
  author: "مؤلف تجريبي",
  contentFormat: "quran",
  category: { id: "c1", labelAr: "تصنيف" },
  editionCount: 0,
  updatedAt: "2026-10-05T08:00:00.000Z",
};
const category: AdminCategory = { id: "c1", slug: "sample", labelAr: "تصنيف", labelEn: null, displayOrder: 3, bookCount: 0, updatedAt: "2026-10-05T08:00:00.000Z" };
const source: AdminSource = {
  id: "s1",
  title: "مصدر",
  provider: "جهة",
  sourceUrl: "https://example.invalid/s",
  licenseUrl: "https://example.invalid/l",
  rightsStatus: "verified",
  checkedAt: null,
  editionCount: 0,
  updatedAt: "2026-10-05T08:00:00.000Z",
};

describe("titles", () => {
  it("shows the Arabic title in Arabic, and the English one in English with the Arabic as fallback", () => {
    expect(bookTitle("ar", book)).toBe("كتاب تجريبي");
    expect(bookTitle("en", book)).toBe("Sample book");
    expect(bookTitle("en", { ...book, titleEn: null })).toBe("كتاب تجريبي");
    expect(bookTitle("en", { ...book, titleEn: "" })).toBe("كتاب تجريبي");
    expect(categoryLabel("en", category)).toBe("تصنيف");
    expect(categoryLabel("en", { ...category, labelEn: "Category" })).toBe("Category");
    expect(sectionTitle("en", { titleAr: "قسم", titleEn: "" })).toBe("قسم");
    expect(sectionTitle("en", { titleAr: "قسم", titleEn: "Section" })).toBe("Section");
    expect(sectionTitle("ar", { titleAr: "قسم", titleEn: "Section" })).toBe("قسم");
  });
});

describe("what a row looks like", () => {
  it("tones the status: only a withdrawn edition is an error", () => {
    expect(statusTone("published")).toBe("success");
    expect(statusTone("validated")).toBe("info");
    expect(statusTone("draft")).toBe("warning");
    expect(statusTone("superseded")).toBe("neutral");
    expect(statusTone("revoked")).toBe("error");
  });

  it("shows a unit in the Quran face only for an ayah", () => {
    expect(unitFace("ayah")).toBe("quran");
    expect(unitFace("hadith_narration")).toBe("hadith");
    expect(unitFace("hadith_takhrij")).toBe("hadith");
  });

  it("writes a timestamp in UTC with the zone named, and a number the way the interface writes numbers", () => {
    const en = formatTimestamp("en", "2026-10-05T08:30:00.000Z");
    expect(en).toContain("2026");
    expect(en).toContain("08:30");
    expect(en).toContain("UTC");
    expect(formatTimestamp("ar", "2026-10-05T08:30:00.000Z")).toContain("٢٠٢٦");
    expect(formatTimestamp("en", "not a date")).toBe("not a date");
    expect(formatCount("ar", 12, t)).toBe("١٢");
    expect(formatCount("en", 12, adminMessages("en"))).toBe("12");
    expect(formatCount("ar", null, t)).toBe("غير متاح");
  });
});

describe("what may be deleted", () => {
  it("allows a delete only for a row that nothing uses", () => {
    expect(bookDeletable(book)).toBe(true);
    expect(bookDeletable({ ...book, editionCount: 1 })).toBe(false);
    expect(categoryDeletable(category)).toBe(true);
    expect(categoryDeletable({ ...category, bookCount: 2 })).toBe(false);
    expect(sourceDeletable(source)).toBe(true);
    expect(sourceDeletable({ ...source, editionCount: 3 })).toBe(false);
  });

  it("offers a section rename unless the edition is withdrawn", () => {
    expect(sectionRenameAllowed({ edition: { id: "e", editionLabel: "x", status: "published" } })).toBe(true);
    expect(sectionRenameAllowed({ edition: { id: "e", editionLabel: "x", status: "revoked" } })).toBe(false);
  });

  it("knows whether an edition has any action beyond the rename", () => {
    const none = { editLabel: true, archive: false, unarchive: false, withdraw: false, delete: false };
    expect(hasEditionActions(none)).toBe(false);
    expect(hasEditionActions({ ...none, withdraw: true })).toBe(true);
    expect(hasEditionActions({ ...none, unarchive: true })).toBe(true);
    expect(hasEditionActions({ ...none, delete: true })).toBe(true);
  });
});

describe("the edit forms send only what changed", () => {
  it("builds no body for an unchanged form, and trims what it sends", () => {
    const edition = { editionLabel: "طبعة", updatedAt: "stamp" };
    expect(editionLabelPatch(edition, { editionLabel: "  طبعة " })).toBeNull();
    expect(editionLabelPatch(edition, { editionLabel: "  طبعة جديدة " })).toEqual({ expectedUpdatedAt: "stamp", editionLabel: "طبعة جديدة" });

    expect(bookPatch(book, bookValues(book))).toBeNull();
    expect(bookPatch(book, { ...bookValues(book), author: " مؤلف آخر ", categoryId: "c2" })).toEqual({
      expectedUpdatedAt: book.updatedAt,
      author: "مؤلف آخر",
      categoryId: "c2",
    });

    expect(categoryPatch(category, categoryValues(category))).toBeNull();
    expect(categoryPatch(category, { ...categoryValues(category), displayOrder: "٧" })).toEqual({ expectedUpdatedAt: category.updatedAt, displayOrder: 7 });
    expect(categoryPatch(category, { ...categoryValues(category), displayOrder: "3" })).toBeNull();

    expect(sourcePatch(source, sourceValues(source))).toBeNull();
    expect(sourcePatch(source, { ...sourceValues(source), rightsStatus: "rejected" })).toEqual({ expectedUpdatedAt: source.updatedAt, rightsStatus: "rejected" });
  });

  it("sends null to clear an optional value, and nothing when it is still empty", () => {
    expect(bookPatch(book, { ...bookValues(book), titleEn: "" })).toEqual({ expectedUpdatedAt: book.updatedAt, titleEn: null });
    expect(bookPatch({ ...book, titleEn: null }, { ...bookValues({ ...book, titleEn: null }), titleEn: "  " })).toBeNull();
    expect(categoryPatch({ ...category, labelEn: "x" }, { labelAr: category.labelAr, labelEn: "", displayOrder: "3" })).toEqual({ expectedUpdatedAt: category.updatedAt, labelEn: null });
    expect(sourcePatch(source, { ...sourceValues(source), licenseUrl: "" })).toEqual({ expectedUpdatedAt: source.updatedAt, licenseUrl: null });
  });

  it("sends a section's titles as text only: both are NOT NULL, so there is no null and a cleared English title is an error", () => {
    const section = { titleAr: "قسم", titleEn: "Section" };
    expect(sectionPatch(section, { titleAr: "قسم", titleEn: "Section" })).toBeNull();
    expect(sectionPatch(section, { titleAr: "قسم", titleEn: "  New title  " })).toEqual({ titleEn: "New title" });
    expect(sectionPatch(section, { titleAr: "قسم جديد", titleEn: "Section" })).toEqual({ titleAr: "قسم جديد" });
    expect(sectionErrors({ titleAr: "قسم", titleEn: "" })).toEqual({ titleEn: "empty" });
    expect(sectionErrors({ titleAr: "قسم", titleEn: "   " })).toEqual({ titleEn: "empty" });
    expect(sectionErrors({ titleAr: "", titleEn: "x".repeat(121) })).toEqual({ titleAr: "empty", titleEn: "too_long" });
    expect(sectionErrors({ titleAr: "قسم", titleEn: "Section" })).toEqual({});
  });

  it("names the rule each field breaks", () => {
    expect(editionLabelErrors({ editionLabel: "" })).toEqual({ editionLabel: "empty" });
    expect(sectionErrors({ titleAr: "x".repeat(121), titleEn: "Section" })).toEqual({ titleAr: "too_long" });
    expect(bookErrors({ ...bookValues(book), author: " ", categoryId: "" })).toEqual({ author: "empty", categoryId: "choose" });
    expect(categoryErrors({ labelAr: "تصنيف", labelEn: "", displayOrder: "12000" })).toEqual({ displayOrder: "out_of_range" });
    expect(sourceErrors({ ...sourceValues(source), title: "x".repeat(201), licenseUrl: "http://x.invalid", rightsStatus: "made_up" })).toEqual({
      title: "too_long",
      licenseUrl: "https_required",
      rightsStatus: "choose",
    });
    expect(withdrawErrors({ reason: null, note: "" })).toEqual({ reason: "choose", note: "empty" });
    expect(withdrawErrors({ reason: "rights", note: "سبب" })).toEqual({});
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ a: "empty" })).toBe(true);
  });

  it("writes each rule as a line of the deck, with the limit in the digits of the language", () => {
    expect(fieldRuleText("ar", t, "empty")).toBe("هذا الحقل مطلوب.");
    expect(fieldRuleText("ar", t, "too_long", 120)).toBe("النص أطول من الحد المسموح (١٢٠ حرفًا).");
    expect(fieldRuleText("en", adminMessages("en"), "too_long", 500)).toBe("The text is longer than allowed (500 characters).");
    expect(fieldRuleText("ar", t, "out_of_range")).toBe("أدخل رقمًا بين ٠ و٩٩٩٩.");
    expect(fieldRuleText("ar", t, "https_required")).toBe("يجب أن يبدأ الرابط بـ https://");
  });
});

describe("the records of an edition, whose fields may be null", () => {
  it("makes a row only for a value that is there", () => {
    const rows = presentRows([
      ["who", "owner", (value) => value.toUpperCase()],
      ["at", null, (value) => value],
      ["scope", "", (value) => value],
      ["words", "عبارة", (value) => `[${value}]`],
    ]);
    expect(rows).toEqual([
      { label: "who", value: "OWNER" },
      { label: "words", value: "[عبارة]" },
    ]);
    expect(presentRows([["a", null, (value) => value]])).toEqual([]);
  });

  it("names a withdrawal reason from the deck, and shows a code it does not know as it is", () => {
    expect(withdrawReasonLabel(t, "transmission")).toBe("خلل في النقل");
    expect(withdrawReasonLabel(t, "rights")).toBe("حقوق النشر");
    expect(withdrawReasonLabel(t, "accreditation")).toBe("الاعتماد العلمي");
    expect(withdrawReasonLabel(t, "something_new")).toBe("something_new");
    expect(withdrawReasonLabel(adminMessages("en"), "rights")).toBe("Copyright");
  });
});
