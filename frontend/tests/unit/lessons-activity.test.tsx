import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lessons/1", useRouter: () => navigation.router }));

import { LessonReaderScreen } from "@/components/lessons/LessonReaderScreen";
import { READING_RETRY_MS, READING_SETTLE_MS } from "@/components/lessons/use-reading-activity";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { mockToday, mockTodayWithoutPlan } from "@/lib/api/mock/fixtures";
import { MOCK_SESSION_ID } from "@/lib/api/mock/today-handlers";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { apiError, E18, E20, E21, jsonResponse, makeGamesBackend, renderWithBackend, type GamesBackend, type Override } from "./games-support";

// Reading counts toward the daily goal (D40, D92): the reader sends E21 activity events to today's daily session. The mock layer answers E18, E20 and E21;
// time is faked, so a test moves it by hand. Synthetic data only.

const OPEN_SESSION_ID = "55555555-5555-4555-8555-0000000000aa";
const ACTIVITY_KEYS = ["activeMs", "clientEventId", "endedAt", "startedAt", "type"];

// A day with no daily session yet: nothing open, no activity, goal not reached. E18 has no field for a completed daily session, so this is the only shape
// in which the reader may create one (the same E20 call as the Today button).
const FRESH_DAY = { ...mockToday, dailyActiveMs: 0, dailyPercent: 0, dailyCompleted: false, openSessionId: null };

const makeBackend = (overrides: Record<string, Override> = {}) => makeGamesBackend({ [E18]: () => jsonResponse(FRESH_DAY), ...overrides });

function renderReader(backend: GamesBackend = makeBackend()) {
  return renderWithBackend(<LessonReaderScreen rawId="1" />, { backend });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// An act scope renders only when it ends, so the section is loaded in one step and the settle time runs in the next: the reader looks for the session at
// the end of the second one, and its clock starts there.
async function settle() {
  await advance(100);
  await advance(READING_SETTLE_MS);
}

// The page is hidden or shown again: the activity clock follows the visibility, as the session's does.
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const activityEvents = (backend: GamesBackend): Extract<SessionEvent, { type: "activity" }>[] => backend.events().filter((event): event is Extract<SessionEvent, { type: "activity" }> => event.type === "activity");
const eventsUrls = (backend: GamesBackend): string[] =>
  backend.fetchImpl.mock.calls.map(([input]) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test").pathname).filter((path) => path.endsWith("/events"));

const acknowledged = (): EventsResponse => ({ acknowledged: [], duplicate: [], pending: [], rejected: [], results: [], daily: { learningDate: "2026-10-05", dailyActiveMs: 0, dailyGoalMs: 600_000, dailyPercent: 0, dailyCompleted: false, extraActiveMs: 0 } });

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.useRealTimers();
});

describe("reading time counts toward the day", () => {
  it("none yet today: calls E20 daily once after the settle time, then credits the time on screen to that session as one activity event when the reader closes", async () => {
    const { backend, unmount } = renderReader();
    await advance(100);
    expect(screen.getByRole("heading", { level: 1, name: "سورة اصطناعية ١" })).toBeInTheDocument();
    expect(backend.count(E18)).toBe(0);
    await advance(READING_SETTLE_MS);
    expect(backend.count(E18)).toBe(1);
    expect(backend.count(E20)).toBe(1);
    expect(backend.bodies(E20)).toEqual([{ kind: "daily", planId: mockToday.plan?.planId, expectedPlanVersion: mockToday.plan?.currentVersion }]);
    expect(backend.count(E21)).toBe(0);

    await advance(60_000);
    unmount();
    await advance(10);
    const events = activityEvents(backend);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "activity", activeMs: 60_000 });
    expect(Date.parse(events[0]?.endedAt ?? "") - Date.parse(events[0]?.startedAt ?? "")).toBe(60_000);
    expect(eventsUrls(backend)).toEqual([`/api/sessions/${MOCK_SESSION_ID}/events`]);
  });

  it("sends nothing but ids and times: no text of the lesson, no answer, no name", async () => {
    const { backend, unmount } = renderReader();
    await settle();
    await advance(20_000);
    unmount();
    await advance(10);
    const [event] = activityEvents(backend);
    expect(Object.keys(event ?? {}).sort()).toEqual(ACTIVITY_KEYS);
    expect(JSON.stringify(backend.bodies(E21))).not.toMatch(/كلمة|سورة|questionId|answer/);
    expect(JSON.stringify(backend.bodies(E20))).not.toMatch(/كلمة|سورة/);
  });

  it("creates no session and sends nothing for a visit shorter than the settle time", async () => {
    const { backend, unmount } = renderReader();
    await advance(100);
    await advance(READING_SETTLE_MS - 1000);
    unmount();
    await advance(READING_SETTLE_MS);
    expect(backend.count(E18)).toBe(0);
    expect(backend.count(E20)).toBe(0);
    expect(backend.count(E21)).toBe(0);
  });

  it("open session today: credits to it and calls no E20", async () => {
    const backend = makeBackend({
      [E18]: () => jsonResponse({ ...mockToday, openSessionId: OPEN_SESSION_ID }),
      [E21]: () => jsonResponse(acknowledged()),
    });
    const { unmount } = renderReader(backend);
    await settle();
    await advance(30_000);
    unmount();
    await advance(10);
    expect(backend.count(E20)).toBe(0);
    expect(eventsUrls(backend)).toEqual([`/api/sessions/${OPEN_SESSION_ID}/events`]);
    expect(activityEvents(backend)[0]).toMatchObject({ activeMs: 30_000 });
  });

  it("ends the interval when the page is hidden, and starts a new one when it is shown again", async () => {
    const { backend } = renderReader();
    await settle();
    await advance(45_000);
    setVisibility("hidden");
    await advance(10);
    expect(activityEvents(backend).map((event) => event.activeMs)).toEqual([45_000]);
    await advance(600_000); // away: not counted
    setVisibility("visible");
    await advance(25_000);
    setVisibility("hidden");
    await advance(10);
    expect(activityEvents(backend).map((event) => event.activeMs)).toEqual([45_000, 25_000]);
  });

  it("cuts a long reading every 5 minutes, so no interval passes the 30 minutes E21 accepts", async () => {
    const { backend, unmount } = renderReader();
    await settle();
    await advance(5 * 60_000);
    expect(activityEvents(backend).map((event) => event.activeMs)).toEqual([300_000]);
    await advance(30_000);
    unmount();
    await advance(10);
    expect(activityEvents(backend).map((event) => event.activeMs)).toEqual([300_000, 30_000]);
  });

  it("completed today (no open session, activity or a completed day): calls no E20, sends no event, shows no error, and does not ask again", async () => {
    for (const today of [mockToday, { ...FRESH_DAY, dailyCompleted: true }]) {
      const backend = makeBackend({ [E18]: () => jsonResponse(today) });
      const { unmount } = renderReader(backend);
      await settle();
      expect(screen.getByRole("heading", { level: 1, name: "سورة اصطناعية ١" })).toBeInTheDocument(); // reading still works
      await advance(READING_RETRY_MS * 2);
      unmount();
      await advance(10);
      expect(backend.count(E18)).toBe(1);
      expect(backend.count(E20)).toBe(0);
      expect(backend.count(E21)).toBe(0);
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });

  it("credits nothing, quietly, for an account whose plan is gone, and does not ask again", async () => {
    const backend = makeBackend({ [E18]: () => jsonResponse(mockTodayWithoutPlan) });
    const { unmount } = renderReader(backend);
    await settle();
    await advance(READING_RETRY_MS * 2);
    unmount();
    await advance(10);
    expect(backend.count(E18)).toBe(1);
    expect(backend.count(E20)).toBe(0);
    expect(backend.count(E21)).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks again after a failed look-up, shows no error for it, and credits from then on", async () => {
    const backend = makeBackend({ [E18]: (_real, call) => (call === 1 ? apiError(500, "internal") : jsonResponse(FRESH_DAY)) });
    const { unmount } = renderReader(backend);
    await settle();
    expect(backend.count(E18)).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
    await advance(READING_RETRY_MS);
    expect(backend.count(E18)).toBe(2);
    await advance(15_000);
    unmount();
    await advance(10);
    expect(activityEvents(backend).map((event) => event.activeMs)).toEqual([15_000]);
  });
});

describe("reading time when the connection or the session fails", () => {
  it("keeps an interval that could not be sent and sends it again, with the same id, when the connection is back", async () => {
    let offline = true;
    const backend = makeBackend({ [E21]: (real) => (offline ? Promise.reject(new TypeError("offline")) : real()) });
    const { unmount } = renderReader(backend);
    await settle();
    await advance(40_000);
    setVisibility("hidden");
    await advance(10_000); // the failed sends and the client's own retries run out
    offline = false;
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await advance(100);
    unmount();
    await advance(100);
    const sent = activityEvents(backend);
    expect(new Set(sent.map((event) => event.clientEventId)).size).toBe(1);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]).toMatchObject({ activeMs: 40_000 });
    expect(backend.count(E21)).toBeGreaterThan(1); // the failed attempts, then the one that got through
  });

  it("stops crediting when the session it credited was closed, and creates no new session", async () => {
    const closeFirst: Override = async (real, call) => {
      const response = await real();
      if (call !== 1) return response;
      const body = (await response.json()) as EventsResponse;
      return jsonResponse({ ...body, acknowledged: [], rejected: body.acknowledged.map((clientEventId) => ({ clientEventId, code: "session_closed" })) });
    };
    const backend = makeBackend({ [E21]: closeFirst });
    renderReader(backend);
    await settle();
    await advance(30_000);
    setVisibility("hidden");
    await advance(100);
    expect(activityEvents(backend)).toHaveLength(1);
    expect(backend.count(E20)).toBe(1);

    setVisibility("visible");
    await advance(READING_SETTLE_MS + 100);
    await advance(60_000);
    setVisibility("hidden");
    await advance(100);
    expect(backend.count(E18)).toBe(1); // no new look-up
    expect(backend.count(E20)).toBe(1); // no second daily session
    expect(activityEvents(backend)).toHaveLength(1); // nothing more is sent
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "سورة اصطناعية ١" })).toBeInTheDocument();
  });
});
