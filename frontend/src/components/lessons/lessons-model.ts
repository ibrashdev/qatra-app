import type { TextKind } from "@/components/questions";
import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";
import { ApiError } from "@/lib/api/errors";
import type { LessonSectionDetail, PassageView, SourceRef } from "@/lib/api/types";

// The lessons reader (D92). Pure helpers: the route id, the failures of the two reads, and what the reader shows of a section.

const SECTION_ID = /^[1-9]\d{0,8}$/u;

// `sectionId` is the ordinal of the section in the plan's edition. Anything that is not a plain positive number is not a section.
export function parseSectionId(raw: string): number | null {
  return SECTION_ID.test(raw) ? Number(raw) : null;
}

// What the two reads can fail with. A 409 `plan_not_active` (no active plan) and a 404 (a section the plan does not hold, or an edition that is gone) are
// answers the screens speak for themselves; everything else is a failure of S-11's kinds.
export type LessonsFailure = TodayFailure | { kind: "not_found" };

export function classifyLessonsError(error: unknown): LessonsFailure {
  if (error instanceof ApiError && error.code === "not_found") return { kind: "not_found" };
  return classifyTodayError(error);
}

export const textKindOfSection = (detail: Pick<LessonSectionDetail, "kind">): TextKind => (detail.kind === "surah" ? "quran" : "hadith");

// The number of an ayah from its reference («112:3» is 3), or null when the unit is not an ayah of that form.
export function ayahNumberOf(reference: string): number | null {
  const tail = reference.slice(reference.lastIndexOf(":") + 1);
  return /^\d{1,4}$/u.test(tail) ? Number(tail) : null;
}

export interface ReaderBlock {
  passage: PassageView;
  units: PassageView["units"];
}

// The text of a section as the reader shows it: passage by passage in book order, each unit once. The passages of a hadith on its sanad, matn and grade paths
// all span the same narration, so a unit is shown at its first passage only; the grade statement is left to the record line («درجة الحديث») and shows as text
// only when nothing else would (a plan on the grade path alone). Nothing of the text is changed.
export function readerBlocks(detail: Pick<LessonSectionDetail, "passages">): ReaderBlock[] {
  const collect = (withGrade: boolean): ReaderBlock[] => {
    const seen = new Set<number>();
    const blocks: ReaderBlock[] = [];
    for (const passage of detail.passages) {
      const units = passage.units.filter((unit) => (withGrade || unit.kind !== "hadith_grade") && !seen.has(unit.unitRef));
      for (const unit of units) seen.add(unit.unitRef);
      if (units.length > 0) blocks.push({ passage, units });
    }
    return blocks;
  };
  const blocks = collect(false);
  return blocks.length > 0 ? blocks : collect(true);
}

// The takhrij and the grade of a hadith section: the first passage that carries each (every passage of a section reads them from the same units).
export function hadithRecordOf(detail: Pick<LessonSectionDetail, "passages">): { takhrij: string | null; grade: string | null } {
  return {
    takhrij: detail.passages.find((passage) => passage.takhrij !== null)?.takhrij ?? null,
    grade: detail.passages.find((passage) => passage.grade !== null)?.grade ?? null,
  };
}

// The line under the text (D92): the book, the surah or the hadith title, and the «المصدر» link to the section's canonical page. No provider name, edition
// label or technical code is ever shown: QuestionSource reads only these three values and the (empty) pages.
export function sectionSource(detail: Pick<LessonSectionDetail, "sectionId" | "referenceAr" | "bookTitleAr" | "sourceUrl">): SourceRef {
  return {
    publisher: "",
    editionLabel: "",
    bookTitleAr: detail.bookTitleAr,
    reference: String(detail.sectionId),
    referenceAr: detail.referenceAr,
    url: detail.sourceUrl,
    pages: [],
  };
}
