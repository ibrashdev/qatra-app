// The rules of S-08 (UI-screens S-08 "Selection rules (D78)", "Goal box", "Validation"; UI-tokens 6.26) over the pure model, with synthetic catalog data.
import { describe, expect, it } from "vitest";
import type { CatalogEdition, CatalogSection } from "@/lib/api/types";
import { composeGoal, formatLearningDate } from "@/components/start/goal-sentence";
import {
  buildSelection,
  checkedPaths,
  chooseBook,
  chooseCategory,
  chooseView,
  clearOrdinals,
  countCodePoints,
  countState,
  EMPTY_FORM,
  groupCategories,
  isDateRejected,
  juzState,
  listKind,
  localizeDigits,
  MAX_SECTIONS,
  nextStep,
  readStartForm,
  removeOrdinals,
  resolveCascade,
  selectAll,
  selectedOrdinals,
  todayIn,
  toggleJuz,
  toggleOrdinal,
  togglePath,
  type StartForm,
} from "@/components/start/start-model";

function section(ordinal: number, kind: CatalogSection["kind"], paths: CatalogSection["paths"]): CatalogSection {
  return {
    sectionId: `section-${kind}-${ordinal}`,
    ordinal,
    kind,
    reference: String(ordinal),
    titleAr: `عنصر تجريبي ${ordinal}`,
    titleEn: `Sample item ${ordinal}`,
    wordCount: 10,
    passageCount: 1,
    paths,
  };
}

function edition(id: string, category: { slug: string; labelAr: string; labelEn: string }, format: CatalogEdition["contentFormat"], sections: CatalogSection[], title = id): CatalogEdition {
  const hadith = format === "hadith_collection";
  return {
    editionId: id,
    editionKey: id,
    titleAr: `كتاب ${title}`,
    titleEn: `Book ${title}`,
    author: "مؤلف تجريبي",
    editionLabel: "طبعة تجريبية",
    category,
    catalogVersion: 1,
    contentFormat: format,
    availablePaths: hadith ? ["matn", "sanad", "grade"] : ["quran"],
    defaultPaths: hadith ? ["matn"] : ["quran"],
    defaultOrder: "book",
    totalWords: 100,
    sections,
  };
}

const QURAN = { slug: "quran", labelAr: "القرآن الكريم", labelEn: "The Quran" };
const HADITH = { slug: "hadith", labelAr: "الحديث", labelEn: "Hadith" };
const FIQH = { slug: "fiqh", labelAr: "الفقه", labelEn: "Fiqh" };

const quranEdition = edition("quran-1", QURAN, "quran", [1, 2, 3, 4, 5].map((n) => section(n, "surah", ["quran"])));
const hadithEdition = edition("hadith-1", HADITH, "hadith_collection", [1, 2, 3, 4].map((n) => section(n, "hadith", ["matn", "sanad", "grade"])));
const hadithEditionTwo = edition("hadith-2", HADITH, "hadith_collection", [1, 2].map((n) => section(n, "hadith", ["matn", "sanad", "grade"])), "two");
const fiqhEdition = edition("fiqh-1", FIQH, "hadith_collection", [1, 2].map((n) => section(n, "hadith", ["matn"])), "fiqh");

const groups = groupCategories([quranEdition, hadithEdition, hadithEditionTwo]);

function form(overrides: Partial<StartForm> = {}): StartForm {
  return { ...EMPTY_FORM, ...overrides };
}

describe("the categories and the levels (D78)", () => {
  it("lists each category once, in the order E14 returns them, with its books", () => {
    expect(groups.map((group) => group.slug)).toEqual(["quran", "hadith"]);
    expect(groups[1]?.editions.map((entry) => entry.editionId)).toEqual(["hadith-1", "hadith-2"]);
    expect(groups.map((group) => group.isQuran)).toEqual([true, false]);
  });

  it("shows only level 1 at first, and the helper names the category", () => {
    const cascade = resolveCascade(form(), groups);
    expect(cascade.category).toBeNull();
    expect(cascade.showBooks || cascade.showView || cascade.mode !== null).toBe(false);
    expect(nextStep(form(), cascade)).toBe("category");
  });

  it("treats a level with one option as chosen: one category counts as chosen without a press", () => {
    const only = groupCategories([quranEdition]);
    const cascade = resolveCascade(form(), only);
    expect(cascade.category?.slug).toBe("quran");
    expect(cascade.showView).toBe(true);
    expect(nextStep(form(), cascade)).toBe("view");
  });

  it("gives the Quran no book list (one edition, O-56) and asks how to select", () => {
    const f = chooseCategory(form(), "quran");
    const cascade = resolveCascade(f, groups);
    expect(cascade.showBooks).toBe(false);
    expect(cascade.edition?.editionId).toBe("quran-1");
    expect(cascade.showView).toBe(true);
    expect(cascade.mode).toBeNull();
    expect(nextStep(f, cascade)).toBe("view");
  });

  it("lists the books of a hadith category and asks for one while several are offered", () => {
    const f = chooseCategory(form(), "hadith");
    const cascade = resolveCascade(f, groups);
    expect(cascade.showBooks).toBe(true);
    expect(cascade.edition).toBeNull();
    expect(nextStep(f, cascade)).toBe("book");
    const chosen = chooseBook(f, "hadith-2");
    expect(resolveCascade(chosen, groups).edition?.editionId).toBe("hadith-2");
  });

  it("preselects a single book: level 3 appears at once and the path boxes with it", () => {
    const only = groupCategories([hadithEdition]);
    const cascade = resolveCascade(form(), only);
    expect(cascade.edition?.editionId).toBe("hadith-1");
    expect(cascade.mode).toBe("book");
    expect(cascade.pathChoices).toEqual(["matn", "sanad", "grade"]);
    expect(nextStep(form(), cascade)).toBe("hadith");
  });

  it("names the next step by the list on screen: surah, juz', hadith or section", () => {
    const base = chooseCategory(form(), "quran");
    expect(nextStep(chooseView(base, "surah"), resolveCascade(chooseView(base, "surah"), groups))).toBe("surah");
    expect(nextStep(chooseView(base, "juz"), resolveCascade(chooseView(base, "juz"), groups))).toBe("juz");
    const generic = groupCategories([fiqhEdition, { ...fiqhEdition, editionId: "fiqh-2", sections: [section(1, "surah", ["matn"]), section(2, "hadith", ["matn"])] }]);
    const cascade = resolveCascade(chooseBook(chooseCategory(form(), "fiqh"), "fiqh-2"), generic);
    expect(listKind(cascade)).toBe("section");
    expect(nextStep(form({ categorySlug: "fiqh", editionId: "fiqh-2" }), cascade)).toBe("section");
  });

  it("clears level 2, level 3 and the path boxes when the category changes, and keeps minutes, date and goal", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-1", ordinals: [1, 2], paths: ["sanad"], minutes: 15, date: "2026-12-01", goalEdited: true, goalText: "mine" });
    const next = chooseCategory(f, "quran");
    expect(next).toMatchObject({ categorySlug: "quran", editionId: null, view: null, ordinals: [], paths: null, minutes: 15, date: "2026-12-01", goalText: "mine" });
    expect(chooseCategory(f, "hadith")).toBe(f);
  });

  it("clears level 3 and the path boxes when the book changes, and nothing above it", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-1", ordinals: [1, 2], paths: ["grade"] });
    expect(chooseBook(f, "hadith-2")).toMatchObject({ categorySlug: "hadith", editionId: "hadith-2", ordinals: [], paths: null });
  });

  it("keeps the checked sections when the view switches between surah and juz'", () => {
    const f = form({ categorySlug: "quran", view: "surah", ordinals: [2, 4] });
    const juz = chooseView(f, "juz");
    expect(juz.ordinals).toEqual([2, 4]);
    expect(chooseView(juz, "surah").ordinals).toEqual([2, 4]);
  });
});

describe("selecting sections (D78, UG-13)", () => {
  const sections = quranEdition.sections;

  it("keeps the ordinals ascending whatever the order of the presses", () => {
    let f = form();
    for (const ordinal of [4, 1, 3]) f = toggleOrdinal(f, ordinal);
    expect(f.ordinals).toEqual([1, 3, 4]);
    expect(toggleOrdinal(f, 3).ordinals).toEqual([1, 4]);
  });

  it("selects everything in one press and clears it again", () => {
    const all = selectAll(form(), sections);
    expect(all.ordinals).toEqual([1, 2, 3, 4, 5]);
    expect(clearOrdinals(all).ordinals).toEqual([]);
    expect(removeOrdinals(all, [2, 3]).ordinals).toEqual([1, 4, 5]);
  });

  it("counts none, some and all", () => {
    expect(countState(0, 5)).toEqual({ kind: "none" });
    expect(countState(2, 5)).toEqual({ kind: "some", n: 2, m: 5 });
    expect(countState(5, 5)).toEqual({ kind: "all", m: 5 });
  });

  it("stops at 60 sections and ignores a further check", () => {
    const many = Array.from({ length: 70 }, (_, index) => section(index + 1, "hadith", ["matn"]));
    let f = form();
    for (let ordinal = 1; ordinal <= 61; ordinal += 1) f = toggleOrdinal(f, ordinal);
    expect(f.ordinals).toHaveLength(MAX_SECTIONS);
    expect(f.ordinals).not.toContain(61);
    expect(toggleOrdinal(f, 5).ordinals).not.toContain(5); // an uncheck is always allowed
    expect(selectAll(form(), many).ordinals).toEqual([]); // select all is not offered past the limit
  });

  it("makes the juz' row one press for every section, mixed when only some are checked", () => {
    expect(juzState([], sections)).toBe("unchecked");
    expect(juzState([1, 2], sections)).toBe("mixed");
    expect(juzState([1, 2, 3, 4, 5], sections)).toBe("checked");
    const all = toggleJuz(form(), sections);
    expect(all.ordinals).toEqual([1, 2, 3, 4, 5]);
    expect(toggleJuz(all, sections).ordinals).toEqual([]);
    expect(toggleJuz(form({ ordinals: [2] }), sections).ordinals).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts only the ordinals that exist in the edition on screen", () => {
    const f = form({ categorySlug: "quran", view: "surah", ordinals: [1, 3, 99] });
    expect(selectedOrdinals(f, resolveCascade(f, groups))).toEqual([1, 3]);
  });
});

describe("the hadith paths (R29)", () => {
  const f = form({ categorySlug: "hadith", editionId: "hadith-1" });
  const cascade = resolveCascade(f, groups);

  it("starts with matn only", () => {
    expect(checkedPaths(f, cascade)).toEqual(["matn"]);
  });

  it("adds boxes in the canonical order and never unchecks the last one", () => {
    const withGrade = togglePath(f, cascade, "grade").form;
    const withSanad = togglePath(withGrade, cascade, "sanad").form;
    expect(checkedPaths(withSanad, cascade)).toEqual(["matn", "sanad", "grade"]);
    const dropMatn = togglePath(withSanad, cascade, "matn").form;
    expect(checkedPaths(dropMatn, cascade)).toEqual(["sanad", "grade"]);
    const lone = form({ ...f, paths: ["sanad"] });
    const refused = togglePath(lone, cascade, "sanad");
    expect(refused.kept).toBe(true);
    expect(checkedPaths(refused.form, cascade)).toEqual(["sanad"]);
  });

  it("shows no group for the Quran edition", () => {
    expect(resolveCascade(chooseCategory(form(), "quran"), groups).pathChoices).toEqual([]);
  });
});

describe("the hand-off to S-09 (guard 5)", () => {
  it("builds the Quran selection: its paths are [quran], the ordinals ascend, the goal is trimmed", () => {
    const f = form({ categorySlug: "quran", view: "surah", ordinals: [5, 2], minutes: 15, date: "2026-12-01" });
    const cascade = resolveCascade(f, groups);
    expect(buildSelection({ form: f, cascade, minutes: 15, goalText: "  goal  " })).toEqual({
      editionId: "quran-1",
      targetScope: { sectionOrdinals: [2, 5] },
      paths: ["quran"],
      sessionMinutes: 15,
      preferredDate: "2026-12-01",
      goalText: "goal",
    });
  });

  it("builds the hadith selection with the checked paths and no date", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-2", ordinals: [1], paths: ["matn", "grade"] });
    const selection = buildSelection({ form: f, cascade: resolveCascade(f, groups), minutes: 5, goalText: "g" });
    expect(selection).toMatchObject({ editionId: "hadith-2", paths: ["matn", "grade"], preferredDate: null, sessionMinutes: 5 });
  });

  it("takes the edition's default paths for a category that has no hadith paths", () => {
    const only = groupCategories([{ ...fiqhEdition, availablePaths: ["quran"], defaultPaths: ["quran"] }]);
    const f = form({ ordinals: [1] });
    expect(buildSelection({ form: f, cascade: resolveCascade(f, only), minutes: 10, goalText: "g" })?.paths).toEqual(["quran"]);
  });

  it("builds nothing until an edition and a section are chosen", () => {
    expect(buildSelection({ form: form(), cascade: resolveCascade(form(), groups), minutes: 10, goalText: "g" })).toBeNull();
    const f = form({ categorySlug: "quran", view: "surah" });
    expect(buildSelection({ form: f, cascade: resolveCascade(f, groups), minutes: 10, goalText: "g" })).toBeNull();
  });
});

describe("the draft that restores the cascade", () => {
  it("round trips the form", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-1", ordinals: [3, 1], paths: ["matn", "sanad"], minutes: 5, date: "2026-11-01", goalEdited: true, goalText: "x" });
    expect(readStartForm(f)).toEqual({ ...f, ordinals: [1, 3] });
  });

  it("drops a value of the wrong shape instead of trusting it", () => {
    expect(readStartForm(null)).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, minutes: 7 })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, view: "page" })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, ordinals: ["1"] })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, paths: ["quran"] })).toBeNull();
  });
});

describe("the goal limits and the date", () => {
  it("counts code points of the trimmed text, so a pair of code units is one character", () => {
    expect(countCodePoints("  abc  ")).toBe(3);
    expect(countCodePoints("\u{1F600}\u{1F600}")).toBe(2);
    expect(countCodePoints("   ")).toBe(0);
  });

  it("accepts no date and today, and rejects an earlier or an impossible date", () => {
    expect(isDateRejected("", "2026-10-05")).toBe(false);
    expect(isDateRejected("2026-10-05", "2026-10-05")).toBe(false);
    expect(isDateRejected("2026-10-04", "2026-10-05")).toBe(true);
    expect(isDateRejected("2027-02-30", "2026-10-05")).toBe(true);
    expect(isDateRejected("soon", "2026-10-05")).toBe(true);
  });

  it("reads today in the account time zone, not in the browser's", () => {
    const instant = new Date("2026-10-05T21:30:00Z");
    expect(todayIn("Asia/Dubai", instant)).toBe("2026-10-06");
    expect(todayIn("America/New_York", instant)).toBe("2026-10-05");
    expect(todayIn("Not/AZone", instant)).toBe("2026-10-05");
  });

  it("writes digits in the interface language", () => {
    expect(localizeDigits("112", "ar")).toBe("١١٢");
    expect(localizeDigits("112", "en")).toBe("112");
  });
});

describe("the composed goal sentence (UI-design 1.1)", () => {
  const quranForm = form({ categorySlug: "quran", view: "surah" });
  function sentence(locale: "ar" | "en", f: StartForm, groupsToUse = groups, minutes: 5 | 10 | 15 = 10) {
    const cascade = resolveCascade(f, groupsToUse);
    return composeGoal({ locale, form: f, cascade, selected: selectedOrdinals(f, cascade), minutes });
  }

  it("is empty until a section is checked", () => {
    expect(sentence("ar", quranForm)).toBe("");
  });

  it("names one to three sections, joined by و in Arabic", () => {
    expect(sentence("ar", { ...quranForm, ordinals: [1] })).toBe(
      "أريد حفظ عنصر تجريبي 1 من كتاب quran-1 (طبعة تجريبية) من باب القرآن الكريم، بمعدل ١٠ دقائق يوميًا، دون موعد محدد، بواجهة العربية.",
    );
    expect(sentence("ar", { ...quranForm, ordinals: [1, 2, 3] })).toContain("عنصر تجريبي 1 وعنصر تجريبي 2 وعنصر تجريبي 3");
  });

  it("says all sections when all are checked, and n of m when more than three are", () => {
    expect(sentence("ar", { ...quranForm, ordinals: [1, 2, 3, 4, 5] })).toContain("أريد حفظ كل الأقسام من");
    expect(sentence("ar", { ...quranForm, ordinals: [1, 2, 3, 4] })).toContain("أريد حفظ ٤ من ٥ سورة من");
    expect(sentence("en", { ...quranForm, ordinals: [1, 2, 3, 4] })).toContain("memorize 4 of 5 surahs of");
  });

  it("adds the hadith paths clause and the date, and counts the minutes with the right noun", () => {
    const hadithForm = form({ categorySlug: "hadith", editionId: "hadith-1", ordinals: [1], paths: ["matn", "sanad"], date: "2026-12-01" });
    const ar = sentence("ar", hadithForm, groups, 15);
    expect(ar).toContain("وأتعلم المتن والسند، بمعدل ١٥ دقيقة يوميًا، وأن أنهيه بحلول");
    expect(sentence("en", hadithForm, groups, 5)).toBe(
      "I want to memorize Sample item 1 of Book hadith-1 (طبعة تجريبية) from Hadith, learning matn and sanad, at 5 minutes a day, and finish by December 1, 2026, with the English interface.",
    );
  });

  it("writes a learning date from its parts, so a time zone never moves it", () => {
    expect(formatLearningDate("en", "2026-12-01")).toBe("December 1, 2026");
    expect(formatLearningDate("ar", "2026-12-01")).toMatch(/٢٠٢٦/);
    expect(formatLearningDate("en", "bad")).toBe("bad");
  });
});
