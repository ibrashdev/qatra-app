import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { retryAfterSeconds } from "@/lib/auth/retry-after";

// What the content manager screens do with each way the admin API can fail (docs/Content-admin.md section 4, "Errors"). The API `message` is never
// shown; each kind has a line in the copy deck (admin-messages.ts and form-messages.ts).
export type AdminFailure =
  | { kind: "session_ended" } // 401 `unauthenticated`: back to sign-in with the page as `next`
  | { kind: "forbidden" } // 403 `forbidden`: the account is not a content manager
  | { kind: "connectivity" } // no usable answer: the wake-up and offline banners speak (P-04, P-05)
  | { kind: "unavailable" } // 503
  | { kind: "internal" }
  | { kind: "origin" } // 403 `forbidden_origin`
  | { kind: "throttled"; retryAfterSec: number } // 429
  | { kind: "not_found" } // 404
  | { kind: "stale" } // 409 `version_conflict`, reason `stale`: the row changed since it was read
  | { kind: "in_use" } // 409, reason `in_use`: something still uses it
  | { kind: "state" } // 409, reason `state`: not allowed in the current status
  | { kind: "invalid" } // 422 `validation_error`
  | { kind: "aborted" };

export function classifyAdminError(error: unknown): AdminFailure {
  if (error instanceof ConnectivityError) return { kind: "connectivity" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthenticated":
        return { kind: "session_ended" };
      case "forbidden":
        return { kind: "forbidden" };
      case "forbidden_origin":
        return { kind: "origin" };
      case "not_found":
        return { kind: "not_found" };
      case "validation_error":
        return { kind: "invalid" };
      case "unavailable":
        return { kind: "unavailable" };
      case "throttled":
        return { kind: "throttled", retryAfterSec: retryAfterSeconds(error) };
      case "version_conflict":
        switch (error.details.reason) {
          case "stale":
            return { kind: "stale" };
          case "in_use":
            return { kind: "in_use" };
          case "state":
            return { kind: "state" };
        }
        break;
    }
  }
  return { kind: "internal" };
}

// A failure the manager can undo by reading the data again: the row moved, vanished or changed state under them.
export const needsReload = (failure: AdminFailure): boolean => failure.kind === "stale" || failure.kind === "state" || failure.kind === "not_found";

// An error raised by a press is read out at once; the others wait in the polite area (P-07).
export function isAlertFailure(failure: AdminFailure): boolean {
  switch (failure.kind) {
    case "internal":
    case "origin":
    case "forbidden":
    case "invalid":
    case "stale":
    case "in_use":
    case "state":
    case "not_found":
      return true;
    default:
      return false;
  }
}
