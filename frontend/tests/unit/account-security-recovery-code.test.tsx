import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/recovery-code", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { RotateRecoveryCodeScreen } from "@/components/account-security/RotateRecoveryCodeScreen";
import { MOCK_PASSWORD } from "@/lib/api/mock";
import { MOCK_ROTATED_CODE } from "@/lib/api/mock/security-handlers";
import { peekLoginArrival } from "@/lib/auth/flash";
import { peekRecoveryCode } from "@/lib/auth/recovery-handoff";
import { peekSettingsArrival } from "@/lib/settings/arrival";
import {
  advance,
  apiError,
  E08,
  DASHES,
  flush,
  follows,
  jsonResponse,
  makeSecurityBackend,
  politeRegion,
  renderSecurity,
  resetSecurityState,
  TRIGGER,
  type SecurityBackend,
} from "./account-security-support";

const AR = {
  heading: "إعادة توليد الرمز",
  title: "إعادة توليد الرمز · قطرة غيث",
  back: "رجوع إلى الإعدادات",
  notice: "سيتوقف رمز الاسترجاع الحالي عن العمل فور إنشاء الرمز الجديد، ولن نعرضه لك مرة أخرى. يظهر الرمز الجديد مرة واحدة فقط.",
  current: "كلمة المرور الحالية",
  invalidCurrent: "كلمة المرور الحالية غير صحيحة.",
  needCurrent: "أدخل كلمة المرور الحالية.",
  uncertain: "تعذّر تأكيد النتيجة. أعد المحاولة؛ كل محاولة ناجحة تستبدل الرمز السابق.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
  throttle20: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
};

let unmountView: (() => void) | undefined;
let disposeRuntime: (() => void) | undefined;

function renderRotate(options: { language?: "ar" | "en"; backend?: SecurityBackend } = {}) {
  const view = renderSecurity(<RotateRecoveryCodeScreen />, options);
  unmountView = view.unmount;
  disposeRuntime = () => view.runtime.wakeUp.dispose();
  return view;
}

const currentInput = () => screen.getByLabelText("كلمة المرور الحالية") as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /^(إعادة توليد الرمز|جارٍ الإنشاء…)$/ });

async function enter(user: UserEvent, password = MOCK_PASSWORD) {
  await user.click(currentInput());
  await user.paste(password);
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

describe("S-24 structure (UI-screens S-24 sections 2, 3 and 5)", () => {
  it("shows the back control and the H1, the notice, one labelled password field and the button, in the order of the spec", () => {
    const { container } = renderRotate();
    const heading = screen.getByRole("heading", { level: 1, name: AR.heading });
    expect(heading).toHaveAttribute("data-page-heading");
    expect(document.title).toBe(AR.title);
    const back = screen.getByRole("link", { name: AR.back });
    expect(back).toHaveAttribute("href", "/settings");

    const order = [back, heading, screen.getByText(AR.notice), currentInput(), submitButton()];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
    expect(container.querySelectorAll("input[type=password]")).toHaveLength(1);
    expect(container.textContent).not.toMatch(DASHES);
  });

  it("gives the field the attributes of P-27 and has a hidden username field filled from E11", async () => {
    const { container } = renderRotate();
    expect(currentInput()).toHaveAttribute("autocomplete", "current-password");
    expect(currentInput()).toHaveAttribute("enterkeyhint", "go");
    expect(currentInput()).toHaveAttribute("dir", "auto");
    expect(currentInput()).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "إظهار كلمة المرور" })).toBeInTheDocument();
    const username = container.querySelector("input[autocomplete=username]") as HTMLInputElement;
    expect(username).toHaveAttribute("tabindex", "-1");
    expect(username).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(username).toHaveValue("sample_user_01"));
  });

  it("is worded in English, left to right", () => {
    renderRotate({ language: "en" });
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("heading", { level: 1, name: "Regenerate the recovery code" })).toBeInTheDocument();
    expect(document.title).toBe("Regenerate the recovery code · Qatra");
    expect(screen.getByRole("link", { name: "Back to Settings" })).toBeInTheDocument();
    expect(screen.getByText("Your current recovery code stops working as soon as the new one is created, and we will not show it again. The new code is shown only once.")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate the code" })).toBeInTheDocument();
  });
});

describe("S-24 validation (P-03, P-27)", () => {
  it("an empty password: nothing is sent, one message, no summary, the field announces it and has focus", async () => {
    const user = userEvent.setup();
    const { backend } = renderRotate();
    await user.click(submitButton());
    expect(backend.count(E08)).toBe(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(currentInput()).toHaveFocus();
    expect(currentInput()).toHaveAttribute("aria-invalid", "true");
    expect(currentInput()).toHaveAccessibleDescription(AR.needCurrent);
  });

  it("clears the error at the next blur once the field holds something", async () => {
    const user = userEvent.setup();
    renderRotate();
    await user.click(submitButton());
    await user.type(currentInput(), "x");
    await user.tab();
    await waitFor(() => expect(currentInput()).not.toHaveAttribute("aria-invalid"));
  });

  it("sends a password of any length as typed, never trimmed", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({ [E08]: () => jsonResponse({ recoveryCode: MOCK_ROTATED_CODE }) });
    renderRotate({ backend });
    await enter(user, " x ");
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.bodies(E08)).toEqual([{ password: " x " }]);
  });
});

describe("S-24 success (E08)", () => {
  it("hands the code to S-04 for the settings host in memory only, wipes the password, and replaces the screen; the code reaches no other place", async () => {
    const user = userEvent.setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { backend, container } = renderRotate();
    await enter(user);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code"));

    expect(backend.bodies(E08)).toEqual([{ password: MOCK_PASSWORD }]);
    expect(peekRecoveryCode()).toEqual({ code: MOCK_ROTATED_CODE, host: "settings" });
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(currentInput()).toHaveValue("");
    expect(submitButton()).toHaveAttribute("aria-busy", "true");
    expect(peekSettingsArrival()).toBeNull();
    expect(peekLoginArrival()).toBeNull();

    const bare = MOCK_ROTATED_CODE.replaceAll("-", "");
    const everywhere = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, window.location.href, window.history.state, document.title, container.innerHTML, document.body.textContent]);
    expect(everywhere).not.toContain(MOCK_ROTATED_CODE);
    expect(everywhere).not.toContain(bare);
    expect(container.querySelectorAll("[role=status], [role=alert], [aria-live]")).not.toHaveLength(0);
    for (const region of container.querySelectorAll("[role=status], [role=alert], [aria-live]")) expect(region.textContent).not.toContain(MOCK_ROTATED_CODE);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(MOCK_ROTATED_CODE);
  });

  it("sends nothing twice while E08 is in flight", async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    const backend = makeSecurityBackend({ [E08]: () => new Promise<Response>((resolve) => (release = resolve)) });
    renderRotate({ backend });
    await enter(user);
    await user.click(submitButton());
    await waitFor(() => expect(submitButton()).toHaveAttribute("aria-busy", "true"));
    await user.click(submitButton());
    await user.type(currentInput(), "{Enter}");
    expect(backend.count(E08)).toBe(1);
    expect(screen.getByText("جارٍ الإنشاء", { selector: "[role=status] p" })).toBeInTheDocument();
    await act(async () => release(jsonResponse({ recoveryCode: MOCK_ROTATED_CODE })));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledTimes(1));
  });
});

describe("S-24 errors (G-04, P-06, P-07, P-04, P-05, P-10, G-03)", () => {
  it("a wrong password: one generic alert above the button, the field cleared and focused, none marked invalid, no code held", async () => {
    const user = userEvent.setup();
    renderRotate();
    await enter(user, "not the password");
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.invalidCurrent);
    expect(currentInput()).toHaveValue("");
    expect(currentInput()).toHaveFocus();
    expect(currentInput()).not.toHaveAttribute("aria-invalid");
    expect(follows(currentInput(), alert)).toBe(true);
    expect(follows(alert, submitButton())).toBe(true);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("500: a generic alert, the value kept, focus on the button", async () => {
    const user = userEvent.setup();
    renderRotate();
    await enter(user, TRIGGER.internal);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(currentInput()).toHaveValue(TRIGGER.internal);
    expect(submitButton()).toHaveFocus();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("503: a polite warning in Slot B; the button is the retry", async () => {
    const user = userEvent.setup();
    renderRotate();
    await enter(user, TRIGGER.unavailable);
    await user.click(submitButton());
    await screen.findByText(AR.unavailable);
    expect(politeRegion(AR.unavailable)).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("403 forbidden_origin: an alert with a reload button", async () => {
    const user = userEvent.setup();
    renderRotate();
    await enter(user, TRIGGER.origin);
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.origin);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("429: a polite warning with the wait, an aria-disabled button, a countdown nobody hears, and a press that does nothing", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend, container } = renderRotate();
    await enter(user, TRIGGER.throttled);
    await user.click(submitButton());
    await flush();

    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
    expect(submitButton()).toHaveAttribute("aria-disabled", "true");
    expect(submitButton()).not.toBeDisabled();
    expect(container.querySelector("p[aria-hidden=true] bdi")).toHaveTextContent("٠٠:٢٠");

    await user.click(submitButton());
    await flush();
    expect(backend.count(E08)).toBe(1);

    await advance(20_000);
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
    expect(politeRegion("يمكنك المحاولة الآن.")).toHaveClass("sr-only");
  });

  it("no answer: a warning that cannot confirm the result, nothing resent on its own, and a press sends again", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    let calls = 0;
    const backend = makeSecurityBackend({
      [E08]: () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return jsonResponse({ recoveryCode: MOCK_ROTATED_CODE });
      },
    });
    renderRotate({ backend });
    await enter(user);
    await user.click(submitButton());
    await flush();

    const banner = politeRegion(AR.uncertain);
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(within(banner).queryByRole("link")).toBeNull();
    expect(currentInput()).toHaveValue(MOCK_PASSWORD);
    expect(submitButton()).toHaveFocus();
    await advance(30_000);
    expect(backend.count(E08)).toBe(1);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).toBeNull();

    await user.click(submitButton());
    await flush();
    expect(backend.count(E08)).toBe(2);
    expect(navigation.router.replace).toHaveBeenCalledWith("/recovery-code");
    expect(peekRecoveryCode()).toEqual({ code: MOCK_ROTATED_CODE, host: "settings" });
    expect(screen.queryByText(AR.uncertain)).not.toBeInTheDocument();
  });

  it("offline: the connectivity line, and a press is still allowed", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderRotate();
    expect(screen.getByText(AR.offline)).toBeInTheDocument();
    expect(submitButton()).not.toHaveAttribute("aria-disabled");
  });

  it("401 unauthenticated from E08: S-01 with the session-ended banner and next set to this screen", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({ [E08]: () => apiError(401, "unauthenticated") });
    renderRotate({ backend });
    await enter(user);
    await user.click(submitButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Frecovery-code"));
    expect(peekLoginArrival()).toBe("session_ended");
    expect(peekRecoveryCode()).toBeNull();
  });

  it("401 unauthenticated from the background E11 read: the same redirect, before any press", async () => {
    renderRotate({ backend: makeSecurityBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Frecovery-code"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-24 the password never outlives the screen (P-27)", () => {
  it("is wiped when the screen unmounts and when the page is hidden", async () => {
    const user = userEvent.setup();
    renderRotate();
    await enter(user);
    const input = currentInput();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(input.value).toBe("");
    await user.click(input);
    await user.paste(MOCK_PASSWORD);
    expect(input.value).toBe(MOCK_PASSWORD);
    unmountView?.();
    expect(input.value).toBe("");
  });
});
