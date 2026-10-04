import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { createEndpoints, probeHealth } from "@/lib/api/endpoints";
import { RequestMonitor } from "@/lib/api/monitor";
import { pollDelayMs, WakeUpController, type WakeUpPhase } from "@/lib/api/wakeup";

// A probe the test controls: every call is recorded with its time and can be answered later.
function createProbe() {
  const calls: { at: number; signal: AbortSignal; resolve: (answered: boolean) => void; reject: (error: unknown) => void }[] = [];
  const probe = (signal: AbortSignal) =>
    new Promise<boolean>((resolve, reject) => {
      calls.push({ at: Date.now(), signal, resolve, reject });
    });
  return { probe, calls, times: () => calls.map((call) => call.at - start) };
}

let start = 0;

function setup(options: { probe?: ReturnType<typeof createProbe> } = {}) {
  const probe = options.probe ?? createProbe();
  const monitor = new RequestMonitor();
  const controller = new WakeUpController({ probe: probe.probe });
  controller.attach(monitor);
  const phases: WakeUpPhase[] = [];
  controller.subscribe(() => phases.push(controller.getState().phase));
  return { probe, monitor, controller, phases, phase: () => controller.getState().phase };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  start = Date.now();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wake-up controller: the 1 s and 2 s rules (G-01, UG-06 final rule)", () => {
  it("does nothing for a request that settles within 1 s", async () => {
    const { monitor, probe, phase } = setup();
    const id = monitor.start();
    await tick(999);
    expect(phase()).toBe("idle");
    monitor.settle(id, "success");
    await tick(5_000);
    expect(phase()).toBe("idle");
    expect(probe.calls).toHaveLength(0);
  });

  it("shows only the neutral busy indicator at 1 s and starts one parallel probe", async () => {
    const { monitor, probe, phase } = setup();
    monitor.start();
    await tick(1_000);
    expect(phase()).toBe("busy");
    expect(probe.times()).toEqual([1_000]);
  });

  it("starts a single probe however many requests are pending", async () => {
    const { monitor, probe } = setup();
    monitor.start();
    monitor.start();
    monitor.start();
    await tick(1_000);
    expect(probe.calls).toHaveLength(1);
  });

  it("stays on the busy indicator when the probe answers while the original request is still pending", async () => {
    const { monitor, probe, phase, phases } = setup();
    const id = monitor.start();
    await tick(1_000);
    probe.calls[0]?.resolve(true);
    await tick(10_000);
    expect(phase()).toBe("busy");
    expect(phases).not.toContain("waking");
    monitor.settle(id, "success");
    expect(phase()).toBe("idle");
  });

  it("returns to idle when the probe answers after the original request already settled", async () => {
    const { monitor, probe, phase } = setup();
    const id = monitor.start();
    await tick(1_000);
    monitor.settle(id, "success");
    expect(phase()).toBe("idle");
    probe.calls[0]?.resolve(true);
    await tick(0);
    expect(phase()).toBe("idle");
  });

  it("shows the line at once when the probe fails", async () => {
    const { monitor, probe, phase } = setup();
    monitor.start();
    await tick(1_000);
    probe.calls[0]?.resolve(false);
    await tick(0);
    expect(phase()).toBe("waking");
  });

  it("shows the line at once when the probe rejects", async () => {
    const { monitor, probe, phase } = setup();
    monitor.start();
    await tick(1_000);
    probe.calls[0]?.reject(new Error("network"));
    await tick(0);
    expect(phase()).toBe("waking");
  });

  it("shows the line when the probe gives no answer within 2 s, and cancels that probe", async () => {
    const { monitor, probe, phase } = setup();
    monitor.start();
    await tick(1_000);
    await tick(1_999);
    expect(phase()).toBe("busy");
    await tick(1);
    expect(phase()).toBe("waking");
    expect(probe.calls[0]?.signal.aborted).toBe(true);
  });

  it("ignores a late answer from the cancelled probe", async () => {
    const { monitor, probe, phase } = setup();
    monitor.start();
    await tick(3_000);
    expect(phase()).toBe("waking");
    probe.calls[0]?.resolve(true);
    await tick(0);
    expect(phase()).toBe("waking");
  });

  it("shows the line immediately when a request fails outside the envelope", async () => {
    const { monitor, probe, phase } = setup();
    const id = monitor.start();
    await tick(10);
    monitor.settle(id, "connectivity");
    expect(phase()).toBe("waking");
    expect(probe.calls).toHaveLength(0);
  });

  it("does not show the line for an enveloped error or an aborted request", async () => {
    const { monitor, phase } = setup();
    monitor.settle(monitor.start(), "api_error");
    monitor.settle(monitor.start(), "aborted");
    await tick(5_000);
    expect(phase()).toBe("idle");
  });
});

describe("wake-up controller: polling with backoff, 90 s limit, retry", () => {
  it("computes the delay: 1, 2, 4, 8 s, then every 10 s", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((index) => pollDelayMs(index))).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it("polls health after waits of 1, 2, 4, 8 s and then every 10 s", async () => {
    const { monitor, probe, phase } = setup();
    monitor.settle(monitor.start(), "connectivity");
    expect(phase()).toBe("waking");
    // Every poll fails the moment it is sent, so each wait is counted from the previous poll.
    let answered = 0;
    for (let second = 0; second < 70; second += 1) {
      await tick(1_000);
      for (; answered < probe.calls.length; answered += 1) probe.calls[answered]?.resolve(false);
    }
    expect(probe.times()).toEqual([1_000, 3_000, 7_000, 15_000, 25_000, 35_000, 45_000, 55_000, 65_000]);
  });

  it("goes ready when a poll answers, runs the ready listeners, then returns to idle", async () => {
    const { monitor, probe, controller, phase } = setup();
    const onReady = vi.fn();
    controller.onReady(onReady);
    monitor.settle(monitor.start(), "connectivity");
    await tick(1_000);
    probe.calls[0]?.resolve(true);
    await tick(0);
    expect(phase()).toBe("ready");
    expect(onReady).toHaveBeenCalledTimes(1);
    await tick(5_000);
    expect(phase()).toBe("idle");
    const callsAfterReady = probe.calls.length;
    await tick(60_000);
    expect(probe.calls).toHaveLength(callsAfterReady);
  });

  it("keeps polling after a rejected poll", async () => {
    const { monitor, probe, phase } = setup();
    monitor.settle(monitor.start(), "connectivity");
    await tick(1_000);
    probe.calls[0]?.reject(new Error("network"));
    await tick(2_000);
    expect(probe.calls).toHaveLength(2);
    expect(phase()).toBe("waking");
  });

  it("shows the retry state 90 s after the line appeared, and stops polling", async () => {
    const { monitor, probe, phase } = setup();
    monitor.settle(monitor.start(), "connectivity");
    await tick(89_999);
    expect(phase()).toBe("waking");
    await tick(1);
    expect(phase()).toBe("timed_out");
    expect(probe.calls.every((call) => call.signal.aborted)).toBe(true);
    const polls = probe.calls.length;
    await tick(120_000);
    expect(probe.calls).toHaveLength(polls);
    expect(phase()).toBe("timed_out");
  });

  it("measures the 90 s from the moment the line appeared, not from the first request", async () => {
    const { monitor, phase } = setup();
    monitor.start();
    await tick(3_000);
    expect(phase()).toBe("waking");
    await tick(89_999);
    expect(phase()).toBe("waking");
    await tick(1);
    expect(phase()).toBe("timed_out");
  });

  it("retry() starts a new 90 s round with an immediate poll, and can still end in ready", async () => {
    const { monitor, probe, controller, phase } = setup();
    monitor.settle(monitor.start(), "connectivity");
    await tick(90_000);
    expect(phase()).toBe("timed_out");
    const before = probe.calls.length;

    controller.retry();
    expect(phase()).toBe("waking");
    await tick(0);
    expect(probe.calls).toHaveLength(before + 1);
    probe.calls[before]?.resolve(true);
    await tick(0);
    expect(phase()).toBe("ready");
  });

  it("retry() times out again after another 90 s and ignores calls outside the retry state", async () => {
    const { monitor, controller, phase } = setup();
    controller.retry();
    expect(phase()).toBe("idle");
    monitor.settle(monitor.start(), "connectivity");
    controller.retry();
    expect(phase()).toBe("waking");
    await tick(90_000);
    expect(phase()).toBe("timed_out");
    controller.retry();
    await tick(90_000);
    expect(phase()).toBe("timed_out");
  });

  it("treats an answer from the application as proof that the server is up, even an error answer", async () => {
    const { monitor, phase } = setup();
    const slow = monitor.start();
    const failing = monitor.start();
    monitor.settle(failing, "connectivity");
    expect(phase()).toBe("waking");
    monitor.settle(slow, "api_error");
    expect(phase()).toBe("ready");
  });

  it("does not restart while waking when more requests start or fail", async () => {
    const { monitor, probe, phases } = setup();
    monitor.settle(monitor.start(), "connectivity");
    const extra = monitor.start();
    await tick(1_000);
    monitor.settle(extra, "connectivity");
    await tick(0);
    expect(phases).toEqual(["waking"]);
    expect(probe.calls).toHaveLength(1);
  });

  it("a request that starts after ready begins a new episode", async () => {
    const { monitor, probe, phase } = setup();
    monitor.settle(monitor.start(), "connectivity");
    await tick(1_000);
    probe.calls[0]?.resolve(true);
    await tick(0);
    expect(phase()).toBe("ready");
    monitor.start();
    await tick(1_000);
    expect(phase()).toBe("busy");
  });

  it("dispose() stops every timer", async () => {
    const { monitor, probe, controller } = setup();
    monitor.settle(monitor.start(), "connectivity");
    controller.dispose();
    await tick(200_000);
    expect(probe.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("wake-up controller with the real client and health endpoint", () => {
  function realSetup(handler: (url: string) => Response | Promise<Response>) {
    const fetchMock = vi.fn<typeof fetch>(async (input) => handler(String(input)));
    const monitor = new RequestMonitor();
    const client = createApiClient({ fetch: fetchMock, monitor });
    const api = createEndpoints(client);
    const controller = new WakeUpController({ probe: (signal) => probeHealth(api, signal) });
    controller.attach(monitor);
    return { fetchMock, api, controller };
  }

  const ok = () => new Response(JSON.stringify({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }), { status: 200 });
  const gateway = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });

  it("an un-enveloped gateway answer shows the line immediately, and the next healthy poll ends it", async () => {
    let healthy = false;
    const { controller, api, fetchMock } = realSetup(() => (healthy ? ok() : gateway()));
    await api.health({ track: true }).catch(() => undefined);
    expect(controller.getState().phase).toBe("waking");

    healthy = true;
    await tick(1_000);
    expect(controller.getState().phase).toBe("ready");
    const polled = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(polled).toEqual(["/api/health", "/api/health"]);
  });

  it("a health answer that is not the documented body does not count as awake", async () => {
    const { controller, api } = realSetup(() => new Response("<html>Starting</html>", { status: 200 }));
    await api.health({ track: true }).catch(() => undefined);
    expect(controller.getState().phase).toBe("waking");
    await tick(30_000);
    expect(controller.getState().phase).toBe("waking");
  });

  it("probes are untracked, so a probe never starts another probe", async () => {
    const { controller, api, fetchMock } = realSetup(() => new Promise<Response>(() => undefined));
    void api.health({ track: true }).catch(() => undefined);
    await tick(1_000);
    expect(controller.getState().phase).toBe("busy");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(5_000);
    expect(fetchMock.mock.calls.length).toBeLessThan(6);
  });
});
