import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { CatalogScreen } from "@/components/catalog/CatalogScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { mockCatalog } from "@/lib/api/mock";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import type { CatalogEdition, CatalogSection } from "@/lib/api/types";

const [quran, hadith] = mockCatalog.editions as [CatalogEdition, CatalogEdition];
const ok = (body: unknown): MockResponse => ({ status: 200, body });
const serve = (editions: CatalogEdition[]): Record<string, MockHandler> => ({ "GET /catalog": () => ok({ editions }) });
const WAKING_AR = "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.";

let runtime: ApiRuntime | undefined;

function renderCatalog({
  language = "ar",
  handlers = {},
  scenario = { signedIn: false },
  latencyMs = 0,
}: { language?: "ar" | "en"; handlers?: Record<string, MockHandler>; scenario?: Partial<MockScenario>; latencyMs?: number } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({ latencyMs, handlers: { ...mockHandlers, ...handlers }, scenario });
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`);
    return mock(input, init);
  });
  runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <CatalogScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, calls, count: (key: string) => calls.filter((call) => call === key).length };
}

const section = (ordinal: number, change: Partial<CatalogSection> = {}): CatalogSection => ({
  sectionId: `22222222-2222-4222-8222-0000000001${String(ordinal).padStart(2, "0")}`,
  ordinal,
  kind: "surah",
  reference: String(77 + ordinal),
  titleAr: `اسم القسم ${ordinal}`,
  titleEn: `Surah ${77 + ordinal}`,
  wordCount: 20 + ordinal,
  passageCount: 1,
  paths: ["quran"],
  ...change,
});

const cardOf = (title: string): HTMLElement => screen.getByRole("heading", { level: 3, name: title }).closest("li") as HTMLElement;
const summaryOf = (card: HTMLElement): HTMLElement => card.querySelector("summary") as HTMLElement;
const detailsOf = (card: HTMLElement): HTMLDetailsElement => card.querySelector("details") as HTMLDetailsElement;

// True when `after` comes later in the page than `before`: the DOM order that the spec's focus order rests on.
const follows = (before: Element, after: Element): boolean => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  // Testing Library drains its queue with a timer it only advances when it finds a jest global: the fake clock of the throttle test needs that.
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  runtime = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetLocaleStoreForTests();
  vi.restoreAllMocks();
});

describe("S-07 populated, Arabic", () => {
  it("shows the H1, the intro, the notice, the category headings and one card per edition with the specified copy", async () => {
    renderCatalog();
    const heading = await screen.findByRole("heading", { level: 1, name: "تصفّح الكتب" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("تصفّح الكتب · قطرة غيث");
    expect(screen.getByText("اطّلع على الكتب والأقسام المتاحة قبل إنشاء حسابك. لا يُعرض هنا نص الكتاب؛ يبدأ التعلم بعد إنشاء الحساب.")).toBeInTheDocument();
    expect(screen.getByText("يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح.")).toBeInTheDocument();

    await screen.findByRole("heading", { level: 3, name: quran.titleAr });
    expect(screen.getAllByRole("heading", { level: 2, name: quran.category.labelAr })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);

    const quranCard = cardOf(quran.titleAr);
    expect(quranCard).toHaveTextContent(`${quran.author} · ${quran.editionLabel}`);
    expect(quranCard).toHaveTextContent("قسمان · ١٠٠ كلمة");
    expect(quranCard).toHaveTextContent("المسارات المتاحة: النص القرآني");

    const hadithCard = cardOf(hadith.titleAr);
    expect(hadithCard).toHaveTextContent("قسم واحد · ٣٠ كلمةً");
    expect(hadithCard).toHaveTextContent("المسارات المتاحة: المتن، السند، الدرجة");
  });

  it("gives the editions of one category a single heading", async () => {
    const second: CatalogEdition = { ...quran, editionId: "11111111-1111-4111-8111-0000000000e3", editionKey: "second-edition", titleAr: "عنوان ثانٍ", titleEn: "Second title" };
    renderCatalog({ handlers: serve([quran, second, hadith]) });
    await screen.findByRole("heading", { level: 3, name: "عنوان ثانٍ" });
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    const group = screen.getAllByRole("heading", { level: 2 })[0]!.closest("section") as HTMLElement;
    expect(within(group).getAllByRole("heading", { level: 3 }).map((entry) => entry.textContent)).toEqual([quran.titleAr, "عنوان ثانٍ"]);
  });

  it("is the whole screen with no religious text, no outbound link and no per-book action", async () => {
    renderCatalog();
    await screen.findByRole("heading", { level: 3, name: quran.titleAr });
    expect(document.querySelectorAll("a[href^='http']")).toHaveLength(0);
    for (const card of [cardOf(quran.titleAr), cardOf(hadith.titleAr)]) {
      expect(within(card).queryAllByRole("link")).toHaveLength(0);
      expect(within(card).queryAllByRole("button")).toHaveLength(0);
    }
    expect(screen.queryByRole("button")).toBeNull();
    // Only the skip link, the logo and the two actions (twice) are links; no start-a-plan control exists here.
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs.sort()).toEqual(["#main", "/", "/login", "/login", "/register", "/register"]);
  });

  it("is read-only: no translation, commentary or ranking words", async () => {
    renderCatalog();
    await screen.findByRole("heading", { level: 3, name: quran.titleAr });
    expect(document.body.textContent ?? "").not.toMatch(/ترجمة|تفسير|شرح الحديث|ترتيب|مستخدم/);
  });
});

describe("S-07 populated, English", () => {
  it("shows the English copy, the English titles only and Western digits", async () => {
    renderCatalog({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Browse books" })).toBeInTheDocument();
    expect(document.title).toBe("Browse books · Qatra");
    expect(screen.getByText("See the books and sections available before you create an account. The text of the books is not shown here; learning starts after you create an account.")).toBeInTheDocument();
    expect(screen.getByText("The app shows the book as it is in its verified edition for memorization, without additions or explanation.")).toBeInTheDocument();

    const quranCard = cardOf(quran.titleEn);
    expect(quranCard).toHaveTextContent("2 sections · 100 words");
    expect(quranCard).toHaveTextContent("Available paths: Quran text");
    const hadithCard = cardOf(hadith.titleEn);
    expect(hadithCard).toHaveTextContent("1 section · 30 words");
    expect(hadithCard).toHaveTextContent("Available paths: Matn, Sanad, Grade");
    expect(screen.getAllByRole("heading", { level: 2, name: quran.category.labelEn })).toHaveLength(2);
    // The Arabic book title is not repeated under the English one (O-19, interim choice).
    expect(screen.queryByText(quran.titleAr)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/[٠-٩]/);
  });

  it("switches language without a new read", async () => {
    const view = renderCatalog();
    await screen.findByRole("heading", { level: 3, name: quran.titleAr });
    await userEvent.setup().click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Browse books" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: quran.titleEn })).toBeInTheDocument();
    expect(view.count("GET /catalog")).toBe(1);
  });
});

describe("S-07 the section disclosure", () => {
  const sections = Array.from({ length: 37 }, (_, index) => section(index + 1));
  const big: CatalogEdition = { ...quran, sections };

  it("starts collapsed, names its count and lists every section as a plain row when opened", async () => {
    const user = userEvent.setup();
    renderCatalog({ handlers: serve([big]) });
    await screen.findByRole("heading", { level: 3, name: big.titleAr });
    const card = cardOf(big.titleAr);
    expect(detailsOf(card).open).toBe(false);
    expect(summaryOf(card)).toHaveTextContent("الأقسام (٣٧)");
    expect(summaryOf(card).className).toContain("min-h-row");

    await user.click(summaryOf(card));
    expect(detailsOf(card).open).toBe(true);
    const rows = within(detailsOf(card)).getAllByRole("listitem");
    expect(rows).toHaveLength(37);
    expect(rows[0]).toHaveTextContent("اسم القسم 1 · 78");
    expect(rows[0]).toHaveTextContent("٢١ كلمةً · مقطع واحد");
    expect(rows[36]).toHaveTextContent("اسم القسم 37 · 114");
    for (const row of rows) {
      expect(row.className).toContain("min-h-row");
      expect(within(row).queryAllByRole("link")).toHaveLength(0);
    }
    expect(within(detailsOf(card)).getByRole("list")).toBeInTheDocument();
  });

  it("toggles closed again and does not remember the state in a second card", async () => {
    const user = userEvent.setup();
    renderCatalog({ handlers: serve([quran, hadith]) });
    await screen.findByRole("heading", { level: 3, name: quran.titleAr });
    const first = cardOf(quran.titleAr);
    await user.click(summaryOf(first));
    expect(detailsOf(first).open).toBe(true);
    expect(detailsOf(cardOf(hadith.titleAr)).open).toBe(false);
    await user.click(summaryOf(first));
    expect(detailsOf(first).open).toBe(false);
  });

  it("shows the Arabic title with its reference in the Arabic UI, and the English title alone in the English UI", async () => {
    const user = userEvent.setup();
    renderCatalog({ handlers: serve([big]) });
    await screen.findByRole("heading", { level: 3, name: big.titleAr });
    const row = within(detailsOf(cardOf(big.titleAr))).getAllByRole("listitem")[0] as HTMLElement;
    expect(row.querySelector("bdi[dir=ltr]")).toHaveTextContent("78");
    await user.click(screen.getByRole("radio", { name: "English (EN)" }));
    const english = within(detailsOf(cardOf(big.titleEn))).getAllByRole("listitem")[0] as HTMLElement;
    expect(english).toHaveTextContent("Surah 78");
    expect(english).toHaveTextContent("21 words · 1 passage");
    expect(english.textContent).not.toContain("اسم القسم");
    expect(english.querySelector("bdi[dir=ltr]")).toBeNull();
    expect(summaryOf(cardOf(big.titleEn))).toHaveTextContent("Sections (37)");
  });
});

describe("S-07 header and body actions", () => {
  it("renders the pair twice, once in the header from 768 px and once under the intro below it, with the right targets", async () => {
    renderCatalog();
    await screen.findByRole("heading", { level: 1, name: "تصفّح الكتب" });
    const header = screen.getByRole("banner");
    const main = screen.getByRole("main");
    for (const region of [header, main]) {
      expect(within(region).getByRole("link", { name: "إنشاء حساب" })).toHaveAttribute("href", "/register");
      expect(within(region).getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
    }
    expect(screen.getAllByRole("link", { name: "إنشاء حساب" })).toHaveLength(2);
    // CSS removes one instance per width (display none takes it out of the tab order).
    expect(within(header).getByRole("link", { name: "إنشاء حساب" }).parentElement?.className).toMatch(/\bhidden\b.*\btablet:flex\b/);
    expect(within(main).getByRole("link", { name: "إنشاء حساب" }).parentElement?.className).toContain("tablet:hidden");
  });

  it("puts the primary action first, as a button-sized link, and keeps the focus order: logo, actions, switch", async () => {
    renderCatalog();
    await screen.findByRole("heading", { level: 1, name: "تصفّح الكتب" });
    const header = screen.getByRole("banner");
    const logo = within(header).getByRole("link", { name: "قطرة غيث" });
    const create = within(header).getByRole("link", { name: "إنشاء حساب" });
    const login = within(header).getByRole("link", { name: "تسجيل الدخول" });
    const group = within(header).getByRole("radiogroup", { name: "اللغة" });
    expect(logo).toHaveAttribute("href", "/");
    expect(follows(logo, create)).toBe(true);
    expect(follows(create, login)).toBe(true);
    expect(follows(login, group)).toBe(true);
    expect(create.className).toContain("min-h-button");
    expect(create.className).toContain("bg-primary");
    expect(login.className).not.toContain("bg-primary");
    // The body copy comes after the heading and the intro, before the notice and the cards.
    const main = screen.getByRole("main");
    const bodyCreate = within(main).getByRole("link", { name: "إنشاء حساب" });
    expect(follows(screen.getByRole("heading", { level: 1 }), bodyCreate)).toBe(true);
    expect(follows(bodyCreate, screen.getByText("يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح."))).toBe(true);
  });

  it("names both actions in English", async () => {
    renderCatalog({ language: "en" });
    await screen.findByRole("heading", { level: 1, name: "Browse books" });
    expect(screen.getAllByRole("link", { name: "Create an account" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Log in" })).toHaveLength(2);
  });
});

describe("S-07 guard 2 (visitors only)", () => {
  it("leaves a visitor on the page", async () => {
    renderCatalog({ scenario: { signedIn: false } });
    await screen.findByRole("heading", { level: 3, name: quran.titleAr });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("sends a signed-in learner with a plan to /today", async () => {
    renderCatalog({ scenario: { signedIn: true, hasPlan: true } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("sends a signed-in learner without a plan to /start", async () => {
    renderCatalog({ scenario: { signedIn: true, hasPlan: false } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
  });
});

describe("S-07 loading", () => {
  it("shows no blocks before 300 ms, then two card skeletons with no numbers, then the list", async () => {
    renderCatalog({ latencyMs: 600 });
    const region = screen.getByTestId("catalog-skeleton");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.querySelector("[aria-hidden='true']")).toBeNull();
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("catalog-skeleton").querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0));
    expect(document.body.textContent ?? "").not.toMatch(/[٠-٩]/);
    expect(screen.getByRole("heading", { level: 1, name: "تصفّح الكتب" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 3, name: quran.titleAr })).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-skeleton")).toBeNull();
  });
});

describe("S-07 empty", () => {
  it("shows the empty state with its sentence, keeps the actions and the notice, and announces it politely", async () => {
    renderCatalog({ handlers: serve([]) });
    expect(await screen.findByRole("heading", { level: 2, name: "لا توجد كتب متاحة الآن." })).toBeInTheDocument();
    expect(screen.getByText("ستظهر هنا الكتب فور نشرها.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getAllByRole("link", { name: "إنشاء حساب" })).toHaveLength(2);
    expect(screen.getByText("يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح.")).toBeInTheDocument();
    const announced = screen.getAllByText("لا توجد كتب متاحة الآن.").find((element) => element.closest("[role=status]"));
    expect(announced?.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
  });

  it("says it in English too", async () => {
    renderCatalog({ language: "en", handlers: serve([]) });
    expect(await screen.findByRole("heading", { level: 2, name: "No books are available right now." })).toBeInTheDocument();
    expect(screen.getByText("Books will appear here as soon as they are published.")).toBeInTheDocument();
  });
});

describe("S-07 failures", () => {
  it("a service error shows the warning with «إعادة المحاولة», no list, focus on the button, and a retry reads again and moves focus to the heading", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const view = renderCatalog({ handlers: { "GET /catalog": (request, scenario) => (answers++ === 0 ? errorResponse(503, "unavailable", "Down.") : (mockHandlers["GET /catalog"] as MockHandler)(request, scenario)) } });
    const text = await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.");
    expect(text.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    const retry = screen.getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "تصفّح الكتب" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "إنشاء حساب" })).toHaveLength(2);

    await user.click(retry);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(await screen.findByRole("heading", { level: 3, name: quran.titleAr })).toBeInTheDocument();
    expect(view.count("GET /catalog")).toBe(2);
    expect(screen.queryByText(/الخدمة غير متاحة/)).toBeNull();
  });

  it("an unexpected error is an alert with «إعادة المحاولة» and focus on it", async () => {
    renderCatalog({ handlers: { "GET /catalog": () => errorResponse(500, "internal", "Boom.") } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    const retry = within(alert).getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).toHaveFocus();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("shows the English wording of a service error", async () => {
    renderCatalog({ language: "en", handlers: { "GET /catalog": () => errorResponse(503, "unavailable", "Down.") } });
    expect(await screen.findByText("The service is temporarily unavailable. Try again shortly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("a forbidden origin offers to reload the page, which is the one thing that helps", async () => {
    const user = userEvent.setup();
    renderCatalog({ handlers: { "GET /catalog": () => errorResponse(403, "forbidden_origin", "No.") } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.");
    await user.click(within(alert).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("offline shows the Info banner of P-05 with «إعادة المحاولة», no error tone, and focus is left alone", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    renderCatalog({ handlers: { "GET /catalog": lost, "GET /health": lost, "GET /me": lost } });
    const text = await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.");
    expect(text.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    const retry = screen.getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).not.toHaveFocus();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("a throttle shows the wait, an inert but focusable retry tied to the banner, and ignores a press until the time is up", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const view = renderCatalog({ handlers: { "GET /catalog": () => errorResponse(429, "throttled", "Slow.", { retryAfterSec: 20 }) } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const text = "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.";
    const banner = screen.getByText(text);
    expect(banner.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
    const retry = screen.getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();
    expect(document.getElementById(retry.getAttribute("aria-describedby") as string)).toContainElement(banner);
    retry.focus();
    expect(retry).toHaveFocus();

    // The visible line counts for the eye only and the wording of the banner never changes.
    const line = document.querySelector("p[aria-hidden=true] bdi") as HTMLElement;
    expect(line).toHaveAttribute("dir", "ltr");
    expect(line).toHaveTextContent("٠٠:٢٠");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(line).toHaveTextContent("٠٠:١٥");
    expect(screen.getByText(text)).toBeInTheDocument();
    await user.click(retry);
    expect(view.count("GET /catalog")).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(retry).toHaveFocus();
    const done = screen.getByText("يمكنك المحاولة الآن.");
    expect(done).toHaveClass("sr-only");
    expect(done.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(document.querySelector("p[aria-hidden=true] bdi")).toBeNull();
    await user.click(retry);
    expect(view.count("GET /catalog")).toBe(2);
  });

  it("a long throttle (the 15 minute lock) is written as mm:ss", async () => {
    renderCatalog({ handlers: { "GET /catalog": () => errorResponse(429, "throttled", "Slow.", { retryAfterSec: 900 }) } });
    const text = await screen.findByText(/محاولات كثيرة\. يمكنك المحاولة بعد/);
    expect(text).toHaveTextContent("محاولات كثيرة. يمكنك المحاولة بعد ١٥:٠٠.");
    expect(text.querySelector("bdi")).toHaveAttribute("dir", "ltr");
  });

  it("while the server wakes it shows the wake-up banner under the intro and keeps the skeleton, then reads again once health answers", async () => {
    let healthy = false;
    let catalogAnswers = 0;
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    // A sleeping server answers none of its routes, the visitor probe of guard 2 included.
    const whenAwake = (key: string): MockHandler => (request, scenario) => (healthy ? (mockHandlers[key] as MockHandler)(request, scenario) : lost());
    const view = renderCatalog({
      handlers: {
        "GET /catalog": (request, scenario) => {
          if (catalogAnswers++ === 0) return lost();
          return (mockHandlers["GET /catalog"] as MockHandler)(request, scenario);
        },
        "GET /health": whenAwake("GET /health"),
        "GET /me": whenAwake("GET /me"),
      },
    });
    const line = await screen.findByText(WAKING_AR, {}, { timeout: 4000 });
    expect(line.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(follows(screen.getByText("اطّلع على الكتب والأقسام المتاحة قبل إنشاء حسابك. لا يُعرض هنا نص الكتاب؛ يبدأ التعلم بعد إنشاء الحساب."), line)).toBe(true);
    expect(screen.getByTestId("catalog-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).toBeNull();
    // The shell's own wake-up line is off: the banner is the only one.
    expect(screen.getAllByText(WAKING_AR)).toHaveLength(1);

    healthy = true;
    expect(await screen.findByRole("heading", { level: 3, name: quran.titleAr }, { timeout: 6000 })).toBeInTheDocument();
    expect(view.count("GET /catalog")).toBe(2);
    expect(screen.queryByText(WAKING_AR)).toBeNull();
    expect(screen.getByText("الخادم جاهز. يمكنك المحاولة الآن.")).toBeInTheDocument();
  }, 15_000);
});
