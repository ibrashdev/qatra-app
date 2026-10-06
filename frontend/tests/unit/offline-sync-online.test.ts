import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { runTx } from "@/lib/offline/db";
import {
  bindOnlineAccount,
  blockOnlineEvents,
  confirmOnlineCompletion,
  countOnlineEvents,
  listOnlineEvents,
  listPendingOnlineCompletions,
  readOnlineRun,
  recordOnlineEvents,
  requestOnlineCompletion,
  saveOnlineRun,
} from "@/lib/offline/online-journal";
import { countOutbox, enqueueEvents } from "@/lib/offline/outbox";
import { logoutLocally, readOwnerState } from "@/lib/offline/owner";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { OfflineSyncController, hasOnlineWork, onlineRunLockName, syncForeground, type SyncRuntimeDeps } from "@/lib/offline/sync";
import type { OnlineBinding, OnlineRunRecord, OnlineSessionKind, SyncStateRecord } from "@/lib/offline/types";
import { DAILY_SESSION, FakeServer, OWNER_ID, USERNAME, ackAll, answerAt, dumpAllStores, envelopeError, fakeClock, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";
import { ONLINE_SESSION, OTHER_ONLINE_SESSION, dumpStore, onlineActivityAt, onlineAnswerAt } from "./offline-online-support";

beforeEach(() => resetOfflineEnvironment());

function deps(server: FakeServer, extra: Partial<SyncRuntimeDeps> = {}): SyncRuntimeDeps {
  const time = fakeClock();
  return { client: server.client(), trigger: "app_open", now: time.now, sleep: time.sleep, isOnline: () => true, ...extra };
}

const sentEvents = (call: { body: unknown } | undefined): SessionEvent[] => (call?.body as { events: SessionEvent[] } | undefined)?.events ?? [];
const eventIds = (call: { body: unknown } | undefined): string[] => sentEvents(call).map((event) => event.clientEventId);
const sequence = (server: FakeServer) => server.calls.map((call) => `${call.method} ${call.path}`);
const eventsPath = (sessionId: string) => `/sessions/${sessionId}/events`;
const completePath = (sessionId: string) => `/sessions/${sessionId}/complete`;
const completeCalls = (server: FakeServer) => server.list("POST /sessions").filter((call) => call.path.endsWith("/complete"));

// A device that only played online: the account is bound (a username-only owner), no plan was ever downloaded.
async function onlineDevice(count = 3, sessionId = ONLINE_SESSION, kind: OnlineSessionKind = "daily"): Promise<{ binding: OnlineBinding; events: SessionEvent[] }> {
  const binding = await bindOnlineAccount(USERNAME);
  const events = Array.from({ length: count }, (_, index) => onlineAnswerAt(index * 1000));
  if (events.length > 0) await recordOnlineEvents(binding, sessionId, kind, events);
  return { binding, events };
}

describe("replaying the online journal (ordinary online sessions)", () => {
  it("does nothing, and asks nobody, when the account is recorded but the journal is empty or holds only blocked events", async () => {
    const { binding, events } = await onlineDevice(1);
    const server = new FakeServer();
    await syncForeground("", deps(server));
    server.calls.length = 0;
    // Everything is acknowledged now: nothing to do. A blocked event is final and is not work.
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "nothing_to_do" });
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(5000)]);
    await blockOnlineEvents(binding.accountKey, (await listOnlineEvents(binding.accountKey)).map((record) => record.clientEventId), "session_closed");
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "nothing_to_do" });
    expect(server.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it("health, then me, then E21 to the original session id with the events as written (no envelope, no E25), and the journal is empty after", async () => {
    const { events, binding } = await onlineDevice(3);
    const server = new FakeServer();
    const after = vi.fn(async () => undefined);
    const result = await syncForeground("", deps(server, { afterReplay: after }));

    expect(sequence(server)).toEqual(["GET /health", "GET /me", `POST ${eventsPath(ONLINE_SESSION)}`]);
    expect(sentEvents(server.list("POST /sessions")[0])).toEqual(events);
    for (const event of sentEvents(server.list("POST /sessions")[0])) {
      expect(Object.keys(event)).not.toEqual(expect.arrayContaining(["clientRunId"]));
      expect(event).not.toHaveProperty("snapshotId");
      expect(event).not.toHaveProperty("localSequence");
      expect(event).not.toHaveProperty("sessionId");
    }
    expect(result).toMatchObject({ outcome: "completed", acknowledgedIds: events.map((event) => event.clientEventId), pendingIds: [], blockedIds: [], completedSessionIds: [] });
    expect(result.daily).toMatchObject({ dailyPercent: 10 });
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ total: 0 });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("sends sessions one after the other and, inside a session, in occurredAt/startedAt order, not insertion order", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const late = onlineAnswerAt(9000);
    const early = onlineAnswerAt(1000);
    const middle = onlineActivityAt(5000);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [late, early, middle]);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", [onlineAnswerAt(100)]);

    const server = new FakeServer();
    await syncForeground("", deps(server));
    const posts = server.list("POST /sessions");
    expect(posts.map((call) => call.path)).toEqual([eventsPath(OTHER_ONLINE_SESSION), eventsPath(ONLINE_SESSION)]);
    expect(eventIds(posts[1])).toEqual([early.clientEventId, middle.clientEventId, late.clientEventId]);
  });

  it("a lost response is repaired by sending the same ids again: the server says duplicate and nothing is left or counted twice", async () => {
    const { events, binding } = await onlineDevice(3);
    const server = new FakeServer();
    const committed = new Set<string>();
    let calls = 0;
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, (call) => {
      calls += 1;
      const ids = eventIds(call);
      if (calls <= 4) {
        // The server stores the events, then the answer is lost (the client retries three times inside one request, all of them lost).
        ids.forEach((id) => committed.add(id));
        throw new TypeError("connection dropped after commit");
      }
      return { body: { ...ackAll(call), acknowledged: ids.filter((id) => !committed.has(id)), duplicate: ids.filter((id) => committed.has(id)) } satisfies EventsResponse };
    });
    const lost = await syncForeground("", deps(server));
    expect(lost.outcome).toBe("server_unreachable");
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ queued: 3 });

    const repaired = await syncForeground("", deps(server));
    expect(repaired).toMatchObject({ outcome: "completed", duplicateIds: events.map((event) => event.clientEventId), acknowledgedIds: [] });
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ total: 0 });
    for (const ids of server.list("POST /sessions").map(eventIds)) expect(ids).toEqual(events.map((event) => event.clientEventId));
  });

  it("503, 429 and a missing answer keep everything for the next sync", async () => {
    const { binding } = await onlineDevice(2);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("unavailable", 503));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "unavailable", acknowledgedIds: [] });
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("throttled", 429, {}, { "Retry-After": "7" }));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "throttled", retryAfterSec: 7 });
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, () => {
      throw new TypeError("offline");
    });
    expect((await syncForeground("", deps(server))).outcome).toBe("server_unreachable");
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ queued: 2, total: 2 });
    server.overrides.clear();
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "completed" });
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ total: 0 });
  });

  it("a stop in one session keeps the others for the next sync", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const first = onlineAnswerAt(100);
    const second = onlineAnswerAt(200);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [first]);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", [second]);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(OTHER_ONLINE_SESSION)}`, envelopeError("unavailable", 503));
    const result = await syncForeground("", deps(server));
    expect(result).toMatchObject({ outcome: "unavailable", acknowledgedIds: [first.clientEventId] });
    expect((await listOnlineEvents(binding.accountKey)).map((record) => record.clientEventId)).toEqual([second.clientEventId]);
  });

  it("pending stays without credit and goes again with the same ids next time; rejected is kept visibly blocked and never sent again", async () => {
    const { events, binding } = await onlineDevice(3);
    const server = new FakeServer();
    let phase = 0;
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, (call) => {
      phase += 1;
      const ids = eventIds(call);
      if (phase === 1) {
        return { body: { ...ackAll(call), acknowledged: [], pending: [{ clientEventId: ids[0] as string, reasonCode: "content_unverifiable" }], rejected: [{ clientEventId: ids[1] as string, code: "session_closed" }, { clientEventId: ids[2] as string, code: "out_of_scope" }] } satisfies EventsResponse };
      }
      return { body: ackAll(call) };
    });
    const first = await syncForeground("", deps(server));
    expect(first).toMatchObject({ outcome: "completed", pendingIds: [events[0]?.clientEventId], blockedIds: [events[1]?.clientEventId, events[2]?.clientEventId], reasonCode: "content_unverifiable" });
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 0, pending: 1, blocked: 2, total: 3 });

    const second = await syncForeground("", deps(server));
    expect(second.acknowledgedIds).toEqual([events[0]?.clientEventId]);
    expect(eventIds(server.list("POST /sessions")[1])).toEqual([events[0]?.clientEventId]);
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 0, pending: 0, blocked: 2, total: 2 });
    await syncForeground("", deps(server));
    expect(server.count("POST /sessions")).toBe(2);
  });

  it("413 halves the batch and sends every event once; a single oversized event is blocked; 422 blocks the batch for good", async () => {
    const { events, binding } = await onlineDevice(5);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, (call) => (eventIds(call).length > 2 ? envelopeError("payload_too_large", 413) : { body: ackAll(call) }));
    const result = await syncForeground("", deps(server));
    expect(result.acknowledgedIds.sort()).toEqual(events.map((event) => event.clientEventId).sort());
    expect(server.list("POST /sessions").map((call) => eventIds(call).length)).toEqual([5, 3, 2, 1, 2]);

    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(70_000)]);
    server.calls.length = 0;
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("payload_too_large", 413));
    const lone = await syncForeground("", deps(server));
    expect(lone.blockedIds).toHaveLength(1);
    expect(await listOnlineEvents(binding.accountKey)).toMatchObject([{ state: "blocked", code: "payload_too_large" }]);

    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(80_000), onlineAnswerAt(81_000)]);
    server.calls.length = 0;
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("validation_error", 422, { fields: [{ field: "events[0].correct", rule: "forbidden_field" }] }));
    expect((await syncForeground("", deps(server))).blockedIds).toHaveLength(2);
    expect(server.count("POST /sessions")).toBe(1);
  });
});

describe("an online session the server no longer has (404 on E21)", () => {
  it("blocks only that session's batch as not_found, drops its owed finish, and still replays and finishes the next session", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const gone = [onlineAnswerAt(100), onlineAnswerAt(150)];
    const alive = [onlineAnswerAt(200)];
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", gone);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", alive);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    await requestOnlineCompletion(binding, OTHER_ONLINE_SESSION, "game", uuid());
    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("not_found", 404));

    const result = await syncForeground("", deps(server));

    expect(result).toMatchObject({
      outcome: "completed",
      blockedIds: gone.map((event) => event.clientEventId),
      acknowledgedIds: alive.map((event) => event.clientEventId),
      completedSessionIds: [OTHER_ONLINE_SESSION],
    });
    // Kept, visible and never resent: the account was confirmed by /api/me, so this is that one session, not another account.
    expect(await listOnlineEvents(binding.accountKey)).toMatchObject([
      { state: "blocked", code: "not_found" },
      { state: "blocked", code: "not_found" },
    ]);
    expect(await listPendingOnlineCompletions(binding.accountKey)).toEqual([]);
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toBeNull();
    expect(server.list(`POST ${completePath(ONLINE_SESSION)}`)).toHaveLength(0);
    expect((await readOwnerState())?.username).toBe(USERNAME);

    server.calls.length = 0;
    expect((await syncForeground("", deps(server))).outcome).toBe("nothing_to_do");
    expect(server.calls).toHaveLength(0);
  });

  it("leaves the rest of that session's batches alone in this sync; they meet the same answer on the next one", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const many = Array.from({ length: 101 }, (_, index) => onlineAnswerAt(index));
    await recordOnlineEvents(binding, ONLINE_SESSION, "game", many);
    const other = onlineAnswerAt(5000);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "daily", [other]);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("not_found", 404));

    const first = await syncForeground("", deps(server));
    expect(first).toMatchObject({ outcome: "completed", acknowledgedIds: [other.clientEventId] });
    expect(first.blockedIds).toHaveLength(100);
    expect(server.count(`POST ${eventsPath(ONLINE_SESSION)}`)).toBe(1);
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 1, pending: 0, blocked: 100, total: 101 });

    const second = await syncForeground("", deps(server));
    expect(second.blockedIds).toHaveLength(1);
    expect(server.count(`POST ${eventsPath(ONLINE_SESSION)}`)).toBe(2);
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 0, pending: 0, blocked: 101, total: 101 });
  });

  it("is also recognised by the error code, and a 404 on the offline outbox is unchanged: an owner mismatch that stops the sync and keeps the journal", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const offline = answerAt(snapshot, uuid(), 0, 0);
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [offline]);
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(DAILY_SESSION)}`, envelopeError("not_found", 404));

    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "owner_mismatch", blockedIds: [] });
    expect(server.count(`POST ${eventsPath(ONLINE_SESSION)}`)).toBe(0);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: 1, blocked: 0 });
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ queued: 1, blocked: 0 });
  });

  it("a 404 for the online session after the offline outbox replayed fine does not stop the sync either", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const offline = answerAt(snapshot, uuid(), 0, 0);
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [offline]);
    const binding = await bindOnlineAccount(USERNAME);
    const online = onlineAnswerAt(0);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [online]);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("not_found", 404));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "completed", acknowledgedIds: [offline.clientEventId], blockedIds: [online.clientEventId] });
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 0 });
  });
});

describe("the account guard also holds for the online journal (G-04)", () => {
  it("another username on the server sends nothing and deletes nothing", async () => {
    const { binding } = await onlineDevice(2);
    const server = new FakeServer();
    server.username = "someone.else";
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "owner_mismatch" });
    expect(server.count("POST")).toBe(0);
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ queued: 2 });
    expect((await readOwnerState())?.username).toBe(USERNAME);
  });

  it("401 on /api/me stops before any event and wipes nothing; the same learner syncs after logging in again", async () => {
    const { binding } = await onlineDevice(2);
    const server = new FakeServer();
    server.on("GET /me", envelopeError("unauthenticated", 401));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "unauthenticated" });
    expect(sequence(server)).toEqual(["GET /health", "GET /me"]);
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ queued: 2 });
    server.overrides.clear();
    expect((await syncForeground("", deps(server))).acknowledgedIds).toHaveLength(2);
  });

  it("a 401 in the middle of the replay stops it, keeps what was not sent and drops what was acknowledged", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const first = onlineAnswerAt(100);
    const second = onlineAnswerAt(200);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [first]);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", [second]);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(OTHER_ONLINE_SESSION)}`, envelopeError("unauthenticated", 401));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "unauthenticated", acknowledgedIds: [first.clientEventId] });
    expect((await listOnlineEvents(binding.accountKey)).map((record) => record.clientEventId)).toEqual([second.clientEventId]);
  });

  it("does not sync, wake or call anything while the browser says it is offline, unless the button was pressed", async () => {
    await onlineDevice(1);
    const server = new FakeServer();
    expect(await syncForeground("", deps(server, { isOnline: () => false }))).toMatchObject({ outcome: "offline" });
    expect(server.calls).toHaveLength(0);
    expect((await syncForeground("", deps(server, { isOnline: () => false, trigger: "manual" }))).outcome).toBe("completed");
  });

  it("a stale controller that still names an ownership id cannot sync a device that has none", async () => {
    await onlineDevice(1);
    const server = new FakeServer();
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "owner_mismatch" });
    expect(server.calls).toHaveLength(0);
  });

  it("the owed server logout still comes first", async () => {
    await onlineDevice(1);
    await logoutLocally({ serverLogoutDone: false });
    const server = new FakeServer();
    expect((await syncForeground("", deps(server))).outcome).toBe("nothing_to_do");
    expect(sequence(server)).toEqual(["GET /health", "POST /auth/logout"]);
  });
});

describe("the offline outbox and the online journal on one device", () => {
  it("replays the outbox first (E25 and its envelope), then the journal (no envelope), and keeps the offline counts offline-only", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const offline = [answerAt(snapshot, uuid(), 0, 0), answerAt(snapshot, uuid(), 1, 1000)];
    await enqueueEvents(OWNER_ID, DAILY_SESSION, offline);
    const binding = await bindOnlineAccount(USERNAME);
    const online = [onlineAnswerAt(-500_000), onlineAnswerAt(-400_000)];
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", online);

    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, (call) => ({ body: { ...ackAll(call), acknowledged: [eventIds(call)[0] as string], rejected: [{ clientEventId: eventIds(call)[1] as string, code: "session_closed" }] } satisfies EventsResponse }));
    const result = await syncForeground("", deps(server));

    expect(sequence(server)).toEqual(["GET /health", "GET /me", "POST /offline/revalidate", `POST ${eventsPath(DAILY_SESSION)}`, `POST ${eventsPath(ONLINE_SESSION)}`]);
    expect(sentEvents(server.list("POST /sessions")[0])).toEqual(offline);
    expect(sentEvents(server.list("POST /sessions")[1])).toEqual(online);
    expect(result).toMatchObject({ outcome: "completed", acknowledgedIds: [...offline.map((event) => event.clientEventId), online[0]?.clientEventId], blockedIds: [online[1]?.clientEventId] });
    // The blocked online event is not in the offline shell's counts.
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 0 });
    expect(((await dumpAllStores()).syncState[0] as SyncStateRecord).counts).toEqual({ queued: 0, pending: 0, blocked: 0, total: 0 });
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ blocked: 1, total: 1 });
  });

  it("a stop in the outbox keeps the journal for the next sync and sends nothing from it", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [answerAt(snapshot, uuid(), 0)]);
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    const server = new FakeServer();
    server.on(`POST ${eventsPath(DAILY_SESSION)}`, envelopeError("unavailable", 503));
    expect((await syncForeground("", deps(server))).outcome).toBe("unavailable");
    expect(server.count(`POST ${eventsPath(ONLINE_SESSION)}`)).toBe(0);
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ queued: 1 });
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: 1 });
  });

  it("a device with a copy and only the journal busy still syncs (the copy has nothing, the journal has work)", async () => {
    await cacheActivePlan(makeSnapshot(), { username: USERNAME });
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "lesson", [onlineActivityAt(0)]);
    const server = new FakeServer();
    expect((await syncForeground("", deps(server))).acknowledgedIds).toHaveLength(1);
  });
});

describe("the finish of an online session (E22) with the stored Idempotency-Key", () => {
  it("is sent once, after the events are acknowledged, with the key stored when the finish was requested, and the run record is deleted", async () => {
    const { binding, events } = await onlineDevice(2);
    await saveOnlineRun(binding, ONLINE_SESSION, "daily", { resumeIndex: 4, planId: "plan-1", planVersion: 2 });
    const key = await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    const server = new FakeServer();
    const result = await syncForeground("", deps(server));

    expect(sequence(server)).toEqual(["GET /health", "GET /me", `POST ${eventsPath(ONLINE_SESSION)}`, `POST ${completePath(ONLINE_SESSION)}`]);
    expect(server.calls.at(-1)).toMatchObject({ body: undefined });
    expect(server.calls.at(-1)?.headers["Idempotency-Key"]).toBe(key);
    expect(result).toMatchObject({ outcome: "completed", acknowledgedIds: events.map((event) => event.clientEventId), completedSessionIds: [ONLINE_SESSION] });
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toBeNull();
    expect(await listPendingOnlineCompletions(binding.accountKey)).toEqual([]);

    // Only once: nothing is left to do.
    server.calls.length = 0;
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "nothing_to_do", completedSessionIds: [] });
    expect(server.calls).toHaveLength(0);
  });

  it("a finish with no events at all is still sent", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const key = await requestOnlineCompletion(binding, ONLINE_SESSION, "lesson", uuid());
    const server = new FakeServer();
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "completed", completedSessionIds: [ONLINE_SESSION] });
    expect(sequence(server)).toEqual(["GET /health", "GET /me", `POST ${completePath(ONLINE_SESSION)}`]);
    expect(completeCalls(server)[0]?.headers["Idempotency-Key"]).toBe(key);
  });

  it("waits while an event of the session is still pending, then sends the finish with the same key; a blocked event does not hold it", async () => {
    const { binding, events } = await onlineDevice(2);
    const key = await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    const server = new FakeServer();
    let phase = 0;
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, (call) => {
      phase += 1;
      if (phase === 1) {
        const ids = eventIds(call);
        return { body: { ...ackAll(call), acknowledged: [], pending: [{ clientEventId: ids[0] as string, reasonCode: "content_unverifiable" }], rejected: [{ clientEventId: ids[1] as string, code: "session_closed" }] } satisfies EventsResponse };
      }
      return { body: ackAll(call) };
    });
    const first = await syncForeground("", deps(server));
    expect(first).toMatchObject({ outcome: "completed", pendingIds: [events[0]?.clientEventId], completedSessionIds: [] });
    expect(completeCalls(server)).toHaveLength(0);
    expect(await listPendingOnlineCompletions(binding.accountKey)).toHaveLength(1);

    const second = await syncForeground("", deps(server));
    expect(second.completedSessionIds).toEqual([ONLINE_SESSION]);
    expect(completeCalls(server).map((call) => call.headers["Idempotency-Key"])).toEqual([key]);
    // The blocked event is final and stays visible; it did not hold the finish.
    expect(await countOnlineEvents(binding.accountKey)).toEqual({ queued: 0, pending: 0, blocked: 1, total: 1 });
  });

  it("503, 429 or a lost answer keeps the owed finish and the identical key for the next attempt", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const key = await requestOnlineCompletion(binding, ONLINE_SESSION, "game", uuid());
    const server = new FakeServer();
    server.on(`POST ${completePath(ONLINE_SESSION)}`, envelopeError("unavailable", 503));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "unavailable", completedSessionIds: [] });
    server.on(`POST ${completePath(ONLINE_SESSION)}`, envelopeError("throttled", 429, {}, { "Retry-After": "3" }));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "throttled", retryAfterSec: 3 });
    server.on(`POST ${completePath(ONLINE_SESSION)}`, () => {
      throw new TypeError("lost");
    });
    expect((await syncForeground("", deps(server))).outcome).toBe("server_unreachable");
    expect(await listPendingOnlineCompletions(binding.accountKey)).toMatchObject([{ sessionId: ONLINE_SESSION, idempotencyKey: key }]);
    expect(completeCalls(server).every((call) => call.headers["Idempotency-Key"] === key)).toBe(true);

    server.overrides.clear();
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "completed", completedSessionIds: [ONLINE_SESSION] });
    expect(completeCalls(server).at(-1)?.headers["Idempotency-Key"]).toBe(key);
  });

  it("an answer other than 401, 429 or 503 is final: the owed finish is dropped, not retried for ever, and is not reported as completed", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    const server = new FakeServer();
    server.on(`POST ${completePath(ONLINE_SESSION)}`, envelopeError("not_found", 404));
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "completed", completedSessionIds: [] });
    expect(await listPendingOnlineCompletions(binding.accountKey)).toEqual([]);
    expect(await readOnlineRun(binding.accountKey, ONLINE_SESSION)).toBeNull();
    server.calls.length = 0;
    expect((await syncForeground("", deps(server))).outcome).toBe("nothing_to_do");
  });

  it("a 401 on the finish stops with unauthenticated and keeps the record", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    const server = new FakeServer();
    server.on(`POST ${completePath(ONLINE_SESSION)}`, envelopeError("unauthenticated", 401));
    expect((await syncForeground("", deps(server))).outcome).toBe("unauthenticated");
    expect(await listPendingOnlineCompletions(binding.accountKey)).toHaveLength(1);
  });

  it("finishes several sessions in the order they were requested", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await requestOnlineCompletion(binding, OTHER_ONLINE_SESSION, "game", uuid());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    const server = new FakeServer();
    const result = await syncForeground("", deps(server));
    expect(result.completedSessionIds).toEqual([OTHER_ONLINE_SESSION, ONLINE_SESSION]);
  });

  it("confirming by hand (the screen finished it itself) leaves nothing for the sync to send", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    await confirmOnlineCompletion(binding.accountKey, ONLINE_SESSION);
    const server = new FakeServer();
    expect((await syncForeground("", deps(server))).outcome).toBe("nothing_to_do");
    expect(server.calls).toHaveLength(0);
  });
});

describe("a live tab keeps its session (the Web Lock qatra-online-run:<sessionId>)", () => {
  it("names the lock after the session", () => {
    expect(onlineRunLockName(ONLINE_SESSION)).toBe(`qatra-online-run:${ONLINE_SESSION}`);
  });

  function lockManager(taken: readonly string[]) {
    const request = vi.fn(async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback(taken.includes(name) ? null : { name }));
    return { request, locks: { request } as never };
  }

  it("skips a session whose lock is taken, sends the others, and does not finish the skipped one", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const live = onlineAnswerAt(100);
    const other = onlineAnswerAt(200);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [live]);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", [other]);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    await requestOnlineCompletion(binding, OTHER_ONLINE_SESSION, "game", uuid());
    const { request, locks } = lockManager([onlineRunLockName(ONLINE_SESSION)]);
    const server = new FakeServer();

    const result = await syncForeground("", deps(server, { locks }));

    expect(server.list("POST /sessions").map((call) => call.path)).toEqual([eventsPath(OTHER_ONLINE_SESSION), completePath(OTHER_ONLINE_SESSION)]);
    expect(result).toMatchObject({ outcome: "completed", acknowledgedIds: [other.clientEventId], completedSessionIds: [OTHER_ONLINE_SESSION] });
    expect((await listOnlineEvents(binding.accountKey)).map((record) => record.clientEventId)).toEqual([live.clientEventId]);
    expect((await listPendingOnlineCompletions(binding.accountKey)).map((entry) => entry.sessionId)).toEqual([ONLINE_SESSION]);
    // Probed without waiting, once per session.
    const probes = request.mock.calls.filter(([name]) => name.startsWith("qatra-online-run:"));
    expect(probes.map(([name]) => name).sort()).toEqual([onlineRunLockName(ONLINE_SESSION), onlineRunLockName(OTHER_ONLINE_SESSION)].sort());
    expect(probes.every(([, options]) => (options as { ifAvailable?: boolean }).ifAvailable === true)).toBe(true);
  });

  it("sends the session after the live tab let go of the lock", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    const live = onlineAnswerAt(100);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [live]);
    const server = new FakeServer();
    await syncForeground("", deps(server, { locks: lockManager([onlineRunLockName(ONLINE_SESSION)]).locks }));
    expect(server.count("POST /sessions")).toBe(0);
    expect((await syncForeground("", deps(server, { locks: lockManager([]).locks }))).acknowledgedIds).toEqual([live.clientEventId]);
  });

  it("without the Locks API nothing is skipped (a duplicate is harmless), and a lock manager that throws does not hold the session either", async () => {
    const { binding } = await onlineDevice(1);
    const server = new FakeServer();
    expect((await syncForeground("", deps(server, { locks: null }))).acknowledgedIds).toHaveLength(1);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(9000)]);
    const throwing = { request: async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
      if (name.startsWith("qatra-online-run:")) throw new DOMException("denied", "SecurityError");
      return callback({ name });
    } };
    expect((await syncForeground("", deps(server, { locks: throwing as never }))).acknowledgedIds).toHaveLength(1);
  });
});

describe("housekeeping and the state the screens read", () => {
  it("removes run records nobody needs any more after a completed sync, and keeps the ones that are needed", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await saveOnlineRun(binding, "idle-old", "daily", { resumeIndex: 3 });
    await saveOnlineRun(binding, "idle-fresh", "daily", { resumeIndex: 3 });
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    await runTx(["onlineRuns"], "readwrite", async (ctx) => {
      const run = await ctx.get<OnlineRunRecord>("onlineRuns", "idle-old");
      await ctx.put("onlineRuns", { ...(run as OnlineRunRecord), updatedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
    });
    const server = new FakeServer();
    await syncForeground("", deps(server, { now: Date.now }));
    expect(((await dumpStore("onlineRuns")) as OnlineRunRecord[]).map((run) => run.sessionId)).toEqual(["idle-fresh"]);
  });

  it("a stopped sync prunes nothing", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await saveOnlineRun(binding, "idle-old", "daily", { resumeIndex: 3 });
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    await runTx(["onlineRuns"], "readwrite", async (ctx) => {
      const run = await ctx.get<OnlineRunRecord>("onlineRuns", "idle-old");
      await ctx.put("onlineRuns", { ...(run as OnlineRunRecord), updatedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
    });
    const server = new FakeServer();
    server.on(`POST ${eventsPath(ONLINE_SESSION)}`, envelopeError("unavailable", 503));
    await syncForeground("", deps(server, { now: Date.now }));
    expect(await dumpStore("onlineRuns")).toHaveLength(1);
  });

  it("hasOnlineWork is a cheap read: false with nothing, for blocked events only, and when storage fails; true for unsent events or an owed finish", async () => {
    expect(await hasOnlineWork()).toBe(false);
    const { binding } = await onlineDevice(1);
    expect(await hasOnlineWork()).toBe(true);
    await syncForeground("", deps(new FakeServer()));
    expect(await hasOnlineWork()).toBe(false);
    await requestOnlineCompletion(binding, ONLINE_SESSION, "daily", uuid());
    expect(await hasOnlineWork()).toBe(true);
    await confirmOnlineCompletion(binding.accountKey, ONLINE_SESSION);
    expect(await hasOnlineWork()).toBe(false);
    const { closeOfflineDb } = await import("@/lib/offline/db");
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    closeOfflineDb();
    expect(await hasOnlineWork()).toBe(false);
  });

  it("the controller that the screens read syncs a device that only has the journal, with a plain 'completed' result", async () => {
    await onlineDevice(2);
    const server = new FakeServer();
    const controller = new OfflineSyncController({ deps: () => deps(server) });
    const result = await controller.run("reconnect");
    expect(result).toMatchObject({ outcome: "completed", completedSessionIds: [] });
    expect(result.acknowledgedIds).toHaveLength(2);
    expect(controller.getState()).toMatchObject({ phase: "done", trigger: "reconnect" });
  });

  it("takes the last authoritative daily figure of the replay", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0)]);
    await recordOnlineEvents(binding, OTHER_ONLINE_SESSION, "game", [onlineAnswerAt(10_000)]);
    const server = new FakeServer();
    let calls = 0;
    server.on("re:^POST /sessions/[^/]+/events$", (call) => {
      calls += 1;
      return { body: { ...ackAll(call), daily: { ...ackAll(call).daily, dailyPercent: calls * 10 } } };
    });
    expect((await syncForeground("", deps(server))).daily).toMatchObject({ dailyPercent: 20 });
  });
});
