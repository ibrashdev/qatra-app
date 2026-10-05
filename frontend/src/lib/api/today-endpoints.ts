import type { ApiClient, RequestOptions } from "./client";
import type { ProgressResponse, SessionSnapshot } from "./types";

// E19 and E20 as the plan and today screen (S-11) uses them. Kept apart from endpoints.ts while that file belongs to another package; the
// coordinator may move both functions into `Endpoints`. They take the client of the runtime, so the mock layer and the real server behave alike.

type ReadOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

// E20 `daily` (API-spec 4.7): the body is exactly these three properties, and `expectedPlanVersion` must equal the plan's `currentVersion`.
export interface StartDailySessionRequest {
  planId: string;
  planVersion: number;
}

export type DailySessionBody = { kind: "daily"; planId: string; expectedPlanVersion: number };

export const dailySessionBody = ({ planId, planVersion }: StartDailySessionRequest): DailySessionBody => ({
  kind: "daily",
  planId,
  expectedPlanVersion: planVersion,
});

// E19 GET /api/progress: no query parameters.
export function getProgress(client: ApiClient, options?: ReadOptions): Promise<ProgressResponse> {
  return client.get<ProgressResponse>("/progress", options);
}

// E20 POST /api/sessions with kind "daily": an atomic get-or-create, so a second call the same day returns the open session (200) and the
// first creates one (201). The client returns the body for both. A row-creating call is never retried automatically (P-14).
export function startDailySession(client: ApiClient, request: StartDailySessionRequest, options?: Pick<RequestOptions, "signal">): Promise<SessionSnapshot> {
  return client.post<SessionSnapshot>("/sessions", dailySessionBody(request), { signal: options?.signal });
}
