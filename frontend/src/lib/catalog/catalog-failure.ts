import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { retryAfterSeconds } from "@/lib/auth/retry-after";

// What S-07 and S-25 do with each way E14 can fail (UI-screens S-07 and S-25 section 4). The API `message` is never shown.
// `session_ended` comes only from E18 on S-25: E14 is public, so it never answers 401.
export type CatalogFailure =
  | { kind: "connectivity" } // no usable answer: the wake-up and offline banners speak (P-04, P-05)
  | { kind: "unavailable" } // G-17
  | { kind: "internal" } // G-16
  | { kind: "origin" } // G-05
  | { kind: "throttled"; retryAfterSec: number } // G-15
  | { kind: "session_ended" } // G-03
  | { kind: "aborted" };

export function classifyCatalogError(error: unknown): CatalogFailure {
  if (error instanceof ConnectivityError) return { kind: "connectivity" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unavailable":
        return { kind: "unavailable" };
      case "forbidden_origin":
        return { kind: "origin" };
      case "throttled":
        return { kind: "throttled", retryAfterSec: retryAfterSeconds(error) };
    }
  }
  return { kind: "internal" };
}

// An error that appeared on its own is spoken at once when it is unexpected; the others wait in the polite area (P-07).
export const isAlertFailure = (failure: CatalogFailure): boolean => failure.kind === "internal" || failure.kind === "origin";
