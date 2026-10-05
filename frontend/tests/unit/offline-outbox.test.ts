import { beforeEach, describe, expect, it } from "vitest";
import type { EventsResponse } from "@/lib/api/types";
import { attachEnvelope, buildEnvelope } from "@/lib/offline/envelope";
import {
  MAX_REPLAY_BYTES,
  applyEventsResponse,
  blockEvents,
  countOutbox,
  enqueueEvent,
  enqueueEvents,
  halveBatch,
  listPendingEvents,
  planReplayBatches,
  sortForReplay,
} from "@/lib/offline/outbox";
import { startRun } from "@/lib/offline/run-store";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import type { PendingEvent } from "@/lib/offline/types";
import { OWNER_ID, USERNAME, activityAt, answerAt, dumpAllStores, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());

async function setup() {
  const snapshot = makeSnapshot();
  await cacheActivePlan(snapshot, { username: USERNAME });
  return snapshot;
}

function response(partial: Partial<EventsResponse> = {}): EventsResponse {
  return {
    acknowledged: [],
    duplicate: [],
    pending: [],
    rejected: [],
    results: [],
    daily: { learningDate: "2026-10-06", dailyActiveMs: 0, dailyGoalMs: 600_000, dailyPercent: 0, dailyCompleted: false, extraActiveMs: 0 },
    ...partial,
  };
}

describe("enqueue (durable, atomic, unique)", () => {
  it("resolves only after the write committed, keeping the original envelope and the session path", async () => {
    const snapshot = await setup();
    const event = answerAt(snapshot, uuid(), 0);
    const stored = await enqueueEvent(OWNER_ID, "session-1", event);
    expect(stored).toMatchObject({ state: "queued", sessionId: "session-1", snapshotId: snapshot.snapshotId, clientRunId: event.clientRunId, localSequence: 0, attempts: 0 });
    const dump = await dumpAllStores();
    expect(dump.pendingEvents).toHaveLength(1);
    // The session id is the request path, never a field of the event.
    expect(Object.keys((dump.pendingEvents[0] as PendingEvent).event)).not.toContain("sessionId");
    expect((dump.pendingEvents[0] as PendingEvent).event).toEqual(event);
  });

  it("keeps the first payload for a repeated clientEventId, like the server does", async () => {
    const snapshot = await setup();
    const event = answerAt(snapshot, uuid(), 0);
    await enqueueEvent(OWNER_ID, "s1", event);
    await enqueueEvent(OWNER_ID, "s1", { ...event, answer: { optionId: "q-choice-b" } } as typeof event);
    const [only] = await listPendingEvents(OWNER_ID);
    expect(await listPendingEvents(OWNER_ID)).toHaveLength(1);
    expect(only?.event).toMatchObject({ answer: { optionId: "q-choice-a" } });
  });

  it.each([
    ["a partial envelope", (e: ReturnType<typeof answerAt>) => ({ ...e, localSequence: undefined })],
    ["a wrong protocol version", (e: ReturnType<typeof answerAt>) => ({ ...e, protocolVersion: 2 })],
    ["an id that is not a UUID", (e: ReturnType<typeof answerAt>) => ({ ...e, clientEventId: "not-a-uuid" })],
    ["a run id that is not a UUID", (e: ReturnType<typeof answerAt>) => ({ ...e, clientRunId: "run" })],
    ["no valid time", (e: ReturnType<typeof answerAt>) => ({ ...e, occurredAt: "yesterday" })],
  ])("refuses %s (invalid_event) and stores nothing", async (_name, corrupt) => {
    const snapshot = await setup();
    const bad = corrupt(answerAt(snapshot, uuid(), 0)) as ReturnType<typeof answerAt>;
    await expect(enqueueEvent(OWNER_ID, "s1", bad)).rejects.toMatchObject({ code: "invalid_event" });
    expect(await listPendingEvents(OWNER_ID)).toHaveLength(0);
  });

  it("refuses an empty session id", async () => {
    const snapshot = await setup();
    await expect(enqueueEvent(OWNER_ID, "", answerAt(snapshot, uuid(), 0))).rejects.toMatchObject({ code: "invalid_event" });
  });

  it("writes a batch atomically: one bad event stores none of them", async () => {
    const snapshot = await setup();
    const runId = uuid();
    const good = answerAt(snapshot, runId, 0);
    const bad = { ...answerAt(snapshot, runId, 1), occurredAt: "never" } as ReturnType<typeof answerAt>;
    await expect(enqueueEvents(OWNER_ID, "s1", [good, bad])).rejects.toMatchObject({ code: "invalid_event" });
    expect(await listPendingEvents(OWNER_ID)).toHaveLength(0);
    await expect(enqueueEvents(OWNER_ID, "s1", [good, answerAt(snapshot, runId, 1, 50)])).resolves.toHaveLength(2);
  });

  it("advances the run's nextLocalSequence in the same transaction", async () => {
    const snapshot = await setup();
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: "s1", kind: "daily" });
    await enqueueEvents(OWNER_ID, "s1", [answerAt(snapshot, run.clientRunId, 0), answerAt(snapshot, run.clientRunId, 1, 10), activityAt(snapshot, run.clientRunId, 2, 20)]);
    const dump = await dumpAllStores();
    expect((dump.activeRuns[0] as { nextLocalSequence: number }).nextLocalSequence).toBe(3);
  });

  it("returns nothing, never another owner's events, to a stale reader", async () => {
    const snapshot = await setup();
    await enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0));
    expect(await listPendingEvents("99999999-9999-4999-8999-999999999999")).toEqual([]);
    expect(await countOutbox("99999999-9999-4999-8999-999999999999")).toMatchObject({ total: 0 });
  });
});

async function stored(snapshot: ReturnType<typeof makeSnapshot>, count: number, sessionId = "s1") {
  const runId = uuid();
  const events = Array.from({ length: count }, (_, index) => answerAt(snapshot, runId, index, index * 1000));
  await enqueueEvents(OWNER_ID, sessionId, events);
  return events;
}

describe("replay order and batching (offline-spec 5)", () => {
  function pending(partial: Partial<PendingEvent> & Pick<PendingEvent, "clientEventId" | "orderMs" | "sessionId">): PendingEvent {
    const snapshot = makeSnapshot();
    const event = answerAt(snapshot, uuid(), 0);
    return {
      ownerId: OWNER_ID,
      generation: 1,
      snapshotId: snapshot.snapshotId,
      clientRunId: event.clientRunId,
      localSequence: 0,
      state: "queued",
      event: { ...event, clientEventId: partial.clientEventId },
      attempts: 0,
      createdAt: "2026-10-05T10:00:00.000Z",
      updatedAt: "2026-10-05T10:00:00.000Z",
      ...partial,
    };
  }

  it("sorts by occurredAt (startedAt for activity) and then by clientEventId, never by localSequence", () => {
    const events = [
      pending({ clientEventId: "b", orderMs: 2, sessionId: "s", localSequence: 0 }),
      pending({ clientEventId: "a", orderMs: 2, sessionId: "s", localSequence: 9 }),
      pending({ clientEventId: "c", orderMs: 1, sessionId: "s", localSequence: 5 }),
    ];
    expect(sortForReplay(events).map((e) => e.clientEventId)).toEqual(["c", "a", "b"]);
  });

  it("groups by session, one session after the other (earliest first), and leaves blocked events out", () => {
    const events = [
      pending({ clientEventId: "1", orderMs: 50, sessionId: "late" }),
      pending({ clientEventId: "2", orderMs: 10, sessionId: "early" }),
      pending({ clientEventId: "3", orderMs: 60, sessionId: "late" }),
      pending({ clientEventId: "4", orderMs: 20, sessionId: "early" }),
      pending({ clientEventId: "5", orderMs: 5, sessionId: "early", state: "blocked" }),
    ];
    const batches = planReplayBatches(events);
    expect(batches.map((b) => [b.sessionId, b.events.map((e) => e.clientEventId)])).toEqual([
      ["early", ["2", "4"]],
      ["late", ["1", "3"]],
    ]);
  });

  it("cuts a batch at 100 events", () => {
    const events = Array.from({ length: 250 }, (_, index) => pending({ clientEventId: `e${String(index).padStart(3, "0")}`, orderMs: index, sessionId: "s" }));
    const batches = planReplayBatches(events, { maxBytes: 10_000_000 });
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 50]);
    expect(batches.flatMap((b) => b.events).map((e) => e.clientEventId)).toEqual(events.map((e) => e.clientEventId));
  });

  it("cuts a batch at about 48 KB, and a single event over the cap is still a batch of one", () => {
    expect(MAX_REPLAY_BYTES).toBe(48 * 1024);
    const big = (id: string, order: number) => {
      const base = pending({ clientEventId: id, orderMs: order, sessionId: "s" });
      return { ...base, event: { ...base.event, answer: { text: "x".repeat(20_000) } } as PendingEvent["event"] };
    };
    const batches = planReplayBatches([big("a", 1), big("b", 2), big("c", 3)]);
    expect(batches.map((b) => b.events.length)).toEqual([2, 1]);
    const lone = planReplayBatches([big("a", 1)], { maxBytes: 100 });
    expect(lone).toHaveLength(1);
  });

  it("halves a batch after a 413 and keeps the order", () => {
    const events = Array.from({ length: 5 }, (_, index) => pending({ clientEventId: `e${index}`, orderMs: index, sessionId: "s" }));
    const [first, second] = halveBatch({ sessionId: "s", events });
    expect(first?.events.map((e) => e.clientEventId)).toEqual(["e0", "e1", "e2"]);
    expect(second?.events.map((e) => e.clientEventId)).toEqual(["e3", "e4"]);
    const single = { sessionId: "s", events: events.slice(0, 1) };
    expect(halveBatch(single)).toEqual([single]);
  });
});

describe("outcome handling per response (API-spec E21, D59)", () => {
  it("removes acknowledged and duplicate events, and only those", async () => {
    const snapshot = await setup();
    const events = await stored(snapshot, 4);
    const sent = await listPendingEvents(OWNER_ID);
    const ids = events.map((e) => e.clientEventId);
    const outcome = await applyEventsResponse(OWNER_ID, sent, response({ acknowledged: [ids[0] as string], duplicate: [ids[1] as string], pending: [{ clientEventId: ids[2] as string, reasonCode: "plan_changed_unverifiable" }], rejected: [{ clientEventId: ids[3] as string, code: "edition_mismatch" }] }));
    expect(outcome).toEqual({ acknowledgedIds: [ids[0]], duplicateIds: [ids[1]], pendingIds: [ids[2]], blockedIds: [ids[3]] });
    const left = await listPendingEvents(OWNER_ID);
    expect(left.map((e) => [e.clientEventId, e.state, e.reasonCode, e.code])).toEqual([
      [ids[2], "pending", "plan_changed_unverifiable", undefined],
      [ids[3], "blocked", undefined, "edition_mismatch"],
    ]);
    expect(left.every((e) => e.attempts === 1)).toBe(true);
  });

  it("keeps an event the response does not mention, queued, so it is sent again with the same id", async () => {
    const snapshot = await setup();
    const [event] = await stored(snapshot, 1);
    await applyEventsResponse(OWNER_ID, await listPendingEvents(OWNER_ID), response());
    const [again] = await listPendingEvents(OWNER_ID);
    expect(again).toMatchObject({ clientEventId: event?.clientEventId, state: "queued", attempts: 1 });
  });

  it("counts by state and never deletes a pending or blocked event on its own", async () => {
    const snapshot = await setup();
    const events = await stored(snapshot, 3);
    const ids = events.map((e) => e.clientEventId);
    await applyEventsResponse(OWNER_ID, await listPendingEvents(OWNER_ID), response({ pending: [{ clientEventId: ids[0] as string, reasonCode: "content_unverifiable" }], rejected: [{ clientEventId: ids[1] as string, code: "out_of_scope" }] }));
    expect(await countOutbox(OWNER_ID)).toEqual({ queued: 1, pending: 1, blocked: 1, total: 3 });
    // A second identical answer changes nothing about what is kept.
    await applyEventsResponse(OWNER_ID, await listPendingEvents(OWNER_ID), response({ pending: [{ clientEventId: ids[0] as string, reasonCode: "content_unverifiable" }] }));
    expect((await countOutbox(OWNER_ID)).total).toBe(3);
  });

  it("ignores a response that arrives after the copy was cleared", async () => {
    const snapshot = await setup();
    await stored(snapshot, 1);
    const sent = await listPendingEvents(OWNER_ID);
    const { clearAccountCache } = await import("@/lib/offline/db");
    await clearAccountCache(OWNER_ID);
    const outcome = await applyEventsResponse(OWNER_ID, sent, response({ acknowledged: sent.map((e) => e.clientEventId) }));
    expect(outcome.acknowledgedIds).toEqual([]);
  });

  it("blocks an event locally with a code, visibly and for good", async () => {
    const snapshot = await setup();
    const [event] = await stored(snapshot, 1);
    expect(await blockEvents(OWNER_ID, [event?.clientEventId as string], "payload_too_large")).toEqual([event?.clientEventId]);
    expect((await listPendingEvents(OWNER_ID))[0]).toMatchObject({ state: "blocked", code: "payload_too_large" });
  });
});

describe("envelope helper is usable on every event", () => {
  it("attaches all nine fields", () => {
    const snapshot = makeSnapshot();
    const run = uuid();
    const event = attachEnvelope({ clientEventId: uuid(), type: "activity", startedAt: "2026-10-05T10:00:00.000Z", endedAt: "2026-10-05T10:00:05.000Z", activeMs: 5000 }, buildEnvelope(snapshot, run, 4));
    expect(event).toMatchObject({ clientRunId: run, snapshotId: snapshot.snapshotId, protocolVersion: 1, planVersion: 1, editionId: snapshot.editionId, bankVersion: 3, normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1", localSequence: 4 });
  });
});
