import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/demo/simulations", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), browserTimeZone: () => "Asia/Dubai" }));
vi.mock("@/lib/browser", () => browser);

import { DemoSimulationsScreen } from "@/components/demo/DemoSimulationsScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_DEMO_SIMULATIONS, type MockScenario } from "@/lib/api/mock";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";

type Handler = () => Response | Promise<Response>;

const envelope = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "Safe text.", details } });
const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: true, isDemo: true, hasPlan: true }) {
  const mock = createMockFetch({ latencyMs: 0, scenario });
  const calls: { key: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key, init });
    const override = overrides[key];
    return override ? override() : mock(input, init);
  });
  return { fetchImpl, calls, count: (key: string) => calls.filter((call) => call.key === key).length };
}
type Backend = ReturnType<typeof makeBackend>;

const SIMULATIONS = "GET /api/demo/simulations";

let runtime: ApiRuntime;

function renderScreen({ language = "ar", backend = makeBackend() }: { language?: "ar" | "en"; backend?: Backend } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <DemoSimulationsScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

const AR = {
  heading: "محاكاة عدة أيام للقراءة فقط",
  label: "محسوبة سلفًا لا تشغيلًا حيًا",
  body: "تعرض هذه الشاشة نتائج حُسبت سلفًا من سيناريوهات اصطناعية. وهي ليست نتيجة تشغيل حي ولا تقدّمَ متعلم حقيقي.",
  retry: "إعادة المحاولة",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  empty: "لا توجد محاكاة جاهزة الآن.",
} as const;

const first = MOCK_DEMO_SIMULATIONS[0]!;
const cardOf = async (title: string) => (await screen.findByRole("region", { name: title })) as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S-30 guards", () => {
  it("sends a visitor to the login screen with the return path and reads nothing", async () => {
    const backend = makeBackend({}, { signedIn: false });
    renderScreen({ backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fdemo%2Fsimulations"));
    expect(backend.count(SIMULATIONS)).toBe(0);
    expect(peekLoginArrival()).toBeNull();
  });

  it("sends an account that is not a demo account to today and reads nothing", async () => {
    const backend = makeBackend({}, { signedIn: true, isDemo: false });
    renderScreen({ backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count(SIMULATIONS)).toBe(0);
  });

  it("goes to today on a later 403 and to the login screen with the banner on a later 401", async () => {
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: () => jsonResponse(envelope("forbidden"), 403) }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("raises the session-ended banner when the session ends under the screen", async () => {
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: () => jsonResponse(envelope("unauthenticated"), 401) }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fdemo%2Fsimulations"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-30 the populated screen", () => {
  it("shows the heading, the prominent precomputed label with its explanation, and the label again on every card", async () => {
    renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: AR.heading })).toHaveAttribute("data-page-heading");
    expect(document.title).toBe(`${AR.heading} · قطرة غيث`);
    // The label is there before the data: it does not wait for the read.
    expect(screen.getByText(AR.label)).toBeInTheDocument();
    expect(screen.getByText(AR.body)).toBeInTheDocument();
    await cardOf(first.titleAr);
    expect(screen.getAllByText(AR.label)).toHaveLength(1 + MOCK_DEMO_SIMULATIONS.length);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(MOCK_DEMO_SIMULATIONS.length);
  });

  it("discloses the synthetic profile and the scripted learner of a simulation", async () => {
    renderScreen();
    const card = within(await cardOf(first.titleAr));
    expect(card.getByRole("heading", { level: 3, name: "الملف الاصطناعي" })).toBeInTheDocument();
    expect(card.getByText("synthetic-profile-a")).toBeInTheDocument();
    expect(card.getByText("٣٠٠")).toBeInTheDocument();
    expect(card.getByText("سلوك المتعلم المكتوب سلفًا")).toBeInTheDocument();
    expect(card.getByText("٨٠٪")).toBeInTheDocument();
    expect(card.getByText("٥، ٦، ٧")).toBeInTheDocument();
    expect(card.getByText("هذه القيم سيناريو مكتوب سلفًا، وليست قياسًا لمتعلم حقيقي.")).toBeInTheDocument();
  });

  it("lists every day in a table with six labelled columns, and the light-review day without new words", async () => {
    renderScreen();
    const card = within(await cardOf(first.titleAr));
    const table = card.getByRole("table", { name: `أيام المحاكاة: ${first.titleAr}` });
    const headings = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headings).toEqual(["اليوم", "كلمات جديدة", "مراجعات", "التعديل", "كلمات مؤكدة (تراكمي)", "الإنجاز الكلي"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(first.days.length);
    const light = first.days.find((day) => day.lightReviewDay)!;
    const lightRow = rows[light.day - 1]!;
    expect(within(lightRow).getByRole("rowheader")).toHaveTextContent(`اليوم ${new Intl.NumberFormat("ar-u-nu-arab", { useGrouping: false }).format(light.day)}`);
    expect(lightRow).toHaveTextContent("مراجعة خفيفة بعد الغياب");
    expect(lightRow).toHaveTextContent("يوم مراجعة خفيفة بلا مادة جديدة");
    expect(within(lightRow).getAllByRole("cell")[0]).toHaveTextContent("٠");
  });

  it("also offers the days as a list of cards for narrow screens, with the same values", async () => {
    renderScreen();
    const card = within(await cardOf(first.titleAr));
    const list = card.getByRole("list", { name: `أيام المحاكاة: ${first.titleAr}` });
    expect(within(list).getAllByRole("listitem")).toHaveLength(first.days.length);
    expect(list).toHaveTextContent("كلمات جديدة:");
    expect(list).toHaveTextContent("الإنجاز الكلي:");
  });

  it("keeps the table scroll region reachable from the keyboard", async () => {
    renderScreen();
    const card = within(await cardOf(first.titleAr));
    expect(card.getByRole("region", { name: `أيام المحاكاة: ${first.titleAr}` })).toHaveAttribute("tabindex", "0");
  });

  it("links back to today and on to the other scenarios, and runs nothing", async () => {
    const user = userEvent.setup();
    const { backend } = renderScreen();
    await cardOf(first.titleAr);
    expect(screen.getByRole("link", { name: "العودة إلى خطوتك اليوم" })).toHaveAttribute("href", "/today");
    expect(screen.getByRole("link", { name: "اختيار سيناريو آخر" })).toHaveAttribute("href", "/demo/scenario");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(backend.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
    expect(user).toBeDefined();
  });

  it("writes no dash into the new text", async () => {
    const { container } = renderScreen();
    await cardOf(first.titleAr);
    expect(container.textContent).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`));
  });

  it("reads in English with Western digits", async () => {
    renderScreen({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Multi-day read-only simulation" })).toBeInTheDocument();
    expect(screen.getByText("Precomputed, not a live run")).toBeInTheDocument();
    const card = within((await screen.findByRole("region", { name: first.titleEn })) as HTMLElement);
    expect(card.getByText("Synthetic profile")).toBeInTheDocument();
    expect(card.getByText("80%")).toBeInTheDocument();
    expect(card.getByText("5, 6, 7")).toBeInTheDocument();
    expect(card.getByRole("table")).toBeInTheDocument();
    expect(card.getAllByRole("rowheader")[0]).toHaveTextContent("Day 1");
  });
});

describe("S-30 states", () => {
  it("shows the loading text and the label at once, and the skeleton after 300 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const held = new Promise<Response>(() => undefined);
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: () => held }) });
    expect(await screen.findByText("جارٍ تحميل المحاكاة")).toBeInTheDocument();
    expect(screen.getByText(AR.label)).toBeInTheDocument();
    expect(screen.getByTestId("demo-skeleton").querySelector("[aria-hidden=true] div")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(screen.getByTestId("demo-skeleton").querySelector("[aria-hidden=true] div")).not.toBeNull();
  });

  it("shows a calm empty notice when no simulation is ready, still with the label", async () => {
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: () => jsonResponse({ simulations: [] }, 200) }) });
    expect(await screen.findByText(AR.empty)).toBeInTheDocument();
    expect(screen.getByText(AR.label)).toBeInTheDocument();
  });

  it("shows the unavailable banner (E29 answers 503 when the fixtures are missing) and a retry that reads again", async () => {
    let calls = 0;
    const backend = makeBackend({
      [SIMULATIONS]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse(envelope("unavailable"), 503) : jsonResponse({ simulations: MOCK_DEMO_SIMULATIONS }, 200);
      },
    });
    const user = userEvent.setup();
    renderScreen({ backend });
    expect(await screen.findByText(AR.unavailable)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: AR.retry }));
    await cardOf(first.titleAr);
    expect(backend.count(SIMULATIONS)).toBe(2);
  });

  it("shows the internal error as an alert for a 500, never the API message", async () => {
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: () => jsonResponse(envelope("internal"), 500) }) });
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(screen.queryByText("Safe text.")).not.toBeInTheDocument();
  });

  it("reads again by itself once the sleeping server answers its health check, and never asks the visitor to retry", async () => {
    let calls = 0;
    const backend = makeBackend({
      [SIMULATIONS]: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new TypeError("network down")) : Promise.resolve(jsonResponse({ simulations: MOCK_DEMO_SIMULATIONS }, 200));
      },
    });
    renderScreen({ backend });
    await screen.findByRole("region", { name: first.titleAr }, { timeout: 10_000 });
    expect(backend.count(SIMULATIONS)).toBe(2);
  }, 15_000);

  it("offline shows the Info banner of P-05 with a retry, and no error tone", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const lost = () => Promise.reject(new TypeError("The mock connection failed."));
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: lost }) });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: AR.retry })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a malformed row of the answer instead of breaking the screen", async () => {
    const body = { simulations: [{ simulationId: "bad" }, MOCK_DEMO_SIMULATIONS[1]] };
    renderScreen({ backend: makeBackend({ [SIMULATIONS]: () => jsonResponse(body, 200) }) });
    await cardOf(MOCK_DEMO_SIMULATIONS[1]!.titleAr);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });
});
