import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { publishOfflineMessage } from "./broadcast";
import { OWNER_KEY, initialOwnerState, nowIso, readLockMarker, readOwnerInTx, runTx, type TxContext } from "./db";
import { eventOrderMs, isUuid } from "./envelope";
import { countEvents, sortForReplay, type ApplyOutcome } from "./outbox";
import {
  OfflineError,
  type OnlineAnswered,
  type OnlineBinding,
  type OnlineEventRecord,
  type OnlineRunRecord,
  type OnlineSessionKind,
  type OutboxCounts,
  type OwnerState,
  type PendingEventState,
  type PendingOnlineCompletion,
} from "./types";

// The online journal of PWA-design 4 (database version 2). An ordinary online session (daily session, game rounds, lesson reading time) writes every event
// here BEFORE it counts it, so a reload or a closed tab no longer loses an unsent answer; the server still answers every event, and an acknowledged event is
// deleted. It is bound to the signed-in account by its normalized username, because an online learner has no server user id on the device. It never
// shares a record with the offline outbox (`pendingEvents`) and never relabels an event: an online event is never enveloped, and an enveloped event
// belongs to a prepared session (the server answers an un-enveloped event on a prepared session with `envelope_mismatch`).
//
// Every write resolves only after its transaction committed, and checks the account and the local generation inside that same transaction, so a tab
// that was open before a logout or an account switch cannot write into the next account's journal. Reads of another account return nothing.

export const ONLINE_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ENVELOPE_KEYS = [
  "clientRunId",
  "snapshotId",
  "protocolVersion",
  "planVersion",
  "editionId",
  "bankVersion",
  "normalizationPolicyVersion",
  "scoringPolicyVersion",
  "localSequence",
] as const;

const KINDS: readonly OnlineSessionKind[] = ["daily", "game", "lesson"];

// The same normalization as owner.ts: a username is compared trimmed and lower-cased, never as typed.
export const accountKeyOf = (username: string): string => username.trim().toLowerCase();

const lockedError = (): OfflineError => new OfflineError("locked", "The local copy is locked until it has been cleared.");
const mismatchError = (): OfflineError => new OfflineError("owner_mismatch", "The local copy belongs to another account.");

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------------------------------------------------------------------------

// Records which account the online journal of this device belongs to and returns the binding a writer carries. It needs no request: the username came
// from the sign-in. One transaction on ownerState: a lock (failed clear) refuses, another account refuses, and a device whose owner has no username yet
// records it (the offline `ownerId` is left as it is).
export async function bindOnlineAccount(username: string): Promise<OnlineBinding> {
  const accountKey = accountKeyOf(username);
  if (accountKey === "") throw new OfflineError("owner_mismatch", "A username is required.");
  return runTx(["ownerState"], "readwrite", async (ctx) => {
    if (readLockMarker()) throw lockedError();
    const current = (await readOwnerInTx(ctx)) ?? initialOwnerState();
    if (current.clearFailed) throw lockedError();
    if (current.username !== null && accountKeyOf(current.username) !== accountKey) throw mismatchError();
    if (current.username === null) await ctx.put("ownerState", { ...current, username: username.trim(), updatedAt: nowIso() } satisfies OwnerState, OWNER_KEY);
    return { accountKey, generation: current.generation };
  });
}

// The binding of the account already recorded on this device, for a screen that has no username at hand. Never throws: null when nothing is recorded,
// the view is locked, or the storage is unavailable.
export async function currentOnlineBinding(): Promise<OnlineBinding | null> {
  try {
    if (readLockMarker()) return null;
    const owner = await runTx(["ownerState"], "readonly", (ctx) => readOwnerInTx(ctx));
    if (owner === undefined || owner.clearFailed || owner.username === null || accountKeyOf(owner.username) === "") return null;
    return { accountKey: accountKeyOf(owner.username), generation: owner.generation };
  } catch {
    return null;
  }
}

// A write: the account of the binding and its generation must still be the current ones.
async function guardBindingInTx(ctx: TxContext, binding: OnlineBinding): Promise<OwnerState> {
  if (readLockMarker()) throw lockedError();
  const owner = await readOwnerInTx(ctx);
  if (owner === undefined) throw mismatchError();
  if (owner.clearFailed) throw lockedError();
  if (owner.username !== null && accountKeyOf(owner.username) !== binding.accountKey) throw mismatchError();
  if (owner.generation !== binding.generation) throw new OfflineError("generation_mismatch", "The local copy was cleared in another tab.");
  if (owner.username === null) throw mismatchError();
  return owner;
}

// A write by account key only (the sync): the account must still be the current one.
async function requireAccountInTx(ctx: TxContext, accountKey: string): Promise<OwnerState> {
  if (readLockMarker()) throw lockedError();
  const owner = await readOwnerInTx(ctx);
  if (owner === undefined || owner.username === null || accountKeyOf(owner.username) !== accountKey) throw mismatchError();
  if (owner.clearFailed) throw lockedError();
  return owner;
}

// A read: another account, a lock or no owner means nothing to show, never another account's records.
async function readAccountInTx(ctx: TxContext, accountKey: string): Promise<OwnerState | null> {
  const owner = await readOwnerInTx(ctx);
  if (owner === undefined || owner.clearFailed || owner.username === null || accountKeyOf(owner.username) !== accountKey) return null;
  return owner;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------------------------------------

function assertRecordable(sessionId: string, kind: OnlineSessionKind, event: SessionEvent): void {
  if (sessionId === "") throw new OfflineError("invalid_event", "A session id is required.");
  if (!KINDS.includes(kind)) throw new OfflineError("invalid_event", "Unknown session kind.");
  if (typeof event !== "object" || event === null) throw new OfflineError("invalid_event", "An event is required.");
  if (event.type !== "answer" && event.type !== "activity") throw new OfflineError("invalid_event", "Unknown event type.");
  if (!isUuid(event.clientEventId)) throw new OfflineError("invalid_event", "The event id must be a UUID.");
  if (!Number.isFinite(eventOrderMs(event))) throw new OfflineError("invalid_event", "The event has no valid time.");
  const loose = event as unknown as Record<string, unknown>;
  for (const key of ENVELOPE_KEYS) {
    if (loose[key] !== undefined) throw new OfflineError("invalid_event", "An online event carries no offline envelope: an enveloped event belongs to the offline outbox.");
  }
}

// Writes the events of one session in one transaction (all or none) and resolves after the commit. An id that is already in the journal keeps its first
// payload, as it does on the server; an id that already sits in the offline outbox is refused, so one event is never held by both.
export async function recordOnlineEvents(
  binding: OnlineBinding,
  sessionId: string,
  kind: OnlineSessionKind,
  events: readonly SessionEvent[],
): Promise<OnlineEventRecord[]> {
  if (events.length === 0) return [];
  for (const event of events) assertRecordable(sessionId, kind, event);
  const now = nowIso();
  const stored = await runTx(["ownerState", "onlineEvents", "pendingEvents"], "readwrite", async (ctx) => {
    const owner = await guardBindingInTx(ctx, binding);
    const written: OnlineEventRecord[] = [];
    for (const event of events) {
      if ((await ctx.get("pendingEvents", event.clientEventId)) !== undefined) {
        throw new OfflineError("invalid_event", "The event id already belongs to the offline outbox.");
      }
      const existing = await ctx.get<OnlineEventRecord>("onlineEvents", event.clientEventId);
      if (existing !== undefined) {
        if (existing.accountKey !== binding.accountKey) throw mismatchError();
        written.push(existing);
        continue;
      }
      const record: OnlineEventRecord = {
        clientEventId: event.clientEventId,
        accountKey: binding.accountKey,
        generation: owner.generation,
        sessionId,
        kind,
        state: "queued",
        event,
        orderMs: eventOrderMs(event),
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.put("onlineEvents", record);
      written.push(record);
    }
    return written;
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return stored;
}

export interface ListOnlineEventsOptions {
  sessionId?: string;
  states?: readonly PendingEventState[];
}

// In replay order (occurredAt or startedAt, then clientEventId). An account that is not the current one, a lock or a cleared device reads as empty.
export async function listOnlineEvents(accountKey: string, options: ListOnlineEventsOptions = {}): Promise<OnlineEventRecord[]> {
  if (readLockMarker()) return [];
  const records = await runTx(["ownerState", "onlineEvents"], "readonly", async (ctx) => {
    if ((await readAccountInTx(ctx, accountKey)) === null) return [];
    return options.sessionId === undefined
      ? ctx.allByIndex<OnlineEventRecord>("onlineEvents", "byAccount", accountKey)
      : ctx.allByIndex<OnlineEventRecord>("onlineEvents", "bySession", options.sessionId);
  });
  const states = options.states;
  return sortForReplay(records.filter((record) => record.accountKey === accountKey && (states === undefined || states.includes(record.state))));
}

export async function countOnlineEvents(accountKey: string): Promise<OutboxCounts> {
  return countEvents(await listOnlineEvents(accountKey));
}

// One 200 settles every event of the batch, exactly as the offline outbox does (API-spec E21): `acknowledged` and `duplicate` leave the journal, and only
// those; `pending` stays without credit and is sent again on a later foreground sync; `rejected` is kept visibly as `blocked` and never sent again.
// An event the answer does not mention stays queued. A response that arrives after the account changed finds nothing to update.
export async function applyOnlineEventsResponse(accountKey: string, sent: readonly OnlineEventRecord[], response: EventsResponse): Promise<ApplyOutcome> {
  const acknowledged = new Set(response.acknowledged);
  const duplicate = new Set(response.duplicate);
  const pending = new Map(response.pending.map((item) => [item.clientEventId, item.reasonCode]));
  const rejected = new Map(response.rejected.map((item) => [item.clientEventId, item.code]));
  const outcome: ApplyOutcome = { acknowledgedIds: [], duplicateIds: [], pendingIds: [], blockedIds: [] };
  const now = nowIso();
  await runTx(["ownerState", "onlineEvents"], "readwrite", async (ctx) => {
    if ((await readAccountInTx(ctx, accountKey)) === null) return;
    for (const item of sent) {
      const stored = await ctx.get<OnlineEventRecord>("onlineEvents", item.clientEventId);
      if (stored === undefined || stored.accountKey !== accountKey) continue;
      const id = item.clientEventId;
      if (acknowledged.has(id)) {
        await ctx.delete("onlineEvents", id);
        outcome.acknowledgedIds.push(id);
      } else if (duplicate.has(id)) {
        await ctx.delete("onlineEvents", id);
        outcome.duplicateIds.push(id);
      } else if (pending.has(id)) {
        await ctx.put("onlineEvents", { ...stored, state: "pending", reasonCode: pending.get(id), attempts: stored.attempts + 1, updatedAt: now } satisfies OnlineEventRecord);
        outcome.pendingIds.push(id);
      } else if (rejected.has(id)) {
        await ctx.put("onlineEvents", { ...stored, state: "blocked", code: rejected.get(id), reasonCode: undefined, attempts: stored.attempts + 1, updatedAt: now } satisfies OnlineEventRecord);
        outcome.blockedIds.push(id);
      } else {
        await ctx.put("onlineEvents", { ...stored, attempts: stored.attempts + 1, updatedAt: now } satisfies OnlineEventRecord);
      }
    }
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return outcome;
}

// Local blocks: an event that can never be sent as it is (a single event over the body cap). Kept, shown, never deleted silently.
export async function blockOnlineEvents(accountKey: string, clientEventIds: readonly string[], code: string): Promise<string[]> {
  if (clientEventIds.length === 0) return [];
  const now = nowIso();
  const blocked: string[] = [];
  await runTx(["ownerState", "onlineEvents"], "readwrite", async (ctx) => {
    await requireAccountInTx(ctx, accountKey);
    for (const id of clientEventIds) {
      const stored = await ctx.get<OnlineEventRecord>("onlineEvents", id);
      if (stored === undefined || stored.accountKey !== accountKey) continue;
      await ctx.put("onlineEvents", { ...stored, state: "blocked", code, reasonCode: undefined, updatedAt: now } satisfies OnlineEventRecord);
      blocked.push(id);
    }
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return blocked;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Runs: where a reload resumes, and the finish that is still owed
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface OnlineRunPatch {
  resumeIndex?: number;
  answered?: Record<string, OnlineAnswered>;
  planId?: string | null;
  planVersion?: number | null;
}

function freshRun(binding: OnlineBinding, generation: number, sessionId: string, kind: OnlineSessionKind, now: string): OnlineRunRecord {
  return {
    sessionId,
    accountKey: binding.accountKey,
    generation,
    kind,
    planId: null,
    planVersion: null,
    resumeIndex: 0,
    answered: {},
    completion: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Rebuilds each entry from its known fields only, so a typed answer (or anything else a caller slips into an object) can never ride along into storage.
function sanitizeAnswered(answered: Record<string, OnlineAnswered>): Record<string, OnlineAnswered> {
  const clean: Record<string, OnlineAnswered> = {};
  for (const [questionId, entry] of Object.entries(answered)) {
    const { correct, assisted, expected, status, updated } = entry.result;
    clean[questionId] = {
      clientEventId: entry.clientEventId,
      hintUsed: entry.hintUsed === true,
      result: {
        correct: correct === true,
        assisted: assisted === true,
        expected: {
          ...(expected.order === undefined ? {} : { order: [...expected.order] }),
          ...(expected.optionId === undefined ? {} : { optionId: expected.optionId }),
          ...(expected.word === undefined ? {} : { word: expected.word }),
        },
        ...(status === undefined ? {} : { status }),
        ...(updated === undefined ? {} : { updated }),
      },
    };
  }
  return clean;
}

function assertPatch(sessionId: string, patch: OnlineRunPatch): void {
  if (sessionId === "") throw new OfflineError("invalid_run", "A run needs a session.");
  if (patch.resumeIndex !== undefined && (!Number.isInteger(patch.resumeIndex) || patch.resumeIndex < 0)) {
    throw new OfflineError("invalid_run", "resumeIndex must be a non-negative integer.");
  }
  if (patch.planVersion !== undefined && patch.planVersion !== null && !Number.isInteger(patch.planVersion)) {
    throw new OfflineError("invalid_run", "planVersion must be an integer.");
  }
}

export async function readOnlineRun(accountKey: string, sessionId: string): Promise<OnlineRunRecord | null> {
  if (readLockMarker()) return null;
  return runTx(["ownerState", "onlineRuns"], "readonly", async (ctx) => {
    if ((await readAccountInTx(ctx, accountKey)) === null) return null;
    const run = await ctx.get<OnlineRunRecord>("onlineRuns", sessionId);
    return run !== undefined && run.accountKey === accountKey ? run : null;
  });
}

// An upsert: the first save creates the record, later ones change only the fields of the patch (a pending completion is never touched).
export async function saveOnlineRun(binding: OnlineBinding, sessionId: string, kind: OnlineSessionKind, patch: OnlineRunPatch): Promise<OnlineRunRecord> {
  assertPatch(sessionId, patch);
  const now = nowIso();
  return runTx(["ownerState", "onlineRuns"], "readwrite", async (ctx) => {
    const owner = await guardBindingInTx(ctx, binding);
    const existing = await ctx.get<OnlineRunRecord>("onlineRuns", sessionId);
    if (existing !== undefined && existing.accountKey !== binding.accountKey) throw mismatchError();
    const base = existing ?? freshRun(binding, owner.generation, sessionId, kind, now);
    const next: OnlineRunRecord = {
      ...base,
      planId: patch.planId === undefined ? base.planId : patch.planId,
      planVersion: patch.planVersion === undefined ? base.planVersion : patch.planVersion,
      resumeIndex: patch.resumeIndex ?? base.resumeIndex,
      answered: patch.answered === undefined ? base.answered : sanitizeAnswered(patch.answered),
      updatedAt: now,
    };
    await ctx.put("onlineRuns", next);
    return next;
  });
}

// The finish of a session is owed to the server (E22) from this moment on. The Idempotency-Key must be a UUID (the server answers 422 otherwise, which the
// sync would take for final). The first stored key is kept: every retry, from any tab, sends the identical key.
export async function requestOnlineCompletion(binding: OnlineBinding, sessionId: string, kind: OnlineSessionKind, proposedKey: string): Promise<string> {
  assertPatch(sessionId, {});
  if (!isUuid(proposedKey)) throw new OfflineError("invalid_run", "The Idempotency-Key must be a UUID.");
  const now = nowIso();
  const key = await runTx(["ownerState", "onlineRuns"], "readwrite", async (ctx) => {
    const owner = await guardBindingInTx(ctx, binding);
    const existing = await ctx.get<OnlineRunRecord>("onlineRuns", sessionId);
    if (existing !== undefined && existing.accountKey !== binding.accountKey) throw mismatchError();
    if (existing?.completion?.state === "pending") return existing.completion.idempotencyKey;
    const base = existing ?? freshRun(binding, owner.generation, sessionId, kind, now);
    await ctx.put("onlineRuns", { ...base, completion: { state: "pending", idempotencyKey: proposedKey, requestedAt: now }, updatedAt: now } satisfies OnlineRunRecord);
    return proposedKey;
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return key;
}

// The server now holds the finished session: the run record is deleted. A call after the account changed finds nothing to delete.
export async function confirmOnlineCompletion(accountKey: string, sessionId: string): Promise<void> {
  await runTx(["ownerState", "onlineRuns"], "readwrite", async (ctx) => {
    if ((await readAccountInTx(ctx, accountKey)) === null) return;
    const run = await ctx.get<OnlineRunRecord>("onlineRuns", sessionId);
    if (run === undefined || run.accountKey !== accountKey) return;
    await ctx.delete("onlineRuns", sessionId);
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
}

export async function listPendingOnlineCompletions(accountKey: string): Promise<PendingOnlineCompletion[]> {
  if (readLockMarker()) return [];
  const runs = await runTx(["ownerState", "onlineRuns"], "readonly", async (ctx) => {
    if ((await readAccountInTx(ctx, accountKey)) === null) return [];
    return ctx.allByIndex<OnlineRunRecord>("onlineRuns", "byAccount", accountKey);
  });
  const owed: PendingOnlineCompletion[] = [];
  for (const run of runs) {
    if (run.accountKey !== accountKey || run.completion === null) continue;
    owed.push({ sessionId: run.sessionId, kind: run.kind, idempotencyKey: run.completion.idempotencyKey, requestedAt: run.completion.requestedAt });
  }
  return owed.sort((left, right) => (left.requestedAt < right.requestedAt ? -1 : left.requestedAt > right.requestedAt ? 1 : left.sessionId < right.sessionId ? -1 : 1));
}

// Run records nobody needs any more: no finish owed, no unsent event of the session (a blocked event is final and does not hold it), and untouched for
// longer than `maxAgeMs`. Never deletes an event. Resolves with the number of records removed.
export async function pruneOnlineRuns(accountKey: string, nowMs: number, maxAgeMs: number = ONLINE_RUN_MAX_AGE_MS): Promise<number> {
  return runTx(["ownerState", "onlineRuns", "onlineEvents"], "readwrite", async (ctx) => {
    await requireAccountInTx(ctx, accountKey);
    const runs = await ctx.allByIndex<OnlineRunRecord>("onlineRuns", "byAccount", accountKey);
    if (runs.length === 0) return 0;
    const events = await ctx.allByIndex<OnlineEventRecord>("onlineEvents", "byAccount", accountKey);
    const held = new Set(events.filter((event) => event.state !== "blocked").map((event) => event.sessionId));
    let removed = 0;
    for (const run of runs) {
      if (run.completion !== null || held.has(run.sessionId)) continue;
      const touched = Date.parse(run.updatedAt);
      if (!Number.isFinite(touched) || nowMs - touched <= maxAgeMs) continue;
      await ctx.delete("onlineRuns", run.sessionId);
      removed += 1;
    }
    return removed;
  });
}

// One cheap read for a foreground trigger: is there anything the server still has to be told (an unsent event, or a finish that is owed)? Blocked events
// are final and do not count. Resolves false for another account, a lock or any storage failure.
export async function hasOnlineJournalWork(accountKey: string): Promise<boolean> {
  try {
    if (readLockMarker()) return false;
    return await runTx(["ownerState", "onlineEvents", "onlineRuns"], "readonly", async (ctx) => {
      if ((await readAccountInTx(ctx, accountKey)) === null) return false;
      const events = await ctx.allByIndex<OnlineEventRecord>("onlineEvents", "byAccount", accountKey);
      if (events.some((event) => event.state !== "blocked")) return true;
      const runs = await ctx.allByIndex<OnlineRunRecord>("onlineRuns", "byAccount", accountKey);
      return runs.some((run) => run.completion !== null);
    });
  } catch {
    return false;
  }
}
