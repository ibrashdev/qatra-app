import { act, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/terms" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import { AppShell } from "@/components/ui/AppShell";
import { FocusShell } from "@/components/ui/FocusShell";
import { PublicShell } from "@/components/ui/PublicShell";
import { TopBar } from "@/components/ui/TopBar";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { useWrappedBar } from "@/components/ui/use-wrapped-bar";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

// A bar that has wrapped to more than one row must not stay sticky (UI-tokens 6.6 and 7, WCAG 1.4.4, 1.4.10, 2.4.11): at 200 % text on 320 px
// the public bar was 305 px of a 568 px window. jsdom has no layout, so the observer and the sizes are stood in for here; the browser checks
// the real thing (tests/e2e/top-bar.spec.ts).

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.observed = [];
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter((instance) => instance !== this);
  }
  // What the browser does when the size of an observed element changes.
  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const healthy = () => new Response(JSON.stringify({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }), { status: 200 });

let runtime: ApiRuntime | undefined;

function renderWithApp(ui: ReactNode) {
  runtime = createApiRuntime({ mode: "live", fetch: vi.fn<typeof fetch>(async () => healthy()) });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

interface BarSize {
  oneRow: number; // what one row needs (its min-height): 56 px at 100 % text, 112 px at 200 %
  height: number; // the height of the bar below the safe area: a one-row TopBar is 57 px, its row of 56 px and the 1 px divider
  rem?: number; // the text size of the page: 16 px at 100 %, 32 px at 200 %
  safeArea?: number; // the padding at the top of the bar for the notch of a phone
}

// Gives the bar the size the browser would report. A bar is wrapped when its height is more than one row plus half a rem, the room that
// the page's scroll padding keeps clear for it; the safe area at the top is counted by that padding on its own.
function sizeBar(bar: HTMLElement, { oneRow, height, rem = 16, safeArea = 0 }: BarSize) {
  document.documentElement.style.fontSize = `${rem}px`;
  (bar.firstElementChild as HTMLElement).style.minHeight = `${oneRow}px`;
  bar.style.paddingTop = `${safeArea}px`;
  const total = height + safeArea;
  bar.getBoundingClientRect = () => ({ height: total, width: 320, x: 0, y: 0, top: 0, left: 0, right: 320, bottom: total, toJSON: () => ({}) }) as DOMRect;
}

// Tells the observer of the bar that its size changed, as the browser does.
function resize(bar: HTMLElement, size: BarSize) {
  sizeBar(bar, size);
  act(() => {
    for (const instance of FakeResizeObserver.instances) if (instance.observed.includes(bar)) instance.notify();
  });
}

const header = () => screen.getByRole("banner");

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  navigation.pathname = "/terms";
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  runtime = undefined;
  document.documentElement.style.fontSize = "";
  vi.unstubAllGlobals();
  localStorage.clear();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("the top bar is sticky while it is one row and static once it has wrapped", () => {
  it("starts sticky, with the rule that makes it static in its classes, and says it has not wrapped", () => {
    render(<TopBar>content</TopBar>);
    expect(header()).toHaveClass("sticky", "top-0", "data-[wrapped=true]:static");
    expect(header()).toHaveAttribute("data-wrapped", "false");
  });

  it("observes its header, once, and stops when it goes", () => {
    const { unmount } = render(<TopBar>content</TopBar>);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]?.observed).toEqual([header()]);
    unmount();
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });

  it("is wrapped when the bar is taller than one row plus half a rem, and sticky again when it is one row", () => {
    render(<TopBar>content</TopBar>);
    const states: [number, string][] = [
      [57, "false"], // one row at 100 % and its divider
      [64, "false"], // one row plus the 8 px that the page keeps clear below the bar: the limit
      [64.5, "true"],
      [101, "true"], // two rows of 44 px controls, a 12 px gap and the divider
      [57, "false"], // the window is wide again
    ];
    for (const [height, wrapped] of states) {
      resize(header(), { oneRow: 56, height });
      expect(header(), `a bar of ${height} px`).toHaveAttribute("data-wrapped", wrapped);
    }
  });

  it("scales with the text: at 200 % one row is 112 px and the limit 128 px, so 113 px is one row and 201 px is two", () => {
    render(<TopBar>content</TopBar>);
    for (const [height, wrapped] of [
      [113, "false"],
      [128, "false"],
      [129, "true"],
      [201, "true"],
      [306, "true"], // the bar of S-03 at 200 % on 320 px, 305 px and its divider
    ] as const) {
      resize(header(), { oneRow: 112, height, rem: 32 });
      expect(header(), `a bar of ${height} px`).toHaveAttribute("data-wrapped", wrapped);
    }
  });

  it("keeps a title of two lines sticky (62 px at 100 %, 123 px at 200 %) and makes a title of three lines static: the rule is about the height of the bar", () => {
    render(<TopBar>content</TopBar>);
    resize(header(), { oneRow: 56, height: 57.2 }); // two lines of an English title
    expect(header()).toHaveAttribute("data-wrapped", "false");
    resize(header(), { oneRow: 56, height: 61.6 }); // two lines of an Arabic title
    expect(header()).toHaveAttribute("data-wrapped", "false");
    resize(header(), { oneRow: 112, height: 123.2, rem: 32 });
    expect(header()).toHaveAttribute("data-wrapped", "false");
    resize(header(), { oneRow: 56, height: 92.4 }); // three lines
    expect(header()).toHaveAttribute("data-wrapped", "true");
  });

  it("never leaves a sticky bar taller than the room the page keeps clear for it: at every text size the limit equals the scroll padding", () => {
    render(<TopBar>content</TopBar>);
    // The scroll padding of the page is --q-size-appbar (3.5 rem) plus --q-space-8 (0.5 rem): 4 rem, and one row is 3.5 rem.
    for (const rem of [16, 20, 24, 32, 48]) {
      resize(header(), { oneRow: 3.5 * rem, height: 4 * rem, rem });
      expect(header(), `${rem} px per rem, at the limit`).toHaveAttribute("data-wrapped", "false");
      resize(header(), { oneRow: 3.5 * rem, height: 4 * rem + 1, rem });
      expect(header(), `${rem} px per rem, a pixel over`).toHaveAttribute("data-wrapped", "true");
    }
  });

  it("does not count the safe area at the top of the screen, which the page's scroll padding counts on its own", () => {
    render(<TopBar>content</TopBar>);
    resize(header(), { oneRow: 56, height: 64, safeArea: 44 });
    expect(header()).toHaveAttribute("data-wrapped", "false");
    resize(header(), { oneRow: 56, height: 65, safeArea: 44 });
    expect(header()).toHaveAttribute("data-wrapped", "true");
  });

  it("stays sticky when it cannot tell: no observer in the browser, or a row with no minimum height", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const first = render(<TopBar>content</TopBar>);
    expect(header()).toHaveAttribute("data-wrapped", "false");
    first.unmount();

    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    render(<TopBar>content</TopBar>);
    // No min-height on the row at all: the computed value is empty, which is not a number.
    header().getBoundingClientRect = () => ({ height: 300 }) as DOMRect;
    header().style.paddingTop = "0px";
    act(() => FakeResizeObserver.instances[0]?.notify());
    expect(header()).toHaveAttribute("data-wrapped", "false");
  });

  it("shows no divider while it is static, since nothing scrolls under a bar that scrolls away", () => {
    render(<TopBar>content</TopBar>);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 120 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(header()).toHaveAttribute("data-scrolled", "true");
    resize(header(), { oneRow: 56, height: 101 });
    expect(header()).toHaveAttribute("data-scrolled", "false");
    expect(header()).toHaveAttribute("data-wrapped", "true");
    resize(header(), { oneRow: 56, height: 57 });
    expect(header()).toHaveAttribute("data-scrolled", "true");
  });

  it("keeps its other classes, including those of a shell that hides it from 1024 px", () => {
    render(<TopBar className="rail:hidden">content</TopBar>);
    expect(header()).toHaveClass("rail:hidden", "sticky", "bg-page", "z-(--q-z-sticky)");
  });

  it("has no transition of its own, so that reduced motion has nothing to switch off", () => {
    render(<TopBar>content</TopBar>);
    expect(header().className).not.toMatch(/transition|duration|animate/);
  });
});

describe("every shell with a top bar follows the rule", () => {
  it("the public shell: the bar of S-01 to S-03 wraps and is static, and comes back", () => {
    renderWithApp(<PublicShell back={{ destination: "x", href: "/login" }}>content</PublicShell>);
    expect(header()).toHaveAttribute("data-wrapped", "false");
    resize(header(), { oneRow: 112, height: 306, rem: 32 });
    expect(header()).toHaveAttribute("data-wrapped", "true");
    resize(header(), { oneRow: 112, height: 113, rem: 32 });
    expect(header()).toHaveAttribute("data-wrapped", "false");
  });

  it("the app shell: its bar (shown below 1024 px) follows it, and keeps hiding itself from 1024 px", () => {
    navigation.pathname = "/today";
    renderWithApp(<AppShell>content</AppShell>);
    expect(header()).toHaveClass("rail:hidden");
    resize(header(), { oneRow: 56, height: 101 });
    expect(header()).toHaveAttribute("data-wrapped", "true");
  });

  it("the focus shell: its header is sticky with the same rule, and a title of many lines at large text makes it static", () => {
    renderWithApp(
      <FocusShell title="عنوان طويل" back={{ destination: "x", href: "/today" }}>
        content
      </FocusShell>,
    );
    expect(header()).toHaveClass("sticky", "top-0", "data-[wrapped=true]:static");
    expect(header()).toHaveAttribute("data-wrapped", "false");
    expect(header().firstElementChild).toContainElement(screen.getByRole("heading", { level: 1, name: "عنوان طويل" }));
    resize(header(), { oneRow: 112, height: 400, rem: 32 });
    expect(header()).toHaveAttribute("data-wrapped", "true");
    resize(header(), { oneRow: 112, height: 112, rem: 32 });
    expect(header()).toHaveAttribute("data-wrapped", "false");
  });

  it("the focus shell leaves its action bar alone: that one stays sticky at the bottom", () => {
    renderWithApp(
      <FocusShell title="t" actionBar={<button type="button">متابعة</button>}>
        content
      </FocusShell>,
    );
    resize(header(), { oneRow: 56, height: 400 });
    const actionBar = screen.getByRole("button", { name: "متابعة" }).parentElement as HTMLElement;
    expect(actionBar).toHaveClass("sticky", "bottom-0");
    expect(actionBar.className).not.toMatch(/data-\[wrapped/);
  });
});

describe("the hook", () => {
  it("gives a ref for the bar and the state, and follows the bar's size", () => {
    const { result } = renderHook(() => useWrappedBar());
    expect(result.current.wrapped).toBe(false);
    const bar = document.createElement("header");
    bar.append(document.createElement("div"));
    document.body.append(bar);
    sizeBar(bar, { oneRow: 56, height: 101 });
    act(() => result.current.barRef(bar));
    act(() => FakeResizeObserver.instances[0]?.notify());
    expect(result.current.wrapped).toBe(true);
    bar.remove();
  });

  it("stays sticky for a bar that has no row to measure", () => {
    const { result } = renderHook(() => useWrappedBar());
    const bar = document.createElement("header");
    document.body.append(bar);
    bar.style.paddingTop = "0px";
    bar.getBoundingClientRect = () => ({ height: 300 }) as DOMRect;
    act(() => result.current.barRef(bar));
    act(() => FakeResizeObserver.instances[0]?.notify());
    expect(result.current.wrapped).toBe(false);
    bar.remove();
  });
});

// The scroll padding of the page reserves the room of a sticky bar above a focused control (UI-tokens 7, 2.4.11). A bar that is static
// covers nothing, so the page must stop reserving that room (checked in the browser by tests/e2e/top-bar.spec.ts).
describe("the page's scroll padding follows the bar", () => {
  const css = readFileSync(path.resolve(__dirname, "../../src/app/globals.css"), "utf8");

  it("reserves the room of one bar and the notch by default, and only the notch and 8 px while a wrapped bar is on the page", () => {
    expect(css).toMatch(/html\s*\{[^}]*scroll-padding-block-start:\s*calc\(var\(--q-size-appbar\)\s*\+\s*env\(safe-area-inset-top, 0px\)\s*\+\s*var\(--q-space-8\)\);/);
    expect(css).toMatch(/html:has\(header\[data-wrapped="true"\]\)\s*\{\s*scroll-padding-block-start:\s*calc\(env\(safe-area-inset-top, 0px\)\s*\+\s*var\(--q-space-8\)\);\s*\}/);
  });

  it("is written with logical properties only", () => {
    expect(css).not.toMatch(/scroll-padding-(?:top|bottom|left|right)/);
  });
});
