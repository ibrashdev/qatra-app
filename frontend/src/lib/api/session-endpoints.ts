import type { ApiClient, RequestOptions, RetryPolicy } from "./client";
import type { CompleteResponse, EventsResponse, SessionEvent } from "./types";

// E20 (daily), E21 and E22 as the memorization session (S-19) uses them. Kept apart from endpoints.ts while that file belongs to another package;
// the coordinator may move them into `Endpoints`. They take the client of the runtime, so the mock layer and the real server behave alike.

// E20 `daily` is the get-or-create of today-endpoints.ts: the same body, 201 for a new session and 200 for the open one. Re-exported so the screen
// imports its three calls from one place. It creates a row on the first call, so it is never retried automatically (P-14).
export { dailySessionBody, startDailySession, type DailySessionBody, type StartDailySessionRequest } from "./today-endpoints";

// API-spec 4.7 E21: 1 to 100 events per request.
export const MAX_EVENTS_PER_REQUEST = 100;

type CallOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

const sessionPath = (sessionId: string, suffix: string): string => `/sessions/${encodeURIComponent(sessionId)}${suffix}`;

// E21 POST /api/sessions/:id/events. Idempotent by `clientEventId` (the first accepted payload for an id wins), so the call is marked safe to repeat:
// the caller keeps the same ids when it resends, and the server answers `duplicate` for what it already has. The body holds nothing but `events`.
export function postSessionEvents(client: ApiClient, sessionId: string, events: readonly SessionEvent[], options: CallOptions = {}): Promise<EventsResponse> {
  if (events.length < 1 || events.length > MAX_EVENTS_PER_REQUEST) {
    return Promise.reject(new RangeError(`E21 takes between 1 and ${MAX_EVENTS_PER_REQUEST} events.`));
  }
  return client.post<EventsResponse>(sessionPath(sessionId, "/events"), { events }, { ...options, idempotent: true });
}

// E22 may be sent again after a lost answer: a connectivity failure is retried twice at the client (1 s, 2 s), and the screen's button repeats it.
export const COMPLETE_RETRY_POLICY: RetryPolicy = { delaysMs: [1000, 2000] };

export interface CompleteOptions extends CallOptions {
  // The same key for every attempt of one finish (API-spec E22). Completion is idempotent per session, so the key adds no semantics in v1.
  idempotencyKey?: string;
}

// E22 POST /api/sessions/:id/complete: no body. It adds no time and creates no daily completion; repeating it returns the stored result.
export function completeSession(client: ApiClient, sessionId: string, options: CompleteOptions = {}): Promise<CompleteResponse> {
  const { idempotencyKey, retry = COMPLETE_RETRY_POLICY, ...rest } = options;
  return client.post<CompleteResponse>(sessionPath(sessionId, "/complete"), undefined, {
    ...rest,
    retry,
    idempotent: true,
    ...(idempotencyKey === undefined ? {} : { headers: { "Idempotency-Key": idempotencyKey } }),
  });
}
