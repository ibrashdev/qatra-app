import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSnapshot } from "@/lib/api/types";
import { openOfflineDb } from "@/lib/offline/db";
import { enqueueEvent } from "@/lib/offline/outbox";
import {
  cacheActivePlan,
  deletePlanMaterial,
  downloadPlanForOffline,
  getPreparedSession,
  inspectLocalPlan,
  mapDownloadError,
  pruneRetiredSnapshots,
  readReadyPlan,
  recordRevalidation,
  validatePlanSnapshot,
  verifyContentHashes,
} from "@/lib/offline/plan-cache";
import { listPendingEvents } from "@/lib/offline/outbox";
import { readOwnerState } from "@/lib/offline/owner";
import { startRun } from "@/lib/offline/run-store";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import type { DownloadPhase, PlanSnapshotRecord, RevalidationRecord, SyncStateRecord } from "@/lib/offline/types";
import { DAILY_SESSION, FakeServer, GAME_SESSION, OWNER_ID, PLAN_ID, USERNAME, answerAt, dumpAllStores, envelopeError, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());
afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as unknown as { storage?: unknown }).storage;
});

function stubStorage(storage: { estimate: () => Promise<{ quota: number; usage: number }>; persist: () => Promise<boolean> }): void {
  Object.defineProperty(navigator, "storage", { value: storage, configurable: true });
}

describe("validatePlanSnapshot (structure first, always, G-07)", () => {
  it("accepts a complete snapshot", () => {
    expect(validatePlanSnapshot(makeSnapshot())).toEqual({ ok: true });
  });

  const bad: [string, (snapshot: PlanSnapshot) => unknown][] = [
    ["a snapshot that is not an object", () => "nope"],
    ["an unsupported protocol version", (s) => ({ ...s, protocolVersion: 2 })],
    ["a missing owner binding", (s) => ({ ...s, userId: "" })],
    ["a policy this app does not know", (s) => ({ ...s, normalizationPolicyVersion: "arabic-norm-v2" })],
    ["no targets", (s) => ({ ...s, downloadedTargetRefs: [] })],
    ["more than 60 targets", (s) => ({ ...s, downloadedTargetRefs: Array.from({ length: 61 }, (_, i) => `p${i}`) })],
    ["a target without a lesson", (s) => ({ ...s, downloadedTargetRefs: [...s.downloadedTargetRefs, "missing-passage"] })],
    ["more than 7 prepared sessions", (s) => ({ ...s, preparedSessions: Array.from({ length: 8 }, () => s.preparedSessions[0]) })],
    ["no prepared sessions", (s) => ({ ...s, preparedSessions: [] })],
    ["a session that is not prepared", (s) => ({ ...s, preparedSessions: [{ ...s.preparedSessions[0], status: "open" }] })],
    ["a placement session", (s) => ({ ...s, preparedSessions: [{ ...s.preparedSessions[0], kind: "placement" }] })],
    ["a choice question without its answer in the options", (s) => ({ ...s, games: [{ ...s.games[0], answerKey: { optionId: "zzz" } }] })],
    ["a choice question with one option", (s) => ({ ...s, games: [{ ...s.games[0], options: [{ optionId: "q-choice-a", text: "a" }] }] })],
    ["a recall question without accepted forms", (s) => ({ ...s, games: [{ ...s.games[1], answerKey: { acceptedNorms: [] } }] })],
    ["an order question whose key names an unknown token", (s) => ({ ...s, games: [{ ...s.games[2], answerKey: { order: ["9:9"] } }] })],
    ["a session question with an unsupported policy", (s) => {
      const session = structuredClone(s.preparedSessions[0]);
      const step = session?.steps.find((item) => item.type === "question");
      if (step?.type === "question") step.question.policy = { normalizationPolicyVersion: "x" } as never;
      return { ...s, preparedSessions: [session] };
    }],
  ];
  it.each(bad)("rejects %s", (_name, corrupt) => {
    expect(validatePlanSnapshot(corrupt(makeSnapshot()))).toMatchObject({ ok: false, failureCode: "invalid_snapshot" });
  });

  it("tells a snapshot from a newer schema apart (schema_too_new)", () => {
    expect(validatePlanSnapshot({ ...makeSnapshot(), schemaVersion: 2 })).toMatchObject({ ok: false, failureCode: "schema_too_new" });
  });
});

describe("verifyContentHashes (Web Crypto, only when a hash is present)", () => {
  async function sha(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  it("passes with no hashes, with matching hashes, and ignores a hash for a unit the lessons do not show", async () => {
    expect(await verifyContentHashes(makeSnapshot())).toBe(true);
    const good = makeSnapshot({ contentHashes: { "unit:1": await sha("alpha beta"), "unit:77": "deadbeef" } });
    expect(await verifyContentHashes(good)).toBe(true);
    expect(await verifyContentHashes(makeSnapshot({ contentHashes: { "unit:1": `sha256:${await sha("alpha beta")}` } }))).toBe(true);
  });

  it("fails on a mismatch, and the snapshot never becomes ready", async () => {
    const tampered = makeSnapshot({ contentHashes: { "unit:1": await sha("something else") } });
    expect(await verifyContentHashes(tampered)).toBe(false);
    expect(await cacheActivePlan(tampered, { username: USERNAME })).toEqual({ ready: false, snapshotId: null, failureCode: "hash_mismatch" });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect((await dumpAllStores()).planSnapshots).toEqual([]);
  });
});

describe("cacheActivePlan: stage, validate, flip", () => {
  it("makes the snapshot ready and readable, with the owner and username recorded", async () => {
    const snapshot = makeSnapshot();
    expect(await cacheActivePlan(snapshot, { username: USERNAME })).toEqual({ ready: true, snapshotId: snapshot.snapshotId });
    expect(await readReadyPlan(OWNER_ID)).toEqual(snapshot);
    expect(await readOwnerState()).toMatchObject({ ownerId: OWNER_ID, username: USERNAME });
    const [record] = (await dumpAllStores()).planSnapshots as PlanSnapshotRecord[];
    expect(record).toMatchObject({ ready: true, retired: false, planId: PLAN_ID, planVersion: 1, schemaVersion: 1 });
    expect(record?.sizeBytes).toBeGreaterThan(100);
    expect(await getPreparedSession(OWNER_ID, snapshot.snapshotId, GAME_SESSION)).toMatchObject({ sessionId: GAME_SESSION, kind: "game" });
    expect(await getPreparedSession(OWNER_ID, snapshot.snapshotId, "nope")).toBeNull();
    expect(await getPreparedSession("someone-else", snapshot.snapshotId, GAME_SESSION)).toBeNull();
  });

  it("is idempotent for the same snapshot (a retried E23)", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    expect(await cacheActivePlan(snapshot, { username: USERNAME })).toEqual({ ready: true, snapshotId: snapshot.snapshotId });
    expect((await dumpAllStores()).planSnapshots).toHaveLength(1);
  });

  it("never leaves a rejected snapshot behind and keeps the previous ready one valid", async () => {
    const first = makeSnapshot();
    await cacheActivePlan(first, { username: USERNAME });
    const broken = makeSnapshot({ snapshotId: uuid(), downloadedTargetRefs: ["missing"] });
    expect(await cacheActivePlan(broken, { username: USERNAME })).toMatchObject({ ready: false, failureCode: "invalid_snapshot" });
    expect(await readReadyPlan(OWNER_ID)).toEqual(first);
    expect((await dumpAllStores()).planSnapshots).toHaveLength(1);
  });

  it("a full quota leaves the snapshot not ready and the previous one untouched (storage_quota)", async () => {
    const first = makeSnapshot();
    await cacheActivePlan(first, { username: USERNAME });
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "planSnapshots") throw new DOMException("full", "QuotaExceededError");
      return original.call(this, value, key);
    });
    const second = makeSnapshot({ snapshotId: uuid(), planVersion: 2 });
    expect(await cacheActivePlan(second, { username: USERNAME })).toEqual({ ready: false, snapshotId: null, failureCode: "storage_quota" });
    vi.restoreAllMocks();
    expect(await readReadyPlan(OWNER_ID)).toEqual(first);
  });

  it("a second snapshot of the same plan replaces the first and owes E22 for the old sessions", async () => {
    const first = makeSnapshot();
    await cacheActivePlan(first, { username: USERNAME });
    const second = makeSnapshot({ snapshotId: uuid(), planVersion: 2 });
    await cacheActivePlan(second, { username: USERNAME });
    const dump = await dumpAllStores();
    expect((dump.planSnapshots as PlanSnapshotRecord[]).map((r) => r.snapshotId)).toEqual([second.snapshotId]);
    expect(await readReadyPlan(OWNER_ID)).toEqual(second);
    const sync = dump.syncState[0] as SyncStateRecord;
    expect(sync.retiredSessions.map((entry) => entry.sessionId).sort()).toEqual([DAILY_SESSION, GAME_SESSION]);
    expect(sync.retiredSessions.every((entry) => entry.snapshotId === first.snapshotId && entry.idempotencyKey.length > 20)).toBe(true);
  });

  it("keeps the old snapshot retired while an unsent event or an active run refers to it, then prunes it", async () => {
    const first = makeSnapshot();
    await cacheActivePlan(first, { username: USERNAME });
    const run = await startRun(OWNER_ID, { snapshotId: first.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    await enqueueEvent(OWNER_ID, DAILY_SESSION, answerAt(first, run.clientRunId, 0));
    const second = makeSnapshot({ snapshotId: uuid(), planVersion: 2 });
    await cacheActivePlan(second, { username: USERNAME });

    let records = (await dumpAllStores()).planSnapshots as PlanSnapshotRecord[];
    expect(records.map((r) => [r.snapshotId, r.retired])).toEqual(expect.arrayContaining([[first.snapshotId, true], [second.snapshotId, false]]));
    // The retired one is never offered as the plan to run.
    expect(await readReadyPlan(OWNER_ID)).toEqual(second);
    expect(await pruneRetiredSnapshots(OWNER_ID)).toBe(0);

    // The event is acknowledged and the run is closed: nothing refers to it any more.
    const { applyEventsResponse } = await import("@/lib/offline/outbox");
    const { finishRun } = await import("@/lib/offline/run-store");
    const sent = await listPendingEvents(OWNER_ID);
    await applyEventsResponse(OWNER_ID, sent, { acknowledged: sent.map((e) => e.clientEventId), duplicate: [], pending: [], rejected: [], results: [], daily: { learningDate: "2026-10-06", dailyActiveMs: 0, dailyGoalMs: 1, dailyPercent: 0, dailyCompleted: false, extraActiveMs: 0 } });
    await finishRun(OWNER_ID, run.clientRunId, "finished");
    expect(await pruneRetiredSnapshots(OWNER_ID)).toBe(1);
    records = (await dumpAllStores()).planSnapshots as PlanSnapshotRecord[];
    expect(records.map((r) => r.snapshotId)).toEqual([second.snapshotId]);
  });
});

describe("inspectLocalPlan and readReadyPlan (E25 results stop display and runs)", () => {
  const record = (snapshotId: string, status: RevalidationRecord["status"], reasonCode: string): RevalidationRecord => ({ snapshotId, status, reasonCode, currentPlanVersion: 2, allowedSessionRefs: [], catalogVersion: 3, at: "2026-10-05T12:00:00.000Z" });

  it("none, then ready", async () => {
    expect(await inspectLocalPlan()).toMatchObject({ status: "none", snapshot: null });
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    expect(await inspectLocalPlan()).toMatchObject({ status: "ready", snapshot, owner: { ownerId: OWNER_ID }, counts: { total: 0 } });
  });

  it("incomplete when only a staged record exists", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    // Simulate a download that died after staging: the ready flag is false.
    const { runTx } = await import("@/lib/offline/db");
    await runTx(["planSnapshots"], "readwrite", async (ctx) => {
      const stored = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshot.snapshotId);
      await ctx.put("planSnapshots", { ...(stored as PlanSnapshotRecord), ready: false, readyAt: null });
    });
    expect(await inspectLocalPlan()).toMatchObject({ status: "incomplete", snapshot: null });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
  });

  it("stale hides the plan from display and runs but keeps the outbox", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    await enqueueEvent(OWNER_ID, DAILY_SESSION, answerAt(snapshot, uuid(), 0));
    await recordRevalidation(OWNER_ID, record(snapshot.snapshotId, "stale", "plan_version_changed"));
    const inspected = await inspectLocalPlan();
    expect(inspected).toMatchObject({ status: "stale", snapshot: null, counts: { queued: 1, total: 1 } });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect(await listPendingEvents(OWNER_ID)).toHaveLength(1);
  });

  it("a fresh download clears the stale state", async () => {
    const first = makeSnapshot();
    await cacheActivePlan(first, { username: USERNAME });
    await recordRevalidation(OWNER_ID, record(first.snapshotId, "stale", "plan_version_changed"));
    const second = makeSnapshot({ snapshotId: uuid(), planVersion: 2 });
    await cacheActivePlan(second, { username: USERNAME });
    expect(await inspectLocalPlan()).toMatchObject({ status: "ready" });
  });

  it("revoked deletes the material, drops the runs, blocks the unsent events and leaves a tombstone", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    await enqueueEvent(OWNER_ID, DAILY_SESSION, answerAt(snapshot, run.clientRunId, 0));
    await recordRevalidation(OWNER_ID, record(snapshot.snapshotId, "revoked", "content_revoked"));
    await deletePlanMaterial(OWNER_ID, snapshot.snapshotId);

    const dump = await dumpAllStores();
    expect(dump.planSnapshots).toEqual([]);
    expect(dump.activeRuns).toEqual([]);
    expect(await listPendingEvents(OWNER_ID)).toMatchObject([{ state: "blocked", code: "content_revoked" }]);
    expect(await inspectLocalPlan()).toMatchObject({ status: "revoked", snapshot: null, counts: { blocked: 1 }, revalidation: { reasonCode: "content_revoked" } });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
  });

  it("locked and schema_incompatible are reported, not hidden", async () => {
    window.localStorage.setItem("qatra.offline.locked", "1");
    expect(await inspectLocalPlan()).toMatchObject({ status: "locked", failureCode: "locked" });
    window.localStorage.clear();
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const { runTx } = await import("@/lib/offline/db");
    await runTx(["planSnapshots"], "readwrite", async (ctx) => {
      const stored = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshot.snapshotId);
      await ctx.put("planSnapshots", { ...(stored as PlanSnapshotRecord), schemaVersion: 2 });
    });
    expect(await inspectLocalPlan()).toMatchObject({ status: "schema_incompatible", snapshot: null });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
  });

  it("an IndexedDB failure is a storage_error, not an empty account", async () => {
    await openOfflineDb();
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
      throw new DOMException("broken", "UnknownError");
    });
    expect(await inspectLocalPlan()).toMatchObject({ status: "storage_error" });
  });
});

describe("downloadPlanForOffline (E23 then cacheActivePlan)", () => {
  function server(snapshot = makeSnapshot()) {
    const fake = new FakeServer();
    fake.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 201, body: snapshot });
    return fake;
  }

  it("downloads, validates, stores, and reports its phases; no field the server forbids is sent", async () => {
    const snapshot = makeSnapshot();
    const fake = server(snapshot);
    const phases: DownloadPhase[] = [];
    const result = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client(), onPhase: (phase) => phases.push(phase) });
    expect(result).toMatchObject({ ready: true, snapshotId: snapshot.snapshotId });
    expect(result.sizeBytes).toBeGreaterThan(100);
    expect(phases).toEqual(["checking_storage", "waking_server", "preparing", "validating", "saving", "done"]);
    const call = fake.list("POST /plans/")[0];
    expect(Object.keys(call?.body as object).sort()).toEqual(["clientOperationId", "expectedPlanVersion"]);
    expect(await readReadyPlan(OWNER_ID)).toEqual(snapshot);
    expect(await readOwnerState()).toMatchObject({ ownerId: OWNER_ID, username: USERNAME });
    // The attempt is spent: the stored operation id is gone.
    expect(((await dumpAllStores()).syncState[0] as SyncStateRecord).pendingDownload).toBeNull();
  });

  it("sends the target refs only when the caller gave them", async () => {
    const fake = server();
    await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1, targetRefs: ["66666666-6666-4666-8666-666666666666"] }, { client: fake.client() });
    expect((fake.list("POST /plans/")[0]?.body as { downloadTargetRefs: string[] }).downloadTargetRefs).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });

  it("stores the operation id before the call and reuses it after a lost answer (same snapshot, no new session)", async () => {
    const snapshot = makeSnapshot();
    const fake = server(snapshot);
    let first = true;
    fake.on(`POST /plans/${PLAN_ID}/offline-snapshots`, () => {
      if (first) {
        first = false;
        throw new TypeError("connection lost after the server committed");
      }
      return { status: 200, body: snapshot };
    });
    const lost = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() });
    // The client retries once on its own (same id); make it fail twice so the first call really ends in connectivity.
    expect(lost.ready).toBe(true);

    await (await import("@/lib/offline/owner")).clearLocalCopy();
    resetOfflineEnvironment();
    const second = new FakeServer();
    const ids: string[] = [];
    let failures = 2;
    second.on(`POST /plans/${PLAN_ID}/offline-snapshots`, (call) => {
      ids.push((call.body as { clientOperationId: string }).clientOperationId);
      if (failures > 0) {
        failures -= 1;
        throw new TypeError("lost");
      }
      return { status: 200, body: snapshot };
    });
    const failed = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: second.client() });
    expect(failed).toMatchObject({ ready: false, failureCode: "connectivity" });
    const retried = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: second.client() });
    expect(retried.ready).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  it("starts a new operation id when the input changed, or after the server answered for the old one", async () => {
    const fake = new FakeServer();
    const ids: string[] = [];
    fake.on(`POST /plans/${PLAN_ID}/offline-snapshots`, (call) => {
      ids.push((call.body as { clientOperationId: string }).clientOperationId);
      return envelopeError("version_conflict", 409, { reason: "plan_version", currentVersion: 5 });
    });
    expect(await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() })).toMatchObject({ failureCode: "plan_version" });
    await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 5 }, { client: fake.client() });
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    ["plan_version", envelopeError("version_conflict", 409, { reason: "plan_version" })],
    ["plan_not_active", envelopeError("version_conflict", 409, { reason: "plan_not_active" })],
    ["idempotency_input", envelopeError("version_conflict", 409, { reason: "idempotency_input" })],
    ["edition_not_downloadable", envelopeError("validation_error", 422, { fields: [{ field: "planId", rule: "edition_not_downloadable" }] })],
    ["edition_not_available", envelopeError("validation_error", 422, { fields: [{ field: "planId", rule: "edition_not_available" }] })],
    ["target_refs_invalid", envelopeError("validation_error", 422, { fields: [{ field: "downloadTargetRefs", rule: "target_refs_invalid" }] })],
    ["failed", envelopeError("validation_error", 422, { fields: [{ field: "x", rule: "forbidden_field" }] })],
    ["not_found", envelopeError("not_found", 404)],
    ["unauthenticated", envelopeError("unauthenticated", 401)],
    ["throttled", envelopeError("throttled", 429, {}, { "Retry-After": "5" })],
    ["unavailable", envelopeError("unavailable", 503)],
  ])("maps the server answer to %s and stores nothing", async (code, reply) => {
    const fake = new FakeServer();
    fake.on(`POST /plans/${PLAN_ID}/offline-snapshots`, reply);
    const result = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() });
    expect(result).toMatchObject({ ready: false, snapshotId: null, failureCode: code });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
  });

  it("maps errors the same way outside the download", () => {
    expect(mapDownloadError(new ConnectivityError("timeout"))).toBe("connectivity");
    expect(mapDownloadError(new ApiError({ status: 500, code: "internal", message: "x" }))).toBe("failed");
    expect(mapDownloadError(new Error("x"))).toBe("failed");
  });

  it("does not ask the server while the browser is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const fake = server();
    expect(await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() })).toMatchObject({ failureCode: "offline" });
    expect(fake.calls).toHaveLength(0);
  });

  it("a free server that does not wake is connectivity, never a status (server_unreachable)", async () => {
    const fake = new FakeServer();
    fake.on("GET /health", { status: 502, body: {} });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending = downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() });
      await vi.advanceTimersByTimeAsync(100_000);
      expect(await pending).toMatchObject({ ready: false, failureCode: "server_unreachable" });
    } finally {
      vi.useRealTimers();
    }
    expect(fake.count("POST /plans/")).toBe(0);
  });

  it("refuses when the free space is below three times the snapshot (storage_insufficient)", async () => {
    stubStorage({ estimate: async () => ({ quota: 1000, usage: 900 }), persist: async () => true });
    const fake = server();
    const result = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() });
    expect(result).toMatchObject({ ready: false, failureCode: "storage_insufficient" });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
  });

  it("asks the browser for persistent storage after a successful download and reports the answer without promising it", async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ estimate: async () => ({ quota: 1e12, usage: 0 }), persist });
    const result = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: server().client() });
    expect(result).toMatchObject({ ready: true, persisted: true });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("another account on the device must wipe first: no request for the snapshot is made", async () => {
    await cacheActivePlan(makeSnapshot(), { username: USERNAME });
    const fake = server();
    fake.username = "someone.else";
    const result = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: fake.client() });
    expect(result).toMatchObject({ ready: false, failureCode: "owner_mismatch" });
    expect(fake.count("POST /plans/")).toBe(0);
  });

  it("an aborted download ends quietly", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: server().client(), signal: controller.signal });
    expect(result.ready).toBe(false);
  });
});
