import { publishOfflineMessage } from "./broadcast";
import { isQuotaError } from "./storage";
import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OfflineError,
  isOfflineError,
  type ClearAccountCacheFn,
  type GuardOptions,
  type OutboxCounts,
  type OwnerState,
  type StoreName,
  type SyncStateRecord,
} from "./types";

// A raw IndexedDB wrapper (G-14: no `idb`). One database, version 2: the five stores of offline-spec 2.2 plus the two stores of the online journal. Nothing
// here ever holds a token, a cookie or a password: every record is learning data of the signed-in learner, and every one carries the `ownerId` (the
// offline stores) or the `accountKey` (the online journal).

// Every store: a clear (logout, account switch, delete account, clear the local copy) wipes all of them.
export const STORE_NAMES: readonly StoreName[] = ["ownerState", "planSnapshots", "activeRuns", "pendingEvents", "syncState", "onlineRuns", "onlineEvents"];

export const OWNER_KEY = "current";
export const SYNC_KEY = "sync";

// A non-secret flag in localStorage that survives an IndexedDB failure: a clear that failed keeps the personal view locked (PWA-design 7).
export const LOCK_MARKER_KEY = "qatra.offline.locked";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function factory(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

export function isOfflineStorageSupported(): boolean {
  return factory() !== null;
}

// Version 1: the five stores of offline-spec 2.2.
function createSchemaV1(db: IDBDatabase): void {
  db.createObjectStore("ownerState");
  const snapshots = db.createObjectStore("planSnapshots", { keyPath: "snapshotId" });
  snapshots.createIndex("byOwner", "ownerId");
  snapshots.createIndex("byPlan", ["ownerId", "planId"]);
  const runs = db.createObjectStore("activeRuns", { keyPath: "clientRunId" });
  runs.createIndex("byOwner", "ownerId");
  runs.createIndex("bySnapshot", "snapshotId");
  const events = db.createObjectStore("pendingEvents", { keyPath: "clientEventId" });
  events.createIndex("byOwner", "ownerId");
  events.createIndex("bySession", "sessionId");
  events.createIndex("bySnapshot", "snapshotId");
  db.createObjectStore("syncState");
}

// Version 2: the online journal. Added next to the version 1 stores, which are never touched.
function createSchemaV2(db: IDBDatabase): void {
  const runs = db.createObjectStore("onlineRuns", { keyPath: "sessionId" });
  runs.createIndex("byAccount", "accountKey");
  const events = db.createObjectStore("onlineEvents", { keyPath: "clientEventId" });
  events.createIndex("byAccount", "accountKey");
  events.createIndex("bySession", "sessionId");
}

// A non-destructive upgrade (PWA-design 8): only what the stored version lacks is created, so unsent version 1 answers survive the update.
export function upgradeSchema(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) createSchemaV1(db);
  if (oldVersion < 2) createSchemaV2(db);
}

function mapError(error: unknown, fallback: "storage_failed" | "unsupported" = "storage_failed"): OfflineError {
  if (error instanceof OfflineError) return error;
  if (isQuotaError(error)) return new OfflineError("quota_exceeded", "The device storage is full.", { cause: error });
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === "VersionError") return new OfflineError("schema_too_new", "The stored database is newer than this app.", { cause: error });
  return new OfflineError(fallback, "The device storage failed.", { cause: error });
}

export function openOfflineDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;
  const idb = factory();
  if (idb === null) return Promise.reject(new OfflineError("unsupported", "IndexedDB is not available."));
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    } catch (error) {
      reject(mapError(error, "unsupported"));
      return;
    }
    request.onupgradeneeded = (event) => upgradeSchema(request.result, event.oldVersion);
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrades the database: close at once so it is not blocked, and open again on the next call.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opened) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === opened) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(mapError(request.error));
    request.onblocked = () => undefined; // waits for the other connection to close
  });
  dbPromise = opened;
  opened.catch(() => {
    if (dbPromise === opened) dbPromise = null;
  });
  return opened;
}

export function closeOfflineDb(): void {
  const current = dbPromise;
  dbPromise = null;
  current?.then((db) => db.close()).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------------------------------------------------------

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(mapError(request.error));
  });
}

// The only operations a transaction body may await. A body awaits nothing else (no fetch, no timer, no crypto), or IndexedDB commits early.
export class TxContext {
  constructor(readonly tx: IDBTransaction) {}

  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return requestToPromise(this.tx.objectStore(store).get(key)) as Promise<T | undefined>;
  }

  put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    const objectStore = this.tx.objectStore(store);
    return requestToPromise(key === undefined ? objectStore.put(value) : objectStore.put(value, key)).then(() => undefined);
  }

  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    return requestToPromise(this.tx.objectStore(store).delete(key)).then(() => undefined);
  }

  clear(store: StoreName): Promise<void> {
    return requestToPromise(this.tx.objectStore(store).clear()).then(() => undefined);
  }

  all<T>(store: StoreName): Promise<T[]> {
    return requestToPromise(this.tx.objectStore(store).getAll()) as Promise<T[]>;
  }

  allByIndex<T>(store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return requestToPromise(this.tx.objectStore(store).index(index).getAll(query)) as Promise<T[]>;
  }
}

export async function runTx<T>(stores: readonly StoreName[], mode: IDBTransactionMode, work: (ctx: TxContext) => Promise<T>): Promise<T> {
  let db: IDBDatabase;
  try {
    db = await openOfflineDb();
  } catch (error) {
    throw mapError(error);
  }
  let tx: IDBTransaction;
  try {
    tx = db.transaction([...stores], mode);
  } catch (error) {
    // A connection closed behind our back (a versionchange): forget it, the next call opens a new one.
    closeOfflineDb();
    throw mapError(error);
  }
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(mapError(tx.error ?? new DOMException("The transaction was aborted.", "AbortError")));
    tx.onerror = () => undefined; // the abort event follows and rejects
  });
  completion.catch(() => undefined);
  let result: T;
  try {
    result = await work(new TxContext(tx));
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // already finished or aborted
    }
    await completion.catch(() => undefined);
    throw mapError(error);
  }
  await completion;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Owner and generation (checked inside the same transaction as the write)
// ---------------------------------------------------------------------------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLockMarker(): boolean {
  try {
    return storage()?.getItem(LOCK_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLockMarker(locked: boolean): void {
  try {
    if (locked) storage()?.setItem(LOCK_MARKER_KEY, "1");
    else storage()?.removeItem(LOCK_MARKER_KEY);
  } catch {
    // Storage blocked: the clearFailed flag in IndexedDB is then the only marker.
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function initialOwnerState(generation = 1): OwnerState {
  return { ownerId: null, username: null, generation, logoutPending: false, clearFailed: false, updatedAt: nowIso() };
}

export function readOwnerInTx(ctx: TxContext): Promise<OwnerState | undefined> {
  return ctx.get<OwnerState>("ownerState", OWNER_KEY);
}

// Throws unless `ownerId` is the owner of the device, the view is not locked and (when given) the generation is still current.
export async function requireOwnerInTx(ctx: TxContext, ownerId: string, options: GuardOptions = {}): Promise<OwnerState> {
  if (readLockMarker()) throw new OfflineError("locked", "The local copy is locked until it has been cleared.");
  const owner = await readOwnerInTx(ctx);
  if (owner === undefined || owner.ownerId === null || owner.ownerId !== ownerId) {
    throw new OfflineError("owner_mismatch", "The local copy belongs to another account.");
  }
  if (owner.clearFailed) throw new OfflineError("locked", "The local copy is locked until it has been cleared.");
  if (options.generation !== undefined && options.generation !== owner.generation) {
    throw new OfflineError("generation_mismatch", "The local copy was cleared in another tab.");
  }
  return owner;
}

export function emptyCounts(): OutboxCounts {
  return { queued: 0, pending: 0, blocked: 0, total: 0 };
}

export function defaultSyncState(ownerId: string | null = null): SyncStateRecord {
  return {
    ownerId,
    lastSyncAt: null,
    lastSyncOutcome: null,
    revalidations: {},
    pendingDownload: null,
    retiredSessions: [],
    lease: null,
    counts: emptyCounts(),
  };
}

export async function readSyncInTx(ctx: TxContext): Promise<SyncStateRecord> {
  return (await ctx.get<SyncStateRecord>("syncState", SYNC_KEY)) ?? defaultSyncState();
}

export function writeSyncInTx(ctx: TxContext, state: SyncStateRecord): Promise<void> {
  return ctx.put("syncState", state, SYNC_KEY);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ClearOptions {
  // Set by an offline logout: the server logout is still owed (PWA-design 7).
  logoutPending?: boolean;
}

// One transaction over every store: drop all personal records, keep one ownerState record with a bumped generation (so a tab that started earlier fails
// its next write) and publish it. If the transaction fails, the localStorage marker and the clearFailed flag keep the view locked and storage repair is
// requested; another account must not open (PWA-design 7).
export async function clearAccountCacheWith(ownerId: string | undefined, options: ClearOptions = {}): Promise<void> {
  if (!isOfflineStorageSupported()) {
    // Nothing can be stored, so nothing needs clearing.
    writeLockMarker(false);
    return;
  }
  const hadMarker = readLockMarker();
  writeLockMarker(true);
  let generation: number;
  try {
    generation = await runTx(STORE_NAMES, "readwrite", async (ctx) => {
      const current = await readOwnerInTx(ctx);
      if (ownerId !== undefined && current !== undefined && current.ownerId !== null && current.ownerId !== ownerId) {
        throw new OfflineError("owner_mismatch", "The local copy belongs to another account.");
      }
      for (const store of STORE_NAMES) await ctx.clear(store);
      const next: OwnerState = {
        ...initialOwnerState((current?.generation ?? 0) + 1),
        logoutPending: options.logoutPending ?? current?.logoutPending ?? false,
      };
      await ctx.put("ownerState", next, OWNER_KEY);
      return next.generation;
    });
  } catch (error) {
    if (isOfflineError(error, "owner_mismatch")) {
      // Nothing was cleared, so nothing is locked by this call.
      writeLockMarker(hadMarker);
      throw error;
    }
    await markClearFailed();
    throw new OfflineError("clear_failed", "The local copy could not be cleared; storage repair is needed.", { cause: error });
  }
  writeLockMarker(false);
  publishOfflineMessage({ type: "OWNER_CLEARED", generation });
}

export const clearAccountCache: ClearAccountCacheFn = (ownerId) => clearAccountCacheWith(ownerId);

async function markClearFailed(): Promise<void> {
  try {
    await runTx(["ownerState"], "readwrite", async (ctx) => {
      const current = (await readOwnerInTx(ctx)) ?? initialOwnerState();
      await ctx.put("ownerState", { ...current, clearFailed: true, updatedAt: nowIso() }, OWNER_KEY);
    });
  } catch {
    // The localStorage marker still locks the view.
  }
}

// Explicit repair after a failed clear: deletes the whole database, which also drops the generation counter. Resolves true when the copy is gone.
export async function deleteOfflineDatabase(): Promise<boolean> {
  const idb = factory();
  if (idb === null) {
    writeLockMarker(false);
    return true;
  }
  closeOfflineDb();
  const done = await new Promise<boolean>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.deleteDatabase(OFFLINE_DB_NAME);
    } catch {
      resolve(false);
      return;
    }
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    request.onblocked = () => undefined;
  });
  if (done) writeLockMarker(false);
  return done;
}
