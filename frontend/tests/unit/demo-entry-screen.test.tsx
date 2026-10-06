import { act, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/demo", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), browserTimeZone: () => "Asia/Dubai" }));
vi.mock("@/lib/browser", () => browser);
vi.mock("@/lib/config", () => ({ API_MODE: "live", TERMS_VERSION: "2026-10-04" }));

import { DemoEntryScreen } from "@/components/demo/DemoEntryScreen";
import { LoginForm } from "@/components/auth/LoginForm";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_PASSWORD, MOCK_RECOVERY_CODE, type MockScenario } from "@/lib/api/mock";
import { peekRecoveryCode, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft } from "@/lib/auth/register-draft";

type Handler = () => Response | Promise<Response>;

const envelope = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "Safe text.", details } });
const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// The mock layer answers by default; a test overrides single operations. Every call is recorded.
function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: false }) {
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

const DEMO = "POST /api/demo/accounts";
const LEARNER = "POST /api/auth/register";

let runtime: ApiRuntime;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderEntry({ language = "ar", backend = makeBackend(), plain = false }: { language?: "ar" | "en"; backend?: Backend; plain?: boolean } = {}) {
  setLanguage(language);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{plain ? <RegisterForm variant="demo" /> : <DemoEntryScreen />}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

const COPY = {
  ar: { heading: "رابط العرض التجريبي", submit: "إنشاء حساب العرض", submitting: "جارٍ إنشاء حساب العرض…", username: "اسم المستخدم", password: "كلمة المرور", confirmation: "تأكيد كلمة المرور", consent: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها", back: "رجوع إلى تصفّح الكتب" },
  en: { heading: "Try the demo", submit: "Create demo account", submitting: "Creating the demo account…", username: "Username", password: "Password", confirmation: "Confirm password", consent: "I have read the terms of use and privacy statement and I agree to them.", back: "Back to Browse books" },
} as const;

async function fill(user: UserEvent, language: "ar" | "en", username = "fresh_demo_01") {
  const copy = COPY[language];
  await user.type(screen.getByLabelText(copy.username), username);
  await user.type(screen.getByLabelText(copy.password, { exact: true }), MOCK_PASSWORD);
  await user.type(screen.getByLabelText(copy.confirmation, { exact: true }), MOCK_PASSWORD);
  await user.click(screen.getByRole("checkbox", { name: copy.consent }));
}

const submitButton = (language: "ar" | "en") => screen.getByRole("button", { name: new RegExp(`^(${COPY[language].submit}|${COPY[language].submitting})$`) });

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearRegisterDraft();
  wipeRecoveryCode();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRegisterDraft();
  wipeRecoveryCode();
});

describe("S-28 structure", () => {
  for (const language of ["ar", "en"] as const) {
    it(`${language}: shows the demo heading and title, the explanation, the synthetic-data note and the demo button, with the back control to the catalog`, () => {
      renderEntry({ language });
      const copy = COPY[language];
      expect(screen.getByRole("heading", { level: 1, name: copy.heading })).toHaveAttribute("data-page-heading");
      expect(document.title).toBe(language === "ar" ? "رابط العرض التجريبي · قطرة غيث" : "Try the demo · Qatra");
      expect(screen.getByText(/ببيانات اصطناعية|synthetic data/)).toBeInTheDocument();
      expect(screen.getByText(/لا يحمل بيانات حقيقية|holds no real data/)).toBeInTheDocument();
      expect(submitButton(language)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.back })).toHaveAttribute("href", "/");
      expect(screen.getByRole("checkbox", { name: copy.consent })).not.toBeChecked();
    });
  }

  it("writes no dash into the new text", () => {
    const { container } = renderEntry();
    expect(container.textContent).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`));
  });

  it("leaves S-02 as it was: the learner form has its own heading, button and no demo words", () => {
    setLanguage("ar");
    runtime = createApiRuntime({ mode: "live", fetch: makeBackend().fetchImpl });
    render(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <RegisterForm />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "إنشاء الحساب" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إنشاء الحساب" })).toBeInTheDocument();
    expect(screen.queryByText(/حساب العرض/)).not.toBeInTheDocument();
  });
});

describe("S-28 creating the demo account (E26)", () => {
  for (const language of ["ar", "en"] as const) {
    it(`${language}: sends E26 only, with the six fields of E03 and no demo flag, then hands the code to S-04 with the demo host`, async () => {
      const user = userEvent.setup();
      const { backend } = renderEntry({ language });
      await fill(user, language);
      await user.click(submitButton(language));
      await settle();

      expect(backend.count(DEMO)).toBe(1);
      expect(backend.count(LEARNER)).toBe(0);
      const body = backend.calls.find((call) => call.key === DEMO)?.body ?? {};
      expect(Object.keys(body).sort()).toEqual(["language", "password", "termsAccepted", "termsVersion", "timeZone", "username"]);
      expect(body).toMatchObject({ language, termsAccepted: true, termsVersion: "2026-10-04", timeZone: "Asia/Dubai" });
      expect(peekRecoveryCode()).toEqual({ code: MOCK_RECOVERY_CODE, host: "demo" });
      expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code");
    });
  }

  it("does not send anything while a field is invalid or the consent box is unchecked", async () => {
    const user = userEvent.setup();
    const { backend } = renderEntry();
    await user.click(submitButton("ar"));
    expect(backend.count(DEMO)).toBe(0);
    await user.type(screen.getByLabelText(COPY.ar.username), "fresh_demo_01");
    await user.type(screen.getByLabelText(COPY.ar.password, { exact: true }), MOCK_PASSWORD);
    await user.type(screen.getByLabelText(COPY.ar.confirmation, { exact: true }), MOCK_PASSWORD);
    await user.click(submitButton("ar"));
    expect(backend.count(DEMO)).toBe(0);
    expect(screen.getByText("يلزم الموافقة على شروط الاستخدام وبيان الخصوصية لإنشاء الحساب.")).toBeInTheDocument();
  });

  it("sends once when the button is pressed twice while the answer is awaited", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = makeBackend({
      [DEMO]: async () => {
        await held;
        return jsonResponse({ profile: {}, recoveryCode: MOCK_RECOVERY_CODE }, 201);
      },
    });
    const user = userEvent.setup();
    renderEntry({ backend });
    await fill(user, "ar");
    await user.click(submitButton("ar"));
    await user.click(submitButton("ar"));
    expect(backend.count(DEMO)).toBe(1);
    release();
    await settle();
    expect(backend.count(DEMO)).toBe(1);
  });

  it("marks a taken name on the name field and keeps the values", async () => {
    const user = userEvent.setup();
    renderEntry();
    await fill(user, "ar", "taken_user_01");
    await user.click(submitButton("ar"));
    await settle();
    expect(screen.getAllByText("اسم المستخدم غير متاح. اختر اسمًا آخر.").length).toBeGreaterThan(0);
    expect(screen.getByLabelText(COPY.ar.username)).toHaveFocus();
    expect(screen.getByLabelText(COPY.ar.username)).toHaveValue("taken_user_01");
    expect(peekRecoveryCode()).toBeNull();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("shows the throttle wording with a countdown for the per-minute and the per-day answer, and never retries by itself", async () => {
    const backend = makeBackend({ [DEMO]: () => jsonResponse(envelope("throttled", { retryAfterSec: 3600 }), 429) });
    const user = userEvent.setup();
    renderEntry({ backend });
    await fill(user, "ar");
    await user.click(submitButton("ar"));
    await settle();
    expect(document.body.textContent).toContain("محاولات كثيرة. يمكنك المحاولة بعد ٦٠:٠٠.");
    expect(submitButton("ar")).toHaveAttribute("aria-disabled", "true");
    await user.click(submitButton("ar"));
    expect(backend.count(DEMO)).toBe(1);
  });

  it("shows the generic banners of S-02 for 503 and 500, never the API message", async () => {
    for (const [status, code, text] of [
      [503, "unavailable", "الخدمة غير متاحة مؤقتًا. حاول بعد قليل."],
      [500, "internal", "حدث خطأ غير متوقع. حاول مرة أخرى."],
    ] as const) {
      const backend = makeBackend({ [DEMO]: () => jsonResponse(envelope(code), status) });
      const user = userEvent.setup();
      const view = renderEntry({ backend });
      await fill(user, "ar");
      await user.click(submitButton("ar"));
      await settle();
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByText("Safe text.")).not.toBeInTheDocument();
      expect(backend.count(DEMO)).toBe(1);
      view.unmount();
      runtime.wakeUp.dispose();
    }
  });

  it("says the outcome is uncertain when no answer comes, and does not send again by itself", async () => {
    const backend = makeBackend({ [DEMO]: () => Promise.reject(new TypeError("network down")) });
    const user = userEvent.setup();
    renderEntry({ backend });
    await fill(user, "ar");
    await user.click(submitButton("ar"));
    await settle();
    expect(screen.getByText(/تعذّر تأكيد إنشاء الحساب/)).toBeInTheDocument();
    expect(backend.count(DEMO)).toBe(1);
  });
});

describe("the demo link of S-01", () => {
  function renderLogin(props: { demoLink?: boolean }, language: "ar" | "en" = "ar") {
    setLanguage(language);
    runtime = createApiRuntime({ mode: "live", fetch: makeBackend().fetchImpl });
    return render(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <LoginForm {...props} />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
  }

  it("is a tertiary text link to /demo after the create-account line, in both languages", () => {
    renderLogin({ demoLink: true });
    const link = screen.getByRole("link", { name: "رابط عرض تجريبي" });
    expect(link).toHaveAttribute("href", "/demo");
    expect(Boolean(screen.getByRole("link", { name: "إنشاء حساب" }).compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("reads Try the demo in English", () => {
    renderLogin({ demoLink: true }, "en");
    expect(screen.getByRole("link", { name: "Try the demo" })).toHaveAttribute("href", "/demo");
  });

  it("is absent from the bare form, which stays as in option B", () => {
    renderLogin({});
    expect(screen.queryByRole("link", { name: "رابط عرض تجريبي" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});
