// The rules of S-08 (UI-screens S-08 "Selection rules (D78, D88)", "Goal box", "Validation"; UI-tokens 6.26) over the pure model, with synthetic catalog data.
import { describe, expect, it } from "vitest";
import type { CatalogEdition, CatalogSection } from "@/lib/api/types";
import { composeGoal, formatLearningDate } from "@/components/start/goal-sentence";
import { groupCountText, groupKindOf, groupLabel } from "@/components/start/group-label";
import {
  buildSelection,
  checkedPaths,
  chooseBook,
  chooseCategory,
  chooseJuz,
  clearOrdinals,
  countCodePoints,
  countState,
  EMPTY_FORM,
  groupCategories,
  groupState,
  isDateRejected,
  juzOptions,
  listKind,
  localizeDigits,
  MAX_SECTIONS,
  nextStep,
  readStartForm,
  removeOrdinals,
  resolveCascade,
  sectionGroups,
  selectAll,
  selectedOrdinals,
  todayIn,
  toggleGroup,
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
const longHadithEdition = edition("hadith-long", HADITH, "hadith_collection", Array.from({ length: 42 }, (_, index) => section(index + 1, "hadith", ["matn", "sanad", "grade"])), "long");
const fiqhEdition = edition("fiqh-1", FIQH, "hadith_collection", [1, 2].map((n) => section(n, "hadith", ["matn"])), "fiqh");

const groups = groupCategories([quranEdition, hadithEdition, hadithEditionTwo]);
const longGroups = groupCategories([longHadithEdition]);

function form(overrides: Partial<StartForm> = {}): StartForm {
  return { ...EMPTY_FORM, ...overrides };
}

describe("the categories and the levels (D78, D88)", () => {
  it("lists each category once, in the order E14 returns them, with its books", () => {
    expect(groups.map((group) => group.slug)).toEqual(["quran", "hadith"]);
    expect(groups[1]?.editions.map((entry) => entry.editionId)).toEqual(["hadith-1", "hadith-2"]);
    expect(groups.map((group) => group.isQuran)).toEqual([true, false]);
  });

  it("shows only level 1 at first, and the helper names the category", () => {
    const cascade = resolveCascade(form(), groups);
    expect(cascade.category).toBeNull();
    expect(cascade.showBooks || cascade.showJuz || cascade.mode !== null).toBe(false);
    expect(nextStep(form(), cascade)).toBe("category");
  });

  it("treats a level with one option as chosen: one category counts as chosen without a press, and level 3 follows", () => {
    const only = groupCategories([quranEdition]);
    const cascade = resolveCascade(form(), only);
    expect(cascade.category?.slug).toBe("quran");
    expect(cascade.showJuz).toBe(true);
    expect(cascade.mode).toBe("surah");
    expect(nextStep(form(), cascade)).toBe("surah");
  });

  it("gives the Quran no book list (one edition, O-56) and a juz' level whose single option counts as chosen (D88, O-55)", () => {
    const f = chooseCategory(form(), "quran");
    const cascade = resolveCascade(f, groups);
    expect(cascade.showBooks).toBe(false);
    expect(cascade.edition?.editionId).toBe("quran-1");
    expect(cascade.showJuz).toBe(true);
    expect(cascade.juzList.map((option) => option.number)).toEqual([30]);
    expect(cascade.juz?.number).toBe(30);
    expect(cascade.mode).toBe("surah");
    expect(cascade.sections).toHaveLength(5);
    expect(cascade.groups).toEqual([]);
    expect(nextStep(f, cascade)).toBe("surah");
  });

  it("offers every section of the edition as juz' 30 until E14 carries a juz' field (O-55)", () => {
    expect(juzOptions(quranEdition)).toEqual([{ number: 30, sections: quranEdition.sections }]);
  });

  it("asks for the juz' when an edition would offer several: level 3 waits for the choice", () => {
    const f = chooseCategory(form(), "quran");
    const cascade = resolveCascade(f, groups);
    const several = {
      ...cascade,
      juzList: [
        { number: 29, sections: quranEdition.sections.slice(0, 2) },
        { number: 30, sections: quranEdition.sections.slice(2) },
      ],
      juz: null,
      mode: null,
      sections: [],
    };
    expect(nextStep(f, several)).toBe("juz");
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

  it("names the next step by the list on screen: surah, hadith or section", () => {
    const base = chooseCategory(form(), "quran");
    expect(nextStep(base, resolveCascade(base, groups))).toBe("surah");
    const hadithForm = form({ categorySlug: "hadith", editionId: "hadith-1" });
    expect(nextStep(hadithForm, resolveCascade(hadithForm, groups))).toBe("hadith");
    const generic = groupCategories([fiqhEdition, { ...fiqhEdition, editionId: "fiqh-2", sections: [section(1, "surah", ["matn"]), section(2, "hadith", ["matn"])] }]);
    const cascade = resolveCascade(chooseBook(chooseCategory(form(), "fiqh"), "fiqh-2"), generic);
    expect(listKind(cascade)).toBe("section");
    expect(nextStep(form({ categorySlug: "fiqh", editionId: "fiqh-2" }), cascade)).toBe("section");
  });

  it("clears level 2, level 3 and the path boxes when the category changes, and keeps minutes, date and goal", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-1", ordinals: [1, 2], paths: ["sanad"], minutes: 15, date: "2026-12-01", goalEdited: true, goalText: "mine" });
    const next = chooseCategory(f, "quran");
    expect(next).toMatchObject({ categorySlug: "quran", editionId: null, juz: null, ordinals: [], paths: null, minutes: 15, date: "2026-12-01", goalText: "mine" });
    expect(chooseCategory(f, "hadith")).toBe(f);
  });

  it("clears level 3 and the path boxes when the book changes, and nothing above it", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-1", ordinals: [1, 2], paths: ["grade"] });
    expect(chooseBook(f, "hadith-2")).toMatchObject({ categorySlug: "hadith", editionId: "hadith-2", ordinals: [], paths: null });
  });

  it("clears level 3 when the juz' changes, and keeps everything above it", () => {
    const f = form({ categorySlug: "quran", juz: 29, ordinals: [2, 4], minutes: 5 });
    expect(chooseJuz(f, 30)).toMatchObject({ categorySlug: "quran", juz: 30, ordinals: [], minutes: 5 });
    expect(chooseJuz(f, 29)).toBe(f);
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

  it("counts only the ordinals that exist in the edition on screen", () => {
    const f = form({ categorySlug: "quran", ordinals: [1, 3, 99] });
    expect(selectedOrdinals(f, resolveCascade(f, groups))).toEqual([1, 3]);
  });
});

describe("the groups of a long book (D88)", () => {
  const sections = longHadithEdition.sections;
  const longForm = form({ categorySlug: "hadith" });
  const cascade = resolveCascade(longForm, longGroups);
  const groupAt = (index: number) => cascade.groups[index] as (typeof cascade.groups)[number];

  it("splits 42 sections into five groups of ten by position, the last holding 41 to 42", () => {
    expect(cascade.groups.map((entry) => [entry.id, entry.first, entry.last, entry.sections.length])).toEqual([
      ["g1", 1, 10, 10],
      ["g11", 11, 20, 10],
      ["g21", 21, 30, 10],
      ["g31", 31, 40, 10],
      ["g41", 41, 42, 2],
    ]);
    expect(cascade.mode).toBe("book");
  });

  it("lists a book of ten or fewer sections directly, and a Quran juz' without groups however long", () => {
    expect(sectionGroups(sections.slice(0, 10))).toEqual([]);
    expect(sectionGroups(sections.slice(0, 11))).toHaveLength(2);
    expect(resolveCascade(form({ categorySlug: "hadith", editionId: "hadith-1" }), groups).groups).toEqual([]);
    const longQuran = groupCategories([edition("quran-long", QURAN, "quran", Array.from({ length: 37 }, (_, index) => section(index + 78, "surah", ["quran"])))]);
    const quranCascade = resolveCascade(form(), longQuran);
    expect(quranCascade.sections).toHaveLength(37);
    expect(quranCascade.groups).toEqual([]);
  });

  it("groups by position in ascending ordinal order, whatever the order E14 sends", () => {
    expect(sectionGroups([...sections].reverse()).map((entry) => [entry.first, entry.last])).toEqual([
      [1, 10],
      [11, 20],
      [21, 30],
      [31, 40],
      [41, 42],
    ]);
    const offset = Array.from({ length: 12 }, (_, index) => section(index + 5, "hadith", ["matn"]));
    expect(sectionGroups(offset).map((entry) => [entry.first, entry.last])).toEqual([
      [5, 14],
      [15, 16],
    ]);
  });

  it("writes the group label and the count with the right Arabic number agreement", () => {
    expect(groupKindOf(cascade)).toBe("hadith");
    expect(groupLabel("ar", "hadith", groupAt(0))).toBe("الأحاديث ١\u2013١٠");
    expect(groupLabel("ar", "hadith", groupAt(4))).toBe("الأحاديث ٤١\u2013٤٢");
    expect(groupLabel("en", "hadith", groupAt(4))).toBe("Hadiths 41\u201342");
    expect(groupLabel("ar", "section", groupAt(0))).toBe("الأقسام ١\u2013١٠");
    expect(groupLabel("en", "section", groupAt(0))).toBe("Sections 1\u201310");
    expect(groupCountText("ar", "hadith", groupAt(0))).toBe("١٠ أحاديث");
    expect(groupCountText("ar", "hadith", groupAt(4))).toBe("حديثان");
    expect(groupCountText("en", "hadith", groupAt(4))).toBe("2 hadiths");
    const sized = (count: number) => ({ id: "g1", first: 1, last: count, sections: Array.from({ length: count }, (_, index) => section(index + 1, "hadith", ["matn"])) });
    expect(groupCountText("ar", "hadith", sized(1))).toBe("حديث واحد");
    expect(groupCountText("ar", "hadith", sized(3))).toBe("٣ أحاديث");
    expect(groupCountText("ar", "hadith", sized(11))).toBe("١١ حديثًا");
    expect(groupCountText("ar", "section", sized(1))).toBe("قسم واحد");
    expect(groupCountText("ar", "section", sized(2))).toBe("قسمان");
    expect(groupCountText("ar", "section", sized(5))).toBe("٥ أقسام");
    expect(groupCountText("ar", "section", sized(12))).toBe("١٢ قسمًا");
    expect(groupCountText("en", "hadith", sized(1))).toBe("1 hadith");
    expect(groupCountText("en", "section", sized(1))).toBe("1 section");
  });

  it("names a group of one section by that section: a book of 41 ends with «الحديث ٤١»", () => {
    const book = groupCategories([edition("hadith-41", HADITH, "hadith_collection", Array.from({ length: 41 }, (_, index) => section(index + 1, "hadith", ["matn"])), "41")]);
    const c41 = resolveCascade(form(), book);
    const last = c41.groups[c41.groups.length - 1] as (typeof c41.groups)[number];
    expect(c41.groups.map((entry) => [entry.first, entry.last])).toEqual([[1, 10], [11, 20], [21, 30], [31, 40], [41, 41]]);
    expect(groupLabel("ar", "hadith", last)).toBe("الحديث ٤١");
    expect(groupLabel("en", "hadith", last)).toBe("Hadith 41");
    expect(groupLabel("ar", "section", last)).toBe("القسم ٤١");
    expect(groupLabel("en", "section", last)).toBe("Section 41");
    expect(groupCountText("ar", "hadith", last)).toBe("حديث واحد");
    const f = form({ categorySlug: "hadith", ordinals: [41] });
    expect(composeGoal({ locale: "ar", form: f, cascade: c41, selected: selectedOrdinals(f, c41), minutes: 10 })).toContain("أريد حفظ الحديث ٤١ من");
    expect(composeGoal({ locale: "en", form: f, cascade: c41, selected: selectedOrdinals(f, c41), minutes: 10 })).toContain("memorize Hadith 41 of");
  });

  it("says «الأقسام» for a list that is not made of hadiths", () => {
    const mixed = groupCategories([{ ...longHadithEdition, sections: longHadithEdition.sections.map((entry, index) => (index % 2 === 0 ? { ...entry, kind: "surah" as const } : entry)) }]);
    expect(groupKindOf(resolveCascade(form(), mixed))).toBe("section");
  });

  it("is tri-state: none, some or all of a group", () => {
    const first = groupAt(0);
    expect(groupState([], first.sections)).toBe("unchecked");
    expect(groupState([1, 2], first.sections)).toBe("mixed");
    expect(groupState([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], first.sections)).toBe("checked");
    expect(groupState([11], first.sections)).toBe("unchecked"); // an ordinal outside the group does not count
  });

  it("checks all ten sections in a press, and unchecks all of them when the group is full", () => {
    const second = groupAt(1);
    const checked = toggleGroup(longForm, second.sections);
    expect(checked.ordinals).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(toggleGroup(checked, second.sections).ordinals).toEqual([]);
    expect(toggleGroup(form({ ordinals: [3, 12] }), second.sections).ordinals).toEqual([3, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("turns a child press into a mixed group, and the selection stays one set of ordinals", () => {
    const f = toggleOrdinal(toggleOrdinal(longForm, 7), 2);
    expect(groupState(f.ordinals, groupAt(0).sections)).toBe("mixed");
    const selection = buildSelection({ form: f, cascade, minutes: 10, goalText: "g" });
    expect(selection?.targetScope.sectionOrdinals).toEqual([2, 7]);
  });

  it("refuses a group press that would pass 60 sections, and still allows the uncheck", () => {
    const many = Array.from({ length: 70 }, (_, index) => section(index + 1, "hadith", ["matn"]));
    const big = sectionGroups(many);
    const at = (index: number) => (big[index] as (typeof big)[number]).sections;
    let f = form();
    for (let index = 0; index < 6; index += 1) f = toggleGroup(f, at(index));
    expect(f.ordinals).toHaveLength(60);
    expect(toggleGroup(f, at(6))).toBe(f);
    expect(toggleGroup(f, at(0)).ordinals).toHaveLength(50);
    const partly = form({ ordinals: Array.from({ length: 55 }, (_, index) => index + 1) });
    expect(toggleGroup(partly, at(6))).toBe(partly);
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
    const f = form({ categorySlug: "quran", ordinals: [5, 2], minutes: 15, date: "2026-12-01" });
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
    const f = form({ categorySlug: "quran" });
    expect(buildSelection({ form: f, cascade: resolveCascade(f, groups), minutes: 10, goalText: "g" })).toBeNull();
  });
});

describe("the draft that restores the cascade", () => {
  it("round trips the form", () => {
    const f = form({ categorySlug: "hadith", editionId: "hadith-1", juz: 30, ordinals: [3, 1], paths: ["matn", "sanad"], minutes: 5, date: "2026-11-01", goalEdited: true, goalText: "x" });
    expect(readStartForm(f)).toEqual({ ...f, ordinals: [1, 3] });
  });

  it("drops a value of the wrong shape instead of trusting it", () => {
    expect(readStartForm(null)).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, minutes: 7 })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, juz: "30" })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, juz: 1.5 })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, ordinals: ["1"] })).toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, paths: ["quran"] })).toBeNull();
  });

  it("keeps a draft from before D88 that still carries view and has no juz', ignoring the old field", () => {
    const legacy: Record<string, unknown> = { ...EMPTY_FORM, view: "juz", categorySlug: "quran", ordinals: [3, 1] };
    delete legacy.juz;
    const read = readStartForm(legacy);
    expect(read).toEqual({ ...EMPTY_FORM, categorySlug: "quran", ordinals: [1, 3] });
    expect(read).not.toHaveProperty("view");
    expect(readStartForm({ ...EMPTY_FORM, view: "page" })).not.toBeNull();
    expect(readStartForm({ ...EMPTY_FORM, juz: 30 })?.juz).toBe(30);
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
  const quranForm = form({ categorySlug: "quran" });
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

  describe("when the selection is made of whole groups (D88, O-60)", () => {
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, index) => a + index);
    const groupSentence = (locale: "ar" | "en", ordinals: number[]) => sentence(locale, form({ categorySlug: "hadith", ordinals }), longGroups);

    it("names one group by its label", () => {
      expect(groupSentence("ar", range(1, 10))).toContain("أريد حفظ الأحاديث ١\u2013١٠ من");
      expect(groupSentence("en", range(41, 42))).toContain("memorize Hadiths 41\u201342 of");
    });

    it("names up to three whole groups joined like the section names", () => {
      expect(groupSentence("ar", [...range(1, 10), ...range(21, 30), ...range(41, 42)])).toContain("أريد حفظ الأحاديث ١\u2013١٠ والأحاديث ٢١\u2013٣٠ والأحاديث ٤١\u2013٤٢ من");
      expect(groupSentence("en", [...range(1, 10), ...range(11, 20)])).toContain("Hadiths 1\u201310 and Hadiths 11\u201320 of");
    });

    it("falls back to the count from the fourth whole group, and to the section names when a group is only partly checked", () => {
      expect(groupSentence("ar", range(1, 40))).toContain("أريد حفظ ٤٠ من ٤٢ حديث من");
      expect(groupSentence("ar", [...range(1, 10), 12])).toContain("١١ من ٤٢ حديث");
      expect(groupSentence("ar", [2, 5])).toContain("عنصر تجريبي 2 وعنصر تجريبي 5");
    });

    it("says all sections when every group is checked", () => {
      expect(groupSentence("ar", range(1, 42))).toContain("أريد حفظ كل الأقسام من");
    });
  });
});
