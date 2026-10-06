import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api/client";
import type { ConnectivityReason } from "@/lib/api/errors";
import { RequestMonitor, type RequestOutcome } from "@/lib/api/monitor";
import { createApiRuntime } from "@/lib/api/runtime";
import type { WakeUpPhase } from "@/lib/api/wakeup";
import { ConnectivityController, INITIAL_CONNECTIVITY, type ConnectivityState } from "@/lib/net/connectivity";
import { isOfflineSwapRoute } from "@/lib/net/offline-routes";

// A wake-up controller the test steers by hand: the phases are its own to set.
function fakeWake(initial: WakeUpPhase = "idle") {
  let phase = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ phase }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: WakeUpPhase) {
      phase = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function setNavigatorOnline(value: boolean) {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
}

const browserGoes = (event: "online" | "offline") => window.dispatchEvent(new Event(event));

function setup({ browserOffline = false }: { browserOffline?: boolean } = {}) {
  setNavigatorOnline(!browserOffline);
  const monitor = new RequestMonitor();
  const wake = fakeWake();
  const controller = new ConnectivityController();
  controller.attach({ monitor, wakeUp: wake });
  const seen: ConnectivityState[] = [];
  const stop = controller.subscribe(() => seen.push(controller.getState()));
  const settle = (outcome: RequestOutcome, reason?: ConnectivityReason) => monitor.settle(monitor.start(), outcome, reason);
  return { controller, monitor, wake, seen, stop, settle, state: () => controller.getState() };
}

let stops: Array<() => void> = [];

function track<T extends { stop: () => void }>(value: T): T {
  stops.push(value.stop);
  return value;
}

beforeEach(() => {
  stops = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  vi.restoreAllMocks();
});

describe("the connectivity store: what the open page knows about the connection", () => {
  it("starts online in episode 0, and the server snapshot is the same", () => {
    const { state } = track(setup());
    expect(state()).toEqual({ status: "online", cause: null, episode: 0 });
    expect(INITIAL_CONNECTIVITY).toEqual({ status: "online", cause: null, episode: 0 });
  });

  it("follows the browser's offline and online events, and counts an episode for each time it goes offline", () => {
    const { state, seen } = track(setup());
    browserGoes("offline");
    expect(state()).toEqual({ status: "offline", cause: "browser", episode: 1 });
    browserGoes("online");
    expect(state()).toEqual({ status: "online", cause: null, episode: 1 });
    browserGoes("offline");
    expect(state()).toEqual({ status: "offline", cause: "browser", episode: 2 });
    expect(seen).toHaveLength(3);
  });

  it("reads the browser's flag as a hint when watching starts", () => {
    const { state } = track(setup({ browserOffline: true }));
    expect(state()).toEqual({ status: "offline", cause: "browser", episode: 1 });
  });

  it("does not notify when nothing changed", () => {
    const { seen, settle } = track(setup());
    settle("success");
    settle("api_error");
    settle("aborted");
    expect(seen).toHaveLength(0);
  });

  it("counts a request that failed before any answer (network) as offline, caused by the request", () => {
    const { state, settle } = track(setup());
    settle("connectivity", "network");
    expect(state()).toEqual({ status: "offline", cause: "request", episode: 1 });
  });

  it.each<ConnectivityReason>(["gateway", "timeout", "invalid_response"])("does not count a %s failure as offline: the server is slow or asleep, not the device", (reason) => {
    const { state, settle } = track(setup());
    settle("connectivity", reason);
    expect(state()).toEqual({ status: "online", cause: null, episode: 0 });
  });

  it("does not count a failure with no reason, or an aborted request", () => {
    const { state, settle } = track(setup());
    settle("connectivity");
    settle("aborted");
    expect(state().status).toBe("online");
  });

  it("is never offline for an answer of the application, a 401 among them, and an answer ends a request-caused offline", () => {
    const { state, settle } = track(setup());
    settle("api_error");
    expect(state().status).toBe("online");
    settle("connectivity", "network");
    expect(state().status).toBe("offline");
    settle("api_error");
    expect(state()).toEqual({ status: "online", cause: null, episode: 1 });
    // A second failure is a second episode; a success ends it as well.
    settle("connectivity", "network");
    expect(state().episode).toBe(2);
    settle("success");
    expect(state()).toEqual({ status: "online", cause: null, episode: 2 });
  });

  it("keeps a request-caused offline through a timeout or a gateway answer, which say nothing about the device", () => {
    const { state, settle } = track(setup());
    settle("connectivity", "network");
    settle("connectivity", "timeout");
    settle("connectivity", "gateway");
    settle("aborted");
    expect(state()).toEqual({ status: "offline", cause: "request", episode: 1 });
  });

  it("calls a waking or timed-out server server_unavailable, never an episode of offline, and clears it when health answers", () => {
    const { state, wake } = track(setup());
    wake.set("busy");
    expect(state().status).toBe("online");
    wake.set("waking");
    expect(state()).toEqual({ status: "server_unavailable", cause: null, episode: 0 });
    wake.set("timed_out");
    expect(state()).toEqual({ status: "server_unavailable", cause: null, episode: 0 });
    wake.set("ready");
    expect(state()).toEqual({ status: "online", cause: null, episode: 0 });
    wake.set("idle");
    expect(state().status).toBe("online");
  });

  it("clears a request failure when the server's own health answers (wake-up ready)", () => {
    const { state, wake, settle } = track(setup());
    settle("connectivity", "network");
    wake.set("waking");
    expect(state().status).toBe("offline");
    wake.set("ready");
    expect(state()).toEqual({ status: "online", cause: null, episode: 1 });
  });

  it("puts the browser first, then a request failure, then the wake-up", () => {
    const { state, wake, settle } = track(setup());
    wake.set("waking");
    expect(state().status).toBe("server_unavailable");
    settle("connectivity", "network");
    expect(state()).toEqual({ status: "offline", cause: "request", episode: 1 });
    browserGoes("offline");
    // The cause changed inside one episode: no new episode.
    expect(state()).toEqual({ status: "offline", cause: "browser", episode: 1 });
    browserGoes("online");
    // The browser coming back retires the request failure it saw; the waking server is still said.
    expect(state()).toEqual({ status: "server_unavailable", cause: null, episode: 1 });
    wake.set("ready");
    expect(state()).toEqual({ status: "online", cause: null, episode: 1 });
  });

  it("markReachable clears a request failure but never the browser's offline", () => {
    const { state, settle, controller } = track(setup());
    settle("connectivity", "network");
    controller.markReachable();
    expect(state()).toEqual({ status: "online", cause: null, episode: 1 });
    browserGoes("offline");
    controller.markReachable();
    expect(state()).toEqual({ status: "offline", cause: "browser", episode: 2 });
  });

  it("counts an episode only when the status moves into offline, not between the causes or out of it", () => {
    const { state, settle, wake } = track(setup());
    settle("connectivity", "network"); // into offline: 1
    browserGoes("offline"); // same episode
    settle("success"); // still offline by the browser
    expect(state()).toEqual({ status: "offline", cause: "browser", episode: 1 });
    browserGoes("online");
    expect(state().status).toBe("online");
    wake.set("waking"); // server_unavailable is not offline
    expect(state().episode).toBe(1);
    settle("connectivity", "network"); // into offline from server_unavailable: 2
    expect(state().episode).toBe(2);
  });

  it("stops listening to the browser when the last watcher leaves, and reads the flag again when one returns", () => {
    const watcher = setup();
    watcher.stop();
    browserGoes("offline");
    expect(watcher.state().status).toBe("online");
    setNavigatorOnline(false);
    const stop = watcher.controller.subscribe(() => undefined);
    stops.push(stop);
    expect(watcher.state()).toEqual({ status: "offline", cause: "browser", episode: 1 });
  });
});

describe("the request monitor carries the reason of a connectivity failure", () => {
  const settled = async (run: (monitor: RequestMonitor) => Promise<unknown>) => {
    const monitor = new RequestMonitor();
    const events: Array<{ outcome: RequestOutcome; reason?: ConnectivityReason }> = [];
    monitor.subscribe({ onSettle: (_id, outcome, reason) => events.push({ outcome, reason }) });
    await run(monitor).catch(() => undefined);
    return events;
  };

  it("reports network when fetch itself fails", async () => {
    const events = await settled((monitor) => createApiClient({ monitor, fetch: async () => Promise.reject(new TypeError("Failed to fetch")) }).get("/today"));
    expect(events).toEqual([{ outcome: "connectivity", reason: "network" }]);
  });

  it("reports gateway for a 5xx outside the envelope and invalid_response for another answer", async () => {
    const gateway = await settled((monitor) => createApiClient({ monitor, fetch: async () => new Response("<html>asleep</html>", { status: 502 }) }).get("/today"));
    expect(gateway).toEqual([{ outcome: "connectivity", reason: "gateway" }]);
    const invalid = await settled((monitor) => createApiClient({ monitor, fetch: async () => new Response("not json", { status: 200 }) }).get("/today"));
    expect(invalid).toEqual([{ outcome: "connectivity", reason: "invalid_response" }]);
  });

  it("reports timeout when the client's own timeout fires", async () => {
    const events = await settled((monitor) =>
      createApiClient({
        monitor,
        timeoutMs: 5,
        fetch: (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      }).get("/today"),
    );
    expect(events).toEqual([{ outcome: "connectivity", reason: "timeout" }]);
  });

  it("reports no reason for an answer of the application, a 401 among them, or for a success", async () => {
    const envelope = JSON.stringify({ error: { code: "unauthenticated", message: "Authentication is required.", details: {} } });
    const unauthenticated = await settled((monitor) => createApiClient({ monitor, fetch: async () => new Response(envelope, { status: 401 }) }).get("/me"));
    expect(unauthenticated).toEqual([{ outcome: "api_error", reason: undefined }]);
    const ok = await settled((monitor) => createApiClient({ monitor, fetch: async () => new Response("{}", { status: 200 }) }).get("/me"));
    expect(ok).toEqual([{ outcome: "success", reason: undefined }]);
  });
});

describe("the runtime wires the store to the client and the wake-up controller", () => {
  const envelope = JSON.stringify({ error: { code: "unauthenticated", message: "Authentication is required.", details: {} } });

  it("goes offline on a failed request, stays offline through the wake-up it raises, and is online again after a 401, which proves the server is reachable", async () => {
    setNavigatorOnline(true);
    let answer: () => Promise<Response> = () => Promise.reject(new TypeError("Failed to fetch"));
    const runtime = createApiRuntime({ mode: "live", fetch: vi.fn<typeof fetch>(async () => answer()) });
    try {
      await runtime.client.get("/today").catch(() => undefined);
      expect(runtime.connectivity.getState()).toEqual({ status: "offline", cause: "request", episode: 1 });
      expect(runtime.wakeUp.getState().phase).toBe("waking");
      answer = async () => new Response(envelope, { status: 401 });
      await runtime.client.get("/me").catch(() => undefined);
      expect(runtime.connectivity.getState().status).not.toBe("offline");
    } finally {
      runtime.wakeUp.dispose();
    }
  });

  it("is server_unavailable, not offline, when the server answers outside the envelope", async () => {
    setNavigatorOnline(true);
    const runtime = createApiRuntime({ mode: "live", fetch: vi.fn<typeof fetch>(async () => new Response("<html>asleep</html>", { status: 502 })) });
    try {
      await runtime.client.get("/today").catch(() => undefined);
      expect(runtime.connectivity.getState()).toEqual({ status: "server_unavailable", cause: null, episode: 0 });
    } finally {
      runtime.wakeUp.dispose();
    }
  });
});

describe("isOfflineSwapRoute: the pages that only read", () => {
  it.each(["/today", "/plan", "/progress", "/games", "/lessons", "/settings/sources"])("swaps on %s, with or without a trailing slash", (path) => {
    expect(isOfflineSwapRoute(path)).toBe(true);
    expect(isOfflineSwapRoute(`${path}/`)).toBe(true);
  });

  it.each([
    "/",
    "/offline",
    "/settings",
    "/settings/",
    "/settings/password",
    "/settings/privacy",
    "/settings/recovery-code",
    "/settings/delete-account",
    "/plan/revise",
    "/plan/chat/abc",
    "/session/abc/result",
    "/today/extra",
    "/games/word-order",
    "/lessons/section-1",
    "/admin",
    "/admin/books",
    "/demo/simulations",
    "/start",
    "/login",
  ])("keeps the page on %s and shows a notice instead", (path) => {
    expect(isOfflineSwapRoute(path)).toBe(false);
  });

  it("is false when there is no pathname", () => {
    expect(isOfflineSwapRoute(null)).toBe(false);
    expect(isOfflineSwapRoute(undefined)).toBe(false);
    expect(isOfflineSwapRoute("")).toBe(false);
  });
});
