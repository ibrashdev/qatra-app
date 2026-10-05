// Mock handlers for the lessons reader (D92): GET /api/lessons and GET /api/lessons/{sectionId}. Synthetic data only: the words are placeholders
// («كلمة١»), never a verse or a hadith. The plan is the mock plan of the E18 fixture (two sections), the edition is the Quran one. Registered in
// mockHandlers next to the other learner reads; an account without a plan gets the 409 the server gives (`plan_not_active`).
import type { LessonSectionDetail, LessonsResponse, PassageView } from "../types";
import { MOCK_PLAN_ID, mockToday } from "./fixtures";
import type { MockHandler, MockResponse } from "./handlers";
import { mockSource } from "./question-fixtures";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");

export const MOCK_LESSON_PASSAGE_IDS = {
  first: "cccccccc-cccc-4ccc-8ccc-000000000001",
  second: "cccccccc-cccc-4ccc-8ccc-000000000002",
  third: "cccccccc-cccc-4ccc-8ccc-000000000003",
} as const;

export const MOCK_LESSON_SECTION_IDS = [1, 2] as const;

const SECTION_REFERENCE_AR: Readonly<Record<number, string>> = { 1: "سورة اصطناعية ١", 2: "سورة اصطناعية ٢" };

function passage(
  passageId: string,
  section: number,
  reference: string,
  referenceAr: string,
  units: readonly { unitRef: number; reference: string; text: string }[],
  highlight: { startRef: string; endRef: string },
): PassageView {
  return {
    passageId,
    path: "quran",
    reference,
    referenceAr,
    sectionTitleAr: `اسم القسم (عنصر نائب) ${section}`,
    units: units.map((unit) => ({ ...unit, kind: "ayah" as const })),
    highlight,
    takhrij: null,
    grade: null,
    showD50Notice: false,
    source: mockSource(reference, referenceAr),
  };
}

const PASSAGES: Readonly<Record<number, readonly PassageView[]>> = {
  1: [
    passage(
      MOCK_LESSON_PASSAGE_IDS.first,
      1,
      "1:1-2",
      "سورة اصطناعية ١، الآيات ١\u2013٢",
      [
        { unitRef: 1, reference: "1:1", text: "كلمة١ كلمة٢ كلمة٣ كلمة٤" },
        { unitRef: 2, reference: "1:2", text: "كلمة٥ كلمة٦ كلمة٧ كلمة٨" },
      ],
      { startRef: "1:0", endRef: "2:3" },
    ),
    passage(
      MOCK_LESSON_PASSAGE_IDS.second,
      1,
      "1:3",
      "سورة اصطناعية ١، الآية ٣",
      [{ unitRef: 3, reference: "1:3", text: "كلمة٩ كلمة١٠ كلمة١١" }],
      { startRef: "3:0", endRef: "3:2" },
    ),
  ],
  2: [
    passage(
      MOCK_LESSON_PASSAGE_IDS.third,
      2,
      "2:1",
      "سورة اصطناعية ٢، الآية ١",
      [{ unitRef: 4, reference: "2:1", text: "كلمة١٢ كلمة١٣ كلمة١٤ كلمة١٥" }],
      { startRef: "4:0", endRef: "4:3" },
    ),
  ],
};

const planVersion = mockToday.plan?.currentVersion ?? 1;

export const mockLessons: LessonsResponse = {
  planId: MOCK_PLAN_ID,
  planVersion,
  sections: MOCK_LESSON_SECTION_IDS.map((sectionId) => ({
    sectionId,
    kind: "surah" as const,
    referenceAr: SECTION_REFERENCE_AR[sectionId] ?? "",
    passageCount: PASSAGES[sectionId]?.length ?? 0,
  })),
};

export function mockLessonSection(sectionId: number): LessonSectionDetail | null {
  const passages = PASSAGES[sectionId];
  if (passages === undefined) return null;
  return {
    sectionId,
    kind: "surah",
    referenceAr: SECTION_REFERENCE_AR[sectionId] ?? "",
    bookTitleAr: "كتاب اصطناعي",
    sourceUrl: "https://example.invalid/ref/1",
    passages: [...passages],
  };
}

// Keys are "METHOD /path", like mockHandlers.
export const lessonMockHandlers: Record<string, MockHandler> = {
  "GET /lessons": (_request, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    if (!scenario.hasPlan) return failure(409, "version_conflict", "The plan is not active.", { reason: "plan_not_active" });
    return { status: 200, body: mockLessons };
  },
  "GET /lessons/:sectionId": ({ params }, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    if (!scenario.hasPlan) return failure(409, "version_conflict", "The plan is not active.", { reason: "plan_not_active" });
    const raw = params?.sectionId ?? "";
    const detail = /^[1-9]\d*$/u.test(raw) ? mockLessonSection(Number(raw)) : null;
    if (detail === null) return failure(404, "not_found", "The resource was not found.");
    return { status: 200, body: detail };
  },
};
