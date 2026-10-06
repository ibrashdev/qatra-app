import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { combineReadiness, getOfflineReadiness, getShellStatus, isServiceWorkerSupported, registerServiceWorker, subscribeShellReady } from "@/lib/pwa/register";
import { FakeContainer, FakeRegistration, FakeWorker, installContainer, removeContainer } from "./pwa-sw-support";
import { USERNAME, makeSnapshot, resetOfflineEnvironment } from "./offline-support";

let container: FakeContainer;

beforeEach(() => {
  resetOfflineEnvironment();
  container = installContainer();
});
afterEach(() => {
  removeContainer();
  vi.unstubAllEnvs();
});

const reply = (shellReady: boolean, missing = 0) => ({ type: "STATUS", buildId: "b1", cacheName: "qatra-shell-b1-x", shellReady, missing, total: 70 });

describe("registerServiceWorker", () => {
  it("registers /sw.js at scope / with updateViaCache none, after the page has loaded", async () => {
    const registration = await registerServiceWorker();
    expect(registration).toBeInstanceOf(FakeRegistration);
    expect(container.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  });

  it("fails safely: an unsupported browser, an insecure page, a missing file", async () => {
    removeContainer();
    expect(isServiceWorkerSupported()).toBe(false);
    expect(await registerServiceWorker()).toBeNull();

    container = installContainer(new FakeContainer(), false);
    expect(isServiceWorkerSupported()).toBe(false);
    expect(await registerServiceWorker()).toBeNull();
    expect(container.register).not.toHaveBeenCalled();

    container = installContainer();
    container.register.mockRejectedValueOnce(new TypeError("Failed to register: 404"));
    expect(await registerServiceWorker()).toBeNull();
  });

  it("does not register from a development server unless it is switched on (a stale worker would serve an old shell)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await registerServiceWorker()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_ENABLE_SW", "1");
    expect(await registerServiceWorker()).toBeInstanceOf(FakeRegistration);
  });
});

describe("getShellStatus: registration is not readiness", () => {
  it("reports unsupported, unregistered, and a worker that is not active yet", async () => {
    removeContainer();
    expect(await getShellStatus()).toMatchObject({ supported: false, registered: false, shellReady: false });
    container = installContainer();
    expect(await getShellStatus()).toMatchObject({ supported: true, registered: false, shellReady: false });
    const registration = new FakeRegistration();
    container.getRegistration.mockResolvedValue(registration);
    expect(await getShellStatus()).toMatchObject({ supported: true, registered: true, controlled: false, shellReady: false, buildId: null });
  });

  it("asks the active worker and reports its cache: ready only when every file is there", async () => {
    const registration = new FakeRegistration();
    registration.active = new FakeWorker("activated");
    container.getRegistration.mockResolvedValue(registration);
    container.controller = {};
    registration.active.statusReply = reply(true);
    expect(await getShellStatus()).toEqual({ supported: true, registered: true, controlled: true, shellReady: true, buildId: "b1", missing: 0 });
    registration.active.statusReply = reply(false, 4);
    expect(await getShellStatus()).toMatchObject({ shellReady: false, missing: 4 });
    expect(registration.active.messages).toContainEqual({ type: "GET_STATUS" });
  });

  it("a worker that does not answer, or answers nonsense, is not ready", async () => {
    const registration = new FakeRegistration();
    registration.active = new FakeWorker("activated");
    container.getRegistration.mockResolvedValue(registration);
    expect(await getShellStatus(20)).toMatchObject({ registered: true, shellReady: false });
    registration.active.statusReply = { type: "STATUS", shellReady: "yes" };
    expect(await getShellStatus(20)).toMatchObject({ shellReady: false });
  });

  it("a registration lookup that throws is unregistered", async () => {
    container.getRegistration.mockRejectedValue(new Error("no"));
    expect(await getShellStatus()).toMatchObject({ supported: true, registered: false });
  });
});

describe("readiness = shellReady AND snapshotReady (PWA-design 4)", () => {
  it("combines both, and each alone is not enough", () => {
    expect(combineReadiness({ shellReady: true }, "ready")).toEqual({ shellReady: true, snapshotReady: true, ready: true });
    expect(combineReadiness({ shellReady: true }, "stale")).toEqual({ shellReady: true, snapshotReady: false, ready: false });
    expect(combineReadiness({ shellReady: false }, "ready")).toEqual({ shellReady: false, snapshotReady: true, ready: false });
    expect(combineReadiness({ shellReady: false }, "none").ready).toBe(false);
  });

  it("reads both at boot", async () => {
    const registration = new FakeRegistration();
    registration.active = new FakeWorker("activated");
    registration.active.statusReply = reply(true);
    container.getRegistration.mockResolvedValue(registration);
    expect(await getOfflineReadiness()).toEqual({ shellReady: true, snapshotReady: false, ready: false });
    await cacheActivePlan(makeSnapshot(), { username: USERNAME });
    expect(await getOfflineReadiness()).toEqual({ shellReady: true, snapshotReady: true, ready: true });
    registration.active.statusReply = reply(false, 1);
    expect(await getOfflineReadiness()).toEqual({ shellReady: false, snapshotReady: true, ready: false });
  });
});

describe("subscribeShellReady", () => {
  it("calls back for SHELL_READY only, and stops when told to", () => {
    const handler = vi.fn();
    const stop = subscribeShellReady(handler);
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "OTHER" } }));
    container.dispatchEvent(Object.assign(new Event("message"), { data: null }));
    expect(handler).not.toHaveBeenCalled();
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "SHELL_READY", buildId: "b1" } }));
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "SHELL_READY" } }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
