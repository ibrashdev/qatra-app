import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/delete-account", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { DeleteAccountScreen } from "@/components/account-security/DeleteAccountScreen";
import { MOCK_PASSWORD } from "@/lib/api/mock";
import { MOCK_ROTATED_CODE } from "@/lib/api/mock/security-handlers";
import { peekLoginArrival } from "@/lib/auth/flash";
import { holdRecoveryCode, peekRecoveryCode } from "@/lib/auth/recovery-handoff";
import { readRegisterDraft, saveRegisterDraft } from "@/lib/auth/register-draft";
import { peekSettingsArrival } from "@/lib/settings/arrival";
import {
  advance,
  apiError,
  E13,
  DASHES,
  flush,
  follows,
  makeSecurityBackend,
  politeRegion,
  renderSecurity,
  resetSecurityState,
  TRIGGER,
  type SecurityBackend,
} from "./account-security-support";

const AR = {
  heading: "حذف الحساب",
  title: "حذف الحساب · قطرة غيث",
  back: "رجوع إلى الإعدادات",
  warning: "حذف الحساب فوري ونهائي، ولا يمكن التراجع عنه.",
  effectsHeading: "ما الذي سيُحذف؟",
  effects: ["حسابك وإعداداتك وسجل موافقتك على الشروط.", "خططك وجلساتك وإجاباتك وتقدمك.", "رسائل محادثة الخطة مع المساعد.", "رمز الاسترجاع وجلسات الدخول على كل الأجهزة."],
  knowHeading: "ما يجب أن تعرفه",
  know: [
    "لا تُحفظ إجاباتك على هذا الجهاز؛ كل ما سُجّل محفوظ في حسابك السحابي وسيُحذف معه.",
    "لا نحتفظ بنسخة قابلة للتنزيل من بياناتك، ولا يمكن استرجاعها بعد الحذف.",
    "قد تبقى نسخ احتياطية داخلية لدى مزود الخدمة مدة تحددها خطته؛ التفاصيل في «بيان الخصوصية».",
    "يحتاج الحذف إلى اتصال بالشبكة.",
  ],
  privacy: "بيان الخصوصية",
  current: "كلمة المرور الحالية",
  acknowledgment: "أفهم أن حذف حسابي نهائي ولا يمكن التراجع عنه",
  acknowledgmentRequired: "أكّد أنك تفهم أن الحذف نهائي قبل المتابعة.",
  cancel: "إلغاء",
  invalidCurrent: "كلمة المرور الحالية غير صحيحة.",
  needCurrent: "أدخل كلمة المرور الحالية.",
  notDeleted: "لم يُحذف حسابك.",
  uncertain: "تعذّر تأكيد النتيجة. إن كان الحساب قد حُذف فستنتهي جلستك؛ وإلا أعد المحاولة.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
  throttle20: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
  summary2: "يوجد خطآن في النموذج",
};

let unmountView: (() => void) | undefined;
let disposeRuntime: (() => void) | undefined;

function renderDelete(options: { language?: "ar" | "en"; backend?: SecurityBackend } = {}) {
  const view = renderSecurity(<DeleteAccountScreen />, options);
  unmountView = view.unmount;
  disposeRuntime = () => view.runtime.wakeUp.dispose();
  return view;
}

const currentInput = () => screen.getByLabelText("كلمة المرور الحالية") as HTMLInputElement;
const box = () => screen.getByRole("checkbox", { name: AR.acknowledgment }) as HTMLInputElement;
const deleteButton = () => screen.getByRole("button", { name: /^(حذف حسابي نهائيًا|جارٍ الحذف…)$/ });
const cancelLink = () => screen.getByRole("link", { name: AR.cancel });

async function enter(user: UserEvent, { password = MOCK_PASSWORD, acknowledge = true }: { password?: string; acknowledge?: boolean } = {}) {
  if (password !== "") {
    await user.click(currentInput());
    await user.paste(password);
  }
  if (acknowledge) await user.click(box());
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

describe("S-27 structure (UI-screens S-27 sections 2, 3 and 5)", () => {
  it("shows the back control and the H1, the warning, the two lists, the privacy link, the password, the box, the destructive button and Cancel, in the order of the spec", () => {
    renderDelete();
    const heading = screen.getByRole("heading", { level: 1, name: AR.heading });
    expect(heading).toHaveAttribute("data-page-heading");
    expect(document.title).toBe(AR.title);
    const back = screen.getByRole("link", { name: AR.back });
    expect(back).toHaveAttribute("href", "/settings");

    const order = [
      back,
      heading,
      screen.getByText(AR.warning),
      screen.getByRole("heading", { level: 2, name: AR.effectsHeading }),
      screen.getByText(AR.effects[0] as string),
      screen.getByRole("heading", { level: 2, name: AR.knowHeading }),
      screen.getByText(AR.know[0] as string),
      screen.getByRole("link", { name: AR.privacy }),
      currentInput(),
      box(),
      deleteButton(),
      cancelLink(),
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(follows(order[index - 1] as HTMLElement, order[index] as HTMLElement), `position ${index}`).toBe(true);
    }
  });

  it("lists every effect and every point as real list items, with the words of the spec and no dash written in front of them", () => {
    const { container } = renderDelete();
    const effects = within(screen.getByRole("heading", { level: 2, name: AR.effectsHeading }).parentElement as HTMLElement).getAllByRole("listitem");
    expect(effects.map((item) => item.textContent)).toEqual(AR.effects);
    const know = within(screen.getByRole("heading", { level: 2, name: AR.knowHeading }).parentElement as HTMLElement).getAllByRole("listitem");
    expect(know.map((item) => item.textContent)).toEqual(AR.know);
    expect(container.textContent).not.toMatch(DASHES);
  });

  it("puts the warning in a banner that cannot be dismissed", () => {
    renderDelete();
    const banner = screen.getByText(AR.warning).closest(".rounded-md") as HTMLElement;
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(banner).not.toHaveAttribute("role");
  });

  it("links the privacy statement to S-26 on a line of its own that is at least 44 px high", () => {
    renderDelete();
    const link = screen.getByRole("link", { name: AR.privacy });
    expect(link).toHaveAttribute("href", "/settings/privacy#privacy");
    expect(link).toHaveClass("min-h-target");
    expect(link.parentElement?.textContent).toBe(AR.privacy);
  });

  it("gives the password field the attributes of P-27, a hidden username filled from E11, and an unticked box that is required", async () => {
    const { container } = renderDelete();
    expect(currentInput()).toHaveAttribute("autocomplete", "current-password");
    expect(currentInput()).toHaveAttribute("enterkeyhint", "go");
    expect(currentInput()).toHaveAttribute("type", "password");
    expect(box()).not.toBeChecked();
    expect(box()).toHaveAttribute("aria-required", "true");
    expect(box()).toHaveAttribute("autocomplete", "off");
    const username = container.querySelector("input[autocomplete=username]") as HTMLInputElement;
    expect(username).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(username).toHaveValue("sample_user_01"));
  });

  it("uses the destructive recipe for the button, the secondary recipe for Cancel, and a Cancel that goes to S-22", () => {
    renderDelete();
    expect(deleteButton()).toHaveClass("bg-error-ink", "text-on-primary", "hover:bg-error-pressed", "min-h-button", "w-full");
    expect(deleteButton()).toHaveAttribute("type", "submit");
    expect(cancelLink()).toHaveClass("border-edge", "bg-surface", "min-h-button", "w-full");
    expect(cancelLink()).toHaveAttribute("href", "/settings");
  });

  it("never shows a typed Latin word, a countdown, an undo, an export or a retention period", () => {
    const { container } = renderDelete();
    expect(container.textContent).not.toMatch(/DELETE/);
    expect(container.querySelectorAll("input[type=text]:not([aria-hidden=true])")).toHaveLength(0);
    expect(container.querySelector("p[aria-hidden=true] bdi")).toBeNull();
    expect(screen.queryByRole("button", { name: /تراجع|تصدير|تنزيل|استعادة/ })).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\s*(يوم|أيام|يومًا)/);
  });

  it("is worded in English, left to right, with the same structure", () => {
    renderDelete({ language: "en" });
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("heading", { level: 1, name: "Delete account" })).toBeInTheDocument();
    expect(document.title).toBe("Delete account · Qatra");
    expect(screen.getByRole("link", { name: "Back to Settings" })).toBeInTheDocument();
    expect(screen.getByText("Deleting the account is immediate and permanent, and it cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "What will be deleted?" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "What you should know" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy statement" })).toHaveAttribute("href", "/settings/privacy#privacy");
    expect(screen.getByRole("checkbox", { name: "I understand that deleting my account is permanent and cannot be undone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete my account permanently" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/settings");
  });
});

describe("S-27 validation (P-03, P-27)", () => {
  it("an unticked box sends nothing: the error is at the box, tied by its description, and focus goes to it", async () => {
    const user = userEvent.setup();
    const { backend } = renderDelete();
    await enter(user, { acknowledge: false });
    await user.click(deleteButton());

    expect(backend.count(E13)).toBe(0);
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect(box()).toHaveAccessibleDescription(AR.acknowledgmentRequired);
    expect(box()).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("an empty password with the box ticked: one message at the password, nothing sent, focus on the field", async () => {
    const user = userEvent.setup();
    const { backend } = renderDelete();
    await enter(user, { password: "" });
    await user.click(deleteButton());
    expect(backend.count(E13)).toBe(0);
    expect(currentInput()).toHaveFocus();
    expect(currentInput()).toHaveAccessibleDescription(AR.needCurrent);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("both missing: two messages, a summary in Slot T under the heading, and focus on the first invalid field", async () => {
    const user = userEvent.setup();
    const { backend } = renderDelete();
    await user.click(deleteButton());

    expect(backend.count(E13)).toBe(0);
    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent(AR.summary2);
    expect(within(summary).getByRole("link", { name: AR.needCurrent })).toBeInTheDocument();
    expect(within(summary).getByRole("link", { name: AR.acknowledgmentRequired })).toBeInTheDocument();
    expect(currentInput()).toHaveFocus();
    expect(follows(screen.getByRole("heading", { level: 1 }), summary)).toBe(true);
    expect(follows(summary, screen.getByText(AR.warning))).toBe(true);

    await user.click(within(summary).getByRole("link", { name: AR.acknowledgmentRequired }));
    expect(box()).toHaveFocus();
  });

  it("ticking the box takes its error away, and the next press sends the request", async () => {
    const user = userEvent.setup();
    const { backend } = renderDelete();
    await enter(user, { acknowledge: false });
    await user.click(deleteButton());
    expect(box()).toHaveAttribute("aria-invalid", "true");
    await user.click(box());
    expect(box()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(AR.acknowledgmentRequired)).not.toBeInTheDocument();
    await user.click(deleteButton());
    await waitFor(() => expect(backend.count(E13)).toBe(1));
  });

  it("clears the password error at its next blur once the field holds something", async () => {
    const user = userEvent.setup();
    renderDelete();
    await user.click(deleteButton());
    await user.type(currentInput(), "x");
    await user.tab();
    await waitFor(() => expect(currentInput()).not.toHaveAttribute("aria-invalid"));
  });
});

describe("S-27 success (E13)", () => {
  it("sends the password as typed with the literal itself, wipes the memory of the account, raises the banner of S-01 and replaces the screen", async () => {
    const user = userEvent.setup();
    saveRegisterDraft({ username: "someone_01", password: "a draft password", confirmation: "a draft password", consent: true });
    holdRecoveryCode(MOCK_ROTATED_CODE, "settings");
    let arrivalAtReplace: string | null = null;
    navigation.router.replace.mockImplementation(() => {
      arrivalAtReplace = peekLoginArrival();
    });
    const { backend } = renderDelete();
    await enter(user);
    await user.click(deleteButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));

    expect(backend.bodies(E13)).toEqual([{ password: MOCK_PASSWORD, confirm: "DELETE" }]);
    expect(arrivalAtReplace).toBe("account_deleted");
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(readRegisterDraft()).toBeNull();
    expect(peekRecoveryCode()).toBeNull();
    expect(currentInput()).toHaveValue("");
    expect(deleteButton()).toHaveAttribute("aria-busy", "true");
    expect(peekSettingsArrival()).toBeNull();
    expect(document.body.textContent).not.toContain(MOCK_PASSWORD);
  });

  it("is inert while E13 is in flight: the button busy and answering once, the fields and Cancel inert, focus on the button", async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    const backend = makeSecurityBackend({ [E13]: () => new Promise<Response>((resolve) => (release = resolve)) });
    renderDelete({ backend });
    await enter(user);
    await user.click(deleteButton());
    await waitFor(() => expect(deleteButton()).toHaveAttribute("aria-busy", "true"));

    expect(deleteButton()).toHaveFocus();
    expect(currentInput()).toHaveAttribute("readonly");
    expect(box()).toBeDisabled();
    expect(cancelLink().closest("[inert]")).not.toBeNull();
    expect(screen.getByText("جارٍ الحذف", { selector: "[role=status] p" })).toBeInTheDocument();
    await user.click(deleteButton());
    await user.type(currentInput(), "{Enter}");
    expect(backend.count(E13)).toBe(1);

    await act(async () => release(new Response(null, { status: 204 })));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(backend.count(E13)).toBe(1);
  });

  it("makes the fields editable again when the request fails", async () => {
    const user = userEvent.setup();
    renderDelete();
    await enter(user, { password: TRIGGER.internal });
    await user.click(deleteButton());
    await screen.findByRole("alert");
    expect(currentInput()).not.toHaveAttribute("readonly");
    expect(box()).toBeEnabled();
    expect(box()).toBeChecked();
    expect(cancelLink().closest("[inert]")).toBeNull();
  });
});

describe("S-27 errors (G-04, P-06, P-07, P-04, P-05, P-10, G-03)", () => {
  it("a wrong password: one generic alert above the button, the field cleared and focused, none marked invalid, the box still ticked, nothing wiped", async () => {
    const user = userEvent.setup();
    saveRegisterDraft({ username: "someone_01", password: "a draft password", confirmation: "a draft password", consent: true });
    renderDelete();
    await enter(user, { password: "not the password" });
    await user.click(deleteButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(AR.invalidCurrent);
    expect(currentInput()).toHaveValue("");
    expect(currentInput()).toHaveFocus();
    expect(currentInput()).not.toHaveAttribute("aria-invalid");
    expect(box()).toBeChecked();
    expect(follows(box(), alert)).toBe(true);
    expect(follows(alert, deleteButton())).toBe(true);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(readRegisterDraft()).not.toBeNull();
    expect(peekLoginArrival()).toBeNull();
  });

  it("500: a generic alert, the values kept, focus on the button, nothing wiped", async () => {
    const user = userEvent.setup();
    renderDelete();
    await enter(user, { password: TRIGGER.internal });
    await user.click(deleteButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
    expect(currentInput()).toHaveValue(TRIGGER.internal);
    expect(deleteButton()).toHaveFocus();
    expect(peekLoginArrival()).toBeNull();
  });

  it("503: one warning that says the account was not deleted, announced politely; the button is the retry and the same request may be repeated", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const backend = makeSecurityBackend({
      [E13]: () => {
        calls += 1;
        return calls === 1 ? apiError(503, "unavailable") : new Response(null, { status: 204 });
      },
    });
    renderDelete({ backend });
    await enter(user);
    await user.click(deleteButton());

    const notDeleted = await screen.findByText(AR.notDeleted, { selector: "p.mt-q4" });
    const banner = notDeleted.closest(".rounded-md") as HTMLElement;
    expect(banner).toHaveTextContent(`${AR.unavailable}${AR.notDeleted}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const announced = screen.getAllByText(`${AR.unavailable} ${AR.notDeleted}`).find((node) => node.closest("[role=status]"));
    expect(announced?.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(follows(box(), banner)).toBe(true);
    expect(follows(banner, deleteButton())).toBe(true);
    expect(currentInput()).toHaveValue(MOCK_PASSWORD);
    expect(deleteButton()).toHaveFocus();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekLoginArrival()).toBeNull();

    await user.click(deleteButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(backend.count(E13)).toBe(2);
    expect(peekLoginArrival()).toBe("account_deleted");
  });

  it("403 forbidden_origin: an alert with a reload button", async () => {
    const user = userEvent.setup();
    renderDelete();
    await enter(user, { password: TRIGGER.origin });
    await user.click(deleteButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.origin);
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "إعادة تحميل الصفحة" }));
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("429: a polite warning with the wait, an aria-disabled destructive button that stays focusable, a countdown nobody hears, and a press that does nothing", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    const { backend, container } = renderDelete();
    await enter(user, { password: TRIGGER.throttled });
    await user.click(deleteButton());
    await flush();

    expect(politeRegion(AR.throttle20)).toHaveAttribute("aria-live", "polite");
    const button = deleteButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)).toContainElement(screen.getByText(AR.throttle20));
    const line = container.querySelector("p[aria-hidden=true] bdi") as HTMLElement;
    expect(line).toHaveTextContent("٠٠:٢٠");
    await advance(1_000);
    expect(line).toHaveTextContent("٠٠:١٩");

    await user.click(deleteButton());
    await flush();
    expect(backend.count(E13)).toBe(1);

    await advance(19_000);
    expect(deleteButton()).not.toHaveAttribute("aria-disabled");
    expect(politeRegion("يمكنك المحاولة الآن.")).toHaveClass("sr-only");
    expect(currentInput()).toHaveValue(TRIGGER.throttled);
  });

  it("no answer: a warning that cannot confirm the result, the values kept, nothing resent, nothing wiped, focus on the button", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    saveRegisterDraft({ username: "someone_01", password: "a draft password", confirmation: "a draft password", consent: true });
    const { backend } = renderDelete();
    await enter(user, { password: TRIGGER.silent });
    await user.click(deleteButton());
    await flush();

    const banner = politeRegion(AR.uncertain);
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(currentInput()).toHaveValue(TRIGGER.silent);
    expect(box()).toBeChecked();
    expect(deleteButton()).toHaveFocus();
    await advance(30_000);
    expect(backend.count(E13)).toBe(1);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekLoginArrival()).toBeNull();
    expect(readRegisterDraft()).not.toBeNull();
  });

  it("a repeat after a real deletion answers 401, so S-01 shows the session-ended banner and the account-deleted banner is not raised", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const backend = makeSecurityBackend({
      [E13]: () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return apiError(401, "unauthenticated");
      },
    });
    renderDelete({ backend });
    await enter(user);
    await user.click(deleteButton());
    await screen.findByText(AR.uncertain);
    await user.click(deleteButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fdelete-account"));
    expect(peekLoginArrival()).toBe("session_ended");
    expect(backend.count(E13)).toBe(2);
  });

  it("offline: the connectivity line, and a press is still allowed", () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderDelete();
    expect(screen.getByText(AR.offline)).toBeInTheDocument();
    expect(deleteButton()).not.toHaveAttribute("aria-disabled");
  });

  it("401 unauthenticated from E13: S-01 with the session-ended banner and next set to this screen", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({ [E13]: () => apiError(401, "unauthenticated") });
    renderDelete({ backend });
    await enter(user);
    await user.click(deleteButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fdelete-account"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("401 unauthenticated from the background E11 read: the same redirect, before any press", async () => {
    renderDelete({ backend: makeSecurityBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fsettings%2Fdelete-account"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("treats a confirm_literal refusal, which the client cannot cause, as an internal error", async () => {
    const user = userEvent.setup();
    const backend = makeSecurityBackend({ [E13]: () => apiError(422, "validation_error", { fields: [{ field: "confirm", rule: "confirm_literal" }] }) });
    renderDelete({ backend });
    await enter(user);
    await user.click(deleteButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(AR.internal);
  });
});

describe("S-27 the password never outlives the screen (P-27)", () => {
  it("is wiped when the page is hidden and when the screen unmounts", async () => {
    const user = userEvent.setup();
    renderDelete();
    await enter(user);
    const input = currentInput();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(input.value).toBe("");
    await user.click(input);
    await user.paste(MOCK_PASSWORD);
    unmountView?.();
    expect(input.value).toBe("");
  });
});
