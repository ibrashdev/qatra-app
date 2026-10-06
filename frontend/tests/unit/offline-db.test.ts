import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_MARKER_KEY, STORE_NAMES, clearAccountCache, closeOfflineDb, deleteOfflineDatabase, openOfflineDb, readOwnerInTx, runTx } from "@/lib/offline/db";
import { enqueueEvent, listPendingEvents } from "@/lib/offline/outbox";
import { adoptOwner, isOfflineLocked, readOwnerState } from "@/lib/offline/owner";
import { cacheActivePlan, readReadyPlan } from "@/lib/offline/plan-cache";
import { OFFLINE_DB_NAME, isOfflineError, type OwnerState } from "@/lib/offline/types";
import { FakeBroadcastChannel, OTHER_OWNER_ID, OWNER_ID, USERNAME, activityAt, answerAt, dumpAllStores, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());
afterEach(() => {
  vi.restoreAllMocks();
});

describe("IndexedDB wrapper (database qatra-offline, version 1)", () => {
  it("creates the five stores of offline-spec 2.2 with their indexes", async () => {
    const db = await openOfflineDb();
    expect(db.name).toBe(OFFLINE_DB_NAME);
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([...STORE_NAMES].sort());
    const tx = db.transaction(["planSnapshots", "activeRuns", "pendingEvents"], "readonly");
    expect(Array.from(tx.objectStore("planSnapshots").indexNames).sort()).toEqual(["byOwner", "byPlan"]);
    expect(Array.from(tx.objectStore("activeRuns").indexNames).sort()).toEqual(["byOwner", "bySnapshot"]);
    expect(Array.from(tx.objectStore("pendingEvents").indexNames).sort()).toEqual(["byOwner", "bySession", "bySnapshot"]);
  });

  it("refuses a stored database that is newer than the app and keeps it untouched (schema_too_new)", async () => {
    const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(OFFLINE_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore("future");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    await expect(openOfflineDb()).rejects.toMatchObject({ code: "schema_too_new" });
    await expect(readOwnerState()).rejects.toMatchObject({ code: "schema_too_new" });
  });

  it("reports unsupported when there is no IndexedDB", async () => {
    closeOfflineDb();
    vi.stubGlobal("indexedDB", undefined);
    await expect(openOfflineDb()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("rolls the whole transaction back when the body throws", async () => {
    await expect(
      runTx(["ownerState"], "readwrite", async (ctx) => {
        await ctx.put("ownerState", { ownerId: "x" }, "current");
        throw new Error("boom");
      }),
    ).rejects.toBeDefined();
    expect(await runTx(["ownerState"], "readonly", (ctx) => readOwnerInTx(ctx))).toBeUndefined();
  });
});

describe("owner and generation inside the same transaction", () => {
  async function ready() {
    const snapshot = makeSnapshot();
    expect(await cacheActivePlan(snapshot, { username: USERNAME })).toMatchObject({ ready: true });
    return snapshot;
  }

  it("rejects a write for another owner or without an owner (owner_mismatch)", async () => {
    const snapshot = await ready();
    const event = answerAt(snapshot, uuid(), 0);
    await expect(enqueueEvent(OTHER_OWNER_ID, "s1", event)).rejects.toMatchObject({ code: "owner_mismatch" });
    expect(await listPendingEvents(OWNER_ID)).toHaveLength(0);
  });

  it("rejects a write from a tab that started before a clear (generation_mismatch)", async () => {
    const snapshot = await ready();
    const before = (await readOwnerState()) as OwnerState;
    await clearAccountCache(OWNER_ID);
    // The same learner comes back and downloads again: the owner id is the same, the generation is not.
    await cacheActivePlan(snapshot, { username: USERNAME });
    const now = (await readOwnerState()) as OwnerState;
    expect(now.generation).toBeGreaterThan(before.generation);
    await expect(enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0), { generation: before.generation })).rejects.toMatchObject({ code: "generation_mismatch" });
    await expect(enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0), { generation: now.generation })).resolves.toMatchObject({ state: "queued" });
  });
});

describe("clearAccountCache", () => {
  it("clears every personal store in one transaction, bumps the generation and announces it", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const runId = uuid();
    await enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, runId, 0));
    await enqueueEvent(OWNER_ID, "s1", activityAt(snapshot, runId, 1, 2000));
    const before = (await readOwnerState()) as OwnerState;

    await clearAccountCache(OWNER_ID);

    const stores = await dumpAllStores();
    expect(stores.planSnapshots).toEqual([]);
    expect(stores.activeRuns).toEqual([]);
    expect(stores.pendingEvents).toEqual([]);
    expect(stores.syncState).toEqual([]);
    const owner = (await readOwnerState()) as OwnerState;
    expect(owner).toMatchObject({ ownerId: null, username: null, clearFailed: false });
    expect(owner.generation).toBe(before.generation + 1);
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect(FakeBroadcastChannel.log).toContainEqual({ type: "OWNER_CLEARED", generation: owner.generation });
    expect(window.localStorage.getItem(LOCK_MARKER_KEY)).toBeNull();
  });

  it("does not clear another owner's copy and does not lock the view for it", async () => {
    await cacheActivePlan(makeSnapshot(), { username: USERNAME });
    await expect(clearAccountCache(OTHER_OWNER_ID)).rejects.toMatchObject({ code: "owner_mismatch" });
    expect(await readReadyPlan(OWNER_ID)).not.toBeNull();
    expect(await isOfflineLocked()).toBe(false);
  });

  it("keeps the personal view locked when the clear fails, and another account cannot open it", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const clear = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementation(() => {
      throw new DOMException("denied", "InvalidStateError");
    });
    await expect(clearAccountCache(OWNER_ID)).rejects.toMatchObject({ code: "clear_failed" });
    clear.mockRestore();

    expect(window.localStorage.getItem(LOCK_MARKER_KEY)).toBe("1");
    expect(await isOfflineLocked()).toBe(true);
    expect(((await readOwnerState()) as OwnerState).clearFailed).toBe(true);
    // Locked: nothing is readable or writable, and no other account can adopt the device.
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    await expect(enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0))).rejects.toMatchObject({ code: "locked" });
    await expect(adoptOwner({ ownerId: OTHER_OWNER_ID, username: "someone.else" })).rejects.toMatchObject({ code: "locked" });
    expect((await cacheActivePlan(makeSnapshot({ userId: OTHER_OWNER_ID }), { username: "someone.else" })).failureCode).toBe("locked");
  });

  it("stays locked after a reload because the marker lives outside IndexedDB, until storage repair succeeds", async () => {
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    expect(await isOfflineLocked()).toBe(true);
    const error = await enqueueEvent(OWNER_ID, "s1", answerAt(makeSnapshot(), uuid(), 0)).catch((e: unknown) => e);
    expect(isOfflineError(error, "locked")).toBe(true);
    expect(await deleteOfflineDatabase()).toBe(true);
    expect(await isOfflineLocked()).toBe(false);
  });
});
