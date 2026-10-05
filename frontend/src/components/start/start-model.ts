// The rules of the S-08 cascade (UI-screens S-08 section 3, UI-tokens 6.26) as pure functions over one plain form object, so they are
// testable without a screen and the form can travel in the start draft that S-09 hands back (lib/plan/start-selection.ts).
import type { NextStep } from "@/i18n/start-messages";
import type { CatalogEdition, CatalogSection, Path } from "@/lib/api/types";
import type { StartSelection } from "@/lib/plan/start-selection";

export const MAX_SECTIONS = 60; // UG-13
export const GOAL_MAX_CODE_POINTS = 500;
export const GOAL_WARN_CODE_POINTS = 450;
// E14 has no juz' field (O-55): the only Quran edition is Juz' Amma, so its one juz' row stands for every section of the edition.
export const JUZ_AMMA_NUMBER = 30;

export type Minutes = 5 | 10 | 15;
export const MINUTE_CHOICES: readonly Minutes[] = [5, 10, 15];
export const DEFAULT_MINUTES: Minutes = 10;

export type SelectionView = "surah" | "juz";
export type HadithPath = Exclude<Path, "quran">;
const HADITH_PATHS: readonly HadithPath[] = ["matn", "sanad", "grade"];

// Everything the learner can change on the screen. A type alias, so it is assignable to the draft's Record<string, unknown>.
export type StartForm = {
  categorySlug: string | null;
  editionId: string | null; // set only when the learner chose a book; a single book is implied
  view: SelectionView | null; // Quran only
  ordinals: number[]; // E14 section ordinals, ascending
  paths: HadithPath[] | null; // null: the default (matn)
  minutes: Minutes | null; // null: the profile default
  date: string; // "" when no date
  goalEdited: boolean;
  goalText: string; // meaningful only while goalEdited
};

export const EMPTY_FORM: StartForm = {
  categorySlug: null,
  editionId: null,
  view: null,
  ordinals: [],
  paths: null,
  minutes: null,
  date: "",
  goalEdited: false,
  goalText: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isNullOrString = (value: unknown): value is string | null => value === null || typeof value === "string";

// The form that came back in the draft, checked field by field: a draft is only memory, but a shape that does not fit is dropped, not trusted.
export function readStartForm(value: unknown): StartForm | null {
  if (!isRecord(value)) return null;
  const { categorySlug, editionId, view, ordinals, paths, minutes, date, goalEdited, goalText } = value;
  if (!isNullOrString(categorySlug) || !isNullOrString(editionId)) return null;
  if (view !== null && view !== "surah" && view !== "juz") return null;
  if (!Array.isArray(ordinals) || !ordinals.every((entry) => Number.isInteger(entry))) return null;
  if (paths !== null && !(Array.isArray(paths) && paths.every((entry) => HADITH_PATHS.includes(entry as HadithPath)))) return null;
  if (minutes !== null && !MINUTE_CHOICES.includes(minutes as Minutes)) return null;
  if (typeof date !== "string" || typeof goalEdited !== "boolean" || typeof goalText !== "string") return null;
  return {
    categorySlug,
    editionId,
    view,
    ordinals: [...(ordinals as number[])].sort((a, b) => a - b),
    paths: paths === null ? null : [...(paths as HadithPath[])],
    minutes: minutes as Minutes | null,
    date,
    goalEdited,
    goalText,
  };
}

export interface CategoryGroup {
  slug: string;
  labelAr: string;
  labelEn: string;
  editions: readonly CatalogEdition[];
  isQuran: boolean; // contentFormat quran: level 2 is the surah or juz' choice
}

// The distinct categories in E14's order (D78: a category appears when E14 returns an edition for it).
export function groupCategories(editions: readonly CatalogEdition[]): CategoryGroup[] {
  const groups: { slug: string; labelAr: string; labelEn: string; editions: CatalogEdition[] }[] = [];
  for (const edition of editions) {
    const existing = groups.find((group) => group.slug === edition.category.slug);
    if (existing) existing.editions.push(edition);
    else groups.push({ slug: edition.category.slug, labelAr: edition.category.labelAr, labelEn: edition.category.labelEn, editions: [edition] });
  }
  return groups.map((group) => ({ ...group, isQuran: group.editions[0]?.contentFormat === "quran" }));
}

export type ListMode = "surah" | "juz" | "book";

// What is on screen for this form: which levels exist and what level 3 lists. A level with one option counts as chosen (D78).
export interface Cascade {
  category: CategoryGroup | null;
  showBooks: boolean;
  edition: CatalogEdition | null;
  showView: boolean;
  view: SelectionView | null;
  mode: ListMode | null;
  sections: readonly CatalogSection[];
  pathChoices: readonly HadithPath[]; // the boxes of c13, empty when the group is not shown
}

// A single book is implied; with several, the one the learner chose.
function findEdition(category: CategoryGroup, editionId: string | null): CatalogEdition | null {
  if (category.editions.length === 1) return category.editions[0] ?? null;
  return category.editions.find((entry) => entry.editionId === editionId) ?? null;
}

export function resolveCascade(form: StartForm, groups: readonly CategoryGroup[]): Cascade {
  const category = groups.length === 1 ? (groups[0] ?? null) : (groups.find((group) => group.slug === form.categorySlug) ?? null);
  // The Quran has one edition (O-56), so there is no book list for it; a second edition would bring the list back.
  const showBooks = category !== null && (!category.isQuran || category.editions.length > 1);
  const edition = category ? findEdition(category, form.editionId) : null;
  const showView = category?.isQuran === true && edition !== null;
  const view = showView ? form.view : null;
  let mode: ListMode | null = null;
  if (edition) mode = category?.isQuran ? view : "book";
  const pathChoices: HadithPath[] = edition === null || edition.contentFormat === "quran" ? [] : HADITH_PATHS.filter((path) => edition.availablePaths.includes(path));
  return { category, showBooks, edition, showView, view, mode, sections: mode ? (edition?.sections ?? []) : [], pathChoices };
}

// The ordinals that are checked and really exist in the edition on screen, ascending.
export function selectedOrdinals(form: StartForm, cascade: Cascade): number[] {
  const known = new Set(cascade.sections.map((section) => section.ordinal));
  return form.ordinals.filter((ordinal) => known.has(ordinal)).sort((a, b) => a - b);
}

export type ListKind = "surah" | "juz" | "hadith" | "section";

// The noun of the level 3 legend and of the helper: «السور»، «الأجزاء»، «الأحاديث» or «الأقسام».
export function listKind(cascade: Cascade): ListKind | null {
  if (cascade.mode === null) return null;
  if (cascade.mode === "juz") return "juz";
  if (cascade.mode === "surah") return "surah";
  const kinds = new Set(cascade.sections.map((section) => section.kind));
  if (kinds.size === 1 && kinds.has("hadith")) return "hadith";
  if (kinds.size === 1 && kinds.has("surah")) return "surah";
  return "section";
}

// The first thing still missing, in cascade order (O-59); null when the primary action can start.
export function nextStep(form: StartForm, cascade: Cascade): NextStep | null {
  if (cascade.category === null) return "category";
  if (cascade.showBooks && cascade.edition === null) return "book";
  if (cascade.showView && cascade.view === null) return "view";
  if (selectedOrdinals(form, cascade).length > 0) return null;
  const kind = listKind(cascade);
  return kind ?? "section";
}

// One immutable step per rule of "Selection rules (D78)".

export function chooseCategory(form: StartForm, slug: string): StartForm {
  if (form.categorySlug === slug) return form;
  // A different category clears level 2, level 3, the chips and the path boxes; minutes, date and goal stay.
  return { ...form, categorySlug: slug, editionId: null, view: null, ordinals: [], paths: null };
}

export function chooseBook(form: StartForm, editionId: string): StartForm {
  if (form.editionId === editionId) return form;
  // A different book clears level 3, the chips and the path boxes.
  return { ...form, editionId, ordinals: [], paths: null };
}

// Switching between the surah and the juz' view keeps the checked sections: both edit one set of ordinals.
export function chooseView(form: StartForm, view: SelectionView): StartForm {
  return form.view === view ? form : { ...form, view };
}

function sorted(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

export function toggleOrdinal(form: StartForm, ordinal: number): StartForm {
  const set = new Set(form.ordinals);
  if (set.has(ordinal)) set.delete(ordinal);
  else if (set.size < MAX_SECTIONS) set.add(ordinal);
  else return form;
  return { ...form, ordinals: sorted(set) };
}

export function removeOrdinals(form: StartForm, ordinals: readonly number[]): StartForm {
  const drop = new Set(ordinals);
  return { ...form, ordinals: form.ordinals.filter((ordinal) => !drop.has(ordinal)) };
}

// A press on the juz' row checks all of its sections, or unchecks all of them when it was fully checked.
export function toggleJuz(form: StartForm, sections: readonly CatalogSection[]): StartForm {
  const all = sections.map((section) => section.ordinal);
  const checked = new Set(form.ordinals);
  if (all.every((ordinal) => checked.has(ordinal))) return removeOrdinals(form, all);
  if (new Set([...form.ordinals, ...all]).size > MAX_SECTIONS) return form;
  return { ...form, ordinals: sorted(new Set([...form.ordinals, ...all])) };
}

export function selectAll(form: StartForm, sections: readonly CatalogSection[]): StartForm {
  if (sections.length > MAX_SECTIONS) return form; // the tool is hidden in a longer list
  return { ...form, ordinals: sorted(sections.map((section) => section.ordinal)) };
}

export function clearOrdinals(form: StartForm): StartForm {
  return form.ordinals.length === 0 ? form : { ...form, ordinals: [] };
}

export type RowState = "unchecked" | "checked" | "mixed";

export function juzState(selected: readonly number[], sections: readonly CatalogSection[]): RowState {
  if (sections.length === 0 || selected.length === 0) return "unchecked";
  const checked = new Set(selected);
  return sections.every((section) => checked.has(section.ordinal)) ? "checked" : "mixed";
}

export type CountState = { kind: "none" } | { kind: "some"; n: number; m: number } | { kind: "all"; m: number };

export function countState(n: number, m: number): CountState {
  if (n === 0) return { kind: "none" };
  return n >= m ? { kind: "all", m } : { kind: "some", n, m };
}

// c13: the checked paths in the canonical order. The default is matn, or the first box when the edition has no matn.
export function checkedPaths(form: StartForm, cascade: Cascade): HadithPath[] {
  const choices = cascade.pathChoices;
  if (choices.length === 0) return [];
  const chosen = form.paths === null ? [] : choices.filter((path) => form.paths?.includes(path));
  if (chosen.length > 0) return chosen;
  return [choices.includes("matn") ? "matn" : (choices[0] as HadithPath)];
}

// An uncheck of the only checked box is refused (R29): the form comes back unchanged and `kept` says why.
export function togglePath(form: StartForm, cascade: Cascade, path: HadithPath): { form: StartForm; kept: boolean } {
  const current = checkedPaths(form, cascade);
  if (current.includes(path)) {
    if (current.length === 1) return { form, kept: true };
    return { form: { ...form, paths: current.filter((entry) => entry !== path) }, kept: false };
  }
  const next = cascade.pathChoices.filter((entry) => entry === path || current.includes(entry));
  return { form: { ...form, paths: next }, kept: false };
}

export const countCodePoints = (text: string): number => Array.from(text.trim()).length;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Today in the account time zone as YYYY-MM-DD, for the `min` of the date control (S-08 "Defaults and other rules").
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const format = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

// "date_invalid": a date that is not a real calendar date, or that lies before today. Learning dates compare as written, never through a zone.
export function isDateRejected(date: string, today: string): boolean {
  if (date === "") return false;
  if (!ISO_DATE.test(date)) return true;
  const parts = date.split("-").map(Number);
  const probe = new Date(Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1));
  if (probe.getUTCFullYear() !== parts[0] || probe.getUTCMonth() !== (parts[1] ?? 1) - 1 || probe.getUTCDate() !== parts[2]) return true;
  return date < today;
}

export interface BuildInputs {
  form: StartForm;
  cascade: Cascade;
  minutes: Minutes;
  goalText: string;
}

// The hand-off to S-09 (guard 5): E14 ordinals ascending, the paths, the minutes, the date and the goal text.
export function buildSelection({ form, cascade, minutes, goalText }: BuildInputs): StartSelection | null {
  const edition = cascade.edition;
  const sectionOrdinals = selectedOrdinals(form, cascade);
  if (edition === null || sectionOrdinals.length === 0 || sectionOrdinals.length > MAX_SECTIONS) return null;
  let paths: Path[];
  if (edition.contentFormat === "quran") paths = ["quran"];
  else if (cascade.pathChoices.length > 0) paths = checkedPaths(form, cascade);
  else paths = [...edition.defaultPaths];
  return {
    editionId: edition.editionId,
    targetScope: { sectionOrdinals },
    paths,
    sessionMinutes: minutes,
    preferredDate: form.date === "" ? null : form.date,
    goalText: goalText.trim(),
  };
}

// P-16: digits follow the interface language. Catalog references and numbers in sentences are written the same way as the formatter writes them.
export function localizeDigits(text: string, locale: "ar" | "en"): string {
  if (locale === "en") return text;
  return text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
}
