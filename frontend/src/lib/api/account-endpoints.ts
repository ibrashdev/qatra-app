import { THROTTLED_REQUEST_TIMEOUT_MS, type ApiClient, type RequestOptions } from "./client";
import type { Profile } from "./types";

// E05, E06, E07 and E10 as the recovery screen (S-05) and the re-consent gate (S-06) use them. Kept apart from endpoints.ts while that file belongs
// to another package; the coordinator may move the four functions into `Endpoints`. They take the client of the runtime, so the mock layer and the
// real server behave alike. A credential or state-changing submit is never retried automatically: the caller decides what a retry does.

type PressOptions = Pick<RequestOptions, "signal">;

// E06 (API-spec 4.2): the recovery code as the server reads it, and the reset grant it hands back (valid 600 s, counted from the response).
export interface VerifyRecoveryRequest {
  username: string;
  recoveryCode: string;
}

export interface VerifyRecoveryResponse {
  resetGrant: string;
  expiresInSec: number;
}

// E07: the grant of E06 and the new password, never trimmed or normalized. The answer carries the replacement recovery code, shown once (S-04).
export interface ResetPasswordRequest {
  resetGrant: string;
  newPassword: string;
}

export interface ResetPasswordResponse {
  recoveryCode: string;
}

// E05: the version of the terms the learner has just seen. The server compares it with its own TERMS_VERSION.
export interface AcceptTermsRequest {
  termsVersion: string;
}

export interface AcceptTermsResponse {
  profile: Profile;
}

export const RECOVERY_CODE_LENGTH = 32;

const ARABIC_INDIC_ZERO = 0x0660;
const ARABIC_INDIC_NINE = 0x0669;

// The rule of E06 and of S-05 step 1 (O-11): dashes and spaces removed, Arabic-Indic digits written as 0 to 9, A to F as a to f; what is left
// must be exactly 32 hexadecimal characters. null means the text cannot be a recovery code, so nothing is sent and the throttle does not count it.
export function normalizeRecoveryCode(raw: string): string | null {
  const folded = Array.from(raw.replace(/[-\s]/g, ""))
    .map((char) => {
      const code = char.charCodeAt(0);
      return code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_NINE ? String(code - ARABIC_INDIC_ZERO) : char;
    })
    .join("")
    .toLowerCase();
  return /^[0-9a-f]+$/.test(folded) && folded.length === RECOVERY_CODE_LENGTH ? folded : null;
}

// E06 and E07 sit behind the auth throttle, which can hold an answer for about 60 s (G-15), so both wait as long as login does.
export function verifyRecovery(client: ApiClient, request: VerifyRecoveryRequest, options?: PressOptions): Promise<VerifyRecoveryResponse> {
  return client.post<VerifyRecoveryResponse>("/auth/recovery/verify", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}

export function resetPassword(client: ApiClient, request: ResetPasswordRequest, options?: PressOptions): Promise<ResetPasswordResponse> {
  return client.post<ResetPasswordResponse>("/auth/recovery/reset", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}

// E05 is naturally idempotent (the stored version already equal answers 200 with the unchanged profile), yet it is still sent once per press.
export function acceptTerms(client: ApiClient, request: AcceptTermsRequest, options?: PressOptions): Promise<AcceptTermsResponse> {
  return client.post<AcceptTermsResponse>("/auth/consent", request, { signal: options?.signal });
}

// E10: no body, answers 204 and clears the cookie; tolerant of a missing session, so a repeat is harmless.
export function logout(client: ApiClient, options?: PressOptions): Promise<void> {
  return client.post<void>("/auth/logout", undefined, { signal: options?.signal });
}
