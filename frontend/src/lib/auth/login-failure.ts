import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";

// What S-01 does with each way E04 can fail (UI-screens S-01 "E04 mapping").
export type LoginFailure =
  | { kind: "credentials" } // G-04
  | { kind: "throttled"; retryAfterSec: number } // G-15
  | { kind: "unavailable" } // G-17
  | { kind: "origin" } // G-05
  | { kind: "internal" } // G-16
  | { kind: "connectivity" } // no usable answer: the wake-up and offline banners speak
  | { kind: "aborted" };

// A server that sends no usable wait is treated as the longest short wait of P-06. The ceiling keeps a wrong value from locking the form for good.
const FALLBACK_RETRY_AFTER_SEC = 60;
const MAX_RETRY_AFTER_SEC = 3600;

export function classifyLoginError(error: unknown): LoginFailure {
  if (error instanceof ConnectivityError) return { kind: "connectivity" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "invalid_credentials":
        return { kind: "credentials" };
      case "throttled": {
        const wait = error.retryAfterSec;
        const seconds = wait !== null && Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : FALLBACK_RETRY_AFTER_SEC;
        return { kind: "throttled", retryAfterSec: Math.min(seconds, MAX_RETRY_AFTER_SEC) };
      }
      case "unavailable":
        return { kind: "unavailable" };
      case "forbidden_origin":
        return { kind: "origin" };
    }
  }
  // internal, a validation_error (the client checks first, so it cannot happen), or a code this screen has no copy for.
  return { kind: "internal" };
}
