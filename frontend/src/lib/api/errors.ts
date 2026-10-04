// Two error families, never mixed. ApiError: the server answered with the envelope, so branch on `code`, not on the status.
// ConnectivityError: no usable application answer; never a logout, never a reason to clear local data (D48, D70).

// The closed list of contract codes (API-spec 1.5).
export const API_ERROR_CODES = [
  "terms_required",
  "unauthenticated",
  "invalid_credentials",
  "forbidden_origin",
  "forbidden",
  "not_found",
  "username_taken",
  "version_conflict",
  "payload_too_large",
  "validation_error",
  "throttled",
  "unavailable",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// Keeps editor completion for the known codes while still accepting an unknown one.
export type AnyApiErrorCode = ApiErrorCode | (string & Record<never, never>);

export type ApiErrorDetails = Readonly<Record<string, unknown>>;

export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  details?: ApiErrorDetails;
  retryAfterSec?: number | null;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: AnyApiErrorCode;
  readonly details: ApiErrorDetails; // untrusted shape: guard before use
  readonly retryAfterSec: number | null; // from details.retryAfterSec or the Retry-After header (429)

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.retryAfterSec = init.retryAfterSec ?? null;
  }

  get isKnownCode(): boolean {
    return (API_ERROR_CODES as readonly string[]).includes(this.code);
  }
}

export type ConnectivityReason =
  | "network" // fetch itself failed: offline, DNS, refused, reset
  | "timeout" // the client request timeout fired
  | "gateway" // a 5xx outside the envelope, for example a sleeping free server
  | "invalid_response"; // any other answer that is not the documented JSON

const CONNECTIVITY_MESSAGES: Record<ConnectivityReason, string> = {
  network: "The network request failed.",
  timeout: "The request timed out.",
  gateway: "The server or a gateway answered outside the API error envelope.",
  invalid_response: "The answer was not a valid API response.",
};

export class ConnectivityError extends Error {
  override readonly name = "ConnectivityError";
  readonly reason: ConnectivityReason;
  readonly status: number | null; // set when an answer arrived

  constructor(reason: ConnectivityReason, options: { status?: number | null; cause?: unknown } = {}) {
    super(CONNECTIVITY_MESSAGES[reason], options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.status = options.status ?? null;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isConnectivityError(value: unknown): value is ConnectivityError {
  return value instanceof ConnectivityError;
}

export function hasApiErrorCode(value: unknown, code: ApiErrorCode): value is ApiError {
  return value instanceof ApiError && value.code === code;
}

// The only signal that the session ended: 401 with the code unauthenticated (G-03).
export function isSessionEnded(value: unknown): boolean {
  return hasApiErrorCode(value, "unauthenticated");
}

// A caller-initiated abort is not a failure and not a connectivity state.
export function isAbortError(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { name?: unknown }).name === "AbortError";
}
