import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => ({ reloadPage: browser.reloadPage, browserTimeZone: () => "Asia/Dubai" }));

import { SettingsScreen } from "@/components/settings/SettingsScreen";
import { errorResponse, type MockHandler } from "@/lib/api/mock/handlers";
import { clearCodeUnavailable, clearLoginArrival } from "@/lib/auth/flash";
import { clearRegisterDraft } from "@/lib/auth/register-draft";
import { wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearSettingsArrival } from "@/lib/settings/arrival";
import { cleanupAdmin, renderAdmin, type AdminRender } from "./admin-support";

let rendered: AdminRender | undefined;

function renderSettings(options: Parameters<typeof renderAdmin>[1] = {}) {
  rendered = renderAdmin(<SettingsScreen />, options);
  return rendered;
}

const noAnswer: MockHandler = () => {
  throw new TypeError("The mock connection failed.");
};
const ROW = { name: "إدارة المحتوى" };

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  clearLoginArrival();
  clearCodeUnavailable();
  clearSettingsArrival();
  clearRegisterDraft();
  wipeRecoveryCode();
});

afterEach(() => {
  cleanupAdmin(rendered);
  rendered = undefined;
});

// The settings screen is loaded when its own save button is in the page.
const loaded = () => screen.findByRole("button", { name: "حفظ التغييرات" });

describe("AD-00 the row to the content manager screens in settings", () => {
  it("is shown after GET /admin/access answers 200 with contentManager true, as a link row to /admin in the words of the deck", async () => {
    const view = renderSettings();
    await loaded();
    const row = await screen.findByRole("link", ROW);
    expect(row).toHaveAttribute("href", "/admin");
    expect(view.count("GET /admin/access")).toBe(1);
  });

  it("is written in English when the interface is English", async () => {
    renderSettings({ language: "en" });
    expect(await screen.findByRole("link", { name: "Content management" })).toHaveAttribute("href", "/admin");
  });

  it("is not shown for a signed-in account that is not a content manager (200 with contentManager false), and nothing says why", async () => {
    const view = renderSettings({ scenario: { contentManager: false } });
    await loaded();
    await waitFor(() => expect(view.count("GET /admin/access")).toBe(1));
    expect(screen.queryByRole("link", ROW)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("هذه الصفحة لمدير المحتوى فقط.")).toBeNull();
  });

  it("is not shown for a demo account (200 with contentManager false)", async () => {
    const view = renderSettings({ scenario: { isDemo: true } });
    await loaded();
    await waitFor(() => expect(view.count("GET /admin/access")).toBe(1));
    expect(screen.queryByRole("link", ROW)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is not shown, and is no error on the page, for a 401, a 403, a 404, an outage or no answer", async () => {
    const cases: Record<string, MockHandler> = {
      "401": () => errorResponse(401, "unauthenticated", "x"),
      "403": () => errorResponse(403, "forbidden", "x"),
      "404": () => errorResponse(404, "not_found", "x"),
      "503": () => errorResponse(503, "unavailable", "x"),
      "500": () => errorResponse(500, "internal", "x"),
      "no answer": noAnswer,
    };
    for (const [label, handler] of Object.entries(cases)) {
      const view = renderSettings({ handlers: { "GET /admin/access": handler } });
      await loaded();
      await waitFor(() => expect(view.count("GET /admin/access"), label).toBe(1));
      expect(screen.queryByRole("link", ROW), label).toBeNull();
      expect(screen.queryByRole("alert"), label).toBeNull();
      view.unmount();
      cleanupAdmin(view);
    }
  });

  it("is not shown when a 200 does not carry contentManager true", async () => {
    for (const body of [{ contentManager: false }, {}, { contentManager: "true" }, { contentManager: 1 }]) {
      const view = renderSettings({ handlers: { "GET /admin/access": () => ({ status: 200, body }) } });
      await loaded();
      await waitFor(() => expect(view.count("GET /admin/access")).toBe(1));
      expect(screen.queryByRole("link", ROW), JSON.stringify(body)).toBeNull();
      view.unmount();
      cleanupAdmin(view);
    }
  });

  it("is not in the page while the answer is awaited, and appears when it arrives", async () => {
    let release: () => void = () => undefined;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = renderSettings({ hold: { key: "GET /admin/access", until } });
    await loaded();
    await waitFor(() => expect(view.count("GET /admin/access")).toBe(1));
    expect(screen.queryByRole("link", ROW)).toBeNull();
    release();
    expect(await screen.findByRole("link", ROW)).toHaveAttribute("href", "/admin");
  });
});
