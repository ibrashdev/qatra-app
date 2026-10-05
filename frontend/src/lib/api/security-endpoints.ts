import { THROTTLED_REQUEST_TIMEOUT_MS, type ApiClient, type RequestOptions } from "./client";
import type { Profile } from "./types";

// E09, E08 and E13 as the settings screens S-23, S-24 and S-27 use them (API-spec 4.2 and 4.3). Each one asks for the current password, and a wrong
// one counts under the login's username key, so the auth throttle can hold the answer for about 60 s (G-15): all three wait as long as login does.
// None is sent twice on its own: a retry is a new press, and the screen decides what an answer that never came means (P-10).

type PressOptions = Pick<RequestOptions, "signal">;

// E09: the password as typed, never trimmed or normalized. The answer replaces the session cookie and carries the profile.
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponse {
  profile: Profile;
}

// E08: the current password only. The answer carries the replacement recovery code, shown once (S-04).
export interface RotateRecoveryRequest {
  password: string;
}

export interface RotateRecoveryResponse {
  recoveryCode: string;
}

// E13: the client sends the literal itself, so nobody types a Latin word on an Arabic keyboard (UI-tokens A5).
export const DELETE_CONFIRMATION = "DELETE";

export interface DeleteAccountRequest {
  password: string;
  confirm: typeof DELETE_CONFIRMATION;
}

export function changePassword(client: ApiClient, request: ChangePasswordRequest, options?: PressOptions): Promise<ChangePasswordResponse> {
  return client.post<ChangePasswordResponse>("/auth/password", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}

export function rotateRecoveryCode(client: ApiClient, request: RotateRecoveryRequest, options?: PressOptions): Promise<RotateRecoveryResponse> {
  return client.post<RotateRecoveryResponse>("/auth/recovery/rotate", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}

// Answers 204 with the cookie cleared.
export function deleteAccount(client: ApiClient, request: DeleteAccountRequest, options?: PressOptions): Promise<void> {
  return client.post<void>("/account/delete", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}
