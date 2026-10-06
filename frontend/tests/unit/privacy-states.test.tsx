import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/settings", router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => navigation.router }));
vi.mock("@/lib/config", () => ({ API_MODE: "live", TERMS_VERSION: "2026-10-04" }));

import Loading from "@/app/(app)/settings/privacy/loading";
import PrivacyRouteError from "@/app/(app)/settings/privacy/error";
import PrivacyLayout from "@/app/(app)/settings/privacy/layout";
import { PrivacyScreen } from "@/components/privacy/PrivacyScreen";
import { AppShell } from "@/components/ui/AppShell";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { mockProfile } from "@/lib/api/mock/fixtures";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

// S-26 "Route loading; text unavailable" (UI-screens S-26 section 4): the frame of the route stays, a skeleton shows after 300 ms with the wait announced,
// and a failed chunk gives the error banner with its retry button. The shell's route focus must land on a heading that does not unmount.

const AR = {
  title: "شروط الاستخدام وبيان الخصوصية",
  privacyHeading: "بيان الخصوصية",
  termsHeading: "شروط الاستخدام",
  loading: "جارٍ التحميل",
  unavailable: "تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.",
  retry: "إعادة المحاولة",
  back: "رجوع إلى الإعدادات",
};
const EN = {
  title: "Terms of use and privacy statement",
  loading: "Loading",
  unavailable: "The terms of use and privacy statement could not be opened. Check your connection and try again.",
  retry: "Try again",
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let runtime: ApiRuntime | undefined;
let scrolledTo: string[] = [];
const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;

function Providers({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime as ApiRuntime}>{children}</ApiRuntimeProvider>
    </LocaleProvider>
  );
}

// The app shell around the layout of the route, around what the segment shows below the frame: the loading view, the failure view or the page.
const route = (content: ReactNode): ReactNode => (
  <AppShell>
    <PrivacyLayout>{content}</PrivacyLayout>
  </AppShell>
);

function renderRoute(content: ReactNode, language: "ar" | "en" = "ar") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  runtime = createApiRuntime({
    mode: "live",
    fetch: vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
      return url.pathname === "/api/me" ? json(mockProfile) : json({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" });
    }),
  });
  return render(route(content), { wrapper: Providers });
}

beforeEach(() => {
  vi.useRealTimers();
  navigation.pathname = "/settings";
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  resetRouteFocusForTests();
  scrolledTo = [];
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolledTo.push(this.id);
  };
});

afterEach(() => {
  vi.useRealTimers();
  runtime?.wakeUp.dispose();
  runtime = undefined;
  window.history.replaceState(null, "", "/");
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  localStorage.clear();
  resetLocaleStoreForTests();
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
});

describe("S-26 the frame of the route", () => {
  it("holds the H1 as the page heading, the back control to Settings and the page title, around whatever the segment shows", () => {
    renderRoute(<p>below</p>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const heading = screen.getByRole("heading", { level: 1, name: AR.title });
    expect(heading).toHaveAttribute("data-page-heading");
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("link", { name: AR.back })).toHaveAttribute("href", "/settings");
    expect(document.title).toBe(`${AR.title} · قطرة غيث`);
    expect(screen.getByText("below")).toBeInTheDocument();
  });
});

describe("S-26 route loading", () => {
  it("shows the frame at once and a skeleton only after 300 ms, announced as loading, busy, with focus where it was", async () => {
    vi.useFakeTimers();
    const { container } = renderRoute(<Loading />);
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: AR.back })).toBeInTheDocument();
    const region = container.querySelector("main [aria-busy=true]") as HTMLElement;
    expect(region).not.toBeNull();
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
    expect(region.querySelectorAll("[aria-hidden=true]").length).toBeGreaterThan(5);
    // Everything that looks like content is decorative, and the region holds no text besides the announcement.
    expect(region.textContent).toBe(AR.loading);
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    expect(within(region).queryAllByRole("link")).toHaveLength(0);
    expect(document.body).toHaveFocus();
  });

  it("announces «Loading» in English", async () => {
    vi.useFakeTimers();
    const { container } = renderRoute(<Loading />, "en");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect((container.querySelector("main [aria-busy=true]") as HTMLElement).textContent).toBe(EN.loading);
  });

  it("shows no skeleton at all when the text arrives within 300 ms", async () => {
    vi.useFakeTimers();
    const view = renderRoute(<Loading />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    view.rerender(route(<PrivacyScreen />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(document.querySelector("[aria-busy=true]")).toBeNull();
    expect(screen.queryByText(AR.loading)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toBeInTheDocument();
  });
});

describe("S-26 text unavailable", () => {
  it("shows the error banner as an alert with its own icon and the retry button, and moves focus to the button", () => {
    const retry = vi.fn();
    renderRoute(<PrivacyRouteError error={new Error("chunk")} retry={retry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(AR.unavailable);
    expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(within(alert).getByRole("button", { name: AR.retry })).toHaveFocus();
    // The frame stays: the heading is there, and is not the focus.
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).not.toHaveFocus();
    expect(screen.getByRole("link", { name: AR.back })).toBeInTheDocument();
  });

  it("calls retry once per press", async () => {
    const retry = vi.fn();
    renderRoute(<PrivacyRouteError error={new Error("chunk")} retry={retry} />);
    await userEvent.click(screen.getByRole("button", { name: AR.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("is worded in English too", () => {
    renderRoute(<PrivacyRouteError error={new Error("chunk")} retry={vi.fn()} />, "en");
    expect(screen.getByRole("alert")).toHaveTextContent(EN.unavailable);
    expect(screen.getByRole("button", { name: EN.retry })).toHaveFocus();
  });

  it("has no em dash or en dash in its text", () => {
    renderRoute(<PrivacyRouteError error={new Error("chunk")} retry={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).not.toMatch(new RegExp("[\u2013\u2014]"));
  });
});

describe("S-26 focus across the swap: the shell's route focus lands on a heading that stays", () => {
  it("focuses the H1 when the route changes under the loading view, and the same H1 keeps the focus when the text arrives", () => {
    const view = renderRoute(<p>settings page</p>);
    const heading = screen.getByRole("heading", { level: 1, name: AR.title });
    expect(document.body).toHaveFocus();

    navigation.pathname = "/settings/privacy";
    view.rerender(route(<Loading />));
    expect(heading).toHaveFocus();

    view.rerender(route(<PrivacyScreen />));
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toBeInTheDocument();
    // The very element that was focused is still in the page and still has focus: nothing was unmounted under it.
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toBe(heading);
    expect(heading).toHaveFocus();
  });

  it("with an anchor, focuses the H1 while loading, and the anchored heading once the text is there, scrolled to", () => {
    const view = renderRoute(<p>settings page</p>);
    const heading = screen.getByRole("heading", { level: 1, name: AR.title });
    window.history.replaceState(null, "", "/settings/privacy#privacy");
    navigation.pathname = "/settings/privacy";
    view.rerender(route(<Loading />));
    expect(heading).toHaveFocus();
    expect(scrolledTo).toEqual([]);

    view.rerender(route(<PrivacyScreen />));
    expect(screen.getByRole("heading", { level: 2, name: AR.privacyHeading })).toHaveFocus();
    expect(scrolledTo).toContain("privacy");
  });

  it("after a failure and a successful retry, focus goes back to the H1 (the retry button is gone), or to the anchor when the address names one", () => {
    const view = renderRoute(<p>settings page</p>);
    navigation.pathname = "/settings/privacy";
    view.rerender(route(<Loading />));
    view.rerender(route(<PrivacyRouteError error={new Error("chunk")} retry={vi.fn()} />));
    expect(screen.getByRole("button", { name: AR.retry })).toHaveFocus();

    view.rerender(route(<PrivacyScreen />));
    expect(screen.getByRole("heading", { level: 1, name: AR.title })).toHaveFocus();

    // The same again, with an anchor.
    view.rerender(route(<PrivacyRouteError error={new Error("chunk")} retry={vi.fn()} />));
    expect(screen.getByRole("button", { name: AR.retry })).toHaveFocus();
    window.history.replaceState(null, "", "/settings/privacy#terms");
    view.rerender(route(<PrivacyScreen />));
    expect(screen.getByRole("heading", { level: 2, name: AR.termsHeading })).toHaveFocus();
  });

  it("does not take the focus from a control the visitor moved to while the text was loading", async () => {
    const view = renderRoute(<p>settings page</p>);
    navigation.pathname = "/settings/privacy";
    view.rerender(route(<Loading />));
    const link = screen.getAllByRole("link").find((element) => element.getAttribute("href") === "/today") as HTMLElement;
    act(() => link.focus());
    expect(link).toHaveFocus();
    view.rerender(route(<PrivacyScreen />));
    expect(link).toHaveFocus();
  });

  it("leaves the first load alone: no focus move without an anchor, though the screen is the first to mount", () => {
    navigation.pathname = "/settings/privacy";
    renderRoute(<PrivacyScreen />);
    expect(document.body).toHaveFocus();
    expect(scrolledTo).toEqual([]);
  });
});
