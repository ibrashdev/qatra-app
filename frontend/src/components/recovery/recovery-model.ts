import { normalizeRecoveryCode } from "@/lib/api/account-endpoints";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { pickPasswordRule, type PasswordViolation } from "@/lib/auth/account-rules";
import { classifyCommonError, validationRuleNames, type CommonFailure } from "./account-failure";

// What S-05 step 1 says about the code field before anything is sent (UI-screens S-05 "Validation", O-11). Nothing is sent for either, so the
// throttle does not count it and nothing about an account is revealed.
export type CodeRule = "empty" | "format";

export function checkRecoveryCode(raw: string): CodeRule | null {
  if (raw === "") return "empty";
  return normalizeRecoveryCode(raw) === null ? "format" : null;
}

// The reset grant of E06, held in memory only (S-05 "Purpose and role"). `receivedAt` is a performance.now() value taken when the answer
// arrived, so the 600 s are counted from the response and never end earlier than the server's own count.
export interface ResetGrant {
  value: string;
  receivedAt: number;
  expiresInSec: number;
}

export const DEFAULT_GRANT_LIFETIME_SEC = 600;

export function makeResetGrant(answer: { resetGrant: string; expiresInSec: number }, now: number): ResetGrant {
  const lifetime = Number.isFinite(answer.expiresInSec) && answer.expiresInSec > 0 ? answer.expiresInSec : DEFAULT_GRANT_LIFETIME_SEC;
  return { value: answer.resetGrant, receivedAt: now, expiresInSec: lifetime };
}

// The client compares before E07 and sends nothing when the grant has lapsed (S-05 "Validation").
export function grantExpired(grant: ResetGrant, now: number): boolean {
  return now - grant.receivedAt >= grant.expiresInSec * 1000;
}

// What S-05 does with each way E06 can fail (UI-screens S-05 "E06 and E07 mapping").
export type VerifyFailure = { kind: "invalid" } | CommonFailure; // invalid: G-04, one message for an unknown name, a wrong, used or malformed code

export function classifyVerifyError(error: unknown): VerifyFailure {
  if (error instanceof ApiError && error.code === "invalid_credentials") return { kind: "invalid" };
  return classifyCommonError(error);
}

// And with each way E07 can fail. `invalid` is the same generic refusal for an expired, used or lost grant; `password` is a validation_error the
// learner can fix; `uncertain` is no answer at all, so the new password may or may not be set (P-10).
export type ResetFailure = { kind: "invalid" } | { kind: "password"; rule: PasswordViolation } | { kind: "uncertain" } | Exclude<CommonFailure, { kind: "connectivity" }>;

export function classifyResetError(error: unknown): ResetFailure {
  if (error instanceof ConnectivityError) return { kind: "uncertain" };
  if (error instanceof ApiError) {
    if (error.code === "invalid_credentials") return { kind: "invalid" };
    if (error.code === "validation_error") {
      const rule = pickPasswordRule(validationRuleNames(error));
      // A missing field or a rule of another name cannot be fixed by the learner: an internal error.
      return rule === null ? { kind: "internal" } : { kind: "password", rule };
    }
  }
  const common = classifyCommonError(error);
  // classifyCommonError reports connectivity only for a ConnectivityError, which is handled above.
  return common.kind === "connectivity" ? { kind: "uncertain" } : common;
}

// Why step 1 opens again after step 2: the generic refusal, with the extra line of P-10 when the attempt before it ended without an answer.
export interface RestartNotice {
  afterUncertain: boolean;
}
