import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/today", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { ProgressScreen } from "@/components/progress/ProgressScreen";
import { TodayScreen } from "@/components/today/TodayScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { mockToday } from "@/lib/api/mock/fixtures";
import { errorResponse, mockHandlers, type MockHandler } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { SyncOutcome } from "@/lib/offline/types";
import { publishOfflineMessage } from "@/lib/offline/broadcast";
import { resetOfflineEnvironment } from "./offline-support";

// When the foreground sync of the online journal completes (here or in another tab) the figures the server confirmed may have changed: the Today and the
// progress screens read them again in place. A screen that is showing data stays as it is while it reads, and a refresh that fails changes nothing.

const E18 = "GET /today";
const E19 = "GET /progress";

function renderScreen(ui: "today" | "progress", handlers: Record<string, MockHandler> = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  resetLocaleStoreForTests();
  const mock = createMockFetch({ latencyMs: 0, handlers: { ...mockHandlers, ...todayMockHandlers, ...handlers }, scenario: { signedIn: true, hasPlan: true } });
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`);
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui === "today" ? <TodayScreen /> : <ProgressScreen />}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, count: (key: string) => calls.filter((call) => call === key).length };
}

const syncDone = (outcome: SyncOutcome) =>
  act(async () => {
    publishOfflineMessage({ type: "SYNC_DONE", outcome });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

beforeEach(() => {
  resetOfflineEnvironment();
  localStorage.clear();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
});

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("the Today screen after a completed sync", () => {
  it("reads E18 and E19 again in place, without going back to a skeleton", async () => {
    const view = renderScreen("today");
    await screen.findByRole("heading", { level: 1, name: "Your step today" });
    await waitFor(() => expect(view.count(E19)).toBe(1));
    expect(view.count(E18)).toBe(1);
    await syncDone("completed");
    await waitFor(() => expect(view.count(E18)).toBe(2));
    expect(view.count(E19)).toBe(2);
    expect(screen.getByRole("heading", { level: 1, name: "Your step today" })).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("does nothing for a sync that did not complete", async () => {
    const view = renderScreen("today");
    await screen.findByRole("heading", { level: 1, name: "Your step today" });
    for (const outcome of ["nothing_to_do", "offline", "server_unreachable", "failed", "unauthenticated"] as const) await syncDone(outcome);
    expect(view.count(E18)).toBe(1);
  });

  it("keeps what it shows when the refresh itself fails", async () => {
    let call = 0;
    const view = renderScreen("today", {
      [E18]: () => {
        call += 1;
        return call === 1 ? { status: 200, body: mockToday } : errorResponse(503, "unavailable", "m");
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Your step today" });
    await syncDone("completed");
    await waitFor(() => expect(view.count(E18)).toBe(2));
    expect(screen.getByRole("heading", { level: 1, name: "Your step today" })).toBeInTheDocument();
    expect(screen.queryByText("The service is temporarily unavailable. Try again shortly.")).toBeNull();
  });

  it("stops listening when it is gone", async () => {
    const view = renderScreen("today");
    await screen.findByRole("heading", { level: 1, name: "Your step today" });
    view.unmount();
    await syncDone("completed");
    expect(view.count(E18)).toBe(1);
  });
});

describe("the progress screen after a completed sync", () => {
  it("reads E19 and E18 again in place", async () => {
    const view = renderScreen("progress");
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(view.count(E19)).toBe(1));
    await syncDone("completed");
    await waitFor(() => expect(view.count(E19)).toBe(2));
    expect(view.count(E18)).toBe(2);
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("does nothing for a sync that did not complete, and keeps the screen when the refresh fails", async () => {
    let call = 0;
    const view = renderScreen("progress", {
      [E19]: () => {
        call += 1;
        return call === 1 ? baseProgress() : errorResponse(503, "unavailable", "m");
      },
    });
    const heading = await screen.findByRole("heading", { level: 1 });
    await syncDone("failed");
    expect(view.count(E19)).toBe(1);
    await syncDone("completed");
    await waitFor(() => expect(view.count(E19)).toBe(2));
    expect(heading).toBeInTheDocument();
    expect(screen.queryByText("The service is temporarily unavailable. Try again shortly.")).toBeNull();
  });
});

function baseProgress() {
  const handler = todayMockHandlers[E19];
  if (handler === undefined) throw new Error("No mock handler for E19.");
  return handler({ method: "GET", path: "/progress", body: undefined }, { signedIn: true, hasPlan: true } as never);
}
