import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/login", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { LoginForm } from "@/components/auth/LoginForm";
import { PublicShell } from "@/components/ui/PublicShell";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_PASSWORD, mockProfile, type MockScenario } from "@/lib/api/mock";
import { clearLoginArrival, raiseLoginArrival } from "@/lib/auth/flash";
import { takeReturnPath } from "@/lib/auth/return-path";

const WAKING = { ar: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.", en: "Starting the free server, this may take about a minute." };
const READY_AR = "الخادم جاهز. يمكنك المحاولة الآن.";
const OFFLINE_AR = "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.";

type Handler = () => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The mock layer answers by default; a test overrides single operations. Every call is recorded.
function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: false }) {
  const mock = createMockFetch({ latencyMs: 0, scenario });
  const calls: { key: string; body: unknown; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, init });
    const override = overrides[key];
    return override ? override() : mock(input, init);
  });
  return { fetchImpl, calls, count: (key: string) => calls.filter((call) => call.key === key).length };
}
type Backend = ReturnType<typeof makeBackend>;

let runtime: ApiRuntime;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderLogin({ language = "ar", backend = makeBackend(), shell = false }: { language?: "ar" | "en"; backend?: Backend; shell?: boolean } = {}) {
  setLanguage(language);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        {shell ? (
          <PublicShell logo={false} wakeUp={false}>
            <LoginForm />
          </PublicShell>
        ) : (
          <LoginForm />
        )}
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

const usernameInput = () => screen.getByLabelText("اسم المستخدم") as HTMLInputElement;
const passwordInput = () => screen.getByLabelText("كلمة المرور") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /^(دخول|جارٍ الدخول…)$/ });

async function fill(user: UserEvent, username: string, password: string) {
  if (username) await user.type(usernameInput(), username);
  if (password) await user.type(passwordInput(), password);
}

// Lets the promises of a request settle without moving the fake clock.
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

// True when `after` comes later in the page than `before`: the DOM order that the spec's layout and focus order rest on.
const follows = (before: Element, after: Element): boolean => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

function politeRegion(text: string): HTMLElement {
  const region = screen.getByText(text).closest("[role=status]");
  expect(region, `a status region around "${text}"`).not.toBeNull();
  return region as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  takeReturnPath();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  window.history.pushState({}, "", "/login");
  // Testing Library waits on a setTimeout after every user-event call and moves a fake clock only when it finds a Jest-style global.
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("S-01 structure (UI-screens S-01 sections 2, 3 and 5)", () => {
  it("shows the lockup, the heading, two labelled fields, the button and the two links, in the order of the spec", () => {
    renderLogin();
    expect(screen.getByRole("heading", { level: 1, name: "الدخول" })).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("الدخول · قطرة غيث");
    expect(screen.getByText("قطرة غيث")).toBeInTheDocument();

    const heading = screen.getByRole("heading", { level: 1 });
    const order = [heading, usernameInput(), passwordInput(), screen.getByRole("button", { name: "إظهار كلمة المرور" }), submitButton(), screen.getByRole("link", { name: "نسيت كلمة المرور" }), screen.getByRole("link", { name: "إنشاء حساب" })];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
    expect(screen.getByRole("link", { name: "نسيت كلمة المرور" })).toHaveAttribute("href", "/recovery");
    expect(screen.getByRole("link", { name: "إنشاء حساب" })).toHaveAttribute("href", "/register");
    expect(screen.getByText("ليس لديك حساب؟")).toBeInTheDocument();
  });

  it("shows the droplet at the 32 px size in the primary colour beside the name in the deep blue, hidden from assistive technology", () => {
    renderLogin();
    const lockup = screen.getByText("قطرة غيث");
    expect(lockup).toHaveClass("text-section", "text-primary-deep");
    const glyph = lockup.querySelector("svg");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveClass("size-icon-xl", "text-primary");
  });

  it("gives the username field the attributes of the spec", () => {
    renderLogin();
    const input = usernameInput();
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("dir", "auto");
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "next");
    expect(input).not.toHaveAttribute("placeholder");
  });

  it("gives the password field the attributes of the spec: no length cap, no autocomplete=off, paste and managers allowed", () => {
    renderLogin();
    const input = passwordInput();
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("dir", "auto");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toHaveAttribute("enterkeyhint", "go");
    expect(input).not.toHaveAttribute("maxlength");
    expect(input).not.toHaveAttribute("placeholder");
  });

  it("is a form that validates by script and never puts the credentials in the address if it is sent before the page is ready", () => {
    const { container } = renderLogin();
    const form = container.querySelector("form");
    expect(form).toHaveAttribute("novalidate");
    expect(form).toHaveAttribute("method", "post");
    expect(container.querySelector("[required], [aria-required]")).toBeNull();
  });

  it("has no back control, no demo link, no remember-me box and no other field", () => {
    renderLogin();
    expect(screen.queryByRole("link", { name: /رجوع|Back/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/عرض|demo/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("renders in English with the proposed counterparts", () => {
    renderLogin({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Log in" })).toBeInTheDocument();
    expect(document.title).toBe("Log in · Qatra");
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/recovery");
    expect(screen.getByText("Don't have an account?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");
  });

  it("shows no banner, no summary and no alert on arrival, and an empty polite status area stays in the page", () => {
    const { container } = renderLogin();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const regions = container.querySelectorAll("[role=status]");
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region).toHaveAttribute("aria-live", "polite");
      expect(region).toBeEmptyDOMElement();
    }
  });
});

describe("password toggle (P-08, S-01 c5)", () => {
  it("shows and hides the password through the 44 px icon button and names the action", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(passwordInput(), "a synthetic passphrase");
    const show = screen.getByRole("button", { name: "إظهار كلمة المرور" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    expect(show).toHaveClass("size-target");
    expect(show.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    await user.click(show);
    expect(passwordInput()).toHaveAttribute("type", "text");
    expect(passwordInput()).toHaveValue("a synthetic passphrase");
    const hide = screen.getByRole("button", { name: "إخفاء كلمة المرور" });
    expect(hide).toHaveAttribute("aria-pressed", "true");

    await user.click(hide);
    expect(passwordInput()).toHaveAttribute("type", "password");
  });

  it("is named in English too", () => {
    renderLogin({ language: "en" });
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("validation, on submit only (P-03, S-01 section 3)", () => {
  it("sends nothing and shows a summary of two errors when both fields are empty, focusing the username", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await user.click(submitButton());

    expect(backend.count("POST /api/auth/login")).toBe(0);
    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent("يوجد ٢ أخطاء في النموذج");
    const links = within(summary).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["أدخل اسم المستخدم.", "أدخل كلمة المرور."]);

    for (const [field, message] of [
      [usernameInput(), "أدخل اسم المستخدم."],
      [passwordInput(), "أدخل كلمة المرور."],
    ] as const) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(document.getElementById(field.getAttribute("aria-describedby") as string)).toHaveTextContent(message);
    }
    expect(usernameInput()).toHaveFocus();
  });

  it("lets a link of the summary move focus to its field", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(submitButton());
    await user.click(screen.getByRole("link", { name: "أدخل كلمة المرور." }));
    expect(passwordInput()).toHaveFocus();
  });

  it("shows no summary for one error: the field is announced through its description, and focus goes to it", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await fill(user, "sample_user_01", "");
    await user.click(submitButton());

    expect(backend.count("POST /api/auth/login")).toBe(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
    expect(passwordInput()).toHaveFocus();
  });

  it("treats a username of only spaces as empty and focuses it, while a password of spaces is a password", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await fill(user, "   ", MOCK_PASSWORD);
    await user.click(submitButton());
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");
    expect(usernameInput()).toHaveFocus();
    expect(backend.count("POST /api/auth/login")).toBe(0);

    await user.clear(usernameInput());
    await user.type(usernameInput(), "sample_user_01");
    await user.clear(passwordInput());
    await user.type(passwordInput(), "   ");
    await user.click(submitButton());
    expect(backend.count("POST /api/auth/login")).toBe(1);
    expect(backend.calls.find((call) => call.key === "POST /api/auth/login")?.body).toEqual({ username: "sample_user_01", password: "   " });
  });

  it("does not validate while the visitor types or when an empty field loses focus", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(usernameInput());
    await user.tab();
    await user.tab();
    await user.tab();
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the error of a field at its next blur once it holds something, and the summary follows", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(submitButton());
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.type(usernameInput(), "sample_user_01");
    await user.tab();
    await vi.waitFor(() => expect(usernameInput()).not.toHaveAttribute("aria-invalid"));
    // One error is left, so the summary is gone and the field speaks for itself.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the message while a press that caused the blur is still down, so the button does not slide away, and clears it on release", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await user.click(submitButton());
    await user.type(usernameInput(), "sample_user_01");
    await user.type(passwordInput(), MOCK_PASSWORD);
    await vi.waitFor(() => expect(usernameInput()).not.toHaveAttribute("aria-invalid"));
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");

    // Pressing the button blurs the password field. Its message must stay until the pointer is up.
    await user.pointer({ keys: "[MouseLeft>]", target: submitButton() });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
    expect(backend.count("POST /api/auth/login")).toBe(0);

    await user.pointer({ keys: "[/MouseLeft]" });
    await vi.waitFor(() => expect(backend.count("POST /api/auth/login")).toBe(1));
    await vi.waitFor(() => expect(passwordInput()).not.toHaveAttribute("aria-invalid"));
  });

  it("keeps an error while the field is still empty at blur, and clears everything at the next submit", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(submitButton());
    await user.click(usernameInput());
    await user.tab();
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");

    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
  });

  it("words the summary and the messages in English with Western digits", async () => {
    const user = userEvent.setup();
    renderLogin({ language: "en" });
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("There are 2 errors in the form");
    expect(screen.getByRole("link", { name: "Enter your username." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter your password." })).toBeInTheDocument();
  });
});

describe("submitting E04 and the exits (S-01 section 1)", () => {
  it("sends the trimmed username and the untouched password as JSON to the same origin, once", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await fill(user, "  sample_user_01  ", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());

    const sent = backend.calls.filter((call) => call.key === "POST /api/auth/login");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ username: "sample_user_01", password: MOCK_PASSWORD });
    expect(sent[0]?.init?.credentials).toBe("same-origin");
    const headers = sent[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("goes to /today when the account has a plan, wipes the password, and keeps the button busy while the next screen opens", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(passwordInput()).toHaveValue("");
    expect(submitButton()).toHaveAttribute("aria-busy", "true");
  });

  it("goes to /start when E18 says there is no plan", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "new_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
  });

  it("goes to /today when E18 itself fails, so a signed-in visitor is never stranded", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      "GET /api/today": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("goes to the kept path and does not ask E18 when ?next= is a path inside the app", async () => {
    window.history.pushState({}, "", "/login?next=%2Fprogress%3Ftab%3D1");
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/progress?tab=1"));
    expect(backend.count("GET /api/today")).toBe(0);
  });

  it.each(["//evil.example", "https://evil.example/x", "javascript:alert(1)", "/\\evil.example", "/login", "/api/auth/logout"])(
    "ignores the unsafe ?next=%s and goes home",
    async (next) => {
      window.history.pushState({}, "", `/login?next=${encodeURIComponent(next)}`);
      const user = userEvent.setup();
      renderLogin();
      await fill(user, "sample_user_01", MOCK_PASSWORD);
      await user.click(submitButton());
      await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
      expect(navigation.router.replace).not.toHaveBeenCalledWith(next);
    },
  );

  it("goes to the re-consent gate when E04 asks for it, keeping ?next= in memory", async () => {
    window.history.pushState({}, "", "/login?next=%2Fgames");
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await fill(user, "reconsent_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/consent"));
    expect(takeReturnPath()).toBe("/games");
    expect(backend.count("GET /api/today")).toBe(0);
    expect(window.location.search).toBe("?next=%2Fgames");
  });

  it("applies the profile language after login (P-02)", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      "POST /api/auth/login": () => jsonResponse({ profile: { ...mockProfile, language: "en" }, reconsentRequired: false }),
    });
    renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("is sent by Enter in either field", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await user.type(usernameInput(), "sample_user_01{Enter}");
    expect(backend.count("POST /api/auth/login")).toBe(0);
    await user.type(passwordInput(), `${MOCK_PASSWORD}{Enter}`);
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count("POST /api/auth/login")).toBe(1);
  });

  it("stores nothing in the browser and shows no message on success", async () => {
    const user = userEvent.setup();
    renderLogin();
    // The helper stored the language to set the scene; from here on the screen may store nothing.
    localStorage.clear();
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the submitting state (S-01 section 4)", () => {
  it("shows the loading button, announces it politely, keeps the fields, keeps focus, and ignores a second press and Enter", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const backend = makeBackend({ "POST /api/auth/login": () => gate.promise });
    renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());

    const button = submitButton();
    expect(button).toHaveTextContent("جارٍ الدخول…");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    expect(button.querySelector("span[aria-hidden=true]")).toHaveClass("animate-spin");
    expect(politeRegion("جارٍ الدخول")).toHaveAttribute("aria-live", "polite");
    expect(usernameInput()).toHaveValue("sample_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);

    await user.click(button);
    await user.type(passwordInput(), "{Enter}");
    expect(backend.count("POST /api/auth/login")).toBe(1);

    gate.resolve(jsonResponse({ profile: mockProfile, reconsentRequired: false }));
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("says it is still working after 5 s, as a polite line, and takes the line away when the answer comes", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const gate = deferred<Response>();
    renderLogin({ backend: makeBackend({ "POST /api/auth/login": () => gate.promise }) });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());

    await advance(4_900);
    expect(screen.queryByText("ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.")).not.toBeInTheDocument();
    await advance(200);
    expect(politeRegion("ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.")).toHaveAttribute("aria-live", "polite");
    expect(submitButton()).toHaveAttribute("aria-busy", "true");

    gate.resolve(jsonResponse({ error: { code: "invalid_credentials", message: "x", details: {} } }, 401));
    await flush();
    expect(screen.queryByText("ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.")).not.toBeInTheDocument();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
  });
});

describe("E04 errors (S-01 section 3, P-06, P-07)", () => {
  it("wrong credentials: one generic alert above the button, the password cleared and focused, the username kept, no field marked", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "sample_user_01", "a wrong passphrase");
    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("اسم المستخدم أو كلمة المرور غير صحيحة.");
    expect(passwordInput()).toHaveValue("");
    expect(passwordInput()).toHaveFocus();
    expect(usernameInput()).toHaveValue("sample_user_01");
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
    expect(navigation.router.replace).not.toHaveBeenCalled();

    // The button is the retry.
    await user.type(passwordInput(), MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("puts the banner above the submit button and below the fields", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "sample_user_01", "wrong");
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(follows(passwordInput(), alert)).toBe(true);
    expect(follows(alert, submitButton())).toBe(true);
  });

  it("answers an unknown name like a wrong password", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "nobody_here_01", MOCK_PASSWORD);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("اسم المستخدم أو كلمة المرور غير صحيحة.");
  });

  it("500: a generic alert, the values kept, focus on the button", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "internal_user_01", "any password");
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    expect(usernameInput()).toHaveValue("internal_user_01");
    expect(passwordInput()).toHaveValue("any password");
    expect(submitButton()).toHaveFocus();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
  });

  it("503: a warning in the polite status area, not an alert", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "unavailable_user_01", "any password");
    await user.click(submitButton());
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(politeRegion("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submitButton()).toHaveFocus();
  });

  it("403 forbidden origin: an alert with a reload button that reloads the page", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "origin_user_01", "any password");
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.");
    await user.click(within(alert).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("treats a validation_error the client cannot produce, and an unknown code, as an unexpected error", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      "POST /api/auth/login": () => jsonResponse({ error: { code: "validation_error", message: "x", details: { fields: [] } } }, 422),
    });
    renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
  });

  it("never shows the message of the API, a status code or any submitted value", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      "POST /api/auth/login": () => jsonResponse({ error: { code: "internal", message: "Database exploded for sample_user_01", details: {} } }, 500),
    });
    const { container } = renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await screen.findByRole("alert");
    expect(container.textContent).not.toContain("exploded");
    expect(container.textContent).not.toContain("500");
    expect(container.textContent).not.toContain(MOCK_PASSWORD);
  });

  it("replaces the earlier banner with the next one", async () => {
    const user = userEvent.setup();
    renderLogin();
    await fill(user, "sample_user_01", "wrong");
    await user.click(submitButton());
    await screen.findByRole("alert");
    await user.clear(usernameInput());
    await user.type(usernameInput(), "internal_user_01");
    await user.type(passwordInput(), "x");
    await user.click(submitButton());
    expect(await screen.findByText("حدث خطأ غير متوقع. حاول مرة أخرى.")).toBeInTheDocument();
    expect(screen.queryByText("اسم المستخدم أو كلمة المرور غير صحيحة.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("throttle (P-06)", () => {
  async function throttle(username: string, language: "ar" | "en" = "ar") {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const view = renderLogin({ language });
    if (language === "en") {
      await user.type(screen.getByLabelText("Username"), username);
      await user.type(screen.getByLabelText("Password"), "any password");
      await user.click(screen.getByRole("button", { name: "Log in" }));
    } else {
      await fill(user, username, "any password");
      await user.click(submitButton());
    }
    await flush();
    return { user, ...view };
  }

  it("up to a minute: a warning with the wait in seconds, a button that is aria-disabled but focusable and tied to the banner", async () => {
    await throttle("throttled_user_01");
    const text = "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.";
    const banner = screen.getByText(text);
    expect(politeRegion(text)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    const button = submitButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)).toContainElement(banner);
    button.focus();
    expect(button).toHaveFocus();
  });

  it("counts down in a visible line that assistive technology does not hear, and ignores a press meanwhile", async () => {
    const { user, container, backend } = await throttle("throttled_user_01");
    const line = container.querySelector("p[aria-hidden=true] bdi") as HTMLElement;
    expect(line).toHaveAttribute("dir", "ltr");
    expect(line).toHaveTextContent("٠٠:٢٠");
    expect(line.closest("p")).toHaveAttribute("aria-hidden", "true");

    await advance(1_000);
    expect(line).toHaveTextContent("٠٠:١٩");
    await advance(9_000);
    expect(line).toHaveTextContent("٠٠:١٠");

    // The banner never changes while it counts: the wording is frozen at receipt.
    expect(screen.getByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();

    await user.click(submitButton());
    await user.type(passwordInput(), "{Enter}");
    await flush();
    expect(backend.count("POST /api/auth/login")).toBe(1);
    expect(submitButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("re-enables the button at zero, takes the banner away, announces «you can try again now», and leaves focus where it was", async () => {
    const { user } = await throttle("throttled_user_01");
    submitButton().focus();
    await advance(19_000);
    expect(submitButton()).toHaveAttribute("aria-disabled", "true");
    await advance(1_000);

    expect(submitButton()).not.toHaveAttribute("aria-disabled");
    expect(submitButton()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).not.toBeInTheDocument();
    const status = politeRegion("يمكنك المحاولة الآن.");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(submitButton()).toHaveFocus();
    expect(document.querySelector("p[aria-hidden=true] bdi")).toBeNull();

    // The same button is the retry.
    await user.click(submitButton());
    await flush();
    expect(screen.getByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
  });

  it("the 15-minute lock: the banner counts in mm:ss, left to right", async () => {
    await throttle("locked_user_01");
    const banner = screen.getByText(/محاولات كثيرة\. يمكنك المحاولة بعد/);
    expect(banner).toHaveTextContent("محاولات كثيرة. يمكنك المحاولة بعد ١٥:٠٠.");
    expect(banner.querySelector("bdi")).toHaveAttribute("dir", "ltr");
    expect(document.querySelector("p[aria-hidden=true] bdi")).toHaveTextContent("١٥:٠٠");
    await advance(61_000);
    expect(document.querySelector("p[aria-hidden=true] bdi")).toHaveTextContent("١٣:٥٩");
  });

  it("is worded in English with Western digits", async () => {
    await throttle("throttled_user_01", "en");
    expect(screen.getByText("Too many attempts. Wait 20 seconds and try again.")).toBeInTheDocument();
    expect(document.querySelector("p[aria-hidden=true] bdi")).toHaveTextContent("00:20");
  });

  it("keeps the username and the password for the retry", async () => {
    await throttle("throttled_user_01");
    expect(usernameInput()).toHaveValue("throttled_user_01");
    expect(passwordInput()).toHaveValue("any password");
  });
});

describe("wake-up (P-04) and connectivity (P-05)", () => {
  const failingLogin = (): Response => {
    throw new TypeError("Failed to fetch");
  };

  it("a send that gets no answer shows the wake-up line above the button, keeps the values and focus, and is not resent", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const backend = makeBackend({ "POST /api/auth/login": failingLogin });
    renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await flush();

    const line = screen.getByText(WAKING.ar);
    expect(politeRegion(WAKING.ar)).toHaveAttribute("aria-live", "polite");
    expect(follows(line, submitButton())).toBe(true);
    expect(follows(passwordInput(), line)).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(usernameInput()).toHaveValue("sample_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
    expect(submitButton()).toHaveFocus();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).not.toBeInTheDocument();

    await advance(30_000);
    expect(backend.count("POST /api/auth/login")).toBe(1);
  });

  it("takes the line away once the server answers and announces that it is ready, because a send had failed", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    renderLogin({ backend: makeBackend({ "POST /api/auth/login": failingLogin }) });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await flush();
    expect(screen.getByText(WAKING.ar)).toBeInTheDocument();

    await advance(1_000);
    expect(screen.queryByText(WAKING.ar)).not.toBeInTheDocument();
    const status = politeRegion(READY_AR);
    expect(status).toHaveClass("sr-only");
    expect(usernameInput()).toHaveValue("sample_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
  });

  it("adds a retry button after 90 s that starts the polling again", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    let healthy = false;
    const backend = makeBackend({
      "POST /api/auth/login": failingLogin,
      "GET /api/health": () => (healthy ? jsonResponse({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }) : new Response("<html>asleep</html>", { status: 502 })),
    });
    renderLogin({ backend });
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await flush();
    await advance(89_000);
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).not.toBeInTheDocument();
    await advance(1_500);
    const retry = screen.getByRole("button", { name: "إعادة المحاولة" });
    expect(screen.getByText(WAKING.ar)).toBeInTheDocument();

    healthy = true;
    await user.click(retry);
    await flush();
    expect(screen.queryByText(WAKING.ar)).not.toBeInTheDocument();
  });

  it("does not announce readiness when nothing was pressed: a probe that failed at load is just retried", async () => {
    vi.useFakeTimers();
    let probes = 0;
    let awake = false;
    const backend = makeBackend({
      "GET /api/health": () => (awake ? jsonResponse({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }) : new Response("<html>asleep</html>", { status: 502 })),
      "GET /api/me": () => {
        probes += 1;
        if (probes === 1) throw new TypeError("Failed to fetch");
        return jsonResponse({ error: { code: "unauthenticated", message: "x", details: {} } }, 401);
      },
    });
    renderLogin({ backend });
    await flush();
    expect(screen.getByText(WAKING.ar)).toBeInTheDocument();

    awake = true;
    await advance(1_000);
    expect(screen.queryByText(WAKING.ar)).not.toBeInTheDocument();
    expect(screen.queryByText(READY_AR)).not.toBeInTheDocument();
    expect(backend.count("GET /api/me")).toBe(2);
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("shows the offline notice when the browser reports no connection, before any press, and never disables the button", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderLogin();
    expect(politeRegion(OFFLINE_AR)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
  });

  it("raises the notice on the offline event and removes it on the online event with a polite «the connection is back»", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    renderLogin();
    expect(screen.queryByText(OFFLINE_AR)).not.toBeInTheDocument();

    onLine.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(OFFLINE_AR)).toBeInTheDocument();

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(OFFLINE_AR)).not.toBeInTheDocument();
    const status = politeRegion("عاد الاتصال.");
    expect(status).toHaveClass("sr-only");
  });

  it("still sends the form while the browser says it is offline: the flag is only a hint", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await fill(user, "sample_user_01", MOCK_PASSWORD);
    await user.click(submitButton());
    await vi.waitFor(() => expect(backend.count("POST /api/auth/login")).toBe(1));
  });

  it("words the wake-up line and the offline notice in English", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderLogin({ language: "en" });
    expect(screen.getByText("There is no network connection. Check your connection and try again.")).toBeInTheDocument();
  });
});

describe("arrival banners (P-09)", () => {
  it.each([
    ["session_ended", "انتهت جلستك. سجّل الدخول للمتابعة.", "warning"],
    ["reset_done", "تم تعيين كلمة مرور جديدة. سجّل الدخول بها.", "success"],
    ["account_deleted", "تم حذف حسابك.", "info"],
  ] as const)("%s shows a %s banner below the heading, with no live role and no announcement on load", (kind, text, variant) => {
    raiseLoginArrival(kind);
    renderLogin();
    const message = screen.getByText(text);
    const banner = message.closest(`[class*="border-${variant}-edge"]`) as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner).not.toHaveAttribute("role");
    expect(message.closest("[role=status], [role=alert]")).toBeNull();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(follows(heading, banner)).toBe(true);
    expect(follows(banner, usernameInput())).toBe(true);
    expect(heading).not.toHaveFocus();
  });

  it("shows only the strongest one: session ended, then reset done, then account deleted", () => {
    raiseLoginArrival("account_deleted");
    raiseLoginArrival("reset_done");
    raiseLoginArrival("session_ended");
    renderLogin();
    expect(screen.getByText("انتهت جلستك. سجّل الدخول للمتابعة.")).toBeInTheDocument();
    expect(screen.queryByText("تم تعيين كلمة مرور جديدة. سجّل الدخول بها.")).not.toBeInTheDocument();
    expect(screen.queryByText("تم حذف حسابك.")).not.toBeInTheDocument();
  });

  it("is shown once: a second visit finds nothing", () => {
    raiseLoginArrival("reset_done");
    const first = renderLogin();
    expect(screen.getByText("تم تعيين كلمة مرور جديدة. سجّل الدخول بها.")).toBeInTheDocument();
    first.unmount();
    renderLogin();
    expect(screen.queryByText("تم تعيين كلمة مرور جديدة. سجّل الدخول بها.")).not.toBeInTheDocument();
  });

  it("can be dismissed with a named button, and focus moves to the heading", async () => {
    const user = userEvent.setup();
    raiseLoginArrival("session_ended");
    renderLogin();
    const dismiss = screen.getByRole("button", { name: "إغلاق التنبيه" });
    expect(dismiss).toHaveClass("size-target");
    await user.click(dismiss);
    expect(screen.queryByText("انتهت جلستك. سجّل الدخول للمتابعة.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("is dismissed from the keyboard too, and sits before the fields in the tab order", async () => {
    const user = userEvent.setup();
    raiseLoginArrival("account_deleted");
    renderLogin();
    await user.tab();
    expect(screen.getByRole("button", { name: "إغلاق التنبيه" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("تم حذف حسابك.")).not.toBeInTheDocument();
  });

  it("sits with the error summary when both apply, the arrival banner first", async () => {
    const user = userEvent.setup();
    raiseLoginArrival("session_ended");
    renderLogin();
    await user.click(submitButton());
    const arrival = screen.getByText("انتهت جلستك. سجّل الدخول للمتابعة.");
    const summary = screen.getByRole("alert");
    expect(follows(arrival, summary)).toBe(true);
  });

  it("is worded in English", () => {
    raiseLoginArrival("session_ended");
    renderLogin({ language: "en" });
    expect(screen.getByText("Your session ended. Log in to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss message" })).toBeInTheDocument();
  });
});

describe("guard 2: a valid session leaves the form (UI-design 2.3)", () => {
  it("sends a signed-in visitor with a plan to /today", async () => {
    renderLogin({ backend: makeBackend({}, { signedIn: true, hasPlan: true }) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("sends a signed-in visitor without a plan to /start", async () => {
    renderLogin({ backend: makeBackend({}, { signedIn: true, hasPlan: false }) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
  });

  it("sends a signed-in visitor home even when ?next= is present", async () => {
    window.history.pushState({}, "", "/login?next=%2Fprogress");
    renderLogin({ backend: makeBackend({}, { signedIn: true, hasPlan: true }) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("leaves a visitor without a session on the form", async () => {
    const { backend } = renderLogin();
    await vi.waitFor(() => expect(backend.count("GET /api/me")).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(backend.count("GET /api/today")).toBe(0);
    expect(screen.getByRole("heading", { level: 1, name: "الدخول" })).toBeInTheDocument();
  });

  it("asks E01 first, so the first request of the page load stays the health probe", async () => {
    const { backend } = renderLogin();
    await vi.waitFor(() => expect(backend.count("GET /api/me")).toBe(1));
    expect(backend.calls.map((call) => call.key).slice(0, 2)).toEqual(["GET /api/health", "GET /api/me"]);
  });

  it("probes once even when the page renders again", async () => {
    const user = userEvent.setup();
    const { backend } = renderLogin();
    await vi.waitFor(() => expect(backend.count("GET /api/me")).toBe(1));
    await user.type(usernameInput(), "a");
    await user.click(submitButton());
    expect(backend.count("GET /api/me")).toBe(1);
  });
});

describe("keyboard and focus (S-01 section 5)", () => {
  it("tabs through the skip link, the language switch, the fields, the toggle, the button and the two links, in that order", async () => {
    const user = userEvent.setup();
    renderLogin({ shell: true });
    const stops: HTMLElement[] = [];
    for (let index = 0; index < 8; index += 1) {
      await user.tab();
      stops.push(document.activeElement as HTMLElement);
    }
    expect(stops).toEqual([
      screen.getByRole("link", { name: "انتقل إلى المحتوى" }),
      screen.getByRole("radio", { name: "العربية" }),
      usernameInput(),
      passwordInput(),
      screen.getByRole("button", { name: "إظهار كلمة المرور" }),
      submitButton(),
      screen.getByRole("link", { name: "نسيت كلمة المرور" }),
      screen.getByRole("link", { name: "إنشاء حساب" }),
    ]);
  });

  it("moves between the two fields with Tab and focuses the password before its toggle", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(usernameInput());
    await user.tab();
    expect(passwordInput()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "إظهار كلمة المرور" })).toHaveFocus();
  });

  it("has no autofocus on the first load", () => {
    renderLogin();
    expect(document.body).toHaveFocus();
  });

  it("does not trap the keyboard: Escape does nothing here", async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(usernameInput());
    await user.keyboard("{Escape}");
    expect(usernameInput()).toHaveFocus();
  });

  it("keeps the typed values when the language is switched, and words the form in English", async () => {
    const user = userEvent.setup();
    renderLogin({ shell: true });
    await fill(user, "sample_user_01", "a synthetic passphrase");
    await user.click(screen.getByRole("radio", { name: "English (EN)" }));

    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByLabelText("Username")).toHaveValue("sample_user_01");
    expect(screen.getByLabelText("Password")).toHaveValue("a synthetic passphrase");
    expect(screen.getByRole("heading", { level: 1, name: "Log in" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English (EN)" })).toHaveFocus();
  });
});
