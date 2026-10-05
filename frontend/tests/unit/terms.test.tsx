import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/terms", router: { back: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => navigation.router }));
// The build's terms version, which the version line shows.
const config = vi.hoisted(() => ({ termsVersion: "2026-10-04" as string | null }));
vi.mock("@/lib/config", () => ({
  API_MODE: "live",
  get TERMS_VERSION() {
    return config.termsVersion;
  },
}));

import { TermsBody } from "@/components/terms/TermsBody";
import { TermsError } from "@/components/terms/TermsError";
import { TermsLoading } from "@/components/terms/TermsLoading";
import { TermsScreen } from "@/components/terms/TermsScreen";
import { PublicShell } from "@/components/ui/PublicShell";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { D53_NOTICE_AR, D53_NOTICE_EN, PLAN_CONVERSATION_AR, PLAN_CONVERSATION_EN, TRANSPARENCY_LINE_AR, TRANSPARENCY_LINE_EN } from "@/i18n/terms-text";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { noteRoute, resetRouteHistoryForTests } from "@/lib/nav/route-history";

const AR = {
  title: "شروط الاستخدام وبيان الخصوصية",
  termsHeading: "شروط الاستخدام",
  privacyHeading: "بيان الخصوصية",
  topics: ["الكتاب كما هو", "صحة المراجع", "لا فتوى ولا شرح", "البيانات التي نجمعها", "بيانات الحساب والنموذج الخارجي", "الحذف والاحتفاظ", "ما لا نستنتجه عنك"],
  version: "إصدار الشروط: 2026-10-04",
  skip: "انتقل إلى المحتوى",
  backHome: "رجوع إلى الصفحة الرئيسية",
  backRegister: "رجوع إلى إنشاء الحساب",
  backConsent: "رجوع إلى الموافقة",
  returnHome: "العودة إلى الصفحة الرئيسية",
  returnRegister: "العودة إلى إنشاء الحساب",
  returnConsent: "العودة إلى الموافقة",
  unavailable: "تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.",
  retry: "إعادة المحاولة",
  loading: "جارٍ التحميل",
  documentTitle: "شروط الاستخدام وبيان الخصوصية · قطرة غيث",
};

const EN = {
  title: "Terms of use and privacy statement",
  termsHeading: "Terms of use",
  privacyHeading: "Privacy statement",
  topics: ["The book as it is", "Accuracy of references", "No fatwa or explanation", "Data we collect", "Account data and external models", "Deletion and retention", "What we do not infer"],
  version: "Terms version: 2026-10-04",
  backHome: "Back to Home",
  backRegister: "Back to Create account",
  returnHome: "Back to home",
  returnRegister: "Back to create account",
  unavailable: "The terms of use and privacy statement could not be opened. Check your connection and try again.",
  retry: "Try again",
  loading: "Loading",
  documentTitle: "Terms of use and privacy statement · Qatra",
};

const healthy = () => new Response(JSON.stringify({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }), { status: 200 });

let runtime: ApiRuntime;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderTerms(ui: ReactNode) {
  fetchImpl = vi.fn<typeof fetch>(async () => healthy());
  runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

// True when `after` comes later in the page than `before`: the DOM order that the layout and the focus order of the spec rest on.
const follows = (before: Element, after: Element): boolean => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

// The version line is one paragraph whose value sits in a bdi, so the text is matched on the paragraph as a whole.
const versionLine = (text: string): HTMLElement => screen.getByText((_, element) => element?.tagName === "P" && element.textContent === text);

// jsdom does not scroll and has no scrollIntoView: an anchored visit calls it, so it is stood in for.
const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  resetRouteHistoryForTests();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  config.termsVersion = "2026-10-04";
  navigation.pathname = "/terms";
  navigation.router.back.mockReset();
  navigation.router.push.mockReset();
  window.history.replaceState(null, "", "/terms");
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

describe("S-03 structure (UI-screens S-03 sections 2, 3 and 5)", () => {
  it("shows the heading, the version line, the terms part with its topics, the divider, the privacy part with its topics and the closing button, in the order of the spec", () => {
    setLanguage("ar");
    const { container } = renderTerms(<TermsScreen />);
    const h1 = screen.getByRole("heading", { level: 1, name: AR.title });
    const version = versionLine(AR.version);
    const termsHeading = screen.getByRole("heading", { level: 2, name: AR.termsHeading });
    const privacyHeading = screen.getByRole("heading", { level: 2, name: AR.privacyHeading });
    const topics = screen.getAllByRole("heading", { level: 3 });
    const divider = container.querySelector("hr") as HTMLElement;
    const button = screen.getByRole("button", { name: AR.returnHome });

    expect(topics.map((topic) => topic.textContent)).toEqual(AR.topics);
    const [bookAsItIs, references, fatwa, data, external, deletion, inference] = topics as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    for (const [before, after] of [
      [h1, version],
      [version, termsHeading],
      [termsHeading, bookAsItIs],
      [bookAsItIs, references],
      [references, fatwa],
      [fatwa, divider],
      [divider, privacyHeading],
      [privacyHeading, data],
      [data, external],
      [external, deletion],
      [deletion, inference],
      [inference, button],
    ] as const) {
      expect(follows(before, after), `${before.textContent?.slice(0, 20)} before ${after.textContent?.slice(0, 20)}`).toBe(true);
    }
  });

  it("has one H1, then H2 and H3 in order, real lists, and a decorative divider", () => {
    setLanguage("ar");
    const { container } = renderTerms(<TermsScreen />);
    expect(screen.getAllByRole("heading").map((heading) => Number(heading.tagName.slice(1)))).toEqual([1, 2, 3, 3, 3, 2, 3, 3, 3, 3]);
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(1);
    expect(within(lists[0] as HTMLElement).getAllByRole("listitem")).toHaveLength(9);
    expect(container.querySelector("hr")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("hr")).toHaveLength(1);
  });

  it("gives each part an anchor that can take focus: #terms and #privacy on the two H2", () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const termsAnchor = document.getElementById("terms");
    const privacyAnchor = document.getElementById("privacy");
    expect(termsAnchor).toBe(screen.getByRole("heading", { level: 2, name: AR.termsHeading }));
    expect(privacyAnchor).toBe(screen.getByRole("heading", { level: 2, name: AR.privacyHeading }));
    for (const anchor of [termsAnchor, privacyAnchor]) expect(anchor).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("tabindex", "-1");
  });

  it("shows the version in a bdi, so it keeps its order in right-to-left text, and leaves the line out when the build has no version", () => {
    setLanguage("ar");
    const first = renderTerms(<TermsScreen />);
    const line = versionLine(AR.version);
    expect(line.tagName).toBe("P");
    expect(within(line).getByText("2026-10-04").tagName).toBe("BDI");
    first.unmount();

    config.termsVersion = null;
    renderTerms(<TermsScreen />);
    expect(screen.queryByText(/إصدار الشروط/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: AR.termsHeading })).toBeInTheDocument();
  });

  it("quotes the fixed sentences: the notice of the book, the transparency line of P-15 and the plan-conversation paragraph, and not the earlier rules-engine sentence", () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent(`«${D53_NOTICE_AR}»`);
    expect(main).toHaveTextContent(`«${TRANSPARENCY_LINE_AR}»`);
    expect(main).toHaveTextContent(PLAN_CONVERSATION_AR);
    expect(main).not.toHaveTextContent("أثناء التحدي");
    expect(main).not.toHaveTextContent("وكيل التعليم");
  });

  it("offers nothing to agree to or fill in: no checkbox, no field, no link in the text, and the closing button is the only control in the page", () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const main = screen.getByRole("main");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(main).queryAllByRole("link")).toHaveLength(0);
    expect(within(main).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByText(/cookie|ملفات تعريف الارتباط|أوافق/i)).not.toBeInTheDocument();
  });

  it("uses the interface fonts only: the fonts of the religious text are not applied anywhere on the page", () => {
    setLanguage("ar");
    const { container } = renderTerms(<TermsScreen />);
    expect(container.innerHTML).not.toMatch(/font-hadith|font-quran|text-hadith|text-quran/);
  });

  it("sets the document title and leaves focus alone on the first load", () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    expect(document.title).toBe(AR.documentTitle);
    expect(document.body).toHaveFocus();
  });

  it("has the header of the spec: the back control and the language switch, no lockup and no wake-up line", () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const header = screen.getByRole("banner");
    expect(within(header).getAllByRole("link")).toHaveLength(1);
    expect(within(header).getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByText("قطرة غيث")).not.toBeInTheDocument();
    expect(screen.queryByText(/جارٍ تشغيل الخادم/)).not.toBeInTheDocument();
  });

  it("uses the reading column as the text measure, in all three views: 640 px below 1024, 720 px from 1024, the page margins outside it", () => {
    setLanguage("ar");
    for (const view of [<TermsScreen key="screen" />, <TermsLoading key="loading" />, <TermsError key="error" retry={vi.fn()} />]) {
      const { unmount } = renderTerms(view);
      const main = screen.getByRole("main");
      expect(main).toHaveClass("max-w-[calc(40rem+2*var(--q-page-margin))]", "rail:max-w-[calc(45rem+2*var(--q-page-margin))]");
      expect(main).not.toHaveClass("max-w-column");
      unmount();
    }
  });

  it("closes with a button of the secondary recipe, not the primary one: it returns, it does not agree", () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const button = screen.getByRole("button", { name: AR.returnHome });
    expect(button).toHaveClass("bg-surface", "text-primary-deep");
    expect(button).not.toHaveClass("bg-primary");
  });

  it("shows no wake-up line while the server is waking, though other public screens do: the page has nothing to wait for", async () => {
    setLanguage("ar");
    fetchImpl = vi.fn<typeof fetch>(async () => new Response("Bad gateway", { status: 502 }));
    runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
    const inApp = (view: ReactNode) => (
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>{view}</ApiRuntimeProvider>
      </LocaleProvider>
    );
    // The control: the same server, asleep, shows its line on a screen that waits for it.
    const control = render(inApp(<PublicShell>content</PublicShell>));
    await waitFor(() => expect(screen.getByText(/جارٍ تشغيل الخادم/)).toBeInTheDocument());
    control.unmount();
    render(inApp(<TermsScreen />));
    expect(screen.queryByText(/جارٍ تشغيل الخادم/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toBeInTheDocument();
  });

  it("calls no API of its own and has no session probe: nothing but the first health request goes out", async () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input), "http://localhost").pathname);
    expect([...new Set(paths)]).toEqual(["/api/health"]);
  });

  it("tabs through the skip link, the back control, the switch and the closing button, and the text holds nothing else", async () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const order: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await userEvent.tab();
      const element = document.activeElement as HTMLElement;
      order.push(element.getAttribute("aria-label") ?? (element.textContent ?? "").trim());
    }
    expect(order).toEqual([AR.skip, AR.backHome, "العربية", AR.returnHome]);
    // Nothing follows the button: the next stop leaves the page.
    await userEvent.tab();
    expect(document.body).toHaveFocus();
  });

  it("renders the body alone for the app shell (S-26): no H1, no back control, no closing button", () => {
    setLanguage("ar");
    renderTerms(<TermsBody />);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(versionLine(AR.version)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.id)).toEqual(["terms", "privacy"]);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(7);
  });
});

describe("S-03 in English (the language switch)", () => {
  it("shows the same page in English, left to right, with the proposed wording and the fixed sentences", () => {
    setLanguage("en");
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("heading", { level: 1, name: EN.title })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((topic) => topic.textContent)).toEqual(EN.topics);
    expect(screen.getByRole("heading", { level: 2, name: EN.termsHeading })).toHaveAttribute("id", "terms");
    expect(screen.getByRole("heading", { level: 2, name: EN.privacyHeading })).toHaveAttribute("id", "privacy");
    expect(versionLine(EN.version)).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent(`“${D53_NOTICE_EN}”`);
    expect(main).toHaveTextContent(`“${TRANSPARENCY_LINE_EN}”`);
    expect(main).toHaveTextContent(PLAN_CONVERSATION_EN);
    expect(screen.getByRole("button", { name: EN.returnHome })).toBeInTheDocument();
    expect(document.title).toBe(EN.documentTitle);
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
  });

  it("rewrites the whole page when the language is switched, keeps the page, and leaves focus on the switch (state «language switched»)", async () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    const before = screen.getByRole("main");
    await userEvent.click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(screen.getByRole("main")).toBe(before);
    expect(screen.getByRole("heading", { level: 1, name: EN.title })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((topic) => topic.textContent)).toEqual(EN.topics);
    expect(screen.getByRole("link", { name: EN.backHome })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: EN.returnHome })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English (EN)" })).toHaveFocus();
    expect(screen.getByText("Language changed to English")).toBeInTheDocument();
  });
});

describe("S-03 exit: back to the opener with its state kept, or to / when opened directly (S-03 section 1, P-02)", () => {
  it("opened directly: the back control is a link to / and the closing button goes to / too", async () => {
    setLanguage("ar");
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("link", { name: AR.backHome })).toHaveAttribute("href", "/");
    await userEvent.click(screen.getByRole("button", { name: AR.returnHome }));
    expect(navigation.router.push).toHaveBeenCalledWith("/");
    expect(navigation.router.back).not.toHaveBeenCalled();
  });

  it("opened from the register form: both controls name it and take one step back in the history, which brings the form back as it was", async () => {
    setLanguage("ar");
    noteRoute("/register");
    renderTerms(<TermsScreen />);
    expect(screen.queryByRole("link", { name: AR.backRegister })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: AR.backRegister }));
    await userEvent.click(screen.getByRole("button", { name: AR.returnRegister }));
    expect(navigation.router.back).toHaveBeenCalledTimes(2);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("opened from the re-consent gate: both controls name the gate", async () => {
    setLanguage("ar");
    noteRoute("/consent");
    renderTerms(<TermsScreen />);
    await userEvent.click(screen.getByRole("button", { name: AR.backConsent }));
    expect(screen.getByRole("button", { name: AR.returnConsent })).toBeInTheDocument();
    expect(navigation.router.back).toHaveBeenCalledTimes(1);
  });

  it("treats any other earlier screen as a direct visit", () => {
    setLanguage("ar");
    noteRoute("/login");
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("link", { name: AR.backHome })).toHaveAttribute("href", "/");
  });

  it("finds the opener whether the tracker has already noted this route or not, and keeps it when the tracker notes it later", () => {
    setLanguage("ar");
    // The loading view mounts first and the tracker has already seen /terms by the time the screen replaces it.
    noteRoute("/register");
    noteRoute("/terms");
    const screenAfterTracker = renderTerms(<TermsScreen />);
    expect(screen.getByRole("button", { name: AR.backRegister })).toBeInTheDocument();
    screenAfterTracker.unmount();

    resetRouteHistoryForTests();
    noteRoute("/register");
    const { rerender } = renderTerms(<TermsScreen />);
    expect(screen.getByRole("button", { name: AR.backRegister })).toBeInTheDocument();
    noteRoute("/terms");
    rerender(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <TermsScreen />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: AR.backRegister })).toBeInTheDocument();
  });

  it("keeps the opener it found when the history moves on while the screen is still mounted", () => {
    setLanguage("ar");
    noteRoute("/register");
    const { rerender } = renderTerms(<TermsScreen />);
    noteRoute("/terms");
    noteRoute("/login");
    rerender(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <TermsScreen />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: AR.backRegister })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: AR.backHome })).not.toBeInTheDocument();
  });

  it("names the opener in English, and a language switch renames it", async () => {
    setLanguage("ar");
    noteRoute("/register");
    renderTerms(<TermsScreen />);
    await userEvent.click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(screen.getByRole("button", { name: EN.backRegister })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: EN.returnRegister })).toBeInTheDocument();
  });

  it("does nothing on Escape: the page stays and nothing is called", async () => {
    setLanguage("ar");
    noteRoute("/register");
    renderTerms(<TermsScreen />);
    await userEvent.keyboard("{Escape}");
    expect(navigation.router.back).not.toHaveBeenCalled();
    expect(navigation.router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toBeInTheDocument();
  });
});

describe("S-03 route loading (state table)", () => {
  it("shows the header and the heading at once and a skeleton only after 300 ms, announced as loading, busy, and with focus where it was", async () => {
    setLanguage("ar");
    vi.useFakeTimers();
    const { container } = renderTerms(<TermsLoading />);
    const region = container.querySelector("[aria-busy=true]") as HTMLElement;
    expect(region).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.backHome })).toBeInTheDocument();
    // The announcement region is in the page from the start and empty, so what is added to it is read.
    const status = within(region).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();
    expect(region.querySelectorAll("[aria-hidden=true]")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(status).toBeEmptyDOMElement();
    expect(region.querySelectorAll("[aria-hidden=true]")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(status).toHaveTextContent(AR.loading);
    const blocks = region.querySelectorAll("[aria-hidden=true]");
    expect(blocks.length).toBeGreaterThan(0);
    // Everything that looks like content is decorative, and the region holds no text besides the announcement.
    expect(region.textContent).toBe(AR.loading);
    expect(document.body).toHaveFocus();
  });

  it("announces «Loading» in English", async () => {
    setLanguage("en");
    vi.useFakeTimers();
    const { container } = renderTerms(<TermsLoading />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect((container.querySelector("[aria-busy=true]") as HTMLElement).textContent).toBe(EN.loading);
  });

  it("has no control of its own besides the header, and shows no skeleton colours outside the token fill", () => {
    setLanguage("ar");
    vi.useFakeTimers();
    renderTerms(<TermsLoading />);
    expect(within(screen.getByRole("main")).queryAllByRole("button")).toHaveLength(0);
    expect(within(screen.getByRole("main")).queryAllByRole("link")).toHaveLength(0);
  });

  it("does not use up the route change: the screen that follows still moves focus to its heading", () => {
    setLanguage("ar");
    navigation.pathname = "/register";
    renderTerms(<PublicShell>page</PublicShell>).unmount();
    navigation.pathname = "/terms";
    const loading = renderTerms(<TermsLoading />);
    expect(document.body).toHaveFocus();
    loading.unmount();
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toHaveFocus();
  });
});

describe("S-03 text unavailable (state table)", () => {
  it("shows the error banner as an alert with its own icon and the retry button, and moves focus to the button", () => {
    setLanguage("ar");
    const retry = vi.fn();
    renderTerms(<TermsError retry={retry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(AR.unavailable);
    expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    const button = within(alert).getByRole("button", { name: AR.retry });
    expect(button).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).not.toHaveFocus();
    expect(document.title).toBe(AR.documentTitle);
  });

  it("calls retry once per press, and the back control and the switch stay in the header", async () => {
    setLanguage("ar");
    const retry = vi.fn();
    renderTerms(<TermsError retry={retry} />);
    await userEvent.click(screen.getByRole("button", { name: AR.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: AR.backHome })).toBeInTheDocument();
    expect(within(header).getAllByRole("radio")).toHaveLength(2);
  });

  it("is worded in English too", () => {
    setLanguage("en");
    renderTerms(<TermsError retry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(EN.unavailable);
    expect(screen.getByRole("button", { name: EN.retry })).toHaveFocus();
  });

  it("does not use up the route change, so a successful retry lands on the heading of the screen", async () => {
    setLanguage("ar");
    navigation.pathname = "/register";
    renderTerms(<PublicShell>page</PublicShell>).unmount();
    navigation.pathname = "/terms";
    const failed = renderTerms(<TermsError retry={vi.fn()} />);
    failed.unmount();
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toHaveFocus();
  });
});

describe("S-03 anchors", () => {
  it("opened with #privacy, the privacy heading takes focus and the page heading does not", () => {
    setLanguage("ar");
    navigation.pathname = "/register";
    renderTerms(<PublicShell>page</PublicShell>).unmount();
    navigation.pathname = "/terms";
    window.history.replaceState(null, "", "/terms#privacy");
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toHaveFocus();
  });

  it("opened with #terms on a first load, the terms heading takes focus", () => {
    setLanguage("ar");
    window.history.replaceState(null, "", "/terms#terms");
    renderTerms(<TermsScreen />);
    expect(screen.getByRole("heading", { level: 2, name: AR.termsHeading })).toHaveFocus();
  });
});
