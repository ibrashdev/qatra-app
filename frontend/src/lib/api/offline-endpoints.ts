import type { ApiClient, RequestOptions, RetryPolicy } from "./client";
import type { PlanSnapshot, RevalidationResult } from "./types";

// E23, E24 and E25 of the offline plan (API-spec 4.12, approved with A-04 and A-12; decision G-01 makes `downloadTargetRefs` optional).
// They take the client of the runtime, like every endpoint file. None of them is cached by the browser or by the service worker: the client sends
// `cache: "no-store"` and the server answers `Cache-Control: no-store`. The cookie is the only credential; nothing here reads or stores a token.

// G-13: a snapshot is built server side on a free instance, so the call waits longer than a normal request (the wake-up loop runs before it).
export const OFFLINE_SNAPSHOT_TIMEOUT_MS = 60_000;

// The operation id makes a repeat harmless (E23 answers 200 with the same snapshot), so one connectivity failure may be retried at the client.
export const OFFLINE_SNAPSHOT_RETRY: RetryPolicy = { delaysMs: [2_000] };

type CallOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

export interface CreateOfflineSnapshotRequest {
  // A UUID made once per download attempt and stored before the call, so a lost answer is retried with the same id (API-spec E23 idempotency).
  clientOperationId: string;
  // Must equal the plan's current version, else 409 version_conflict (reason plan_version).
  expectedPlanVersion: number;
  // G-01: omitted, the server picks up to 60 passages from the learner's next new passage on. An empty array is still 422.
  downloadTargetRefs?: string[];
}

export interface RevalidateOfflineRequest {
  snapshotId: string;
  expectedPlanVersion: number;
  editionId: string;
  bankVersion: number;
}

const planPath = (planId: string): string => `/plans/${encodeURIComponent(planId)}/offline-snapshots`;
const snapshotPath = (snapshotId: string): string => `/offline-snapshots/${encodeURIComponent(snapshotId)}`;

// E23 POST /api/plans/:id/offline-snapshots. 201 for a new snapshot, 200 for the same snapshot when the operation id repeats with the same input.
// The body holds exactly these properties: the server rejects anything else with 422 forbidden_field.
export function createOfflineSnapshot(client: ApiClient, planId: string, request: CreateOfflineSnapshotRequest, options: CallOptions = {}): Promise<PlanSnapshot> {
  const body: CreateOfflineSnapshotRequest = {
    clientOperationId: request.clientOperationId,
    expectedPlanVersion: request.expectedPlanVersion,
    ...(request.downloadTargetRefs === undefined ? {} : { downloadTargetRefs: request.downloadTargetRefs }),
  };
  return client.post<PlanSnapshot>(planPath(planId), body, {
    timeoutMs: OFFLINE_SNAPSHOT_TIMEOUT_MS,
    retry: OFFLINE_SNAPSHOT_RETRY,
    ...options,
    idempotent: true,
  });
}

// E24 GET /api/offline-snapshots/:id. Read only: it never creates a session. 404 also covers a revoked edition (the reason comes from E25).
export function readOfflineSnapshot(client: ApiClient, snapshotId: string, options: CallOptions = {}): Promise<PlanSnapshot> {
  return client.get<PlanSnapshot>(snapshotPath(snapshotId), { timeoutMs: OFFLINE_SNAPSHOT_TIMEOUT_MS, ...options });
}

// E25 POST /api/offline/revalidate. The status is in the body of a 200, never an HTTP error. A wake-up timeout or an un-enveloped 5xx is connectivity,
// never a status. There is no lease and no lock, so the call is safe to repeat.
export function revalidateOffline(client: ApiClient, request: RevalidateOfflineRequest, options: CallOptions = {}): Promise<RevalidationResult> {
  const body: RevalidateOfflineRequest = {
    snapshotId: request.snapshotId,
    expectedPlanVersion: request.expectedPlanVersion,
    editionId: request.editionId,
    bankVersion: request.bankVersion,
  };
  return client.post<RevalidationResult>("/offline/revalidate", body, { ...options, idempotent: true });
}
