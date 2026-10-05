import { describe, expect, it } from "vitest";
import { classifyLessonsError, hadithRecordOf, parseSectionId, readerBlocks, sectionSource, textKindOfSection } from "@/components/lessons/lessons-model";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { getLessonSection, getLessons } from "@/lib/api/lesson-endpoints";
import { createMockFetch } from "@/lib/api/mock";
import { mockLessonSection, mockLessons } from "@/lib/api/mock/lesson-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { PassageView } from "@/lib/api/types";

function client(scenario: { signedIn?: boolean; hasPlan?: boolean } = {}) {
  return createApiRuntime({ mode: "live", fetch: createMockFetch({ latencyMs: 0, scenario }) }).client;
}

describe("the route id of the reader", () => {
  it("accepts a plain positive number and nothing else", () => {
    expect(parseSectionId("1")).toBe(1);
    expect(parseSectionId("42")).toBe(42);
    for (const raw of ["0", "-1", "01", "1.5", "abc", "", "1e3", " 1", "1 ", "99999999999"]) expect(parseSectionId(raw), raw).toBeNull();
  });
});

describe("the failures of the two reads", () => {
  it("tells a 404 from a plan that is not active, and keeps the kinds of the other screens", () => {
    const error = (status: number, code: string, details: Record<string, unknown> = {}) => new ApiError({ status, code, message: "m", details });
    expect(classifyLessonsError(error(404, "not_found"))).toEqual({ kind: "not_found" });
    expect(classifyLessonsError(error(409, "version_conflict", { reason: "plan_not_active" }))).toEqual({ kind: "plan_not_active" });
    expect(classifyLessonsError(error(401, "unauthenticated"))).toEqual({ kind: "session_ended" });
    expect(classifyLessonsError(error(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyLessonsError(error(500, "internal"))).toEqual({ kind: "internal" });
    expect(classifyLessonsError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
  });
});

function passage(passageId: string, units: PassageView["units"], extra: Partial<PassageView> = {}): PassageView {
  return { ...(mockLessonSection(1)?.passages[0] as PassageView), passageId, units, ...extra };
}

describe("what the reader shows of a section", () => {
  const narration = { unitRef: 1, kind: "hadith_narration" as const, reference: "h:1", text: "نص١" };
  const grade = { unitRef: 3, kind: "hadith_grade" as const, reference: "h:1", text: "درجة" };

  it("shows each unit once, at its first passage, and keeps the order of the book", () => {
    const blocks = readerBlocks({ passages: [passage("a", [narration]), passage("b", [narration]), passage("c", [{ ...narration, unitRef: 2, text: "نص٢" }])] });
    expect(blocks.map((block) => block.passage.passageId)).toEqual(["a", "c"]);
    expect(blocks.map((block) => block.units.map((unit) => unit.text))).toEqual([["نص١"], ["نص٢"]]);
  });

  it("leaves the grade statement to the record line unless nothing else would show", () => {
    expect(readerBlocks({ passages: [passage("a", [narration]), passage("g", [grade])] }).map((block) => block.passage.passageId)).toEqual(["a"]);
    expect(readerBlocks({ passages: [passage("g", [grade])] }).map((block) => block.units.map((unit) => unit.text))).toEqual([["درجة"]]);
  });

  it("changes no text", () => {
    const text = " نص  بعلامات  ً ";
    const [block] = readerBlocks({ passages: [passage("a", [{ ...narration, text }])] });
    expect(block?.units[0]?.text).toBe(text);
  });

  it("reads the takhrij and the grade from the first passage that has each", () => {
    expect(hadithRecordOf({ passages: [passage("a", [], { takhrij: null, grade: null }), passage("b", [], { takhrij: "ت", grade: "د" }), passage("c", [], { takhrij: "x", grade: "y" })] })).toEqual({ takhrij: "ت", grade: "د" });
    expect(hadithRecordOf({ passages: [passage("a", [], { takhrij: null, grade: null })] })).toEqual({ takhrij: null, grade: null });
  });

  it("builds the source line from the section, with no provider, edition label or pages", () => {
    const detail = mockLessonSection(1);
    expect(detail).not.toBeNull();
    const source = sectionSource(detail ?? (undefined as never));
    expect(source).toMatchObject({ bookTitleAr: "كتاب اصطناعي", referenceAr: "سورة اصطناعية ١", url: "https://example.invalid/ref/1", pages: [] });
    expect(source.publisher).toBe("");
    expect(source.editionLabel).toBe("");
  });

  it("picks the font of a surah and of a hadith", () => {
    expect(textKindOfSection({ kind: "surah" })).toBe("quran");
    expect(textKindOfSection({ kind: "hadith" })).toBe("hadith");
  });
});

describe("the mock layer of the lessons reader", () => {
  it("answers the list with the sections of the mock plan, and the detail with their synthetic passages", async () => {
    const http = client();
    expect(await getLessons(http)).toEqual(mockLessons);
    const detail = await getLessonSection(http, 1);
    expect(detail).toEqual(mockLessonSection(1));
    expect(detail.passages.every((entry) => entry.units.every((unit) => /^[\s٠-٩ء-ي]+$/u.test(unit.text)))).toBe(true);
  });

  it("answers 409 plan_not_active without a plan, 401 without a session and 404 for a section it does not hold", async () => {
    await expect(getLessons(client({ hasPlan: false }))).rejects.toMatchObject({ status: 409, code: "version_conflict", details: { reason: "plan_not_active" } });
    await expect(getLessonSection(client({ hasPlan: false }), 1)).rejects.toMatchObject({ status: 409 });
    await expect(getLessons(client({ signedIn: false }))).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    await expect(getLessonSection(client(), 9)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});
