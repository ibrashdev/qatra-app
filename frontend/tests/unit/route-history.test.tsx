import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/login" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import { RouteTracker } from "@/components/RouteTracker";
import { SkeletonBlock, SkeletonLines } from "@/components/ui/Skeleton";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { noteRoute, resetRouteHistoryForTests, routeBefore } from "@/lib/nav/route-history";
import { termsOpener } from "@/lib/nav/terms-opener";

beforeEach(() => {
  resetRouteHistoryForTests();
  navigation.pathname = "/login";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the route history (which screen opened this one)", () => {
  it("knows nothing at the start of a visit, so a screen opened directly has no opener", () => {
    expect(routeBefore("/terms")).toBeNull();
  });

  it("answers with the current route while the new route has not been noted yet, and with the previous route after", () => {
    noteRoute("/register");
    // A screen asks while it renders, before the tracker's effect has run.
    expect(routeBefore("/terms")).toBe("/register");
    noteRoute("/terms");
    expect(routeBefore("/terms")).toBe("/register");
  });

  it("ignores a repeat of the same path, so a re-render cannot erase the opener", () => {
    noteRoute("/register");
    noteRoute("/terms");
    noteRoute("/terms");
    noteRoute("/terms");
    expect(routeBefore("/terms")).toBe("/register");
  });

  it("follows the visitor back and forth", () => {
    noteRoute("/register");
    noteRoute("/terms");
    noteRoute("/register");
    expect(routeBefore("/register")).toBe("/terms");
    noteRoute("/terms");
    expect(routeBefore("/terms")).toBe("/register");
  });

  it("starts empty again on a reset (a reload empties the module)", () => {
    noteRoute("/register");
    resetRouteHistoryForTests();
    expect(routeBefore("/terms")).toBeNull();
  });
});

describe("the screens that open S-03", () => {
  it("names the register form and the re-consent gate, and treats every other route, or none, as a direct visit", () => {
    expect(termsOpener("/register")).toBe("register");
    expect(termsOpener("/consent")).toBe("consent");
    for (const other of ["/login", "/", "/terms", "/recovery", "/settings", "/register/extra", null]) expect(termsOpener(other), String(other)).toBe("home");
  });
});

describe("the route tracker", () => {
  it("renders nothing and notes each path once it is committed", () => {
    navigation.pathname = "/register";
    const { container, rerender } = render(<RouteTracker />);
    expect(container).toBeEmptyDOMElement();
    expect(routeBefore("/terms")).toBe("/register");

    navigation.pathname = "/terms";
    rerender(<RouteTracker />);
    expect(routeBefore("/terms")).toBe("/register");
    expect(routeBefore("/register")).toBe("/terms");
  });

  it("changes nothing when the path stays the same", () => {
    navigation.pathname = "/register";
    const { rerender } = render(<RouteTracker />);
    navigation.pathname = "/terms";
    rerender(<RouteTracker />);
    rerender(<RouteTracker />);
    expect(routeBefore("/terms")).toBe("/register");
  });
});

describe("useAfterDelay (the 300 ms of a skeleton, UI-tokens 6.14)", () => {
  it("is false at first and true once the delay has passed", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAfterDelay(300));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("sets nothing after the component has gone", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useAfterDelay(300));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the skeleton blocks (UI-tokens 6.14)", () => {
  it("are decorative blocks in the disabled fill with the small radius, and hidden from assistive technology", () => {
    const { container } = render(<SkeletonBlock className="h-q16 w-1/3" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block).toHaveClass("bg-disabled", "rounded-sm", "h-q16", "w-1/3");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("make a paragraph of lines, the last one shorter", () => {
    const { container } = render(<SkeletonLines lines={4} />);
    const lines = container.querySelectorAll("[aria-hidden=true]");
    // The wrapper is hidden too; the lines are its children.
    const blocks = Array.from((lines[0] as HTMLElement).children);
    expect(blocks).toHaveLength(4);
    expect(blocks.slice(0, 3).every((block) => block.classList.contains("w-full"))).toBe(true);
    expect(blocks[3]).toHaveClass("w-3/5");
    expect(container.textContent).toBe("");
  });
});
