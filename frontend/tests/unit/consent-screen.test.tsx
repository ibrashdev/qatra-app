import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/consent", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);
// The build's terms version: the gate compares the profile with it, and Continue sends it.
const config = vi.hoisted(() => ({ termsVersion: "2026-10-04" as string | null }));
vi.mock("@/lib/config", () => ({
  API_MODE: "live",
  get TERMS_VERSION() {
    return config.termsVersion;
  },
}));

import { resetConsentStateForTests } from "@/components/consent/consent-state";
import { ConsentScreen } from "@/components/consent/ConsentScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, mockHandlers, mockProfile, type MockScenario } from "@/lib/api/mock";
import { accountMockHandlers, MOCK_OLD_TERMS_VERSION } from "@/lib/api/mock/account-handlers";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { clearRegisterDraft, readRegisterDraft, saveRegisterDraft } from "@/lib/auth/register-draft";
import { setReturnPath, takeReturnPath } from "@/lib/auth/return-path";

const ME = "GET /api/me";
const CONSENT = "POST /api/auth/consent";
const LOGOUT = "POST /api/auth/logout";

const AR = {
  heading: "موافقة جديدة على الشروط",
  lead: "تغيّرت شروط الاستخدام وبيان الخصوصية. اقرأها ثم أكّد موافقتك للمتابعة.",
  line: "إصدار الشروط: 2026-10-04؛ أنت مسجّل باسم sample_user_01",
  link: "شروط الاستخدام وبيان الخصوصية",
  box: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
  boxRequired: "يلزم تأكيد موافقتك على شروط الاستخدام وبيان الخصوصية للمتابعة.",
  outdated: "تحدّثت الشروط. أعد تحميل الصفحة لقراءة الإصدار الأحدث.",
  logoutFailed: "تعذّر تسجيل الخروج. حاول مرة أخرى.",
  waking: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  throttle20: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
};

type Handler = () => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const errorBody = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "x", details } });
const pendingProfile = (): Response => jsonResponse({ ...mockProfile, termsVersion: MOCK_OLD_TERMS_VERSION });

// A signed-in learner whose terms are out of date, unless a test says otherwise. Every call is recorded.
function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: true, hasPlan: true }, pending = true) {
  const mock = createMockFetch({ latencyMs: 0, scenario, handlers: { ...mockHandlers, ...accountMockHandlers } });
  const calls: { key: string; body: unknown }[] = [];
  const handlers: Record<string, Handler> = { ...(pending ? { [ME]: pendingProfile } : {}), ...overrides };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const override = handlers[key];
    return override ? override() : mock(input, init);
  });
  return {
    fetchImpl,
    calls,
    count: (key: string) => calls.filter((call) => call.key === key).length,
    bodies: (key: string) => calls.filter((call) => call.key === key).map((call) => call.body),
  };
}
type Backend = ReturnType<typeof makeBackend>;

let runtime: ApiRuntime;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderConsent({ language = "ar", backend = makeBackend() }: { language?: "ar" | "en"; backend?: Backend } = {}) {
  setLanguage(language);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <ConsentScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

// A line whose runs are set in their own <bdi> elements: the text is read from the paragraph, not from one text node.
const paragraph = (text: string) => screen.getByText((_content, element) => element?.tagName === "P" && element.textContent === text);
const box = () => screen.getByRole("checkbox", { name: AR.box });
const continueButton = () => screen.getByRole("button", { name: /^(متابعة|جارٍ الحفظ…)$/ });
const logoutButton = () => screen.getByRole("button", { name: /^(تسجيل الخروج|جارٍ الخروج…)$/ });
const ready = () => screen.findByRole("checkbox", { name: AR.box });

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const follows = (before: Element, after: Element): boolean => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

function politeRegion(text: string): HTMLElement {
  const region = screen.getByText(text).closest("[role=status]");
  expect(region, `a status region around "${text}"`).not.toBeNull();
  return region as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  resetConsentStateForTests();
  clearLoginArrival();
  clearRegisterDraft();
  takeReturnPath();
  config.termsVersion = "2026-10-04";
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  window.history.pushState({}, "", "/consent");
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetConsentStateForTests();
  takeReturnPath();
});

describe("S-06 structure (UI-screens S-06 sections 2, 3 and 5)", () => {
  it("shows the heading, the lead, the version and account lines, the terms link, the box, the two document links, Continue and Log out, in the order of the spec", async () => {
    renderConsent();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: AR.heading })).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("موافقة جديدة على الشروط · قطرة غيث");
    expect(screen.getByText(AR.lead)).toBeInTheDocument();
    expect(paragraph(AR.line)).toBeInTheDocument();

    const termsLink = screen.getByRole("link", { name: AR.link });
    expect(termsLink).toHaveAttribute("href", "/terms");
    const termsOfUse = screen.getByRole("link", { name: "شروط الاستخدام" });
    const privacy = screen.getByRole("link", { name: "بيان الخصوصية" });
    expect(termsOfUse).toHaveAttribute("href", "/terms#terms");
    expect(privacy).toHaveAttribute("href", "/terms#privacy");

    const order = [screen.getByRole("heading", { level: 1 }), screen.getByText(AR.lead), paragraph(AR.line), termsLink, box(), termsOfUse, privacy, continueButton(), logoutButton()];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
  });

  it("writes the version and the username in isolated left-to-right runs", async () => {
    renderConsent();
    await ready();
    const line = paragraph(AR.line);
    const runs = [...line.querySelectorAll("bdi")];
    expect(runs.map((run) => run.textContent)).toEqual(["2026-10-04", "sample_user_01"]);
    expect(runs[0]).toHaveAttribute("dir", "ltr");
  });

  it("the box is unchecked when first shown and its name is exactly the fixed sentence, with the two links outside it", async () => {
    renderConsent();
    await ready();
    expect(box()).not.toBeChecked();
    expect(box()).toHaveAttribute("aria-required", "true");
    expect(box().closest("label")).not.toContainElement(screen.getByRole("link", { name: "شروط الاستخدام" }));
  });

  it("is a focus screen: the brand only in the header, no language switch, no back control, no tab bar", async () => {
    renderConsent();
    await ready();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "اللغة" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^رجوع إلى/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^رجوع إلى/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    const header = document.querySelector("header") as HTMLElement;
    expect(within(header).getByText("قطرة غيث")).toBeInTheDocument();
    expect(within(header).queryByRole("link")).not.toBeInTheDocument();
  });

  it("tabs through the skip link, the terms link, the box, the two document links, Continue and Log out, and Space toggles the box", async () => {
    const user = userEvent.setup();
    renderConsent();
    await ready();
    const stops = [screen.getByRole("link", { name: AR.link }), box(), screen.getByRole("link", { name: "شروط الاستخدام" }), screen.getByRole("link", { name: "بيان الخصوصية" }), continueButton(), logoutButton()];
    await user.tab();
    expect(screen.getByRole("link", { name: "انتقل إلى المحتوى" })).toHaveFocus();
    for (const stop of stops) {
      await user.tab();
      expect(stop).toHaveFocus();
    }
    box().focus();
    await user.keyboard(" ");
    expect(box()).toBeChecked();
  });

  it("shows a loading state with no form while E11 is in flight", async () => {
    const gate = deferred<Response>();
    renderConsent({ backend: makeBackend({ [ME]: () => gate.promise }) });
    expect(screen.getByRole("heading", { level: 1, name: AR.heading })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    gate.resolve(pendingProfile());
    await ready();
    expect(screen.queryByText("جارٍ التحميل")).not.toBeInTheDocument();
  });
});

describe("S-06 entry rules (guards)", () => {
  it("without a session: back to the login with the gate as the way on, and the gate never draws", async () => {
    const backend = makeBackend({}, { signedIn: false }, false);
    renderConsent({ backend });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fconsent"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // A visitor who never had a session is not told that one ended.
    expect(peekLoginArrival()).toBeNull();
  });

  it("without a pending change: to /today, the gate never draws", async () => {
    renderConsent({ backend: makeBackend({}, { signedIn: true, hasPlan: true }, false) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("a build with no terms version cannot compare, so it shows the gate and states no version", async () => {
    config.termsVersion = null;
    renderConsent({ backend: makeBackend({}, { signedIn: true, hasPlan: true }, false) });
    await ready();
    expect(paragraph("أنت مسجّل باسم sample_user_01")).toBeInTheDocument();
    expect(screen.queryByText(/إصدار الشروط/)).not.toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });
});

describe("S-06 validation (G-18)", () => {
  it("Continue with the box unchecked: nothing is sent, the error is at the box, linked by description, focus goes to the box, no alert, no summary", async () => {
    const user = userEvent.setup();
    const { backend } = renderConsent();
    await ready();
    await user.click(continueButton());

    expect(backend.count(CONSENT)).toBe(0);
    expect(box()).toHaveFocus();
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect(box()).toHaveAccessibleDescription(AR.boxRequired);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(box());
    expect(screen.queryByText(AR.boxRequired)).not.toBeInTheDocument();
  });
});

describe("S-06 consent (E05)", () => {
  it("sends only the terms version, and returns to the path the login kept", async () => {
    setReturnPath("/session/synthetic-one");
    const user = userEvent.setup();
    const { backend } = renderConsent();
    await ready();
    await user.click(box());
    await user.click(continueButton());

    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/session/synthetic-one"));
    expect(backend.bodies(CONSENT)).toEqual([{ termsVersion: "2026-10-04" }]);
    expect(takeReturnPath()).toBeNull();
  });

  it("with no kept path goes home: /today with a plan", async () => {
    const user = userEvent.setup();
    renderConsent();
    await ready();
    await user.click(box());
    await user.click(continueButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("with no kept path and no plan goes to /start", async () => {
    const user = userEvent.setup();
    renderConsent({ backend: makeBackend({}, { signedIn: true, hasPlan: false }) });
    await ready();
    await user.click(box());
    await user.click(continueButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
  });

  it("never returns to the gate itself", async () => {
    setReturnPath("/consent");
    const user = userEvent.setup();
    renderConsent();
    await ready();
    await user.click(box());
    await user.click(continueButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("holds the button busy, makes Log out inert, announces «جارٍ الحفظ» and sends nothing twice while the answer is awaited", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const backend = makeBackend({ [CONSENT]: () => gate.promise });
    renderConsent({ backend });
    await ready();
    await user.click(box());
    await user.click(continueButton());

    expect(continueButton()).toHaveAttribute("aria-busy", "true");
    expect(logoutButton()).toHaveAttribute("aria-disabled", "true");
    expect(politeRegion("جارٍ الحفظ")).toHaveClass("sr-only");
    await user.click(continueButton());
    await user.click(logoutButton());
    expect(backend.count(CONSENT)).toBe(1);
    expect(backend.count(LOGOUT)).toBe(0);

    gate.resolve(jsonResponse({ profile: { ...mockProfile } }));
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("keeps what the learner set when the page is opened again after S-03 (the box is kept in memory, not in storage)", async () => {
    const user = userEvent.setup();
    const first = renderConsent();
    await ready();
    await user.click(box());
    first.unmount();
    runtime.wakeUp.dispose();

    renderConsent();
    await ready();
    expect(box()).toBeChecked();
    expect(JSON.stringify({ ...localStorage })).not.toContain("agree");
  });
});

describe("S-06 E05 errors (G-18, G-03, P-04 to P-07)", () => {
  async function pressContinue(backend: Backend) {
    const user = userEvent.setup({ delay: null });
    renderConsent({ backend });
    await ready();
    await user.click(box());
    await user.click(continueButton());
    return user;
  }

  it("terms_required: the reload alert, focus on its button, and no version this build has not shown is ever sent", async () => {
    const backend = makeBackend({ [CONSENT]: () => jsonResponse(errorBody("terms_required", { requiredVersion: "2099-01-01" }), 400) });
    await pressContinue(backend);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.outdated);
    expect(within(alert).getByRole("button", { name: "إعادة تحميل الصفحة" })).toHaveFocus();
    expect(follows(box(), alert)).toBe(true);
    expect(follows(alert, continueButton())).toBe(true);
    expect(box()).toBeChecked();
    expect(navigation.router.replace).not.toHaveBeenCalled();

    await userEvent.click(within(alert).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("unauthenticated: the session-ended banner for S-01, and the gate is the way on after the login", async () => {
    const backend = makeBackend({ [CONSENT]: () => jsonResponse(errorBody("unauthenticated"), 401) });
    await pressContinue(backend);
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fconsent"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("500 and forbidden_origin: generic alerts, the box kept, focus on Continue", async () => {
    await pressContinue(makeBackend({ [CONSENT]: () => jsonResponse(errorBody("internal"), 500) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(box()).toBeChecked();
    expect(continueButton()).toHaveFocus();
  });

  it("403: an alert with a reload button", async () => {
    await pressContinue(makeBackend({ [CONSENT]: () => jsonResponse(errorBody("forbidden_origin"), 403) }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.origin);
    expect(within(alert).getByRole("button", { name: "إعادة تحميل الصفحة" })).toBeInTheDocument();
  });

  it("503: a polite warning; a validation_error is an internal error", async () => {
    await pressContinue(makeBackend({ [CONSENT]: () => jsonResponse(errorBody("unavailable"), 503) }));
    await screen.findByText(AR.unavailable);
    expect(politeRegion(AR.unavailable)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("422: treated as internal, the learner cannot fix it", async () => {
    await pressContinue(makeBackend({ [CONSENT]: () => jsonResponse(errorBody("validation_error", { fields: [{ field: "termsVersion", rule: "invalid_type" }] }), 422) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
  });

  it("429: the throttle banner, an aria-disabled button, the countdown, and a retry at zero", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const backend = makeBackend({ [CONSENT]: () => jsonResponse(errorBody("throttled", { retryAfterSec: 20 }), 429) });
    const { container } = renderConsent({ backend });
    await flush();
    await ready();
    await user.click(box());
    await user.click(continueButton());
    await flush();

    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
    expect(continueButton()).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelector("p[aria-hidden=true] bdi")).toHaveTextContent("٠٠:٢٠");
    await user.click(continueButton());
    await flush();
    expect(backend.count(CONSENT)).toBe(1);
    await advance(20_000);
    expect(continueButton()).not.toHaveAttribute("aria-disabled");
    expect(politeRegion("يمكنك المحاولة الآن.")).toHaveClass("sr-only");
  });

  it("no answer: the wake-up line above the button, the box kept, nothing resent", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const backend = makeBackend({
      [CONSENT]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderConsent({ backend });
    await flush();
    await ready();
    await user.click(box());
    await user.click(continueButton());
    await flush();

    expect(politeRegion(AR.waking)).toHaveAttribute("aria-live", "polite");
    expect(follows(screen.getByText(AR.waking), continueButton())).toBe(true);
    expect(box()).toBeChecked();
    await advance(30_000);
    expect(backend.count(CONSENT)).toBe(1);
  });

  it("a build with no terms version sends nothing and says it cannot complete the request", async () => {
    config.termsVersion = null;
    const user = userEvent.setup();
    const backend = makeBackend({}, { signedIn: true, hasPlan: true }, false);
    renderConsent({ backend });
    await ready();
    await user.click(box());
    await user.click(continueButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(backend.count(CONSENT)).toBe(0);
  });
});

describe("S-06 logout (E10)", () => {
  it("204: to the login, no dialog, and nothing kept for the learner outlives the session", async () => {
    const user = userEvent.setup();
    saveRegisterDraft({ username: "synthetic_name_01", password: "synthetic draft password", confirmation: "", consent: false });
    const { backend } = renderConsent();
    await ready();
    await user.click(box());
    await user.click(logoutButton());

    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(backend.count(LOGOUT)).toBe(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readRegisterDraft()).toBeNull();
  });

  it("a 401 means the session is already gone: to the login all the same", async () => {
    const user = userEvent.setup();
    renderConsent({ backend: makeBackend({ [LOGOUT]: () => jsonResponse(errorBody("unauthenticated"), 401) }) });
    await ready();
    await user.click(logoutButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
  });

  it("shows the busy state, makes Continue inert and announces «جارٍ الخروج» while the answer is awaited", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const backend = makeBackend({ [LOGOUT]: () => gate.promise });
    renderConsent({ backend });
    await ready();
    await user.click(logoutButton());

    expect(logoutButton()).toHaveAttribute("aria-busy", "true");
    expect(continueButton()).toHaveAttribute("aria-disabled", "true");
    expect(politeRegion("جارٍ الخروج")).toHaveClass("sr-only");
    await user.click(logoutButton());
    expect(backend.count(LOGOUT)).toBe(1);

    gate.resolve(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
  });

  it.each([
    ["503", () => jsonResponse(errorBody("unavailable"), 503)],
    ["403", () => jsonResponse(errorBody("forbidden_origin"), 403)],
    [
      "no answer",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("%s: an error alert in Slot B, the learner stays, and the button is the retry", async (_name, answer) => {
    const user = userEvent.setup();
    let calls = 0;
    const backend = makeBackend({
      [LOGOUT]: () => {
        calls += 1;
        return calls === 1 ? answer() : new Response(null, { status: 204 });
      },
    });
    renderConsent({ backend });
    await ready();
    await user.click(logoutButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.logoutFailed);
    expect(follows(box(), alert)).toBe(true);
    expect(follows(alert, continueButton())).toBe(true);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(logoutButton()).not.toHaveAttribute("aria-busy");
    expect(continueButton()).not.toHaveAttribute("aria-disabled");

    await user.click(logoutButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
  });
});

describe("S-06 when E11 gives no profile", () => {
  it("503: a polite warning and a retry button, no form; the retry reads again and then draws the gate", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const backend = makeBackend({ [ME]: () => (++calls === 1 ? jsonResponse(errorBody("unavailable"), 503) : pendingProfile()) });
    renderConsent({ backend });
    await screen.findByText(AR.unavailable);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    await ready();
    expect(backend.count(ME)).toBe(2);
  });

  it("500: a generic alert and a retry button", async () => {
    renderConsent({ backend: makeBackend({ [ME]: () => jsonResponse(errorBody("internal"), 500) }) });
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });

  it("no answer: the wake-up line, and the read repeats by itself once the server answers", async () => {
    vi.useFakeTimers();
    let awake = false;
    let reads = 0;
    const backend = makeBackend({
      "GET /api/health": () => (awake ? jsonResponse({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }) : new Response("<html>asleep</html>", { status: 502 })),
      [ME]: () => {
        reads += 1;
        if (!awake) throw new TypeError("Failed to fetch");
        return pendingProfile();
      },
    });
    renderConsent({ backend });
    await flush();
    expect(screen.getByText(AR.waking)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    awake = true;
    await advance(1_500);
    await flush();
    expect(screen.getByRole("checkbox", { name: AR.box })).toBeInTheDocument();
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("offline: the connectivity line and a retry", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderConsent({
      backend: makeBackend({
        [ME]: () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });
});

describe("S-06 in English", () => {
  it("is worded in English, left to right, and keeps the same order", async () => {
    const user = userEvent.setup();
    const { backend } = renderConsent({ language: "en" });
    const english = await screen.findByRole("checkbox", { name: "I have read the terms of use and privacy statement and I agree to them." });
    expect(document.documentElement.dir).toBe("ltr");
    expect(screen.getByRole("heading", { level: 1, name: "Agree to the updated terms" })).toBeInTheDocument();
    expect(screen.getByText("The terms of use and privacy statement have changed. Read them, then confirm your agreement to continue.")).toBeInTheDocument();
    expect(paragraph("Terms version: 2026-10-04; You are signed in as sample_user_01")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms of use and privacy statement" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Terms of use" })).toHaveAttribute("href", "/terms#terms");
    expect(screen.getByRole("link", { name: "Privacy statement" })).toHaveAttribute("href", "/terms#privacy");
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("You must confirm your agreement to the terms of use and privacy statement to continue.")).toBeInTheDocument();
    expect(english).toHaveFocus();
    expect(backend.count(CONSENT)).toBe(0);
  });
});
