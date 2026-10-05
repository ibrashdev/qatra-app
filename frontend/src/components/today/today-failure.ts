import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { retryAfterSeconds } from "@/lib/auth/retry-after";

// What S-11 does with each way E18, E19 and E20 can fail (UI-screens S-11 section 4). The API `message` is never shown.
export type TodayFailure =
  | { kind: "session_ended" } // G-03
  | { kind: "connectivity" } // no usable answer: the wake-up and offline banners speak (P-04, P-05)
  | { kind: "unavailable" } // G-17
  | { kind: "internal" } // G-16
  | { kind: "origin" } // G-05
  | { kind: "throttled"; retryAfterSec: number } // G-15
  | { kind: "plan_version" } // G-09
  | { kind: "plan_not_active" } // G-11
  | { kind: "revoked" } // G-20
  | { kind: "aborted" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// `edition_not_available` is a 422 rule: the contract lists it among the `validation_error` codes, so it may sit in `code`, `details.reason` or a field rule.
function isRevoked(error: ApiError): boolean {
  if (error.code === "edition_not_available") return true;
  if (error.details.reason === "edition_not_available") return true;
  const { fields } = error.details;
  return Array.isArray(fields) && fields.some((field) => isRecord(field) && field.rule === "edition_not_available");
}

export function classifyTodayError(error: unknown): TodayFailure {
  if (error instanceof ConnectivityError) return { kind: "connectivity" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthenticated":
        return { kind: "session_ended" };
      case "unavailable":
        return { kind: "unavailable" };
      case "forbidden_origin":
        return { kind: "origin" };
      case "throttled":
        return { kind: "throttled", retryAfterSec: retryAfterSeconds(error) };
      case "version_conflict":
        if (error.details.reason === "plan_version") return { kind: "plan_version" };
        if (error.details.reason === "plan_not_active") return { kind: "plan_not_active" };
        break;
      default:
        if (isRevoked(error)) return { kind: "revoked" };
    }
  }
  return { kind: "internal" };
}

// An error raised by a press is read out at once; the others wait in the polite area (P-07).
export const isAlertFailure = (failure: TodayFailure): boolean => failure.kind === "internal" || failure.kind === "origin" || failure.kind === "revoked";
