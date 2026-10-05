import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/demo/scenario", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), browserTimeZone: () => "Asia/Dubai" }));
vi.mock("@/lib/browser", () => browser);

import { DemoScenarioScreen } from "@/components/demo/DemoScenarioScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_DEMO_SCENARIOS, mockToday, type MockScenario } from "@/lib/api/mock";
import { clearCodeUnavailable, clearLoginArrival, peekLoginArrival, raiseCodeUnavailable } from "@/lib/auth/flash";

type Handler = () => Response | Promise<Response>;

const envelope = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "Safe text.", details } });
const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// The mock layer answers by default; a test overrides single operations. Every call is recorded.
function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: true, isDemo: true, hasPlan: false }) {
  const mock = createMockFetch({ latencyMs: 0, scenario });
  const calls: { key: string; body: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    const override = overrides[key];
    return override ? override() : mock(input, init);
  });
  return { fetchImpl, calls, count: (key: string) => calls.filter((call) => call.key === key).length };
}
type Backend = ReturnType<typeof makeBackend>;

const SCENARIOS = "GET /api/demo/scenarios";
const PLANS = "POST /api/demo/plans";

let runtime: ApiRuntime;

function renderScreen({ language = "ar", backend = makeBackend() }: { language?: "ar" | "en"; backend?: Backend } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <DemoScenarioScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

const AR = {
  heading: "قائمة سيناريوهات أهداف اصطناعية",
  group: "السيناريوهات",
  build: "ابنِ الخطة",
  building: "جارٍ بناء الخطة…",
  choose: "اختر سيناريو لتفعيل الزر.",
  ready: "تُحفظ الخطة في حساب العرض، وتحل محل الخطة الحالية إن وُجدت.",
  builtTitle: "تم بناء خطتك",
  byRules: "بُنيت هذه الخطة بمحرك القواعد داخل التطبيق.",
  byPlanner: "بُنيت هذه الخطة بواسطة «المخطط المقيد».",
  cont: "المتابعة إلى خطتك",
  simulations: "محاكاة عدة أيام للقراءة فقط",
  emptyText: "لا توجد سيناريوهات جاهزة الآن. يمكنك بدء خطة بنفسك.",
  start: "ابدأ خطتك",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  retry: "إعادة المحاولة",
  race: "بدأت خطة أخرى للتو. حدّث الصفحة ثم أعد المحاولة.",
  reload: "إعادة تحميل الصفحة",
  unknown: "لم يعد هذا السيناريو متاحًا. حدّثنا القائمة، فاختر سيناريو آخر.",
  uncertain: "لم نتلقَّ تأكيدًا ببناء الخطة. افتح خطوتك اليوم لترى إن كانت قد بُنيت، وإلا فأعد المحاولة.",
  openToday: "افتح خطوتك اليوم",
  daily: "لكل حساب عرض عدد محدود من بناء الخطط في اليوم.",
  privacy: "لا يُرسل أي نص حر إلى النموذج.",
} as const;

const group = () => screen.getByRole("radiogroup", { name: AR.group });
const buildButton = () => screen.getByRole("button", { name: new RegExp(`^(${AR.build}|${AR.building})$`) });
const radios = () => within(group()).getAllByRole("radio");
async function ready() {
  await screen.findByRole("radiogroup", { name: AR.group });
}
async function choose(user: ReturnType<typeof userEvent.setup>, index = 0) {
  await user.click(radios()[index] as HTMLElement);
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearCodeUnavailable();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S-29 guards", () => {
  it("sends a visitor to the login screen with the return path, asks nothing of the demo endpoints, and raises no session-ended banner", async () => {
    const backend = makeBackend({}, { signedIn: false });
    renderScreen({ backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fdemo%2Fscenario"));
    expect(backend.count(SCENARIOS)).toBe(0);
    expect(backend.count(PLANS)).toBe(0);
    expect(peekLoginArrival()).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: AR.group })).not.toBeInTheDocument();
  });

  it("sends an account that is not a demo account to today, and never reads the scenarios", async () => {
    const backend = makeBackend({}, { signedIn: true, isDemo: false });
    renderScreen({ backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count(SCENARIOS)).toBe(0);
    expect(screen.queryByRole("radiogroup", { name: AR.group })).not.toBeInTheDocument();
  });

  it("falls back to today when a later read answers 403, and to the login screen with the banner when it answers 401", async () => {
    renderScreen({ backend: makeBackend({ [SCENARIOS]: () => jsonResponse(envelope("forbidden"), 403) }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("raises the session-ended banner when the session ends under an open screen", async () => {
    renderScreen({ backend: makeBackend({ [SCENARIOS]: () => jsonResponse(envelope("unauthenticated"), 401) }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fdemo%2Fscenario"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-29 the list and the build press", () => {
  it("shows the heading, the explanation, the privacy note, one radio per scenario and a button that waits for a choice", async () => {
    renderScreen();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: AR.heading })).toBeInTheDocument();
    expect(document.title).toBe(`${AR.heading} · قطرة غيث`);
    expect(screen.getByText(/لا يُرسل أي نص حر إلى النموذج/)).toBeInTheDocument();
    expect(radios()).toHaveLength(MOCK_DEMO_SCENARIOS.length);
    expect(radios().every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(buildButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(AR.choose)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.simulations })).toHaveAttribute("href", "/demo/simulations");
  });

  it("shows the sections of each scenario and not its edition key or any goal text", async () => {
    const { container } = renderScreen();
    await ready();
    expect(within(group()).getAllByText(/عدد الأقسام: [١٢]/).length).toBe(MOCK_DEMO_SCENARIOS.length - 0);
    expect(container.textContent).not.toContain("placeholder-quran-edition");
  });

  it("enables the button on a choice, sends only the scenario id, and shows the rules label with a continue button", async () => {
    const user = userEvent.setup();
    const { backend } = renderScreen();
    await ready();
    await choose(user, 0);
    expect(radios()[0]).toBeChecked();
    expect(buildButton()).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByText(AR.ready)).toBeInTheDocument();
    await user.click(buildButton());

    const built = await screen.findByRole("heading", { level: 2, name: AR.builtTitle });
    expect(built).toHaveFocus();
    expect(screen.getByText(AR.byRules)).toBeInTheDocument();
    expect(screen.queryByText(AR.byPlanner)).not.toBeInTheDocument();
    expect(backend.count(PLANS)).toBe(1);
    expect(backend.calls.find((call) => call.key === PLANS)?.body).toEqual({ scenarioId: "scenario-01" });
    expect(screen.queryByRole("radiogroup", { name: AR.group })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.simulations })).toHaveAttribute("href", "/demo/simulations");

    await user.click(screen.getByRole("button", { name: AR.cont }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/today");
  });

  it("says «المخطط المقيد» when the constrained planner built the plan", async () => {
    const user = userEvent.setup();
    renderScreen();
    await ready();
    await choose(user, 1);
    await user.click(buildButton());
    await screen.findByRole("heading", { level: 2, name: AR.builtTitle });
    expect(screen.getByText(AR.byPlanner)).toBeInTheDocument();
    expect(screen.queryByText(AR.byRules)).not.toBeInTheDocument();
  });

  it("does nothing when the button is pressed with no choice", async () => {
    const user = userEvent.setup();
    const { backend } = renderScreen();
    await ready();
    await user.click(buildButton());
    expect(backend.count(PLANS)).toBe(0);
  });

  it("shows the waiting state, ignores a second press and a change of choice, and sends one request", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = makeBackend({
      [PLANS]: async () => {
        await held;
        return jsonResponse(mockToday.plan, 201);
      },
    });
    const user = userEvent.setup();
    renderScreen({ backend });
    await ready();
    await choose(user, 0);
    await user.click(buildButton());
    expect(buildButton()).toHaveAttribute("aria-busy", "true");
    expect(buildButton()).toHaveTextContent(AR.building);
    expect(screen.getAllByText("جارٍ بناء الخطة").length).toBeGreaterThan(0);
    await user.click(buildButton());
    await choose(user, 2);
    expect(radios()[0]).toBeChecked();
    expect(backend.count(PLANS)).toBe(1);
    release();
    await screen.findByRole("heading", { level: 2, name: AR.builtTitle });
    expect(backend.count(PLANS)).toBe(1);
  });

  it("says it is still working after five seconds of waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
    const backend = makeBackend({ [PLANS]: () => new Promise<Response>(() => undefined) });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderScreen({ backend });
    await ready();
    await choose(user, 0);
    await user.click(buildButton());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(screen.getByText("ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe("S-29 states of the list", () => {
  it("shows a calm empty notice with a link to S-08 when no scenario can be resolved", async () => {
    renderScreen({ backend: makeBackend({ [SCENARIOS]: () => jsonResponse({ scenarios: [] }, 200) }) });
    expect(await screen.findByText(AR.emptyText)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.start })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("button", { name: AR.build })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.simulations })).toBeInTheDocument();
  });

  it("shows the loading text at once and the skeleton only after 300 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const gate: { release: () => void } = { release: () => undefined };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const backend = makeBackend();
    const original = backend.fetchImpl.getMockImplementation();
    backend.fetchImpl.mockImplementation(async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test").pathname;
      if (path === "/api/demo/scenarios") await held;
      return original!(input, init);
    });
    renderScreen({ backend });
    expect(await screen.findByText("جارٍ تحميل السيناريوهات")).toBeInTheDocument();
    const region = screen.getByTestId("demo-skeleton");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.querySelector("[aria-hidden=true] div")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(screen.getByTestId("demo-skeleton").querySelector("[aria-hidden=true] div")).not.toBeNull();
    gate.release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await ready();
  });

  it("shows the unavailable banner with a retry that reads the list again (E27 answers 503 when the fixtures are missing)", async () => {
    let calls = 0;
    const backend = makeBackend({
      [SCENARIOS]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse(envelope("unavailable"), 503) : jsonResponse({ scenarios: MOCK_DEMO_SCENARIOS }, 200);
      },
    });
    const user = userEvent.setup();
    renderScreen({ backend });
    expect(await screen.findByText(AR.unavailable)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: AR.group })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: AR.retry }));
    await ready();
    expect(backend.count(SCENARIOS)).toBe(2);
  });

  it("shows the internal error banner for a 500 on the list, as an alert", async () => {
    renderScreen({ backend: makeBackend({ [SCENARIOS]: () => jsonResponse(envelope("internal"), 500) }) });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.internal);
    expect(screen.queryByText("Safe text.")).not.toBeInTheDocument();
  });

  it("shows the note of S-04 once when the recovery code was left unconfirmed", async () => {
    raiseCodeUnavailable();
    renderScreen();
    await ready();
    expect(screen.getByText("لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.")).toBeInTheDocument();
  });
});

describe("S-29 how E28 can fail", () => {
  async function press(backend: Backend, index = 0) {
    const user = userEvent.setup();
    renderScreen({ backend });
    await ready();
    await choose(user, index);
    await user.click(buildButton());
    await settle();
    return user;
  }

  it("429: shows the throttle wording and the daily-limit line, keeps the button inert with a countdown, and never retries", async () => {
    const backend = makeBackend({ [PLANS]: () => jsonResponse(envelope("throttled", { retryAfterSec: 3600 }), 429) });
    const user = await press(backend);
    expect(document.body.textContent).toContain("محاولات كثيرة. يمكنك المحاولة بعد ٦٠:٠٠.");
    expect(screen.getByText(AR.daily)).toBeInTheDocument();
    expect(buildButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(buildButton());
    expect(backend.count(PLANS)).toBe(1);
  });

  it("409 active_plan_conflict: says another plan started, offers a page reload, and keeps the list", async () => {
    const backend = makeBackend({ [PLANS]: () => jsonResponse(envelope("version_conflict", { reason: "active_plan_conflict" }), 409) });
    const user = await press(backend);
    expect(screen.getByText(AR.race)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: AR.reload }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
    expect(backend.count(PLANS)).toBe(1);
    expect(screen.getByRole("radiogroup", { name: AR.group })).toBeInTheDocument();
  });

  it("422 unknown_scenario: says the scenario is gone, drops the choice and reads the list again", async () => {
    const backend = makeBackend({ [PLANS]: () => jsonResponse(envelope("validation_error", { fields: [{ field: "scenarioId", rule: "unknown_scenario" }] }), 422) });
    await press(backend);
    expect(screen.getByText(AR.unknown)).toBeInTheDocument();
    await ready();
    expect(backend.count(SCENARIOS)).toBe(2);
    expect(radios().every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(backend.count(PLANS)).toBe(1);
  });

  it("401: goes to the login screen with the session-ended banner and the return path", async () => {
    await press(makeBackend({ [PLANS]: () => jsonResponse(envelope("unauthenticated"), 401) }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fdemo%2Fscenario");
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("403: goes to today", async () => {
    await press(makeBackend({ [PLANS]: () => jsonResponse(envelope("forbidden"), 403) }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/today");
  });

  it("503: shows the unavailable banner and sends nothing again by itself", async () => {
    const backend = makeBackend({ [PLANS]: () => jsonResponse(envelope("unavailable"), 503) });
    await press(backend);
    expect(screen.getByText(AR.unavailable)).toBeInTheDocument();
    await settle();
    expect(backend.count(PLANS)).toBe(1);
    expect(buildButton()).toHaveAttribute("aria-disabled", "false");
  });

  it("500: shows the internal error as an alert, and a further press is the retry", async () => {
    let calls = 0;
    const backend = makeBackend({
      [PLANS]: () => {
        calls += 1;
        return jsonResponse(envelope("internal"), 500);
      },
    });
    const user = await press(backend);
    expect(screen.getByRole("alert")).toHaveTextContent(AR.internal);
    expect(screen.queryByRole("button", { name: AR.retry })).not.toBeInTheDocument();
    await user.click(buildButton());
    await settle();
    expect(calls).toBe(2);
  });

  it("403 forbidden_origin: asks for a reload", async () => {
    const backend = makeBackend({ [PLANS]: () => jsonResponse(envelope("forbidden_origin"), 403) });
    const user = await press(backend);
    expect(screen.getByRole("alert")).toHaveTextContent("تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.");
    await user.click(screen.getByRole("button", { name: AR.reload }));
    expect(browser.reloadPage).toHaveBeenCalled();
  });

  it("no answer at all: says the plan may exist, links to today, and sends nothing again by itself", async () => {
    const backend = makeBackend({ [PLANS]: () => Promise.reject(new TypeError("network down")) });
    await press(backend);
    expect(screen.getByText(AR.uncertain)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.openToday })).toHaveAttribute("href", "/today");
    await settle();
    expect(backend.count(PLANS)).toBe(1);
  });
});

describe("S-29 in English", () => {
  it("reads in English left to right and builds a plan", async () => {
    const user = userEvent.setup();
    renderScreen({ language: "en" });
    const list = await screen.findByRole("radiogroup", { name: "Scenarios" });
    expect(screen.getByRole("heading", { level: 1, name: "Synthetic goal scenarios" })).toBeInTheDocument();
    expect(screen.getByText(/No free text is sent to the model/)).toBeInTheDocument();
    expect(screen.getByText("Choose a scenario to turn the button on.")).toBeInTheDocument();
    await user.click(within(list).getAllByRole("radio")[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Build the plan" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Your plan is built" })).toBeInTheDocument();
    expect(screen.getByText("This plan was built by the rules engine inside the app.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to your plan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Multi-day read-only simulation" })).toHaveAttribute("href", "/demo/simulations");
  });
});
