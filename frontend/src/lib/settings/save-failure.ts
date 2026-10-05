import { ApiError, isAbortError } from "@/lib/api/errors";

// What S-22 does with each way E12 can fail (UI-screens S-22 "E12 mapping"). The API `message` is never shown.
// `failed` is `internal`, no answer at all, and everything the learner cannot fix: `validation_error` and `forbidden_field` (every value comes from
// a fixed list), a throttle (E10 to E12 have none), and a code this screen has no copy for.
export type SaveFailure =
  | { kind: "session_ended" } // G-03
  | { kind: "unavailable" } // G-17
  | { kind: "origin" } // G-05
  | { kind: "failed" }
  | { kind: "aborted" };

export function classifySaveError(error: unknown): SaveFailure {
  if (isAbortError(error)) return { kind: "aborted" };
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthenticated":
        return { kind: "session_ended" };
      case "unavailable":
        return { kind: "unavailable" };
      case "forbidden_origin":
        return { kind: "origin" };
    }
  }
  return { kind: "failed" };
}
