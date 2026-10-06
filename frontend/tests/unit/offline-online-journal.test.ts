import { beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@/lib/api/types";
import { LOCK_MARKER_KEY, clearAccountCache, closeOfflineDb, nowIso, runTx } from "@/lib/offline/db";
import { clearLocalCopy, logoutLocally, readOwnerState } from "@/lib/offline/owner";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { enqueueEvent, eventBytes, halveBatch, planReplayBatches } from "@/lib/offline/outbox";
import {
  accountKeyOf,
  applyOnlineEventsResponse,
  bindOnlineAccount,
  blockOnlineEvents,
  confirmOnlineCompletion,
  countOnlineEvents,
  currentOnlineBinding,
  hasOnlineJournalWork,
  listOnlineEvents,
  listPendingOnlineCompletions,
  pruneOnlineRuns,
  readOnlineRun,
  recordOnlineEvents,
  requestOnlineCompletion,
  saveOnlineRun,
} from "@/lib/offline/online-journal";
import type { OnlineAnswered, OnlineBinding, OnlineEventRecord, OnlineRunRecord, OwnerState } from "@/lib/offline/types";
import { FakeBroadcastChannel, OWNER_ID, USERNAME, answerAt, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";
import { ONLINE_SESSION, OTHER_ONLINE_SESSION, dumpStore, eventsResponse, onlineActivityAt, onlineAnswerAt } from "./offline-online-support";

beforeEach(() => resetOfflineEnvironment());

const DAY_MS = 24 * 60 * 60 * 1000;

async function bound(): Promise<OnlineBinding> {
  return bindOnlineAccount(USERNAME);
}

const ids = (records: readonly { clientEventId: string }[]): string[] => records.map((record) => record.clientEventId);

function answered(clientEventId: string): OnlineAnswered {
  return { clientEventId, hintUsed: false, result: { correct: true, assisted: false, expected: { optionId: "q-choice-a" }, status: "counted" } };
}

describe("binding an online session to the signed-in account", () => {
  it("records the normalized username on a device that has no owner, without inventing an ownership id", async () => {
    const binding = await bindOnlineAccount("  Test.Learner ");
    expect(binding).toEqual({ accountKey: "test.learner", generation: 1 });
    expect(await readOwnerState()).toMatchObject({ ownerId: null, username: "Test.Learner", generation: 1, clearFailed: false });
    expect(accountKeyOf(" TEST.learner")).toBe("test.learner");
  });

  it("gives the same binding for the same account in any spelling, and keeps the ownership id of a downloaded copy", async () => {
    await cacheActivePlan(makeSnapshot(), { username: USERNAME });
    const first = await bindOnlineAccount(USERNAME);
    expect(await bindOnlineAccount(" TEST.LEARNER ")).toEqual(first);
    expect(await readOwnerState()).toMatchObject({ ownerId: OWNER_ID, username: USERNAME });
  });

  it("records the username on a downloaded copy that has none, and leaves the ownership id alone", async () => {
    await cacheActivePlan(makeSnapshot(), { username: null });
    expect(((await readOwnerState()) as OwnerState).username).toBeNull();
    await bindOnlineAccount(USERNAME);
    expect(await readOwnerState()).toMatchObject({ ownerId: OWNER_ID, username: USERNAME });
  });

  it("refuses another account (owner_mismatch) and an empty username", async () => {
    await bound();
    await expect(bindOnlineAccount("someone.else")).rejects.toMatchObject({ code: "owner_mismatch" });
    await expect(bindOnlineAccount("   ")).rejects.toMatchObject({ code: "owner_mismatch" });
  });

  it("refuses while the personal view is locked by a failed clear (the marker or the flag)", async () => {
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    await expect(bindOnlineAccount(USERNAME)).rejects.toMatchObject({ code: "locked" });
    window.localStorage.removeItem(LOCK_MARKER_KEY);
    await runTx(["ownerState"], "readwrite", async (ctx) => {
      await ctx.put("ownerState", { ownerId: null, username: null, generation: 1, logoutPending: false, clearFailed: true, updatedAt: nowIso() }, "current");
    });
    await expect(bindOnlineAccount(USERNAME)).rejects.toMatchObject({ code: "locked" });
  });

  it("currentOnlineBinding reads the recorded account and never throws", async () => {
    expect(await currentOnlineBinding()).toBeNull();
    const binding = await bound();
    expect(await currentOnlineBinding()).toEqual(binding);
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    expect(await currentOnlineBinding()).toBeNull();
    window.localStorage.removeItem(LOCK_MARKER_KEY);
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    closeOfflineDb();
    expect(await currentOnlineBinding()).toBeNull();
  });
});

describe("recording events (durable, atomic, account-bound)", () => {
  it("resolves after the commit with a queued record that keeps the event exactly as it was made, and announces the change", async () => {
    const binding = await bound();
    const answer = onlineAnswerAt(1000);
    const activity = onlineActivityAt(5000);
    const stored = await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [answer, activity]);

    expect(stored).toHaveLength(2);
    const dump = (await dumpStore("onlineEvents")) as OnlineEventRecord[];
    expect(dump).toHaveLength(2);
    const answerRecord = dump.find((record) => record.clientEventId === answer.clientEventId);
    expect(answerRecord).toMatchObject({ accountKey: "test.learner", generation: binding.generation, sessionId: ONLINE_SESSION, kind: "daily", state: "queued", attempts: 0 });
    expect(answerRecord?.event).toEqual(answer);
    expect(answerRecord?.orderMs).toBe(Date.parse((answer as { occurredAt: string }).occurredAt));
    expect(dump.find((record) => record.clientEventId === activity.clientEventId)?.orderMs).toBe(Date.parse((activity as { startedAt: string }).startedAt));
    // The session id is the request path, never a field of the event.
    expect(Object.keys(answerRecord?.event ?? {})).not.toContain("sessionId");
    expect(FakeBroadcastChannel.log).toContainEqual({ type: "OUTBOX_CHANGED" });
  });

  it("keeps the first payload for a repeated clientEventId, like the server does", async () => {
    const binding = await bound();
    const event = onlineAnswerAt(0);
    await recordOnlineEvents(binding, ONLINE_SESSION, "game", [event]);
    await recordOnlineEvents(binding, ONLINE_SESSION, "game", [{ ...event, answer: { optionId: "q-choice-b" } } as SessionEvent]);
    const [only, ...rest] = await listOnlineEvents(binding.accountKey);
    expect(rest).toHaveLength(0);
    expect(only?.event).toMatchObject({ answer: { optionId: "q-choice-a" } });
  });

  it("returns nothing for an empty list and touches no storage", async () => {
    expect(await recordOnlineEvents({ accountKey: "nobody", generation: 9 }, ONLINE_SESSION, "daily", [])).toEqual([]);
  });

  it("refuses an enveloped event (it belongs to the offline outbox): a full envelope, or even one stray field", async () => {
    const binding = await bound();
    const enveloped = answerAt(makeSnapshot(), uuid(), 0);
    await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [enveloped])).rejects.toMatchObject({ code: "invalid_event" });
    for (const field of ["clientRunId", "snapshotId", "protocolVersion", "planVersion", "editionId", "bankVersion", "normalizationPolicyVersion", "scoringPolicyVersion", "localSequence"]) {
      await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0, { [field]: field === "protocolVersion" || field === "localSequence" ? 1 : "x" })])).rejects.toMatchObject({ code: "invalid_event" });
    }
    expect(await listOnlineEvents(binding.accountKey)).toEqual([]);
  });

  it("refuses an event id that already sits in the offline outbox, so one event is never held by both", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const binding = await bound();
    const offline = answerAt(snapshot, uuid(), 0);
    await enqueueEvent(OWNER_ID, "prepared-session", offline);
    const stripped = onlineAnswerAt(0, { clientEventId: offline.clientEventId });
    await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(10), stripped])).rejects.toMatchObject({ code: "invalid_event" });
    // The good one in the same batch was not kept either: all or none.
    expect(await listOnlineEvents(binding.accountKey)).toEqual([]);
  });

  it.each([
    ["an id that is not a UUID", () => onlineAnswerAt(0, { clientEventId: "not-a-uuid" })],
    ["no valid time", () => onlineAnswerAt(0, { occurredAt: "yesterday" })],
    ["an activity without a valid start", () => onlineActivityAt(0, 5000, { startedAt: "never" })],
    ["an unknown event type", () => onlineAnswerAt(0, { type: "note" })],
  ])("refuses %s (invalid_event) and stores nothing", async (_name, make) => {
    const binding = await bound();
    await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [make()])).rejects.toMatchObject({ code: "invalid_event" });
    await expect(recordOnlineEvents(binding, "", "daily", [onlineAnswerAt(0)])).rejects.toMatchObject({ code: "invalid_event" });
    expect(await listOnlineEvents(binding.accountKey)).toEqual([]);
  });

  it("refuses a tab that started before a logout or a clear (generation_mismatch), also after the same account signed in again", async () => {
    const stale = await bound();
    await clearAccountCache();
    await expect(recordOnlineEvents(stale, ONLINE_SESSION, "daily", [onlineAnswerAt(0)])).rejects.toMatchObject({ code: "generation_mismatch" });
    const fresh = await bound();
    expect(fresh.generation).toBeGreaterThan(stale.generation);
    await expect(recordOnlineEvents(stale, ONLINE_SESSION, "daily", [onlineAnswerAt(0)])).rejects.toMatchObject({ code: "generation_mismatch" });
    await expect(recordOnlineEvents(fresh, ONLINE_SESSION, "daily", [onlineAnswerAt(0)])).resolves.toHaveLength(1);
  });

  it("refuses when another account owns the device now, and while the view is locked", async () => {
    const binding = await bound();
    await runTx(["ownerState"], "readwrite", async (ctx) => {
      await ctx.put("ownerState", { ownerId: null, username: "someone.else", generation: binding.generation, logoutPending: false, clearFailed: false, updatedAt: nowIso() }, "current");
    });
    await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)])).rejects.toMatchObject({ code: "owner_mismatch" });
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)])).rejects.toMatchObject({ code: "locked" });
  });

  it("reports unavailable storage as an error, so the screen never claims an answer was saved", async () => {
    const binding = await bound();
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    closeOfflineDb();
    await expect(recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)])).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("reading the journal (isolated by account)", () => {
  it("lists in replay order (time, then id), filters by session and by state, and counts by state", async () => {
    const binding = await bound();
    const late = onlineAnswerAt(9000);
    const early = onlineAnswerAt(1000);
    const middle = onlineActivityAt(5000);
    const other = onlineAnswerAt(100);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [late, early, middle]);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", [other]);

    expect(ids(await listOnlineEvents(binding.accountKey, { sessionId: ONLINE_SESSION }))).toEqual([early.clientEventId, middle.clientEventId, late.clientEventId]);
    expect(ids(await listOnlineEvents(binding.accountKey, { sessionId: OTHER_ONLINE_SESSION }))).toEqual([other.clientEventId]);
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(4);

    await blockOnlineEvents(binding.accountKey, [late.clientEventId], "payload_too_large");
    expect(ids(await listOnlineEvents(binding.accountKey, { states: ["blocked"] }))).toEqual([late.clientEventId]);
    expect(await listOnlineEvents(binding.accountKey, { states: ["queued", "pending"] })).toHaveLength(3);
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 3, pending: 0, blocked: 1, total: 4 });
  });

  it("another account reads nothing, a stale account key reads nothing, and a foreign record is never returned", async () => {
    const binding = await bound();
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    expect(await listOnlineEvents("someone.else")).toEqual([]);
    expect(await countOnlineEvents("someone.else")).toEqual({ queued: 0, pending: 0, blocked: 0, total: 0 });
    // A record of another account that ended up in the store (it cannot through this module) is still filtered out.
    await runTx(["onlineEvents"], "readwrite", async (ctx) => {
      await ctx.put("onlineEvents", { clientEventId: uuid(), accountKey: "someone.else", generation: 1, sessionId: ONLINE_SESSION, kind: "daily", state: "queued", event: onlineAnswerAt(5), orderMs: 5, attempts: 0, createdAt: nowIso(), updatedAt: nowIso() });
    });
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(1);
    expect(await listOnlineEvents(binding.accountKey, { sessionId: ONLINE_SESSION })).toHaveLength(1);
  });

  it("reads empty after the account changed and while the view is locked", async () => {
    const binding = await bound();
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    expect(await listOnlineEvents(binding.accountKey)).toEqual([]);
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toBeNull();
    window.localStorage.removeItem(LOCK_MARKER_KEY);
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(1);
    await clearAccountCache();
    expect(await listOnlineEvents(binding.accountKey)).toEqual([]);
    await bindOnlineAccount("someone.else");
    expect(await listOnlineEvents(binding.accountKey)).toEqual([]);
    expect(await listOnlineEvents("someone.else")).toEqual([]);
  });
});

describe("what the server answered (API-spec E21), the same semantics as the offline outbox", () => {
  async function recorded(count: number): Promise<{ binding: OnlineBinding; sent: OnlineEventRecord[] }> {
    const binding = await bound();
    const sent = await recordOnlineEvents(
      binding,
      ONLINE_SESSION,
      "daily",
      Array.from({ length: count }, (_, index) => onlineAnswerAt(index * 1000)),
    );
    return { binding, sent };
  }

  it("removes acknowledged and duplicate events, keeps pending ones without credit, blocks rejected ones, and leaves the rest queued", async () => {
    const { binding, sent } = await recorded(5);
    const [a, b, c, d, e] = ids(sent) as [string, string, string, string, string];
    const outcome = await applyOnlineEventsResponse(
      binding.accountKey,
      sent,
      eventsResponse({ acknowledged: [a], duplicate: [b], pending: [{ clientEventId: c, reasonCode: "plan_changed_unverifiable" }], rejected: [{ clientEventId: d, code: "session_closed" }] }),
    );
    expect(outcome).toEqual({ acknowledgedIds: [a], duplicateIds: [b], pendingIds: [c], blockedIds: [d] });
    const left = await listOnlineEvents(binding.accountKey);
    expect(left.map((record) => [record.clientEventId, record.state, record.reasonCode, record.code, record.attempts])).toEqual([
      [c, "pending", "plan_changed_unverifiable", undefined, 1],
      [d, "blocked", undefined, "session_closed", 1],
      [e, "queued", undefined, undefined, 1],
    ]);
  });

  it("never deletes a pending or blocked event on its own, however often the same answer arrives", async () => {
    const { binding, sent } = await recorded(2);
    const [a, b] = ids(sent) as [string, string];
    const answer = eventsResponse({ pending: [{ clientEventId: a, reasonCode: "content_unverifiable" }], rejected: [{ clientEventId: b, code: "out_of_scope" }] });
    await applyOnlineEventsResponse(binding.accountKey, sent, answer);
    await applyOnlineEventsResponse(binding.accountKey, await listOnlineEvents(binding.accountKey), answer);
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 0, pending: 1, blocked: 1, total: 2 });
  });

  it("ignores an answer that arrives after the account changed", async () => {
    const { binding, sent } = await recorded(1);
    await clearAccountCache();
    const outcome = await applyOnlineEventsResponse(binding.accountKey, sent, eventsResponse({ acknowledged: ids(sent) }));
    expect(outcome.acknowledgedIds).toEqual([]);
    await bindOnlineAccount("someone.else");
    expect((await applyOnlineEventsResponse(binding.accountKey, sent, eventsResponse({ acknowledged: ids(sent) }))).acknowledgedIds).toEqual([]);
  });

  it("blocks events locally with a code, visibly and for good, and refuses for another account", async () => {
    const { binding, sent } = await recorded(1);
    expect(await blockOnlineEvents(binding.accountKey, [sent[0]?.clientEventId as string], "payload_too_large")).toEqual(ids(sent));
    expect((await listOnlineEvents(binding.accountKey))[0]).toMatchObject({ state: "blocked", code: "payload_too_large" });
    expect(await blockOnlineEvents(binding.accountKey, [], "x")).toEqual([]);
    await expect(blockOnlineEvents("someone.else", ids(sent), "x")).rejects.toMatchObject({ code: "owner_mismatch" });
  });
});

describe("runs: where a reload resumes, and the finish that is owed", () => {
  it("creates the record on the first save and changes only what a later patch names", async () => {
    const binding = await bound();
    const first = await saveOnlineRun(binding, ONLINE_SESSION, "daily", { planId: "plan-1", planVersion: 4, resumeIndex: 2 });
    expect(first).toMatchObject({ sessionId: ONLINE_SESSION, accountKey: "test.learner", generation: binding.generation, kind: "daily", planId: "plan-1", planVersion: 4, resumeIndex: 2, answered: {}, completion: null });
    const second = await saveOnlineRun(binding, ONLINE_SESSION, "daily", { answered: { q1: answered(uuid()) } });
    expect(second).toMatchObject({ planId: "plan-1", planVersion: 4, resumeIndex: 2, createdAt: first.createdAt });
    expect(Object.keys(second.answered)).toEqual(["q1"]);
    const third = await saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: 3, planId: null, planVersion: null });
    expect(third).toMatchObject({ planId: null, planVersion: null, resumeIndex: 3 });
    expect(Object.keys(third.answered)).toEqual(["q1"]);
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toEqual(third);
    expect(await readOnlineRun("someone.else", ONLINE_SESSION)).toBeNull();
    expect(await readOnlineRun(binding.accountKey, OTHER_ONLINE_SESSION)).toBeNull();
  });

  it("stores only what a screen needs to show an answer again, never a typed answer", async () => {
    const binding = await bound();
    const sneaky = { clientEventId: uuid(), hintUsed: true, answer: { text: "typed-secret" }, result: { correct: false, assisted: true, expected: { word: "alpha", leaked: "typed-secret" }, status: "rejected", updated: true, typed: "typed-secret" } };
    await saveOnlineRun(binding, ONLINE_SESSION, "game", { answered: { q1: sneaky as unknown as OnlineAnswered } });
    const stored = ((await dumpStore("onlineRuns")) as OnlineRunRecord[])[0] as OnlineRunRecord;
    expect(stored.answered.q1).toEqual({ clientEventId: sneaky.clientEventId, hintUsed: true, result: { correct: false, assisted: true, expected: { word: "alpha" }, status: "rejected", updated: true } });
    expect(JSON.stringify(await dumpStore("onlineRuns"))).not.toContain("typed-secret");
  });

  it("rejects a resume position that is not a non-negative integer, and a run without a session", async () => {
    const binding = await bound();
    await expect(saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: -1 })).rejects.toMatchObject({ code: "invalid_run" });
    await expect(saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: 1.5 })).rejects.toMatchObject({ code: "invalid_run" });
    await expect(saveOnlineRun(binding, "", "daily", {})).rejects.toMatchObject({ code: "invalid_run" });
    expect(await dumpStore("onlineRuns")).toEqual([]);
  });

  it("refuses a stale tab (generation_mismatch)", async () => {
    const stale = await bound();
    await clearAccountCache();
    await expect(saveOnlineRun(stale, ONLINE_SESSION, "daily", { resumeIndex: 1 })).rejects.toMatchObject({ code: "generation_mismatch" });
    await expect(requestOnlineCompletion(stale, ONLINE_SESSION, "daily", uuid())).rejects.toMatchObject({ code: "generation_mismatch" });
  });

  it("keeps the first idempotency key of a finish for every retry, from any binding of the same account", async () => {
    const binding = await bound();
    const first = uuid();
    expect(await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", first)).toBe(first);
    expect(await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid())).toBe(first);
    expect(await requestOnlineCompletion(await bound(), ONLINE_SESSION, "daily", uuid())).toBe(first);
    // A later save of the position does not touch the owed finish.
    await saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: 7 });
    expect(await listPendingOnlineCompletions(binding.accountKey)).toMatchObject([{ sessionId: ONLINE_SESSION, kind: "daily", idempotencyKey: first }]);
    expect(((await dumpStore("onlineRuns")) as OnlineRunRecord[])[0]).toMatchObject({ resumeIndex: 7, completion: { state: "pending", idempotencyKey: first } });
  });

  it("creates the run record when the finish is the first thing saved, and only accepts a UUID key (the server says 422 to anything else)", async () => {
    const binding = await bound();
    await expect(requestOnlineCompletion(binding, ONLINE_SESSION, "daily", "key-1")).rejects.toMatchObject({ code: "invalid_run" });
    expect(await dumpStore("onlineRuns")).toEqual([]);
    const key = uuid();
    await requestOnlineCompletion(binding, OTHER_ONLINE_SESSION, "lesson", key);
    expect(await readOnlineRun(binding.accountKey, OTHER_ONLINE_SESSION)).toMatchObject({ kind: "lesson", resumeIndex: 0, completion: { state: "pending", idempotencyKey: key } });
  });

  it("lists the owed finishes of this account only, oldest first, and confirming one deletes its run record", async () => {
    const binding = await bound();
    const keyA = uuid();
    const keyB = uuid();
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", keyA);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await requestOnlineCompletion(binding, OTHER_ONLINE_SESSION, "game", keyB);
    await saveOnlineRun(binding, "no-finish-owed", "daily", { resumeIndex: 1 });
    expect((await listPendingOnlineCompletions(binding.accountKey)).map((entry) => entry.sessionId)).toEqual([ONLINE_SESSION, OTHER_ONLINE_SESSION]);
    expect(await listPendingOnlineCompletions("someone.else")).toEqual([]);

    await confirmOnlineCompletion("someone.else", ONLINE_SESSION);
    expect(await listPendingOnlineCompletions(binding.accountKey)).toHaveLength(2);
    await confirmOnlineCompletion(binding.accountKey, ONLINE_SESSION);
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toBeNull();
    expect((await listPendingOnlineCompletions(binding.accountKey)).map((entry) => entry.sessionId)).toEqual([OTHER_ONLINE_SESSION]);
    // Confirming twice, or a session that was never saved, is harmless.
    await confirmOnlineCompletion(binding.accountKey, ONLINE_SESSION);
    await confirmOnlineCompletion(binding.accountKey, "never-saved");
  });
});

describe("pruning the run records nobody needs", () => {
  async function ageRun(sessionId: string, ageMs: number): Promise<void> {
    await runTx(["onlineRuns"], "readwrite", async (ctx) => {
      const run = await ctx.get<OnlineRunRecord>("onlineRuns", sessionId);
      if (run !== undefined) await ctx.put("onlineRuns", { ...run, updatedAt: new Date(Date.now() - ageMs).toISOString() });
    });
  }

  it("removes only old records with no owed finish and no unsent event, and never deletes an event", async () => {
    const binding = await bound();
    const sessions = ["old-idle", "fresh", "old-owed", "old-with-event", "old-blocked-only"];
    for (const sessionId of sessions) await saveOnlineRun(binding, sessionId, "daily", { resumeIndex: 1 });
    await requestOnlineCompletion(binding, "old-owed", "daily", uuid());
    const queued = onlineAnswerAt(0);
    const blocked = onlineAnswerAt(10);
    await recordOnlineEvents(binding, "old-with-event", "daily", [queued]);
    await recordOnlineEvents(binding, "old-blocked-only", "daily", [blocked]);
    await blockOnlineEvents(binding.accountKey, [blocked.clientEventId], "session_closed");
    for (const sessionId of sessions) if (sessionId !== "fresh") await ageRun(sessionId, 8 * DAY_MS);

    expect(await pruneOnlineRuns(binding.accountKey, Date.now())).toBe(2);
    const left = ((await dumpStore("onlineRuns")) as OnlineRunRecord[]).map((run) => run.sessionId).sort();
    expect(left).toEqual(["fresh", "old-owed", "old-with-event"]);
    expect(await dumpStore("onlineEvents")).toHaveLength(2);
  });

  it("honours the age limit it is given, and does nothing for another account", async () => {
    const binding = await bound();
    await saveOnlineRun(binding, "idle", "daily", { resumeIndex: 1 });
    await ageRun("idle", 2 * DAY_MS);
    expect(await pruneOnlineRuns(binding.accountKey, Date.now())).toBe(0);
    await expect(pruneOnlineRuns("someone.else", Date.now(), DAY_MS)).rejects.toMatchObject({ code: "owner_mismatch" });
    expect(await pruneOnlineRuns(binding.accountKey, Date.now(), DAY_MS)).toBe(1);
  });
});

describe("work the server still has to be told about", () => {
  it("is true for an unsent event or an owed finish, and false for nothing, for blocked events only, and for another account", async () => {
    const binding = await bound();
    expect(await hasOnlineJournalWork(binding.accountKey)).toBe(false);
    const event = onlineAnswerAt(0);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [event]);
    expect(await hasOnlineJournalWork(binding.accountKey)).toBe(true);
    expect(await hasOnlineJournalWork("someone.else")).toBe(false);
    await blockOnlineEvents(binding.accountKey, [event.clientEventId], "session_closed");
    expect(await hasOnlineJournalWork(binding.accountKey)).toBe(false);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    expect(await hasOnlineJournalWork(binding.accountKey)).toBe(true);
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    expect(await hasOnlineJournalWork(binding.accountKey)).toBe(false);
  });
});

describe("every clear wipes the journal with the rest of the personal copy", () => {
  async function filled(): Promise<OnlineBinding> {
    const binding = await bound();
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0), onlineActivityAt(100)]);
    await saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: 2 });
    await requestOnlineCompletion(binding, OTHER_ONLINE_SESSION, "game", uuid());
    expect(await dumpStore("onlineEvents")).toHaveLength(2);
    expect(await dumpStore("onlineRuns")).toHaveLength(2);
    return binding;
  }

  it("clearAccountCache (logout, account switch, delete account) empties both stores and bumps the generation", async () => {
    const binding = await filled();
    await clearAccountCache();
    expect(await dumpStore("onlineEvents")).toEqual([]);
    expect(await dumpStore("onlineRuns")).toEqual([]);
    expect(((await readOwnerState()) as OwnerState).generation).toBe(binding.generation + 1);
  });

  it("logoutLocally counts the unsent online answers it discards, then the stores are empty", async () => {
    await filled();
    expect(await logoutLocally({ serverLogoutDone: true })).toEqual({ discardedEvents: 2, serverLogoutPending: false });
    expect(await dumpStore("onlineEvents")).toEqual([]);
    expect(await dumpStore("onlineRuns")).toEqual([]);
  });

  it("clearLocalCopy counts them too, together with the offline outbox of a downloaded copy", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const binding = await bound();
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0), onlineAnswerAt(50), onlineAnswerAt(90)]);
    await enqueueEvent(OWNER_ID, "prepared-session", answerAt(snapshot, uuid(), 0));
    await blockOnlineEvents(binding.accountKey, [(await listOnlineEvents(binding.accountKey))[0]?.clientEventId as string], "session_closed");
    // Queued, pending and blocked ones all count: 3 online + 1 offline.
    expect(await clearLocalCopy()).toEqual({ discardedEvents: 4 });
    expect(await dumpStore("onlineEvents")).toEqual([]);
    expect(await dumpStore("pendingEvents")).toEqual([]);
  });
});

describe("the replay planning serves both record types", () => {
  it("plans online records exactly as it plans outbox records: per session, in order, 100 at a time, blocked ones left out", async () => {
    const binding = await bound();
    const events = Array.from({ length: 250 }, (_, index) => onlineAnswerAt(index));
    const stored = await recordOnlineEvents(binding, ONLINE_SESSION, "daily", events);
    const blocked = stored[0] as OnlineEventRecord;
    const batches = planReplayBatches([...stored.slice(1), { ...blocked, state: "blocked" as const }], { maxBytes: 10_000_000 });
    expect(batches.map((batch) => batch.events.length)).toEqual([100, 100, 49]);
    expect(batches.every((batch) => batch.sessionId === ONLINE_SESSION)).toBe(true);
    expect(batches.flatMap((batch) => ids(batch.events))).toEqual(ids(stored.slice(1)));
    const [first, second] = halveBatch({ sessionId: ONLINE_SESSION, events: stored.slice(0, 5) });
    expect([first?.events.length, second?.events.length]).toEqual([3, 2]);
    expect(eventBytes(stored[0] as OnlineEventRecord)).toBeGreaterThan(50);
  });
});
