import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_LOCK_NAME, applyUpdateWhenSafe, holdRunLock, inspectUpdate, isRunActiveAnywhere, watchForUpdates } from "@/lib/pwa/update";
import type { UpdateState } from "@/lib/offline/types";
import { FakeContainer, FakeRegistration, FakeWorker, fakeLocks, installContainer, removeContainer } from "./pwa-sw-support";
import { FakeBroadcastChannel, resetOfflineEnvironment } from "./offline-support";

let container: FakeContainer;

beforeEach(() => {
  resetOfflineEnvironment();
  container = installContainer();
});
afterEach(() => {
  removeContainer();
  delete (navigator as unknown as { locks?: unknown }).locks;
  vi.useRealTimers();
});

describe("inspectUpdate (PWA-design 8)", () => {
  it("is available only while a worker waits", () => {
    expect(inspectUpdate(null)).toEqual({ phase: "idle" });
    expect(inspectUpdate(undefined)).toEqual({ phase: "idle" });
    expect(inspectUpdate({ waiting: null })).toEqual({ phase: "idle" });
    expect(inspectUpdate({ waiting: new FakeWorker() as unknown as ServiceWorker })).toEqual({ phase: "available" });
  });
});

describe("applyUpdateWhenSafe: no activation during a run", () => {
  function waitingRegistration() {
    const registration = new FakeRegistration();
    registration.waiting = new FakeWorker();
    return registration;
  }

  it("does nothing, and posts nothing, while a run is active (not_safe)", async () => {
    const registration = waitingRegistration();
    const result = await applyUpdateWhenSafe(registration as never, { isSafe: () => false });
    expect(result).toEqual({ phase: "available", failureCode: "not_safe" });
    expect(registration.waiting?.messages).toEqual([]);
  });

  it("at a safe point posts SKIP_WAITING, waits for the new controller, then reloads", async () => {
    const registration = waitingRegistration();
    const reload = vi.fn();
    const states: UpdateState[] = [];
    const pending = applyUpdateWhenSafe(registration as never, { isSafe: () => true, reload, onState: (s) => states.push(s) });
    await vi.waitFor(() => expect(registration.waiting?.messages).toEqual([{ type: "SKIP_WAITING" }]));
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event("controllerchange"));
    expect(await pending).toEqual({ phase: "applying" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ phase: "applying" }]);
  });

  it("also accepts the worker reporting `activated`, for a page that was not controlled", async () => {
    const registration = waitingRegistration();
    const reload = vi.fn();
    const pending = applyUpdateWhenSafe(registration as never, { isSafe: () => true, reload });
    await vi.waitFor(() => expect(registration.waiting?.messages).toHaveLength(1));
    registration.waiting?.setState("activated");
    expect(await pending).toEqual({ phase: "applying" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a worker that does not activate in time is a failed state and the old worker stays in charge; nothing reloads", async () => {
    const registration = waitingRegistration();
    const reload = vi.fn();
    expect(await applyUpdateWhenSafe(registration as never, { isSafe: () => true, reload, timeoutMs: 10 })).toEqual({ phase: "failed", failureCode: "activation_timeout" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("handles no registration and no waiting worker", async () => {
    expect(await applyUpdateWhenSafe(null)).toEqual({ phase: "failed", failureCode: "no_registration" });
    expect(await applyUpdateWhenSafe(new FakeRegistration() as never)).toEqual({ phase: "idle" });
  });

  it("by default it is safe only when no run holds the run lock in any tab", async () => {
    Object.defineProperty(navigator, "locks", { value: fakeLocks(), configurable: true });
    const registration = waitingRegistration();
    const release = await holdRunLock();
    expect(await applyUpdateWhenSafe(registration as never, { reload: vi.fn(), timeoutMs: 10 })).toEqual({ phase: "available", failureCode: "not_safe" });
    release();
    await vi.waitFor(async () => expect(await isRunActiveAnywhere()).toBe(false));
    expect(await applyUpdateWhenSafe(registration as never, { reload: vi.fn(), timeoutMs: 10 })).toEqual({ phase: "failed", failureCode: "activation_timeout" });
  });
});

describe("the run lock (other tabs can see a run)", () => {
  it("is held as a shared Web Lock while a run is active, and released when it ends", async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    expect(await isRunActiveAnywhere()).toBe(false);
    const release = await holdRunLock();
    expect(locks.held).toEqual([{ name: RUN_LOCK_NAME, mode: "shared" }]);
    expect(await isRunActiveAnywhere()).toBe(true);
    release();
    release(); // releasing twice is harmless
    await vi.waitFor(() => expect(locks.held).toEqual([]));
    expect(await isRunActiveAnywhere()).toBe(false);
  });

  it("another tab's lock counts", async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    locks.held.push({ name: RUN_LOCK_NAME, mode: "shared" });
    expect(await isRunActiveAnywhere()).toBe(true);
    locks.held.length = 0;
    locks.held.push({ name: "something-else", mode: "exclusive" });
    expect(await isRunActiveAnywhere()).toBe(false);
  });

  it("without Web Locks only this tab's own runs are known", async () => {
    expect(await isRunActiveAnywhere()).toBe(false);
    const release = await holdRunLock();
    expect(await isRunActiveAnywhere()).toBe(true);
    release();
    expect(await isRunActiveAnywhere()).toBe(false);
  });
});

describe("watchForUpdates", () => {
  it("reports the state now and at every change, and tells the other tabs when an update waits", () => {
    const registration = new FakeRegistration();
    const states: UpdateState[] = [];
    const stop = watchForUpdates(registration as never, (state) => states.push(state));
    expect(states).toEqual([{ phase: "idle" }]);

    const installing = new FakeWorker("installing");
    registration.installing = installing;
    registration.dispatchEvent(new Event("updatefound"));
    registration.installing = null;
    registration.waiting = installing;
    installing.setState("installed");
    expect(states.at(-1)).toEqual({ phase: "available" });
    expect(FakeBroadcastChannel.log).toContainEqual({ type: "UPDATE_PENDING" });

    registration.waiting = null;
    installing.setState("activated");
    expect(states.at(-1)).toEqual({ phase: "idle" });
    stop();
  });

  it("asks the browser for a new worker when the page becomes visible again, and stops when told to", () => {
    const registration = new FakeRegistration();
    const stop = watchForUpdates(registration as never, () => undefined);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledTimes(1);
    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("is idle without a registration", () => {
    const onChange = vi.fn();
    watchForUpdates(null, onChange)();
    expect(onChange).toHaveBeenCalledWith({ phase: "idle" });
  });
});
