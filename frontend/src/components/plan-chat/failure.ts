import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { retryAfterSeconds } from "@/lib/auth/retry-after";

// What S-34 does with each way E31 to E34 can fail (UI-screens S-34 "States", API-spec 4.10.1).
export type ChatFailure =
  | { kind: "session_ended" } // G-03
  | { kind: "not_found" } // G-36
  | { kind: "chat_closed" } // G-38
  | { kind: "proposal_stale" } // G-37
  | { kind: "plan_version" } // G-09
  | { kind: "active_plan_conflict" } // G-13
  | { kind: "plan_not_active" } // G-11
  | { kind: "validation"; rules: string[] } // the rule names of `details.fields`
  | { kind: "throttled"; retryAfterSec: number } // G-15
  | { kind: "unavailable" } // G-17
  | { kind: "origin" } // G-05
  | { kind: "internal" } // G-16
  | { kind: "connectivity" } // no usable answer: the wake-up and offline banners speak
  | { kind: "aborted" };

function fieldRules(details: Readonly<Record<string, unknown>>): string[] {
  const fields = details.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((entry: unknown) => {
    const rule = typeof entry === "object" && entry !== null ? (entry as { rule?: unknown }).rule : undefined;
    return typeof rule === "string" ? [rule] : [];
  });
}

export function classifyChatError(error: unknown): ChatFailure {
  if (error instanceof ConnectivityError) return { kind: "connectivity" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthenticated":
        return { kind: "session_ended" };
      case "not_found":
        return { kind: "not_found" };
      case "throttled":
        return { kind: "throttled", retryAfterSec: retryAfterSeconds(error) };
      case "unavailable":
        return { kind: "unavailable" };
      case "forbidden_origin":
        return { kind: "origin" };
      case "validation_error":
        return { kind: "validation", rules: fieldRules(error.details) };
      case "version_conflict": {
        const reason = error.details.reason;
        if (reason === "chat_closed" || reason === "proposal_stale" || reason === "plan_version" || reason === "active_plan_conflict" || reason === "plan_not_active") {
          return { kind: reason };
        }
        break;
      }
    }
  }
  // internal, or a code this screen has no copy for.
  return { kind: "internal" };
}
