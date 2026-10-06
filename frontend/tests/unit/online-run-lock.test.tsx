import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnlineRunLock } from "@/components/session/use-online-run-lock";
import { onlineRunLockName } from "@/lib/offline/sync";

const SESSION = "55555555-5555-4555-8555-555555555581";

// A tiny LockManager: a request is granted on the next tick (or when `grant()` is called), the callback's promise is the hold, and the lock is free again
// when that promise settles.
function installLocks({ deferred = false }: { deferred?: boolean } = {}) {
  const held = new Set<string>();
  const requested: string[] = [];
  const grants: (() => void)[] = [];
  const request = vi.fn((name: string, callback: (lock: unknown) => unknown) => {
    requested.push(name);
    return new Promise<unknown>((resolve, reject) => {
      const grant = () => {
        held.add(name);
        Promise.resolve(callback({ name })).then(
          (value) => {
            held.delete(name);
            resolve(value);
          },
          (error: unknown) => {
            held.delete(name);
            reject(error);
          },
        );
      };
      if (deferred) grants.push(grant);
      else queueMicrotask(grant);
    });
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return { held, requested, request, grant: () => grants.splice(0).forEach((grant) => grant()) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
});

describe("useOnlineRunLock", () => {
  it("holds qatra-online-run:<sessionId> while the screen is mounted, and lets it go on unmount", async () => {
    const locks = installLocks();
    const { unmount } = renderHook(() => useOnlineRunLock(SESSION));
    await settle();
    expect(locks.requested).toEqual([onlineRunLockName(SESSION)]);
    expect([...locks.held]).toEqual([`qatra-online-run:${SESSION}`]);
    unmount();
    await settle();
    expect(locks.held.size).toBe(0);
  });

  it("holds it for the whole life of the screen, not for a render: re-rendering asks nothing new", async () => {
    const locks = installLocks();
    const { rerender, unmount } = renderHook(() => useOnlineRunLock(SESSION));
    await settle();
    rerender();
    rerender();
    await settle();
    expect(locks.request).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("takes the lock and gives it back at once when the screen went away before it was granted", async () => {
    const locks = installLocks({ deferred: true });
    const { unmount } = renderHook(() => useOnlineRunLock(SESSION));
    await settle();
    expect(locks.held.size).toBe(0);
    unmount();
    locks.grant();
    await settle();
    expect(locks.held.size).toBe(0);
  });

  it("asks nothing when it is not enabled, and does nothing where the Locks API is missing", async () => {
    const locks = installLocks();
    renderHook(() => useOnlineRunLock(SESSION, false));
    await settle();
    expect(locks.request).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    expect(() => renderHook(() => useOnlineRunLock(SESSION)).unmount()).not.toThrow();
  });

  it("lets a request that fails go: the run is never stopped by the lock", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: () => Promise.reject(new DOMException("denied", "SecurityError")) } });
    expect(() => renderHook(() => useOnlineRunLock(SESSION)).unmount()).not.toThrow();
    await settle();
  });
});
