import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/today" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import { SideRail, TabBar } from "@/components/ui/MainNav";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";

function activeTabs(pathname: string | null): string[] {
  navigation.pathname = pathname;
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  resetLocaleStoreForTests();
  const { container } = render(
    <LocaleProvider>
      <TabBar />
      <SideRail />
    </LocaleProvider>,
  );
  return Array.from(container.querySelectorAll("a[aria-current='page']")).map((link) => link.getAttribute("href") ?? "");
}

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("main navigation: tab icons (FC-01)", () => {
  function renderBar(pathname: string) {
    navigation.pathname = pathname;
    localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
    resetLocaleStoreForTests();
    return render(
      <LocaleProvider>
        <TabBar />
      </LocaleProvider>,
    );
  }

  it("gives each of the four tabs one decorative icon above its label, and keeps the labels, the order and the names", () => {
    const { container } = renderBar("/games");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/today", "/games", "/progress", "/settings"]);
    expect(links.map((link) => link.textContent)).toEqual(["اليوم", "الألعاب", "التقدم", "الإعدادات"]);
    for (const link of links) {
      const icons = link.querySelectorAll("svg");
      expect(icons).toHaveLength(1);
      expect(icons[0]).toHaveAttribute("aria-hidden", "true");
      expect(icons[0]).not.toHaveClass("rtl:-scale-x-100");
      expect(link).not.toHaveAttribute("aria-label");
    }
  });

  it("uses a different glyph for each destination", () => {
    const { container } = renderBar("/today");
    const shapes = Array.from(container.querySelectorAll("a svg")).map((svg) => svg.innerHTML);
    expect(new Set(shapes).size).toBe(4);
  });

  it("draws the active icon at stroke 2 with the 3 px top rule and aria-current, the others at 1.5", () => {
    const { container } = renderBar("/progress");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((link) => link.querySelector("svg")?.getAttribute("stroke-width"))).toEqual(["1.5", "1.5", "2", "1.5"]);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, null, "page", null]);
    expect(links[2]).toHaveClass("border-t-[3px]", "border-primary");
  });

  it("keeps the 4 rem bar height as a floor and the safe-area inset on the bar, not a fixed frame size", () => {
    const { container } = renderBar("/today");
    expect(container.querySelector("nav")).toHaveClass("pb-[env(safe-area-inset-bottom)]");
    expect(container.querySelector("a")?.className).toContain("min-h-[calc(var(--q-size-tabbar)-1px)]");
  });

  it("keeps the block padding at 4 px so the icon, the gap and the caption fit inside the 64 px bar (UI-tokens 6.6)", () => {
    const { container } = renderBar("/today");
    expect(container.querySelector("a")).toHaveClass("py-q4", "gap-q4");
    expect(container.querySelector("a")).not.toHaveClass("py-q8");
  });
});

describe("main navigation: the active tab", () => {
  it("marks the tab of the current path, in the bar and in the rail", () => {
    expect(activeTabs("/today")).toEqual(["/today", "/today"]);
  });

  it("keeps the progress tab for its own path", () => {
    expect(activeTabs("/progress")).toEqual(["/progress", "/progress"]);
  });

  it("marks the progress tab on the session result (S-20)", () => {
    expect(activeTabs("/session/55555555-5555-4555-8555-000000000001/result")).toEqual(["/progress", "/progress"]);
    expect(activeTabs("/session/abc/result/")).toEqual(["/progress", "/progress"]);
  });

  it("marks the today tab on the plan overview (S-12) and the plan revision (S-13)", () => {
    expect(activeTabs("/plan")).toEqual(["/today", "/today"]);
    document.body.innerHTML = "";
    expect(activeTabs("/plan/")).toEqual(["/today", "/today"]);
    document.body.innerHTML = "";
    expect(activeTabs("/plan/revise")).toEqual(["/today", "/today"]);
    document.body.innerHTML = "";
    expect(activeTabs("/plan/revise/")).toEqual(["/today", "/today"]);
  });

  it("marks no tab on the plan conversation (S-34, a focus flow) or on lookalike plan paths", () => {
    for (const path of ["/plan/chat/abc", "/plan/revise/extra", "/planning", "/plan/other"]) {
      document.body.innerHTML = "";
      expect(activeTabs(path), path).toEqual([]);
    }
  });

  it("keeps the session result on the progress tab next to the plan rule", () => {
    document.body.innerHTML = "";
    expect(activeTabs("/session/abc/result")).toEqual(["/progress", "/progress"]);
  });

  it("marks no tab on the session itself (S-19, a focus flow) or on lookalike paths", () => {
    for (const path of ["/session/abc", "/session/abc/other", "/session/abc/result/extra", "/session/result", "/session//result", null]) {
      document.body.innerHTML = "";
      expect(activeTabs(path), String(path)).toEqual([]);
    }
  });
});
