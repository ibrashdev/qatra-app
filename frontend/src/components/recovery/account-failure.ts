import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { retryAfterSeconds } from "@/lib/auth/retry-after";

// The ways a credential or state-changing call fails that the account screens answer alike (UI-screens P-04 to P-07). A screen looks for the codes
// of its own first (G-04, G-18, G-03) and falls back to this.
export type CommonFailure =
  | { kind: "throttled"; retryAfterSec: number } // G-15
  | { kind: "unavailable" } // G-17
  | { kind: "origin" } // G-05
  | { kind: "internal" } // G-16, a validation_error the learner cannot fix, and a code this screen has no copy for
  | { kind: "connectivity" } // no usable answer: the wake-up and offline banners speak
  | { kind: "aborted" };

export function classifyCommonError(error: unknown): CommonFailure {
  if (error instanceof ConnectivityError) return { kind: "connectivity" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "throttled":
        return { kind: "throttled", retryAfterSec: retryAfterSeconds(error) };
      case "unavailable":
        return { kind: "unavailable" };
      case "forbidden_origin":
        return { kind: "origin" };
    }
  }
  return { kind: "internal" };
}

// The rule names of a validation_error, from details.fields. The shape is not trusted: anything else is an empty list.
export function validationRuleNames(error: ApiError): string[] {
  const fields = error.details.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((entry: unknown) => {
    const rule = typeof entry === "object" && entry !== null ? (entry as { rule?: unknown }).rule : undefined;
    return typeof rule === "string" ? [rule] : [];
  });
}
