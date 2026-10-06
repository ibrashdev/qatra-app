import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/admin" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import { SideRail, TabBar } from "@/components/ui/MainNav";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";

function activeTabs(pathname: string): string[] {
  document.body.innerHTML = "";
  navigation.pathname = pathname;
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  resetLocaleStoreForTests();
  const { container, unmount } = render(
    <LocaleProvider>
      <TabBar />
      <SideRail />
    </LocaleProvider>,
  );
  const active = Array.from(container.querySelectorAll("a[aria-current='page']")).map((link) => link.getAttribute("href") ?? "");
  unmount();
  return active;
}

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("main navigation on the content manager screens (D91)", () => {
  it("keeps the settings tab active, in the bar and in the rail, on every /admin route", () => {
    for (const path of [
      "/admin",
      "/admin/",
      "/admin/books",
      "/admin/categories",
      "/admin/sources",
      "/admin/editions/11111111-1111-4111-8111-0000000000e1",
      "/admin/sections/22222222-2222-4222-8222-000000000001",
    ]) {
      expect(activeTabs(path), path).toEqual(["/settings", "/settings"]);
    }
  });

  it("marks no tab on a path that only looks like the admin", () => {
    for (const path of ["/administrator", "/admins", "/administration/books"]) expect(activeTabs(path), path).toEqual([]);
  });

  it("leaves the settings routes as they were", () => {
    expect(activeTabs("/settings")).toEqual(["/settings", "/settings"]);
    expect(activeTabs("/settings/sources")).toEqual(["/settings", "/settings"]);
  });
});
