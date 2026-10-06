import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { completeSession } from "@/lib/api/session-endpoints";
import { applyEventsResponse, countOutbox, enqueueEvents, listPendingEvents } from "@/lib/offline/outbox";
import { logoutLocally, readOwnerState } from "@/lib/offline/owner";
import { cacheActivePlan, inspectLocalPlan, readReadyPlan } from "@/lib/offline/plan-cache";
import { finishRun, startRun } from "@/lib/offline/run-store";
import { OfflineSyncController, syncForeground, type SyncRuntimeDeps } from "@/lib/offline/sync";
import type { OwnerState, SyncProgress, SyncStateRecord } from "@/lib/offline/types";
import {
  DAILY_SESSION,
  FakeServer,
  GAME_SESSION,
  OWNER_ID,
  USERNAME,
  activityAt,
  answerAt,
  ackAll,
  choiceQuestion,
  dumpAllStores,
  envelopeError,
  fakeClock,
  makeSnapshot,
  preparedSession,
  resetOfflineEnvironment,
  uuid,
} from "./offline-support";

beforeEach(() => resetOfflineEnvironment());

function deps(server: FakeServer, extra: Partial<SyncRuntimeDeps> = {}): SyncRuntimeDeps {
  const time = fakeClock();
  return { client: server.client(), trigger: "app_open", now: time.now, sleep: time.sleep, isOnline: () => true, ...extra };
}

async function device(count = 3, sessionId = DAILY_SESSION) {
  const snapshot = makeSnapshot();
  await cacheActivePlan(snapshot, { username: USERNAME });
  const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId, kind: "daily" });
  const events = Array.from({ length: count }, (_, index) => answerAt(snapshot, run.clientRunId, index, index * 1000));
  if (events.length > 0) await enqueueEvents(OWNER_ID, sessionId, events);
  return { snapshot, run, events };
}

const eventIds = (call: { body: unknown } | undefined): string[] => ((call?.body as { events: SessionEvent[] } | undefined)?.events ?? []).map((event) => event.clientEventId);
const sequence = (server: FakeServer) => server.calls.map((call) => `${call.method} ${call.path}`);

describe("the foreground order (offline-spec 2.6)", () => {
  it("does nothing, and asks nobody, when there is nothing on the device", async () => {
    const server = new FakeServer();
    expect(await syncForeground("", deps(server))).toMatchObject({ outcome: "nothing_to_do" });
    expect(server.calls).toHaveLength(0);
  });

  it("health, then me, then E25 for the snapshot, then E21 with the original envelope, then the outbox is empty", async () => {
    const { events, snapshot } = await device(3);
    const server = new FakeServer();
    const after = vi.fn(async () => undefined);
    const result = await syncForeground(OWNER_ID, deps(server, { afterReplay: after }));

    expect(sequence(server)).toEqual(["GET /health", "GET /me", "POST /offline/revalidate", `POST /sessions/${DAILY_SESSION}/events`]);
    expect(server.list("POST /offline/revalidate")[0]?.body).toEqual({ snapshotId: snapshot.snapshotId, expectedPlanVersion: 1, editionId: snapshot.editionId, bankVersion: 3 });
    const sent = (server.list("POST /sessions")[0]?.body as { events: SessionEvent[] }).events;
    expect(sent).toEqual(events);
    expect(sent.every((event) => (event as { snapshotId?: string }).snapshotId === snapshot.snapshotId)).toBe(true);
    expect(result).toMatchObject({ outcome: "completed", acknowledgedIds: events.map((e) => e.clientEventId), pendingIds: [], blockedIds: [] });
    expect(result.daily).toMatchObject({ dailyPercent: 10 });
    expect(result.revalidations).toMatchObject([{ status: "available", reasonCode: "current" }]);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 0 });
    expect(after).toHaveBeenCalledTimes(1);
    const sync = (await dumpAllStores()).syncState[0] as SyncStateRecord;
    expect(sync).toMatchObject({ lastSyncOutcome: "completed", counts: { total: 0 } });
    expect(sync.lastSyncAt).not.toBeNull();
  });

  it("sends sessions one after the other and, inside a session, in occurredAt order, not insertion order", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const run = uuid();
    const late = answerAt(snapshot, run, 0, 9000);
    const early = answerAt(snapshot, run, 1, 1000);
    const middle = activityAt(snapshot, run, 2, 5000);
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [late, early, middle]);
    await enqueueEvents(OWNER_ID, GAME_SESSION, [answerAt(snapshot, uuid(), 0, 100)]);

    const server = new FakeServer();
    await syncForeground(OWNER_ID, deps(server));

    const posts = server.list("POST /sessions");
    expect(posts.map((call) => call.path)).toEqual([`/sessions/${GAME_SESSION}/events`, `/sessions/${DAILY_SESSION}/events`]);
    expect(eventIds(posts[1])).toEqual([early.clientEventId, middle.clientEventId, late.clientEventId]);
  });

  it("does not wake or call anything while the browser says it is offline, unless the button was pressed", async () => {
    await device(2);
    const server = new FakeServer();
    expect(await syncForeground(OWNER_ID, deps(server, { isOnline: () => false }))).toMatchObject({ outcome: "offline" });
    expect(server.calls).toHaveLength(0);
    expect((await syncForeground(OWNER_ID, deps(server, { isOnline: () => false, trigger: "manual" }))).outcome).toBe("completed");
  });

  it("only the device owner may sync", async () => {
    await device(1);
    const server = new FakeServer();
    expect(await syncForeground("99999999-9999-4999-8999-999999999999", deps(server))).toMatchObject({ outcome: "owner_mismatch" });
    expect(server.calls).toHaveLength(0);
  });
});

describe("401, owner mismatch and 404 stop the replay without wiping anything (G-04)", () => {
  it("401 on /api/me stops before E25 and E21; the copy and the outbox are untouched", async () => {
    const { events } = await device(2);
    const server = new FakeServer();
    server.on("GET /me", envelopeError("unauthenticated", 401));
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "unauthenticated" });
    expect(sequence(server)).toEqual(["GET /health", "GET /me"]);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: events.length });
    expect(await readReadyPlan(OWNER_ID)).not.toBeNull();
  });

  it("another username on the server blocks the sync and keeps the copy for the explicit clear-and-continue", async () => {
    await device(2);
    const server = new FakeServer();
    server.username = "someone.else";
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "owner_mismatch" });
    expect(server.count("POST")).toBe(0);
    expect(await readReadyPlan(OWNER_ID)).not.toBeNull();
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 2 });
  });

  it("a 404 from E25 (the snapshot is not this account's) is an owner mismatch and sends nothing", async () => {
    await device(2);
    const server = new FakeServer();
    server.on("POST /offline/revalidate", envelopeError("not_found", 404));
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "owner_mismatch" });
    expect(server.count("POST /sessions")).toBe(0);
  });

  it("a 401 in the middle of the replay stops it, keeps what was not sent and drops what was acknowledged", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const first = answerAt(snapshot, uuid(), 0, 100);
    const second = answerAt(snapshot, uuid(), 0, 200);
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [first]);
    await enqueueEvents(OWNER_ID, GAME_SESSION, [second]);
    const server = new FakeServer();
    server.on(`POST /sessions/${GAME_SESSION}/events`, envelopeError("unauthenticated", 401));
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result).toMatchObject({ outcome: "unauthenticated", acknowledgedIds: [first.clientEventId] });
    expect((await listPendingEvents(OWNER_ID)).map((e) => e.clientEventId)).toEqual([second.clientEventId]);
    expect(await readReadyPlan(OWNER_ID)).not.toBeNull();
  });
});

describe("E25 statuses (D58, D59, G-05, G-06)", () => {
  it("stale blocks new runs but the old events are still replayed under their original plan version", async () => {
    const { events } = await device(2);
    const server = new FakeServer();
    server.on("POST /offline/revalidate", { body: { status: "stale", currentPlanVersion: 2, allowedSessionRefs: [], catalogVersion: 3, reasonCode: "plan_version_changed" } });
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => ({
      body: { ...ackAll(call), acknowledged: [], pending: eventIds(call).map((clientEventId) => ({ clientEventId, reasonCode: "plan_changed_unverifiable" })) } satisfies EventsResponse,
    }));
    const result = await syncForeground(OWNER_ID, deps(server));

    expect(result.revalidations).toMatchObject([{ status: "stale", reasonCode: "plan_version_changed" }]);
    expect(result.outcome).toBe("completed");
    expect(result.pendingIds).toEqual(events.map((e) => e.clientEventId));
    expect(result.reasonCode).toBe("plan_changed_unverifiable");
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect(await inspectLocalPlan()).toMatchObject({ status: "stale", counts: { pending: 2, total: 2 } });
    // Kept with their own envelope, never re-attributed to a newer plan version.
    for (const stored of await listPendingEvents(OWNER_ID)) expect(stored.event).toMatchObject({ planVersion: 1, snapshotId: events[0]?.snapshotId });
  });

  it("revoked deletes the material, blocks the unsent events and sends nothing, so no blocked text leaves the device", async () => {
    await device(3);
    const server = new FakeServer();
    server.on("POST /offline/revalidate", { body: { status: "revoked", currentPlanVersion: 1, allowedSessionRefs: [], catalogVersion: 4, reasonCode: "content_revoked" } });
    const result = await syncForeground(OWNER_ID, deps(server));

    expect(server.count("POST /sessions")).toBe(0);
    expect(result.outcome).toBe("completed");
    expect(await inspectLocalPlan()).toMatchObject({ status: "revoked", snapshot: null, counts: { blocked: 3, queued: 0 } });
    const dump = await dumpAllStores();
    expect(dump.planSnapshots).toEqual([]);
    expect(await listPendingEvents(OWNER_ID)).toHaveLength(3);
    expect((await listPendingEvents(OWNER_ID)).every((e) => e.state === "blocked" && e.code === "content_revoked")).toBe(true);
  });

  it("a 422 snapshot_mismatch marks the local snapshot unusable but deletes nothing", async () => {
    await device(1);
    const server = new FakeServer();
    server.on("POST /offline/revalidate", envelopeError("validation_error", 422, { fields: [{ field: "snapshotId", rule: "snapshot_mismatch" }] }));
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result.revalidations).toMatchObject([{ status: "stale", reasonCode: "snapshot_mismatch" }]);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 0 });
  });
});

describe("per-event outcomes (API-spec E21)", () => {
  it("pending stays without credit, is not resent in the same run and is resent with the same ids on the next sync", async () => {
    const { events } = await device(2);
    const server = new FakeServer();
    let phase = 0;
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => {
      phase += 1;
      if (phase === 1) {
        return { body: { ...ackAll(call), acknowledged: [], pending: eventIds(call).map((clientEventId) => ({ clientEventId, reasonCode: "plan_changed_unverifiable" })) } satisfies EventsResponse };
      }
      return { body: ackAll(call) };
    });
    const first = await syncForeground(OWNER_ID, deps(server));
    expect(first.pendingIds).toHaveLength(2);
    expect(server.count("POST /sessions")).toBe(1);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ pending: 2 });

    const second = await syncForeground(OWNER_ID, deps(server));
    expect(second.acknowledgedIds).toEqual(events.map((e) => e.clientEventId));
    expect(eventIds(server.list("POST /sessions")[1])).toEqual(events.map((e) => e.clientEventId));
  });

  it("a rejected event is kept visibly as blocked and is never sent again", async () => {
    const { events } = await device(2);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => ({
      body: { ...ackAll(call), acknowledged: [events[0]?.clientEventId as string], rejected: [{ clientEventId: events[1]?.clientEventId as string, code: "edition_mismatch" }] } satisfies EventsResponse,
    }));
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result).toMatchObject({ acknowledgedIds: [events[0]?.clientEventId], blockedIds: [events[1]?.clientEventId] });
    expect(await listPendingEvents(OWNER_ID)).toMatchObject([{ state: "blocked", code: "edition_mismatch" }]);
    await syncForeground(OWNER_ID, deps(server));
    expect(server.count("POST /sessions")).toBe(1);
  });

  it("a duplicate answer removes the event: a lost response is repaired by sending the same ids again", async () => {
    const { events } = await device(3);
    const server = new FakeServer();
    const committed = new Set<string>();
    let calls = 0;
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => {
      calls += 1;
      const ids = eventIds(call);
      if (calls <= 4) {
        // The server stores the events, then the answer is lost (the client retries three times inside one request, all of them lost).
        ids.forEach((id) => committed.add(id));
        throw new TypeError("connection dropped after commit");
      }
      return { body: { ...ackAll(call), acknowledged: ids.filter((id) => !committed.has(id)), duplicate: ids.filter((id) => committed.has(id)) } satisfies EventsResponse };
    });
    const lost = await syncForeground(OWNER_ID, deps(server));
    expect(lost.outcome).toBe("server_unreachable");
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: 3 });

    const repaired = await syncForeground(OWNER_ID, deps(server));
    expect(repaired).toMatchObject({ outcome: "completed", duplicateIds: events.map((e) => e.clientEventId), acknowledgedIds: [] });
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 0 });
    // Every resend carried the identical ids: nothing was regenerated.
    const sentIds = server.list("POST /sessions").map(eventIds);
    for (const ids of sentIds) expect(ids).toEqual(events.map((e) => e.clientEventId));
  });

  it("429 keeps everything and reports Retry-After; 503 is unavailable", async () => {
    await device(2);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, envelopeError("throttled", 429, {}, { "Retry-After": "7" }));
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "throttled", retryAfterSec: 7 });
    server.on(`POST /sessions/${DAILY_SESSION}/events`, envelopeError("unavailable", 503));
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "unavailable" });
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: 2 });
  });

  it("a 404 for the session is an owner mismatch and nothing is deleted", async () => {
    await device(1);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, envelopeError("not_found", 404));
    expect(await syncForeground(OWNER_ID, deps(server))).toMatchObject({ outcome: "owner_mismatch" });
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: 1 });
  });
});

describe("413 payload_too_large (G-13)", () => {
  it("halves the batch and sends every event exactly once", async () => {
    const { events } = await device(5);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => {
      if (eventIds(call).length > 2) return envelopeError("payload_too_large", 413);
      return { body: ackAll(call) };
    });
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result.outcome).toBe("completed");
    expect(result.acknowledgedIds.sort()).toEqual(events.map((e) => e.clientEventId).sort());
    expect(server.list("POST /sessions").map((call) => eventIds(call).length)).toEqual([5, 3, 2, 1, 2]);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 0 });
  });

  it("a single event the server refuses as too large is reported as blocked, not dropped silently", async () => {
    const { events } = await device(1);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, envelopeError("payload_too_large", 413));
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result.blockedIds).toEqual([events[0]?.clientEventId]);
    expect(await listPendingEvents(OWNER_ID)).toMatchObject([{ state: "blocked", code: "payload_too_large" }]);
  });

  it("a request the server calls invalid is blocked for good rather than repeated", async () => {
    await device(2);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, envelopeError("validation_error", 422, { fields: [{ field: "events[0].correct", rule: "forbidden_field" }] }));
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result.blockedIds).toHaveLength(2);
    expect(server.count("POST /sessions")).toBe(1);
  });
});

describe("waking the free server (D48, API-spec 1.11)", () => {
  it("probes at 1, 2, 4 s until health answers, then goes on; the wait is connectivity, never a status", async () => {
    await device(1);
    const server = new FakeServer();
    let probes = 0;
    server.on("GET /health", () => {
      probes += 1;
      return probes <= 3 ? { status: 502, body: {} } : { body: { status: "ok", version: "t", time: "now" } };
    });
    const time = fakeClock();
    const progress: SyncProgress[] = [];
    const result = await syncForeground(OWNER_ID, { client: server.client(), now: time.now, sleep: time.sleep, isOnline: () => true, onProgress: (p) => progress.push(p) });
    expect(result.outcome).toBe("completed");
    expect(probes).toBe(4);
    expect(time.now() - 1_000_000).toBe(1000 + 2000 + 4000);
    expect(progress.filter((p) => p.phase === "waiting_server").map((p) => p.waitedMs).filter((ms) => ms > 0)).toEqual([1000, 3000]); // reported after each failed probe
  });

  it("gives up after 90 s with the retry state, touches no data and calls neither me nor E25 nor E21", async () => {
    const { events } = await device(2);
    const server = new FakeServer();
    server.on("GET /health", { status: 502, body: {} });
    const time = fakeClock();
    const progress: SyncProgress[] = [];
    const result = await syncForeground(OWNER_ID, { client: server.client(), now: time.now, sleep: time.sleep, isOnline: () => true, onProgress: (p) => progress.push(p) });
    expect(result.outcome).toBe("server_unreachable");
    expect(time.now() - 1_000_000).toBeGreaterThanOrEqual(90_000);
    expect(progress.at(-1)).toMatchObject({ phase: "stopped", timedOut: true });
    expect(server.calls.every((call) => call.path === "/health")).toBe(true);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ queued: events.length });
    expect(await readReadyPlan(OWNER_ID)).not.toBeNull();
    expect(await inspectLocalPlan()).toMatchObject({ status: "ready" });
  });

  it("an application error from /health still proves the server is awake", async () => {
    await device(1);
    const server = new FakeServer();
    server.on("GET /health", envelopeError("unavailable", 503));
    expect((await syncForeground(OWNER_ID, deps(server))).outcome).toBe("completed");
  });
});

describe("one sync worker per device", () => {
  it("a second run while one is running is refused (IndexedDB lease fallback)", async () => {
    await device(2);
    const server = new FakeServer();
    const release: { go: () => void } = { go: () => undefined };
    const gate = new Promise<void>((resolve) => {
      release.go = resolve;
    });
    server.on("GET /me", async () => {
      await gate;
      return { body: { username: USERNAME } };
    });
    const first = syncForeground(OWNER_ID, deps(server, { locks: null }));
    // Let the first run take the lease.
    await vi.waitFor(() => expect(server.count("GET /me")).toBe(1));
    const second = await syncForeground(OWNER_ID, deps(server, { locks: null }));
    expect(second.outcome).toBe("locked_elsewhere");
    release.go();
    expect((await first).outcome).toBe("completed");
    // The lease is released: a later run works.
    expect((await syncForeground(OWNER_ID, deps(server, { locks: null }))).outcome).toBe("completed");
  });

  it("uses a Web Lock when the browser has one, and reports locked_elsewhere when another tab holds it", async () => {
    await device(1);
    const server = new FakeServer();
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback(null));
    expect(await syncForeground(OWNER_ID, deps(server, { locks: { request } as never }))).toMatchObject({ outcome: "locked_elsewhere" });
    expect(request).toHaveBeenCalledWith("qatra-sync", { ifAvailable: true }, expect.any(Function));
    expect(server.calls).toHaveLength(0);
    const granted = vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({ name: "qatra-sync" }));
    expect((await syncForeground(OWNER_ID, deps(server, { locks: { request: granted } as never }))).outcome).toBe("completed");
  });
});

describe("the owed server logout comes first (PWA-design 7)", () => {
  it("after an offline logout the next foreground sync wakes the server, logs out, and clears the flag", async () => {
    await device(1);
    await logoutLocally({ serverLogoutDone: false });
    const server = new FakeServer();
    const result = await syncForeground("", deps(server));
    expect(result.outcome).toBe("nothing_to_do");
    expect(sequence(server)).toEqual(["GET /health", "POST /auth/logout"]);
    expect(((await readOwnerState()) as OwnerState).logoutPending).toBe(false);
  });

  it("a failed server logout keeps the flag and says the server was unreachable", async () => {
    await device(1);
    await logoutLocally({ serverLogoutDone: false });
    const server = new FakeServer();
    server.on("POST /auth/logout", envelopeError("unavailable", 503));
    expect((await syncForeground("", deps(server))).outcome).toBe("server_unreachable");
    expect(((await readOwnerState()) as OwnerState).logoutPending).toBe(true);
  });
});

describe("E22 only for retired descriptors, after every event is acknowledged (G-03)", () => {
  async function replaced() {
    const first = makeSnapshot();
    await cacheActivePlan(first, { username: USERNAME });
    const run = await startRun(OWNER_ID, { snapshotId: first.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    const events = [answerAt(first, run.clientRunId, 0, 0)];
    await enqueueEvents(OWNER_ID, DAILY_SESSION, events);
    const passageId = first.downloadedTargetRefs[0] as string;
    const second = makeSnapshot({
      snapshotId: uuid(),
      planVersion: 2,
      preparedSessions: [preparedSession(uuid(), "daily", [choiceQuestion("q-new", passageId)], passageId)],
      games: [choiceQuestion("q-new", passageId)],
    });
    await cacheActivePlan(second, { username: USERNAME });
    return { first, second, events };
  }

  it("never closes a descriptor that is still reusable", async () => {
    await device(1);
    const server = new FakeServer();
    await syncForeground(OWNER_ID, deps(server));
    expect(server.count("POST /sessions/" + DAILY_SESSION + "/complete")).toBe(0);
  });

  it("closes the replaced snapshot's sessions with a stable Idempotency-Key once its events are acknowledged, then drops the old copy", async () => {
    const { first } = await replaced();
    const [run] = (await dumpAllStores()).activeRuns as { clientRunId: string }[];
    await finishRun(OWNER_ID, run?.clientRunId as string, "finished");
    expect(first.snapshotId).toBeDefined();
    const server = new FakeServer();
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result.outcome).toBe("completed");
    const completes = server.list("POST /sessions").filter((call) => call.path.endsWith("/complete"));
    expect(completes.map((call) => call.path).sort()).toEqual([`/sessions/${DAILY_SESSION}/complete`, `/sessions/${GAME_SESSION}/complete`].sort());
    const keys = completes.map((call) => call.headers["Idempotency-Key"]);
    expect(keys.every((key) => typeof key === "string" && key.length > 20)).toBe(true);
    const dump = await dumpAllStores();
    expect((dump.syncState[0] as SyncStateRecord).retiredSessions).toEqual([]);
    expect(dump.planSnapshots).toHaveLength(1);
  });

  it("a run abandoned for more than a day no longer holds the old copy", async () => {
    await replaced();
    const { runTx } = await import("@/lib/offline/db");
    await runTx(["activeRuns"], "readwrite", async (ctx) => {
      const [run] = await ctx.all<{ clientRunId: string; updatedAt: string }>("activeRuns");
      await ctx.put("activeRuns", { ...run, updatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
    });
    await syncForeground(OWNER_ID, deps(new FakeServer()));
    expect((await dumpAllStores()).planSnapshots).toHaveLength(1);
  });

  it("waits while an event of the old snapshot is still pending", async () => {
    await replaced();
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => ({
      body: { ...ackAll(call), acknowledged: [], pending: eventIds(call).map((clientEventId) => ({ clientEventId, reasonCode: "plan_changed_unverifiable" })) } satisfies EventsResponse,
    }));
    await syncForeground(OWNER_ID, deps(server));
    expect(server.list("POST /sessions").some((call) => call.path.endsWith("/complete"))).toBe(false);
    expect(((await dumpAllStores()).syncState[0] as SyncStateRecord).retiredSessions.length).toBeGreaterThan(0);
  });

  it("an answer the server will not close is dropped from the list instead of being retried for ever", async () => {
    await replaced();
    const server = new FakeServer();
    server.on("re:^POST /sessions/[^/]+/complete$", envelopeError("not_found", 404));
    await syncForeground(OWNER_ID, deps(server));
    expect(((await dumpAllStores()).syncState[0] as SyncStateRecord).retiredSessions).toEqual([]);
  });

  it("a connectivity failure keeps the list for the next sync", async () => {
    await replaced();
    const server = new FakeServer();
    server.on("re:^POST /sessions/[^/]+/complete$", () => {
      throw new TypeError("lost");
    });
    const result = await syncForeground(OWNER_ID, deps(server));
    expect(result.outcome).toBe("server_unreachable");
    expect(((await dumpAllStores()).syncState[0] as SyncStateRecord).retiredSessions.length).toBeGreaterThan(0);
  });

  it("uses the same key for the same session across two attempts", async () => {
    await replaced();
    const server = new FakeServer();
    server.on("re:^POST /sessions/[^/]+/complete$", () => {
      throw new TypeError("lost");
    });
    await syncForeground(OWNER_ID, deps(server));
    const firstKeys = new Map(server.list("POST /sessions").filter((c) => c.path.endsWith("/complete")).map((c) => [c.path, c.headers["Idempotency-Key"]]));
    server.calls.length = 0;
    await syncForeground(OWNER_ID, deps(server));
    for (const call of server.list("POST /sessions").filter((c) => c.path.endsWith("/complete"))) {
      expect(call.headers["Idempotency-Key"]).toBe(firstKeys.get(call.path));
    }
  });
});

describe("OfflineSyncController (what the screens read)", () => {
  it("walks the phases, ends in done with the result, and runs one sync at a time", async () => {
    await device(1);
    const server = new FakeServer();
    const controller = new OfflineSyncController({ deps: () => deps(server) });
    const seen: string[] = [];
    controller.subscribe(() => seen.push(controller.getState().phase));
    expect(controller.getState().phase).toBe("idle");
    const [a, b] = await Promise.all([controller.run("app_open"), controller.run("reconnect")]);
    expect(a).toBe(b);
    expect(a.outcome).toBe("completed");
    expect(seen).toEqual(expect.arrayContaining(["checking_account", "waiting_server", "revalidating", "replaying", "refreshing", "done"]));
    expect(controller.getState()).toMatchObject({ phase: "done", trigger: "app_open", result: { outcome: "completed" } });
    expect(server.count("POST /sessions")).toBe(1);
  });

  it("a stopped sync ends in stopped and the retry button runs it again as a manual trigger", async () => {
    await device(1);
    const server = new FakeServer();
    server.on("GET /me", envelopeError("unauthenticated", 401));
    const controller = new OfflineSyncController({ deps: () => deps(server) });
    expect((await controller.run("app_open")).outcome).toBe("unauthenticated");
    expect(controller.getState()).toMatchObject({ phase: "stopped" });
    server.overrides.clear();
    expect((await controller.retry()).outcome).toBe("completed");
    expect(controller.getState().trigger).toBe("manual");
  });

  it("a connection that returns triggers a real attempt", async () => {
    await device(1);
    const server = new FakeServer();
    const controller = new OfflineSyncController({ deps: () => deps(server) });
    const detach = controller.attachForegroundTriggers();
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(controller.getState().phase).toBe("done"));
    expect(controller.getState().trigger).toBe("reconnect");
    detach();
  });
});

describe("integration with the stored state", () => {
  it("applyEventsResponse and sync agree on counts after a mixed answer", async () => {
    const { events } = await device(3);
    const server = new FakeServer();
    server.on(`POST /sessions/${DAILY_SESSION}/events`, (call) => {
      const ids = eventIds(call);
      return { body: { ...ackAll(call), acknowledged: [ids[0] as string], pending: [{ clientEventId: ids[1] as string, reasonCode: "content_unverifiable" }], rejected: [{ clientEventId: ids[2] as string, code: "out_of_scope" }] } satisfies EventsResponse };
    });
    await syncForeground(OWNER_ID, deps(server));
    expect(await countOutbox(OWNER_ID)).toEqual({ queued: 0, pending: 1, blocked: 1, total: 2 });
    const { acknowledgedIds } = await applyEventsResponse(OWNER_ID, [], ackAll({ method: "POST", path: "", body: { events: [] }, headers: {} }));
    expect(acknowledgedIds).toEqual([]);
    expect(events).toHaveLength(3);
  });

  it("completeSession is the only way an E22 leaves this module (no body, idempotent header)", async () => {
    const server = new FakeServer();
    await completeSession(server.client(), DAILY_SESSION, { idempotencyKey: "key-1" });
    expect(server.calls[0]).toMatchObject({ method: "POST", path: `/sessions/${DAILY_SESSION}/complete`, body: undefined });
    expect(server.calls[0]?.headers["Idempotency-Key"]).toBe("key-1");
  });
});

