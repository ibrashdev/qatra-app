// S-08, the start and goal screen (UI-screens S-08), against the mock API with a synthetic catalog.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/start", router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), browserTimeZone: () => "Asia/Dubai" }));
vi.mock("@/lib/browser", () => browser);

import StartPage from "@/app/(flow)/start/page";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, errorResponse, mockHandlers, mockProfile, mockToday, mockTodayWithoutPlan, type MockHandler } from "@/lib/api/mock";
import type { CatalogEdition, CatalogResponse, CatalogSection } from "@/lib/api/types";
import { clearCodeUnavailable, clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { getStartDraft, setStartDraft } from "@/lib/plan/start-selection";

type Language = "ar" | "en";

function sectionOf(ordinal: number, kind: CatalogSection["kind"], paths: CatalogSection["paths"]): CatalogSection {
  return {
    sectionId: `sample-${kind}-${ordinal}`,
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

function editionOf(id: string, category: CatalogEdition["category"], format: CatalogEdition["contentFormat"], count: number): CatalogEdition {
  const hadith = format === "hadith_collection";
  return {
    editionId: id,
    editionKey: id,
    titleAr: `كتاب ${id}`,
    titleEn: `Book ${id}`,
    author: "مؤلف تجريبي",
    editionLabel: "طبعة تجريبية",
    category,
    catalogVersion: 1,
    contentFormat: format,
    availablePaths: hadith ? ["matn", "sanad", "grade"] : ["quran"],
    defaultPaths: hadith ? ["matn"] : ["quran"],
    defaultOrder: "book",
    totalWords: 100,
    sections: Array.from({ length: count }, (_, index) => sectionOf(index + 1, hadith ? "hadith" : "surah", hadith ? ["matn", "sanad", "grade"] : ["quran"])),
  };
}

const QURAN = { slug: "quran", labelAr: "القرآن الكريم", labelEn: "The Quran" };
const HADITH = { slug: "hadith", labelAr: "الحديث", labelEn: "Hadith" };

// A Quran edition of eight surahs (more than six, so the chips can hide) and two hadith books.
const CATALOG: CatalogResponse = {
  editions: [editionOf("quran-1", QURAN, "quran", 8), editionOf("hadith-1", HADITH, "hadith_collection", 4), editionOf("hadith-2", HADITH, "hadith_collection", 2)],
};

const json = (body: unknown): ReturnType<MockHandler> => ({ status: 200, body });

interface Setup {
  language?: Language;
  catalog?: MockHandler;
  today?: MockHandler;
  profile?: MockHandler;
  latencyMs?: number;
}

let calls: string[];

function renderStart({ language = "ar", catalog, today, profile, latencyMs = 0 }: Setup = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  calls = [];
  const handlers = {
    ...mockHandlers,
    "GET /catalog": catalog ?? (() => json(CATALOG)),
    "GET /today": today ?? (() => json(mockTodayWithoutPlan)),
    "GET /me": profile ?? (() => json(mockProfile)),
  };
  const mock = createMockFetch({ latencyMs, scenario: { signedIn: true, hasPlan: false }, handlers });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <StartPage />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearCodeUnavailable();
  setStartDraft(null);
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
});

const startButton = (language: Language = "ar") => screen.getByRole("button", { name: language === "ar" ? "ابدأ المحادثة" : "Start the conversation" });
const goalBox = () => screen.getByRole("textbox", { name: /الهدف والموعد|Goal and date/ }) as HTMLTextAreaElement;
const liveText = () => Array.from(document.querySelectorAll("[role=status]")).map((node) => node.textContent ?? "").join(" | ");

async function pickCategory(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("radio", { name }));
}

async function pickQuranSurahs(user: ReturnType<typeof userEvent.setup>) {
  await pickCategory(user, "القرآن الكريم");
  await user.click(screen.getByRole("radio", { name: "حسب السورة" }));
}

const row = (ordinal: number) => screen.getByRole("checkbox", { name: new RegExp(`عنصر تجريبي ${ordinal}(?!\\d)`) });

describe("the first view: only level 1, and a start button that waits (D78)", () => {
  it("shows the title, the subtitle, level 1 and no later level", async () => {
    renderStart();
    expect(screen.getByRole("heading", { level: 1, name: "ما هي خطتك؟" })).toBeInTheDocument();
    expect(screen.getByText("اختر ما تريد حفظه ووقتك اليومي، ثم نكمل الخطة معًا.")).toBeInTheDocument();
    expect(await screen.findByRole("radiogroup", { name: "الباب" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "القرآن الكريم" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "الحديث" })).not.toBeChecked();
    expect(screen.queryByRole("radiogroup", { name: "طريقة الاختيار" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "الأقسام" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ما تريد تعلمه" })).not.toBeInTheDocument();
  });

  it("keeps the start button aria-disabled and focusable, with the next step under it, and a press does nothing", async () => {
    const user = userEvent.setup();
    renderStart();
    await screen.findByRole("radiogroup", { name: "الباب" });
    const button = startButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleDescription("اختر الباب أولًا.");
    button.focus();
    expect(button).toHaveFocus();
    await user.click(button);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("shows the transparency notice of P-15 and the language switch, and the daily time with ten minutes chosen", async () => {
    renderStart();
    await screen.findByRole("radiogroup", { name: "الباب" });
    expect(screen.getByText(/تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English (EN)" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "وقتك اليومي" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "١٠ دقائق" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "٥ دقائق" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "١٥ دقيقة" })).not.toBeChecked();
  });

  it("takes the daily time from the profile (E11) once it arrives", async () => {
    renderStart({ profile: () => json({ ...mockProfile, sessionMinutes: 15 }) });
    await waitFor(() => expect(screen.getByRole("radio", { name: "١٥ دقيقة" })).toBeChecked());
  });

  it("shows no start banner without an open conversation, and no close control without a plan", async () => {
    renderStart();
    await screen.findByRole("radiogroup", { name: "الباب" });
    expect(screen.queryByText(/لديك محادثة خطة لم تعتمدها بعد/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /رجوع إلى/ })).not.toBeInTheDocument();
  });

  it("makes no call but the reads: E14, E11 and E18", async () => {
    renderStart();
    await screen.findByRole("radiogroup", { name: "الباب" });
    await waitFor(() => expect(calls).toEqual(expect.arrayContaining(["GET /api/catalog", "GET /api/me", "GET /api/today"])));
    expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
  });
});

describe("the Quran branch: by surah", () => {
  it("shows level 2 after the category and asks how to select", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickCategory(user, "القرآن الكريم");
    const group = screen.getByRole("radiogroup", { name: "طريقة الاختيار" });
    expect(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["surah", "juz"]);
    expect(startButton()).toHaveAccessibleDescription("اختر طريقة الاختيار: حسب السورة أو حسب الجزء.");
    expect(screen.queryByRole("group", { name: "السور" })).not.toBeInTheDocument();
    // Announced politely, and focus did not move to the new group.
    expect(liveText()).toContain("ظهرت قائمة: طريقة الاختيار");
    expect(group.contains(document.activeElement)).toBe(false);
  });

  it("shows the surah list with nothing checked, no chips, the clear tool inert and the box empty", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    const list = screen.getByRole("group", { name: "السور" });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(8);
    expect(within(list).getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    expect(list).toHaveAccessibleDescription("لم تختر شيئًا بعد");
    expect(screen.getByRole("button", { name: "مسح الاختيار" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("group", { name: "الأقسام المختارة" })).not.toBeInTheDocument();
    expect(goalBox().value).toBe("");
    expect(goalBox()).toHaveAttribute("placeholder", "اكتب هدفك هنا، أو اختر ما تريد حفظه لنكتب لك جملة مقترحة.");
    expect(startButton()).toHaveAccessibleDescription("اختر سورة واحدة على الأقل.");
    expect(startButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("checks a row: the count, one chip, the start button and the composed sentence follow", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(1));
    expect(row(1)).toBeChecked();
    expect(screen.getByRole("group", { name: "السور" })).toHaveAccessibleDescription("تم اختيار ١ من ٨");
    const chips = screen.getByRole("group", { name: "الأقسام المختارة" });
    expect(within(chips).getByRole("button", { name: "إزالة عنصر تجريبي 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "مسح الاختيار" })).toHaveAttribute("aria-disabled", "false");
    expect(startButton()).toHaveAttribute("aria-disabled", "false");
    expect(startButton()).toHaveAccessibleDescription("تسبقها أسئلة قصيرة لتحديد نقطة البداية، ويمكنك تجاوزها.");
    expect(goalBox().value).toBe("أريد حفظ عنصر تجريبي 1 من كتاب quran-1 (طبعة تجريبية) من باب القرآن الكريم، بمعدل ١٠ دقائق يوميًا، دون موعد محدد، بواجهة العربية.");
  });

  it("announces the count and then the updated sentence, once, after the debounce", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(1));
    await user.click(row(2));
    await waitFor(() => expect(liveText()).toContain("تم اختيار ٢ من ٨"), { timeout: 2000 });
    await waitFor(() => expect(liveText()).toContain("تم تحديث الجملة المقترحة"), { timeout: 3000 });
  });

  it("selects all in one press: the count says all, select all is inert, the pressed button keeps focus, and no chips repeat it", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    const selectAll = screen.getByRole("button", { name: "تحديد الكل" });
    await user.click(selectAll);
    expect(screen.getByRole("group", { name: "السور" })).toHaveAccessibleDescription("تم اختيار الكل (٨)");
    expect(selectAll).toHaveAttribute("aria-disabled", "true");
    expect(selectAll).toHaveFocus();
    expect(screen.queryByRole("group", { name: "الأقسام المختارة" })).not.toBeInTheDocument();
    expect(goalBox().value).toContain("أريد حفظ كل الأقسام من");
    await user.click(screen.getByRole("button", { name: "مسح الاختيار" }));
    expect(screen.getByRole("group", { name: "السور" })).toHaveAccessibleDescription("لم تختر شيئًا بعد");
    expect(screen.getByRole("button", { name: "مسح الاختيار" })).toHaveFocus();
    expect(goalBox().value).toBe("");
  });

  it("shows the chips only from one to six checked rows", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    for (const ordinal of [1, 2, 3, 4, 5, 6]) await user.click(row(ordinal));
    expect(within(screen.getByRole("group", { name: "الأقسام المختارة" })).getAllByRole("button")).toHaveLength(6);
    await user.click(row(7));
    expect(screen.queryByRole("group", { name: "الأقسام المختارة" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "السور" })).toHaveAccessibleDescription("تم اختيار ٧ من ٨");
  });

  it("removes a chip: its row is unchecked, focus goes to the next chip, and the removal is announced", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    for (const ordinal of [1, 2, 3]) await user.click(row(ordinal));
    await user.click(screen.getByRole("button", { name: "إزالة عنصر تجريبي 2" }));
    expect(row(2)).not.toBeChecked();
    expect(screen.getByRole("button", { name: "إزالة عنصر تجريبي 3" })).toHaveFocus();
    expect(liveText()).toContain("أُزيل عنصر تجريبي 2. تم اختيار ٢ من ٨");
    // The last chip goes: focus moves to the previous one, then to the first row.
    await user.click(screen.getByRole("button", { name: "إزالة عنصر تجريبي 3" }));
    expect(screen.getByRole("button", { name: "إزالة عنصر تجريبي 1" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "إزالة عنصر تجريبي 1" }));
    expect(row(1)).toHaveFocus();
  });

  it("stays in the page flow: the rows are in a list, with no scroll area of their own", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    const list = within(screen.getByRole("group", { name: "السور" })).getByRole("list");
    expect(list.className).not.toMatch(/overflow|max-h/);
    expect(list.className).toContain("tablet:columns-2");
  });

  it("writes the catalog reference in the digits of the language", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    expect(row(3)).toHaveAccessibleName("عنصر تجريبي 3 ٣");
  });
});

describe("the juz' view", () => {
  it("offers one row for the whole edition and keeps the checked sections when the view switches", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(1));
    await user.click(row(2));
    await user.click(screen.getByRole("radio", { name: "حسب الجزء" }));
    const list = screen.getByRole("group", { name: "الأجزاء" });
    const juz = within(list).getByRole("checkbox", { name: /الجزء ٣٠/ });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(1);
    expect(juz).toBePartiallyChecked();
    expect(juz).toHaveAttribute("aria-checked", "mixed");
    expect(within(list).getByText("يشمل كل سور الطبعة (٨)")).toBeInTheDocument();
    expect(list).toHaveAccessibleDescription("تم اختيار ٢ من ٨");
    await user.click(juz);
    expect(juz).toBeChecked();
    expect(list).toHaveAccessibleDescription("تم اختيار الكل (٨)");
    // A single juz' chip stays, because the count is of sections and one chip stands for the row.
    expect(within(screen.getByRole("group", { name: "الأقسام المختارة" })).getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByRole("radio", { name: "حسب السورة" }));
    expect(within(screen.getByRole("group", { name: "السور" })).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    await user.click(screen.getByRole("radio", { name: "حسب الجزء" }));
    await user.click(within(screen.getByRole("group", { name: "الأجزاء" })).getByRole("checkbox"));
    expect(screen.getByRole("group", { name: "الأجزاء" })).toHaveAccessibleDescription("لم تختر شيئًا بعد");
  });

  it("names the next step «اختر جزءًا واحدًا على الأقل.» until the juz' row is checked", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickCategory(user, "القرآن الكريم");
    await user.click(screen.getByRole("radio", { name: "حسب الجزء" }));
    expect(startButton()).toHaveAccessibleDescription("اختر جزءًا واحدًا على الأقل.");
  });
});

describe("the hadith branch and the cascade rules", () => {
  it("lists the books, asks for one, then shows the hadith list and the path boxes with matn checked", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickCategory(user, "الحديث");
    const books = screen.getByRole("radiogroup", { name: "الكتاب" });
    expect(within(books).getAllByRole("radio")).toHaveLength(2);
    expect(within(books).getAllByText("مؤلف تجريبي · طبعة تجريبية")).toHaveLength(2);
    expect(startButton()).toHaveAccessibleDescription("اختر الكتاب.");
    expect(screen.queryByRole("group", { name: "الأحاديث" })).not.toBeInTheDocument();
    await user.click(within(books).getByRole("radio", { name: /كتاب hadith-1/ }));
    expect(screen.getByRole("group", { name: "الأحاديث" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "الأحاديث" })).getAllByRole("checkbox")).toHaveLength(4);
    const paths = screen.getByRole("group", { name: "ما تريد تعلمه" });
    expect(within(paths).getByRole("checkbox", { name: "متن" })).toBeChecked();
    expect(within(paths).getByRole("checkbox", { name: "سند" })).not.toBeChecked();
    expect(within(paths).getByRole("checkbox", { name: "الدرجة" })).not.toBeChecked();
    expect(startButton()).toHaveAccessibleDescription("اختر حديثًا واحدًا على الأقل.");
    expect(liveText()).toContain("أضيف خيار «ما تريد تعلمه»");
  });

  it("keeps one path checked: the last box is aria-disabled, stays checked and announces the helper", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickCategory(user, "الحديث");
    await user.click(screen.getByRole("radio", { name: /كتاب hadith-1/ }));
    const matn = screen.getByRole("checkbox", { name: "متن" });
    expect(matn).toHaveAttribute("aria-disabled", "true");
    await user.click(matn);
    expect(matn).toBeChecked();
    expect(matn).toHaveFocus();
    expect(liveText()).toContain("يبقى مسار واحد على الأقل.");
    await user.click(screen.getByRole("checkbox", { name: "سند" }));
    expect(matn).not.toHaveAttribute("aria-disabled");
    await user.click(matn);
    expect(matn).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "سند" })).toHaveAttribute("aria-disabled", "true");
  });

  it("clears the lower levels when the category changes, and level 3 when the book changes", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(1));
    await pickCategory(user, "الحديث");
    expect(screen.queryByRole("group", { name: "السور" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "طريقة الاختيار" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /كتاب hadith-1/ }));
    await user.click(within(screen.getByRole("group", { name: "الأحاديث" })).getAllByRole("checkbox")[0] as HTMLElement);
    await user.click(screen.getByRole("checkbox", { name: "سند" }));
    await user.click(screen.getByRole("radio", { name: /كتاب hadith-2/ }));
    const list = screen.getByRole("group", { name: "الأحاديث" });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(2);
    expect(list).toHaveAccessibleDescription("لم تختر شيئًا بعد");
    expect(screen.getByRole("checkbox", { name: "سند" })).not.toBeChecked();
    await pickCategory(user, "القرآن الكريم");
    await user.click(screen.getByRole("radio", { name: "حسب السورة" }));
    expect(within(screen.getByRole("group", { name: "السور" })).getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  });

  it("preselects a category that is the only one, and still shows it", async () => {
    const user = userEvent.setup();
    renderStart({ catalog: () => json({ editions: [CATALOG.editions[0]] }) });
    const group = await screen.findByRole("radiogroup", { name: "الباب" });
    expect(within(group).getAllByRole("radio")).toHaveLength(1);
    expect(within(group).getByRole("radio")).toBeChecked();
    expect(screen.getByRole("radiogroup", { name: "طريقة الاختيار" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "حسب السورة" }));
    expect(screen.getByRole("group", { name: "السور" })).toBeInTheDocument();
  });

  it("uses a native select for a level of six or more options (UI-tokens 6.5)", async () => {
    const many = Array.from({ length: 6 }, (_, index) => editionOf(`book-${index + 1}`, { slug: `cat-${index + 1}`, labelAr: `باب تجريبي ${index + 1}`, labelEn: `Category ${index + 1}` }, "hadith_collection", 2));
    renderStart({ catalog: () => json({ editions: many }) });
    const select = await screen.findByRole("combobox", { name: "الباب" });
    expect(within(select).getAllByRole("option").filter((option) => option.getAttribute("value"))).toHaveLength(6);
    await userEvent.setup().selectOptions(select, "cat-2");
    expect(screen.getByRole("group", { name: "الأحاديث" })).toBeInTheDocument();
  });
});

describe("the goal box (UA-13)", () => {
  async function withOneSection(user: ReturnType<typeof userEvent.setup>) {
    await pickQuranSurahs(user);
    await user.click(row(1));
  }

  it("follows the selection until the learner edits, then never overwrites, and restores on request", async () => {
    const user = userEvent.setup();
    renderStart();
    await withOneSection(user);
    const composed = goalBox().value;
    expect(screen.queryByRole("button", { name: "استعادة الجملة المقترحة" })).not.toBeInTheDocument();
    await user.click(row(2));
    expect(goalBox().value).toContain("عنصر تجريبي 1 وعنصر تجريبي 2");
    await user.type(goalBox(), " وأريد المزيد");
    const edited = goalBox().value;
    expect(edited).toContain("وأريد المزيد");
    await user.click(row(3));
    expect(goalBox().value).toBe(edited);
    await user.click(screen.getByRole("radio", { name: "٥ دقائق" }));
    expect(goalBox().value).toBe(edited);
    await user.click(screen.getByRole("button", { name: "استعادة الجملة المقترحة" }));
    expect(goalBox().value).toContain("عنصر تجريبي 1 وعنصر تجريبي 2 وعنصر تجريبي 3");
    expect(goalBox().value).toContain("بمعدل ٥ دقائق يوميًا");
    expect(goalBox().value).not.toBe(composed);
    expect(goalBox()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "استعادة الجملة المقترحة" })).not.toBeInTheDocument();
    expect(liveText()).toContain("تمت استعادة الجملة");
  });

  it("counts in code points out of 500, warns from 450 and judges, without truncating, above 500", async () => {
    const user = userEvent.setup();
    renderStart();
    await withOneSection(user);
    fireEvent.change(goalBox(), { target: { value: "ا".repeat(449) } });
    expect(screen.getByText("٤٤٩/٥٠٠", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByText("٤٤٩/٥٠٠", { selector: "bdi" }).closest("p")).toHaveClass("text-ink-secondary");
    fireEvent.change(goalBox(), { target: { value: "ا".repeat(450) } });
    expect(screen.getByText("٤٥٠/٥٠٠", { selector: "bdi" }).closest("p")).toHaveClass("text-warning-ink");
    expect(liveText()).toContain("٤٥٠/٥٠٠");
    fireEvent.change(goalBox(), { target: { value: "ا".repeat(501) } });
    expect(goalBox().value).toHaveLength(501);
    expect(goalBox()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("٥٠١/٥٠٠", { selector: "bdi" }).closest("p")).toHaveClass("text-error-ink");
    expect(screen.getByText("الهدف حتى ٥٠٠ حرف.", { selector: "p:not([role])" })).toBeInTheDocument();
    expect(goalBox()).toHaveAccessibleDescription(expect.stringContaining("الهدف حتى ٥٠٠ حرف."));
    expect(liveText()).toContain("الهدف حتى ٥٠٠ حرف.");
    expect(goalBox()).not.toHaveAttribute("maxlength");
  });

  it("counts a character outside the basic plane once", async () => {
    const user = userEvent.setup();
    renderStart();
    await withOneSection(user);
    fireEvent.change(goalBox(), { target: { value: "\u{1F600}".repeat(300) } });
    expect(screen.getByText("٣٠٠/٥٠٠", { selector: "bdi" })).toBeInTheDocument();
  });

  it("describes the box by its helper, its counter and its error, and never reads it as a one-line field", async () => {
    const user = userEvent.setup();
    renderStart();
    await withOneSection(user);
    expect(goalBox().tagName).toBe("TEXTAREA");
    expect(goalBox()).toHaveAttribute("dir", "auto");
    expect(goalBox()).toHaveAccessibleDescription(expect.stringContaining("لا تكتب اسمك أو أي بيانات شخصية."));
    await user.type(goalBox(), "{Enter}x");
    expect(goalBox().value).toContain("\n");
    expect(navigation.router.push).not.toHaveBeenCalled();
  });
});

describe("the date and the validation of the start press", () => {
  async function ready(user: ReturnType<typeof userEvent.setup>) {
    await pickQuranSurahs(user);
    await user.click(row(1));
  }
  const dateInput = () => screen.getByLabelText("الموعد المفضل (اختياري)") as HTMLInputElement;

  it("sets min to today in the account time zone and offers a clear action once a date is set", async () => {
    const user = userEvent.setup();
    renderStart();
    await ready(user);
    expect(dateInput()).toHaveAttribute("type", "date");
    expect(dateInput().min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.queryByRole("button", { name: "مسح الموعد" })).not.toBeInTheDocument();
    fireEvent.change(dateInput(), { target: { value: "2999-01-01" } });
    expect(goalBox().value).toContain("وأن أنهيه بحلول");
    await user.click(screen.getByRole("button", { name: "مسح الموعد" }));
    expect(dateInput().value).toBe("");
    expect(goalBox().value).toContain("دون موعد محدد");
  });

  it("rejects a past date: the error shows on blur, the press does not navigate and focus goes to the field", async () => {
    const user = userEvent.setup();
    renderStart();
    await ready(user);
    fireEvent.change(dateInput(), { target: { value: "2020-01-01" } });
    fireEvent.blur(dateInput());
    expect(screen.getByText("اختر موعدًا من اليوم فصاعدًا.")).toBeInTheDocument();
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
    await user.click(startButton());
    expect(navigation.router.push).not.toHaveBeenCalled();
    expect(dateInput()).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // one error: no summary
  });

  it("rejects an empty box on the press, with the button still enabled and focus on the box", async () => {
    const user = userEvent.setup();
    renderStart();
    await ready(user);
    await user.clear(goalBox());
    expect(startButton()).toHaveAttribute("aria-disabled", "false");
    await user.click(startButton());
    expect(screen.getByText("اكتب هدفك أو استعد الجملة المقترحة.")).toBeInTheDocument();
    expect(goalBox()).toHaveFocus();
    expect(navigation.router.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "استعادة الجملة المقترحة" }));
    expect(screen.queryByText("اكتب هدفك أو استعد الجملة المقترحة.")).not.toBeInTheDocument();
  });

  it("lists two errors in a summary of links, and puts focus on the first invalid field", async () => {
    const user = userEvent.setup();
    renderStart();
    await ready(user);
    fireEvent.change(dateInput(), { target: { value: "2020-01-01" } });
    await user.clear(goalBox());
    await user.click(startButton());
    const summary = screen.getByRole("alert");
    expect(within(summary).getByText("يوجد خطآن في النموذج")).toBeInTheDocument();
    expect(within(summary).getAllByRole("link")).toHaveLength(2);
    expect(dateInput()).toHaveFocus();
    await user.click(within(summary).getByRole("link", { name: "اكتب هدفك أو استعد الجملة المقترحة." }));
    expect(goalBox()).toHaveFocus();
  });
});

describe("the hand-off to S-09 (guard 5)", () => {
  it("builds the selection, keeps it in memory with the form, sends nothing and goes to /placement", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(5));
    await user.click(row(2));
    await user.click(screen.getByRole("radio", { name: "١٥ دقيقة" }));
    fireEvent.change(screen.getByLabelText("الموعد المفضل (اختياري)"), { target: { value: "2999-01-01" } });
    const goal = goalBox().value;
    await waitFor(() => expect(calls).toContain("GET /api/today"));
    const before = calls.length;
    await user.click(startButton());
    expect(navigation.router.push).toHaveBeenCalledTimes(1);
    expect(navigation.router.push).toHaveBeenCalledWith("/placement");
    expect(getStartDraft()?.selection).toEqual({
      editionId: "quran-1",
      targetScope: { sectionOrdinals: [2, 5] },
      paths: ["quran"],
      sessionMinutes: 15,
      preferredDate: "2999-01-01",
      goalText: goal.trim(),
    });
    expect(calls.length).toBe(before); // no request on submit (R02, D34)
  });

  it("hands over the checked hadith paths and the hadith edition", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickCategory(user, "الحديث");
    await user.click(screen.getByRole("radio", { name: /كتاب hadith-2/ }));
    await user.click(within(screen.getByRole("group", { name: "الأحاديث" })).getAllByRole("checkbox")[1] as HTMLElement);
    await user.click(screen.getByRole("checkbox", { name: "سند" }));
    await user.click(startButton());
    expect(getStartDraft()?.selection).toMatchObject({ editionId: "hadith-2", targetScope: { sectionOrdinals: [2] }, paths: ["matn", "sanad"], sessionMinutes: 10, preferredDate: null });
    expect(navigation.router.push).toHaveBeenCalledWith("/placement");
  });

  it("restores every level, the checked sections, the paths, the minutes and the goal text when the learner comes back", async () => {
    const user = userEvent.setup();
    const first = renderStart();
    await pickCategory(user, "الحديث");
    await user.click(screen.getByRole("radio", { name: /كتاب hadith-1/ }));
    const boxes = within(screen.getByRole("group", { name: "الأحاديث" })).getAllByRole("checkbox");
    await user.click(boxes[0] as HTMLElement);
    await user.click(boxes[3] as HTMLElement);
    await user.click(screen.getByRole("checkbox", { name: "الدرجة" }));
    await user.click(screen.getByRole("radio", { name: "٥ دقائق" }));
    await user.type(goalBox(), " نص خاص");
    const typed = goalBox().value;
    await user.click(startButton());
    first.unmount();

    renderStart();
    await screen.findByRole("radiogroup", { name: "الباب" });
    await waitFor(() => expect(screen.getByRole("group", { name: "الأحاديث" })).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "الحديث" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /كتاب hadith-1/ })).toBeChecked();
    const restored = within(screen.getByRole("group", { name: "الأحاديث" })).getAllByRole("checkbox") as HTMLInputElement[];
    expect(restored.map((box) => box.checked)).toEqual([true, false, false, true]);
    expect(screen.getByRole("checkbox", { name: "الدرجة" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "متن" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "سند" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "٥ دقائق" })).toBeChecked();
    expect(goalBox().value).toBe(typed);
    expect(screen.getByRole("button", { name: "استعادة الجملة المقترحة" })).toBeInTheDocument();
    expect(startButton()).toHaveAttribute("aria-disabled", "false");
    // Restoring is silent: nothing was announced for what the screen put back.
    expect(liveText()).not.toContain("ظهرت قائمة");
  });

  it("does not trust a draft that no longer fits the catalog: a missing edition shows level 1 only", async () => {
    setStartDraft({
      selection: { editionId: "gone", targetScope: { sectionOrdinals: [1] }, paths: ["quran"], sessionMinutes: 10, preferredDate: null, goalText: "x" },
      form: { categorySlug: "gone", editionId: "gone", view: null, ordinals: [1], paths: null, minutes: null, date: "", goalEdited: false, goalText: "" },
    });
    renderStart();
    await screen.findByRole("radiogroup", { name: "الباب" });
    expect(screen.getByRole("radio", { name: "القرآن الكريم" })).not.toBeChecked();
    expect(startButton()).toHaveAttribute("aria-disabled", "true");
  });
});

describe("the open conversation, the plan close control and the failures", () => {
  it("offers the open conversation (c4) as a link to S-34", async () => {
    renderStart({ today: () => json({ ...mockToday, openPlanChatId: "chat-1" }) });
    const link = await screen.findByRole("link", { name: "متابعة المحادثة" });
    expect(link).toHaveAttribute("href", "/plan/chat/chat-1");
    expect(screen.getByText("لديك محادثة خطة لم تعتمدها بعد. إن بدأت محادثة جديدة فستحلّ محلها.")).toBeInTheDocument();
  });

  it("gives a learner with an active plan a way back to S-12", async () => {
    renderStart({ today: () => json(mockToday) });
    const back = await screen.findByRole("link", { name: "رجوع إلى الخطة الكبرى" });
    expect(back).toHaveAttribute("href", "/plan");
  });

  it("shows no stale list when E14 fails, and a retry that reads again", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderStart({
      catalog: () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(503, "unavailable", "Down.") : json(CATALOG);
      },
    });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "الباب" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(await screen.findByRole("radiogroup", { name: "الباب" })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("raises a generic alert for an internal error", async () => {
    renderStart({ catalog: () => errorResponse(500, "internal", "Boom.") });
    expect(await screen.findByRole("alert")).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
  });

  it("sends a learner whose session ended to the login screen with the note, and shows no list", async () => {
    renderStart({ catalog: () => errorResponse(401, "unauthenticated", "No session.") });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("shows skeleton rows after 300 ms while E14 is in flight, marked busy", async () => {
    renderStart({ latencyMs: 1000 });
    const group = screen.getByText("الباب").closest("fieldset") as HTMLElement;
    expect(group).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(group.querySelectorAll("div[aria-hidden=true].bg-disabled").length).toBeGreaterThan(0), { timeout: 1500 });
  });
});

describe("the English interface", () => {
  it("writes the screen, the counts and the sentence in English with Western digits and the same structure", async () => {
    const user = userEvent.setup();
    renderStart({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "What is your plan?" })).toBeInTheDocument();
    await user.click(await screen.findByRole("radio", { name: "The Quran" }));
    await user.click(screen.getByRole("radio", { name: "By surah" }));
    const list = screen.getByRole("group", { name: "Surahs" });
    expect(list).toHaveAccessibleDescription("Nothing selected yet");
    expect(startButton("en")).toHaveAccessibleDescription("Choose at least one surah.");
    await user.click(screen.getByRole("checkbox", { name: "Sample item 1 1" }));
    await user.click(screen.getByRole("checkbox", { name: "Sample item 2 2" }));
    expect(list).toHaveAccessibleDescription("2 of 8 selected");
    expect(goalBox().value).toBe("I want to memorize Sample item 1 and Sample item 2 of Book quran-1 (طبعة تجريبية) from The Quran, at 10 minutes a day, with no set date, with the English interface.");
    expect(screen.getByRole("radio", { name: "5 minutes" })).toBeInTheDocument();
    expect(screen.getByText(/Your plan is built and revised in a conversation with an AI assistant/)).toBeInTheDocument();
    expect(document.title).toBe("What is your plan? · Qatra");
  });

  it("rebuilds the unedited sentence in the new language when the language switch is used", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(1));
    expect(goalBox().value.startsWith("أريد حفظ")).toBe(true);
    await user.click(screen.getByRole("radio", { name: "English (EN)" }));
    await waitFor(() => expect(goalBox().value.startsWith("I want to memorize")).toBe(true));
    expect(screen.getByRole("heading", { level: 1, name: "What is your plan?" })).toBeInTheDocument();
  });
});

describe("the structure for assistive technology", () => {
  it("labels every control with its visible text and groups each level in a fieldset with a legend", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickQuranSurahs(user);
    await user.click(row(1));
    for (const name of ["الباب", "طريقة الاختيار", "السور", "وقتك اليومي"]) {
      const group = screen.getByRole(name === "السور" ? "group" : "radiogroup", { name });
      expect(group.tagName).toBe("FIELDSET");
      expect(group.querySelector("legend")).toHaveTextContent(name);
    }
    expect(screen.getByLabelText("الموعد المفضل (اختياري)")).toBeInTheDocument();
    expect(goalBox()).toBeInTheDocument();
    // Skip link first, then the language switch, as the focus order of S-08 says.
    const focusable = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select")).filter((node) => !node.hasAttribute("disabled"));
    expect(focusable[0]?.textContent).toContain("انتقل إلى المحتوى");
  });

  it("does not move focus when a level appears", async () => {
    const user = userEvent.setup();
    renderStart();
    await pickCategory(user, "القرآن الكريم");
    expect(screen.getByRole("radio", { name: "القرآن الكريم" })).toHaveFocus();
    await act(async () => undefined);
  });
});
