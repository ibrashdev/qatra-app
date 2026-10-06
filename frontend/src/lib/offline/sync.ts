import type { ApiClient } from "@/lib/api/client";
import { READ_RETRY_POLICY } from "@/lib/api/client";
import { createEndpoints } from "@/lib/api/endpoints";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { revalidateOffline } from "@/lib/api/offline-endpoints";
import { getApiRuntime } from "@/lib/api/runtime";
import { completeSession, postSessionEvents } from "@/lib/api/session-endpoints";
import type { DailyProgress, EventsResponse } from "@/lib/api/types";
import { newEventId } from "@/components/session/session-events";
import { publishOfflineMessage } from "./broadcast";
import { nowIso, readSyncInTx, requireOwnerInTx, runTx, writeSyncInTx } from "./db";
import {
  accountKeyOf,
  applyOnlineEventsResponse,
  blockOnlineEvents,
  confirmOnlineCompletion,
  hasOnlineJournalWork,
  listOnlineEvents,
  listPendingOnlineCompletions,
  currentOnlineBinding,
  pruneOnlineRuns,
} from "./online-journal";
import {
  applyEventsResponse,
  blockEvents,
  halveBatch,
  listPendingEvents,
  planReplayBatches,
  countEvents,
  type ApplyOutcome,
  type ReplayBatch,
  type ReplayableEvent,
} from "./outbox";
import { completePendingLogout, isOfflineLocked, readOwnerState } from "./owner";
import { deletePlanMaterial, listReadySnapshots, pruneRetiredSnapshots, recordRevalidation } from "./plan-cache";
import { waitForServer } from "./wake";
import {
  OfflineError,
  type OnlineEventRecord,
  type OutboxCounts,
  type PendingEvent,
  type PendingOnlineCompletion,
  type PlanSnapshotRecord,
  type RevalidationRecord,
  type SyncDeps,
  type SyncForegroundFn,
  type SyncOutcome,
  type SyncPhase,
  type SyncProgress,
  type SyncResult,
  type SyncTrigger,
} from "./types";

// The foreground revalidation and replay of PWA-design 6 and offline-spec 2.6, in this order:
//   online hint -> GET /api/health wake loop -> GET /api/me (401 stops) -> owner match (G-04) -> POST /api/offline/revalidate for every ready snapshot (E25)
//   -> replay the outbox in order (E21, with the original envelope) -> replay the online journal in order (E21, never enveloped) -> E22 for retired
//   descriptors and for the online sessions whose finish is owed -> authoritative figures back to the screen.
// It runs only in the foreground: when the app opens, when a real connection returns, or when the learner presses «إعادة المحاولة». There is no Background
// Sync and nothing is promised while the app is closed. A free-server wake-up timeout, a gateway answer or a lost response is connectivity: it never changes
// a snapshot's status, never clears the outbox and never asks for a login (D48, API-spec 1.11).

export const SYNC_LOCK_NAME = "qatra-sync";

// The Web Lock a live tab holds for as long as it plays an online session. The sync leaves a session alone while the lock is taken: that tab sends its own
// events, and a duplicate would be harmless (the server answers `duplicate`) but wasteful. Where the Locks API is missing nothing is skipped.
export const onlineRunLockName = (sessionId: string): string => `qatra-online-run:${sessionId}`;
const LEASE_MS = 120_000;
const REPLAY_RETRY = { delaysMs: [1_000, 2_000, 4_000] } as const;

// The seams (clock, sleep, locks, online hint) live on SyncDeps so a test can set them; a screen passes none of them.
export type SyncRuntimeDeps = SyncDeps;

function emptyResult(outcome: SyncOutcome, extra: Partial<SyncResult> = {}): SyncResult {
  return { acknowledgedIds: [], pendingIds: [], blockedIds: [], duplicateIds: [], revalidations: [], daily: null, completedSessionIds: [], outcome, ...extra };
}

export function classifySyncError(error: unknown): { outcome: SyncOutcome; retryAfterSec?: number | null } {
  if (error instanceof ConnectivityError) return { outcome: "server_unreachable" };
  if (error instanceof ApiError) {
    if (error.status === 401 || error.code === "unauthenticated") return { outcome: "unauthenticated" };
    if (error.status === 404 || error.code === "not_found") return { outcome: "owner_mismatch" };
    if (error.status === 429 || error.code === "throttled") return { outcome: "throttled", retryAfterSec: error.retryAfterSec };
    if (error.status === 503 || error.code === "unavailable") return { outcome: "unavailable" };
    return { outcome: "failed" };
  }
  if (error instanceof OfflineError) {
    if (error.code === "schema_too_new") return { outcome: "schema_incompatible" };
    if (error.code === "locked" || error.code === "clear_failed") return { outcome: "locked" };
    if (error.code === "owner_mismatch" || error.code === "generation_mismatch") return { outcome: "owner_mismatch" };
  }
  return { outcome: "failed" };
}

type SyncLockHolder = <T>(work: () => Promise<T>) => Promise<T | null>;

// One sync worker per device: a Web Lock where it exists, an IndexedDB lease record where it does not. The server's unique ids make a duplicate request
// harmless anyway, so this only saves work.
function resolveLocks(deps: SyncRuntimeDeps): Pick<LockManager, "request"> | null {
  const locks = deps.locks === undefined ? (typeof navigator !== "undefined" ? navigator.locks : undefined) : deps.locks;
  return locks === undefined || locks === null ? null : locks;
}

function lockHolder(deps: SyncRuntimeDeps, now: () => number, randomId: () => string): SyncLockHolder {
  const locks = resolveLocks(deps);
  if (locks !== null) {
    return <T>(work: () => Promise<T>) => locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => (lock === null ? null : await work())) as Promise<T | null>;
  }
  return async (work) => {
    const holderId = randomId();
    const acquired = await runTx(["syncState"], "readwrite", async (ctx) => {
      const sync = await readSyncInTx(ctx);
      if (sync.lease !== null && sync.lease.until > now()) return false;
      await writeSyncInTx(ctx, { ...sync, lease: { holderId, until: now() + LEASE_MS } });
      return true;
    });
    if (!acquired) return null;
    try {
      return await work();
    } finally {
      await runTx(["syncState"], "readwrite", async (ctx) => {
        const sync = await readSyncInTx(ctx);
        if (sync.lease?.holderId === holderId) await writeSyncInTx(ctx, { ...sync, lease: null });
      }).catch(() => undefined);
    }
  };
}

const normalize = (username: string): string => username.trim().toLowerCase();

export const syncForeground: SyncForegroundFn = async (ownerId, deps = {}) => {
  const runtime = deps as SyncRuntimeDeps;
  const now = runtime.now ?? Date.now;
  const randomId = runtime.randomId ?? newEventId;
  const holder = lockHolder(runtime, now, randomId);
  let result: SyncResult;
  try {
    const guarded = await holder(() => runSync(ownerId, runtime, now));
    result = guarded ?? emptyResult("locked_elsewhere");
  } catch (error) {
    result = emptyResult(classifySyncError(error).outcome);
  }
  publishOfflineMessage({ type: "SYNC_DONE", outcome: result.outcome });
  return result;
};

function reporter(deps: SyncRuntimeDeps, now: () => number) {
  const startedAt = now();
  let waitedMs = 0;
  let timedOut = false;
  const emit = (phase: SyncPhase, result: SyncResult | null = null): void => {
    deps.onProgress?.({ phase, trigger: deps.trigger ?? null, startedAt, waitedMs, timedOut, result });
  };
  return {
    emit,
    wait: (ms: number) => {
      waitedMs = ms;
      emit("waiting_server");
    },
    timedOut: () => {
      timedOut = true;
    },
  };
}

interface OnlineWork {
  events: OnlineEventRecord[];
  completions: PendingOnlineCompletion[];
  any: boolean;
}

// What the online journal still owes the server for this account: unsent events (queued or pending, never blocked ones) and finishes that are owed.
async function readOnlineWork(accountKey: string | null): Promise<OnlineWork> {
  if (accountKey === null) return { events: [], completions: [], any: false };
  const [events, completions] = await Promise.all([listOnlineEvents(accountKey, { states: ["queued", "pending"] }), listPendingOnlineCompletions(accountKey)]);
  return { events, completions, any: events.length > 0 || completions.length > 0 };
}

async function runSync(ownerArg: string, deps: SyncRuntimeDeps, now: () => number): Promise<SyncResult> {
  const progress = reporter(deps, now);
  const finish = (result: SyncResult): SyncResult => {
    progress.emit(result.outcome === "completed" || result.outcome === "nothing_to_do" ? "done" : "stopped", result);
    return result;
  };
  const client: ApiClient = deps.client ?? getApiRuntime().client;
  const online = deps.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const trigger = deps.trigger ?? "manual";

  // 1. Local checks: nothing here needs the network.
  if (await isOfflineLocked()) return finish(emptyResult("locked"));
  const owner = await readOwnerState();
  if (owner !== null && owner.logoutPending) {
    // The server logout owed after an offline logout comes before anything else (PWA-design 7). The local copy is already gone.
    if (!online() && trigger !== "manual") return finish(emptyResult("offline"));
    progress.emit("waiting_server");
    const wake = await waitForServer(client, { signal: deps.signal, now, sleep: deps.sleep, maxWaitMs: deps.maxWaitMs, onTick: progress.wait });
    if (wake !== "awake") return finish(emptyResult("server_unreachable"));
    const done = await completePendingLogout(client);
    return finish(emptyResult(done === "failed" ? "server_unreachable" : "nothing_to_do"));
  }
  // The device can hold two kinds of work: a downloaded copy (an ownership id) and the online journal (the account's username only).
  const ownerId = owner?.ownerId ?? null;
  const accountKey = owner?.username != null && accountKeyOf(owner.username) !== "" ? accountKeyOf(owner.username) : null;
  if (ownerId === null && accountKey === null) return finish(emptyResult("nothing_to_do"));
  if (ownerArg !== "" && ownerArg !== ownerId) return finish(emptyResult("owner_mismatch"));

  const snapshots = ownerId === null ? [] : await listReadySnapshots(ownerId);
  const events = ownerId === null ? [] : await listPendingEvents(ownerId);
  const retiredSessions = ownerId === null ? [] : await runTx(["syncState"], "readonly", async (ctx) => (await readSyncInTx(ctx)).retiredSessions);
  const sendable = events.filter((event) => event.state !== "blocked");
  const offlineIdle = snapshots.length === 0 && sendable.length === 0 && retiredSessions.length === 0;
  if (offlineIdle && !(await readOnlineWork(accountKey)).any) return finish(emptyResult("nothing_to_do"));

  // 2. The online hint is a hint; the pressed button still tries.
  if (!online() && trigger !== "manual") return finish(emptyResult("offline"));

  // 3. Wake the free server with short probes.
  progress.emit("waiting_server");
  const wake = await waitForServer(client, { signal: deps.signal, now, sleep: deps.sleep, maxWaitMs: deps.maxWaitMs, onTick: progress.wait });
  if (wake === "aborted") return finish(emptyResult("failed"));
  if (wake === "timed_out") {
    progress.timedOut();
    return finish(emptyResult("server_unreachable"));
  }

  // 4. The account: 401 stops the replay without wiping anything; another username blocks it (G-04). It guards the online journal as well.
  progress.emit("checking_account");
  try {
    const profile = await createEndpoints(client).me({ signal: deps.signal, retry: READ_RETRY_POLICY });
    if (owner !== null && owner.username !== null && normalize(owner.username) !== normalize(profile.username)) return finish(emptyResult("owner_mismatch"));
  } catch (error) {
    return finish(emptyResult(classifySyncError(error).outcome, { retryAfterSec: classifySyncError(error).retryAfterSec }));
  }

  // 5. E25 for every ready snapshot (a device without a downloaded copy has none).
  progress.emit("revalidating");
  const revalidations: RevalidationRecord[] = [];
  if (ownerId !== null) {
    const stopped = await revalidateSnapshots(ownerId, snapshots, client, deps.signal, revalidations);
    if (stopped !== null) return finish(emptyResult(stopped.outcome, { revalidations, retryAfterSec: stopped.retryAfterSec }));
  }

  // 6. Replay in the server's order: the outbox first, then the online journal. `stale` does not stop it: the old events keep their own plan version and
  // the server decides each one (D59). A stop in the first part (401, 404, 429, 503, no answer) keeps everything and does not start the second.
  progress.emit("replaying");
  const replay = newReplayReport();
  if (ownerId !== null) await replayOutbox(ownerId, client, deps.signal, replay);
  if (replay.stop === null && accountKey !== null) await replayOnlineJournal(accountKey, client, deps, replay);
  let outcome: SyncOutcome = replay.stop ?? "completed";

  // 7. E22 for descriptors a newer snapshot replaced, after all their events are acknowledged (G-03), then drop what is no longer referenced. Then E22 for
  // the online sessions whose finish is owed, once their events are out of the journal, and the run records nobody needs any more.
  if (outcome === "completed") {
    progress.emit("refreshing");
    if (ownerId !== null) {
      const retired = await retireSessions(ownerId, client, deps.signal);
      if (retired.stop !== null) outcome = retired.stop;
      await pruneRetiredSnapshots(ownerId).catch(() => undefined);
    }
    if (outcome === "completed" && accountKey !== null) {
      const finished = await completeOnlineSessions(accountKey, client, deps.signal, replay);
      if (finished !== null) {
        outcome = finished.outcome;
        replay.retryAfterSec = finished.retryAfterSec;
      }
      await pruneOnlineRuns(accountKey, now()).catch(() => 0);
    }
    if (outcome === "completed") {
      try {
        await deps.afterReplay?.();
      } catch {
        // The screen refreshes itself later; a failed refresh is not a sync failure.
      }
    }
  }

  // `syncState` belongs to the downloaded copy: its counts stay the offline outbox's, so what the offline shell shows does not change when the online journal
  // is busy. A device with only the journal has no such record.
  if (ownerId !== null) await finishState(ownerId, outcome).catch(() => undefined);
  const firstPending = replay.pending[0];
  const result: SyncResult = {
    acknowledgedIds: replay.acknowledged,
    pendingIds: replay.pending.map((item) => item.id),
    blockedIds: replay.blocked,
    duplicateIds: replay.duplicate,
    revalidations,
    daily: replay.daily,
    completedSessionIds: replay.completed,
    outcome,
    ...(firstPending?.reasonCode === undefined ? {} : { reasonCode: firstPending.reasonCode }),
    ...(replay.retryAfterSec === undefined ? {} : { retryAfterSec: replay.retryAfterSec }),
  };
  return finish(result);
}

// E25 for every ready snapshot. Returns null when all were answered (or marked unusable on a 422), else the classified stop.
async function revalidateSnapshots(
  ownerId: string,
  snapshots: readonly PlanSnapshotRecord[],
  client: ApiClient,
  signal: AbortSignal | undefined,
  revalidations: RevalidationRecord[],
): Promise<{ outcome: SyncOutcome; retryAfterSec?: number | null } | null> {
  for (const record of snapshots) {
    try {
      const answer = await revalidateOffline(
        client,
        { snapshotId: record.snapshotId, expectedPlanVersion: record.planVersion, editionId: record.editionId, bankVersion: record.bankVersion },
        { signal },
      );
      const stored: RevalidationRecord = {
        snapshotId: record.snapshotId,
        status: answer.status,
        reasonCode: answer.reasonCode,
        currentPlanVersion: answer.currentPlanVersion,
        allowedSessionRefs: answer.allowedSessionRefs,
        catalogVersion: answer.catalogVersion,
        at: nowIso(),
      };
      await recordRevalidation(ownerId, stored);
      revalidations.push(stored);
      // Revoked or expired: hide and delete the material, keep the unsent events visibly blocked, never send blocked text (G-06).
      if (answer.status === "revoked" || answer.status === "expired") await deletePlanMaterial(ownerId, record.snapshotId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        // The device holds values the server does not recognise for this snapshot: it is not usable, but nothing is deleted.
        const stored: RevalidationRecord = {
          snapshotId: record.snapshotId,
          status: "stale",
          reasonCode: "snapshot_mismatch",
          currentPlanVersion: record.planVersion,
          allowedSessionRefs: [],
          catalogVersion: record.bankVersion,
          at: nowIso(),
        };
        await recordRevalidation(ownerId, stored);
        revalidations.push(stored);
        continue;
      }
      return classifySyncError(error);
    }
  }
  return null;
}

interface ReplayReport {
  acknowledged: string[];
  duplicate: string[];
  pending: { id: string; reasonCode: string | undefined }[];
  blocked: string[];
  daily: DailyProgress | null;
  completed: string[];
  stop: SyncOutcome | null;
  retryAfterSec?: number | null;
}

const newReplayReport = (): ReplayReport => ({ acknowledged: [], duplicate: [], pending: [], blocked: [], daily: null, completed: [], stop: null });

// Where a batch goes after the server answered: the offline outbox and the online journal settle their own records, the replay itself is the same.
interface ReplaySink<T extends ReplayableEvent> {
  apply: (sent: readonly T[], response: EventsResponse) => Promise<ApplyOutcome>;
  block: (clientEventIds: readonly string[], code: string) => Promise<string[]>;
  // True when a live tab is playing this session and sends its own events (the online journal only).
  skipSession?: (sessionId: string) => Promise<boolean>;
  // Set only by the online journal. A 404 there cannot mean another account (/api/me confirmed the account): the session no longer exists for it. The
  // sink blocks the batch's events as `not_found`, drops what is owed for the session, and returns the blocked ids; the replay then goes on with the
  // other sessions. Without this hook (the offline outbox) a 404 keeps stopping the sync as an owner mismatch (G-04).
  sessionGone?: (sessionId: string, clientEventIds: readonly string[]) => Promise<string[]>;
}

async function replayBatches<T extends ReplayableEvent>(planned: ReplayBatch<T>[], client: ApiClient, signal: AbortSignal | undefined, sink: ReplaySink<T>, report: ReplayReport): Promise<void> {
  const queue: ReplayBatch<T>[] = [...planned];
  const skipped = new Map<string, boolean>();
  const gone = new Set<string>();
  while (queue.length > 0) {
    const batch = queue.shift();
    if (batch === undefined) break;
    if (gone.has(batch.sessionId)) continue;
    if (sink.skipSession !== undefined) {
      let skip = skipped.get(batch.sessionId);
      if (skip === undefined) {
        skip = await sink.skipSession(batch.sessionId);
        skipped.set(batch.sessionId, skip);
      }
      if (skip) continue;
    }
    let response: EventsResponse;
    try {
      response = await postSessionEvents(client, batch.sessionId, batch.events.map((item) => item.event), { signal, retry: REPLAY_RETRY });
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) {
        if (batch.events.length > 1) {
          // G-13: halve and send again, without a message. The same ids go out again, so nothing is counted twice.
          queue.unshift(...halveBatch(batch));
          continue;
        }
        report.blocked.push(...(await sink.block(batch.events.map((item) => item.clientEventId), "payload_too_large")));
        continue;
      }
      if (error instanceof ApiError && error.status === 422) {
        // A request the server cannot accept as it is never improves by repeating it: keep the events, visibly blocked.
        report.blocked.push(...(await sink.block(batch.events.map((item) => item.clientEventId), "validation_error")));
        continue;
      }
      if (error instanceof ApiError && (error.status === 404 || error.code === "not_found") && sink.sessionGone !== undefined) {
        // The rest of this session's batches are left alone for now: they stay queued and meet the same answer on a later sync.
        report.blocked.push(...(await sink.sessionGone(batch.sessionId, batch.events.map((item) => item.clientEventId))));
        gone.add(batch.sessionId);
        continue;
      }
      const classified = classifySyncError(error);
      report.stop = classified.outcome;
      report.retryAfterSec = classified.retryAfterSec;
      return;
    }
    const applied = await sink.apply(batch.events, response);
    report.acknowledged.push(...applied.acknowledgedIds);
    report.duplicate.push(...applied.duplicateIds);
    report.blocked.push(...applied.blockedIds);
    const reasons = new Map(response.pending.map((item) => [item.clientEventId, item.reasonCode]));
    for (const id of applied.pendingIds) report.pending.push({ id, reasonCode: reasons.get(id) });
    report.daily = response.daily;
  }
}

async function replayOutbox(ownerId: string, client: ApiClient, signal: AbortSignal | undefined, report: ReplayReport): Promise<void> {
  // Read again: the revalidation may just have blocked the events of a revoked snapshot.
  const events = (await listPendingEvents(ownerId)).filter((event) => event.state !== "blocked");
  await replayBatches(
    planReplayBatches(events),
    client,
    signal,
    { apply: (sent, response) => applyEventsResponse(ownerId, sent, response), block: (ids, code) => blockEvents(ownerId, ids, code) },
    report,
  );
}

// A session whose lock is taken has a live tab that sends its own events. Probes without keeping the lock; any failure of the Locks API means "not held".
async function heldByLiveTab(locks: Pick<LockManager, "request">, sessionId: string): Promise<boolean> {
  try {
    const free = await locks.request(onlineRunLockName(sessionId), { ifAvailable: true }, async (lock) => lock !== null);
    return !free;
  } catch {
    return false;
  }
}

// The online journal's events go to the ORIGINAL session id, un-enveloped, in the server's order (occurredAt or startedAt, then clientEventId), exactly as
// they were written; the ids never change, so a lost answer is repaired by the server's `duplicate`.
async function replayOnlineJournal(accountKey: string, client: ApiClient, deps: SyncRuntimeDeps, report: ReplayReport): Promise<void> {
  const events = await listOnlineEvents(accountKey, { states: ["queued", "pending"] });
  if (events.length === 0) return;
  const locks = resolveLocks(deps);
  await replayBatches(
    planReplayBatches(events),
    client,
    deps.signal,
    {
      apply: (sent, response) => applyOnlineEventsResponse(accountKey, sent, response),
      block: (ids, code) => blockOnlineEvents(accountKey, ids, code),
      sessionGone: async (sessionId, ids) => {
        const blocked = await blockOnlineEvents(accountKey, ids, "not_found");
        // A finish can never be accepted for a session the server does not have: drop what is owed instead of retrying it for ever.
        await confirmOnlineCompletion(accountKey, sessionId);
        return blocked;
      },
      ...(locks === null ? {} : { skipSession: (sessionId: string) => heldByLiveTab(locks, sessionId) }),
    },
    report,
  );
}

// E22 for the online sessions whose finish is owed, with the key that was stored when the finish was requested (the identical key on every retry).
// A session whose events are not all out of the journal waits (a blocked event is final and does not hold it). An answer other than 401, 429 or 503 is
// final, as for the retired descriptors: the server will not close that session, so the record is dropped instead of being retried for ever.
async function completeOnlineSessions(
  accountKey: string,
  client: ApiClient,
  signal: AbortSignal | undefined,
  report: ReplayReport,
): Promise<{ outcome: SyncOutcome; retryAfterSec?: number | null } | null> {
  const completions = await listPendingOnlineCompletions(accountKey);
  if (completions.length === 0) return null;
  const holding = new Set((await listOnlineEvents(accountKey, { states: ["queued", "pending"] })).map((event) => event.sessionId));
  for (const entry of completions) {
    if (holding.has(entry.sessionId)) continue;
    try {
      await completeSession(client, entry.sessionId, { signal, idempotencyKey: entry.idempotencyKey });
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401 && error.status !== 429 && error.status !== 503) {
        await confirmOnlineCompletion(accountKey, entry.sessionId);
        continue;
      }
      return classifySyncError(error);
    }
    await confirmOnlineCompletion(accountKey, entry.sessionId);
    report.completed.push(entry.sessionId);
  }
  return null;
}

// Cheap and never throwing: is there anything in the online journal the server still has to be told (for the account recorded on this device)? A foreground
// trigger asks it before it starts a sync. False for no account, a lock, another account and any storage failure.
export async function hasOnlineWork(): Promise<boolean> {
  try {
    const binding = await currentOnlineBinding();
    return binding === null ? false : await hasOnlineJournalWork(binding.accountKey);
  } catch {
    return false;
  }
}

async function retireSessions(ownerId: string, client: ApiClient, signal: AbortSignal | undefined): Promise<{ stop: SyncOutcome | null }> {
  const { sessions, events } = await runTx(["ownerState", "syncState", "pendingEvents"], "readonly", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    return {
      sessions: (await readSyncInTx(ctx)).retiredSessions,
      events: await ctx.allByIndex<PendingEvent>("pendingEvents", "byOwner", ownerId),
    };
  });
  const finished = new Set<string>();
  let stop: SyncOutcome | null = null;
  for (const entry of sessions) {
    // Only when every event of the descriptor is out of the outbox; a blocked event is final and does not hold it.
    if (events.some((event) => event.snapshotId === entry.snapshotId && event.state !== "blocked")) continue;
    try {
      await completeSession(client, entry.sessionId, { signal, idempotencyKey: entry.idempotencyKey });
      finished.add(entry.sessionId);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401 && error.status !== 429 && error.status !== 503) {
        // The server will not close this one (unknown or already closed): there is nothing to retry.
        finished.add(entry.sessionId);
        continue;
      }
      stop = classifySyncError(error).outcome;
      break;
    }
  }
  if (finished.size > 0) {
    await runTx(["ownerState", "syncState"], "readwrite", async (ctx) => {
      await requireOwnerInTx(ctx, ownerId);
      const sync = await readSyncInTx(ctx);
      await writeSyncInTx(ctx, { ...sync, retiredSessions: sync.retiredSessions.filter((entry) => !finished.has(entry.sessionId)) });
    });
  }
  return { stop };
}

async function finishState(ownerId: string, outcome: SyncOutcome): Promise<OutboxCounts> {
  return runTx(["ownerState", "syncState", "pendingEvents"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    const counts = countEvents(await ctx.allByIndex<PendingEvent>("pendingEvents", "byOwner", ownerId));
    const sync = await readSyncInTx(ctx);
    await writeSyncInTx(ctx, { ...sync, ownerId, lastSyncAt: nowIso(), lastSyncOutcome: outcome, counts });
    return counts;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The state machine the screens read (useSyncExternalStore)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const IDLE: SyncProgress = { phase: "idle", trigger: null, startedAt: null, waitedMs: 0, timedOut: false, result: null };

export interface SyncControllerOptions {
  // Resolved at every run, so a screen never captures a client of an older session.
  deps?: () => SyncRuntimeDeps;
}

export class OfflineSyncController {
  #state: SyncProgress = IDLE;
  readonly #listeners = new Set<() => void>();
  #running: Promise<SyncResult> | null = null;

  constructor(private readonly options: SyncControllerOptions = {}) {}

  getState = (): SyncProgress => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // One run at a time: a second call while one is running gets the same promise (app open and connection return can coincide).
  run(trigger: SyncTrigger = "manual"): Promise<SyncResult> {
    if (this.#running !== null) return this.#running;
    const running = this.#execute(trigger).finally(() => {
      if (this.#running === running) this.#running = null;
    });
    this.#running = running;
    return running;
  }

  retry(): Promise<SyncResult> {
    return this.run("manual");
  }

  // `online` is a hint: it triggers a real attempt, which only counts when a request succeeds.
  attachForegroundTriggers(): () => void {
    if (typeof window === "undefined") return () => undefined;
    const onOnline = () => {
      void this.run("reconnect");
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }

  dispose(): void {
    this.#listeners.clear();
  }

  async #execute(trigger: SyncTrigger): Promise<SyncResult> {
    const set = (next: SyncProgress): void => {
      this.#state = next;
      for (const listener of [...this.#listeners]) listener();
    };
    set({ ...IDLE, phase: "checking_account", trigger, startedAt: Date.now() });
    try {
      const owner = await readOwnerState();
      const deps: SyncRuntimeDeps = { ...(this.options.deps?.() ?? {}), trigger, onProgress: set };
      return await syncForeground(owner?.ownerId ?? "", deps);
    } catch (error) {
      const result = emptyResult(classifySyncError(error).outcome);
      set({ ...this.#state, phase: "stopped", result });
      return result;
    }
  }
}

let shared: OfflineSyncController | undefined;

export function getOfflineSyncController(): OfflineSyncController {
  shared ??= new OfflineSyncController({ deps: () => ({ client: getApiRuntime().client }) });
  return shared;
}
