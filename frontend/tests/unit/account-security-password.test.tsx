import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/password", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { ChangePasswordScreen } from "@/components/account-security/ChangePasswordScreen";
import { MOCK_PASSWORD } from "@/lib/api/mock";
import { peekLoginArrival } from "@/lib/auth/flash";
import { peekSettingsArrival } from "@/lib/settings/arrival";
import {
  advance,
  apiError,
  E09,
  E11,
  DASHES,
  flush,
  follows,
  jsonResponse,
  makeSecurityBackend,
  NEW_PASSWORD,
  politeRegion,
  renderSecurity,
  resetSecurityState,
  TRIGGER,
  type SecurityBackend,
} from "./account-security-support";

const AR = {
  heading: "تغيير كلمة المرور",
  title: "تغيير كلمة المرور · قطرة غيث",
  back: "رجوع إلى الإعدادات",
  notice: "ستبقى مسجّلًا الدخول في هذا الجهاز، وتنتهي جلسات هذا الحساب على الأجهزة الأخرى.",
  current: "كلمة المرور الحالية",
  password: "كلمة المرور الجديدة",
  helper: "١٥ حرفًا على الأقل. يمكنك استخدام عبارة طويلة.",
  confirmation: "تأكيد كلمة المرور الجديدة",
  invalidCurrent: "كلمة المرور الحالية غير صحيحة.",
  needCurrent: "أدخل كلمة المرور الحالية.",
  needPassword: "أدخل كلمة المرور.",
  short: "كلمة المرور ١٥ حرفًا على الأقل.",
  tooLong: "كلمة المرور أطول من الحد المسموح (٧٢ بايت). اختصرها قليلًا؛ الحرف العربي الواحد يُحتسب بايتين.",
  needConfirmation: "أكّد كلمة المرور.",
  mismatch: "كلمتا المرور غير متطابقتين.",
  summary3: "يوجد ٣ أخطاء في النموذج",
  uncertain: "تعذّر تأكيد النتيجة. إن انتهت جلستك فسجّل الدخول بكلمة المرور الجديدة؛ وإلا أعد المحاولة.",
  waking: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
  throttle20: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
};

let unmountView: (() => void) | undefined;
let disposeRuntime: (() => void) | undefined;

function renderPassword(options: { language?: "ar" | "en"; backend?: SecurityBackend } = {}) {
  const view = renderSecurity(<ChangePasswordScreen />, options);
  unmountView = view.unmount;
  disposeRuntime = () => view.runtime.wakeUp.dispose();
  return view;
}

const currentInput = () => screen.getByLabelText("كلمة المرور الحالية") as HTMLInputElement;
const passwordInput = () => screen.getByLabelText("كلمة المرور الجديدة") as HTMLInputElement;
const confirmationInput = () => screen.getByLabelText("تأكيد كلمة المرور الجديدة") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /^(تغيير كلمة المرور|جارٍ التغيير…)$/ });
const hiddenUsername = (container: HTMLElement) => container.querySelector("input[autocomplete=username]") as HTMLInputElement;

async function fill(user: UserEvent, { current = MOCK_PASSWORD, password = NEW_PASSWORD, confirmation = password }: { current?: string; password?: string; confirmation?: string } = {}) {
  // Pasting is allowed on every password field (P-08), and it is quicker than typing forty keys three times.
  for (const [input, value] of [
    [currentInput(), current],
    [passwordInput(), password],
    [confirmationInput(), confirmation],
  ] as const) {
    if (value === "") continue;
    await user.click(input);
    await user.paste(value);
  }
}

beforeEach(() => {
  resetSecurityState();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
});

afterEach(() => {
  disposeRuntime?.();
  disposeRuntime = undefined;
  unmountView = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("S-23 structure (UI-screens S-23 sections 2, 3 and 5)", () => {
  it("shows the back control and the H1, the notice, three labelled fields with the helper under the new one, and the button, in the order of the spec", () => {
    renderPassword();
    const heading = screen.getByRole("heading", { level: 1, name: AR.heading });
    expect(heading).toHaveAttribute("data-page-heading");
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(document.title).toBe(AR.title);

    const back = screen.getByRole("link", { name: AR.back });
    expect(back).toHaveAttribute("href", "/settings");

    const helper = screen.getByText(AR.helper);
    expect(passwordInput()).toHaveAccessibleDescription(AR.helper);
    const order = [back, heading, screen.getByText(AR.notice), currentInput(), passwordInput(), helper, confirmationInput(), submitButton()];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
  });

  it("writes no dash anywhere on the screen: the label and its helper, like the heading and its list, are separate elements", () => {
    const { container } = renderPassword();
    expect(container.textContent).not.toMatch(DASHES);
    expect(screen.getByText("كلمة المرور الجديدة", { selector: "label" })).toBeInTheDocument();
  });

  it("gives the fields the attributes of P-27 and P-08 and shows no strength meter and no password in clear", () => {
    const { container } = renderPassword();
    expect(currentInput()).toHaveAttribute("autocomplete", "current-password");
    expect(currentInput()).toHaveAttribute("enterkeyhint", "go");
    for (const input of [currentInput(), passwordInput(), confirmationInput()]) {
      expect(input).toHaveAttribute("type", "password");
      expect(input).toHaveAttribute("dir", "auto");
      expect(input).not.toHaveAttribute("maxlength");
      expect(input).not.toHaveAttribute("autocomplete", "off");
    }
    expect(passwordInput()).toHaveAttribute("autocomplete", "new-password");
    expect(confirmationInput()).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getAllByRole("button", { name: "إظهار كلمة المرور" })).toHaveLength(3);
    expect(container.querySelector("meter, progress, [role=progressbar], [role=meter]")).toBeNull();
  });

  it("has a hidden username field for password managers, filled from E11 in the background", async () => {
    const { container } = renderPassword();
    const username = hiddenUsername(container);
    expect(username).toHaveAttribute("tabindex", "-1");
    expect(username).toHaveAttribute("aria-hidden", "true");
    expect(username).toHaveClass("sr-only");
    await waitFor(() => expect(username).toHaveValue("sample_user_01"));
    expect(username.form).toBe(currentInput().form);
  });

  it("leaves the username empty and blocks nothing when the E11 read fails", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({
      [E11]: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const { container } = renderPassword({ backend });
    await fill(user);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/settings"));
    expect(hiddenUsername(container)).toHaveValue("");
    expect(backend.count(E09)).toBe(1);
  });

  it("is worded in English, left to right, with the same structure", () => {
    renderPassword({ language: "en" });
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(screen.getByRole("heading", { level: 1, name: "Change password" })).toBeInTheDocument();
    expect(document.title).toBe("Change password · Qatra");
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAccessibleDescription("At least 15 characters. A long phrase works well.");
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(screen.getByText("You stay signed in on this device, and sessions of this account on other devices end.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();
  });
});

describe("S-23 validation (P-03, P-08, P-27)", () => {
  it("three empty fields: nothing is sent, three messages, a summary in Slot T, and focus on the first invalid field", async () => {
    const user = userEvent.setup();
    const { backend } = renderPassword();
    await user.click(submitButton());

    expect(backend.count(E09)).toBe(0);
    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent(AR.summary3);
    expect(within(summary).getByRole("link", { name: AR.needCurrent })).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: AR.needPassword })).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: AR.needConfirmation })).toBeInTheDocument();
    expect(currentInput()).toHaveFocus();
    expect(currentInput()).toHaveAttribute("aria-invalid", "true");
    expect(currentInput()).toHaveAccessibleDescription(AR.needCurrent);
    expect(follows(screen.getByRole("heading", { level: 1 }), summary)).toBe(true);
    expect(follows(summary, screen.getByText(AR.notice))).toBe(true);

    await user.click(within(summary).getByRole("link", { name: AR.needConfirmation }));
    expect(confirmationInput()).toHaveFocus();
  });

  it("one error: no summary, the field is announced through its description, and focus goes to it", async () => {
    const user = userEvent.setup();
    const { backend } = renderPassword();
    await fill(user, { password: "short", confirmation: "short" });
    await user.click(submitButton());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(passwordInput()).toHaveFocus();
    expect(passwordInput()).toHaveAccessibleDescription(`${AR.helper} ${AR.short}`);
    expect(backend.count(E09)).toBe(0);
  });

  it("the current password is checked for being empty only: any length is accepted and sent", async () => {
    const user = userEvent.setup();
    const { backend } = renderPassword();
    await fill(user, { current: "x" });
    await user.click(submitButton());
    await screen.findByRole("alert");
    expect(backend.bodies(E09)).toEqual([{ currentPassword: "x", newPassword: NEW_PASSWORD }]);
  });

  it("refuses a password over 72 bytes (Arabic letters count two) and a mismatch, before anything is sent", async () => {
    const user = userEvent.setup();
    const { backend } = renderPassword();
    await fill(user, { password: "ع".repeat(37), confirmation: "something else entirely" });
    await user.click(submitButton());

    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent("يوجد خطآن في النموذج");
    expect(within(summary).getByRole("link", { name: AR.tooLong })).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: AR.mismatch })).toBeInTheDocument();
    expect(backend.count(E09)).toBe(0);
  });

  it("checks a field with content on blur, and clears the error at the next blur once it holds a good value", async () => {
    const user = userEvent.setup();
    renderPassword();
    await user.type(passwordInput(), "short");
    await user.tab();
    await waitFor(() => expect(passwordInput()).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText(AR.short)).toBeInTheDocument();

    await user.type(passwordInput(), " and a long enough ending");
    await user.tab();
    await waitFor(() => expect(passwordInput()).not.toHaveAttribute("aria-invalid"));
    expect(screen.queryByText(AR.short)).not.toBeInTheDocument();
  });

  it("compares the confirmation when either of the two new fields blurs", async () => {
    const user = userEvent.setup();
    renderPassword();
    await user.type(passwordInput(), NEW_PASSWORD);
    await user.type(confirmationInput(), "different");
    await user.tab();
    await waitFor(() => expect(screen.getByText(AR.mismatch)).toBeInTheDocument());
    await user.clear(passwordInput());
    await user.type(passwordInput(), "different");
    await user.tab();
    await waitFor(() => expect(screen.getByText(AR.short)).toBeInTheDocument());
  });

  it("sends the passwords exactly as typed: spaces at the ends are not trimmed", async () => {
    const user = userEvent.setup();
    const padded = `  ${"a".repeat(13)}`;
    // The mock accepts one current password, so this test answers E09 itself and looks only at what was sent.
    const backend = makeSecurityBackend({ [E09]: () => jsonResponse({ profile: {} }) });
    renderPassword({ backend });
    await fill(user, { current: " spaced current ", password: padded, confirmation: padded });
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.bodies(E09)).toEqual([{ currentPassword: " spaced current ", newPassword: padded }]);
  });

  it("shows the message of a password rule that only the server refused at the new password field, and focuses it", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({
      [E09]: () => apiError(422, "validation_error", { fields: [{ field: "newPassword", rule: "password_min_chars" }] }),
    });
    renderPassword({ backend });
    await fill(user);
    await user.click(submitButton());
    await screen.findByText(AR.short);
    expect(passwordInput()).toHaveFocus();
    expect(passwordInput()).toHaveValue(NEW_PASSWORD);
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("treats a validation_error the learner cannot fix as an internal error", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({ [E09]: () => apiError(422, "validation_error", { fields: [{ field: "currentPassword", rule: "invalid_type" }] }) });
    renderPassword({ backend });
    await fill(user);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
  });
});

describe("S-23 success (E09)", () => {
  it("sends the three values as typed, wipes the fields, raises the banner of S-22 before it replaces the screen, and keeps the button busy", async () => {
    const user = userEvent.setup();
    let arrivalAtReplace: string | null = null;
    navigation.router.replace.mockImplementation(() => {
      arrivalAtReplace = peekSettingsArrival();
    });
    const { backend } = renderPassword();
    await fill(user);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/settings"));

    expect(backend.bodies(E09)).toEqual([{ currentPassword: MOCK_PASSWORD, newPassword: NEW_PASSWORD }]);
    expect(arrivalAtReplace).toBe("password_changed");
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    for (const input of [currentInput(), passwordInput(), confirmationInput()]) expect(input).toHaveValue("");
    expect(submitButton()).toHaveAttribute("aria-busy", "true");
    expect(peekLoginArrival()).toBeNull();
    expect(document.body.textContent).not.toContain(NEW_PASSWORD);
    expect(document.body.textContent).not.toContain(MOCK_PASSWORD);
  });

  it("sends nothing twice while E09 is in flight", async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    const backend = makeSecurityBackend({ [E09]: () => new Promise<Response>((resolve) => (release = resolve)) });
    renderPassword({ backend });
    await fill(user);
    await user.click(submitButton());
    await waitFor(() => expect(submitButton()).toHaveAttribute("aria-busy", "true"));
    await user.click(submitButton());
    await user.type(confirmationInput(), "{Enter}");
    expect(backend.count(E09)).toBe(1);
    expect(screen.getByText("جارٍ التغيير", { selector: "[role=status] p" })).toBeInTheDocument();
    await act(async () => release(new Response(JSON.stringify({ profile: {} }), { status: 200 })));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledTimes(1));
  });
});

describe("S-23 errors (G-04, P-06, P-07, P-04, P-05, P-10, G-03)", () => {
  it("a wrong current password: one generic alert above the button, the field cleared and focused, none marked invalid, the new values kept", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user, { current: "not the password" });
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.invalidCurrent);
    expect(currentInput()).toHaveValue("");
    expect(currentInput()).toHaveFocus();
    for (const input of [currentInput(), passwordInput(), confirmationInput()]) expect(input).not.toHaveAttribute("aria-invalid");
    expect(passwordInput()).toHaveValue(NEW_PASSWORD);
    expect(confirmationInput()).toHaveValue(NEW_PASSWORD);
    expect(follows(confirmationInput(), alert)).toBe(true);
    expect(follows(alert, submitButton())).toBe(true);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekSettingsArrival()).toBeNull();
  });

  it("takes the generic banner away when the next press starts", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user, { current: "not the password" });
    await user.click(submitButton());
    await screen.findByRole("alert");
    await user.type(currentInput(), MOCK_PASSWORD);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(screen.queryByText(AR.invalidCurrent)).not.toBeInTheDocument();
  });

  it("500: a generic alert, the values kept, focus on the button", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user, { current: TRIGGER.internal });
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(passwordInput()).toHaveValue(NEW_PASSWORD);
    expect(currentInput()).toHaveValue(TRIGGER.internal);
    expect(submitButton()).toHaveFocus();
  });

  it("503: a polite warning in Slot B; the button is the retry", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user, { current: TRIGGER.unavailable });
    await user.click(submitButton());
    await screen.findByText(AR.unavailable);
    expect(politeRegion(AR.unavailable)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(passwordInput()).toHaveValue(NEW_PASSWORD);
  });

  it("403 forbidden_origin: an alert with a reload button", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user, { current: TRIGGER.origin });
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.origin);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("429: a polite warning with the wait, a button that is aria-disabled but focusable, a countdown nobody hears, and a press that does nothing", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend, container } = renderPassword();
    await fill(user, { current: TRIGGER.throttled });
    await user.click(submitButton());
    await flush();

    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
    const button = submitButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)).toContainElement(screen.getByText(AR.throttle20));
    const line = container.querySelector("p[aria-hidden=true] bdi") as HTMLElement;
    expect(line).toHaveTextContent("٠٠:٢٠");
    await advance(1_000);
    expect(line).toHaveTextContent("٠٠:١٩");

    await user.click(submitButton());
    await flush();
    expect(backend.count(E09)).toBe(1);

    await advance(19_000);
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
    expect(politeRegion("يمكنك المحاولة الآن.")).toHaveClass("sr-only");
    expect(passwordInput()).toHaveValue(NEW_PASSWORD);
  });

  it("the 15-minute lock is worded as a clock", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user, { current: TRIGGER.locked });
    await user.click(submitButton());
    expect(await screen.findByText(/محاولات كثيرة\. يمكنك المحاولة بعد/)).toHaveTextContent("١٥:٠٠");
  });

  it("no answer to E09: a warning that cannot confirm the result, with a login link, the values kept, nothing resent, focus on the button", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend } = renderPassword();
    await fill(user, { current: TRIGGER.silent });
    await user.click(submitButton());
    await flush();

    const banner = politeRegion(AR.uncertain);
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(within(banner).getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
    expect(passwordInput()).toHaveValue(NEW_PASSWORD);
    expect(submitButton()).toHaveFocus();
    expect(screen.queryByText(AR.invalidCurrent)).not.toBeInTheDocument();
    await advance(30_000);
    expect(backend.count(E09)).toBe(1);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekSettingsArrival()).toBeNull();
  });

  it("offline: the connectivity line, and a press is still allowed", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderPassword();
    expect(screen.getByText(AR.offline)).toBeInTheDocument();
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
  });

  it("401 unauthenticated from E09: S-01 with the session-ended banner and next set to this screen, the fields wiped", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({ [E09]: () => apiError(401, "unauthenticated") });
    renderPassword({ backend });
    await fill(user);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fpassword"));
    expect(peekLoginArrival()).toBe("session_ended");
    expect(peekSettingsArrival()).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("401 unauthenticated from the background E11 read: the same redirect, before any press", async () => {
    renderPassword({ backend: makeSecurityBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fpassword"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-23 passwords never outlive the screen (P-27)", () => {
  it("wipes every password field when the screen unmounts", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user);
    const inputs = [currentInput(), passwordInput(), confirmationInput()];
    unmountView?.();
    for (const input of inputs) expect(input.value).toBe("");
  });

  it("wipes them when the page is hidden, so a page kept for the back button does not show them again", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    for (const input of [currentInput(), passwordInput(), confirmationInput()]) expect(input).toHaveValue("");
  });

  it("stores nothing: no storage, no address and no history state carries a password", async () => {
    const user = userEvent.setup();
    renderPassword();
    await fill(user);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    const everything = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, window.location.href, window.history.state]);
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toContain(MOCK_PASSWORD);
  });
});
