import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

const navigation = vi.hoisted(() => ({ pathname: "/today" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import { AppShell } from "@/components/ui/AppShell";
import { ErrorView } from "@/components/ui/ErrorView";
import { FocusShell } from "@/components/ui/FocusShell";
import { NotFoundView } from "@/components/ui/NotFoundView";
import { PlaceholderPage } from "@/components/ui/PlaceholderPage";
import { PublicShell } from "@/components/ui/PublicShell";
import { WakeUpStatus } from "@/components/ui/WakeUpStatus";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";

const healthy = () => new Response(JSON.stringify({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }), { status: 200 });

let runtime: ApiRuntime;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderWithApp(ui: ReactNode, { fetchImpl = vi.fn<typeof fetch>(async () => healthy()) } = {}) {
  runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  navigation.pathname = "/today";
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
});

describe("AppShell (F0-4)", () => {
  it("renders four tab links in the documented order, in both navigation landmarks", () => {
    setLanguage("ar");
    renderWithApp(<AppShell>content</AppShell>);
    const navs = screen.getAllByRole("navigation", { name: "التنقل الرئيسي" });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      const links = within(nav).getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/") && link.textContent !== "قطرة غيث");
      expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
        ["اليوم", "/today"],
        ["الألعاب", "/games"],
        ["التقدم", "/progress"],
        ["الإعدادات", "/settings"],
      ]);
    }
  });

  it("marks the current destination with aria-current, in both navs, and nothing else", () => {
    setLanguage("ar");
    navigation.pathname = "/progress";
    renderWithApp(<AppShell>content</AppShell>);
    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toHaveTextContent("التقدم");
  });

  it("names the destinations in English when the language is English", () => {
    setLanguage("en");
    renderWithApp(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main navigation" })[0] as HTMLElement;
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toContain("Settings");
  });

  it("has a skip link as the first focusable element, pointing at the main landmark", async () => {
    setLanguage("ar");
    renderWithApp(<AppShell>content</AppShell>);
    await userEvent.tab();
    const skip = screen.getByRole("link", { name: "انتقل إلى المحتوى" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("has one main landmark and a banner, and renders its children", () => {
    setLanguage("ar");
    renderWithApp(<AppShell>content</AppShell>);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveTextContent("content");
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});

describe("PublicShell and the language switch (F0-3, UA-11)", () => {
  it("has the switch «العربية | EN» and no tab navigation", () => {
    setLanguage("ar");
    renderWithApp(<PublicShell>content</PublicShell>);
    const group = screen.getByRole("radiogroup", { name: "اللغة" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["العربية", "English (EN)"]);
    expect(radios[0]).toBeChecked();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("switches lang and dir at once, keeps the choice, announces it, and leaves focus on the switch", async () => {
    setLanguage("ar");
    renderWithApp(<PublicShell>content</PublicShell>);
    const english = screen.getByRole("radio", { name: "English (EN)" });
    await userEvent.click(english);

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(screen.getByRole("radio", { name: "English (EN)" })).toBeChecked();
    expect(english).toHaveFocus();
    expect(screen.getByText("Language changed to English")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("link", { name: "Qatra" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "العربية" }));
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("link", { name: "قطرة غيث" })).toBeInTheDocument();
  });

  it("shows a check at the start edge of the selected segment only, hidden from assistive technology, and moves it with the choice (P-02)", async () => {
    setLanguage("ar");
    renderWithApp(<PublicShell>content</PublicShell>);
    const segment = (name: string) => screen.getByRole("radio", { name }).closest("label") as HTMLElement;

    const check = segment("العربية").querySelector("svg");
    expect(check).toHaveAttribute("aria-hidden", "true");
    expect(check).toHaveClass("lucide-check", "size-icon-sm");
    expect(check).not.toHaveClass("rtl:-scale-x-100");
    // The glyph comes before the label text in the DOM, so it sits at the start edge in either direction.
    expect(check?.previousElementSibling).toBe(screen.getByRole("radio", { name: "العربية" }));
    expect(check?.nextSibling?.textContent).toBe("العربية");
    expect(segment("English (EN)").querySelector("svg")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(segment("العربية").querySelector("svg")).toBeNull();
    expect(segment("English (EN)").querySelector("svg")).toHaveClass("lucide-check");
    // The accessible names do not change with the glyph.
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["العربية", "English (EN)"]);
  });

  it("still works when localStorage throws (UA-17)", async () => {
    setLanguage("ar");
    renderWithApp(<PublicShell>content</PublicShell>);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await userEvent.click(screen.getByRole("radio", { name: "English (EN)" }));
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("gives each segment its own lang so the labels read in their own language", () => {
    setLanguage("en");
    renderWithApp(<PublicShell>content</PublicShell>);
    const arabic = screen.getByRole("radio", { name: "العربية" }).closest("label");
    expect(arabic).toHaveAttribute("lang", "ar");
  });

  it("shows the lockup as a link at the start edge, the droplet glyph hidden from assistive technology", () => {
    setLanguage("ar");
    renderWithApp(<PublicShell>content</PublicShell>);
    const lockup = screen.getByRole("link", { name: "قطرة غيث" });
    expect(lockup).toHaveAttribute("href", "/");
    const glyph = lockup.querySelector("svg");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveClass("size-icon-xl", "text-primary");
  });

  it("leaves the lockup out of the header when the page carries its own, and keeps the switch at the end edge", () => {
    setLanguage("ar");
    renderWithApp(<PublicShell logo={false}>content</PublicShell>);
    expect(screen.queryByRole("link", { name: "قطرة غيث" })).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "اللغة" }).closest("div.ms-auto")).not.toBeNull();
  });

  it("keeps the wake-up line out of the page top when the screen shows it above its own button", () => {
    setLanguage("ar");
    renderWithApp(<PublicShell wakeUp={false}>content</PublicShell>);
    act(() => runtime.monitor.settle(runtime.monitor.start(), "connectivity"));
    expect(screen.queryByText("جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.")).not.toBeInTheDocument();
  });

  it("puts a back control at the start edge when the screen has one, in place of the lockup, named for where it goes (P-02)", async () => {
    setLanguage("ar");
    renderWithApp(
      <PublicShell back={{ destination: "تصفّح الكتب", href: "/login" }} logo={false}>
        content
      </PublicShell>,
    );
    const back = screen.getByRole("link", { name: "رجوع إلى تصفّح الكتب" });
    expect(back).toHaveAttribute("href", "/login");
    expect(back).toHaveClass("size-target");
    expect(screen.queryByRole("link", { name: "قطرة غيث" })).not.toBeInTheDocument();
    // The focus order of the header: the skip link, the back control, then the switch.
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "انتقل إلى المحتوى" })).toHaveFocus();
    await userEvent.tab();
    expect(back).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "العربية" })).toHaveFocus();
  });

  it("names the back control in English and lets it take the place of the lockup even when the lockup is on", () => {
    setLanguage("en");
    renderWithApp(<PublicShell back={{ destination: "Browse books", href: "/login" }}>content</PublicShell>);
    expect(screen.getByRole("link", { name: "Back to Browse books" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: "Qatra" })).not.toBeInTheDocument();
  });
});

describe("BackControl (UI-tokens 5 and 6.1, P-02)", () => {
  it("is a 44 px icon control whose arrow is hidden from assistive technology and mirrors in right-to-left only", () => {
    setLanguage("ar");
    renderWithApp(<PublicShell back={{ destination: "x", href: "/login" }}>content</PublicShell>);
    const back = screen.getByRole("link", { name: "رجوع إلى x" });
    expect(back).toHaveClass("size-target");
    const arrow = back.querySelector("svg");
    expect(arrow).toHaveAttribute("aria-hidden", "true");
    expect(arrow).toHaveClass("size-icon-lg", "rtl:-scale-x-100");
    expect(back).toHaveTextContent("");
  });
});

describe("route focus (UI-screens P-01)", () => {
  it("leaves focus alone on the first load, then moves it to the heading when another shell mounts on a new path", () => {
    setLanguage("ar");
    navigation.pathname = "/recovery";
    const first = renderWithApp(
      <PublicShell>
        <PlaceholderPage screen="recovery" />
      </PublicShell>,
    );
    expect(document.body).toHaveFocus();
    first.unmount();

    navigation.pathname = "/today";
    renderWithApp(
      <AppShell>
        <PlaceholderPage screen="today" />
      </AppShell>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "اليوم" })).toHaveFocus();
  });

  it("does not move focus when a shell mounts again on the same path", () => {
    setLanguage("ar");
    navigation.pathname = "/recovery";
    const first = renderWithApp(
      <PublicShell>
        <PlaceholderPage screen="recovery" />
      </PublicShell>,
    );
    first.unmount();
    renderWithApp(
      <PublicShell>
        <PlaceholderPage screen="recovery" />
      </PublicShell>,
    );
    expect(document.body).toHaveFocus();
  });
});

describe("FocusShell: the focus-flow variant (UA-10)", () => {
  it("has a title, a named back link, and neither a tab bar nor a rail", () => {
    setLanguage("ar");
    renderWithApp(
      <FocusShell title="عنوان تجريبي" back={{ destination: "الصفحة السابقة", href: "/today" }}>
        content
      </FocusShell>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "عنوان تجريبي" })).toBeInTheDocument();
    const back = screen.getByRole("link", { name: "رجوع إلى الصفحة السابقة" });
    expect(back).toHaveAttribute("href", "/today");
    // The same arrow control as the public header: no text on it, the name says where it goes.
    expect(back).toHaveClass("size-target");
    expect(back).toHaveTextContent("");
    expect(back.querySelector("svg")).toHaveClass("rtl:-scale-x-100");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("content");
  });

  it("offers a button back control that calls its handler", async () => {
    setLanguage("en");
    const onClick = vi.fn();
    renderWithApp(
      <FocusShell title="Title" back={{ destination: "the form", onClick }}>
        content
      </FocusShell>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Back to the form" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the sticky action bar only when it is given", () => {
    setLanguage("ar");
    const { unmount } = renderWithApp(<FocusShell title="t">content</FocusShell>);
    expect(screen.queryByRole("button", { name: "متابعة" })).not.toBeInTheDocument();
    unmount();
    renderWithApp(
      <FocusShell title="t" actionBar={<button type="button">متابعة</button>}>
        content
      </FocusShell>,
    );
    expect(screen.getByRole("button", { name: "متابعة" })).toBeInTheDocument();
  });
});

describe("placeholder pages (screens that arrive in a later step)", () => {
  it.each([
    ["today", "اليوم"],
    ["games", "الألعاب"],
    ["progress", "التقدم"],
    ["settings", "الإعدادات"],
    ["recovery", "استرجاع الحساب"],
  ] as const)("%s shows its name and says plainly that it is not built yet, with no control", (screen_, name) => {
    setLanguage("ar");
    renderWithApp(<PlaceholderPage screen={screen_} />);
    expect(screen.getByRole("heading", { level: 1, name })).toBeInTheDocument();
    expect(screen.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.title).toBe(`${name} · قطرة غيث`);
  });

  it("follows the language in the heading and in the document title", () => {
    setLanguage("en");
    renderWithApp(<PlaceholderPage screen="games" />);
    expect(screen.getByRole("heading", { level: 1, name: "Games" })).toBeInTheDocument();
    expect(document.title).toBe("Games · Qatra");
  });
});

describe("error and not-found views", () => {
  it("not-found links home", () => {
    setLanguage("ar");
    renderWithApp(<NotFoundView />);
    expect(screen.getByRole("heading", { level: 1, name: "الصفحة غير موجودة" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "الذهاب إلى الصفحة الرئيسية" })).toHaveAttribute("href", "/");
  });

  it("the error view announces itself and its retry button calls reset", async () => {
    setLanguage("ar");
    const reset = vi.fn();
    renderWithApp(<ErrorView reset={reset} />);
    expect(screen.getByRole("alert")).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    await userEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("WakeUpStatus (F0-6): the line, the busy indicator, the retry button", () => {
  const LINE_AR = "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.";

  function Harness() {
    return <WakeUpStatus />;
  }

  it("keeps an empty polite live region in the DOM while nothing is happening", () => {
    setLanguage("ar");
    renderWithApp(<Harness />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("shows the fixed Arabic line inside the live region as soon as a request fails outside the envelope", () => {
    setLanguage("ar");
    renderWithApp(<Harness />);
    act(() => runtime.monitor.settle(runtime.monitor.start(), "connectivity"));
    const region = screen.getByRole("status");
    expect(within(region).getByText(LINE_AR)).toBeInTheDocument();
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the English line in the English interface", () => {
    setLanguage("en");
    renderWithApp(<Harness />);
    act(() => runtime.monitor.settle(runtime.monitor.start(), "connectivity"));
    expect(screen.getByText("Starting the free server, this may take about a minute.")).toBeInTheDocument();
  });

  it("shows only a neutral busy indicator while the probe answers and the request is still pending", async () => {
    vi.useFakeTimers();
    setLanguage("ar");
    renderWithApp(<Harness />);
    await act(async () => {
      runtime.monitor.start();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    expect(screen.queryByText(LINE_AR)).not.toBeInTheDocument();
  });

  it("adds the retry button after 90 s, keeps the line, and the button restarts polling", async () => {
    vi.useFakeTimers();
    setLanguage("ar");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>asleep</html>", { status: 502 }));
    renderWithApp(<Harness />, { fetchImpl });
    await act(async () => {
      runtime.monitor.settle(runtime.monitor.start(), "connectivity");
      await vi.advanceTimersByTimeAsync(89_000);
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(LINE_AR)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "إعادة المحاولة" });

    const callsBefore = fetchImpl.mock.calls.length;
    fetchImpl.mockImplementation(async () => healthy());
    await act(async () => {
      button.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(screen.queryByText(LINE_AR)).not.toBeInTheDocument();
    expect(screen.getByText("الخادم جاهز. يمكنك المحاولة الآن.")).toHaveClass("sr-only");
  });

  it("announces readiness once the server answers, then goes quiet", async () => {
    vi.useFakeTimers();
    setLanguage("ar");
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockImplementation(async () => new Response("<html>asleep</html>", { status: 502 }));
    renderWithApp(<Harness />, { fetchImpl });
    await act(async () => {
      runtime.monitor.settle(runtime.monitor.start(), "connectivity");
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByText(LINE_AR)).toBeInTheDocument();
    fetchImpl.mockImplementation(async () => healthy());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByText(LINE_AR)).not.toBeInTheDocument();
    expect(screen.getByText("الخادم جاهز. يمكنك المحاولة الآن.")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("is part of every shell", () => {
    setLanguage("ar");
    for (const shell of [
      <AppShell key="app">x</AppShell>,
      <PublicShell key="public">x</PublicShell>,
      <FocusShell key="focus" title="t">
        x
      </FocusShell>,
    ]) {
      const { unmount } = renderWithApp(shell);
      expect(screen.getAllByRole("status").some((region) => region.getAttribute("aria-live") === "polite")).toBe(true);
      runtime.wakeUp.dispose();
      unmount();
    }
  });
});
