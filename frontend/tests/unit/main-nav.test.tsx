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

  it("marks no tab on the session itself (S-19, a focus flow) or on lookalike paths", () => {
    for (const path of ["/session/abc", "/session/abc/other", "/session/abc/result/extra", "/session/result", "/session//result", null]) {
      document.body.innerHTML = "";
      expect(activeTabs(path), String(path)).toEqual([]);
    }
  });
});
