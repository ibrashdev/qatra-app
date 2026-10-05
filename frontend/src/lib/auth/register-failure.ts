import { ApiError, ConnectivityError, isAbortError } from "@/lib/api/errors";
import { pickPasswordRule, pickUsernameRule, type PasswordViolation, type UsernameViolation } from "./account-rules";
import { retryAfterSeconds } from "./retry-after";

// What S-02 does with each way E03 can fail (UI-screens S-02 "E03 mapping").
export type RegisterFailure =
  | { kind: "username_taken" } // G-08
  | { kind: "terms_outdated" } // the server wants a version this build has not shown: the reload banner (O-09)
  | { kind: "terms_missing" } // the version is the one shown: the field error at the box
  | { kind: "fields"; username: UsernameViolation | null; password: PasswordViolation | null } // validation_error the learner can fix
  | { kind: "throttled"; retryAfterSec: number } // G-15
  | { kind: "unavailable" } // G-17
  | { kind: "origin" } // G-05
  | { kind: "internal" } // G-16, and every validation_error the learner cannot fix
  | { kind: "uncertain" } // no answer outside the envelope: the account may exist (P-10)
  | { kind: "aborted" };

// The rule names of a validation_error, from details.fields. The shape is not trusted: anything else is an empty list.
function ruleNames(error: ApiError): string[] {
  const fields = error.details.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((entry: unknown) => {
    const rule = typeof entry === "object" && entry !== null ? (entry as { rule?: unknown }).rule : undefined;
    return typeof rule === "string" ? [rule] : [];
  });
}

// `bundledVersion` is the terms version this build shows on S-03 (null when the build was made without one).
export function classifyRegisterError(error: unknown, bundledVersion: string | null): RegisterFailure {
  if (error instanceof ConnectivityError) return { kind: "uncertain" };
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "username_taken":
        return { kind: "username_taken" };
      case "terms_required": {
        const required = error.details.requiredVersion;
        return typeof required === "string" && required === bundledVersion ? { kind: "terms_missing" } : { kind: "terms_outdated" };
      }
      case "validation_error": {
        const names = ruleNames(error);
        const username = pickUsernameRule(names);
        const password = pickPasswordRule(names);
        // time_zone_invalid, language_invalid and forbidden_field cannot be fixed by the learner, so they are an internal error.
        return username === null && password === null ? { kind: "internal" } : { kind: "fields", username, password };
      }
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
