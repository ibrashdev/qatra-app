import { classifyCommonError, validationRuleNames, type CommonFailure } from "@/components/recovery/account-failure";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { pickPasswordRule, type PasswordViolation } from "@/lib/auth/account-rules";

// What S-23, S-24 and S-27 do with each way E09, E08 and E13 can fail (UI-screens P-27 and the "mapping" paragraphs of the three screens).
export type SecurityFailure =
  | { kind: "session_ended" } // G-03: `401 unauthenticated`
  | { kind: "credentials" } // G-04, re-authentication: the current password is wrong
  | { kind: "password"; rule: PasswordViolation } // E09 only: a rule of the new password that the learner can fix
  | { kind: "uncertain" } // no answer at all: the request may or may not have been applied (P-10)
  | Exclude<CommonFailure, { kind: "connectivity" }>;

// `newPassword` is true for E09, the only call whose validation_error the learner can fix. For E08 and E13 any validation_error is `internal`
// (E13 `confirm_literal` cannot arise: the client sends the literal itself).
export function classifySecurityError(error: unknown, { newPassword = false }: { newPassword?: boolean } = {}): SecurityFailure {
  // These three calls change something on the server, so an answer that never came is never read as "nothing happened".
  if (error instanceof ConnectivityError) return { kind: "uncertain" };
  if (error instanceof ApiError) {
    if (error.code === "unauthenticated") return { kind: "session_ended" };
    if (error.code === "invalid_credentials") return { kind: "credentials" };
    if (newPassword && error.code === "validation_error") {
      const rule = pickPasswordRule(validationRuleNames(error));
      return rule === null ? { kind: "internal" } : { kind: "password", rule };
    }
  }
  const common = classifyCommonError(error);
  // classifyCommonError reports connectivity only for a ConnectivityError, which is handled above.
  return common.kind === "connectivity" ? { kind: "uncertain" } : common;
}
