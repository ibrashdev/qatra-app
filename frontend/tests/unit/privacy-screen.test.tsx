import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/privacy", useRouter: () => navigation.router }));
// The build's terms version, which the version line shows.
const config = vi.hoisted(() => ({ termsVersion: "2026-10-04" as string | null }));
vi.mock("@/lib/config", () => ({
  API_MODE: "live",
  get TERMS_VERSION() {
    return config.termsVersion;
  },
}));

import { PrivacyScreen } from "@/components/privacy/PrivacyScreen";
import { AppShell } from "@/components/ui/AppShell";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { D53_NOTICE_AR, PLAN_CONVERSATION_AR, TRANSPARENCY_LINE_AR } from "@/i18n/terms-text";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { mockProfile } from "@/lib/api/mock/fixtures";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

const AR = {
  title: "شروط الاستخدام وبيان الخصوصية",
  termsHeading: "شروط الاستخدام",
  privacyHeading: "بيان الخصوصية",
  topics: ["الكتاب كما هو", "صحة المراجع", "لا فتوى ولا شرح", "البيانات التي نجمعها", "بيانات الحساب والنموذج الخارجي", "الحذف والاحتفاظ", "ما لا نستنتجه عنك"],
  version: "إصدار الشروط: 2026-10-04",
  back: "رجوع إلى الإعدادات",
  returnButton: "العودة إلى الإعدادات",
  documentTitle: "شروط الاستخدام وبيان الخصوصية · قطرة غيث",
};

const EN = {
  title: "Terms of use and privacy statement",
  termsHeading: "Terms of use",
  privacyHeading: "Privacy statement",
  version: "Terms version: 2026-10-04",
  back: "Back to Settings",
  returnButton: "Back to Settings",
  documentTitle: "Terms of use and privacy statement · Qatra",
};

// The version line is one paragraph whose value sits in a bdi, so the text is matched on the paragraph as a whole.
const versionLine = (text: string): HTMLElement => screen.getByText((_, element) => element?.tagName === "P" && element.textContent === text);

type MeAnswer = () => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const healthy = (): Response => json({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" });
const sessionEnded = (): Response => json({ error: { code: "unauthenticated", message: "x", details: {} } }, 401);
const failed = (status: number, code: string): MeAnswer => () => json({ error: { code, message: "x", details: {} } }, status);

let runtime: ApiRuntime | undefined;
// jsdom does not scroll and has no scrollIntoView: the calls are recorded, by the id of the element that was scrolled to.
let scrolledTo: string[] = [];
const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;

function renderPrivacy({ language = "ar", me = (): Response => json(mockProfile), shell = false }: { language?: "ar" | "en"; me?: MeAnswer; shell?: boolean } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    calls.push(url.pathname);
    return url.pathname === "/api/me" ? me() : healthy();
  });
  runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const get = vi.spyOn(runtime.client, "get");
  const screenNode = <PrivacyScreen />;
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{shell ? <AppShell>{screenNode}</AppShell> : screenNode}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, calls, get, reads: () => calls.filter((path) => path === "/api/me").length };
}

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  config.termsVersion = "2026-10-04";
  resetRouteFocusForTests();
  scrolledTo = [];
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolledTo.push(this.id);
  };
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  runtime = undefined;
  window.history.replaceState(null, "", "/");
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  localStorage.clear();
  resetLocaleStoreForTests();
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
});

describe("S-26 Privacy and data: the screen", () => {
  it("shows the H1, the back control to Settings, the version line, both parts with their anchors, the topics and the closing button", () => {
    renderPrivacy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.back })).toHaveAttribute("href", "/settings");
    expect(versionLine(AR.version)).toBeInTheDocument();

    const terms = screen.getByRole("heading", { level: 2, name: AR.termsHeading });
    const privacy = screen.getByRole("heading", { level: 2, name: AR.privacyHeading });
    expect(terms).toHaveAttribute("id", "terms");
    expect(terms).toHaveAttribute("tabindex", "-1");
    expect(privacy).toHaveAttribute("id", "privacy");
    expect(privacy).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(AR.topics);

    const closing = screen.getByRole("link", { name: AR.returnButton });
    expect(closing).toHaveAttribute("href", "/settings");
    expect(document.title).toBe(AR.documentTitle);
  });

  it("shows the version inside a bdi and leaves the line out when the build has no version", () => {
    const view = renderPrivacy();
    expect(within(versionLine(AR.version)).getByText("2026-10-04").tagName).toBe("BDI");
    view.unmount();
    config.termsVersion = null;
    renderPrivacy();
    expect(screen.queryByText(/إصدار الشروط/)).toBeNull();
  });

  it("has the fixed sentences of the text, and no agree control, cookie banner or outbound link", () => {
    renderPrivacy();
    for (const sentence of [D53_NOTICE_AR, TRANSPARENCY_LINE_AR, PLAN_CONVERSATION_AR]) expect(screen.getByText((content) => content.includes(sentence))).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/settings", "/settings"]);
  });

  it("is written in English with the English back control and button", () => {
    renderPrivacy({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: EN.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: EN.termsHeading })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: EN.privacyHeading })).toBeInTheDocument();
    expect(versionLine(EN.version)).toBeInTheDocument();
    // The spec gives the back control and the closing button the same English name, so two links answer to it, both to Settings.
    const links = screen.getAllByRole("link", { name: EN.back });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute("href", "/settings");
    expect(document.title).toBe(EN.documentTitle);
  });

  it("renders the whole text at once and never waits for the session read", () => {
    renderPrivacy({ me: () => new Promise<Response>(() => undefined) });
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(AR.topics.length);
    expect(screen.queryByTestId("settings-skeleton")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("S-26 Privacy and data: guard 13", () => {
  it("makes one untracked read of the profile", async () => {
    const view = renderPrivacy();
    await waitFor(() => expect(view.reads()).toBe(1));
    expect(view.get).toHaveBeenCalledWith("/me", expect.objectContaining({ track: false }));
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["#privacy", "/terms#privacy"],
    ["#terms", "/terms#terms"],
    ["", "/terms"],
    ["#other", "/terms"],
  ])("replaces the route with S-03 when the session has ended, keeping only a known anchor (%s)", async (hash, target) => {
    window.history.replaceState(null, "", `/settings/privacy${hash}`);
    renderPrivacy({ me: sessionEnded });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(target));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it.each([
    ["a 500", failed(500, "internal")],
    ["a 503", failed(503, "unavailable")],
    ["no answer", (): Response => Promise.reject(new TypeError("offline")) as unknown as Response],
    ["a gateway page", (): Response => new Response("<html></html>", { status: 502 })],
  ])("ignores %s: the text stays and there is no banner", async (_label, me) => {
    const view = renderPrivacy({ me });
    await waitFor(() => expect(view.reads()).toBe(1));
    // Let the read settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not hand over a learner whose session is valid", async () => {
    const view = renderPrivacy({ me: () => json(mockProfile) });
    await waitFor(() => expect(view.reads()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("stops the read when the screen is left", async () => {
    const view = renderPrivacy({ me: () => new Promise<Response>(() => undefined) });
    await waitFor(() => expect(view.get).toHaveBeenCalled());
    const signal = (view.get.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("S-26 Privacy and data: anchors in the app shell", () => {
  it("focuses the privacy heading when it is opened with #privacy", () => {
    window.history.replaceState(null, "", "/settings/privacy#privacy");
    renderPrivacy({ shell: true });
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toHaveFocus();
    expect(scrolledTo).toContain("privacy");
  });

  it("focuses the terms heading when it is opened with #terms", () => {
    window.history.replaceState(null, "", "/settings/privacy#terms");
    renderPrivacy({ shell: true });
    expect(screen.getByRole("heading", { level: 2, name: AR.termsHeading })).toHaveFocus();
  });

  it("starts with no focus on first load without an anchor", () => {
    renderPrivacy({ shell: true });
    expect(document.body).toHaveFocus();
  });

  it("keeps the H1 as the one page heading the shell moves focus to after a route change", () => {
    renderPrivacy({ shell: true });
    const heading = screen.getByRole("heading", { level: 1, name: AR.title });
    expect(heading).toHaveAttribute("data-page-heading");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});
