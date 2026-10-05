import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/recovery-code", router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn(), browserTimeZone: () => "Asia/Dubai" }));
vi.mock("@/lib/browser", () => browser);

import StartPage from "@/app/(flow)/start/page";
import { LoginForm } from "@/components/auth/LoginForm";
import { RecoveryCodeScreen } from "@/components/auth/RecoveryCodeScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { recoveryCodeAr, recoveryCodeEn } from "@/i18n/recovery-code-messages";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_RECOVERY_CODE, mockProfile, type MockScenario } from "@/lib/api/mock";
import { clearCodeUnavailable, clearLoginArrival, peekCodeUnavailable, peekLoginArrival, raiseCodeUnavailable, raiseLoginArrival } from "@/lib/auth/flash";
import { holdRecoveryCode, peekRecoveryCode, wipeRecoveryCode, type RecoveryHost } from "@/lib/auth/recovery-handoff";
import { installDialogPolyfill } from "./dialog-polyfill";

type Language = "ar" | "en";

const COPY = { ar: recoveryCodeAr, en: recoveryCodeEn } as const;
const H1 = { ar: "حفظ رمز الاسترجاع", en: "Save your recovery code" } as const;
const TITLE = { ar: "حفظ رمز الاسترجاع · قطرة غيث", en: "Save your recovery code · Qatra" } as const;
const SKIP = { ar: "انتقل إلى المحتوى", en: "Skip to content" } as const;
const NAME = { ar: "قطرة غيث", en: "Qatra" } as const;

type Handler = () => Response | Promise<Response>;

// The mock layer answers by default; every call is recorded, so a test can say which requests the screen made.
function makeBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: false }) {
  const mock = createMockFetch({ latencyMs: 0, scenario });
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push(key);
    const override = overrides[key];
    return override ? override() : mock(input, init);
  });
  return { fetchImpl, calls };
}
type Backend = ReturnType<typeof makeBackend>;

let runtime: ApiRuntime;
let dialogs: ReturnType<typeof installDialogPolyfill>;

function setLanguage(language: Language) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderScreen({ language = "ar", host = "register", code = MOCK_RECOVERY_CODE, held = true, backend = makeBackend() }: { language?: Language; host?: RecoveryHost; code?: string; held?: boolean; backend?: Backend } = {}) {
  setLanguage(language);
  if (held) holdRecoveryCode(code, host);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <RecoveryCodeScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

// The pops of the browser's history, seen before the guard can swallow them.
const popWaiters: Array<() => void> = [];
let unwatchPops: () => void;

async function goBack() {
  await act(async () => {
    const popped = new Promise<void>((resolve) => void popWaiters.push(resolve));
    window.history.back();
    await popped;
  });
}

// What the browser would do for the clipboard, the file and the click on the download link.
let writeText: ReturnType<typeof vi.fn>;
let files: { blob: Blob; name: string; href: string; attached: boolean }[];
let revoked: string[];

function stubClipboard(impl: (text: string) => Promise<void> = async () => undefined) {
  writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

const h1 = () => screen.getByRole("heading", { level: 1, name: H1.ar });
const copyButton = (language: Language = "ar") => screen.getByRole("button", { name: COPY[language].copy });
const downloadButton = (language: Language = "ar") => screen.getByRole("button", { name: COPY[language].download });
const confirmBox = (language: Language = "ar") => screen.getByRole("checkbox", { name: COPY[language].confirmLabel }) as HTMLInputElement;
const continueButton = (language: Language = "ar") => screen.getByRole("button", { name: COPY[language].continueLabel });
const block = (language: Language = "ar") => screen.getByRole("group", { name: COPY[language].blockName });
const liveRegions = () => Array.from(document.querySelectorAll("[aria-live], [role=status], [role=alert]"));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearCodeUnavailable();
  wipeRecoveryCode();
  navigation.pathname = "/recovery-code";
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  window.history.replaceState({ origin: true }, "", "/recovery-code");
  dialogs = installDialogPolyfill();
  stubClipboard();
  files = [];
  revoked = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const href = `blob:http://localhost:3000/file-${files.length + 1}`;
    files.push({ blob, name: "", href, attached: false });
    return href;
  });
  URL.revokeObjectURL = vi.fn((href: string) => {
    revoked.push(href);
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    const file = files.find((entry) => entry.href === this.href);
    if (file) {
      file.name = this.download;
      file.attached = this.isConnected;
    }
  });
  const watch = () => {
    for (const resolve of popWaiters.splice(0)) resolve();
  };
  window.addEventListener("popstate", watch, true);
  unwatchPops = () => window.removeEventListener("popstate", watch, true);
});

afterEach(() => {
  unwatchPops();
  runtime?.wakeUp.dispose();
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S-04 structure (UI-screens S-04 sections 2, 3 and 6)", () => {
  it("is a focus screen: the header holds the droplet and the product name and nothing else, and there is no switch, no back control and no tab bar", () => {
    renderScreen();
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent(NAME.ar);
    expect(within(header).queryByRole("link")).not.toBeInTheDocument();
    expect(within(header).queryByRole("button")).not.toBeInTheDocument();
    expect(header.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /رجوع|Back/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: SKIP.ar })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("shows the regions in the order of the spec: heading, lead, warning, code, copy and download, confirmation, continue", () => {
    renderScreen();
    const lead = document.getElementById(h1().getAttribute("aria-describedby") ?? "") as HTMLElement;
    const warning = screen.getByText(COPY.ar.warning);
    const order = [h1(), lead, warning, block(), copyButton(), downloadButton(), confirmBox(), continueButton()];
    for (let index = 1; index < order.length; index += 1) {
      const before = order[index - 1] as Element;
      const after = order[index] as Element;
      expect(Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING), `position ${index}`).toBe(true);
    }
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("separates the regions by 24 px and puts the two actions side by side, 8 px apart, wrapping only when the text is enlarged", () => {
    renderScreen();
    expect(h1().parentElement).toHaveClass("flex", "flex-col", "gap-q24");
    const actions = copyButton().parentElement as HTMLElement;
    expect(actions).toHaveClass("flex", "flex-wrap", "gap-q8");
    expect(actions).toContainElement(downloadButton());
  });

  it("has the heading of the screen name, described by the one-time sentence, ready to take focus after a route change", () => {
    renderScreen();
    expect(h1()).toHaveClass("text-title", "text-ink");
    expect(h1()).toHaveAttribute("tabindex", "-1");
    expect(h1()).toHaveAttribute("data-page-heading");
    const lead = document.getElementById(h1().getAttribute("aria-describedby") ?? "");
    expect(lead).toHaveTextContent(COPY.ar.lead);
    expect(lead).toHaveClass("text-body", "text-ink");
    expect(screen.getByRole("heading", { level: 1, name: H1.ar, description: COPY.ar.lead })).toBe(h1());
  });

  it("titles the page with the screen name and the product, and never with the code", () => {
    renderScreen();
    expect(document.title).toBe(TITLE.ar);
    expect(document.title).not.toContain("0123");
  });

  it("shows the loss statement in a Warning banner that cannot be dismissed, in the wording of the owner fix, with no live-region role", () => {
    renderScreen();
    const banner = screen.getByText(COPY.ar.warning).closest("div.rounded-md") as HTMLElement;
    expect(banner).toHaveClass("border-warning-edge", "bg-warning-tint", "text-warning-ink");
    expect(banner).not.toHaveAttribute("role");
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
    expect(banner.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(COPY.ar.warning).toBe("لا يمكن استرجاع الحساب دون الرمز. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.");
  });

  it("shows the code as eight spans of four characters in two lines of four groups, left to right, never translated, in the mono face, selected whole by a press", () => {
    renderScreen();
    const element = block();
    expect(element).toHaveAttribute("dir", "ltr");
    expect(element).toHaveAttribute("translate", "no");
    expect(element).toHaveClass("select-all", "font-mono", "border", "border-edge", "bg-surface", "rounded-md", "p-q16", "text-ink");
    expect(element.className).toContain("text-[1.25rem]");
    expect(element.className).toContain("leading-[1.8]");
    const groups = Array.from(element.querySelectorAll("span")).filter((span) => /^[0-9a-f]{4}$/.test(span.textContent ?? ""));
    expect(groups.map((span) => span.textContent)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
    const lines = Array.from(element.children);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(Array.from(line.querySelectorAll("span")).filter((span) => /^[0-9a-f]{4}$/.test(span.textContent ?? ""))).toHaveLength(4);
  });

  it("has the code with its dashes as its text, so a copy by hand and assistive technology read the same code", () => {
    renderScreen();
    expect(block().textContent).toBe(MOCK_RECOVERY_CODE);
    expect(screen.getByRole("group", { name: "رمز الاسترجاع", description: "يظهر مرة واحدة فقط" })).toBe(block());
  });

  it("keeps the dash between the two lines in the text at font size zero: no room on screen, yet in the selection and in what is read", () => {
    renderScreen();
    const lone = Array.from(block().querySelectorAll("span")).filter((span) => span.textContent === "-");
    expect(lone).toHaveLength(1);
    expect(lone[0]).toHaveClass("text-[0px]");
    expect(lone[0]?.parentElement).toBe(block().firstElementChild);
    expect(block().textContent?.split("-")).toHaveLength(8);
  });

  it("is not focusable, and holds no second copy of the code for assistive technology", () => {
    renderScreen();
    expect(block()).not.toHaveAttribute("tabindex");
    expect(block().querySelector("[tabindex]")).toBeNull();
    expect(document.body.textContent?.split(MOCK_RECOVERY_CODE).length).toBe(2);
    for (const element of Array.from(document.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain("4567");
    }
  });

  it("rewrites a copy of the selection to the plain code with its dashes, never with the line break", () => {
    renderScreen();
    const data = new Map<string, string>();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData: (type: string, value: string) => data.set(type, value) } });
    block().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(data.get("text/plain")).toBe(MOCK_RECOVERY_CODE);
  });

  it("offers Copy and Download as secondary buttons of at least 88 by 44 px with a glyph that does not mirror, named as their labels", () => {
    renderScreen();
    for (const button of [copyButton(), downloadButton()]) {
      expect(button).toHaveClass("border", "border-edge", "bg-surface", "text-primary-deep", "min-h-button", "min-w-22");
      const glyph = button.querySelector("svg");
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph).not.toHaveClass("rtl:-scale-x-100");
      expect(glyph?.getAttribute("class")).toContain("size-icon-md");
    }
    expect(copyButton().querySelector("svg")?.getAttribute("class")).toContain("lucide-copy");
    expect(downloadButton().querySelector("svg")?.getAttribute("class")).toContain("lucide-download");
  });

  it("starts with the box unchecked and a Continue button that is not disabled, full width and primary", () => {
    renderScreen();
    expect(confirmBox()).not.toBeChecked();
    expect(confirmBox()).toHaveAttribute("aria-required", "true");
    expect(confirmBox()).not.toHaveAttribute("aria-invalid");
    const button = continueButton();
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toHaveClass("w-full", "bg-primary", "text-on-primary");
  });

  it("shows no username, no demo wording, no masked or hidden-by-default code and no 'show' control", () => {
    renderScreen();
    expect(document.body.textContent).not.toContain(mockProfile.username);
    expect(screen.queryByRole("button", { name: /إظهار|إخفاء|Show|Hide|reveal/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([COPY.ar.copy, COPY.ar.download, COPY.ar.continueLabel]);
  });

  it("calls no API: only the page's own first request of the load is made", async () => {
    const { backend } = renderScreen();
    await userEvent.click(copyButton());
    await userEvent.click(downloadButton());
    await userEvent.click(confirmBox());
    await userEvent.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.calls.filter((call) => call !== "GET /api/health")).toEqual([]);
  });
});

describe("the hosts (S-04 sections 1 and 3)", () => {
  it("registration: no step line, only the one-time sentence in the lead", () => {
    renderScreen({ host: "register" });
    expect(screen.queryByText(COPY.ar.step)).not.toBeInTheDocument();
    const lead = document.getElementById(h1().getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(lead.textContent).toBe(COPY.ar.lead);
    expect(screen.queryByText(new RegExp(COPY.ar.oldCodeInvalid))).not.toBeInTheDocument();
  });

  it("recovery: the step line above the heading and the sentence about the old code after the lead", () => {
    renderScreen({ host: "recovery" });
    const step = screen.getByText(COPY.ar.step);
    expect(step).toHaveClass("text-small", "text-ink-secondary");
    expect(Boolean(step.compareDocumentPosition(h1()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    const lead = document.getElementById(h1().getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(lead.textContent).toBe(`${COPY.ar.lead} ${COPY.ar.oldCodeInvalid}`);
  });

  it("rotation in Settings: the sentence about the old code, and no step line", () => {
    renderScreen({ host: "settings" });
    expect(screen.queryByText(COPY.ar.step)).not.toBeInTheDocument();
    const lead = document.getElementById(h1().getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(lead.textContent).toBe(`${COPY.ar.lead} ${COPY.ar.oldCodeInvalid}`);
  });

  it.each([
    ["register", "/start", null],
    ["recovery", "/login", "reset_done"],
    ["settings", "/settings", null],
  ] as const)("%s: Continue goes to %s by replace, and raises %s for the next screen", async (host, path, arrival) => {
    renderScreen({ host });
    await userEvent.click(confirmBox());
    await userEvent.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(path));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(peekLoginArrival()).toBe(arrival);
    expect(peekCodeUnavailable()).toBe(false);
  });

  it.each([
    ["register", "/start"],
    ["settings", "/settings"],
  ] as const)("%s: leaving goes to %s with the default Info banner of S-04 for the next screen", async (host, path) => {
    renderScreen({ host });
    await goBack();
    await userEvent.click(await screen.findByRole("button", { name: COPY.ar.leave.leave }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(path));
    expect(peekCodeUnavailable()).toBe(true);
    expect(peekLoginArrival()).toBeNull();
  });

  it("recovery: leaving goes to S-01 with the banner in its wording, and the dialog says to log in first", async () => {
    renderScreen({ host: "recovery" });
    await goBack();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(COPY.ar.leave.bodyRecovery)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: COPY.ar.leave.leave }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(peekLoginArrival()).toBe("code_unavailable");
    expect(peekCodeUnavailable()).toBe(false);
  });

  it("registration and rotation: the dialog gives the sentence without the login clause", async () => {
    renderScreen({ host: "register" });
    await goBack();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(COPY.ar.leave.body)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(COPY.ar.leave.bodyRecovery);
  });
});

describe("Copy and Download (S-04 section 3)", () => {
  it("copies the code with its dashes, confirms with a polite toast, and leaves focus on the button", async () => {
    renderScreen();
    await userEvent.click(copyButton());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(MOCK_RECOVERY_CODE);
    const toast = await screen.findByText(COPY.ar.copied);
    const live = toast.closest("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-atomic", "true");
    expect(document.activeElement).toBe(copyButton());
    expect(screen.queryByText(COPY.ar.copyUnavailable)).not.toBeInTheDocument();
  });

  it("announces a second copy again: the toast is a new node", async () => {
    renderScreen();
    await userEvent.click(copyButton());
    const first = await screen.findByText(COPY.ar.copied);
    await userEvent.click(copyButton());
    const second = await screen.findByText(COPY.ar.copied);
    expect(second).not.toBe(first);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("shows the notice below the buttons, selects the text and keeps focus on Copy when the clipboard refuses", async () => {
    stubClipboard(async () => Promise.reject(new DOMException("denied", "NotAllowedError")));
    renderScreen();
    await userEvent.click(copyButton());
    const notice = await screen.findByText(COPY.ar.copyUnavailable);
    expect(notice.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(Boolean(copyButton().compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(notice.compareDocumentPosition(confirmBox()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(window.getSelection()?.toString().replace(/\s/g, "")).toBe(MOCK_RECOVERY_CODE);
    expect(document.activeElement).toBe(copyButton());
    expect(screen.queryByText(COPY.ar.copied)).not.toBeInTheDocument();
  });

  it("does the same where there is no clipboard at all", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    renderScreen();
    await userEvent.click(copyButton());
    expect(await screen.findByText(COPY.ar.copyUnavailable)).toBeInTheDocument();
    expect(window.getSelection()?.toString().replace(/\s/g, "")).toBe(MOCK_RECOVERY_CODE);
  });

  it("takes the notice away and shows the toast when a later copy works", async () => {
    stubClipboard(async () => Promise.reject(new Error("denied")));
    renderScreen();
    await userEvent.click(copyButton());
    await screen.findByText(COPY.ar.copyUnavailable);
    stubClipboard();
    await userEvent.click(copyButton());
    await screen.findByText(COPY.ar.copied);
    expect(screen.queryByText(COPY.ar.copyUnavailable)).not.toBeInTheDocument();
  });

  it("keeps an empty polite status region in the page before any failure, so the notice is announced", () => {
    renderScreen();
    const region = copyButton().parentElement?.nextElementSibling as HTMLElement;
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("downloads a UTF-8 text file named qatra-recovery-code.txt, made in the browser, three lines, in Arabic", async () => {
    renderScreen();
    await userEvent.click(downloadButton());
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file?.name).toBe("qatra-recovery-code.txt");
    expect(file?.attached).toBe(true);
    expect(file?.blob.type).toBe("text/plain;charset=utf-8");
    expect((await file?.blob.text())?.split("\n")).toEqual(["قطرة غيث: رمز الاسترجاع", MOCK_RECOVERY_CODE, "احتفظ بهذا الملف في مكان آمن ولا تشاركه."]);
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("writes the file in English when the page is in English, and never with the username", async () => {
    renderScreen({ language: "en" });
    await userEvent.click(downloadButton("en"));
    const text = (await files[0]?.blob.text()) ?? "";
    expect(text.split("\n")).toEqual(["Qatra: recovery code", MOCK_RECOVERY_CODE, "Keep this file somewhere safe and do not share it."]);
    expect(text).not.toContain(mockProfile.username);
  });

  it("confirms the download with a polite toast, keeps focus on the button, and releases the file address a moment later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderScreen();
    await userEvent.click(downloadButton());
    expect(screen.getByText(COPY.ar.downloaded)).toBeInTheDocument();
    expect(document.activeElement).toBe(downloadButton());
    expect(revoked).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(revoked).toEqual([files[0]?.href]);
  });

  it("downloads again on a second press: one file each time", async () => {
    renderScreen();
    await userEvent.click(downloadButton());
    await userEvent.click(downloadButton());
    expect(files).toHaveLength(2);
  });
});

describe("Continue without the confirmation (S-04 sections 3 and 4)", () => {
  it("shows the error at the box instead of a disabled button, moves focus to the box, and goes nowhere", async () => {
    renderScreen();
    await userEvent.click(continueButton());
    const error = screen.getByText(COPY.ar.confirmRequired);
    expect(error.closest("p")).toHaveClass("text-error-ink");
    expect(error.closest("p")?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(confirmBox()).toHaveAttribute("aria-invalid", "true");
    expect(confirmBox().getAttribute("aria-describedby")).toBe(error.closest("p")?.id);
    expect(document.activeElement).toBe(confirmBox());
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).not.toBeNull();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
    expect(continueButton()).not.toHaveAttribute("aria-disabled");
  });

  it("clears the error when the box is checked, and shows it again if Continue is pressed after unchecking", async () => {
    renderScreen();
    await userEvent.click(continueButton());
    await userEvent.click(confirmBox());
    expect(screen.queryByText(COPY.ar.confirmRequired)).not.toBeInTheDocument();
    expect(confirmBox()).not.toHaveAttribute("aria-invalid");
    await userEvent.click(confirmBox());
    expect(screen.queryByText(COPY.ar.confirmRequired)).not.toBeInTheDocument();
    await userEvent.click(continueButton());
    expect(screen.getByText(COPY.ar.confirmRequired)).toBeInTheDocument();
  });

  it("is reached by Enter on the focused button as well", async () => {
    renderScreen();
    continueButton().focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText(COPY.ar.confirmRequired)).toBeInTheDocument();
    expect(document.activeElement).toBe(confirmBox());
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("does not show the error before Continue is pressed", () => {
    renderScreen();
    expect(screen.queryByText(COPY.ar.confirmRequired)).not.toBeInTheDocument();
  });
});

describe("Continue with the confirmation (S-04 section 4)", () => {
  it("wipes the memory, replaces the screen with the next one, and only once however often it is pressed", async () => {
    renderScreen();
    await userEvent.click(confirmBox());
    await userEvent.click(continueButton());
    await userEvent.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(peekRecoveryCode()).toBeNull();
  });

  it("wipes the memory at the press itself, before the history entry is given back and before the screen has gone", async () => {
    renderScreen();
    await userEvent.click(confirmBox());
    fireEvent.click(continueButton());
    expect(peekRecoveryCode()).toBeNull();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
  });

  it("gives the guard's history entry back first, so the next screen replaces the screen's own entry and back never returns here", async () => {
    renderScreen();
    expect(window.history.state).toEqual({ qatraRecoveryCodeGuard: true });
    await userEvent.click(confirmBox());
    await userEvent.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    expect(window.history.state).toEqual({ origin: true });
  });
});

describe("the leave dialog (S-04 sections 3 and 4)", () => {
  it("opens on Back while the box is unchecked: an alert dialog, titled and described, with Stay first and focused", async () => {
    renderScreen();
    await goBack();
    const dialog = await screen.findByRole("alertdialog", { name: COPY.ar.leave.title, description: COPY.ar.leave.body });
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([COPY.ar.leave.stay, COPY.ar.leave.leave]);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: COPY.ar.leave.stay }));
    expect(dialogs.showModal).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/recovery-code");
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).not.toBeNull();
  });

  it("is in English with the English wording", async () => {
    renderScreen({ language: "en" });
    await goBack();
    const dialog = await screen.findByRole("alertdialog", { name: "You have not confirmed saving the code", description: "If you leave now this code will not be shown again. You can create a new one in Settings." });
    expect(within(dialog).getByRole("button", { name: "Stay and save the code" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Leave without saving" })).toBeInTheDocument();
  });

  it("closes on Escape, which means stay, returns focus to the element that held it, and asks again on the next Back", async () => {
    renderScreen();
    copyButton().focus();
    await goBack();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(copyButton());
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).not.toBeNull();
    expect(window.history.state).toEqual({ qatraRecoveryCodeGuard: true });
    await goBack();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("closes on Stay and keeps the screen as it was, the code and the unchecked box included", async () => {
    renderScreen();
    await goBack();
    await userEvent.click(await screen.findByRole("button", { name: COPY.ar.leave.stay }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(block().textContent).toBe(MOCK_RECOVERY_CODE);
    expect(confirmBox()).not.toBeChecked();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("closes on a press of the backdrop, which is the safe action", async () => {
    renderScreen();
    await goBack();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("leaves without saving: wipes the code and goes to the next screen by replace, with the guard-9 banner raised for it", async () => {
    renderScreen();
    await goBack();
    await userEvent.click(await screen.findByRole("button", { name: COPY.ar.leave.leave }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(peekRecoveryCode()).toBeNull();
    expect(peekCodeUnavailable()).toBe(true);
  });

  it("leaves without saving after a Stay too: the guard's entry is given back before the next screen replaces the page", async () => {
    renderScreen();
    await goBack();
    await userEvent.click(await screen.findByRole("button", { name: COPY.ar.leave.stay }));
    await waitFor(() => expect(window.history.state).toEqual({ qatraRecoveryCodeGuard: true }));
    await goBack();
    await userEvent.click(await screen.findByRole("button", { name: COPY.ar.leave.leave }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    expect(window.history.state).toEqual({ origin: true });
  });

  it("does not open once the box is checked: Back then goes on to the page before", async () => {
    renderScreen();
    await userEvent.click(confirmBox());
    const goOn = vi.spyOn(window.history, "back");
    await goBack();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(goOn).toHaveBeenCalledTimes(2);
  });

  it("does not open from Continue: only a way out of the screen asks", async () => {
    renderScreen();
    await userEvent.click(continueButton());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("the browser's own prompt on closing or reloading (S-04 section 3)", () => {
  function unload(): Event {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it("is asked for only while the box is unchecked", async () => {
    renderScreen();
    expect(unload().defaultPrevented).toBe(true);
    await userEvent.click(confirmBox());
    expect(unload().defaultPrevented).toBe(false);
    await userEvent.click(confirmBox());
    expect(unload().defaultPrevented).toBe(true);
  });

  it("is not asked for once the screen has gone", () => {
    const { unmount } = renderScreen();
    unmount();
    expect(unload().defaultPrevented).toBe(false);
  });
});

describe("the code is wiped whichever way the screen goes (S-04 section 3)", () => {
  it("when the screen unmounts", () => {
    const { unmount } = renderScreen();
    expect(peekRecoveryCode()).not.toBeNull();
    unmount();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("when the page is hidden, and the page is loaded anew when it comes back from the back-forward cache", () => {
    renderScreen();
    window.dispatchEvent(new Event("pagehide"));
    expect(peekRecoveryCode()).toBeNull();
    expect(browser.reloadPage).not.toHaveBeenCalled();
    const restored = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    expect(browser.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("does not reload for an ordinary page show", () => {
    renderScreen();
    const shown = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(shown, "persisted", { value: false });
    window.dispatchEvent(shown);
    expect(browser.reloadPage).not.toHaveBeenCalled();
    expect(peekRecoveryCode()).not.toBeNull();
  });
});

describe("the code is nowhere but on the screen (UA-06, S-04 section 3)", () => {
  function assertNoLeak(label: string) {
    expect(window.location.href, `${label}: address`).not.toMatch(/0123|4567/);
    expect(document.title, `${label}: title`).not.toMatch(/0123|4567/);
    expect(JSON.stringify(window.history.state), `${label}: history state`).not.toMatch(/0123|4567|cdef/);
    expect(JSON.stringify({ ...localStorage }), `${label}: local storage`).not.toMatch(/0123|4567|cdef/);
    expect(JSON.stringify({ ...sessionStorage }), `${label}: session storage`).not.toMatch(/0123|4567|cdef/);
    expect(document.cookie, `${label}: cookies`).not.toMatch(/0123|4567|cdef/);
    for (const region of liveRegions()) expect(region.textContent, `${label}: live region`).not.toMatch(/0123|4567|cdef/);
  }

  it("is not in the address, the title, the history state, the storage, the cookies or any live region, whatever the learner does", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    renderScreen();
    assertNoLeak("arrival");
    await userEvent.click(copyButton());
    await screen.findByText(COPY.ar.copied);
    assertNoLeak("copied");
    await userEvent.click(downloadButton());
    assertNoLeak("downloaded");
    await userEvent.click(continueButton());
    assertNoLeak("unconfirmed");
    await goBack();
    await screen.findByRole("alertdialog");
    assertNoLeak("dialog");
    expect(document.querySelector("dialog")?.textContent).not.toMatch(/0123|4567|cdef/);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("is not in the notice when the clipboard refuses", async () => {
    stubClipboard(async () => Promise.reject(new Error("denied")));
    renderScreen();
    await userEvent.click(copyButton());
    const notice = await screen.findByText(COPY.ar.copyUnavailable);
    expect(notice.closest("[role=status]")?.textContent).not.toMatch(/0123|4567|cdef/);
    assertNoLeak("refused");
  });

});

describe("guard 9: the code is gone (UI-design 2.3, S-04 section 4)", () => {
  function scenario(signedIn: boolean, hasPlan = true) {
    return makeBackend({}, { signedIn, hasPlan });
  }

  it("shows only the empty frame while it finds out where the learner belongs: the header, no heading, no code, no controls", () => {
    renderScreen({ held: false, backend: scenario(false) });
    expect(screen.getByRole("banner")).toHaveTextContent(NAME.ar);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(document.title).toBe(TITLE.ar);
    expect(screen.getByRole("main").querySelector("[aria-busy=true]")).not.toBeNull();
  });

  it("sends a visitor to S-01 by replace, with the banner in the wording that says to log in first", async () => {
    const backend = scenario(false);
    renderScreen({ held: false, backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(peekLoginArrival()).toBe("code_unavailable");
    expect(peekCodeUnavailable()).toBe(false);
    expect(backend.calls).toContain("GET /api/me");
    expect(backend.calls).not.toContain("GET /api/today");
  });

  it("sends a learner with a plan to /today with the default banner raised", async () => {
    renderScreen({ held: false, backend: scenario(true, true) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(peekCodeUnavailable()).toBe(true);
    expect(peekLoginArrival()).toBeNull();
  });

  it("sends a learner without a plan to /start with the default banner raised", async () => {
    renderScreen({ held: false, backend: scenario(true, false) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    expect(peekCodeUnavailable()).toBe(true);
  });

  it("treats a sleeping server as a visitor, so S-01 asks again and sends a learner on", async () => {
    const backend = makeBackend({ "GET /api/me": () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    renderScreen({ held: false, backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(peekLoginArrival()).toBe("code_unavailable");
  });

  it("treats a value that is not a recovery code as no code at all, and wipes it", async () => {
    holdRecoveryCode("not a code", "register");
    renderScreen({ held: false, backend: scenario(false) });
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(peekRecoveryCode()).toBeNull();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
  });

  it("does not send the learner anywhere once the screen has gone", async () => {
    let release: (response: Response) => void = () => undefined;
    const backend = makeBackend({ "GET /api/me": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { unmount } = renderScreen({ held: false, backend });
    await waitFor(() => expect(backend.calls).toContain("GET /api/me"));
    unmount();
    release(new Response(JSON.stringify(mockProfile), { status: 200 }));
    await act(async () => undefined);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekCodeUnavailable()).toBe(false);
    expect(peekLoginArrival()).toBeNull();
  });

  it("makes no request but the session check and, for a learner, the plan check", async () => {
    const backend = scenario(true, true);
    renderScreen({ held: false, backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.calls.filter((call) => call !== "GET /api/health")).toEqual(["GET /api/me", "GET /api/today"]);
  });
});

describe("focus and keyboard (S-04 section 5)", () => {
  it("moves focus to the heading when the screen arrives by navigation, and does not steal it on a first load", () => {
    navigation.pathname = "/register";
    const first = renderScreen({ held: true });
    expect(document.activeElement).toBe(document.body);
    navigation.pathname = "/recovery-code";
    first.rerender(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <RecoveryCodeScreen />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    expect(document.activeElement).toBe(h1());
  });

  it("tabs from the skip link to Copy, Download, the box and Continue, and nothing else", async () => {
    const user = userEvent.setup();
    renderScreen();
    const order = [screen.getByRole("link", { name: SKIP.ar }), copyButton(), downloadButton(), confirmBox(), continueButton()];
    for (const expected of order) {
      await user.tab();
      expect(document.activeElement).toBe(expected);
    }
    expect(document.activeElement).not.toBe(block());
  });

  // The direct calls of user-event are used here: setup() would put its own clipboard in the place of the one under test.
  it("toggles the box with Space and presses the buttons with Enter", async () => {
    renderScreen();
    confirmBox().focus();
    await userEvent.keyboard(" ");
    expect(confirmBox()).toBeChecked();
    await userEvent.keyboard(" ");
    expect(confirmBox()).not.toBeChecked();
    copyButton().focus();
    await userEvent.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledTimes(1);
    downloadButton().focus();
    await userEvent.keyboard("{Enter}");
    expect(files).toHaveLength(1);
  });

  it("keeps the code block out of the tab order and out of every focusable query", () => {
    renderScreen();
    const stops = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]:not([tabindex='-1'])"));
    expect(stops.some((stop) => block().contains(stop))).toBe(false);
  });
});

describe("English and right-to-left (S-04 section 5)", () => {
  it("renders every string in English, left to right, and titles the page in English", () => {
    renderScreen({ language: "en", host: "recovery" });
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toBe(TITLE.en);
    expect(screen.getByRole("heading", { level: 1, name: H1.en })).toBeInTheDocument();
    expect(screen.getByText(COPY.en.step)).toBeInTheDocument();
    expect(screen.getByText(`${COPY.en.lead} ${COPY.en.oldCodeInvalid}`)).toBeInTheDocument();
    expect(screen.getByText(COPY.en.warning)).toBeInTheDocument();
    expect(copyButton("en")).toBeInTheDocument();
    expect(downloadButton("en")).toBeInTheDocument();
    expect(confirmBox("en")).toBeInTheDocument();
    expect(continueButton("en")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: SKIP.en })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent(NAME.en);
  });

  it("keeps the code block left to right inside a right-to-left page, with the glyphs of Copy and Download unmirrored", () => {
    renderScreen({ language: "ar" });
    expect(document.documentElement.dir).toBe("rtl");
    expect(block()).toHaveAttribute("dir", "ltr");
    for (const svg of Array.from(block().ownerDocument.querySelectorAll("button svg"))) expect(svg.getAttribute("class")).not.toContain("rtl:-scale-x-100");
  });

  it("gives every string in English the same structure as in Arabic: the same controls in the same order", () => {
    const { unmount } = renderScreen({ language: "ar", host: "recovery" });
    const ar = screen.getAllByRole("button").length;
    unmount();
    renderScreen({ language: "en", host: "recovery" });
    expect(screen.getAllByRole("button")).toHaveLength(ar);
  });
});

describe("the screens that receive the note of S-04", () => {
  function renderStart(language: Language = "ar") {
    setLanguage(language);
    runtime = createApiRuntime({ mode: "live", fetch: makeBackend().fetchImpl });
    return render(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <StartPage />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
  }

  it("S-08 (a placeholder for now) shows the Info banner once, with the default wording, and not as an alert", () => {
    raiseCodeUnavailable();
    renderStart();
    const banner = screen.getByText(COPY.ar.unavailable).closest("div.rounded-md") as HTMLElement;
    expect(banner).toHaveClass("border-info-edge", "bg-info-tint", "text-info-ink");
    expect(banner).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The note has done its job: a second visit does not show it again.
    expect(peekCodeUnavailable()).toBe(false);
    expect(screen.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toBeInTheDocument();
  });

  it("S-08 shows nothing when no note was raised, and nothing once it has expired", () => {
    renderStart().unmount();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    raiseCodeUnavailable();
    now = 31_000;
    renderStart();
    expect(screen.queryByText(COPY.ar.unavailable)).not.toBeInTheDocument();
  });

  it("S-08 shows nothing when no note was raised", () => {
    renderStart();
    expect(screen.queryByText(COPY.ar.unavailable)).not.toBeInTheDocument();
  });

  it("S-08 gives the banner in English, and a dismiss control of 44 px that puts focus on the heading", async () => {
    raiseCodeUnavailable();
    renderStart("en");
    expect(screen.getByText(COPY.en.unavailable)).toBeInTheDocument();
    const dismiss = screen.getByRole("button", { name: "Dismiss message" });
    expect(dismiss).toHaveClass("size-target");
    await userEvent.click(dismiss);
    expect(screen.queryByText(COPY.en.unavailable)).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "What is your plan?" }));
  });

  it("S-01 shows the Info banner with the wording that says to log in first, once, dismissible, and not as an alert", () => {
    raiseLoginArrival("code_unavailable");
    setLanguage("ar");
    runtime = createApiRuntime({ mode: "live", fetch: makeBackend().fetchImpl });
    render(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <LoginForm />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    const banner = screen.getByText(COPY.ar.unavailableRecovery).closest("div.rounded-md") as HTMLElement;
    expect(banner).toHaveClass("border-info-edge", "bg-info-tint");
    expect(banner).not.toHaveAttribute("role");
    expect(within(banner).getByRole("button", { name: "إغلاق التنبيه" })).toBeInTheDocument();
    expect(peekLoginArrival()).toBeNull();
  });

  it("S-01 gives the stronger arrival banner when two are raised", () => {
    raiseLoginArrival("code_unavailable");
    raiseLoginArrival("reset_done");
    setLanguage("ar");
    runtime = createApiRuntime({ mode: "live", fetch: makeBackend().fetchImpl });
    render(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <LoginForm />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    expect(screen.getByText("تم تعيين كلمة مرور جديدة. سجّل الدخول بها.")).toBeInTheDocument();
    expect(screen.queryByText(COPY.ar.unavailableRecovery)).not.toBeInTheDocument();
  });
});
