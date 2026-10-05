import type { ApiClient } from "@/lib/api/client";
import type {
  AnswerPayload,
  DailyProgress,
  EventsResponse,
  ISODateTime,
  OfflineEnvelope,
  OfflineStatus,
  PlanSnapshot,
  SessionEvent,
  SessionSnapshot,
} from "@/lib/api/types";

// FROZEN for the UI package (WP3). The record shapes and the public function types of lib/offline/* are declared here and nowhere else; the modules
// implement them with `export const fn: FnType = ...`. A change goes through the coordinator. PWA-design 4 and offline-spec 2.2 describe the design.

export const OFFLINE_DB_NAME = "qatra-offline";
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_SCHEMA_VERSION = 1;
export const OFFLINE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type OfflineErrorCode =
  | "unsupported" // no IndexedDB (private mode, very old browser)
  | "storage_failed" // a transaction failed
  | "quota_exceeded" // QuotaExceededError
  | "schema_too_new" // the stored database is newer than this app: do not open the plan, keep the outbox (PWA-design 8)
  | "owner_mismatch" // the record belongs to another account, or the device has no owner yet
  | "generation_mismatch" // the local copy was cleared after the caller started (another tab logged out)
  | "locked" // a clear failed: the personal view stays locked until the repair finishes
  | "clear_failed"
  | "invalid_snapshot"
  | "invalid_event"
  | "invalid_run"
  | "not_found";

export class OfflineError extends Error {
  override readonly name = "OfflineError";
  readonly code: OfflineErrorCode;
  constructor(code: OfflineErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.code = code;
  }
}

export function isOfflineError(value: unknown, code?: OfflineErrorCode): value is OfflineError {
  return value instanceof OfflineError && (code === undefined || value.code === code);
}

// Optional guard of every owner-scoped write: when set, the generation must still be the current one inside the same transaction.
export interface GuardOptions {
  generation?: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Stored records (IndexedDB database `qatra-offline`, version 1). No record holds a token, a cookie or a password.
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type StoreName = "ownerState" | "planSnapshots" | "activeRuns" | "pendingEvents" | "syncState";

// ownerState['current']. `ownerId` is null after a clear: the record stays so the generation keeps counting and `logoutPending` survives.
export interface OwnerState {
  ownerId: string | null; // PlanSnapshot.userId, a non-secret ownership id (G-04)
  username: string | null; // from E11 at download; the reconnect check compares it with E11 again
  generation: number; // bumped by every clear
  logoutPending: boolean; // an offline logout wiped the copy; POST /api/auth/logout is still owed
  clearFailed: boolean; // a clear failed: locked
  updatedAt: ISODateTime;
}

// planSnapshots, keyed by snapshotId (deviation from the composite key of offline-spec 2.2, so a staged download never overwrites a ready one).
export interface PlanSnapshotRecord {
  snapshotId: string;
  ownerId: string;
  generation: number;
  planId: string;
  editionId: string;
  bankVersion: number;
  planVersion: number;
  ready: boolean; // false while staged; flipped in one readwrite transaction after validation
  stagedAt: ISODateTime;
  readyAt: ISODateTime | null;
  sizeBytes: number;
  schemaVersion: number;
  retired: boolean; // superseded by a newer snapshot but kept while events or a run still refer to it
  snapshot: PlanSnapshot;
}

export type RunKind = "daily" | "game";
export type RunStatus = "active" | "finished" | "abandoned";

export interface RunAnswered {
  clientEventId: string;
  correct: boolean | null; // the provisional local verdict, null when feedback was unavailable
  assisted: boolean;
}

// activeRuns, keyed by clientRunId. A recall answer's text is never here: it lives in the outbox until the server has it.
export interface ActiveRunRecord {
  clientRunId: string;
  ownerId: string;
  generation: number;
  snapshotId: string;
  sessionId: string;
  kind: RunKind;
  stepIndex: number;
  answered: Record<string, RunAnswered>; // by questionId
  nextLocalSequence: number; // advanced in the same transaction as the enqueue that used it
  startedAt: ISODateTime;
  updatedAt: ISODateTime;
  status: RunStatus;
  extra: Record<string, string | number | boolean | null>; // small UI state, never answer text
}

export type EnvelopedEvent = SessionEvent & OfflineEnvelope;

export type PendingEventState = "queued" | "pending" | "blocked";

// pendingEvents, keyed by clientEventId. `sessionId` is the E21 path parameter; the event body never carries it.
export interface PendingEvent {
  clientEventId: string;
  ownerId: string;
  generation: number;
  snapshotId: string;
  sessionId: string;
  clientRunId: string;
  localSequence: number;
  state: PendingEventState;
  reasonCode?: string; // state 'pending': kept without credit, resent on a later foreground sync (D59)
  code?: string; // state 'blocked': rejected by the server (or locally blocked), never resent unchanged
  event: EnvelopedEvent;
  orderMs: number; // occurredAt (answer) or startedAt (activity), the replay order together with clientEventId
  attempts: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface OutboxCounts {
  queued: number;
  pending: number;
  blocked: number;
  total: number;
}

export interface RevalidationRecord {
  snapshotId: string;
  status: OfflineStatus;
  reasonCode: string;
  currentPlanVersion: number;
  allowedSessionRefs: string[];
  catalogVersion: number;
  at: ISODateTime;
}

export interface PendingDownload {
  planId: string;
  clientOperationId: string; // stored before E23 is called, reused by every retry of the same attempt
  expectedPlanVersion: number;
  targetRefs: string[] | null; // null: the server chooses (G-01)
  startedAt: ISODateTime;
}

export type SyncOutcome =
  | "completed"
  | "nothing_to_do"
  | "offline" // the browser says there is no connection
  | "server_unreachable" // the free server did not answer within the wake-up window (connectivity, never a status)
  | "unauthenticated" // E11 401: replay stops, the learner is asked to log in online, nothing is wiped
  | "owner_mismatch" // another account is signed in, or a 404 on E24/E25/E21 (G-04)
  | "locked" // the personal view is locked after a failed clear
  | "locked_elsewhere" // another tab holds the sync lock
  | "throttled"
  | "unavailable"
  | "schema_incompatible"
  | "failed";

// syncState['sync']. No tokens.
export interface SyncStateRecord {
  ownerId: string | null;
  lastSyncAt: ISODateTime | null;
  lastSyncOutcome: SyncOutcome | null;
  revalidations: Record<string, RevalidationRecord>; // by snapshotId
  pendingDownload: PendingDownload | null;
  retiredSessions: { sessionId: string; snapshotId: string; idempotencyKey: string }[]; // E22 owed after all their events were acknowledged (G-03)
  lease: { holderId: string; until: number } | null; // sync lock fallback when Web Locks are missing
  counts: OutboxCounts;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Results shared with the UI (PWA-design 4)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type CacheFailureCode =
  | "storage_quota"
  | "storage_insufficient" // free space below 3 times the snapshot size (G-13)
  | "storage_failed"
  | "unsupported"
  | "invalid_snapshot"
  | "hash_mismatch"
  | "owner_mismatch"
  | "locked"
  | "schema_too_new";

export interface CacheResult {
  ready: boolean;
  snapshotId: string | null;
  failureCode?: CacheFailureCode;
}

// Why a download failed, for the S-32 card. `connectivity` is never a status of the snapshot.
export type DownloadFailureCode =
  | CacheFailureCode
  | "offline"
  | "connectivity"
  | "server_unreachable"
  | "unauthenticated"
  | "plan_not_active"
  | "plan_version" // 409 version_conflict: the plan moved on, refresh and retry
  | "idempotency_input"
  | "edition_not_downloadable"
  | "edition_not_available"
  | "target_refs_invalid"
  | "not_found"
  | "throttled"
  | "unavailable"
  | "failed";

export interface DownloadRequest {
  planId: string;
  expectedPlanVersion: number;
  targetRefs?: string[]; // G-01: the card omits it
}

export interface DownloadResult extends Omit<CacheResult, "failureCode"> {
  failureCode?: DownloadFailureCode;
  sizeBytes?: number;
  persisted?: boolean | null; // navigator.storage.persist() answer when it was asked
}

export type DownloadPhase = "checking_storage" | "waking_server" | "preparing" | "validating" | "saving" | "done";

export interface SyncResult {
  acknowledgedIds: string[];
  pendingIds: string[];
  blockedIds: string[];
  reasonCode?: string;
  // Extra detail the UI may read.
  outcome: SyncOutcome;
  duplicateIds: string[];
  revalidations: RevalidationRecord[];
  daily: DailyProgress | null; // the last authoritative figure of the replay: it replaces the provisional local one
  retryAfterSec?: number | null;
}

export type SyncPhase = "idle" | "waiting_server" | "checking_account" | "revalidating" | "replaying" | "refreshing" | "done" | "stopped";
export type SyncTrigger = "app_open" | "reconnect" | "manual";

export interface SyncProgress {
  phase: SyncPhase;
  trigger: SyncTrigger | null;
  startedAt: number | null;
  waitedMs: number; // time spent waiting for the free server (G-01 line after a second, retry button at timed_out)
  timedOut: boolean; // the 90 s wake-up window ended: show «إعادة المحاولة»
  result: SyncResult | null;
}

export type LocalPlanStatus =
  | "none" // nothing downloaded
  | "incomplete" // a staged or half-written snapshot
  | "ready"
  | "stale" // E25 stale: display and new runs stop until a fresh download
  | "revoked"
  | "expired"
  | "locked"
  | "schema_incompatible"
  | "storage_error";

export interface LocalPlanInspection {
  status: LocalPlanStatus;
  owner: OwnerState | null;
  snapshot: PlanSnapshot | null; // null when none, incomplete, revoked or expired
  record: PlanSnapshotRecord | null;
  revalidation: RevalidationRecord | null;
  counts: OutboxCounts;
  failureCode?: OfflineErrorCode;
}

export type OwnerMatch = { kind: "none" } | { kind: "match"; owner: OwnerState } | { kind: "mismatch"; owner: OwnerState };

export interface LocalLogoutResult {
  discardedEvents: number; // unsynced answers deleted with the copy
  serverLogoutPending: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Service worker, install and update (lib/pwa)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type UpdatePhase = "idle" | "available" | "applying" | "failed";

export interface UpdateState {
  phase: UpdatePhase;
  failureCode?: "no_registration" | "activation_timeout" | "not_safe" | "schema_incompatible";
}

export type InstallKind =
  | "installed" // already standalone: show nothing
  | "available" // beforeinstallprompt was captured: show «تثبيت التطبيق»
  | "ios_instructions" // iOS Safari: Share, then Add to Home Screen
  | "in_app_browser" // online only: «افتح في المتصفح» (D67)
  | "unsupported"; // no install path: show nothing

export interface InstallState {
  kind: InstallKind;
  inAppBrowser: string | null;
}

export interface ShellStatus {
  supported: boolean; // secure context and service workers exist
  registered: boolean;
  controlled: boolean; // the page is controlled by a worker (reload once after the first install)
  shellReady: boolean; // the worker's cache holds every file of its allowlist
  buildId: string | null;
  missing: number;
}

export interface OfflineReadiness {
  shellReady: boolean;
  snapshotReady: boolean;
  ready: boolean; // shellReady AND snapshotReady, checked on every boot (PWA-design 4)
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Public function types of the modules (the modules export constants of these types)
// ---------------------------------------------------------------------------------------------------------------------------------------------

// db.ts
export type ClearAccountCacheFn = (ownerId?: string) => Promise<void>;

// owner.ts
export type ReadOwnerStateFn = () => Promise<OwnerState | null>;
export type IsOfflineLockedFn = () => Promise<boolean>;
export type MatchOwnerFn = (username: string) => Promise<OwnerMatch>;
export type AdoptOwnerFn = (input: { ownerId: string; username: string }) => Promise<OwnerState>;
// Login or registration as another username wipes the local copy first (G-04). Resolves true when something was wiped.
export type WipeIfDifferentAccountFn = (username: string) => Promise<boolean>;
export type LogoutLocallyFn = (options: { serverLogoutDone: boolean }) => Promise<LocalLogoutResult>;
export type ClearLocalCopyFn = () => Promise<{ discardedEvents: number }>;
export type CompletePendingLogoutFn = (client: ApiClient) => Promise<"none" | "done" | "failed">;

// plan-cache.ts
export type CacheActivePlanFn = (snapshot: PlanSnapshot, options?: { username?: string | null; sizeBytes?: number }) => Promise<CacheResult>;
export type ReadReadyPlanFn = (ownerId: string) => Promise<PlanSnapshot | null>; // null: nothing ready, stale, revoked, expired, another owner, incompatible
export type InspectLocalPlanFn = () => Promise<LocalPlanInspection>;
export type DownloadPlanForOfflineFn = (request: DownloadRequest, deps?: DownloadDeps) => Promise<DownloadResult>;
export type DeletePlanMaterialFn = (ownerId: string, snapshotId: string) => Promise<void>;
export type GetPreparedSessionFn = (ownerId: string, snapshotId: string, sessionId: string) => Promise<SessionSnapshot | null>;

export interface DownloadDeps {
  client?: ApiClient; // default: the runtime client
  username?: string | null; // E11 username at download; fetched through the client when missing
  onPhase?: (phase: DownloadPhase) => void;
  signal?: AbortSignal;
}

// outbox.ts
export type EnqueueEventFn = (ownerId: string, sessionId: string, event: EnvelopedEvent, options?: GuardOptions) => Promise<PendingEvent>;
export type EnqueueEventsFn = (ownerId: string, sessionId: string, events: readonly EnvelopedEvent[], options?: GuardOptions) => Promise<PendingEvent[]>;
export type ListPendingEventsFn = (ownerId: string) => Promise<PendingEvent[]>;
export type CountOutboxFn = (ownerId: string) => Promise<OutboxCounts>;

// run-store.ts
export type StartRunFn = (ownerId: string, input: { snapshotId: string; sessionId: string; kind: RunKind }, options?: GuardOptions) => Promise<ActiveRunRecord>;
export type SaveRunFn = (ownerId: string, clientRunId: string, patch: Partial<Pick<ActiveRunRecord, "stepIndex" | "answered" | "extra">>) => Promise<ActiveRunRecord>;
export type ReadRunFn = (ownerId: string, clientRunId: string) => Promise<ActiveRunRecord | null>;
export type ListRunsFn = (ownerId: string, status?: RunStatus) => Promise<ActiveRunRecord[]>;
export type FinishRunFn = (ownerId: string, clientRunId: string, status: "finished" | "abandoned") => Promise<void>;

// sync.ts
export type SyncForegroundFn = (ownerId: string, deps?: SyncDeps) => Promise<SyncResult>;

export interface SyncDeps {
  client?: ApiClient; // default: the runtime client
  trigger?: SyncTrigger;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  // Optional hook run after a replay: the UI re-reads E18/E19 here.
  afterReplay?: () => Promise<void>;
  // Seams for tests, never set by a screen: the clock and sleep of the wake-up loop, the online hint, the lock manager (null forces the IndexedDB lease
  // fallback), an id source, and the wake-up window.
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isOnline?: () => boolean;
  locks?: Pick<LockManager, "request"> | null;
  randomId?: () => string;
  maxWaitMs?: number;
}

// envelope.ts
export type AttachEnvelopeFn = (event: SessionEvent, envelope: OfflineEnvelope) => EnvelopedEvent;

// storage.ts
export interface StorageInfo {
  quota: number | null;
  usage: number | null;
  free: number | null;
}
export type EstimateStorageFn = () => Promise<StorageInfo | null>;
export type RequestPersistenceFn = () => Promise<boolean | null>;

// broadcast.ts
export type OfflineMessage =
  | { type: "OWNER_CLEARED"; generation: number }
  | { type: "SNAPSHOT_READY"; snapshotId: string }
  | { type: "OUTBOX_CHANGED" }
  | { type: "SYNC_DONE"; outcome: SyncOutcome }
  | { type: "UPDATE_PENDING" };
export type SubscribeOfflineMessagesFn = (handler: (message: OfflineMessage) => void) => () => void;

// games/evaluation.ts
export type ProvisionalFeedback =
  | { available: true; provisional: true; correct: boolean; assisted: boolean; expected: { order?: string[]; optionId?: string; word?: string } }
  | { available: false; provisional: true; reason: "policy_unsupported" | "policy_missing" };

export type { AnswerPayload, EventsResponse };
