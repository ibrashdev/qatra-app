import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BINDING_WAIT_MS, DurableOnlineQueue, readSessionJournal, resolveOnlineBinding, type DurableOnlineQueueOptions } from "@/components/session/durable-online-queue";
import { ConnectivityError } from "@/lib/api/errors";
import { LOCK_MARKER_KEY } from "@/lib/offline/db";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { bindOnlineAccount, listOnlineEvents, readOnlineRun, recordOnlineEvents, saveOnlineRun } from "@/lib/offline/online-journal";
import type { OnlineAnswered, OnlineBinding } from "@/lib/offline/types";
import { logoutLocally } from "@/lib/offline/owner";
import { USERNAME, profile, resetOfflineEnvironment } from "./offline-support";
import { ONLINE_SESSION, eventsResponse, onlineActivityAt, onlineAnswerAt } from "./offline-online-support";

beforeEach(() => resetOfflineEnvironment());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ack = (events: readonly SessionEvent[], extra: Partial<EventsResponse> = {}): EventsResponse => eventsResponse({ acknowledged: events.map((event) => event.clientEventId), ...extra });
const ids = (events: readonly SessionEvent[]): string[] => events.map((event) => event.clientEventId);

interface Harness {
  queue: DurableOnlineQueue;
  binding: OnlineBinding;
  sent: SessionEvent[][];
}

// A queue on a device whose account is recorded: the journal is the real one (fake IndexedDB), the server is whatever `send` says.
async function makeQueue(send?: (events: SessionEvent[], call: number) => Promise<EventsResponse>, extra: Partial<DurableOnlineQueueOptions> = {}): Promise<Harness> {
  const binding = await bindOnlineAccount(USERNAME);
  const sent: SessionEvent[][] = [];
  const queue = new DurableOnlineQueue({
    sessionId: ONLINE_SESSION,
    kind: "daily",
    send: async (events) => {
      sent.push(events);
      return send === undefined ? ack(events) : send(events, sent.length);
    },
    resolveBinding: async () => binding,
    ...extra,
  });
  await queue.start();
  return { queue, binding, sent };
}

describe("the durable online queue: write first, then count", () => {
  it("resolves enqueue only after the event is committed, and the event reaches the sending queue only after that", async () => {
    const { queue, binding, sent } = await makeQueue();
    expect(queue.mode).toBe("durable");
    const event = onlineAnswerAt(0);
    await queue.enqueue(event);
    // Committed to the journal as `queued`, with the original session id and no envelope.
    const records = await listOnlineEvents(binding.accountKey, { sessionId: ONLINE_SESSION });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ clientEventId: event.clientEventId, state: "queued", sessionId: ONLINE_SESSION, kind: "daily" });
    expect(records[0]?.event).toEqual(event);
    expect(sent).toHaveLength(0);
    expect(queue.size).toBe(1);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(ids(sent.flat())).toEqual([event.clientEventId]);
  });

  it("does not hand the event to the sender while its write is still running", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { queue, sent } = await makeQueue(undefined, {
      store: {
        record: async (...args) => {
          await gate;
          return recordOnlineEvents(...args);
        },
      },
    });
    const event = onlineAnswerAt(0);
    const stored = queue.enqueue(event);
    const flushing = queue.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
    expect(queue.size).toBe(1);
    release?.();
    await stored;
    expect(await flushing).toEqual({ ok: true });
    expect(ids(sent.flat())).toEqual([event.clientEventId]);
  });

  it("keeps the order events were enqueued in, whatever order the writes finish in", async () => {
    let call = 0;
    const { queue, sent } = await makeQueue(undefined, {
      store: {
        // The first write is the slowest one.
        record: async (...args) => {
          call += 1;
          if (call === 1) await new Promise((resolve) => setTimeout(resolve, 30));
          return recordOnlineEvents(...args);
        },
      },
    });
    const events = [onlineAnswerAt(0), onlineActivityAt(1000), onlineAnswerAt(2000)];
    for (const event of events) void queue.enqueue(event);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(ids(sent.flat())).toEqual(ids(events));
  });

  it("falls back to the page's memory on a failed write, says so, keeps sending, and stops writing", async () => {
    const record = vi.fn(async () => {
      throw new Error("quota");
    });
    const { queue, sent, binding } = await makeQueue(undefined, { store: { record } });
    const seen: string[] = [];
    queue.subscribe(() => seen.push(`${queue.mode}:${queue.storageProblem}`));
    const first = onlineAnswerAt(0);
    const second = onlineAnswerAt(1000);
    // enqueue still resolves: an online session keeps working.
    await expect(queue.enqueue(first)).resolves.toBeUndefined();
    expect(queue.mode).toBe("memory");
    expect(queue.storageProblem).toBe(true);
    void queue.enqueue(second);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(ids(sent.flat())).toEqual([first.clientEventId, second.clientEventId]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["memory:true"]);
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0);
  });

  it("is a plain synchronous page-memory queue where the device has no storage", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const sent: SessionEvent[][] = [];
    const queue = new DurableOnlineQueue({ sessionId: ONLINE_SESSION, kind: "game", send: async (events) => (sent.push(events), ack(events)), resolveBinding: async () => null });
    expect(queue.mode).toBe("memory");
    expect(queue.storageProblem).toBe(false);
    const event = onlineAnswerAt(0);
    expect(queue.enqueue(event)).toBeUndefined();
    expect(queue.size).toBe(1);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(ids(sent.flat())).toEqual([event.clientEventId]);
  });

  it("goes on in memory, without a storage problem, when the account is not known", async () => {
    const sent: SessionEvent[][] = [];
    const queue = new DurableOnlineQueue({ sessionId: ONLINE_SESSION, kind: "daily", send: async (events) => (sent.push(events), ack(events)), resolveBinding: async () => null });
    expect(queue.mode).toBe("binding");
    await queue.enqueue(onlineAnswerAt(0));
    expect(queue.mode).toBe("memory");
    expect(queue.storageProblem).toBe(false);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it("does not let an answer wait for ever for the account: after the wait it goes on in memory", async () => {
    vi.useFakeTimers();
    const queue = new DurableOnlineQueue({ sessionId: ONLINE_SESSION, kind: "daily", send: async (events) => ack(events), resolveBinding: () => new Promise<OnlineBinding | null>(() => undefined) });
    void queue.start();
    const stored = queue.enqueue(onlineAnswerAt(0)) as Promise<void>;
    let settled = false;
    void stored.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(BINDING_WAIT_MS - 10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(true);
    expect(queue.mode).toBe("memory");
    expect(queue.size).toBe(1);
  });
});

describe("the durable online queue: the journal follows the server's answers", () => {
  it("leaves the journal untouched after a failed send, sends the same ids again, and settles it when the server says duplicate", async () => {
    let attempt = 0;
    const { queue, binding, sent } = await makeQueue(async (events) => {
      attempt += 1;
      if (attempt === 1) throw new ConnectivityError("network");
      // The first answer was lost after the server stored the events: the resend comes back as duplicate.
      return eventsResponse({ duplicate: ids(events) });
    });
    const events = [onlineAnswerAt(0), onlineActivityAt(1000)];
    for (const event of events) await queue.enqueue(event);
    const failed = await queue.flush();
    expect(failed.ok).toBe(false);
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(2);
    expect(queue.size).toBe(2);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(sent.map(ids)).toEqual([ids(events), ids(events)]);
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0);
    expect(queue.size).toBe(0);
  });

  it("settles a 200 like the foreground sync: acknowledged leaves, pending stays without credit, rejected is kept as blocked", async () => {
    const events = [onlineAnswerAt(0), onlineAnswerAt(1000), onlineAnswerAt(2000)];
    const { queue, binding } = await makeQueue(async () =>
      eventsResponse({
        acknowledged: [events[0]?.clientEventId ?? ""],
        pending: [{ clientEventId: events[1]?.clientEventId ?? "", reasonCode: "content_unverifiable" }],
        rejected: [{ clientEventId: events[2]?.clientEventId ?? "", code: "out_of_scope" }],
      }),
    );
    for (const event of events) await queue.enqueue(event);
    const handler = vi.fn();
    queue.setResponseHandler(handler);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const left = await listOnlineEvents(binding.accountKey);
    expect(left.map((record) => [record.clientEventId, record.state, record.reasonCode ?? record.code])).toEqual([
      [events[1]?.clientEventId, "pending", "content_unverifiable"],
      [events[2]?.clientEventId, "blocked", "out_of_scope"],
    ]);
    // The screen was told once; the queue does not hold them any more.
    expect(queue.size).toBe(0);
  });

  it("still settles an event whose write succeeded after a later write failed", async () => {
    let call = 0;
    const { queue, binding } = await makeQueue(undefined, {
      store: {
        record: async (...args) => {
          call += 1;
          if (call === 2) throw new Error("quota");
          return recordOnlineEvents(...args);
        },
      },
    });
    await queue.enqueue(onlineAnswerAt(0));
    await queue.enqueue(onlineAnswerAt(1000));
    expect(queue.storageProblem).toBe(true);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0);
  });
});

describe("the durable online queue: account isolation", () => {
  it("never writes into the journal of another account after the account changed under a running page", async () => {
    const { queue } = await makeQueue();
    await queue.enqueue(onlineAnswerAt(0));
    expect(queue.mode).toBe("durable");
    // The learner signs out in another tab and someone else signs in on this device.
    await logoutLocally({ serverLogoutDone: true });
    const other = await bindOnlineAccount("another.learner");
    await expect(queue.enqueue(onlineAnswerAt(1000))).resolves.toBeUndefined();
    // The write was refused (the binding is stale), the page says so and carries the event in memory; nothing reached the new journal.
    expect(queue.storageProblem).toBe(true);
    expect(await listOnlineEvents(other.accountKey)).toHaveLength(0);
    expect(queue.size).toBe(2);
  });
});

describe("the durable online queue: after a reload", () => {
  it("takes the queued records of its session back without writing them again, in the order given, and leaves pending and blocked ones to the sync", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const events = [onlineAnswerAt(0), onlineActivityAt(1000), onlineAnswerAt(2000)];
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", events);
    await recordOnlineEvents(binding, "another-session", "daily", [onlineAnswerAt(3000)]);
    const mine = await listOnlineEvents(binding.accountKey, { sessionId: ONLINE_SESSION });
    const other = await listOnlineEvents(binding.accountKey, { sessionId: "another-session" });
    const record = vi.fn();
    const sent: SessionEvent[][] = [];
    const queue = new DurableOnlineQueue({
      sessionId: ONLINE_SESSION,
      kind: "daily",
      send: async (batch) => (sent.push(batch), ack(batch)),
      resolveBinding: async () => binding,
      store: { record },
    });
    expect(mine).toHaveLength(3);
    const [pendingOne, second, third] = mine;
    if (pendingOne === undefined || second === undefined || third === undefined) throw new Error("three records expected");
    // The first was left `pending` by an earlier page: the sync owns it. The other session record is not this queue's.
    queue.restore([{ ...pendingOne, state: "pending" }, second, third, ...other]);
    expect(queue.size).toBe(2);
    await queue.start();
    expect(await queue.flush()).toEqual({ ok: true });
    expect(record).not.toHaveBeenCalled();
    expect(ids(sent.flat())).toEqual([second.clientEventId, third.clientEventId]);
    // The ones it sent are settled; the held one and the other session event are untouched.
    const rest = await listOnlineEvents(binding.accountKey);
    expect(rest.map((entry) => entry.clientEventId).sort()).toEqual([pendingOne.clientEventId, ...other.map((entry) => entry.clientEventId)].sort());
  });

  it("reads the journal of a session without asking the server for the account, and reads nothing for another session", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    await saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: 3, planVersion: 2 });
    const journal = await readSessionJournal(ONLINE_SESSION);
    expect(journal.accountKey).toBe(binding.accountKey);
    expect(journal.run).toMatchObject({ resumeIndex: 3, planVersion: 2, completion: null });
    expect(journal.queued).toHaveLength(1);
    const other = await readSessionJournal("55555555-5555-4555-8555-555555555599");
    expect(other).toMatchObject({ run: null, queued: [] });
  });

  it("reads as empty where no account is recorded or there is no storage", async () => {
    expect(await readSessionJournal(ONLINE_SESSION)).toMatchObject({ accountKey: null, run: null, queued: [] });
    vi.stubGlobal("indexedDB", undefined);
    expect(await readSessionJournal(ONLINE_SESSION)).toMatchObject({ accountKey: null, run: null, queued: [] });
  });
});

describe("the durable online queue: the finish that is owed", () => {
  it("records the finish once and returns the identical key to every attempt, also after a reload", async () => {
    const { queue, binding } = await makeQueue();
    const first = await queue.requestCompletion("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    expect(first).toEqual({ key: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", durable: true });
    const again = await queue.requestCompletion("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
    expect(again).toEqual({ key: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", durable: true });
    // A new page of the same session finds the same key.
    const reloaded = new DurableOnlineQueue({ sessionId: ONLINE_SESSION, kind: "daily", send: async (events) => ack(events), resolveBinding: async () => binding });
    expect(await reloaded.requestCompletion("cccccccc-3333-4333-8333-cccccccccccc")).toEqual({ key: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", durable: true });
    await reloaded.confirmCompletion();
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toBeNull();
  });

  it("gives the page's own key and says it is not recorded where nothing can be stored", async () => {
    const queue = new DurableOnlineQueue({ sessionId: ONLINE_SESSION, kind: "game", send: async (events) => ack(events), resolveBinding: async () => null });
    expect(await queue.requestCompletion("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa")).toEqual({ key: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", durable: false });
  });

  it("saves where the run resumes, and never keeps a typed answer", async () => {
    const { queue, binding } = await makeQueue();
    // A caller that slips the typed text into the object must not get it stored.
    const sloppy = { clientEventId: "aaaaaaaa-0000-4000-8000-000000000001", hintUsed: false, result: { correct: true, assisted: false, expected: { optionId: "o" }, typed: "secret text" } } as unknown as OnlineAnswered;
    await queue.saveRun({ resumeIndex: 4, planId: "plan-1", planVersion: 1, answered: { "q-1": sloppy } });
    const run = await readOnlineRun(binding.accountKey, ONLINE_SESSION);
    expect(run).toMatchObject({ resumeIndex: 4, planId: "plan-1", planVersion: 1 });
    expect(JSON.stringify(run)).not.toContain("secret text");
  });
});

describe("resolveOnlineBinding", () => {
  it("uses the account already recorded and asks nobody", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const me = vi.fn(async () => profile("someone.else"));
    expect(await resolveOnlineBinding({ me })).toEqual(binding);
    expect(me).not.toHaveBeenCalled();
  });

  it("asks E11 once for a device that has no account recorded, and binds the answer", async () => {
    const me = vi.fn(async () => profile("New.Learner "));
    const binding = await resolveOnlineBinding({ me });
    expect(me).toHaveBeenCalledTimes(1);
    expect(binding).toMatchObject({ accountKey: "new.learner" });
    expect(await resolveOnlineBinding({ me })).toEqual(binding);
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("is null, without a request, while the browser is offline, and null when E11 fails or the view is locked", async () => {
    const me = vi.fn(async () => profile());
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(await resolveOnlineBinding({ me })).toBeNull();
    expect(me).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    expect(await resolveOnlineBinding({ me: async () => Promise.reject(new ConnectivityError("network")) })).toBeNull();
    // A failed clear keeps the personal view locked: no account is bound even when E11 answers.
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    expect(await resolveOnlineBinding({ me })).toBeNull();
  });

  it("is null where there is no storage", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const me = vi.fn(async () => profile());
    expect(await resolveOnlineBinding({ me })).toBeNull();
    expect(me).not.toHaveBeenCalled();
  });
});
