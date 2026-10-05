import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/register", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), browserTimeZone: () => "Asia/Dubai" }));
vi.mock("@/lib/browser", () => browser);
// The build's terms version: the screen sends it, and compares what the server asks for with it.
const config = vi.hoisted(() => ({ termsVersion: "2026-10-04" as string | null }));
vi.mock("@/lib/config", () => ({
  API_MODE: "live",
  get TERMS_VERSION() {
    return config.termsVersion;
  },
}));

import { RegisterForm } from "@/components/auth/RegisterForm";
import { RegisterScreen } from "@/components/auth/RegisterScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_PASSWORD, MOCK_RECOVERY_CODE, type MockScenario } from "@/lib/api/mock";
import { peekRecoveryCode, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft, readRegisterDraft, saveRegisterDraft } from "@/lib/auth/register-draft";

const AR = {
  heading: "إنشاء الحساب",
  lead: "لا نطلب بريدًا إلكترونيًا ولا رقم هاتف ولا تاريخ ميلاد؛ اسم مستخدم وكلمة مرور فقط. جميع الحقول مطلوبة.",
  termsLink: "شروط الاستخدام وبيان الخصوصية",
  usernameHelper: "من ٣ إلى ٢٤ حرفًا: حروف عربية أو إنجليزية وأرقام وشرطة سفلية (_).",
  passwordHelper: "١٥ حرفًا على الأقل. يمكنك استخدام عبارة طويلة، ومدير كلمات المرور مقبول.",
  notice: "بعد إنشاء الحساب نعرض لك رمز استرجاع مرة واحدة. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.",
  consent: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
  consentRequired: "يلزم الموافقة على شروط الاستخدام وبيان الخصوصية لإنشاء الحساب.",
  needUsername: "أدخل اسم المستخدم.",
  invisible: "لا يقبل اسم المستخدم مسافات أو محارف غير مرئية.",
  chars: "يقبل اسم المستخدم حروفًا عربية أو إنجليزية وأرقامًا وشرطة سفلية فقط.",
  length: "اسم المستخدم من ٣ إلى ٢٤ حرفًا.",
  taken: "اسم المستخدم غير متاح. اختر اسمًا آخر.",
  takenHint: "إن كنت قد أنشأت هذا الحساب قبل لحظات فسجّل الدخول بدل ذلك.",
  needPassword: "أدخل كلمة المرور.",
  passwordMin: "كلمة المرور ١٥ حرفًا على الأقل.",
  passwordMax: "كلمة المرور أطول من الحد المسموح (٧٢ بايت). اختصرها قليلًا؛ الحرف العربي الواحد يُحتسب بايتين.",
  needConfirmation: "أكّد كلمة المرور.",
  mismatch: "كلمتا المرور غير متطابقتين.",
  uncertain: "تعذّر تأكيد إنشاء الحساب. إن كان قد أُنشئ فسجّل الدخول بالاسم وكلمة المرور ثم أنشئ رمز استرجاع جديدًا من الإعدادات؛ وإلا أعد المحاولة.",
  termsUpdated: "تحدّثت الشروط. أعد تحميل الصفحة لقراءة الإصدار الأحدث.",
  submitting: "جارٍ إنشاء الحساب",
  waking: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
  offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
  back: "عاد الاتصال.",
  ready: "الخادم جاهز. يمكنك المحاولة الآن.",
  processing: "ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  throttle20: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
  again: "يمكنك المحاولة الآن.",
  reload: "إعادة تحميل الصفحة",
  show: "إظهار كلمة المرور",
  hide: "إخفاء كلمة المرور",
  login: "تسجيل الدخول",
} as const;

type Handler = () => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const envelope = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "Safe text.", details } });

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

const REGISTER = "POST /api/auth/register";

let runtime: ApiRuntime;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderRegister({ language = "ar", backend = makeBackend(), shell = false }: { language?: "ar" | "en"; backend?: Backend; shell?: boolean } = {}) {
  setLanguage(language);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{shell ? <RegisterScreen /> : <RegisterForm />}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

const usernameInput = () => screen.getByLabelText("اسم المستخدم") as HTMLInputElement;
const passwordInput = () => screen.getByLabelText("كلمة المرور") as HTMLInputElement;
const confirmationInput = () => screen.getByLabelText("تأكيد كلمة المرور") as HTMLInputElement;
const consentBox = () => screen.getByRole("checkbox", { name: AR.consent }) as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /^(إنشاء الحساب|جارٍ إنشاء الحساب…)$/ });
const toggles = (name: string = AR.show) => screen.getAllByRole("button", { name }) as HTMLButtonElement[];

interface Values {
  username?: string;
  password?: string;
  confirmation?: string;
  consent?: boolean;
}

async function fill(user: UserEvent, { username = "fresh_user_01", password = MOCK_PASSWORD, confirmation = password, consent = true }: Values = {}) {
  if (username) await user.type(usernameInput(), username);
  if (password) await user.type(passwordInput(), password);
  if (confirmation) await user.type(confirmationInput(), confirmation);
  if (consent) await user.click(consentBox());
}

// Lets a blur check (which waits for a press to end) run, and the promises of a request settle, without a fake clock.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

// With a fake clock: lets the promises of a request settle without moving it.
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

const description = (field: HTMLElement) => (field.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent);

// jsdom cannot navigate: a press on a link is observed, and the page stays. Buttons keep their default action.
const stayOnPage = (event: Event) => {
  if ((event.target as Element).closest("a[href]")) event.preventDefault();
};

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearRegisterDraft();
  wipeRecoveryCode();
  config.termsVersion = "2026-10-04";
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  window.history.pushState({}, "", "/register");
  document.addEventListener("click", stayOnPage);
  // Testing Library waits on a setTimeout after every user-event call and moves a fake clock only when it finds a Jest-style global.
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
});

afterEach(() => {
  document.removeEventListener("click", stayOnPage);
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRegisterDraft();
  wipeRecoveryCode();
});

describe("S-02 structure (UI-screens S-02 sections 2, 3 and 5)", () => {
  it("shows the heading, the lead, the terms link, three fields, the notice, the consent block, the button and the login line, in the order of the spec", () => {
    renderRegister();
    const heading = screen.getByRole("heading", { level: 1, name: AR.heading });
    expect(heading).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("إنشاء الحساب · قطرة غيث");

    const order = [
      heading,
      screen.getByText(AR.lead),
      screen.getByRole("link", { name: AR.termsLink }),
      usernameInput(),
      passwordInput(),
      toggles()[0],
      confirmationInput(),
      toggles()[1],
      screen.getByText(AR.notice),
      consentBox(),
      screen.getByRole("link", { name: "شروط الاستخدام" }),
      screen.getByRole("link", { name: "بيان الخصوصية" }),
      submitButton(),
      screen.getByText("لديك حساب؟"),
      screen.getByRole("link", { name: AR.login }),
    ] as HTMLElement[];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
  });

  it("links the three terms lines to S-03, two of them to the anchor of their part, and the login line to S-01", () => {
    renderRegister();
    expect(screen.getByRole("link", { name: AR.termsLink })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "شروط الاستخدام" })).toHaveAttribute("href", "/terms#terms");
    expect(screen.getByRole("link", { name: "بيان الخصوصية" })).toHaveAttribute("href", "/terms#privacy");
    expect(screen.getByRole("link", { name: AR.login })).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("writes the label and the helper of the username and password as two elements, and never joins them with a dash (owner fix)", () => {
    const { container } = renderRegister();
    for (const [field, label, helper] of [
      [usernameInput(), "اسم المستخدم", AR.usernameHelper],
      [passwordInput(), "كلمة المرور", AR.passwordHelper],
    ] as const) {
      const labelElement = screen.getByText(label, { selector: "label" });
      const helperElement = screen.getByText(helper);
      expect(labelElement.tagName).toBe("LABEL");
      expect(labelElement).toHaveAttribute("for", field.id);
      expect(labelElement).toHaveTextContent(new RegExp(`^${label}$`));
      expect(helperElement.tagName).toBe("P");
      expect(labelElement).not.toContainElement(helperElement);
      expect(description(field)).toEqual([helper]);
    }
    expect(container.textContent).not.toMatch(new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`));
  });

  it("gives the username field the attributes of S-01, with no cap, no placeholder and no trimming", () => {
    renderRegister();
    const input = usernameInput();
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("dir", "auto");
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "next");
    expect(input).not.toHaveAttribute("maxlength");
    expect(input).not.toHaveAttribute("placeholder");
  });

  it("gives both password fields new-password, dir=auto, no cap and no autocomplete=off, and the right Enter key", () => {
    renderRegister();
    for (const [input, hint] of [
      [passwordInput(), "next"],
      [confirmationInput(), "go"],
    ] as const) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveAttribute("dir", "auto");
      expect(input).toHaveAttribute("autocomplete", "new-password");
      expect(input).toHaveAttribute("enterkeyhint", hint);
      expect(input).not.toHaveAttribute("maxlength");
      expect(input).not.toHaveAttribute("placeholder");
    }
  });

  it("is a form that validates by script: no browser bubbles, no required attribute, and only the box says it is required", () => {
    const { container } = renderRegister();
    const form = container.querySelector("form");
    expect(form).toHaveAttribute("novalidate");
    expect(form).toHaveAttribute("method", "post");
    expect(container.querySelector("[required]")).toBeNull();
    expect([...container.querySelectorAll("[aria-required]")]).toEqual([consentBox()]);
    expect(consentBox()).toHaveAttribute("aria-required", "true");
  });

  it("starts with the box unchecked, empty fields, no banner and no error, and empty polite status areas that stay in the page", () => {
    const { container } = renderRegister();
    expect(consentBox()).not.toBeChecked();
    expect([usernameInput().value, passwordInput().value, confirmationInput().value]).toEqual(["", "", ""]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector("[aria-invalid]")).toBeNull();
    const regions = container.querySelectorAll("[role=status]");
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region).toHaveAttribute("aria-live", "polite");
      expect(region).toBeEmptyDOMElement();
    }
  });

  it("shows the recovery-code notice as plain secondary text with a glyph, and no live region around it", () => {
    renderRegister();
    const notice = screen.getByText(AR.notice).closest("p") as HTMLElement;
    expect(notice).toHaveClass("text-small", "text-ink-secondary");
    expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(notice.closest("[role=status], [role=alert]")).toBeNull();
  });

  it("asks for nothing else: one text field, two password fields, one box, no email, phone, birth date, zone or language", () => {
    const { container } = renderRegister();
    expect([...container.querySelectorAll("input")].map((input) => input.getAttribute("name"))).toEqual(["username", "password", "confirmation", "consent"]);
    expect(container.querySelector("select, textarea, input[type=email], input[type=tel], input[type=date]")).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("renders in English with the proposed counterparts", () => {
    renderRegister({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Create an account" })).toBeInTheDocument();
    expect(document.title).toBe("Create an account · Qatra");
    expect(screen.getByText("We do not ask for an email address, phone number or date of birth; only a username and a password. All fields are required.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms of use and privacy statement" })).toHaveAttribute("href", "/terms");
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByText("3 to 24 characters: Arabic or English letters, digits and underscore (_).")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByText("At least 15 characters. A long phrase works well and a password manager is welcome.")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
    expect(screen.getByText("After you create the account we show you a recovery code once. If you lose both your password and the code, we cannot recover your account.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "I have read the terms of use and privacy statement and I agree to them." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms of use" })).toHaveAttribute("href", "/terms#terms");
    expect(screen.getByRole("link", { name: "Privacy statement" })).toHaveAttribute("href", "/terms#privacy");
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByText("Already have an account?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(2);
  });
});

describe("the header of S-02 (P-02)", () => {
  it("has a back control to S-07 that goes to /login until S-07 exists, and the language switch, and no lockup", () => {
    renderRegister({ shell: true });
    const back = screen.getByRole("link", { name: "رجوع إلى تصفّح الكتب" });
    expect(back).toHaveAttribute("href", "/login");
    expect(back).toHaveClass("size-target");
    expect(back.querySelector("svg")).toHaveClass("rtl:-scale-x-100");
    expect(screen.getByRole("radiogroup", { name: "اللغة" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "قطرة غيث" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("names the back control in English", () => {
    renderRegister({ shell: true, language: "en" });
    expect(screen.getByRole("link", { name: "Back to Browse books" })).toHaveAttribute("href", "/login");
  });
});

describe("password toggles (P-08, S-02 c7 and c9)", () => {
  it("has one for each field, each showing and hiding only its own, named by the action and with no pressed state", async () => {
    const user = userEvent.setup();
    renderRegister();
    expect(toggles()).toHaveLength(2);
    for (const toggle of toggles()) {
      expect(toggle).toHaveClass("size-target");
      expect(toggle).not.toHaveAttribute("aria-pressed");
      expect(toggle.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    await user.type(passwordInput(), "a synthetic passphrase");
    await user.type(confirmationInput(), "another synthetic one");

    await user.click(toggles()[0] as HTMLElement);
    expect(passwordInput()).toHaveAttribute("type", "text");
    expect(passwordInput()).toHaveValue("a synthetic passphrase");
    expect(confirmationInput()).toHaveAttribute("type", "password");
    expect(toggles(AR.hide)).toHaveLength(1);
    expect(toggles(AR.show)).toHaveLength(1);

    await user.click(toggles()[0] as HTMLElement);
    expect(confirmationInput()).toHaveAttribute("type", "text");
    expect(confirmationInput()).toHaveValue("another synthetic one");
    expect(toggles(AR.hide)).toHaveLength(2);

    await user.click(toggles(AR.hide)[0] as HTMLElement);
    expect(passwordInput()).toHaveAttribute("type", "password");
  });
});

describe("validation timing (P-03): on blur of a field with content, never per keystroke", () => {
  it("does not check while the visitor types", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.type(usernameInput(), "a-");
    await settle();
    expect(usernameInput()).toHaveFocus();
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(AR.chars)).not.toBeInTheDocument();
  });

  it("raises nothing when an empty field loses focus", async () => {
    const user = userEvent.setup();
    const { container } = renderRegister();
    await user.click(usernameInput());
    for (let step = 0; step < 6; step += 1) await user.tab();
    await settle();
    expect(container.querySelector("[aria-invalid]")).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["an other character", "sample-user", AR.chars],
    ["a space", "sample user", AR.invisible],
    ["an invisible character", "sample\u200Buser", AR.invisible],
    ["fewer than three characters", "ab", AR.length],
    ["more than 24 characters", "a".repeat(25), AR.length],
  ])("checks the username when it loses focus: %s", async (_name, typed, message) => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(usernameInput());
    await user.paste(typed);
    await user.tab();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");
    expect(description(usernameInput())).toEqual([AR.usernameHelper, message]);
  });

  it("reports only the first failure of a username, in the order of the spec", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(usernameInput());
    await user.paste("a b-");
    await user.tab();
    expect(await screen.findByText(AR.invisible)).toBeInTheDocument();
    expect(screen.queryByText(AR.chars)).not.toBeInTheDocument();
    expect(screen.queryByText(AR.length)).not.toBeInTheDocument();
  });

  it("accepts Arabic letters and Arabic-Indic digits and says nothing", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(usernameInput());
    await user.paste("مستخدم_١٢٣");
    await user.tab();
    await settle();
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
  });

  it("clears the error of the username at its next blur, once it is fine", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(usernameInput());
    await user.paste("ab");
    await user.tab();
    await screen.findByText(AR.length);

    await user.click(usernameInput());
    await user.paste("c");
    await user.tab();
    await vi.waitFor(() => expect(usernameInput()).not.toHaveAttribute("aria-invalid"));
    expect(screen.queryByText(AR.length)).not.toBeInTheDocument();
  });

  it.each([
    ["too short", "short phrase", AR.passwordMin],
    ["over 72 bytes", "a".repeat(73), AR.passwordMax],
  ])("checks the password when it loses focus: %s", async (_name, typed, message) => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(passwordInput());
    await user.paste(typed);
    await user.tab();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
    expect(description(passwordInput())).toEqual([AR.passwordHelper, message]);
  });

  it("counts Arabic letters as two bytes and accepts 36 of them", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(passwordInput());
    await user.paste("ب".repeat(36));
    await user.tab();
    await settle();
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
    await user.click(passwordInput());
    await user.paste("ب");
    await user.tab();
    expect(await screen.findByText(AR.passwordMax)).toBeInTheDocument();
  });

  it("compares the confirmation with the password when the confirmation loses focus", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.type(passwordInput(), MOCK_PASSWORD);
    await user.type(confirmationInput(), `${MOCK_PASSWORD}!`);
    await user.tab();
    expect(await screen.findByText(AR.mismatch)).toBeInTheDocument();
    expect(confirmationInput()).toHaveAttribute("aria-invalid", "true");
    expect(description(confirmationInput())).toEqual([AR.mismatch]);
  });

  it("compares them again when the password loses focus, so a fixed password clears the mismatch and a changed one raises it", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.type(passwordInput(), MOCK_PASSWORD);
    await user.type(confirmationInput(), `${MOCK_PASSWORD}!`);
    await user.tab();
    await screen.findByText(AR.mismatch);

    await user.click(passwordInput());
    await user.type(passwordInput(), "!", { skipClick: true });
    await user.tab();
    await vi.waitFor(() => expect(confirmationInput()).not.toHaveAttribute("aria-invalid"));

    await user.click(passwordInput());
    await user.type(passwordInput(), "?", { skipClick: true });
    await user.tab();
    expect(await screen.findByText(AR.mismatch)).toBeInTheDocument();
  });

  it("does not ask for the confirmation while the password loses focus and the confirmation is still empty and untouched", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.type(passwordInput(), MOCK_PASSWORD);
    await user.tab();
    await settle();
    expect(confirmationInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(AR.needConfirmation)).not.toBeInTheDocument();
  });

  it("does not raise a summary from errors that blur alone has found, however many", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(usernameInput());
    await user.paste("ab");
    await user.click(passwordInput());
    await user.paste("short");
    await user.tab();
    await screen.findByText(AR.passwordMin);
    expect(screen.getByText(AR.length)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the message while a press that caused the blur is still down, so the button does not slide away, and shows it on release", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user);
    await user.click(usernameInput());
    await user.paste("!");
    await user.pointer({ keys: "[MouseLeft>]", target: submitButton() });
    await settle();
    // The username lost focus to the button, but its message waits for the pointer to come up.
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
    expect(backend.count(REGISTER)).toBe(0);

    await user.pointer({ keys: "[/MouseLeft]" });
    await vi.waitFor(() => expect(usernameInput()).toHaveAttribute("aria-invalid", "true"));
    // The click was delivered: the submit ran, found the error and moved focus to the field.
    expect(usernameInput()).toHaveFocus();
    expect(backend.count(REGISTER)).toBe(0);
  });
});

describe("validation on submit (P-03, S-02 sections 3 and 4)", () => {
  it("runs every rule, sends nothing, focuses the first invalid field and lists four errors in a summary", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await user.click(submitButton());

    expect(backend.count(REGISTER)).toBe(0);
    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent("يوجد ٤ أخطاء في النموذج");
    const links = within(summary).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([AR.needUsername, AR.needPassword, AR.needConfirmation, AR.consentRequired]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([usernameInput(), passwordInput(), confirmationInput(), consentBox()].map((field) => `#${field.id}`));

    for (const [field, message] of [
      [usernameInput(), AR.needUsername],
      [passwordInput(), AR.needPassword],
      [confirmationInput(), AR.needConfirmation],
      [consentBox(), AR.consentRequired],
    ] as const) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(description(field).at(-1)).toBe(message);
    }
    expect(usernameInput()).toHaveFocus();
  });

  it("puts the summary directly under the heading, before the lead", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(submitButton());
    const summary = screen.getByRole("alert");
    expect(follows(screen.getByRole("heading", { level: 1 }), summary)).toBe(true);
    expect(follows(summary, screen.getByText(AR.lead))).toBe(true);
  });

  it.each([
    [2, { username: "ab", consent: false }, "يوجد خطآن في النموذج"],
    [3, { username: "ab", password: "short", confirmation: "short", consent: false }, "يوجد ٣ أخطاء في النموذج"],
  ] as const)("titles the summary of %i errors in the Arabic form of the number", async (_count, values, title) => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, values);
    await user.click(submitButton());
    expect(screen.getByRole("alert")).toHaveTextContent(title);
  });

  it("lets a link of the summary move focus to its field, the box included", async () => {
    const user = userEvent.setup();
    renderRegister();
    await user.click(submitButton());
    await user.click(screen.getByRole("link", { name: AR.needConfirmation }));
    expect(confirmationInput()).toHaveFocus();
    await user.click(screen.getByRole("link", { name: AR.consentRequired }));
    expect(consentBox()).toHaveFocus();
  });

  it("shows no summary for one error: the field is announced through its description, and focus goes to it", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user, { consent: false });
    await user.click(submitButton());

    expect(backend.count(REGISTER)).toBe(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(consentBox()).toHaveAttribute("aria-invalid", "true");
    expect(consentBox()).toHaveFocus();
    expect(description(consentBox())).toEqual([AR.consentRequired]);
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
  });

  it("marks the box with the error recipe: a red border and the message with its glyph below the row", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { consent: false });
    await user.click(submitButton());
    expect(consentBox().parentElement).toHaveClass("border-error-edge");
    const message = screen.getByText(AR.consentRequired);
    expect(message).toHaveClass("text-error-ink");
    expect(message.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(follows(consentBox(), message)).toBe(true);
  });

  it("clears the box error as soon as the box is ticked", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { consent: false });
    await user.click(submitButton());
    await user.click(consentBox());
    expect(consentBox()).toBeChecked();
    expect(consentBox()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(AR.consentRequired)).not.toBeInTheDocument();
  });

  it("names the confirmation as missing, not as a mismatch, when it is empty at submit", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { confirmation: "" });
    await user.click(submitButton());
    expect(screen.getByText(AR.needConfirmation, { selector: "p" })).toBeInTheDocument();
    expect(confirmationInput()).toHaveFocus();
  });

  it("keeps an error while the field is still empty at blur, and clears everything at the next good submit", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await user.click(submitButton());
    await user.click(usernameInput());
    await user.tab();
    await settle();
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");

    await fill(user);
    await user.click(submitButton());
    await vi.waitFor(() => expect(backend.count(REGISTER)).toBe(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never trims: a password of fifteen spaces is a password and goes as typed, a username with a space is an error", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user, { username: "sample user", password: " ".repeat(15) });
    await user.click(submitButton());
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(AR.invisible, { selector: "p" })).toBeInTheDocument();
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
    expect(backend.count(REGISTER)).toBe(0);

    await user.clear(usernameInput());
    await user.type(usernameInput(), "sample_user");
    await user.click(submitButton());
    await vi.waitFor(() => expect(backend.count(REGISTER)).toBe(1));
    expect(backend.calls.find((call) => call.key === REGISTER)?.body).toMatchObject({ username: "sample_user", password: " ".repeat(15) });
  });

  it("never shows a typed value back in a message", async () => {
    const user = userEvent.setup();
    const { container } = renderRegister();
    await fill(user, { username: "sample-user-xyz", password: "short-secret", confirmation: "other-secret", consent: false });
    await user.click(submitButton());
    expect(container.textContent).not.toContain("xyz");
    expect(container.textContent).not.toContain("secret");
  });

  it("words the summary and the messages in English with Western digits", async () => {
    const user = userEvent.setup();
    renderRegister({ language: "en" });
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent("There are 4 errors in the form");
    for (const message of ["Enter a username.", "Enter a password.", "Confirm the password.", "You must agree to the terms of use and privacy statement to create an account."]) {
      expect(screen.getByRole("link", { name: message })).toBeInTheDocument();
    }
  });
});

describe("submitting E03 and the exit to S-04 (S-02 section 1)", () => {
  it("sends the six fields of the contract as JSON to the same origin, once, with the language of the page and the zone of the browser", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());

    const sent = backend.calls.filter((call) => call.key === REGISTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      username: "fresh_user_01",
      password: MOCK_PASSWORD,
      timeZone: "Asia/Dubai",
      language: "ar",
      termsAccepted: true,
      termsVersion: "2026-10-04",
    });
    expect(sent[0]?.init?.credentials).toBe("same-origin");
    const headers = sent[0]?.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("sends the language that is on the page when it is English", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister({ language: "en" });
    await user.type(screen.getByLabelText("Username"), "fresh_user_01");
    await user.type(screen.getByLabelText("Password"), MOCK_PASSWORD);
    await user.type(screen.getByLabelText("Confirm password"), MOCK_PASSWORD);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.calls.find((call) => call.key === REGISTER)?.body).toMatchObject({ language: "en" });
  });

  it("sends an empty version when the build has none, and lets the server say so", async () => {
    config.termsVersion = null;
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user);
    await user.click(submitButton());
    // The mock asks for 2026-10-04; this build was shown none, so it asks for a reload instead of guessing.
    expect(await screen.findByText(AR.termsUpdated)).toBeInTheDocument();
    expect(backend.calls.find((call) => call.key === REGISTER)?.body).toMatchObject({ termsVersion: "" });
  });

  it("goes to the recovery-code screen by replace, hands the code over in memory, wipes the fields, and keeps the button busy while it opens", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code"));

    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(peekRecoveryCode()).toEqual({ code: MOCK_RECOVERY_CODE, host: "register" });
    expect([usernameInput().value, passwordInput().value, confirmationInput().value]).toEqual(["", "", ""]);
    expect(submitButton()).toHaveAttribute("aria-busy", "true");
    expect(readRegisterDraft()).toBeNull();
  });

  it("never shows the code, the profile or any message on success, and stores nothing in the browser", async () => {
    const user = userEvent.setup();
    const { container } = renderRegister();
    // The helper stored the language to set the scene; from here on the screen may store nothing.
    localStorage.clear();
    await fill(user);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(container.textContent).not.toContain(MOCK_RECOVERY_CODE.slice(0, 9));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(window.location.href).not.toContain("0123");
  });

  it("is sent by Enter in the confirmation field and in the box", async () => {
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user, { consent: false });
    await user.type(confirmationInput(), "{Enter}", { skipClick: true });
    expect(backend.count(REGISTER)).toBe(0);
    expect(consentBox()).toHaveFocus();

    await user.keyboard(" ");
    expect(consentBox()).toBeChecked();
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(backend.count(REGISTER)).toBe(1));
  });

  it("does not send when the visitor leaves the page while the answer is on its way: the draft is gone and no code is kept for a screen nobody opens", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const backend = makeBackend({ [REGISTER]: () => gate.promise });
    const { unmount } = renderRegister({ backend });
    await fill(user);
    saveRegisterDraft({ username: "x", password: "y", confirmation: "z", consent: true });
    await user.click(submitButton());
    unmount();
    gate.resolve(jsonResponse({ profile: {}, recoveryCode: MOCK_RECOVERY_CODE }, 201));
    await settle();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).toBeNull();
    expect(readRegisterDraft()).toBeNull();
  });
});

describe("the submitting state (S-02 section 4)", () => {
  it("shows the loading button, announces it politely, keeps the fields, keeps focus, and ignores a second press and Enter", async () => {
    const user = userEvent.setup();
    const gate = deferred<Response>();
    const backend = makeBackend({ [REGISTER]: () => gate.promise });
    renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());

    const button = submitButton();
    expect(button).toHaveTextContent("جارٍ إنشاء الحساب…");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    expect(button.querySelector("span[aria-hidden=true]")).toHaveClass("animate-spin");
    expect(politeRegion(AR.submitting)).toHaveAttribute("aria-live", "polite");
    expect(usernameInput()).toHaveValue("fresh_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
    expect(confirmationInput()).toHaveValue(MOCK_PASSWORD);
    expect(consentBox()).toBeChecked();

    await user.click(button);
    await user.type(confirmationInput(), "{Enter}", { skipClick: true });
    expect(backend.count(REGISTER)).toBe(1);

    gate.resolve(jsonResponse({ profile: {}, recoveryCode: MOCK_RECOVERY_CODE }, 201));
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code"));
  });

  it("says it is still working after 5 s, as a polite line, and takes the line away when the answer comes", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const gate = deferred<Response>();
    renderRegister({ backend: makeBackend({ [REGISTER]: () => gate.promise }) });
    await fill(user);
    await user.click(submitButton());

    await advance(4_900);
    expect(screen.queryByText(AR.processing)).not.toBeInTheDocument();
    await advance(200);
    expect(politeRegion(AR.processing)).toHaveAttribute("aria-live", "polite");
    expect(submitButton()).toHaveAttribute("aria-busy", "true");

    gate.resolve(jsonResponse(envelope("internal"), 500));
    await flush();
    expect(screen.queryByText(AR.processing)).not.toBeInTheDocument();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
  });
});

describe("E03 errors (S-02 section 3, P-06, P-07, P-10)", () => {
  it("username_taken: a field error at the username, the values kept, the username focused, no banner and no summary", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "taken_user_01" });
    await user.click(submitButton());

    expect(await screen.findByText(AR.taken)).toBeInTheDocument();
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");
    expect(usernameInput()).toHaveFocus();
    expect(description(usernameInput())).toEqual([AR.usernameHelper, AR.taken]);
    expect(usernameInput()).toHaveValue("taken_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
    expect(confirmationInput()).toHaveValue(MOCK_PASSWORD);
    expect(consentBox()).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(AR.takenHint)).not.toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
  });

  it("clears a taken name when the username is edited, and not when the field only loses focus", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "taken_user_01" });
    await user.click(submitButton());
    await screen.findByText(AR.taken);

    await user.click(usernameInput());
    await user.tab();
    await settle();
    expect(screen.getByText(AR.taken)).toBeInTheDocument();

    await user.click(usernameInput());
    await user.type(usernameInput(), "2", { skipClick: true });
    expect(screen.queryByText(AR.taken)).not.toBeInTheDocument();
    expect(usernameInput()).not.toHaveAttribute("aria-invalid");
  });

  it("validation_error from the server: the username rule at the username, with the message of the spec", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      [REGISTER]: () => jsonResponse(envelope("validation_error", { fields: [{ field: "username", rule: "username_length" }] }), 422),
    });
    renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    expect(await screen.findByText(AR.length)).toBeInTheDocument();
    expect(usernameInput()).toHaveFocus();
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("validation_error from the server: a password rule at the password, focused", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      [REGISTER]: () => jsonResponse(envelope("validation_error", { fields: [{ field: "password", rule: "password_max_bytes" }] }), 422),
    });
    renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    expect(await screen.findByText(AR.passwordMax)).toBeInTheDocument();
    expect(passwordInput()).toHaveFocus();
    expect(passwordInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("validation_error from the server for both fields: two errors, so the summary comes, in the Arabic dual", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      [REGISTER]: () =>
        jsonResponse(
          envelope("validation_error", {
            fields: [
              { field: "username", rule: "username_chars" },
              { field: "password", rule: "password_min_chars" },
            ],
          }),
          422,
        ),
    });
    renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("يوجد خطآن في النموذج");
    expect(within(summary).getAllByRole("link").map((link) => link.textContent)).toEqual([AR.chars, AR.passwordMin]);
    expect(usernameInput()).toHaveFocus();
  });

  it.each(["time_zone_invalid", "language_invalid", "forbidden_field"])("validation_error %s cannot be fixed by the learner and shows as an unexpected error", async (rule) => {
    const user = userEvent.setup();
    const backend = makeBackend({ [REGISTER]: () => jsonResponse(envelope("validation_error", { fields: [{ field: "x", rule }] }), 422) });
    const { container } = renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(container.querySelector("[aria-invalid]")).toBeNull();
    expect(submitButton()).toHaveFocus();
  });

  describe("terms_required (O-09)", () => {
    it("another version than this build shows: an error banner with a reload button, the values kept, no field error", async () => {
      const user = userEvent.setup();
      renderRegister();
      await fill(user, { username: "terms_user_01" });
      await user.click(submitButton());

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(AR.termsUpdated);
      expect(follows(passwordInput(), alert)).toBe(true);
      expect(follows(alert, submitButton())).toBe(true);
      await user.click(within(alert).getByRole("button", { name: AR.reload }));
      expect(browser.reloadPage).toHaveBeenCalledTimes(1);
      expect(consentBox()).not.toHaveAttribute("aria-invalid");
      expect(usernameInput()).toHaveValue("terms_user_01");
      expect(consentBox()).toBeChecked();
    });

    it("the version this build shows: the error is at the box, which takes focus", async () => {
      const user = userEvent.setup();
      const backend = makeBackend({ [REGISTER]: () => jsonResponse(envelope("terms_required", { requiredVersion: "2026-10-04" }), 400) });
      renderRegister({ backend });
      await fill(user);
      await user.click(submitButton());
      expect(await screen.findByText(AR.consentRequired)).toBeInTheDocument();
      expect(consentBox()).toHaveAttribute("aria-invalid", "true");
      expect(consentBox()).toHaveFocus();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("500: a generic alert, the values kept, focus on the button", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "internal_user_01" });
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(usernameInput()).toHaveValue("internal_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
    expect(submitButton()).toHaveFocus();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
  });

  it("503: a warning in the polite status area, not an alert", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "unavailable_user_01" });
    await user.click(submitButton());
    expect(await screen.findByText(AR.unavailable)).toBeInTheDocument();
    expect(politeRegion(AR.unavailable)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submitButton()).toHaveFocus();
  });

  it("403 forbidden origin: an alert with a reload button that reloads the page", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "origin_user_01" });
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.origin);
    await user.click(within(alert).getByRole("button", { name: AR.reload }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("treats a code it has no copy for as an unexpected error", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({ [REGISTER]: () => jsonResponse(envelope("something_new"), 418) });
    renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
  });

  it("never shows the message of the API, a status code or any submitted value", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({
      [REGISTER]: () => jsonResponse({ error: { code: "internal", message: "Database exploded for fresh_user_01", details: {} } }, 500),
    });
    const { container } = renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    await screen.findByRole("alert");
    expect(container.textContent).not.toContain("exploded");
    expect(container.textContent).not.toContain("500");
    expect(container.textContent).not.toContain(MOCK_PASSWORD);
  });

  it("replaces the earlier banner with the next one", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "internal_user_01" });
    await user.click(submitButton());
    await screen.findByRole("alert");
    await user.clear(usernameInput());
    await user.type(usernameInput(), "origin_user_01");
    await user.click(submitButton());
    expect(await screen.findByText(AR.origin)).toBeInTheDocument();
    expect(screen.queryByText(AR.internal)).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("puts the banner above the submit button and below the fields and the notice", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "internal_user_01" });
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(follows(confirmationInput(), alert)).toBe(true);
    expect(follows(screen.getByText(AR.notice), alert)).toBe(true);
    expect(follows(screen.getByRole("link", { name: "بيان الخصوصية" }), alert)).toBe(true);
    expect(follows(alert, submitButton())).toBe(true);
  });
});

describe("an uncertain outcome (P-10)", () => {
  const silentThenTaken = () => {
    let attempt = 0;
    return makeBackend({
      [REGISTER]: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return jsonResponse(envelope("username_taken"), 409);
      },
    });
  };

  it("a send that gets no answer shows a warning that says so and offers the safe path, with the values kept and focus on the button", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "silent_user_01" });
    await user.click(submitButton());

    const banner = await screen.findByText(AR.uncertain);
    expect(politeRegion(AR.uncertain)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(follows(confirmationInput(), banner)).toBe(true);
    expect(follows(banner, submitButton())).toBe(true);
    expect(usernameInput()).toHaveValue("silent_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
    expect(submitButton()).toHaveFocus();
    expect(submitButton()).not.toHaveAttribute("aria-busy");
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("is not resent on its own, and the button is the retry", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const backend = makeBackend({
      [REGISTER]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderRegister({ backend });
    await fill(user);
    await user.click(submitButton());
    await flush();
    expect(screen.getByText(AR.uncertain)).toBeInTheDocument();
    await advance(60_000);
    expect(backend.count(REGISTER)).toBe(1);
    await user.click(submitButton());
    await flush();
    expect(backend.count(REGISTER)).toBe(2);
  });

  it("shows the wake-up line beside it when the server does not answer either, the line first", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const backend = makeBackend({
      [REGISTER]: () => {
        throw new TypeError("Failed to fetch");
      },
      "GET /api/health": () => new Response("<html>asleep</html>", { status: 502 }),
    });
    renderRegister({ backend });
    await fill(user, { username: "silent_user_01" });
    await user.click(submitButton());
    await flush();

    const waking = screen.getByText(AR.waking);
    const uncertain = screen.getByText(AR.uncertain);
    expect(follows(waking, uncertain)).toBe(true);
    expect(follows(uncertain, submitButton())).toBe(true);
    expect(waking.closest("[role=status]")).toBe(uncertain.closest("[role=status]"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the offline notice beside it when the browser is offline, the notice first", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "silent_user_01" });
    await user.click(submitButton());
    const uncertain = await screen.findByText(AR.uncertain);
    expect(follows(screen.getByText(AR.offline), uncertain)).toBe(true);
  });

  it("a taken name on the next attempt carries the hint and a link to the login screen, which the attempt after it does not", async () => {
    const user = userEvent.setup();
    renderRegister({ backend: silentThenTaken() });
    await fill(user);
    await user.click(submitButton());
    await screen.findByText(AR.uncertain);

    await user.click(submitButton());
    const hint = await screen.findByText(AR.takenHint);
    expect(screen.getByText(AR.taken)).toBeInTheDocument();
    expect(description(usernameInput())).toEqual([AR.usernameHelper, AR.taken, expect.stringContaining(AR.takenHint)]);
    const block = hint.parentElement as HTMLElement;
    expect(within(block).getByRole("link", { name: AR.login })).toHaveAttribute("href", "/login");
    expect(screen.queryByText(AR.uncertain)).not.toBeInTheDocument();

    await user.click(submitButton());
    await vi.waitFor(() => expect(screen.queryByText(AR.takenHint)).not.toBeInTheDocument());
    expect(screen.getByText(AR.taken)).toBeInTheDocument();
  });

  it("takes the hint away when the username is edited", async () => {
    const user = userEvent.setup();
    renderRegister({ backend: silentThenTaken() });
    await fill(user);
    await user.click(submitButton());
    await screen.findByText(AR.uncertain);
    await user.click(submitButton());
    await screen.findByText(AR.takenHint);

    await user.type(usernameInput(), "2", { skipClick: true });
    expect(screen.queryByText(AR.takenHint)).not.toBeInTheDocument();
    expect(screen.queryByText(AR.taken)).not.toBeInTheDocument();
  });

  it("a taken name after an ordinary first answer carries no hint", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "taken_user_01" });
    await user.click(submitButton());
    await screen.findByText(AR.taken);
    expect(screen.queryByText(AR.takenHint)).not.toBeInTheDocument();
  });

  it("words the warning and the hint in English", async () => {
    const user = userEvent.setup();
    renderRegister({ language: "en", backend: silentThenTaken() });
    await user.type(screen.getByLabelText("Username"), "fresh_user_01");
    await user.type(screen.getByLabelText("Password"), MOCK_PASSWORD);
    await user.type(screen.getByLabelText("Confirm password"), MOCK_PASSWORD);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("We could not confirm that the account was created. If it was, log in with your username and password and create a new recovery code in Settings; otherwise try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("If you created this account a moment ago, log in instead.")).toBeInTheDocument();
    expect(screen.getByText("This username is not available. Choose another.")).toBeInTheDocument();
  });
});

describe("throttle (P-06)", () => {
  async function throttle(username: string) {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const view = renderRegister();
    await fill(user, { username });
    await user.click(submitButton());
    await flush();
    return { user, ...view };
  }

  it("up to a minute: a warning with the wait in seconds, a button that is aria-disabled but focusable and tied to the banner", async () => {
    await throttle("throttled_user_01");
    const banner = screen.getByText(AR.throttle20);
    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
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
    await advance(1_000);
    expect(line).toHaveTextContent("٠٠:١٩");
    expect(screen.getByText(AR.throttle20)).toBeInTheDocument();

    await user.click(submitButton());
    await user.type(confirmationInput(), "{Enter}", { skipClick: true });
    await flush();
    expect(backend.count(REGISTER)).toBe(1);
    expect(submitButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("re-enables the button at zero, takes the banner away, announces «you can try again now», and leaves focus where it was", async () => {
    await throttle("throttled_user_01");
    submitButton().focus();
    await advance(19_000);
    expect(submitButton()).toHaveAttribute("aria-disabled", "true");
    await advance(1_000);

    expect(submitButton()).not.toHaveAttribute("aria-disabled");
    expect(submitButton()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(AR.throttle20)).not.toBeInTheDocument();
    const status = politeRegion(AR.again);
    expect(status).toHaveClass("sr-only");
    expect(submitButton()).toHaveFocus();
    expect(document.querySelector("p[aria-hidden=true] bdi")).toBeNull();
  });

  it("the 15-minute lock: the banner counts in mm:ss, left to right", async () => {
    await throttle("locked_user_01");
    const banner = screen.getByText(/محاولات كثيرة\. يمكنك المحاولة بعد/);
    expect(banner).toHaveTextContent("محاولات كثيرة. يمكنك المحاولة بعد ١٥:٠٠.");
    expect(banner.querySelector("bdi")).toHaveAttribute("dir", "ltr");
  });

  it("keeps every value for the retry", async () => {
    await throttle("throttled_user_01");
    expect(usernameInput()).toHaveValue("throttled_user_01");
    expect(passwordInput()).toHaveValue(MOCK_PASSWORD);
    expect(confirmationInput()).toHaveValue(MOCK_PASSWORD);
    expect(consentBox()).toBeChecked();
  });
});

describe("wake-up (P-04) and connectivity (P-05)", () => {
  it("a send that gets no answer shows the wake-up line above the button and announces readiness once the server answers", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    renderRegister({
      backend: makeBackend({
        [REGISTER]: () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    });
    await fill(user);
    await user.click(submitButton());
    await flush();
    const line = screen.getByText(AR.waking);
    expect(politeRegion(AR.waking)).toHaveAttribute("aria-live", "polite");
    expect(follows(line, submitButton())).toBe(true);
    expect(follows(confirmationInput(), line)).toBe(true);

    await advance(1_000);
    expect(screen.queryByText(AR.waking)).not.toBeInTheDocument();
    expect(politeRegion(AR.ready)).toHaveClass("sr-only");
  });

  it("shows the offline notice when the browser reports no connection, before any press, and never disables the button", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderRegister();
    expect(politeRegion(AR.offline)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
  });

  it("raises the notice on the offline event and removes it on the online event with a polite «the connection is back»", () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    renderRegister();
    expect(screen.queryByText(AR.offline)).not.toBeInTheDocument();
    onLine.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(AR.offline)).toBeInTheDocument();
    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(AR.offline)).not.toBeInTheDocument();
    expect(politeRegion(AR.back)).toHaveClass("sr-only");
  });

  it("still sends the form while the browser says it is offline: the flag is only a hint", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const user = userEvent.setup();
    const { backend } = renderRegister();
    await fill(user);
    await user.click(submitButton());
    await vi.waitFor(() => expect(backend.count(REGISTER)).toBe(1));
  });

  it("words the notices in English", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderRegister({ language: "en" });
    expect(screen.getByText("There is no network connection. Check your connection and try again.")).toBeInTheDocument();
  });
});

describe("opening S-03 keeps the form (S-02 Dialogs)", () => {
  const LINKS = [AR.termsLink, "شروط الاستخدام", "بيان الخصوصية"];

  it.each(LINKS)("keeps the typed values, the passwords and the box in memory when the link «%s» is pressed", async (name) => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { username: "sample_user", password: "first synthetic phrase", confirmation: "second synthetic phrase" });
    await user.click(screen.getByRole("link", { name }));
    expect(readRegisterDraft()).toEqual({ username: "sample_user", password: "first synthetic phrase", confirmation: "second synthetic phrase", consent: true });
  });

  it("keeps nothing before a link is pressed: typing, blurring and a failed submit leave the draft empty", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user);
    await user.click(submitButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(readRegisterDraft()).toBeNull();
  });

  it("puts the values back when the form is shown again, with the passwords hidden and no error", () => {
    saveRegisterDraft({ username: "sample_user", password: "first synthetic phrase", confirmation: "second synthetic phrase", consent: true });
    const { container } = renderRegister();
    expect(usernameInput()).toHaveValue("sample_user");
    expect(passwordInput()).toHaveValue("first synthetic phrase");
    expect(passwordInput()).toHaveAttribute("type", "password");
    expect(confirmationInput()).toHaveValue("second synthetic phrase");
    expect(consentBox()).toBeChecked();
    expect(container.querySelector("[aria-invalid]")).toBeNull();
  });

  it("puts back an unticked box as unticked", () => {
    saveRegisterDraft({ username: "sample_user", password: "", confirmation: "", consent: false });
    renderRegister();
    expect(usernameInput()).toHaveValue("sample_user");
    expect(consentBox()).not.toBeChecked();
  });

  it("goes round the whole way: open S-03, come back, and the account can be made without typing again", async () => {
    const user = userEvent.setup();
    const first = renderRegister();
    await fill(user);
    await user.click(screen.getByRole("link", { name: "بيان الخصوصية" }));
    first.unmount();
    runtime.wakeUp.dispose();

    const second = renderRegister();
    await user.click(submitButton());
    await vi.waitFor(() => expect(second.backend.count(REGISTER)).toBe(1));
    expect(second.backend.calls.find((call) => call.key === REGISTER)?.body).toMatchObject({ username: "fresh_user_01", password: MOCK_PASSWORD });
    await vi.waitFor(() => expect(readRegisterDraft()).toBeNull());
  });

  it("never reaches the browser's storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderRegister();
    setItem.mockClear();
    await fill(user, { password: "first synthetic secret" });
    await user.click(screen.getByRole("link", { name: AR.termsLink }));
    expect(setItem).not.toHaveBeenCalled();
    expect(Object.keys(localStorage)).toEqual([LOCALE_STORAGE_KEY]);
    expect(JSON.stringify(window.history.state)).not.toContain("secret");
  });
});

describe("the language switch and the form (P-02)", () => {
  it("keeps every typed value, words the form in English and flips the direction, with the messages rewritten", async () => {
    const user = userEvent.setup();
    renderRegister({ shell: true });
    await fill(user, { username: "sample_user", password: "short", confirmation: "", consent: false });
    await user.click(submitButton());
    expect(screen.getByRole("alert")).toHaveTextContent("يوجد ٣ أخطاء في النموذج");

    await user.click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(document.documentElement.dir).toBe("ltr");
    expect(screen.getByLabelText("Username")).toHaveValue("sample_user");
    expect(screen.getByLabelText("Password")).toHaveValue("short");
    expect(screen.getByRole("alert")).toHaveTextContent("There are 3 errors in the form");
    expect(screen.getByText("The password must be at least 15 characters.", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("You must agree to the terms of use and privacy statement to create an account.", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("radio", { name: "English (EN)" })).toHaveFocus();
  });
});

describe("guard 2: a valid session leaves the form (UI-design 2.3)", () => {
  it("sends a signed-in visitor with a plan to /today", async () => {
    renderRegister({ backend: makeBackend({}, { signedIn: true, hasPlan: true }) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("sends a signed-in visitor without a plan to /start", async () => {
    renderRegister({ backend: makeBackend({}, { signedIn: true, hasPlan: false }) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
  });

  it("leaves a visitor without a session on the form, and asks E01 first", async () => {
    const { backend } = renderRegister();
    await vi.waitFor(() => expect(backend.count("GET /api/me")).toBe(1));
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(backend.calls[0]?.key).toBe("GET /api/health");
  });
});

describe("keyboard and focus (S-02 section 5)", () => {
  it("tabs through the skip link, the back control, the switch, the terms link, the three fields with their toggles, the box, the two links, the button and the login link", async () => {
    const user = userEvent.setup();
    renderRegister({ shell: true });
    const expected = [
      screen.getByRole("link", { name: "انتقل إلى المحتوى" }),
      screen.getByRole("link", { name: "رجوع إلى تصفّح الكتب" }),
      screen.getByRole("radio", { name: "العربية" }),
      screen.getByRole("link", { name: AR.termsLink }),
      usernameInput(),
      passwordInput(),
      toggles()[0],
      confirmationInput(),
      toggles()[1],
      consentBox(),
      screen.getByRole("link", { name: "شروط الاستخدام" }),
      screen.getByRole("link", { name: "بيان الخصوصية" }),
      submitButton(),
      screen.getByRole("link", { name: AR.login }),
    ] as HTMLElement[];
    for (const [index, element] of expected.entries()) {
      await user.tab();
      expect(element, `stop ${index}`).toHaveFocus();
    }
  });

  it("has no autofocus on the first load, and Escape does nothing", async () => {
    const user = userEvent.setup();
    renderRegister();
    expect(document.body).toHaveFocus();
    await user.click(usernameInput());
    await user.keyboard("{Escape}");
    expect(usernameInput()).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses the first invalid field after a failed submit, not the first field", async () => {
    const user = userEvent.setup();
    renderRegister();
    await fill(user, { password: "", confirmation: "" });
    await user.click(submitButton());
    expect(passwordInput()).toHaveFocus();
  });
});
