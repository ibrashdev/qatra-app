import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), timeZone: "Asia/Dubai" }));
vi.mock("@/lib/browser", () => ({ reloadPage: browser.reloadPage, browserTimeZone: () => browser.timeZone }));

import { SettingsScreen } from "@/components/settings/SettingsScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { TRANSPARENCY_LINE_AR, TRANSPARENCY_LINE_EN } from "@/i18n/terms-text";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { accountMockHandlers } from "@/lib/api/mock/account-handlers";
import { mockProfile } from "@/lib/api/mock/fixtures";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { errorResponse, mockHandlers, type MockHandler, type MockScenario } from "@/lib/api/mock/handlers";
import { settingsMockHandlers } from "@/lib/api/mock/settings-handlers";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import type { Profile } from "@/lib/api/types";
import { clearCodeUnavailable, clearLoginArrival, peekCodeUnavailable, peekLoginArrival, raiseCodeUnavailable } from "@/lib/auth/flash";
import { holdRecoveryCode, peekRecoveryCode, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft, readRegisterDraft, saveRegisterDraft } from "@/lib/auth/register-draft";
import { clearSettingsArrival, peekSettingsArrival, raiseSettingsArrival } from "@/lib/settings/arrival";

const SAVE = { name: "حفظ التغييرات" };
const LOGOUT = { name: "تسجيل الخروج" };
const MINUTES_15 = { name: "١٥ دقيقة" };
const MINUTES_5 = { name: "٥ دقائق" };
const NOTHING = "لا توجد تغييرات للحفظ.";
const SAVE_FAILED = "تعذّر حفظ الإعدادات. حاول مرة أخرى.";
const LOGOUT_FAILED = "تعذّر تسجيل الخروج. حاول مرة أخرى.";
const PENDING_MINUTES_AR = "السارية الآن: ١٠ دقائق. يبدأ هذا التغيير من يوم التعلم التالي (٦ أكتوبر ٢٠٢٦).";

const profileWith = (change: Partial<Profile>): MockHandler => () => ({ status: 200, body: { ...mockProfile, ...change } });
const fail = (status: number, code: string): MockHandler => () => errorResponse(status, code, "x");
const noAnswer: MockHandler = () => {
  throw new TypeError("The mock connection failed.");
};

let runtime: ApiRuntime | undefined;

function renderSettings({
  language = "ar",
  handlers = {},
  scenario = {},
  hold,
}: { language?: "ar" | "en"; handlers?: Record<string, MockHandler>; scenario?: Partial<MockScenario>; hold?: { key: string; until: Promise<void> } } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({
    latencyMs: 0,
    handlers: { ...mockHandlers, ...accountMockHandlers, ...settingsMockHandlers, ...handlers },
    scenario: { signedIn: true, hasPlan: true, ...scenario },
  });
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (hold !== undefined && key === hold.key) await hold.until;
    return mock(input, init);
  });
  runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <SettingsScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  const sent = (key: string) => calls.filter((call) => call.key === key);
  return { ...view, calls, sent, count: (key: string) => sent(key).length };
}

const populated = () => screen.findByRole("button", SAVE);

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  browser.timeZone = "Asia/Dubai";
  clearLoginArrival();
  clearCodeUnavailable();
  clearSettingsArrival();
  clearRegisterDraft();
  wipeRecoveryCode();
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  runtime = undefined;
  localStorage.clear();
  resetLocaleStoreForTests();
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
});

describe("S-22 Settings: the populated screen", () => {
  it("shows the H1, the account rows, the preferences, the privacy rows, the transparency line and logout in Arabic", async () => {
    renderSettings();
    await populated();

    expect(screen.getByRole("heading", { level: 1, name: "الإعدادات" })).toBeInTheDocument();
    for (const name of ["الحساب", "التفضيلات", "الخصوصية والمصادر"]) expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();

    // c3: the account name sits in a left-to-right isolate. c4: the sync chip is a polite status.
    expect(screen.getByText("اسم الحساب:")).toBeInTheDocument();
    const username = screen.getByText("sample_user_01");
    expect(username.tagName).toBe("BDI");
    expect(username).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("حالة المزامنة:")).toBeInTheDocument();
    const chip = screen.getByText("متزامن");
    expect(chip.closest("[role='status']")).toHaveAttribute("aria-live", "polite");

    // c5 to c7, c17: the rows go to the account and privacy screens; the delete row is in the error colour.
    expect(screen.getByRole("link", { name: "تغيير كلمة المرور" })).toHaveAttribute("href", "/settings/password");
    expect(screen.getByRole("link", { name: "إعادة توليد الرمز" })).toHaveAttribute("href", "/settings/recovery-code");
    const remove = screen.getByRole("link", { name: "حذف الحساب" });
    expect(remove).toHaveAttribute("href", "/settings/delete-account");
    expect(remove.className).toContain("text-error-ink");
    expect(screen.getByRole("link", { name: "الخصوصية والبيانات" })).toHaveAttribute("href", "/settings/privacy");
    expect(screen.getByRole("link", { name: "المصادر" })).toHaveAttribute("href", "/settings/sources");

    // c9, c10, c12, c14: the controls show what is in force.
    expect(screen.getByRole("radio", { name: "العربية" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "English" })).not.toBeChecked();
    // The two language segments name their language in their own (WCAG 3.1.2), as P-02 does for the switch.
    expect(screen.getByRole("radio", { name: "العربية" }).closest("label")).toHaveAttribute("lang", "ar");
    expect(screen.getByRole("radio", { name: "English" }).closest("label")).toHaveAttribute("lang", "en");
    expect(screen.getByRole("radio", { name: "١٠ دقائق" }).closest("label")).not.toHaveAttribute("lang");
    expect(screen.getByRole("radio", { name: "١٠ دقائق" })).toBeChecked();
    expect(screen.getByRole("radio", MINUTES_5)).not.toBeChecked();
    expect(screen.getByRole("radio", MINUTES_15)).not.toBeChecked();
    expect(screen.getByText("يُقترح هذا الوقت عند إنشاء خطة جديدة. لتغيير وقت خطتك الحالية استخدم «تعديل الوقت والهدف».")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "المنطقة الزمنية" })).toHaveDisplayValue(/Asia\/Dubai/);
    expect(screen.getByRole("checkbox", { name: "تذكير داخل التطبيق" })).toBeChecked();
    // c14: the helper is the checkbox's own description, shown once.
    const reminderHelper = "عند فتح التطبيق يظهر إشعار إن كانت لديك مراجعة مستحقة. لا توجد إشعارات خارج التطبيق.";
    expect(screen.getByText(reminderHelper)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "تذكير داخل التطبيق" })).toHaveAccessibleDescription(reminderHelper);

    // c18: the fixed transparency line, with no control beside it.
    expect(screen.getByText(TRANSPARENCY_LINE_AR)).toBeInTheDocument();
    expect(screen.getByRole("button", LOGOUT)).toBeInTheDocument();
    expect(screen.queryByTestId("settings-skeleton")).toBeNull();
  });

  it("shows the same screen in English, left to right, with Western digits", async () => {
    renderSettings({ language: "en", handlers: { "GET /me": profileWith({ language: "en" }) } });
    await screen.findByRole("button", { name: "Save changes" });

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const name of ["Account", "Preferences", "Privacy and sources"]) expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    expect(screen.getByText("Account name:")).toBeInTheDocument();
    expect(screen.getByText("Sync status:")).toBeInTheDocument();
    expect(screen.getByText("Synced")).toBeInTheDocument();
    for (const name of ["Change password", "Regenerate the recovery code", "Delete account", "Privacy and data", "Sources"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: "10 minutes" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(screen.getByText("This time is suggested when you create a new plan. To change the time of your current plan, use «Adjust time and goal».")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Time zone" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "In-app reminder" })).toBeChecked();
    expect(screen.getByText("When you open the app, a notice appears if a review is due. There are no notifications outside the app.")).toBeInTheDocument();
    expect(screen.getByText(TRANSPARENCY_LINE_EN)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("never shows an assistant switch, a link-account row, push or email reminders, a dark mode or translation toggle, an export or a certificate", async () => {
    renderSettings();
    await populated();
    expect(screen.queryByRole("switch")).toBeNull();
    for (const text of [/ربط حساب/, /تصدير/, /شهادة/, /الوضع الداكن/, /ترجمة/, /البريد/, /الهاتف/]) expect(screen.queryByText(text)).toBeNull();
    // The only checkbox is the in-app reminder, and the only radio groups are the two choices.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
  });

  it("shows a skeleton that is busy while the profile loads, then the screen", async () => {
    renderSettings();
    expect(screen.getByTestId("settings-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    await populated();
    expect(screen.queryByTestId("settings-skeleton")).toBeNull();
  });

  it("offers the link to adjust the time and goal only when the plan in force exists", async () => {
    const withPlan = renderSettings();
    await populated();
    expect(screen.getByRole("link", { name: "تعديل الوقت والهدف" })).toHaveAttribute("href", "/plan/revise");
    withPlan.unmount();

    renderSettings({ scenario: { hasPlan: false } });
    await populated();
    expect(screen.queryByRole("link", { name: "تعديل الوقت والهدف" })).toBeNull();
  });

  it("leaves the link out, without a banner, when E18 fails", async () => {
    renderSettings({ handlers: { "GET /today": fail(500, "internal") } });
    await populated();
    expect(screen.queryByRole("link", { name: "تعديل الوقت والهدف" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the zone of the browser with its mark when it differs from the profile, and the offset of each zone", async () => {
    browser.timeZone = "Europe/London";
    renderSettings();
    await populated();
    const select = screen.getByRole("combobox", { name: "المنطقة الزمنية" }) as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.find((option) => option.value === "Europe/London")?.textContent).toContain("من المتصفح");
    expect(options.find((option) => option.value === "Asia/Dubai")?.textContent).toBe("⁦Asia/Dubai⁩ · ⁦UTC+٤⁩");
    expect(options.filter((option) => option.textContent?.includes("من المتصفح"))).toHaveLength(1);
    expect(select.value).toBe("Asia/Dubai");
  });

  it("keeps the order of focus of the specification: the account rows, the controls, Save, the privacy rows, then logout", async () => {
    const user = userEvent.setup();
    renderSettings();
    await populated();
    const names: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      const active = document.activeElement;
      names.push(active instanceof HTMLInputElement ? (active.labels?.[0]?.textContent ?? "") : (active?.textContent ?? ""));
    }
    expect(names.slice(0, 3)).toEqual(["تغيير كلمة المرور", "إعادة توليد الرمز", "حذف الحساب"]);
    expect(names.slice(3, 5)).toEqual(["العربية", "١٠ دقائق"]);
    expect(names[5]).toBe("تعديل الوقت والهدف");
    expect(document.activeElement).toBe(screen.getByRole("button", LOGOUT));
    expect(names.slice(8)).toEqual(["حفظ التغييرات", "الخصوصية والبيانات", "المصادر", "تسجيل الخروج"]);
  });
});

describe("S-22 Settings: saving (E12)", () => {
  it("sends nothing and says so in a polite line when nothing changed", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const save = await populated();
    await user.click(save);

    const line = await screen.findByText(NOTHING);
    expect(line.closest("[role='status']")).toHaveAttribute("aria-live", "polite");
    expect(view.count("PATCH /me")).toBe(0);
    expect(save).toHaveFocus();

    // Changing a control takes the line away.
    await user.click(screen.getByRole("radio", MINUTES_15));
    expect(screen.queryByText(NOTHING)).toBeNull();
  });

  it("sends only the changed field, shows the toast and the pending line, and then has nothing left to save", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(save);

    await waitFor(() => expect(view.count("PATCH /me")).toBe(1));
    expect(view.sent("PATCH /me")[0]?.body).toEqual({ sessionMinutes: 15 });
    expect(await screen.findByText("تم حفظ الإعدادات")).toBeInTheDocument();
    // The profile was replaced: the choice is kept as the pending value, and c13 names the value in force and the start day.
    expect(await screen.findByText(PENDING_MINUTES_AR)).toBeInTheDocument();
    expect(screen.getByRole("radio", MINUTES_15)).toBeChecked();
    expect(save).toHaveFocus();

    await user.click(save);
    expect(await screen.findByText(NOTHING)).toBeInTheDocument();
    expect(view.count("PATCH /me")).toBe(1);
  });

  it("sends the language and the reminder together, and the zone alone", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const save = await populated();
    await user.click(screen.getByRole("radio", { name: "English" }));
    await user.click(screen.getByRole("checkbox", { name: "تذكير داخل التطبيق" }));
    await user.click(save);
    await waitFor(() => expect(view.count("PATCH /me")).toBe(1));
    expect(view.sent("PATCH /me")[0]?.body).toEqual({ language: "en", reminderSettings: { inApp: false } });
    view.unmount();

    const second = renderSettings();
    const secondSave = await populated();
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "المنطقة الزمنية" }), "Asia/Riyadh");
    await userEvent.setup().click(secondSave);
    await waitFor(() => expect(second.count("PATCH /me")).toBe(1));
    expect(second.sent("PATCH /me")[0]?.body).toEqual({ timeZone: "Asia/Riyadh" });
    expect(await screen.findByText(/السارية الآن/)).toHaveTextContent("السارية الآن: Asia/Dubai. يبدأ هذا التغيير من يوم التعلم التالي (٦ أكتوبر ٢٠٢٦).");
  });

  it("does not send the form when Enter is pressed in a checkbox, and sends it when Enter is pressed on the Save button", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const save = await populated();
    const reminder = screen.getByRole("checkbox", { name: "تذكير داخل التطبيق" });
    await user.click(reminder);
    reminder.focus();
    await user.keyboard("{Enter}");
    expect(view.count("PATCH /me")).toBe(0);

    save.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(view.count("PATCH /me")).toBe(1));
    expect(view.sent("PATCH /me")[0]?.body).toEqual({ reminderSettings: { inApp: false } });
  });

  it("keeps the button loading and sends the request once when it is pressed twice", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = renderSettings({ hold: { key: "PATCH /me", until } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);

    const busy = await screen.findByRole("button", { name: "جارٍ الحفظ…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("جارٍ الحفظ…", { selector: "p" })).toBeInTheDocument();
    await user.click(busy);
    expect(view.count("PATCH /me")).toBe(1);
    release();
    expect(await screen.findByText("تم حفظ الإعدادات")).toBeInTheDocument();
    expect(view.count("PATCH /me")).toBe(1);
  });

  it("serves a demo account like any other", async () => {
    const user = userEvent.setup();
    const view = renderSettings({ scenario: { isDemo: true } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(save);
    expect(await screen.findByText("تم حفظ الإعدادات")).toBeInTheDocument();
    expect(view.count("PATCH /me")).toBe(1);
  });
});

describe("S-22 Settings: pending settings (c13)", () => {
  it("shows the pending minutes as chosen, with the value in force and the start day", async () => {
    const user = userEvent.setup();
    const view = renderSettings({ handlers: { "GET /me": profileWith({ pendingSettings: { sessionMinutes: 15, effectiveDate: "2026-10-06" } }) } });
    const save = await populated();
    expect(screen.getByRole("radio", MINUTES_15)).toBeChecked();
    expect(screen.getByRole("radio", { name: "١٠ دقائق" })).not.toBeChecked();
    expect(screen.getByText(PENDING_MINUTES_AR)).toBeInTheDocument();
    // Only the control it belongs to shows a line.
    expect(screen.getAllByText(/السارية الآن/)).toHaveLength(1);

    // The pending value is what was chosen last, so saving as it stands sends nothing; putting the value in force back is a change.
    await user.click(save);
    expect(await screen.findByText(NOTHING)).toBeInTheDocument();
    expect(view.count("PATCH /me")).toBe(0);
    await user.click(screen.getByRole("radio", { name: "١٠ دقائق" }));
    await user.click(save);
    await waitFor(() => expect(view.count("PATCH /me")).toBe(1));
    expect(view.sent("PATCH /me")[0]?.body).toEqual({ sessionMinutes: 10 });
  });

  it("shows the pending zone chosen, with the zone in force in a left-to-right isolate", async () => {
    renderSettings({ handlers: { "GET /me": profileWith({ pendingSettings: { timeZone: "Asia/Riyadh", effectiveDate: "2026-10-06" } }) } });
    await populated();
    expect(screen.getByRole("combobox", { name: "المنطقة الزمنية" })).toHaveDisplayValue(/Asia\/Riyadh/);
    const line = screen.getByText(/السارية الآن/);
    expect(line).toHaveTextContent("السارية الآن: Asia/Dubai. يبدأ هذا التغيير من يوم التعلم التالي (٦ أكتوبر ٢٠٢٦).");
    expect(within(line).getByText("Asia/Dubai").tagName).toBe("BDI");
    expect(within(line).getByText("Asia/Dubai")).toHaveAttribute("dir", "ltr");
  });

  it("writes the line in English with a Western-digit date", async () => {
    renderSettings({ language: "en", handlers: { "GET /me": profileWith({ language: "en", pendingSettings: { sessionMinutes: 5, effectiveDate: "2026-10-06" } }) } });
    await screen.findByRole("button", { name: "Save changes" });
    expect(screen.getByText("In force now: 10 minutes. This change starts on the next learning day (October 6, 2026).")).toBeInTheDocument();
  });

  it("shows no line without pending settings", async () => {
    renderSettings();
    await populated();
    expect(screen.queryByText(/السارية الآن/)).toBeNull();
  });
});

describe("S-22 Settings: a changed language", () => {
  it("switches lang, dir and every label at once, announces it, and keeps focus on Save", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const save = await populated();
    expect(document.documentElement.dir).toBe("rtl");
    await user.click(screen.getByRole("radio", { name: "English" }));
    await user.click(save);

    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(view.sent("PATCH /me")[0]?.body).toEqual({ language: "en" });
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(screen.getByText("Language changed to English").closest("[role='status']")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Settings saved")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "10 minutes" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveFocus();
    // No reload and no navigation.
    expect(browser.reloadPage).not.toHaveBeenCalled();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("switches back to Arabic with the Arabic announcement", async () => {
    const user = userEvent.setup();
    renderSettings({ language: "en", handlers: { "GET /me": profileWith({ language: "en" }) } });
    const save = await screen.findByRole("button", { name: "Save changes" });
    await user.click(screen.getByRole("radio", { name: "العربية" }));
    await user.click(save);
    expect(await screen.findByRole("heading", { level: 1, name: "الإعدادات" })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByText("تم تغيير اللغة إلى العربية")).toBeInTheDocument();
    expect(screen.getByText("تم حفظ الإعدادات")).toBeInTheDocument();
  });
});

describe("S-22 Settings: a failed save", () => {
  it("shows the save-failed banner for an internal error, keeps the chosen values, and sends again on the next press", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderSettings({
      handlers: {
        "PATCH /me": () => {
          attempts += 1;
          return errorResponse(500, "internal", "x");
        },
      },
    });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(screen.getByRole("checkbox", { name: "تذكير داخل التطبيق" }));
    await user.click(save);

    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByRole("radio", MINUTES_15)).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "تذكير داخل التطبيق" })).not.toBeChecked();
    expect(save).toHaveFocus();
    expect(screen.queryByText("تم حفظ الإعدادات")).toBeNull();

    await user.click(save);
    await waitFor(() => expect(attempts).toBe(2));
  });

  it("shows the same banner when no answer arrives", async () => {
    const user = userEvent.setup();
    renderSettings({ handlers: { "PATCH /me": noAnswer } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByRole("radio", MINUTES_5)).toBeChecked();
  });

  it("treats a validation error as an internal one", async () => {
    const user = userEvent.setup();
    renderSettings({ handlers: { "PATCH /me": fail(422, "validation_error") } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_FAILED);
  });

  it("says the service is unavailable in a polite warning, not an alert", async () => {
    const user = userEvent.setup();
    renderSettings({ handlers: { "PATCH /me": fail(503, "unavailable") } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);
    const text = await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.");
    expect(text.closest("[role='status']")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", MINUTES_5)).toBeChecked();
  });

  it("asks for the page to be reloaded when the origin is refused", async () => {
    const user = userEvent.setup();
    renderSettings({ handlers: { "PATCH /me": fail(403, "forbidden_origin") } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.");
    await user.click(screen.getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("sends the visitor to S-01 with the session-ended banner when the session has ended", async () => {
    const user = userEvent.setup();
    renderSettings({ handlers: { "PATCH /me": fail(401, "unauthenticated") } });
    const save = await populated();
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("shows the offline banner above Save before any press, without disabling Save", async () => {
    const user = userEvent.setup();
    const view = renderSettings();
    const save = await populated();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(save).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("radio", MINUTES_5));
    await user.click(save);
    await waitFor(() => expect(view.count("PATCH /me")).toBe(1));
  });

  it("takes the offline banner away and says the connection is back when the browser reports it", async () => {
    renderSettings();
    await populated();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    const status = await screen.findByText("عاد الاتصال.");
    expect(status.closest("[role='status']")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeNull();
  });
});

describe("S-22 Settings: E11 failed", () => {
  it("shows an error banner with a retry that has focus, hides the form and the account rows that need the profile, and keeps the other rows and logout", async () => {
    const user = userEvent.setup();
    let reads = 0;
    renderSettings({
      handlers: {
        "GET /me": () => {
          reads += 1;
          return reads === 1 ? errorResponse(500, "internal", "x") : { status: 200, body: mockProfile };
        },
      },
    });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    const retry = within(banner).getByRole("button", { name: "إعادة المحاولة" });
    expect(retry).toHaveFocus();

    expect(screen.queryByRole("button", SAVE)).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "التفضيلات" })).toBeNull();
    expect(screen.queryByText("اسم الحساب:")).toBeNull();
    expect(screen.getByRole("link", { name: "تغيير كلمة المرور" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "حذف الحساب" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "المصادر" })).toBeInTheDocument();
    expect(screen.getByText(TRANSPARENCY_LINE_AR)).toBeInTheDocument();
    expect(screen.getByRole("button", LOGOUT)).toBeInTheDocument();

    await user.click(retry);
    await populated();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(reads).toBe(2);
  });

  it("shows the offline banner with a retry when E11 cannot be reached and the browser is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderSettings({ handlers: { "GET /me": noAnswer } });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", SAVE)).toBeNull();
  });

  it("says the service is unavailable with a retry for a 503", async () => {
    renderSettings({ handlers: { "GET /me": fail(503, "unavailable") } });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByRole("button", SAVE)).toBeNull();
  });

  it("sends the visitor to S-01 with the session-ended banner and shows nothing of the screen when the session has ended", async () => {
    renderSettings({ scenario: { signedIn: false } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings"));
    expect(peekLoginArrival()).toBe("session_ended");
    expect(screen.queryByRole("button", LOGOUT)).toBeNull();
    expect(screen.queryByRole("link", { name: "تغيير كلمة المرور" })).toBeNull();
  });
});

describe("S-22 Settings: the arrival banners", () => {
  it("shows the password-changed banner once, without a live-region role, and takes it from memory", async () => {
    raiseSettingsArrival("password_changed");
    const view = renderSettings();
    await populated();
    const text = await screen.findByText("تم تغيير كلمة المرور. تنتهي جلسات هذا الحساب على الأجهزة الأخرى، وتبقى هذه الجلسة مفتوحة.");
    expect(text.closest("[role='alert'], [role='status']")).toBeNull();
    expect(peekSettingsArrival()).toBeNull();

    view.unmount();
    renderSettings();
    await populated();
    expect(screen.queryByText(/تم تغيير كلمة المرور/)).toBeNull();
  });

  it("shows the code-rotated banner", async () => {
    raiseSettingsArrival("code_rotated");
    renderSettings();
    expect(await screen.findByText("تم إنشاء رمز استرجاع جديد، ولم يعد الرمز القديم صالحًا.")).toBeInTheDocument();
    expect(peekSettingsArrival()).toBeNull();
  });

  it("shows the note about a code that cannot be shown again, and nothing else, when S-04 was left unconfirmed", async () => {
    raiseCodeUnavailable();
    raiseSettingsArrival("password_changed");
    renderSettings();
    expect(await screen.findByText("لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.")).toBeInTheDocument();
    expect(screen.queryByText(/تم تغيير كلمة المرور/)).toBeNull();
    // Both notes are spent: the one that lost the priority is not shown later.
    expect(peekCodeUnavailable()).toBe(false);
    expect(peekSettingsArrival()).toBeNull();
  });

  it("shows the password-changed banner before the code-rotated one when both are raised", async () => {
    raiseSettingsArrival("code_rotated");
    raiseSettingsArrival("password_changed");
    renderSettings();
    expect(await screen.findByText(/تم تغيير كلمة المرور/)).toBeInTheDocument();
    expect(screen.queryByText(/رمز استرجاع جديد/)).toBeNull();
  });

  it("is dismissible, and focus goes to the H1", async () => {
    const user = userEvent.setup();
    raiseSettingsArrival("code_rotated");
    renderSettings();
    await populated();
    await user.click(screen.getByRole("button", { name: "إغلاق التنبيه" }));
    expect(screen.queryByText(/رمز استرجاع جديد/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "الإعدادات" })).toHaveFocus();
  });

  it("writes the banners in English", async () => {
    raiseSettingsArrival("password_changed");
    renderSettings({ language: "en" });
    expect(await screen.findByText("Your password was changed. Sessions of this account on other devices have ended, and this one stays open.")).toBeInTheDocument();
  });

  it("shows no banner without an arrival", async () => {
    renderSettings();
    await populated();
    expect(screen.queryByRole("button", { name: "إغلاق التنبيه" })).toBeNull();
  });
});

describe("S-22 Settings: logout (E10)", () => {
  const keepSomethingInMemory = () => {
    saveRegisterDraft({ username: "typed_user_01", password: "synthetic draft value", confirmation: "synthetic draft value", consent: true });
    holdRecoveryCode("0123-4567-89ab-cdef-0123-4567-89ab-cdef", "register");
  };

  it("calls E10 once, clears the register draft and the held recovery code, and goes to S-01", async () => {
    const user = userEvent.setup();
    keepSomethingInMemory();
    const view = renderSettings();
    await populated();
    await user.click(screen.getByRole("button", LOGOUT));

    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(view.count("POST /auth/logout")).toBe(1);
    expect(readRegisterDraft()).toBeNull();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("treats a 401 as done: the session was already gone", async () => {
    const user = userEvent.setup();
    keepSomethingInMemory();
    renderSettings({ handlers: { "POST /auth/logout": fail(401, "unauthenticated") } });
    await populated();
    await user.click(screen.getByRole("button", LOGOUT));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(readRegisterDraft()).toBeNull();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("shows the button loading with the form inert, and a polite status, while E10 is in flight", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = renderSettings({ hold: { key: "POST /auth/logout", until } });
    await populated();
    await user.click(screen.getByRole("button", LOGOUT));

    const busy = await screen.findByRole("button", { name: "جارٍ الخروج…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("جارٍ الخروج…", { selector: "p" }).closest("[role='status']")).toHaveAttribute("aria-live", "polite");
    expect(document.querySelector("form")).toHaveAttribute("inert");
    await user.click(busy);
    expect(view.count("POST /auth/logout")).toBe(1);
    release();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
  });

  it.each([
    ["a 503", fail(503, "unavailable")],
    ["a 403", fail(403, "forbidden_origin")],
    ["a 500", fail(500, "internal")],
    ["no answer", noAnswer],
  ])("stays on the screen with an error banner above the button after %s, and keeps what is in memory", async (_label, handler) => {
    const user = userEvent.setup();
    keepSomethingInMemory();
    renderSettings({ handlers: { "POST /auth/logout": handler } });
    await populated();
    const logout = screen.getByRole("button", LOGOUT);
    await user.click(logout);

    expect(await screen.findByRole("alert")).toHaveTextContent(LOGOUT_FAILED);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(readRegisterDraft()).not.toBeNull();
    expect(peekRecoveryCode()).not.toBeNull();
    expect(screen.getByRole("button", LOGOUT)).toBe(logout);
    expect(logout).toHaveFocus();
    expect(document.querySelector("form")).not.toHaveAttribute("inert");
  });

  it("writes the failure in English", async () => {
    const user = userEvent.setup();
    renderSettings({ language: "en", handlers: { "POST /auth/logout": fail(503, "unavailable") } });
    await screen.findByRole("button", { name: "Save changes" });
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Logging out failed. Try again.");
  });
});
