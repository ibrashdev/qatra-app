import type { ApiError } from "@/lib/api/errors";

// A server that sends no usable wait is treated as the longest short wait of P-06. The ceiling keeps a wrong value from locking a form for good.
const FALLBACK_RETRY_AFTER_SEC = 60;
const MAX_RETRY_AFTER_SEC = 3600;

// The wait of a 429, in whole seconds, from `details.retryAfterSec` or the Retry-After header (the client has already read both).
export function retryAfterSeconds(error: ApiError): number {
  const wait = error.retryAfterSec;
  const seconds = wait !== null && Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : FALLBACK_RETRY_AFTER_SEC;
  return Math.min(seconds, MAX_RETRY_AFTER_SEC);
}
