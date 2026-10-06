import { newEventId } from "@/components/session/session-events";
import type { ApiClient } from "@/lib/api/client";
import { createEndpoints } from "@/lib/api/endpoints";
import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { createOfflineSnapshot } from "@/lib/api/offline-endpoints";
import { getApiRuntime } from "@/lib/api/runtime";
import type { PlanSnapshot, SessionSnapshot } from "@/lib/api/types";
import { publishOfflineMessage } from "./broadcast";
import {
  OWNER_KEY,
  STORE_NAMES,
  defaultSyncState,
  initialOwnerState,
  isOfflineStorageSupported,
  nowIso,
  readLockMarker,
  readOwnerInTx,
  readSyncInTx,
  requireOwnerInTx,
  runTx,
  writeSyncInTx,
  type TxContext,
} from "./db";
import { countEvents } from "./outbox";
import { estimateStorage, hasEnoughSpace, isQuotaError, requestPersistence, utf8Length } from "./storage";
import { waitForServer } from "./wake";
import {
  OFFLINE_SCHEMA_VERSION,
  OfflineError,
  isOfflineError,
  type ActiveRunRecord,
  type CacheActivePlanFn,
  type CacheFailureCode,
  type DeletePlanMaterialFn,
  type DownloadFailureCode,
  type DownloadPlanForOfflineFn,
  type GetPreparedSessionFn,
  type InspectLocalPlanFn,
  type LocalPlanInspection,
  type OwnerState,
  type PendingDownload,
  type PendingEvent,
  type PlanSnapshotRecord,
  type ReadReadyPlanFn,
  type RevalidationRecord,
  type SyncStateRecord,
} from "./types";

// The plan on the device (PWA-design 4, offline-spec 2.2). A download is written to `planSnapshots` as `ready: false`, checked, and flipped to `ready: true`
// in one readwrite transaction; a failure at any point leaves the previous ready snapshot untouched. Readiness is `shellReady` AND `snapshotReady`, both
// checked at every boot, because no transaction spans Cache Storage and IndexedDB.

const MAX_TARGET_REFS = 60;
const MAX_PREPARED_SESSIONS = 7;

type SnapshotValidation = { ok: true } | { ok: false; failureCode: "invalid_snapshot" | "schema_too_new"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function questionProblem(question: unknown): string | null {
  if (!isRecord(question)) return "question is not an object";
  if (!isText(question.questionId)) return "question without id";
  if (!isText(question.passageId)) return `question ${String(question.questionId)} without passage`;
  const policy = question.policy;
  if (!isRecord(policy) || policy.normalizationPolicyVersion !== "arabic-norm-v1" || policy.scoringPolicyVersion !== "v1") {
    return `question ${String(question.questionId)} with an unsupported policy`;
  }
  const key = question.answerKey;
  if (!isRecord(key)) return `question ${String(question.questionId)} without answer key`;
  switch (question.type) {
    case "word_order": {
      const tokens = Array.isArray(question.tokens) ? question.tokens : [];
      const refs = new Set(tokens.map((token) => (isRecord(token) ? token.ref : undefined)));
      if (tokens.length === 0 || !Array.isArray(key.order) || key.order.length === 0 || !key.order.every((ref) => refs.has(ref))) {
        return `word_order ${String(question.questionId)} is incomplete`;
      }
      return null;
    }
    case "word_choice":
    case "similar_distinction": {
      const options = Array.isArray(question.options) ? question.options : [];
      const ids = options.map((option) => (isRecord(option) ? option.optionId : undefined));
      if (options.length < 2 || !ids.every(isText) || !ids.some((id) => id === key.optionId)) return `${String(question.type)} ${String(question.questionId)} is incomplete`;
      return null;
    }
    case "word_recall":
      if (!Array.isArray(key.acceptedNorms) || key.acceptedNorms.length === 0 || !key.acceptedNorms.every(isText)) return `word_recall ${String(question.questionId)} is incomplete`;
      return null;
    default:
      return `unknown question type ${String(question.type)}`;
  }
}

// Structure first, always (G-07): what offline play needs has to be in the snapshot before it may become ready. Pure, no clock, no network.
export function validatePlanSnapshot(value: unknown): SnapshotValidation {
  const bad = (detail: string): SnapshotValidation => ({ ok: false, failureCode: "invalid_snapshot", detail });
  if (!isRecord(value)) return bad("the snapshot is not an object");
  const snapshot = value;
  if (typeof snapshot.schemaVersion === "number" && snapshot.schemaVersion > OFFLINE_SCHEMA_VERSION) {
    return { ok: false, failureCode: "schema_too_new", detail: `schemaVersion ${snapshot.schemaVersion} is newer than this app` };
  }
  if (snapshot.schemaVersion !== 1 || snapshot.protocolVersion !== 1) return bad("unsupported schema or protocol version");
  for (const field of ["snapshotId", "userId", "planId", "editionId", "learningTimeZone"] as const) {
    if (!isText(snapshot[field])) return bad(`${field} is missing`);
  }
  if (!Number.isInteger(snapshot.planVersion) || (snapshot.planVersion as number) < 1) return bad("planVersion is invalid");
  if (!Number.isInteger(snapshot.bankVersion) || (snapshot.bankVersion as number) < 0) return bad("bankVersion is invalid");
  if (typeof snapshot.dailyGoalMs !== "number" || !Number.isFinite(snapshot.dailyGoalMs) || snapshot.dailyGoalMs < 0) return bad("dailyGoalMs is invalid");
  if (snapshot.normalizationPolicyVersion !== "arabic-norm-v1" || snapshot.scoringPolicyVersion !== "v1") return bad("unsupported policy version");
  if (!isRecord(snapshot.contentHashes)) return bad("contentHashes is missing");

  const refs = snapshot.downloadedTargetRefs;
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_TARGET_REFS || !refs.every(isText)) return bad("downloadedTargetRefs is invalid");
  if (!Array.isArray(snapshot.lessons)) return bad("lessons is missing");
  const lessonIds = new Set(snapshot.lessons.map((lesson) => (isRecord(lesson) ? lesson.passageId : undefined)));
  if (!snapshot.lessons.every((lesson) => isRecord(lesson) && isText(lesson.passageId) && Array.isArray(lesson.units))) return bad("a lesson is incomplete");
  for (const ref of refs) if (!lessonIds.has(ref)) return bad(`target ${String(ref)} has no lesson`);

  if (!Array.isArray(snapshot.games)) return bad("games is missing");
  for (const question of snapshot.games) {
    const problem = questionProblem(question);
    if (problem !== null) return bad(problem);
  }
  if (!Array.isArray(snapshot.references)) return bad("references is missing");

  const sessions = snapshot.preparedSessions;
  if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > MAX_PREPARED_SESSIONS) return bad("preparedSessions is invalid");
  for (const session of sessions) {
    if (!isRecord(session) || !isText(session.sessionId)) return bad("a prepared session has no id");
    if (session.status !== "prepared") return bad(`session ${session.sessionId} is not prepared`);
    if (session.kind !== "daily" && session.kind !== "game") return bad(`session ${session.sessionId} has an unsupported kind`);
    if (!Array.isArray(session.steps) || session.steps.length === 0) return bad(`session ${session.sessionId} has no steps`);
    for (const step of session.steps) {
      if (!isRecord(step)) return bad(`session ${session.sessionId} has a malformed step`);
      if (step.type === "learn") {
        if (!isRecord(step.passage) || !isText(step.passage.passageId)) return bad(`session ${session.sessionId} has a malformed lesson step`);
      } else if (step.type === "question") {
        const problem = questionProblem(step.question);
        if (problem !== null) return bad(`session ${session.sessionId}: ${problem}`);
      } else {
        return bad(`session ${session.sessionId} has an unknown step`);
      }
    }
  }
  return { ok: true };
}

async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// G-07: `contentHashes["unit:<unitRef>"]` is the sha256 of the unit text. Checked with Web Crypto only when a hash is present; without Web Crypto
// (an insecure context) the check is skipped, never faked. A mismatch means the content changed on the way, so the snapshot does not become ready.
export async function verifyContentHashes(snapshot: PlanSnapshot): Promise<boolean> {
  const wanted = Object.entries(snapshot.contentHashes).filter(([key]) => key.startsWith("unit:"));
  if (wanted.length === 0) return true;
  const texts = new Map<number, string>();
  for (const lesson of snapshot.lessons) for (const unit of lesson.units) texts.set(unit.unitRef, unit.text);
  for (const [key, expected] of wanted) {
    const text = texts.get(Number(key.slice("unit:".length)));
    if (text === undefined) continue;
    const actual = await sha256Hex(text);
    if (actual === null) return true;
    if (actual !== String(expected).replace(/^sha256:/i, "").toLowerCase()) return false;
  }
  return true;
}

function failureOf(error: unknown): CacheFailureCode {
  if (isOfflineError(error)) {
    switch (error.code) {
      case "owner_mismatch":
        return "owner_mismatch";
      case "locked":
      case "clear_failed":
        return "locked";
      case "quota_exceeded":
        return "storage_quota";
      case "schema_too_new":
        return "schema_too_new";
      case "unsupported":
        return "unsupported";
      default:
        return "storage_failed";
    }
  }
  return isQuotaError(error) ? "storage_quota" : "storage_failed";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Writing: stage, validate, flip
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const cacheActivePlan: CacheActivePlanFn = async (snapshot, options = {}) => {
  if (!isOfflineStorageSupported()) return { ready: false, snapshotId: null, failureCode: "unsupported" };
  const validation = validatePlanSnapshot(snapshot);
  if (!validation.ok) return { ready: false, snapshotId: null, failureCode: validation.failureCode };
  if (!(await verifyContentHashes(snapshot))) return { ready: false, snapshotId: null, failureCode: "hash_mismatch" };
  const sizeBytes = options.sizeBytes ?? utf8Length(JSON.stringify(snapshot));
  const stagedAt = nowIso();
  const snapshotId = snapshot.snapshotId;

  try {
    await runTx(["ownerState", "planSnapshots"], "readwrite", async (ctx) => {
      if (readLockMarker()) throw new OfflineError("locked", "The local copy is locked until it has been cleared.");
      const owner = (await readOwnerInTx(ctx)) ?? initialOwnerState();
      if (owner.clearFailed) throw new OfflineError("locked", "The local copy is locked until it has been cleared.");
      if (owner.ownerId !== null && owner.ownerId !== snapshot.userId) throw new OfflineError("owner_mismatch", "The local copy belongs to another account.");
      const username = options.username === undefined ? owner.username : options.username;
      await ctx.put("ownerState", { ...owner, ownerId: snapshot.userId, username, updatedAt: stagedAt } satisfies OwnerState, OWNER_KEY);
      const existing = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshotId);
      if (existing?.ready === true) return; // the same snapshot again (a retried E23): nothing to stage
      const record: PlanSnapshotRecord = {
        snapshotId,
        ownerId: snapshot.userId,
        generation: owner.generation,
        planId: snapshot.planId,
        editionId: snapshot.editionId,
        bankVersion: snapshot.bankVersion,
        planVersion: snapshot.planVersion,
        ready: false,
        stagedAt,
        readyAt: null,
        sizeBytes,
        schemaVersion: snapshot.schemaVersion,
        retired: false,
        snapshot,
      };
      await ctx.put("planSnapshots", record);
    });
  } catch (error) {
    return { ready: false, snapshotId: null, failureCode: failureOf(error) };
  }

  try {
    await runTx(STORE_NAMES, "readwrite", async (ctx) => {
      const owner = await requireOwnerInTx(ctx, snapshot.userId);
      const record = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshotId);
      if (record === undefined) throw new OfflineError("not_found", "The staged snapshot disappeared.");
      if (record.generation !== owner.generation) throw new OfflineError("generation_mismatch", "The copy was cleared during the download.");
      if (record.ready) return;
      await ctx.put("planSnapshots", { ...record, ready: true, readyAt: nowIso() } satisfies PlanSnapshotRecord);
      await supersedeOlder(ctx, snapshot);
    });
  } catch (error) {
    await discardStaged(snapshotId);
    return { ready: false, snapshotId: null, failureCode: failureOf(error) };
  }
  publishOfflineMessage({ type: "SNAPSHOT_READY", snapshotId });
  return { ready: true, snapshotId };
};

async function discardStaged(snapshotId: string): Promise<void> {
  try {
    await runTx(["planSnapshots"], "readwrite", async (ctx) => {
      const record = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshotId);
      if (record !== undefined && !record.ready) await ctx.delete("planSnapshots", snapshotId);
    });
  } catch {
    // The staged record stays `ready: false`: it is never shown and the next download replaces it.
  }
}

// A new ready snapshot replaces the older ones of its plan, except while a run or an unsent event still refers to one: that one is retired (never
// shown, never started) and kept until the references are gone. The prepared sessions of every replaced snapshot are owed an E22 once their events
// are acknowledged (G-03, done by the sync).
async function supersedeOlder(ctx: TxContext, snapshot: PlanSnapshot): Promise<void> {
  const ownerId = snapshot.userId;
  const sync = await readSyncInTx(ctx);
  const records = await ctx.allByIndex<PlanSnapshotRecord>("planSnapshots", "byPlan", [ownerId, snapshot.planId]);
  const runs = await ctx.allByIndex<ActiveRunRecord>("activeRuns", "byOwner", ownerId);
  const events = await ctx.allByIndex<PendingEvent>("pendingEvents", "byOwner", ownerId);
  const retired = [...sync.retiredSessions];
  const revalidations = { ...sync.revalidations };
  for (const record of records) {
    if (record.snapshotId === snapshot.snapshotId) continue;
    if (!record.ready) {
      await ctx.delete("planSnapshots", record.snapshotId);
      continue;
    }
    for (const session of record.snapshot.preparedSessions) {
      if (!retired.some((entry) => entry.sessionId === session.sessionId)) {
        retired.push({ sessionId: session.sessionId, snapshotId: record.snapshotId, idempotencyKey: newEventId() });
      }
    }
    const referenced = runs.some((run) => runKeepsSnapshot(run, record.snapshotId, Date.now())) || events.some((event) => event.snapshotId === record.snapshotId);
    if (referenced) {
      await ctx.put("planSnapshots", { ...record, retired: true } satisfies PlanSnapshotRecord);
    } else {
      await ctx.delete("planSnapshots", record.snapshotId);
      delete revalidations[record.snapshotId];
    }
  }
  // A tombstone of a revoked snapshot is moot once a fresh one is ready.
  const liveIds = new Set(records.map((record) => record.snapshotId));
  for (const [id, entry] of Object.entries(revalidations)) {
    if ((entry.status === "revoked" || entry.status === "expired") && !liveIds.has(id)) delete revalidations[id];
  }
  await writeSyncInTx(ctx, { ...sync, ownerId, retiredSessions: retired, revalidations });
}

// Retired snapshots whose runs and events are gone no longer need to stay on the device.
export async function pruneRetiredSnapshots(ownerId: string): Promise<number> {
  return runTx(["ownerState", "planSnapshots", "activeRuns", "pendingEvents"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    const records = await ctx.allByIndex<PlanSnapshotRecord>("planSnapshots", "byOwner", ownerId);
    const runs = await ctx.allByIndex<ActiveRunRecord>("activeRuns", "byOwner", ownerId);
    const events = await ctx.allByIndex<PendingEvent>("pendingEvents", "byOwner", ownerId);
    let removed = 0;
    for (const record of records) {
      if (!record.retired) continue;
      const referenced = runs.some((run) => runKeepsSnapshot(run, record.snapshotId, Date.now())) || events.some((event) => event.snapshotId === record.snapshotId);
      if (referenced) continue;
      await ctx.delete("planSnapshots", record.snapshotId);
      removed += 1;
    }
    return removed;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------------------------------------

const BLOCKING = new Set(["stale", "revoked", "expired"]);

// A run still counts as using its snapshot for a day after its last write. One the learner walked away from stops holding a retired snapshot.
export const RUN_FRESH_MS = 24 * 60 * 60 * 1000;

function runKeepsSnapshot(run: ActiveRunRecord, snapshotId: string, nowMs: number): boolean {
  return run.snapshotId === snapshotId && run.status === "active" && nowMs - Date.parse(run.updatedAt) < RUN_FRESH_MS;
}

function latestReady(records: readonly PlanSnapshotRecord[]): PlanSnapshotRecord | null {
  let best: PlanSnapshotRecord | null = null;
  for (const record of records) {
    if (!record.ready || record.retired) continue;
    if (best === null || (record.readyAt ?? "") > (best.readyAt ?? "")) best = record;
  }
  return best;
}

export const readReadyPlan: ReadReadyPlanFn = async (ownerId) => {
  if (readLockMarker()) return null;
  try {
    return await runTx(["ownerState", "planSnapshots", "syncState"], "readonly", async (ctx) => {
      const owner = await readOwnerInTx(ctx);
      if (owner === undefined || owner.ownerId !== ownerId || owner.clearFailed) return null;
      const record = latestReady(await ctx.allByIndex<PlanSnapshotRecord>("planSnapshots", "byOwner", ownerId));
      if (record === null || record.schemaVersion > OFFLINE_SCHEMA_VERSION) return null;
      const revalidation = (await readSyncInTx(ctx)).revalidations[record.snapshotId];
      if (revalidation !== undefined && BLOCKING.has(revalidation.status)) return null;
      return record.snapshot;
    });
  } catch {
    return null;
  }
};

function emptyInspection(overrides: Partial<LocalPlanInspection>): LocalPlanInspection {
  return { status: "none", owner: null, snapshot: null, record: null, revalidation: null, counts: { queued: 0, pending: 0, blocked: 0, total: 0 }, ...overrides };
}

export const inspectLocalPlan: InspectLocalPlanFn = async () => {
  if (!isOfflineStorageSupported()) return emptyInspection({ status: "none", failureCode: "unsupported" });
  if (readLockMarker()) return emptyInspection({ status: "locked", failureCode: "locked" });
  try {
    return await runTx(["ownerState", "planSnapshots", "syncState", "pendingEvents"], "readonly", async (ctx) => {
      const owner = (await readOwnerInTx(ctx)) ?? null;
      if (owner?.clearFailed === true) return emptyInspection({ status: "locked", owner, failureCode: "locked" });
      if (owner === null || owner.ownerId === null) return emptyInspection({ owner });
      const records = await ctx.allByIndex<PlanSnapshotRecord>("planSnapshots", "byOwner", owner.ownerId);
      const events = await ctx.allByIndex<PendingEvent>("pendingEvents", "byOwner", owner.ownerId);
      const sync = await readSyncInTx(ctx);
      const counts = countEvents(events);
      const record = latestReady(records);
      if (record === null) {
        const tombstone = Object.values(sync.revalidations)
          .filter((entry) => entry.status === "revoked" || entry.status === "expired")
          .sort((left, right) => (left.at < right.at ? 1 : -1))[0];
        if (tombstone !== undefined) return emptyInspection({ status: tombstone.status === "expired" ? "expired" : "revoked", owner, revalidation: tombstone, counts });
        return emptyInspection({ status: records.some((item) => !item.ready) ? "incomplete" : "none", owner, counts });
      }
      if (record.schemaVersion > OFFLINE_SCHEMA_VERSION) {
        return emptyInspection({ status: "schema_incompatible", owner, record, counts, failureCode: "schema_too_new" });
      }
      const revalidation = sync.revalidations[record.snapshotId] ?? null;
      if (revalidation !== null && BLOCKING.has(revalidation.status)) {
        const status = revalidation.status === "revoked" ? "revoked" : revalidation.status === "expired" ? "expired" : "stale";
        return emptyInspection({ status, owner, record, revalidation, counts });
      }
      return { status: "ready", owner, snapshot: record.snapshot, record, revalidation, counts };
    });
  } catch (error) {
    if (isOfflineError(error, "schema_too_new")) return emptyInspection({ status: "schema_incompatible", failureCode: "schema_too_new" });
    if (isOfflineError(error, "locked")) return emptyInspection({ status: "locked", failureCode: "locked" });
    if (isOfflineError(error, "unsupported")) return emptyInspection({ status: "none", failureCode: "unsupported" });
    return emptyInspection({ status: "storage_error", failureCode: isOfflineError(error) ? error.code : "storage_failed" });
  }
};

export const getPreparedSession: GetPreparedSessionFn = async (ownerId, snapshotId, sessionId) => {
  if (readLockMarker()) return null;
  try {
    return await runTx(["ownerState", "planSnapshots"], "readonly", async (ctx) => {
      const owner = await readOwnerInTx(ctx);
      if (owner === undefined || owner.ownerId !== ownerId || owner.clearFailed) return null;
      const record = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshotId);
      if (record === undefined || record.ownerId !== ownerId || !record.ready) return null;
      return record.snapshot.preparedSessions.find((session: SessionSnapshot) => session.sessionId === sessionId) ?? null;
    });
  } catch {
    return null;
  }
};

// Revoked or expired material (E25, G-06): lessons, questions and steps are deleted, runs of the snapshot are dropped, and its unsent events are kept
// visibly as `blocked` (never resent, never sent with blocked text). A tombstone in syncState tells the screen why the plan is «غير متاح».
export const deletePlanMaterial: DeletePlanMaterialFn = async (ownerId, snapshotId) => {
  await runTx(["ownerState", "planSnapshots", "activeRuns", "pendingEvents", "syncState"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    const record = await ctx.get<PlanSnapshotRecord>("planSnapshots", snapshotId);
    if (record !== undefined && record.ownerId === ownerId) await ctx.delete("planSnapshots", snapshotId);
    const runs = await ctx.allByIndex<ActiveRunRecord>("activeRuns", "bySnapshot", snapshotId);
    for (const run of runs) if (run.ownerId === ownerId) await ctx.delete("activeRuns", run.clientRunId);
    const events = await ctx.allByIndex<PendingEvent>("pendingEvents", "bySnapshot", snapshotId);
    const now = nowIso();
    for (const event of events) {
      if (event.ownerId !== ownerId || event.state === "blocked") continue;
      await ctx.put("pendingEvents", { ...event, state: "blocked", code: "content_revoked", reasonCode: undefined, updatedAt: now } satisfies PendingEvent);
    }
  });
  publishOfflineMessage({ type: "OUTBOX_CHANGED" });
};

// Stores the answer of E25 for a snapshot (also used by the sync). Kept apart from the transaction above because the sync decides what follows.
export async function recordRevalidation(ownerId: string, record: RevalidationRecord): Promise<void> {
  await runTx(["ownerState", "syncState"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    const sync = await readSyncInTx(ctx);
    await writeSyncInTx(ctx, { ...sync, ownerId, revalidations: { ...sync.revalidations, [record.snapshotId]: record } });
  });
}

export async function listReadySnapshots(ownerId: string): Promise<PlanSnapshotRecord[]> {
  if (readLockMarker()) return [];
  return runTx(["ownerState", "planSnapshots"], "readonly", async (ctx) => {
    const owner = await readOwnerInTx(ctx);
    if (owner === undefined || owner.ownerId !== ownerId || owner.clearFailed) return [];
    return (await ctx.allByIndex<PlanSnapshotRecord>("planSnapshots", "byOwner", ownerId)).filter((record) => record.ready && !record.retired);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Download (E23 then cacheActivePlan)
// ---------------------------------------------------------------------------------------------------------------------------------------------

function sameRefs(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((ref, index) => ref === right[index]);
}

// The operation id is stored before E23 is called, so a lost answer is retried with the same id and returns the same snapshot (API-spec E23).
async function loadOrCreateDownload(planId: string, expectedPlanVersion: number, targetRefs: string[] | null): Promise<PendingDownload> {
  return runTx(["syncState"], "readwrite", async (ctx) => {
    const sync = await readSyncInTx(ctx);
    const existing = sync.pendingDownload;
    if (existing !== null && existing.planId === planId && existing.expectedPlanVersion === expectedPlanVersion && sameRefs(existing.targetRefs, targetRefs)) return existing;
    const created: PendingDownload = { planId, clientOperationId: newEventId(), expectedPlanVersion, targetRefs, startedAt: nowIso() };
    await writeSyncInTx(ctx, { ...sync, pendingDownload: created });
    return created;
  });
}

async function setPendingDownload(value: PendingDownload | null): Promise<void> {
  await runTx(["syncState"], "readwrite", async (ctx) => {
    const sync: SyncStateRecord = await readSyncInTx(ctx);
    await writeSyncInTx(ctx, { ...(sync ?? defaultSyncState()), pendingDownload: value });
  });
}

const VALIDATION_RULES = ["edition_not_downloadable", "edition_not_available", "target_refs_invalid"] as const;

function validationRule(details: Readonly<Record<string, unknown>>): string | null {
  const fields = Array.isArray(details.fields) ? details.fields : [];
  for (const field of fields) {
    if (isRecord(field) && typeof field.rule === "string") return field.rule;
  }
  return typeof details.rule === "string" ? details.rule : null;
}

export function mapDownloadError(error: unknown): DownloadFailureCode {
  if (error instanceof ConnectivityError) return "connectivity";
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthenticated":
        return "unauthenticated";
      case "not_found":
        return "not_found";
      case "throttled":
        return "throttled";
      case "unavailable":
        return "unavailable";
      case "version_conflict": {
        const reason = error.details.reason;
        if (reason === "plan_not_active") return "plan_not_active";
        if (reason === "idempotency_input") return "idempotency_input";
        return "plan_version";
      }
      case "validation_error": {
        const rule = validationRule(error.details);
        return (VALIDATION_RULES as readonly string[]).includes(rule ?? "") ? (rule as DownloadFailureCode) : "failed";
      }
      default:
        return "failed";
    }
  }
  return "failed";
}

export const downloadPlanForOffline: DownloadPlanForOfflineFn = async (request, deps = {}) => {
  const phase = deps.onPhase ?? (() => undefined);
  if (!isOfflineStorageSupported()) return { ready: false, snapshotId: null, failureCode: "unsupported" };
  if (readLockMarker()) return { ready: false, snapshotId: null, failureCode: "locked" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ready: false, snapshotId: null, failureCode: "offline" };
  const client: ApiClient = deps.client ?? getApiRuntime().client;
  try {
    phase("checking_storage");
    const owner = await runTx(["ownerState"], "readonly", (ctx) => readOwnerInTx(ctx));
    if (owner?.clearFailed === true) return { ready: false, snapshotId: null, failureCode: "locked" };

    phase("waking_server");
    const wake = await waitForServer(client, { signal: deps.signal });
    if (wake === "aborted") return { ready: false, snapshotId: null, failureCode: "failed" };
    if (wake === "timed_out") return { ready: false, snapshotId: null, failureCode: "server_unreachable" };

    // The account that downloads is the account of this device (G-04): another owner has to be wiped first, never overwritten.
    let username = deps.username;
    if (username === undefined) username = (await createEndpoints(client).me()).username;
    if (owner !== undefined && owner.ownerId !== null && owner.username !== null && username !== null && owner.username.trim().toLowerCase() !== username.trim().toLowerCase()) {
      return { ready: false, snapshotId: null, failureCode: "owner_mismatch" };
    }

    phase("preparing");
    const download = await loadOrCreateDownload(request.planId, request.expectedPlanVersion, request.targetRefs ?? null);
    let snapshot: PlanSnapshot;
    try {
      snapshot = await createOfflineSnapshot(
        client,
        request.planId,
        {
          clientOperationId: download.clientOperationId,
          expectedPlanVersion: request.expectedPlanVersion,
          ...(request.targetRefs === undefined ? {} : { downloadTargetRefs: request.targetRefs }),
        },
        { signal: deps.signal },
      );
    } catch (error) {
      if (isAbortError(error)) return { ready: false, snapshotId: null, failureCode: "failed" };
      const code = mapDownloadError(error);
      // The server answered for this operation id: the stored attempt is spent, the next one starts a new id. A lost answer keeps it.
      if (code !== "connectivity" && code !== "throttled" && code !== "unavailable" && code !== "unauthenticated") await setPendingDownload(null).catch(() => undefined);
      return { ready: false, snapshotId: null, failureCode: code };
    }

    phase("validating");
    const sizeBytes = utf8Length(JSON.stringify(snapshot));
    if (!hasEnoughSpace(await estimateStorage(), sizeBytes)) return { ready: false, snapshotId: null, failureCode: "storage_insufficient", sizeBytes };

    phase("saving");
    const cached = await cacheActivePlan(snapshot, { username, sizeBytes });
    if (!cached.ready) return { ...cached, sizeBytes };
    await setPendingDownload(null).catch(() => undefined);
    // Best effort and never a promise: the browser may still evict (PWA-design 8).
    const persisted = await requestPersistence();
    phase("done");
    return { ...cached, sizeBytes, persisted };
  } catch (error) {
    if (isAbortError(error)) return { ready: false, snapshotId: null, failureCode: "failed" };
    if (error instanceof OfflineError) return { ready: false, snapshotId: null, failureCode: failureOf(error) };
    return { ready: false, snapshotId: null, failureCode: mapDownloadError(error) };
  }
};
