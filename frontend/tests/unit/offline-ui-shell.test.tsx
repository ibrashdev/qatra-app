import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/offline", useRouter: () => navigation.router }));

// The sync is the one of lib/offline (tested there). Here it is a controllable stand-in, so each outcome of the foreground check can be shown.
const sync = vi.hoisted(() => ({
  run: vi.fn(),
  state: { phase: "idle", trigger: null, startedAt: null, waitedMs: 0, timedOut: false, result: null } as import("@/lib/offline/types").SyncProgress,
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/offline/sync", () => ({
  getOfflineSyncController: () => ({
    run: sync.run,
    retry: sync.run,
    getState: () => sync.state,
    subscribe: (listener: () => void) => {
      sync.listeners.add(listener);
      return () => sync.listeners.delete(listener);
    },
  }),
}));

// Whether the worker has cached every file of the shell: a service worker cannot run in jsdom.
const shell = vi.hoisted(() => ({ ready: true }));
vi.mock("@/lib/pwa/register", () => ({
  getShellStatus: async () => ({ supported: true, registered: true, controlled: true, shellReady: shell.ready, buildId: "b", missing: 0 }),
  subscribeShellReady: () => () => undefined,
}));

import { OfflineShell } from "@/components/pwa/OfflineShell";
import { clearResumeForTests } from "@/components/session/resume-store";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime } from "@/lib/api/runtime";
import * as planCache from "@/lib/offline/plan-cache";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { enqueueEvent, listPendingEvents } from "@/lib/offline/outbox";
import { readOwnerState } from "@/lib/offline/owner";
import type { LocalPlanInspection, SyncResult } from "@/lib/offline/types";
import { installDialogPolyfill } from "./dialog-polyfill";
import { OWNER_ID, USERNAME, activityAt, makeSnapshot, orderQuestion, profile, resetOfflineEnvironment } from "./offline-support";

const snapshot = makeSnapshot();

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
}

function syncResult(outcome: SyncResult["outcome"], overrides: Partial<SyncResult> = {}): SyncResult {
  return { acknowledgedIds: [], pendingIds: [], blockedIds: [], outcome, duplicateIds: [], revalidations: [], daily: null, ...overrides };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderShell({ language = "en", me = (): Response => json(profile()) }: { language?: "ar" | "en"; me?: () => Response } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/me")) return me();
    return json({ status: "ok", version: "t", time: "2026-10-06T00:00:00Z" });
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <OfflineShell />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { fetchImpl, ...view };
}

const apiCalls = (fetchImpl: ReturnType<typeof renderShell>["fetchImpl"]) => fetchImpl.mock.calls.map(([input]) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url));

async function seedPlan() {
  const result = await cacheActivePlan(snapshot, { username: USERNAME });
  expect(result.ready).toBe(true);
}

// A status the real storage cannot easily be put into: the shell reads it through inspectLocalPlan, so the read is replaced for one test.
function inspecting(overrides: Partial<LocalPlanInspection>) {
  const base: LocalPlanInspection = { status: "none", owner: null, snapshot: null, record: null, revalidation: null, counts: { queued: 0, pending: 0, blocked: 0, total: 0 } };
  vi.spyOn(planCache, "inspectLocalPlan").mockResolvedValue({ ...base, ...overrides });
}

beforeEach(() => {
  resetOfflineEnvironment();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearResumeForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  sync.run.mockReset();
  sync.run.mockResolvedValue(syncResult("nothing_to_do"));
  sync.state = { phase: "idle", trigger: null, startedAt: null, waitedMs: 0, timedOut: false, result: null };
  shell.ready = true;
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S-31 offline: the local day", () => {
  it("shows the plan as ready, the fixed offline line, the sessions and the games that need a connection, and makes no request", async () => {
    setOnline(false);
    await seedPlan();
    const { fetchImpl } = renderShell();
    expect(await screen.findByText("Plan ready offline")).toBeInTheDocument();
    expect(screen.getByText("Offline. Results are waiting to be verified.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Learning offline" })).toBeInTheDocument();
    const sessions = screen.getByRole("heading", { level: 2, name: "Sessions ready on this device" }).closest("section") as HTMLElement;
    const rows = within(sessions).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["Today's session", "Word order", "Word or segment choice", "Similar distinction", "Word recall"]);
    // The bank holds choice and recall questions, so a connection would prepare those two again; it holds no similar passage, so that game is not offered.
    expect(within(sessions).getAllByText("This game needs a connection to be prepared again")).toHaveLength(2);
    expect(within(sessions).getAllByText("This game is not available for this part")).toHaveLength(1);
    const similar = within(sessions).getByText("Similar distinction").closest("li") as HTMLElement;
    expect(within(similar).getByText("This game is not available for this part")).toBeInTheDocument();
    expect(within(similar).queryByText("This game needs a connection to be prepared again")).toBeNull();
    expect(within(sessions).getByRole("button", { name: "Start: Today's session" })).toBeInTheDocument();
    // The provisional figure: nothing is done yet, and the day is never called completed.
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("A provisional figure from this device. The server's figure replaces it after syncing.")).toBeInTheDocument();
    // Offline: nothing was asked of the server, and the launcher did not move on.
    expect(apiCalls(fetchImpl)).toEqual([]);
    expect(sync.run).not.toHaveBeenCalled();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("speaks the fixed Arabic strings in the Arabic interface", async () => {
    setOnline(false);
    await seedPlan();
    renderShell({ language: "ar" });
    expect(await screen.findByText("الخطة جاهزة دون اتصال")).toBeInTheDocument();
    expect(screen.getByText("غير متصل \u2014 النتائج بانتظار التحقق")).toBeInTheDocument();
    expect(screen.getAllByText("هذه اللعبة تحتاج اتصالًا لتجهيزها مجددًا")).toHaveLength(2);
    expect(screen.getAllByText("لا تتوفر هذه اللعبة لهذا الجزء")).toHaveLength(1);
  });

  it("says a game is not available, and not that it needs a connection, when the material holds no question of its kind", async () => {
    setOnline(false);
    const passageId = snapshot.downloadedTargetRefs[0]!;
    const short = makeSnapshot({ games: [orderQuestion("q-order", passageId)] });
    expect((await cacheActivePlan(short, { username: USERNAME })).ready).toBe(true);
    renderShell();
    const sessions = (await screen.findByRole("heading", { level: 2, name: "Sessions ready on this device" })).closest("section") as HTMLElement;
    expect(within(sessions).getAllByText("This game is not available for this part")).toHaveLength(3);
    expect(within(sessions).queryByText("This game needs a connection to be prepared again")).toBeNull();
    expect(within(sessions).getAllByRole("button", { name: /^Start: / })).toHaveLength(2);
  });

  it("does not say the plan is ready while the app files are not cached yet", async () => {
    setOnline(false);
    shell.ready = false;
    await seedPlan();
    renderShell();
    expect(await screen.findByText(/app files are not ready to work offline yet/)).toBeInTheDocument();
    expect(screen.queryByText("Plan ready offline")).toBeNull();
  });

  it("counts the unsynced answers, shows the provisional minutes, and offers the sync", async () => {
    setOnline(false);
    await seedPlan();
    const owner = await readOwnerState();
    const run = "99999999-9999-4999-8999-999999999991";
    // A 90 second interval of today on the device clock (Asia/Dubai): the provisional figure is 1 minute of 10.
    const now = Date.now();
    const interval = { ...activityAt(snapshot, run, 0, 0, 90_000) };
    const shifted = { ...interval, startedAt: new Date(now - 120_000).toISOString(), endedAt: new Date(now - 30_000).toISOString() };
    await enqueueEvent(owner!.ownerId!, snapshot.preparedSessions[0]!.sessionId, shifted);
    renderShell();
    expect(await screen.findByText("Saved on the device, waiting to sync")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("1 of 10 minutes (provisional)").length).toBeGreaterThan(0));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "15");
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Sync now" }));
    expect(sync.run).toHaveBeenCalledWith("manual");
  });

  it("opens a run from the list and returns to the list with a local result, still without a request", async () => {
    setOnline(false);
    await seedPlan();
    const user = userEvent.setup();
    const { fetchImpl } = renderShell();
    await user.click(await screen.findByRole("button", { name: "Start: Today's session" }));
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    // Pause and leave: the shell is back on the list.
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(await screen.findByRole("button", { name: "Pause and leave" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Sessions ready on this device" })).toBeInTheDocument();
    expect(apiCalls(fetchImpl)).toEqual([]);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(navigation.router.push).not.toHaveBeenCalled();
    expect((await listPendingEvents(OWNER_ID)).length).toBeGreaterThanOrEqual(0);
  });

  it("contains no link: a router transition would need the network", async () => {
    setOnline(false);
    await seedPlan();
    const { container } = renderShell();
    await screen.findByText("Plan ready offline");
    // The skip link is an in-page anchor; no other link leaves the page.
    expect(container.querySelectorAll('a[href]:not([href^="#"])')).toHaveLength(0);
  });
});

describe("S-31 offline: the states that replace the day", () => {
  it("says a connection is needed when nothing is downloaded, and offers neither sign-in nor a plan", async () => {
    setOnline(false);
    renderShell();
    expect(await screen.findByRole("heading", { level: 2, name: "No plan is downloaded on this device" })).toBeInTheDocument();
    expect(screen.getByText(/download your plan from the Today screen/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /log in|sign in|create/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /start/i })).toBeNull();
  });

  it("says an incomplete download is not opened", async () => {
    setOnline(false);
    inspecting({ status: "incomplete" });
    renderShell();
    expect(await screen.findByRole("heading", { level: 2, name: "The plan download is not complete" })).toBeInTheDocument();
  });

  it.each([
    ["stale", "The downloaded plan is out of date", /Your plan changed on the server/],
    ["revoked", "Unavailable", /no longer available/],
    ["expired", "Unavailable", /has expired/],
    ["schema_incompatible", "The app needs an update", /older than the data saved on this device/],
    ["storage_error", "Storage is not reachable", /could not be read/],
  ] as const)("shows the %s state with its reason in words and no run button", async (status, title, body) => {
    setOnline(false);
    inspecting({ status });
    renderShell();
    expect(await screen.findByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
  });

  it("locks the personal view after a failed clear and offers the repair", async () => {
    setOnline(false);
    inspecting({ status: "locked", failureCode: "locked" });
    const repair = vi.spyOn(await import("@/lib/offline/owner"), "repairOfflineStorage").mockResolvedValue(true);
    renderShell();
    expect(await screen.findByRole("heading", { level: 2, name: "The saved plan is locked" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(repair).toHaveBeenCalledTimes(1);
  });
});

describe("S-31 online: the launcher (G-10) and the account states", () => {
  it("syncs, then goes to the online app when the account answers", async () => {
    setOnline(true);
    await seedPlan();
    sync.run.mockResolvedValue(syncResult("completed"));
    renderShell();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(sync.run).toHaveBeenCalledWith("app_open");
  });

  it("asks the account directly when there is nothing to sync, and goes on when it answers", async () => {
    setOnline(true);
    sync.run.mockResolvedValue(syncResult("nothing_to_do"));
    const { fetchImpl } = renderShell();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(apiCalls(fetchImpl).some((url) => url.endsWith("/api/me"))).toBe(true);
  });

  it("stays in the shell with the answers when the sync was throttled, and tries again by itself before it goes on", async () => {
    setOnline(true);
    await seedPlan();
    const owner = await readOwnerState();
    await enqueueEvent(owner!.ownerId!, snapshot.preparedSessions[0]!.sessionId, activityAt(snapshot, "99999999-9999-4999-8999-999999999992", 0, 0, 5000));
    sync.run.mockResolvedValueOnce(syncResult("throttled", { retryAfterSec: 1 })).mockResolvedValue(syncResult("completed"));
    renderShell();
    expect(await screen.findByText("Saved on the device, waiting to sync")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    // The retry waits at least the two seconds of the first step, then the second sync completes and the launcher goes on.
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"), { timeout: 8000 });
    // The first sync was the one at open, the second the automatic retry (a mocked sync leaves the answers queued, so one more runs before the move).
    expect(sync.run.mock.calls.slice(0, 2).map(([trigger]) => trigger)).toEqual(["app_open", "manual"]);
  });

  it("keeps the local copy and says the session ended when the account answers 401 (G-03)", async () => {
    setOnline(true);
    await seedPlan();
    sync.run.mockResolvedValue(syncResult("unauthenticated"));
    renderShell();
    expect(await screen.findByText("Your session has ended. Log in to continue.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    // Nothing was wiped, and the local day stays usable.
    expect(await screen.findByText("Plan ready offline")).toBeInTheDocument();
    expect(await readOwnerState()).toMatchObject({ ownerId: OWNER_ID });
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("invites a visitor who never signed in on this device to log in, without saying a session ended", async () => {
    setOnline(true);
    sync.run.mockResolvedValue(syncResult("nothing_to_do"));
    renderShell({ me: () => json({ error: { code: "unauthenticated", message: "m", details: {} } }, 401) });
    expect(await screen.findByText("Log in to download your plan and use it offline")).toBeInTheDocument();
    expect(screen.queryByText("Your session has ended. Log in to continue.")).toBeNull();
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    // The "no plan downloaded" panel stays as it was.
    expect(await screen.findByRole("heading", { level: 2, name: "No plan is downloaded on this device" })).toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("speaks the sign-in invitation in Arabic for a visitor who never signed in", async () => {
    setOnline(true);
    sync.run.mockResolvedValue(syncResult("nothing_to_do"));
    renderShell({ language: "ar", me: () => json({ error: { code: "unauthenticated", message: "m", details: {} } }, 401) });
    expect(await screen.findByText("سجّل الدخول لتنزيل خطتك واستعمالها دون اتصال")).toBeInTheDocument();
    expect(screen.queryByText("انتهت جلستك. سجّل الدخول للمتابعة.")).toBeNull();
    expect(screen.getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
  });

  it("keeps the session-ended line when the device holds an owner but no downloaded plan (a real ended session)", async () => {
    setOnline(true);
    inspecting({
      status: "none",
      owner: { ownerId: OWNER_ID, username: USERNAME, generation: 1, logoutPending: false, clearFailed: false, updatedAt: "2026-10-06T00:00:00.000Z" },
    });
    sync.run.mockResolvedValue(syncResult("unauthenticated"));
    renderShell();
    expect(await screen.findByText("Your session has ended. Log in to continue.")).toBeInTheDocument();
    expect(screen.queryByText("Log in to download your plan and use it offline")).toBeNull();
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  });

  it("blocks the copy of another account until the learner clears it, then goes on", async () => {
    setOnline(true);
    await seedPlan();
    sync.run.mockResolvedValue(syncResult("owner_mismatch"));
    renderShell();
    expect(await screen.findByRole("heading", { level: 2, name: "This device holds another account's plan" })).toBeInTheDocument();
    // The other account's plan is not shown.
    expect(screen.queryByText("Plan ready offline")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete the local copy and continue" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect((await readOwnerState())?.ownerId ?? null).toBeNull();
  });

  it("shows the waking line while the free server starts, keeps the local day usable, and offers the retry after 90 seconds", async () => {
    setOnline(true);
    await seedPlan();
    sync.run.mockResolvedValue(syncResult("server_unreachable"));
    sync.state = { phase: "waiting_server", trigger: "app_open", startedAt: 0, waitedMs: 95_000, timedOut: true, result: null };
    renderShell();
    expect(await screen.findByText("Starting the free server, this may take about a minute.")).toBeInTheDocument();
    expect(await screen.findByText("Plan ready offline")).toBeInTheDocument();
    const retry = screen.getAllByRole("button", { name: "Try again" })[0] as HTMLElement;
    await act(async () => {
      retry.click();
    });
    expect(sync.run).toHaveBeenCalledWith("manual");
  });
});
