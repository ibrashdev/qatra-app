import { ApiError } from "@/lib/api/errors";
import { classifyCommonError, type CommonFailure } from "@/components/recovery/account-failure";

// What S-06 does with each way E05 can fail (UI-screens S-06 "E05 mapping"). `validation_error` is treated as an internal error: the client sends
// one string and checks it first, so the learner cannot fix it.
export type ConsentFailure =
  | { kind: "terms_outdated" } // the server wants a version this build has not shown: the reload banner (O-09)
  | { kind: "session_ended" } // G-03: S-01 with the session-ended banner
  | CommonFailure;

export function classifyConsentError(error: unknown): ConsentFailure {
  if (error instanceof ApiError) {
    if (error.code === "terms_required") return { kind: "terms_outdated" };
    if (error.code === "unauthenticated") return { kind: "session_ended" };
  }
  return classifyCommonError(error);
}

// E10 is tolerant, so a 401 means the session is already gone, which is what the learner asked for. Any other failure keeps them on the screen.
export function logoutAlreadyDone(error: unknown): boolean {
  return error instanceof ApiError && error.code === "unauthenticated";
}
