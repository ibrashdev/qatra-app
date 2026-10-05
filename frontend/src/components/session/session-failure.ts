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
