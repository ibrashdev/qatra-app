import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/sources", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { SourcesScreen } from "@/components/sources/SourcesScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { mockCatalog, mockToday } from "@/lib/api/mock";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import type { CatalogEdition } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";

const [quran, hadith] = mockCatalog.editions as [CatalogEdition, CatalogEdition];
const ok = (body: unknown): MockResponse => ({ status: 200, body });
const serve = (editions: CatalogEdition[]): Record<string, MockHandler> => ({ "GET /catalog": () => ok({ editions }) });
const NOTICE_AR = "يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح.";
const TAKHRIJ_AR = "التخريج والدرجة منقولان كما وردا في سجل HadeethEnc، ويُعرضان موسومين بأنهما من سجله، دون تعديل أو إضافة. وحين لا تنسب الطبعة الحديث إلى الصحيحين ولا تذكر درجته يظهر بجانبه تنبيه ثابت.";
const UNAVAILABLE_LINE_AR = "هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.";

let runtime: ApiRuntime | undefined;

function renderSources({
  language = "ar",
  handlers = {},
  scenario = { signedIn: true, hasPlan: true },
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
        <SourcesScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, calls, count: (key: string) => calls.filter((call) => call === key).length };
}

const cardOf = (title: string): HTMLElement => screen.getByRole("heading", { level: 2, name: title }).closest("li") as HTMLElement;

// The plan of the mock account is on the Quran edition, so these two lists decide whether its book is still listed.
const planListed = serve([quran, hadith]);
const planGone = serve([hadith]);

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  clearLoginArrival();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
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

describe("S-25 populated, Arabic", () => {
  it("shows the back control, the H1, the fixed notice and one card per edition with the specified lines", async () => {
    renderSources({ handlers: planListed });
    const heading = await screen.findByRole("heading", { level: 1, name: "المصادر" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("المصادر · قطرة غيث");
    expect(screen.getByRole("link", { name: "رجوع إلى الإعدادات" })).toHaveAttribute("href", "/settings");
    expect(screen.getByText(NOTICE_AR)).toBeInTheDocument();

    await screen.findByRole("heading", { level: 2, name: quran.titleAr });
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);

    const quranCard = cardOf(quran.titleAr);
    expect(quranCard).toHaveTextContent(`${quran.author} · ${quran.editionLabel}`);
    expect(quranCard).toHaveTextContent(`الباب: ${quran.category.labelAr}`);
    expect(quranCard).toHaveTextContent("طريقة المرجع: السورة والآية، مع رابط مرجعي بجانب النص بدل رقم الصفحة.");

    const hadithCard = cardOf(hadith.titleAr);
    expect(hadithCard).toHaveTextContent("طريقة المرجع: رقم الحديث، مع رابط مرجعي بجانب النص بدل رقم الصفحة.");
  });

  it("adds the takhrij note to a hadith edition only, and not to a Quran edition", async () => {
    renderSources({ handlers: planListed });
    await screen.findByRole("heading", { level: 2, name: quran.titleAr });
    expect(within(cardOf(hadith.titleAr)).getByText(TAKHRIJ_AR)).toBeInTheDocument();
    expect(within(cardOf(quran.titleAr)).queryByText(TAKHRIJ_AR)).toBeNull();
    expect(screen.getAllByText(TAKHRIJ_AR)).toHaveLength(1);
  });

  it("keeps the order of E14 and shows no outbound link, publisher, translation or text of a book", async () => {
    renderSources({ handlers: planListed });
    await screen.findByRole("heading", { level: 2, name: quran.titleAr });
    expect(screen.getAllByRole("heading", { level: 2 }).map((entry) => entry.textContent)).toEqual([quran.titleAr, hadith.titleAr]);
    expect(document.querySelectorAll("a[href^='http']")).toHaveLength(0);
    // The only link is the back control (the shell adds its own); the cards have none, and there is no button.
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/settings"]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/ترجمة|تفسير|QuranEnc|islamhouse/i);
  });

  it("puts the Arabic title in the H2 and the Arabic category in the category line", async () => {
    renderSources({ handlers: planListed });
    const heading = await screen.findByRole("heading", { level: 2, name: quran.titleAr });
    expect(heading.querySelector("bdi")).toHaveAttribute("dir", "auto");
    expect(within(cardOf(quran.titleAr)).getByText(quran.category.labelAr).tagName).toBe("BDI");
  });
});

describe("S-25 populated, English", () => {
  it("shows the English copy, the English titles and the English category", async () => {
    renderSources({ language: "en", handlers: planListed });
    expect(await screen.findByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    expect(document.title).toBe("Sources · Qatra");
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByText("The app shows the book as it is in its verified edition for memorization, without additions or explanation.")).toBeInTheDocument();

    await screen.findByRole("heading", { level: 2, name: quran.titleEn });
    const quranCard = cardOf(quran.titleEn);
    expect(quranCard).toHaveTextContent(`Category: ${quran.category.labelEn}`);
    expect(quranCard).toHaveTextContent("Reference: surah and ayah, with a reference link beside the text instead of a page number.");
    const hadithCard = cardOf(hadith.titleEn);
    expect(hadithCard).toHaveTextContent("Reference: hadith number, with a reference link beside the text instead of a page number.");
    expect(hadithCard).toHaveTextContent("The takhrij and the grade are taken as recorded in the HadeethEnc record");
    expect(screen.queryByText(quran.titleAr)).toBeNull();
  });
});

describe("S-25 plan edition unavailable (O-49)", () => {
  it("shows the chip, the sentence and «ابدأ خطتك» on a card for the plan's book when E14 no longer lists it", async () => {
    renderSources({ handlers: planGone });
    const planTitle = mockToday.plan?.titleAr as string;
    const heading = await screen.findByRole("heading", { level: 2, name: planTitle });
    const card = heading.closest("li") as HTMLElement;
    const chip = within(card).getByText("غير متاح");
    expect(chip.className).toContain("bg-warning-tint");
    expect(chip.className).toContain("text-warning-ink");
    expect(chip.className).toContain("text-caption");
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(within(card).getByText(UNAVAILABLE_LINE_AR)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "ابدأ خطتك" })).toHaveAttribute("href", "/start");
    // The other edition is still listed, after it.
    expect(screen.getByRole("heading", { level: 2, name: hadith.titleAr })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("is a chip and a sentence, with no dash joining them", async () => {
    renderSources({ handlers: planGone });
    await screen.findByText("غير متاح");
    expect(document.body.textContent ?? "").not.toMatch(/[\u2013\u2014]/);
    expect(screen.getByText("غير متاح").parentElement?.textContent).toBe("غير متاح");
  });

  it("is in English too, titled by the plan's English title", async () => {
    renderSources({ language: "en", handlers: planGone });
    const heading = await screen.findByRole("heading", { level: 2, name: mockToday.plan?.titleEn as string });
    const card = heading.closest("li") as HTMLElement;
    expect(within(card).getByText("Unavailable")).toBeInTheDocument();
    expect(within(card).getByText("This edition is no longer available. You can start a plan on another edition.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Start your plan" })).toHaveAttribute("href", "/start");
  });

  it("shows no chip and no «ابدأ خطتك» while the plan's book is listed", async () => {
    renderSources({ handlers: planListed });
    await screen.findByRole("heading", { level: 2, name: quran.titleAr });
    expect(screen.queryByText("غير متاح")).toBeNull();
    expect(screen.queryByRole("link", { name: "ابدأ خطتك" })).toBeNull();
  });

  it("shows no chip for an account with no plan, even when E14 lists little", async () => {
    renderSources({ handlers: planGone, scenario: { signedIn: true, hasPlan: false } });
    await screen.findByRole("heading", { level: 2, name: hadith.titleAr });
    expect(screen.queryByText("غير متاح")).toBeNull();
    expect(screen.queryByRole("link", { name: "ابدأ خطتك" })).toBeNull();
  });

  it("leaves the flag out silently when E18 fails, with no banner and the list intact", async () => {
    renderSources({ handlers: { ...planGone, "GET /today": () => errorResponse(503, "unavailable", "Down.") } });
    await screen.findByRole("heading", { level: 2, name: hadith.titleAr });
    expect(screen.queryByText("غير متاح")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/الخدمة غير متاحة/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does the same when E18 cannot be reached", async () => {
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    renderSources({ handlers: { ...planGone, "GET /today": lost } });
    await screen.findByRole("heading", { level: 2, name: hadith.titleAr });
    expect(screen.queryByText("غير متاح")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ends the session when E18 answers 401: S-01 with the banner and this screen as the way back", async () => {
    renderSources({ handlers: { ...planListed, "GET /today": () => errorResponse(401, "unauthenticated", "Out.") } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fsources"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("reads E14 and E18 once each", async () => {
    const view = renderSources({ handlers: planListed });
    await screen.findByRole("heading", { level: 2, name: quran.titleAr });
    expect(view.count("GET /catalog")).toBe(1);
    expect(view.count("GET /today")).toBe(1);
  });
});

describe("S-25 empty", () => {
  it("shows the empty state, keeps the notice, announces it politely, and has no retry button", async () => {
    renderSources({ handlers: serve([]), scenario: { signedIn: true, hasPlan: false } });
    expect(await screen.findByRole("heading", { level: 2, name: "لا توجد مصادر منشورة الآن." })).toBeInTheDocument();
    expect(screen.getByText(NOTICE_AR)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link", { name: "ابدأ خطتك" })).toBeNull();
    const announced = screen.getAllByText("لا توجد مصادر منشورة الآن.").find((element) => element.closest("[role=status]"));
    expect(announced?.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
  });

  it("still flags the plan's book when nothing at all is listed", async () => {
    renderSources({ handlers: serve([]) });
    expect(await screen.findByRole("heading", { level: 2, name: "لا توجد مصادر منشورة الآن." })).toBeInTheDocument();
    expect(screen.getByText("غير متاح")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطتك" })).toBeInTheDocument();
  });

  it("says it in English", async () => {
    renderSources({ language: "en", handlers: serve([]), scenario: { signedIn: true, hasPlan: false } });
    expect(await screen.findByRole("heading", { level: 2, name: "No sources are published right now." })).toBeInTheDocument();
  });
});

describe("S-25 loading and failures", () => {
  it("shows no blocks before 300 ms, then two card skeletons with no numbers, then the cards", async () => {
    renderSources({ latencyMs: 600, handlers: planListed });
    const region = screen.getByTestId("catalog-skeleton");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.querySelector("[aria-hidden='true']")).toBeNull();
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("catalog-skeleton").querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0));
    expect(document.body.textContent ?? "").not.toMatch(/[٠-٩]/);
    expect(screen.getByRole("heading", { level: 1, name: "المصادر" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: quran.titleAr })).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-skeleton")).toBeNull();
  });

  it("a service error shows the warning with «إعادة المحاولة», no stale list, and a retry reads again", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const view = renderSources({
      handlers: { "GET /catalog": (request, scenario) => (answers++ === 0 ? errorResponse(503, "unavailable", "Down.") : (planListed["GET /catalog"] as MockHandler)(request, scenario)) },
    });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "المصادر" })).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).toHaveFocus();
    await user.click(retry);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(await screen.findByRole("heading", { level: 2, name: quran.titleAr })).toBeInTheDocument();
    expect(view.count("GET /catalog")).toBe(2);
    expect(screen.queryByText(/الخدمة غير متاحة/)).toBeNull();
  });

  it("an unexpected error is an alert with «إعادة المحاولة»", async () => {
    renderSources({ handlers: { "GET /catalog": () => errorResponse(500, "internal", "Boom.") } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    expect(within(alert).getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });

  it("offline shows the Info banner of P-05 with «إعادة المحاولة» and no error tone", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    renderSources({ handlers: { "GET /catalog": lost, "GET /today": lost, "GET /health": lost } });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("a throttle keeps the retry inert until the wait is over, then announces it", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const view = renderSources({ handlers: { "GET /catalog": () => errorResponse(429, "throttled", "Slow.", { retryAfterSec: 10 }) } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("محاولات كثيرة. انتظر ١٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await user.click(retry);
    expect(view.count("GET /catalog")).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("يمكنك المحاولة الآن.")).toBeInTheDocument();
  });

  it("while the server wakes it adds no line of its own (the shell speaks), keeps the skeleton and reads again once health answers", async () => {
    let healthy = false;
    let catalogAnswers = 0;
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    const view = renderSources({
      handlers: {
        "GET /catalog": (request, scenario) => {
          if (catalogAnswers++ === 0) return lost();
          return (planListed["GET /catalog"] as MockHandler)(request, scenario);
        },
        "GET /health": (request, scenario) => (healthy ? (mockHandlers["GET /health"] as MockHandler)(request, scenario) : lost()),
        "GET /today": (request, scenario) => (healthy ? (mockHandlers["GET /today"] as MockHandler)(request, scenario) : lost()),
      },
    });
    await waitFor(() => expect(view.count("GET /catalog")).toBe(1));
    await waitFor(() => expect(runtime?.wakeUp.getState().phase).toBe("waking"), { timeout: 4000 });
    expect(screen.getByTestId("catalog-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).toBeNull();

    healthy = true;
    expect(await screen.findByRole("heading", { level: 2, name: quran.titleAr }, { timeout: 6000 })).toBeInTheDocument();
    expect(view.count("GET /catalog")).toBe(2);
  }, 15_000);
});
