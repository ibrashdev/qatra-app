import { HEALTH_REQUEST_TIMEOUT_MS, THROTTLED_REQUEST_TIMEOUT_MS, type ApiClient, type RequestOptions } from "./client";
import { ConnectivityError } from "./errors";
import type { CatalogResponse, HealthResponse, LoginRequest, LoginResponse, Profile, RegisterRequest, RegisterResponse, Today } from "./types";

type ReadOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

export interface HealthOptions {
  signal?: AbortSignal;
  // Probes are untracked. The first request of a page load passes true, so the wake-up logic watches it.
  track?: boolean;
}

// Only the operations the screens built so far call; later packages add theirs here.
export interface Endpoints {
  health(options?: HealthOptions): Promise<HealthResponse>; // E01
  register(request: RegisterRequest, options?: Pick<RequestOptions, "signal">): Promise<RegisterResponse>; // E03
  login(request: LoginRequest, options?: Pick<RequestOptions, "signal">): Promise<LoginResponse>; // E04
  me(options?: ReadOptions): Promise<Profile>; // E11
  catalog(options?: ReadOptions): Promise<CatalogResponse>; // E14
  today(options?: ReadOptions): Promise<Today>; // E18
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "ok";
}

export function createEndpoints(client: ApiClient): Endpoints {
  return {
    async health({ signal, track = false } = {}) {
      const body = await client.get<unknown>("/health", { signal, track, timeoutMs: HEALTH_REQUEST_TIMEOUT_MS });
      // A sleeping server can answer 200 with a platform page, so the body has to say ok.
      if (!isHealthResponse(body)) throw new ConnectivityError("invalid_response");
      return body;
    },
    // The auth throttle can hold the answer for about 60 s (G-15). A credential submit is never retried.
    // Registration waits as long, though nothing holds its answer: a cold free server may need that, and a client timeout would turn a
    // success into an uncertain outcome (P-10).
    register: (request, options) => client.post<RegisterResponse>("/auth/register", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS }),
    login: (request, options) => client.post<LoginResponse>("/auth/login", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS }),
    me: (options) => client.get<Profile>("/me", options),
    catalog: (options) => client.get<CatalogResponse>("/catalog", options),
    today: (options) => client.get<Today>("/today", options),
  };
}

export async function probeHealth(endpoints: Endpoints, signal: AbortSignal): Promise<boolean> {
  try {
    await endpoints.health({ signal });
    return true;
  } catch {
    return false;
  }
}
