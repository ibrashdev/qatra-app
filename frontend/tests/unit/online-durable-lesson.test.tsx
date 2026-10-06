import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lessons/1", useRouter: () => navigation.router }));

import { LessonReaderScreen } from "@/components/lessons/LessonReaderScreen";
import { READING_SETTLE_MS } from "@/components/lessons/use-reading-activity";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { mockToday } from "@/lib/api/mock/fixtures";
import { MOCK_SESSION_ID } from "@/lib/api/mock/today-handlers";
import { bindOnlineAccount, listOnlineEvents, readOnlineRun } from "@/lib/offline/online-journal";
import type { OnlineBinding } from "@/lib/offline/types";
import { apiError, E18, E21, jsonResponse, makeGamesBackend, renderWithBackend, type GamesBackend, type Override } from "./games-support";
import { USERNAME, resetOfflineEnvironment } from "./offline-support";

// Reading time of the lesson reader with the online journal behind it: each interval is committed to the device (kind `lesson`, activity events only)
// before it is counted, so closing the reader or losing the connection no longer loses it. The reader holds no run lock and owes no finish.

const FRESH_DAY = { ...mockToday, dailyActiveMs: 0, dailyPercent: 0, dailyCompleted: false, openSessionId: null };
const makeBackend = (overrides: Record<string, Override> = {}) => makeGamesBackend({ [E18]: () => jsonResponse(FRESH_DAY), ...overrides });

// IndexedDB of the test (fake-indexeddb) schedules with setImmediate, which stays real; the page's own clocks are the ones a test moves by hand.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settleTrulyAsync() {
  // Real-time pause for the storage and the promises that sit behind it.
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  });
}

let binding: OnlineBinding;

beforeEach(async () => {
  resetOfflineEnvironment();
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  binding = await bindOnlineAccount(USERNAME);
});

afterEach(() => {
  delete (document as { visibilityState?: unknown }).visibilityState;
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  vi.useRealTimers();
});

async function readFor(backend: GamesBackend, ms: number, close = true) {
  const view = renderWithBackend(<LessonReaderScreen rawId="1" />, { backend });
  await advance(100);
  await advance(READING_SETTLE_MS);
  await advance(ms);
  if (close) {
    view.unmount();
    await advance(10);
    await settleTrulyAsync();
  }
  return view;
}

describe("the lesson reader with the online journal", () => {
  it("commits the reading interval to the journal as a `lesson` activity event of today's session before it is sent, then settles it", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const backend = makeBackend({ [E21]: async (real) => (await gate, real()) });
    await readFor(backend, 60_000);
    await vi.waitFor(() => expect(backend.count(E21)).toBe(1));
    const stored = await listOnlineEvents(binding.accountKey);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "lesson", sessionId: MOCK_SESSION_ID, state: "queued" });
    expect(stored[0]?.event).toMatchObject({ type: "activity", activeMs: 60_000 });
    release?.();
    await vi.waitFor(async () => expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0));
  });

  it("keeps the interval on the device when the server cannot be reached and the reader is gone, for the foreground sync", async () => {
    const backend = makeBackend({ [E21]: () => apiError(503, "unavailable") });
    await readFor(backend, 30_000);
    await vi.waitFor(() => expect(backend.count(E21)).toBeGreaterThanOrEqual(1));
    const stored = await listOnlineEvents(binding.accountKey);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "lesson", state: "queued" });
  });

  it("owes no finish and holds no run lock", async () => {
    const request = vi.fn(() => new Promise<void>(() => undefined));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const backend = makeBackend();
    await readFor(backend, 20_000);
    expect(request).not.toHaveBeenCalled();
    expect(await readOnlineRun(binding.accountKey, MOCK_SESSION_ID)).toBeNull();
  });
});
