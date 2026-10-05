import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lessons/1", useRouter: () => navigation.router }));

import { LessonReaderScreen } from "@/components/lessons/LessonReaderScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { MOCK_LESSON_PASSAGE_IDS, mockLessonSection } from "@/lib/api/mock/lesson-handlers";
import { mockSource } from "@/lib/api/mock/question-fixtures";
import type { LessonSectionDetail, PassageView } from "@/lib/api/types";
import { apiError, jsonResponse, makeGamesBackend, renderWithBackend, type GamesBackend } from "./games-support";

const SECTION_1 = "GET /api/lessons/1";

function renderReader(options: { language?: "ar" | "en"; backend?: GamesBackend; rawId?: string } = {}) {
  const { rawId = "1", ...rest } = options;
  return renderWithBackend(<LessonReaderScreen rawId={rawId} />, rest);
}

// A synthetic hadith section as the server builds it: the passages of the three paths all span the narration (unit 1), and the grade passage lies in the
// grade unit (unit 3). The placeholder words are never a hadith.
function hadithPassage(passageId: string, path: PassageView["path"], units: PassageView["units"], showD50Notice = false): PassageView {
  return {
    passageId,
    path,
    reference: "h:1",
    referenceAr: "حديث اصطناعي ١",
    sectionTitleAr: "حديث اصطناعي ١",
    units,
    highlight: { startRef: "1:0", endRef: "1:3" },
    takhrij: "تخريج اصطناعي",
    grade: "درجة اصطناعية",
    showD50Notice,
    source: mockSource("h:1", "حديث اصطناعي ١"),
  };
}

const NARRATION = { unitRef: 1, kind: "hadith_narration" as const, reference: "h:1", text: "نص١ نص٢ نص٣ نص٤ نص٥" };
const GRADE_UNIT = { unitRef: 3, kind: "hadith_grade" as const, reference: "h:1", text: "درجة اصطناعية" };

function hadithDetail(showD50Notice = false): LessonSectionDetail {
  return {
    sectionId: 1,
    kind: "hadith",
    referenceAr: "حديث اصطناعي ١",
    bookTitleAr: "كتاب اصطناعي",
    sourceUrl: "https://example.invalid/ref/hadith-1",
    passages: [
      hadithPassage("dddddddd-dddd-4ddd-8ddd-000000000001", "sanad", [NARRATION], showD50Notice),
      hadithPassage("dddddddd-dddd-4ddd-8ddd-000000000002", "matn", [NARRATION], showD50Notice),
      hadithPassage("dddddddd-dddd-4ddd-8ddd-000000000003", "grade", [GRADE_UNIT], showD50Notice),
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the reader of a surah", () => {
  it("is a focus screen titled with the surah, with a back control to the list and no tab bar", async () => {
    renderReader();
    expect(await screen.findByRole("heading", { level: 1, name: "سورة اصطناعية ١" })).toBeInTheDocument();
    expect(document.title).toBe("سورة اصطناعية ١ · Qatra");
    expect(screen.getByRole("link", { name: "Back to Lessons" })).toHaveAttribute("href", "/lessons");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("shows every passage of the section under its own reference, with the verbatim text in the original-text font and the ayah numbers as decoration", async () => {
    renderReader();
    await screen.findByRole("heading", { level: 1 });
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["سورة اصطناعية ١، الآيات ١\u2013٢", "سورة اصطناعية ١، الآية ٣"]);
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(2);
    const text = regions.map((region) => region.querySelector("[lang='ar'][dir='rtl']"));
    expect(text[0]).toHaveTextContent("كلمة١ كلمة٢ كلمة٣ كلمة٤ ﴿١﴾ كلمة٥ كلمة٦ كلمة٧ كلمة٨ ﴿٢﴾");
    expect(text[1]).toHaveTextContent("كلمة٩ كلمة١٠ كلمة١١ ﴿٣﴾");
    expect(text[0]).toHaveClass("font-quran");
    expect(regions[0]).toHaveAccessibleName("سورة اصطناعية ١، الآيات ١\u2013٢");
    // The numbers are decoration: hidden from assistive technology and never part of the text of the book.
    expect(text[0]?.querySelectorAll("[data-ayah-end]")).toHaveLength(2);
    expect([...(text[0]?.querySelectorAll("[data-ayah-end]") ?? [])].every((mark) => mark.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("shows the book, the surah and the «المصدر» link under the text, and no provider, edition label or code", async () => {
    renderReader({ language: "ar" });
    await screen.findByRole("heading", { level: 1 });
    const section = screen.getByRole("main");
    expect(section).toHaveTextContent("كتاب اصطناعي · سورة اصطناعية ١ · المصدر");
    const link = within(section).getByRole("link", { name: /المصدر|سورة اصطناعية ١/ });
    expect(link).toHaveAttribute("href", "https://example.invalid/ref/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(section).not.toHaveTextContent("ناشر اصطناعي");
    expect(section).not.toHaveTextContent("نسخة اصطناعية");
  });

  it("offers nothing to answer or play, and no way into a session: no button, no field, no continue", async () => {
    renderReader();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText(/Check|Next|Finish|Continue|Start practice/)).toBeNull();
    expect(screen.queryByRole("link", { name: /session|practice|game/i })).toBeNull();
  });

  it("shows no takhrij or grade for a surah", async () => {
    renderReader();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/Takhrij|Hadith grade/)).toBeNull();
  });

  it("is built from the same passages the server gives: the text of the mock section, unit by unit", async () => {
    renderReader();
    await screen.findByRole("heading", { level: 1 });
    const expected = mockLessonSection(1)?.passages.flatMap((passage) => passage.units.map((unit) => unit.text)) ?? [];
    expect(expected).toHaveLength(3);
    const shown = screen.getAllByRole("region").map((region) => region.querySelector("[lang='ar'][dir='rtl']")?.textContent ?? "");
    for (const text of expected) expect(shown.join(" ")).toContain(text);
  });

  it("shows a single passage without a heading of its own: the title says it", async () => {
    renderReader({ rawId: "2" });
    await screen.findByRole("heading", { level: 1, name: "سورة اصطناعية ٢" });
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Lesson text" })).toHaveTextContent("كلمة١٢ كلمة١٣ كلمة١٤ كلمة١٥ ﴿١﴾");
  });
});

describe("the reader of a hadith", () => {
  const withHadith = (detail = hadithDetail()) => makeGamesBackend({ [SECTION_1]: () => jsonResponse(detail) });

  it("shows the narration once however many paths the plan reads it on, in the hadith font", async () => {
    renderReader({ backend: withHadith() });
    await screen.findByRole("heading", { level: 1, name: "حديث اصطناعي ١" });
    expect(screen.getAllByText("نص١ نص٢ نص٣ نص٤ نص٥")).toHaveLength(1);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Lesson text" }).querySelector("[lang='ar']")).toHaveClass("font-hadith");
  });

  it("shows the takhrij and the grade of the hadith as the edition states them, the grade once", async () => {
    renderReader({ backend: withHadith() });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText(/Takhrij:/)).toHaveTextContent("Takhrij: تخريج اصطناعي");
    expect(screen.getByText(/Hadith grade:/)).toHaveTextContent("Hadith grade: درجة اصطناعية");
    expect(screen.getAllByText(/درجة اصطناعية/)).toHaveLength(1); // the grade statement is not repeated as text
  });

  it("says «غير مذكور في النسخة» for a takhrij or a grade the edition does not give", async () => {
    const detail = hadithDetail();
    renderReader({
      language: "ar",
      backend: withHadith({ ...detail, passages: detail.passages.map((passage) => ({ ...passage, takhrij: null, grade: null })) }),
    });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText(/التخريج:/)).toHaveTextContent("التخريج: غير مذكور في النسخة");
    expect(screen.getByText(/درجة الحديث:/)).toHaveTextContent("درجة الحديث: غير مذكور في النسخة");
  });

  it("shows the book, the hadith title and the «المصدر» link of the section", async () => {
    renderReader({ language: "ar", backend: withHadith() });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("main")).toHaveTextContent("كتاب اصطناعي · حديث اصطناعي ١ · المصدر");
    expect(screen.getByRole("link", { name: /حديث اصطناعي ١/ })).toHaveAttribute("href", "https://example.invalid/ref/hadith-1");
  });

  it("shows the D50 notice only when the passages say the edition gives neither attribution nor grade", async () => {
    renderReader({ backend: withHadith(hadithDetail(true)) });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText(/authenticity has not been verified/)).toBeInTheDocument();
  });

  it("shows no D50 notice by default", async () => {
    renderReader({ backend: withHadith() });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/authenticity has not been verified/)).toBeNull();
  });

  it("shows the grade statement as the text when the plan reads the grade path alone", async () => {
    const detail = hadithDetail();
    renderReader({ backend: withHadith({ ...detail, passages: detail.passages.filter((passage) => passage.path === "grade") }) });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByText(/درجة اصطناعية/).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Lesson text" })).toHaveTextContent("درجة اصطناعية");
  });
});

describe("the reader, states", () => {
  it("says the lesson is not in the plan, and points back to the list, for a 404", async () => {
    renderReader({ rawId: "9" });
    expect(await screen.findByText("This lesson is not in your plan.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Back to Lessons" }).map((link) => link.getAttribute("href"))).toEqual(["/lessons", "/lessons"]);
    expect(screen.getByRole("heading", { level: 1, name: "Lessons" })).toBeInTheDocument();
  });

  it("says the same for an account with no active plan (409)", async () => {
    renderReader({ backend: makeGamesBackend({}, { hasPlan: false }) });
    expect(await screen.findByText("This lesson is not in your plan.")).toBeInTheDocument();
  });

  it("asks nothing of the server for a route id that is not a number", async () => {
    const { backend } = renderReader({ rawId: "abc" });
    expect(await screen.findByText("This lesson is not in your plan.")).toBeInTheDocument();
    expect(backend.calls.filter((call) => call.key.startsWith("GET /api/lessons"))).toHaveLength(0);
  });

  it("shows the Error banner with Try again on a failed read, and reads again", async () => {
    const backend = makeGamesBackend({ [SECTION_1]: (real, call) => (call === 1 ? apiError(500, "internal") : real()) });
    const user = userEvent.setup();
    renderReader({ backend });
    expect(await screen.findByText("Something unexpected happened. Try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "سورة اصطناعية ١" })).toBeInTheDocument();
  });

  it("sends a visitor whose session ended to the login screen and back to this section", async () => {
    renderReader({ backend: makeGamesBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Flessons%2F1"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("shows the hidden loading text while the section loads", async () => {
    const backend = makeGamesBackend({ [SECTION_1]: async (real) => (await new Promise((resolve) => setTimeout(resolve, 100)), real()) });
    renderReader({ backend });
    expect(screen.getByText("Loading")).toBeInTheDocument();
    await screen.findByRole("heading", { level: 1, name: "سورة اصطناعية ١" });
    expect(screen.queryByText("Loading")).toBeNull();
  });
});

describe("the fixtures", () => {
  it("are synthetic: placeholder words only, with the ids of the lessons the mock serves", () => {
    const section = mockLessonSection(1);
    expect(section?.passages.map((passage) => passage.passageId)).toEqual([MOCK_LESSON_PASSAGE_IDS.first, MOCK_LESSON_PASSAGE_IDS.second]);
    expect(mockLessonSection(9)).toBeNull();
  });
});
