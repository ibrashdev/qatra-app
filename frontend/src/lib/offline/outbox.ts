import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { MAX_EVENTS_PER_REQUEST } from "@/lib/api/session-endpoints";
import { publishOfflineMessage } from "./broadcast";
import { nowIso, readOwnerInTx, requireOwnerInTx, runTx, readLockMarker, emptyCounts, type TxContext } from "./db";
import { eventOrderMs, isFullEnvelope, isUuid } from "./envelope";
import { utf8Length } from "./storage";
import {
  OfflineError,
  type ActiveRunRecord,
  type CountOutboxFn,
  type EnqueueEventFn,
  type EnqueueEventsFn,
  type EnvelopedEvent,
  type GuardOptions,
  type ListPendingEventsFn,
  type OutboxCounts,
  type PendingEvent,
  type PendingEventState,
} from "./types";

// The durable outbox of PWA-design 4 and offline-spec 5. An event is one IndexedDB record keyed by its `clientEventId`; the id is made once and never
// changes, so every resend is the same event and the server answers `duplicate`. The write must commit before the screen shows an answer as checked, which is
// why the enqueue functions resolve only after the transaction completed. A recall answer's text stays here until the server has acknowledged it.

// Request body limits: E21 takes at most 100 events and the body cap is 64 KiB; a request is cut at about 48 KB (G-13).
export const MAX_REPLAY_BYTES = 48 * 1024;
const REQUEST_OVERHEAD_BYTES = 16; // {"events":[ ... ]}

function toPending(ownerId: string, generation: number, sessionId: string, event: EnvelopedEvent, now: string): PendingEvent {
  return {
    clientEventId: event.clientEventId,
    ownerId,
    generation,
    snapshotId: event.snapshotId,
    sessionId,
    clientRunId: event.clientRunId,
    localSequence: event.localSequence,
    state: "queued",
    event,
    orderMs: eventOrderMs(event),
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function assertEnqueueable(sessionId: string, event: EnvelopedEvent): void {
  if (sessionId === "") throw new OfflineError("invalid_event", "A session id is required.");
  if (!isFullEnvelope(event)) throw new OfflineError("invalid_event", "An offline event needs the full envelope.");
  if (!isUuid(event.clientEventId) || !isUuid(event.clientRunId)) throw new OfflineError("invalid_event", "Event and run ids must be UUIDs.");
  if (!Number.isFinite(eventOrderMs(event))) throw new OfflineError("invalid_event", "The event has no valid time.");
  if (event.type !== "answer" && event.type !== "activity") throw new OfflineError("invalid_event", "Unknown event type.");
}

export const enqueueEvents: EnqueueEventsFn = async (ownerId, sessionId, events, options: GuardOptions = {}) => {
  if (events.length === 0) return [];
  for (const event of events) assertEnqueueable(sessionId, event);
  const now = nowIso();
  const stored = await runTx(["ownerState", "pendingEvents", "activeRuns"], "readwrite", async (ctx) => {
    const owner = await requireOwnerInTx(ctx, ownerId, options);
    const written: PendingEvent[] = [];
    const sequences = new Map<string, number>();
    for (const event of events) {
      // The id is unique: the first payload for an id stays, as it does on the server.
      const existing = await ctx.get<PendingEvent>("pendingEvents", event.clientEventId);
      if (existing !== undefined) {
        if (existing.ownerId !== ownerId) throw new OfflineError("owner_mismatch", "The event id belongs to another account.");
        written.push(existing);
        continue;
      }
      const record = toPending(ownerId, owner.generation, sessionId, event, now);
      await ctx.put("pendingEvents", record);
      written.push(record);
      sequences.set(event.clientRunId, Math.max(sequences.get(event.clientRunId) ?? 0, event.localSequence + 1));
    }
    // The run continues after a restart where this transaction left it.
    for (const [clientRunId, next] of sequences) {
      const run = await ctx.get<ActiveRunRecord>("activeRuns", clientRunId);
      if (run !== undefined && run.ownerId === ownerId && next > run.nextLocalSequence) {
        await ctx.put("activeRuns", { ...run, nextLocalSequence: next, updatedAt: now });
      }
    }
    return written;
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return stored;
};

export const enqueueEvent: EnqueueEventFn = async (ownerId, sessionId, event, options) => {
  const [stored] = await enqueueEvents(ownerId, sessionId, [event], options);
  if (stored === undefined) throw new OfflineError("storage_failed", "The event was not stored.");
  return stored;
};

async function readOwned(ctx: TxContext, ownerId: string): Promise<PendingEvent[] | null> {
  const owner = await readOwnerInTx(ctx);
  if (owner === undefined || owner.ownerId !== ownerId || owner.clearFailed) return null;
  return ctx.allByIndex<PendingEvent>("pendingEvents", "byOwner", ownerId);
}

// A stale tab or another account reads nothing: an empty list, never another owner's events.
export const listPendingEvents: ListPendingEventsFn = async (ownerId) => {
  if (readLockMarker()) return [];
  return runTx(["ownerState", "pendingEvents"], "readonly", async (ctx) => (await readOwned(ctx, ownerId)) ?? []);
};

export function countEvents(events: readonly Pick<PendingEvent, "state">[]): OutboxCounts {
  const counts = emptyCounts();
  for (const event of events) {
    counts[event.state] += 1;
    counts.total += 1;
  }
  return counts;
}

export const countOutbox: CountOutboxFn = async (ownerId) => countEvents(await listPendingEvents(ownerId));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Replay planning (pure)
// ---------------------------------------------------------------------------------------------------------------------------------------------

// What the pure replay helpers need from a stored event. The offline outbox (`PendingEvent`) and the online journal (`OnlineEventRecord`) both fit, so the
// same planning serves both without changing what it does for either.
export interface ReplayableEvent {
  clientEventId: string;
  sessionId: string;
  state: PendingEventState;
  orderMs: number;
  event: SessionEvent;
}

// The server's replay order: occurredAt (startedAt for activity), then clientEventId. It never reorders, so the client sends in this order.
export function sortForReplay<T extends Pick<ReplayableEvent, "orderMs" | "clientEventId">>(events: readonly T[]): T[] {
  return [...events].sort((left, right) => left.orderMs - right.orderMs || (left.clientEventId < right.clientEventId ? -1 : left.clientEventId > right.clientEventId ? 1 : 0));
}

export interface ReplayBatch<T extends ReplayableEvent = PendingEvent> {
  sessionId: string;
  events: T[];
}

export interface ReplayLimits {
  maxEvents?: number;
  maxBytes?: number;
}

export function eventBytes(event: Pick<ReplayableEvent, "event">): number {
  return utf8Length(JSON.stringify(event.event)) + 1;
}

// Groups the events by session (the E21 path), one request per session at a time and sessions one after another, earliest session first. Inside a
// session a batch holds at most 100 events and about 48 KB. A single event larger than the cap is still a batch of one: the server's 413 decides.
// Blocked events are never sent again; the caller passes only `queued` and `pending` ones.
export function planReplayBatches<T extends ReplayableEvent = PendingEvent>(events: readonly T[], limits: ReplayLimits = {}): ReplayBatch<T>[] {
  const maxEvents = Math.max(1, Math.min(limits.maxEvents ?? MAX_EVENTS_PER_REQUEST, MAX_EVENTS_PER_REQUEST));
  const maxBytes = limits.maxBytes ?? MAX_REPLAY_BYTES;
  const bySession = new Map<string, T[]>();
  for (const event of events) {
    if (event.state === "blocked") continue;
    const list = bySession.get(event.sessionId);
    if (list === undefined) bySession.set(event.sessionId, [event]);
    else list.push(event);
  }
  const sessions = [...bySession.entries()].map(([sessionId, list]) => ({ sessionId, list: sortForReplay(list) }));
  sessions.sort((left, right) => (left.list[0]?.orderMs ?? 0) - (right.list[0]?.orderMs ?? 0) || (left.sessionId < right.sessionId ? -1 : 1));
  const batches: ReplayBatch<T>[] = [];
  for (const { sessionId, list } of sessions) {
    let current: T[] = [];
    let bytes = REQUEST_OVERHEAD_BYTES;
    for (const event of list) {
      const size = eventBytes(event);
      if (current.length > 0 && (current.length >= maxEvents || bytes + size > maxBytes)) {
        batches.push({ sessionId, events: current });
        current = [];
        bytes = REQUEST_OVERHEAD_BYTES;
      }
      current.push(event);
      bytes += size;
    }
    if (current.length > 0) batches.push({ sessionId, events: current });
  }
  return batches;
}

// After a 413: the same events in two halves (a single event cannot be halved).
export function halveBatch<T extends ReplayableEvent = PendingEvent>(batch: ReplayBatch<T>): ReplayBatch<T>[] {
  if (batch.events.length < 2) return [batch];
  const middle = Math.ceil(batch.events.length / 2);
  return [
    { sessionId: batch.sessionId, events: batch.events.slice(0, middle) },
    { sessionId: batch.sessionId, events: batch.events.slice(middle) },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ApplyOutcome {
  acknowledgedIds: string[];
  duplicateIds: string[];
  pendingIds: string[];
  blockedIds: string[];
}

// One 200 settles every event of the batch (API-spec E21): `acknowledged` and `duplicate` leave the outbox, and only those; `pending` stays without credit
// and is sent again on a later foreground sync; `rejected` is kept visibly as `blocked` and never sent unchanged (D59, offline-spec 5).
export async function applyEventsResponse(ownerId: string, sent: readonly PendingEvent[], response: EventsResponse): Promise<ApplyOutcome> {
  const acknowledged = new Set(response.acknowledged);
  const duplicate = new Set(response.duplicate);
  const pending = new Map(response.pending.map((item) => [item.clientEventId, item.reasonCode]));
  const rejected = new Map(response.rejected.map((item) => [item.clientEventId, item.code]));
  const outcome: ApplyOutcome = { acknowledgedIds: [], duplicateIds: [], pendingIds: [], blockedIds: [] };
  const now = nowIso();
  await runTx(["ownerState", "pendingEvents"], "readwrite", async (ctx) => {
    const owner = await readOwnerInTx(ctx);
    // The copy was cleared or switched while the request was in flight: there is nothing left to update.
    if (owner === undefined || owner.ownerId !== ownerId) return;
    for (const item of sent) {
      const stored = await ctx.get<PendingEvent>("pendingEvents", item.clientEventId);
      if (stored === undefined || stored.ownerId !== ownerId) continue;
      const id = item.clientEventId;
      if (acknowledged.has(id)) {
        await ctx.delete("pendingEvents", id);
        outcome.acknowledgedIds.push(id);
      } else if (duplicate.has(id)) {
        await ctx.delete("pendingEvents", id);
        outcome.duplicateIds.push(id);
      } else if (pending.has(id)) {
        await ctx.put("pendingEvents", { ...stored, state: "pending", reasonCode: pending.get(id), attempts: stored.attempts + 1, updatedAt: now });
        outcome.pendingIds.push(id);
      } else if (rejected.has(id)) {
        await ctx.put("pendingEvents", { ...stored, state: "blocked", code: rejected.get(id), reasonCode: undefined, attempts: stored.attempts + 1, updatedAt: now });
        outcome.blockedIds.push(id);
      } else {
        // Not mentioned in any list: it stays queued and is sent again.
        await ctx.put("pendingEvents", { ...stored, attempts: stored.attempts + 1, updatedAt: now });
      }
    }
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return outcome;
}

// Local blocks: an event that can never be sent as it is (a single event over the body cap, a revoked edition). Kept, shown, never deleted silently.
export async function blockEvents(ownerId: string, clientEventIds: readonly string[], code: string): Promise<string[]> {
  if (clientEventIds.length === 0) return [];
  const now = nowIso();
  const blocked: string[] = [];
  await runTx(["ownerState", "pendingEvents"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    for (const id of clientEventIds) {
      const stored = await ctx.get<PendingEvent>("pendingEvents", id);
      if (stored === undefined || stored.ownerId !== ownerId) continue;
      await ctx.put("pendingEvents", { ...stored, state: "blocked", code, reasonCode: undefined, updatedAt: now });
      blocked.push(id);
    }
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
  return blocked;
}
