import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_MARKER_KEY, STORE_NAMES, clearAccountCache, closeOfflineDb, deleteOfflineDatabase, openOfflineDb, readOwnerInTx, runTx } from "@/lib/offline/db";
import { enqueueEvent, listPendingEvents } from "@/lib/offline/outbox";
import { adoptOwner, isOfflineLocked, readOwnerState } from "@/lib/offline/owner";
import { bindOnlineAccount, listOnlineEvents, recordOnlineEvents } from "@/lib/offline/online-journal";
import { cacheActivePlan, readReadyPlan } from "@/lib/offline/plan-cache";
import { OFFLINE_DB_NAME, OFFLINE_DB_VERSION, isOfflineError, type OwnerState, type PlanSnapshotRecord } from "@/lib/offline/types";
import { FakeBroadcastChannel, OTHER_OWNER_ID, OWNER_ID, USERNAME, activityAt, answerAt, dumpAllStores, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());
afterEach(() => {
  vi.restoreAllMocks();
});

describe("IndexedDB wrapper (database qatra-offline, version 2)", () => {
  it("creates the seven stores (the five of offline-spec 2.2 and the online journal) with their indexes", async () => {
    const db = await openOfflineDb();
    expect(db.name).toBe(OFFLINE_DB_NAME);
    expect(OFFLINE_DB_VERSION).toBe(2);
    expect(db.version).toBe(2);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([...STORE_NAMES].sort());
    expect([...STORE_NAMES].sort()).toEqual(["activeRuns", "onlineEvents", "onlineRuns", "ownerState", "pendingEvents", "planSnapshots", "syncState"]);
    const tx = db.transaction(["planSnapshots", "activeRuns", "pendingEvents", "onlineRuns", "onlineEvents"], "readonly");
    expect(Array.from(tx.objectStore("planSnapshots").indexNames).sort()).toEqual(["byOwner", "byPlan"]);
    expect(Array.from(tx.objectStore("activeRuns").indexNames).sort()).toEqual(["byOwner", "bySnapshot"]);
    expect(Array.from(tx.objectStore("pendingEvents").indexNames).sort()).toEqual(["byOwner", "bySession", "bySnapshot"]);
    expect(tx.objectStore("onlineRuns").keyPath).toBe("sessionId");
    expect(Array.from(tx.objectStore("onlineRuns").indexNames)).toEqual(["byAccount"]);
    expect(tx.objectStore("onlineEvents").keyPath).toBe("clientEventId");
    expect(Array.from(tx.objectStore("onlineEvents").indexNames).sort()).toEqual(["byAccount", "bySession"]);
  });

  it("refuses a stored database that is newer than the app and keeps it untouched (schema_too_new)", async () => {
    const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION + 1);
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

// A database exactly as version 1 of the app wrote it: the five stores and their indexes, with learner records in them.
async function writeVersion1Database(): Promise<{ eventId: string; snapshotId: string }> {
  const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
  const snapshot = makeSnapshot();
  const event = answerAt(snapshot, uuid(), 0);
  const record: PlanSnapshotRecord = {
    snapshotId: snapshot.snapshotId,
    ownerId: OWNER_ID,
    generation: 3,
    planId: snapshot.planId,
    editionId: snapshot.editionId,
    bankVersion: snapshot.bankVersion,
    planVersion: snapshot.planVersion,
    ready: true,
    stagedAt: "2026-10-05T10:00:00.000Z",
    readyAt: "2026-10-05T10:00:01.000Z",
    sizeBytes: 1000,
    schemaVersion: 1,
    retired: false,
    snapshot,
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OFFLINE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const created = request.result;
      created.createObjectStore("ownerState");
      const snapshots = created.createObjectStore("planSnapshots", { keyPath: "snapshotId" });
      snapshots.createIndex("byOwner", "ownerId");
      snapshots.createIndex("byPlan", ["ownerId", "planId"]);
      const runs = created.createObjectStore("activeRuns", { keyPath: "clientRunId" });
      runs.createIndex("byOwner", "ownerId");
      runs.createIndex("bySnapshot", "snapshotId");
      const events = created.createObjectStore("pendingEvents", { keyPath: "clientEventId" });
      events.createIndex("byOwner", "ownerId");
      events.createIndex("bySession", "sessionId");
      events.createIndex("bySnapshot", "snapshotId");
      created.createObjectStore("syncState");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["ownerState", "planSnapshots", "pendingEvents"], "readwrite");
    tx.objectStore("ownerState").put({ ownerId: OWNER_ID, username: USERNAME, generation: 3, logoutPending: false, clearFailed: false, updatedAt: "2026-10-05T10:00:00.000Z" }, "current");
    tx.objectStore("planSnapshots").put(record);
    tx.objectStore("pendingEvents").put({
      clientEventId: event.clientEventId,
      ownerId: OWNER_ID,
      generation: 3,
      snapshotId: snapshot.snapshotId,
      sessionId: "s1",
      clientRunId: event.clientRunId,
      localSequence: 0,
      state: "queued",
      event,
      orderMs: Date.parse(event.type === "answer" ? event.occurredAt : event.startedAt),
      attempts: 0,
      createdAt: "2026-10-05T10:00:00.000Z",
      updatedAt: "2026-10-05T10:00:00.000Z",
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return { eventId: event.clientEventId, snapshotId: snapshot.snapshotId };
}

describe("the upgrade from version 1 to version 2 never destroys what the learner has (PWA-design 8)", () => {
  it("keeps the owner, the ready plan and the unsent answers, and adds the two empty online stores", async () => {
    const { eventId, snapshotId } = await writeVersion1Database();

    const db = await openOfflineDb();
    expect(db.version).toBe(2);
    expect(Array.from(db.objectStoreNames).sort()).toEqual([...STORE_NAMES].sort());

    expect(await readOwnerState()).toMatchObject({ ownerId: OWNER_ID, username: USERNAME, generation: 3 });
    expect((await listPendingEvents(OWNER_ID)).map((event) => event.clientEventId)).toEqual([eventId]);
    expect((await readReadyPlan(OWNER_ID))?.snapshotId).toBe(snapshotId);
    const stores = (await dumpAllStores()) as unknown as Record<string, unknown[]>;
    expect(stores.onlineRuns).toEqual([]);
    expect(stores.onlineEvents).toEqual([]);
  });

  it("the new journal works on the upgraded database and does not touch the version 1 outbox", async () => {
    const { eventId } = await writeVersion1Database();
    const binding = await bindOnlineAccount(USERNAME);
    expect(binding).toEqual({ accountKey: "test.learner", generation: 3 });
    const online = { clientEventId: uuid(), type: "activity" as const, startedAt: "2026-10-05T10:00:00.000Z", endedAt: "2026-10-05T10:00:05.000Z", activeMs: 5000 };
    await recordOnlineEvents(binding, "online-session", "lesson", [online]);

    expect((await listOnlineEvents(binding.accountKey)).map((event) => event.clientEventId)).toEqual([online.clientEventId]);
    expect((await listPendingEvents(OWNER_ID)).map((event) => event.clientEventId)).toEqual([eventId]);
  });

  it("a second open of the upgraded database changes nothing", async () => {
    await writeVersion1Database();
    await openOfflineDb();
    closeOfflineDb();
    const db = await openOfflineDb();
    expect(db.version).toBe(2);
    expect((await listPendingEvents(OWNER_ID)).length).toBe(1);
  });
});
