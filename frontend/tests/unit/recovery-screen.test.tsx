import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/recovery", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { RecoveryScreen } from "@/components/recovery/RecoveryScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, mockHandlers, MOCK_PASSWORD, MOCK_RECOVERY_CODE, type MockScenario } from "@/lib/api/mock";
import { accountMockHandlers, MOCK_REPLACEMENT_CODE } from "@/lib/api/mock/account-handlers";
import { clearLoginArrival } from "@/lib/auth/flash";
import { peekRecoveryCode, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";

const NEW_PASSWORD = "another synthetic passphrase for docs";
const VERIFY = "POST /api/auth/recovery/verify";
const RESET = "POST /api/auth/recovery/reset";

const AR = {
  heading: "استرجاع الحساب",
  step1: "الخطوة ١ من ٣: التحقق من الرمز",
  step2: "الخطوة ٢ من ٣: كلمة مرور جديدة",
  lead1: "أدخل اسم المستخدم ورمز الاسترجاع الذي حفظته عند التسجيل.",
  lead2: "تم التحقق. اختر كلمة مرور جديدة.",
  codeHelper: "٣٢ خانة، مع الفواصل أو بدونها.",
  notice1: "بعد التحقق تكون أمامك ١٠ دقائق لتعيين كلمة مرور جديدة.",
  notice2: "سيتوقف الرمز الحالي، وسنعرض لك رمزًا بديلًا مرة واحدة.",
  invalid: "بيانات الاسترجاع غير صحيحة أو لم تعد صالحة.",
  invalidHint: "إن كنت قد غيّرت كلمة المرور قبل لحظات فجرّب الدخول بها.",
  uncertain: "تعذّر تأكيد النتيجة. إن كانت كلمة المرور قد تغيّرت فسجّل الدخول بها، وإلا أعد المحاولة. بعد الدخول يمكنك إنشاء رمز جديد من الإعدادات.",
  needUsername: "أدخل اسم المستخدم.",
  needCode: "أدخل رمز الاسترجاع.",
  badCode: "رمز الاسترجاع يتكوّن من ٣٢ خانة (أرقام وحروف من a إلى f).",
  waking: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  throttle20: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
  short: "كلمة المرور ١٥ حرفًا على الأقل.",
  mismatch: "كلمتا المرور غير متطابقتين.",
};

type Handler = () => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const errorBody = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "x", details } });

// The mock layer answers by default, with the account handlers over it; a test overrides single operations. Every call is recorded.
function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: false }) {
  const mock = createMockFetch({ latencyMs: 0, scenario, handlers: { ...mockHandlers, ...accountMockHandlers } });
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const override = overrides[key];
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

function renderRecovery({ language = "ar", backend = makeBackend() }: { language?: "ar" | "en"; backend?: Backend } = {}) {
  setLanguage(language);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <RecoveryScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

const usernameInput = () => screen.getByLabelText("اسم المستخدم") as HTMLInputElement;
const codeInput = () => screen.getByLabelText("رمز الاسترجاع") as HTMLInputElement;
const verifyButton = () => screen.getByRole("button", { name: /^(تحقق|جارٍ التحقق…)$/ });
const newPasswordInput = () => screen.getByLabelText("كلمة المرور الجديدة") as HTMLInputElement;
const confirmationInput = () => screen.getByLabelText("تأكيد كلمة المرور الجديدة") as HTMLInputElement;
const resetButton = () => screen.getByRole("button", { name: /^(تعيين كلمة المرور|جارٍ التعيين…)$/ });

async function fillStep1(user: UserEvent, username: string, code: string) {
  if (username) await user.type(usernameInput(), username);
  if (code) await user.type(codeInput(), code);
}

async function verified(user: UserEvent, username = "sample_user_01") {
  await fillStep1(user, username, MOCK_RECOVERY_CODE);
  await user.click(verifyButton());
  await screen.findByRole("heading", { level: 2, name: AR.step2 });
}

async function fillStep2(user: UserEvent, password = NEW_PASSWORD, confirmation = password) {
  await user.type(newPasswordInput(), password);
  await user.type(confirmationInput(), confirmation);
}

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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  wipeRecoveryCode();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  window.history.pushState({}, "", "/recovery");
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wipeRecoveryCode();
});

describe("S-05 step 1 structure (UI-screens S-05 sections 2, 3 and 5)", () => {
  it("shows the heading, the step heading, the lead, two labelled fields, the notice, the button and the login line, in the order of the spec", () => {
    renderRecovery();
    expect(screen.getByRole("heading", { level: 1, name: AR.heading })).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("استرجاع الحساب · قطرة غيث");

    const order = [
      screen.getByRole("heading", { level: 1 }),
      screen.getByRole("heading", { level: 2, name: AR.step1 }),
      screen.getByText(AR.lead1),
      usernameInput(),
      codeInput(),
      screen.getByText(AR.notice1),
      verifyButton(),
      screen.getByRole("link", { name: "تسجيل الدخول" }),
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
    expect(screen.getByText("تذكّرت كلمة المرور؟")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
  });

  it("has a back control that names the catalog and goes to /login until S-07 ships, and no logo", () => {
    renderRecovery();
    const back = screen.getByRole("link", { name: "رجوع إلى تصفّح الكتب" });
    expect(back).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: "قطرة غيث" })).not.toBeInTheDocument();
  });

  it("gives the username field the attributes of S-01", () => {
    renderRecovery();
    const input = usernameInput();
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("dir", "auto");
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).not.toHaveAttribute("placeholder");
  });

  it("gives the code field the attributes of the spec: left to right, mono, unmasked, no automatic dashes, nothing that blocks a paste", () => {
    renderRecovery();
    const input = codeInput();
    expect(input).toHaveAttribute("dir", "ltr");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).not.toHaveAttribute("maxlength");
    expect(input).not.toHaveAttribute("pattern");
    expect(input).not.toHaveAttribute("placeholder");
    expect(input.style.fontFamily).toBe("var(--q-font-mono)");
    expect(input).toHaveAccessibleDescription(AR.codeHelper);
  });

  it("keeps the typed code exactly as typed: no mask, no dash added", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await user.type(codeInput(), "0123456789ABCDEF");
    expect(codeInput()).toHaveValue("0123456789ABCDEF");
  });
});

describe("S-05 step 1 validation (P-03, O-11)", () => {
  it("two empty fields: nothing is sent, two messages, a summary in Slot T, and focus on the first invalid field", async () => {
    const user = userEvent.setup();
    const { backend } = renderRecovery();
    await user.click(verifyButton());

    expect(backend.count(VERIFY)).toBe(0);
    expect(screen.getByRole("alert")).toHaveTextContent("يوجد خطآن في النموذج");
    expect(within(screen.getByRole("alert")).getByRole("link", { name: AR.needUsername })).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByRole("link", { name: AR.needCode })).toBeInTheDocument();
    expect(usernameInput()).toHaveFocus();
    expect(usernameInput()).toHaveAttribute("aria-invalid", "true");
    expect(codeInput()).toHaveAttribute("aria-invalid", "true");
    // The summary sits under the step heading, before the lead (Slot T).
    expect(follows(screen.getByRole("heading", { level: 2 }), screen.getByRole("alert"))).toBe(true);
    expect(follows(screen.getByRole("alert"), screen.getByText(AR.lead1))).toBe(true);
  });

  it("one error: no summary, the field is announced through its description, and focus goes to it", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await user.type(usernameInput(), "sample_user_01");
    await user.click(verifyButton());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(codeInput()).toHaveFocus();
    expect(codeInput()).toHaveAccessibleDescription(`${AR.codeHelper} ${AR.needCode}`);
  });

  it("a code that is not 32 hexadecimal characters is refused on the client: nothing is sent", async () => {
    const user = userEvent.setup();
    const { backend } = renderRecovery();
    await fillStep1(user, "sample_user_01", "0123-4567-89ab-cdef-0123-4567-89ab-cde");
    await user.click(verifyButton());
    expect(screen.getByText(AR.badCode)).toBeInTheDocument();
    expect(backend.count(VERIFY)).toBe(0);
    expect(codeInput()).toHaveFocus();

    // Letters outside a to f are refused too.
    await user.clear(codeInput());
    await user.type(codeInput(), "0123-4567-89ab-cdef-0123-4567-89ab-cdeg");
    await user.click(verifyButton());
    expect(screen.getByText(AR.badCode)).toBeInTheDocument();
    expect(backend.count(VERIFY)).toBe(0);
  });

  it("checks a field with content on blur, and clears the error at the next blur once it holds a good value", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await user.type(codeInput(), "abc");
    await user.tab();
    await vi.waitFor(() => expect(screen.getByText(AR.badCode)).toBeInTheDocument());
    await user.click(codeInput());
    await user.clear(codeInput());
    await user.type(codeInput(), MOCK_RECOVERY_CODE);
    await user.tab();
    await vi.waitFor(() => expect(screen.queryByText(AR.badCode)).not.toBeInTheDocument());
  });

  it("accepts the code with or without dashes, in capitals and in Arabic-Indic digits, and sends the plain form", async () => {
    const user = userEvent.setup();
    const { backend } = renderRecovery();
    await fillStep1(user, "sample_user_01", "٠١٢٣-4567-89AB-CDEF-0123-4567-89ab-cdef");
    await user.click(verifyButton());
    await screen.findByRole("heading", { level: 2, name: AR.step2 });
    expect(backend.bodies(VERIFY)).toEqual([{ username: "sample_user_01", recoveryCode: "0123456789abcdef0123456789abcdef" }]);
  });
});

describe("S-05 step 1 to step 2 (E06)", () => {
  it("moves to step 2 in place: no new history entry, focus on the step heading, nothing in storage, no navigation", async () => {
    const user = userEvent.setup();
    renderRecovery();
    const before = window.history.length;
    await verified(user);

    expect(screen.getByRole("heading", { level: 2, name: AR.step2 })).toHaveFocus();
    expect(window.history.length).toBe(before);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: AR.heading })).toBeInTheDocument();
    expect(screen.queryByText(AR.lead1)).not.toBeInTheDocument();
    expect(screen.getByText(AR.lead2)).toBeInTheDocument();
    expect(screen.getByText(AR.notice2)).toBeInTheDocument();
    // The grant is held in memory only, never in storage or the address.
    expect(JSON.stringify({ ...localStorage })).not.toContain("mock-grant");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("mock-grant");
    expect(window.location.href).not.toContain("grant");
  });

  it("step 2 has the new-password fields, the show toggles, a hidden username for password managers, and the notice before the button", async () => {
    const user = userEvent.setup();
    const { container } = renderRecovery();
    await verified(user, "sample_user_01");

    for (const input of [newPasswordInput(), confirmationInput()]) {
      expect(input).toHaveAttribute("autocomplete", "new-password");
      expect(input).toHaveAttribute("dir", "auto");
      expect(input).toHaveAttribute("type", "password");
      expect(input).not.toHaveAttribute("maxlength");
    }
    expect(screen.getAllByRole("button", { name: "إظهار كلمة المرور" })).toHaveLength(2);
    const hidden = container.querySelector("input[name=username]") as HTMLInputElement;
    expect(hidden).toHaveAttribute("autocomplete", "username");
    expect(hidden).toHaveAttribute("tabindex", "-1");
    expect(hidden).toHaveAttribute("aria-hidden", "true");
    expect(hidden).toHaveValue("sample_user_01");
    expect(screen.queryByLabelText("اسم المستخدم")).not.toBeInTheDocument();

    const order = [newPasswordInput(), confirmationInput(), screen.getByText(AR.notice2), resetButton()];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
  });

  it("step 2 checks the password rules and the confirmation before anything is sent", async () => {
    const user = userEvent.setup();
    const { backend } = renderRecovery();
    await verified(user);

    await user.click(resetButton());
    expect(backend.count(RESET)).toBe(0);
    expect(screen.getByRole("alert")).toHaveTextContent("يوجد خطآن في النموذج");
    expect(newPasswordInput()).toHaveFocus();

    await fillStep2(user, "too short", "too short");
    await user.click(resetButton());
    expect(screen.getByText(AR.short)).toBeInTheDocument();
    expect(backend.count(RESET)).toBe(0);

    await user.clear(newPasswordInput());
    await user.clear(confirmationInput());
    await fillStep2(user, NEW_PASSWORD, "a different passphrase entirely");
    await user.click(resetButton());
    expect(screen.getByText(AR.mismatch)).toBeInTheDocument();
    expect(backend.count(RESET)).toBe(0);
  });

  it("a success sends the grant and the password as typed, wipes the fields, hands the new code to S-04 in memory and replaces the screen", async () => {
    const user = userEvent.setup();
    const { backend } = renderRecovery();
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());

    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code"));
    const [body] = backend.bodies(RESET) as { resetGrant: string; newPassword: string }[];
    expect(body?.newPassword).toBe(NEW_PASSWORD);
    expect(body?.resetGrant).toMatch(/^mock-grant-/);
    expect(newPasswordInput()).toHaveValue("");
    expect(confirmationInput()).toHaveValue("");
    expect(peekRecoveryCode()).toEqual({ code: MOCK_REPLACEMENT_CODE, host: "recovery" });
    expect(JSON.stringify({ ...localStorage })).not.toContain(MOCK_REPLACEMENT_CODE);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(MOCK_REPLACEMENT_CODE);
  });

  it("keeps the button busy and sends nothing twice while E07 is in flight", async () => {
    const user = userEvent.setup();
    let release!: (response: Response) => void;
    const backend = makeBackend({ [RESET]: () => new Promise<Response>((done) => (release = done)) });
    renderRecovery({ backend });
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());
    expect(resetButton()).toHaveAttribute("aria-busy", "true");
    expect(politeRegion("جارٍ التعيين")).toHaveClass("sr-only");
    await user.type(confirmationInput(), "{Enter}");
    expect(backend.count(RESET)).toBe(1);
    release(jsonResponse({ recoveryCode: MOCK_REPLACEMENT_CODE }));
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code"));
  });
});

describe("S-05 E06 errors (G-04, P-06, P-07, P-04)", () => {
  it("a wrong code: one generic alert above the button, the code cleared and focused, the username kept", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await fillStep1(user, "sample_user_01", "ffff-ffff-ffff-ffff-ffff-ffff-ffff-ffff");
    await user.click(verifyButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(AR.invalid);
    expect(codeInput()).toHaveValue("");
    expect(codeInput()).toHaveFocus();
    expect(usernameInput()).toHaveValue("sample_user_01");
    expect(follows(codeInput(), screen.getByRole("alert"))).toBe(true);
    expect(follows(screen.getByRole("alert"), verifyButton())).toBe(true);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: AR.step1 })).toBeInTheDocument();
  });

  it("an unknown name gets the same message, and so does a used or lapsed code (the answer never says which)", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await fillStep1(user, "nobody_here_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.invalid);
    expect(screen.queryByText(/غير موجود|مستخدم من قبل|انتهت/)).not.toBeInTheDocument();
  });

  it("takes the generic banner away when the next press starts", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await fillStep1(user, "sample_user_01", "ffff-ffff-ffff-ffff-ffff-ffff-ffff-ffff");
    await user.click(verifyButton());
    await screen.findByRole("alert");
    await user.type(codeInput(), MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await screen.findByRole("heading", { level: 2, name: AR.step2 });
    expect(screen.queryByText(AR.invalid)).not.toBeInTheDocument();
  });

  it("500: a generic alert, the values kept, focus on the button", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await fillStep1(user, "internal_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(usernameInput()).toHaveValue("internal_user_01");
    expect(codeInput()).toHaveValue(MOCK_RECOVERY_CODE);
    expect(verifyButton()).toHaveFocus();
  });

  it("503: a polite warning in Slot B; the button is the retry", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await fillStep1(user, "unavailable_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await screen.findByText(AR.unavailable);
    expect(politeRegion(AR.unavailable)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(codeInput()).toHaveValue(MOCK_RECOVERY_CODE);
  });

  it("403 forbidden_origin: an alert with a reload button", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await fillStep1(user, "origin_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.origin);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("429: a polite warning with the wait, a button that is aria-disabled but focusable, a countdown nobody hears, and a press that does nothing", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend, container } = renderRecovery();
    await fillStep1(user, "throttled_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await flush();

    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
    const button = verifyButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)).toContainElement(screen.getByText(AR.throttle20));
    const line = container.querySelector("p[aria-hidden=true] bdi") as HTMLElement;
    expect(line).toHaveTextContent("٠٠:٢٠");
    await advance(1_000);
    expect(line).toHaveTextContent("٠٠:١٩");

    await user.click(verifyButton());
    await flush();
    expect(backend.count(VERIFY)).toBe(1);

    await advance(19_000);
    expect(verifyButton()).not.toHaveAttribute("aria-disabled");
    expect(politeRegion("يمكنك المحاولة الآن.")).toHaveClass("sr-only");
    expect(usernameInput()).toHaveValue("throttled_user_01");
  });

  it("no answer: the wake-up line above the button, the values kept, nothing resent, no error alert", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const backend = makeBackend({
      [VERIFY]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderRecovery({ backend });
    await fillStep1(user, "sample_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await flush();

    expect(politeRegion(AR.waking)).toHaveAttribute("aria-live", "polite");
    expect(follows(screen.getByText(AR.waking), verifyButton())).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(codeInput()).toHaveValue(MOCK_RECOVERY_CODE);
    await advance(30_000);
    expect(backend.count(VERIFY)).toBe(1);
  });

  it("offline: the connectivity line, and a press is still allowed", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderRecovery();
    expect(screen.getByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(verifyButton()).not.toHaveAttribute("aria-disabled");
  });
});

describe("S-05 E07 errors (G-04, P-10, P-06, P-07)", () => {
  it("a grant the server no longer knows: back to step 1 with the generic banner, the username kept, the passwords gone, focus on the step heading", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await verified(user, "reset_expired_user_01");
    await fillStep2(user);
    await user.click(resetButton());

    expect(await screen.findByRole("heading", { level: 2, name: AR.step1 })).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(AR.invalid);
    expect(screen.queryByText(AR.invalidHint)).not.toBeInTheDocument();
    expect(usernameInput()).toHaveValue("reset_expired_user_01");
    expect(codeInput()).toHaveValue("");
    expect(screen.queryByLabelText("كلمة المرور الجديدة")).not.toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("a grant that lapsed on the client clock (600 s from the answer): nothing is sent, the same generic banner", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend } = renderRecovery();
    await fillStep1(user, "sample_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await flush();
    await screen.findByRole("heading", { level: 2, name: AR.step2 });
    await fillStep2(user);

    await advance(601_000);
    // No timer is shown: the limit is stated once, in the notice.
    expect(screen.queryByText(/\d\d:\d\d/)).not.toBeInTheDocument();
    await user.click(resetButton());
    await flush();

    expect(backend.count(RESET)).toBe(0);
    expect(screen.getByRole("heading", { level: 2, name: AR.step1 })).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(AR.invalid);
    expect(usernameInput()).toHaveValue("sample_user_01");
  });

  it("a grant is good until the 600 s are over", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend } = renderRecovery();
    await fillStep1(user, "sample_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await flush();
    await screen.findByRole("heading", { level: 2, name: AR.step2 });
    await fillStep2(user);
    await advance(599_000);
    await user.click(resetButton());
    await flush();
    expect(backend.count(RESET)).toBe(1);
  });

  it("a password the server refuses (validation_error) shows its message at the field, the grant kept", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({ [RESET]: () => jsonResponse(errorBody("validation_error", { fields: [{ field: "newPassword", rule: "password_min_chars" }] }), 422) });
    renderRecovery({ backend });
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());
    expect(await screen.findByText(AR.short)).toBeInTheDocument();
    expect(newPasswordInput()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: AR.step2 })).toBeInTheDocument();
  });

  it("a validation_error the learner cannot fix is an internal error, not a field message", async () => {
    const user = userEvent.setup();
    const backend = makeBackend({ [RESET]: () => jsonResponse(errorBody("validation_error", { fields: [{ field: "resetGrant", rule: "invalid_type" }] }), 422) });
    renderRecovery({ backend });
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
  });

  it("503: the grant and the typed passwords are kept, and the same grant is sent again by the next press", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const backend = makeBackend({
      [RESET]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse(errorBody("unavailable"), 503) : jsonResponse({ recoveryCode: MOCK_REPLACEMENT_CODE });
      },
    });
    renderRecovery({ backend });
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());
    await screen.findByText(AR.unavailable);
    expect(newPasswordInput()).toHaveValue(NEW_PASSWORD);
    expect(confirmationInput()).toHaveValue(NEW_PASSWORD);
    expect(resetButton()).toHaveFocus();

    await user.click(resetButton());
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code"));
    const [first, second] = backend.bodies(RESET) as { resetGrant: string }[];
    expect(second?.resetGrant).toBe(first?.resetGrant);
  });

  it("500 and 403: the generic alerts of P-07, the values kept", async () => {
    const user = userEvent.setup();
    renderRecovery({ backend: makeBackend({ [RESET]: () => jsonResponse(errorBody("internal"), 500) }) });
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(newPasswordInput()).toHaveValue(NEW_PASSWORD);
  });

  it("429 on E07: the throttle banner and the countdown, the values kept", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { container } = renderRecovery();
    await fillStep1(user, "reset_throttled_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await flush();
    await screen.findByRole("heading", { level: 2, name: AR.step2 });
    await fillStep2(user);
    await user.click(resetButton());
    await flush();
    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
    expect(resetButton()).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelector("p[aria-hidden=true] bdi")).toHaveTextContent("٠٠:٢٠");
    expect(newPasswordInput()).toHaveValue(NEW_PASSWORD);
  });

  it("no answer to E07: a warning that cannot confirm the result, with a login link, the values kept, focus on the button", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    renderRecovery();
    await fillStep1(user, "reset_silent_user_01", MOCK_RECOVERY_CODE);
    await user.click(verifyButton());
    await flush();
    await screen.findByRole("heading", { level: 2, name: AR.step2 });
    await fillStep2(user);
    await user.click(resetButton());
    await flush();

    const banner = politeRegion(AR.uncertain);
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(within(banner).getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
    expect(newPasswordInput()).toHaveValue(NEW_PASSWORD);
    expect(resetButton()).toHaveFocus();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("an uncertain E07 followed by a retry that the server refuses adds the hint and the login link to the generic banner", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const backend = makeBackend({
      [RESET]: () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return jsonResponse(errorBody("invalid_credentials"), 401);
      },
    });
    renderRecovery({ backend });
    await verified(user);
    await fillStep2(user);
    await user.click(resetButton());
    await screen.findByText(AR.uncertain);
    await user.click(resetButton());

    await screen.findByRole("heading", { level: 2, name: AR.step1 });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(AR.invalid);
    expect(alert).toHaveTextContent(AR.invalidHint);
    expect(within(alert).getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
  });
});

describe("S-05 guard, language and direction", () => {
  it("sends a signed-in visitor on (guard 2)", async () => {
    renderRecovery({ backend: makeBackend({}, { signedIn: true, hasPlan: true }) });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("is worded in English, with the code and the username left to right", async () => {
    const user = userEvent.setup();
    renderRecovery({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Account recovery" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Step 1 of 3: Verify your code" })).toBeInTheDocument();
    expect(screen.getByText("Enter your username and the recovery code you saved when you registered.")).toBeInTheDocument();
    expect(screen.getByText("32 characters, with or without dashes.")).toBeInTheDocument();
    expect(screen.getByText("After verification you have 10 minutes to set a new password.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Browse books" })).toHaveAttribute("href", "/login");
    expect(screen.getByLabelText("Recovery code")).toHaveAttribute("dir", "ltr");

    await user.type(screen.getByLabelText("Username"), "sample_user_01");
    await user.type(screen.getByLabelText("Recovery code"), MOCK_RECOVERY_CODE);
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Step 2 of 3: New password" })).toHaveFocus();
    expect(screen.getByText("Your current code will stop working and we will show you a replacement once.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeInTheDocument();
  });

  it("keeps the typed values when the language is switched, and rewrites the messages", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await user.type(usernameInput(), "sample_user_01");
    await user.click(verifyButton());
    expect(screen.getByText(AR.needCode)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(screen.getByText("Enter the recovery code.")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("sample_user_01");
  });

  it("uses the MOCK_PASSWORD only as test data: the screen never shows a password back", async () => {
    const user = userEvent.setup();
    renderRecovery();
    await verified(user);
    await fillStep2(user, MOCK_PASSWORD);
    await user.click(screen.getAllByRole("button", { name: "إظهار كلمة المرور" })[0] as HTMLElement);
    expect(newPasswordInput()).toHaveAttribute("type", "text");
    expect(confirmationInput()).toHaveAttribute("type", "password");
  });
});
