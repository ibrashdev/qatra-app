import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";
import { ApiError } from "@/lib/api/errors";

// What S-19 does with each way E18, E20, E21 and E22 can fail (UI-screens S-19 "States", P-22). The kinds of S-11 carry over (a revoked edition, a moved
// plan, a throttle, an outage); a session adds two: the id the server does not know, and a request the server found too large.
export type SessionFailure = TodayFailure | { kind: "not_found" } | { kind: "too_large" };

export function classifySessionError(error: unknown): SessionFailure {
  if (error instanceof ApiError) {
    if (error.code === "not_found") return { kind: "not_found" };
    if (error.code === "payload_too_large") return { kind: "too_large" };
  }
  return classifyTodayError(error);
}

// A failure that is worth sending again by itself: nothing reached the server, or the server was out for a moment (E21 and E22 are idempotent).
export function retriesByItself(failure: SessionFailure): boolean {
  return failure.kind === "connectivity" || failure.kind === "unavailable";
}

// The finish of a session that is recorded on this device and owed to the server (E22): the run is complete here, the result is confirmed only after the
// server answers. It is shown in the place of a plain failure when the finish could not leave the device because of the connection or an unavailable
// free server (PWA-design 6). It is not an error: it is never classified from an exception, and nothing about the session is lost.
export type FinishPending = { kind: "finish_pending" };

export const FINISH_PENDING: FinishPending = { kind: "finish_pending" };

// Only a failure that is the connection's or the free server's own counts as "later": anything else (a throttle, a conflict, an internal error) says
// something the learner has to see as it is.
export function leavesFinishPending(failure: SessionFailure): boolean {
  return failure.kind === "connectivity" || failure.kind === "unavailable";
}
