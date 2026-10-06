import { ApiError, ConnectivityError, isAbortError, type ConnectivityReason } from "./errors";
import { RequestMonitor, type RequestOutcome } from "./monitor";
import { abortError, sleep as defaultSleep } from "./sleep";

export const API_BASE_PATH = "/api";

// O-02 (request timeouts) is open in API-spec 1.7; these are the F0 defaults, to be confirmed when the first deployment is measured.
// 30 s bounds a normal call: warm latency targets are under 1 s and the model call is capped at 8 s.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// The auth throttle can hold an answer for about 60 s (G-15), so those calls pass this value.
export const THROTTLED_REQUEST_TIMEOUT_MS = 70_000;
// Wake-up probes are short requests, never one long one (API-spec 1.11).
export const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RetryPolicy {
  readonly delaysMs: readonly number[]; // one retry per entry, waiting that long before it
}

// Automatic retry is for reads only (G-02); a caller opts in per request.
export const READ_RETRY_POLICY: RetryPolicy = { delaysMs: [1000, 2000, 4000] };

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  // Marks a non-GET request as safe to repeat (E21 events carry clientEventId). Without it only GET may retry.
  idempotent?: boolean;
  retry?: RetryPolicy;
  // False for the health probes, so they never start another probe.
  track?: boolean;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  monitor?: RequestMonitor;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, "method" | "body">): Promise<T>;
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">): Promise<T>;
  patch<T>(path: string, body: unknown, options?: Omit<RequestOptions, "method" | "body">): Promise<T>;
}

function toUrl(path: string): string {
  // Same origin only: the cookie must never travel to another host.
  if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]|\.\.|:\/\//.test(path)) {
    throw new TypeError(`Invalid API path: ${path}`);
  }
  return `${API_BASE_PATH}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readEnvelope(value: unknown): { code: string; message: string; details: Record<string, unknown> } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message, details } = value.error;
  if (typeof code !== "string" || !/^[a-z][a-z0-9_]*$/.test(code)) return null;
  if (typeof message !== "string") return null;
  if (details !== undefined && !isRecord(details)) return null;
  return { code, message, details: details ?? {} };
}

function readRetryAfterSec(response: Response, details: Record<string, unknown>): number | null {
  const fromDetails = details.retryAfterSec;
  if (typeof fromDetails === "number" && Number.isFinite(fromDetails) && fromDetails >= 0) return fromDetails;
  const header = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
  return Number.isFinite(header) && header >= 0 ? header : null;
}

function parseResponse<T>(response: Response, text: string): T {
  const { status } = response;
  if (response.ok) {
    if (status === 204) return undefined as T;
    const json = tryParseJson(text);
    if (json === undefined) throw new ConnectivityError("invalid_response", { status });
    return json as T;
  }
  const envelope = readEnvelope(tryParseJson(text));
  if (envelope) {
    throw new ApiError({
      status,
      code: envelope.code,
      message: envelope.message,
      details: envelope.details,
      retryAfterSec: readRetryAfterSec(response, envelope.details),
    });
  }
  // No envelope: a gateway or the platform answered, not the application.
  throw new ConnectivityError(status >= 500 ? "gateway" : "invalid_response", { status });
}

function outcomeOf(error: unknown): RequestOutcome {
  if (error instanceof ApiError) return "api_error";
  if (error instanceof ConnectivityError) return "connectivity";
  return isAbortError(error) ? "aborted" : "connectivity";
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;

  async function attempt<T>(url: string, method: HttpMethod, request: RequestOptions): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? defaultTimeoutMs);
    const onCallerAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const failure = (cause: unknown): Error => {
      if (timedOut) return new ConnectivityError("timeout", { cause });
      if (request.signal?.aborted) return abortError();
      return new ConnectivityError("network", { cause });
    };

    try {
      if (request.signal?.aborted) throw abortError();
      const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
      if (request.body !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        text = await response.text();
      } catch (cause) {
        throw failure(cause);
      }
      return parseResponse<T>(response, text);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async function run<T>(path: string, request: RequestOptions): Promise<T> {
    const method = request.method ?? "GET";
    if (method === "GET" && request.body !== undefined) throw new TypeError("A GET request cannot have a body.");
    const url = toUrl(path);
    const retryDelays = method === "GET" || request.idempotent === true ? (request.retry?.delaysMs ?? []) : [];
    const monitor = request.track === false ? undefined : options.monitor;
    const monitorId = monitor?.start();
    let outcome: RequestOutcome = "success";
    let reason: ConnectivityReason | undefined;
    try {
      for (let index = 0; ; index += 1) {
        try {
          return await attempt<T>(url, method, request);
        } catch (error) {
          const delay = retryDelays[index];
          if (error instanceof ConnectivityError && delay !== undefined && !request.signal?.aborted) {
            await sleep(delay, request.signal);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      outcome = outcomeOf(error);
      if (error instanceof ConnectivityError) reason = error.reason;
      throw error;
    } finally {
      if (monitor !== undefined && monitorId !== undefined) monitor.settle(monitorId, outcome, reason);
    }
  }

  return {
    request: (path, request = {}) => run(path, request),
    get: (path, request = {}) => run(path, { ...request, method: "GET" }),
    post: (path, body, request = {}) => run(path, { ...request, method: "POST", body }),
    patch: (path, body, request = {}) => run(path, { ...request, method: "PATCH", body }),
  };
}
