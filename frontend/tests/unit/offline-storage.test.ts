import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishOfflineMessage, subscribeOfflineMessages } from "@/lib/offline/broadcast";
import { MIN_FREE_SPACE_FACTOR, estimateStorage, hasEnoughSpace, isQuotaError, requestPersistence, utf8Length } from "@/lib/offline/storage";
import type { OfflineMessage } from "@/lib/offline/types";
import { FakeBroadcastChannel, resetOfflineEnvironment } from "./offline-support";

function stubStorage(storage: unknown): void {
  Object.defineProperty(navigator, "storage", { value: storage, configurable: true });
}

beforeEach(() => resetOfflineEnvironment());
afterEach(() => {
  delete (navigator as unknown as { storage?: unknown }).storage;
  vi.unstubAllGlobals();
});

describe("storage estimate and persistence (PWA-design 8: estimates and requests, never guarantees)", () => {
  it("reads quota, usage and free space, and says null when the browser cannot", async () => {
    expect(await estimateStorage()).toBeNull();
    stubStorage({ estimate: async () => ({ quota: 1000, usage: 250 }) });
    expect(await estimateStorage()).toEqual({ quota: 1000, usage: 250, free: 750 });
    stubStorage({ estimate: async () => ({}) });
    expect(await estimateStorage()).toEqual({ quota: null, usage: null, free: null });
    stubStorage({
      estimate: async () => {
        throw new Error("no");
      },
    });
    expect(await estimateStorage()).toBeNull();
  });

  it("requires three times the snapshot as free space, and allows an unknown estimate", () => {
    expect(MIN_FREE_SPACE_FACTOR).toBe(3);
    expect(hasEnoughSpace({ quota: 100, usage: 0, free: 300 }, 100)).toBe(true);
    expect(hasEnoughSpace({ quota: 100, usage: 0, free: 299 }, 100)).toBe(false);
    expect(hasEnoughSpace(null, 1e9)).toBe(true);
    expect(hasEnoughSpace({ quota: null, usage: null, free: null }, 1e9)).toBe(true);
  });

  it("asks for persistence once, and reports what the browser said (or null)", async () => {
    expect(await requestPersistence()).toBeNull();
    const persist = vi.fn(async () => false);
    stubStorage({ persist, persisted: async () => false });
    expect(await requestPersistence()).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    const again = vi.fn(async () => true);
    stubStorage({ persist: again, persisted: async () => true });
    expect(await requestPersistence()).toBe(true);
    expect(again).not.toHaveBeenCalled();
  });

  it("recognises a quota error by name or code, and measures bytes in UTF-8", () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error("x"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("قطرة")).toBe(8);
  });
});

describe("BroadcastChannel notices (speed only, never the security mechanism)", () => {
  it("delivers a message to subscribers, including those in the publishing tab", () => {
    const received: OfflineMessage[] = [];
    const stop = subscribeOfflineMessages((message) => received.push(message));
    publishOfflineMessage({ type: "OUTBOX_CHANGED" });
    publishOfflineMessage({ type: "SYNC_DONE", outcome: "completed" });
    expect(received).toEqual([{ type: "OUTBOX_CHANGED" }, { type: "SYNC_DONE", outcome: "completed" }]);
    stop();
    publishOfflineMessage({ type: "UPDATE_PENDING" });
    expect(received).toHaveLength(2);
    expect(FakeBroadcastChannel.channels.size).toBe(1); // only the publisher is left
  });

  it("drops a message with an unknown shape", () => {
    const received: OfflineMessage[] = [];
    subscribeOfflineMessages((message) => received.push(message));
    const publisher = new FakeBroadcastChannel("qatra-offline");
    publisher.postMessage({ type: "HACK" });
    publisher.postMessage("OWNER_CLEARED");
    publisher.postMessage(null);
    publisher.postMessage({ type: "OWNER_CLEARED", generation: 3 });
    expect(received).toEqual([{ type: "OWNER_CLEARED", generation: 3 }]);
  });

  it("is a no-op where BroadcastChannel does not exist", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const stop = subscribeOfflineMessages(() => undefined);
    expect(() => publishOfflineMessage({ type: "OUTBOX_CHANGED" })).not.toThrow();
    expect(() => stop()).not.toThrow();
  });
});
