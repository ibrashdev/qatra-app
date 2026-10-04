import { HEALTH_REQUEST_TIMEOUT_MS, type ApiClient, type RequestOptions } from "./client";
import { ConnectivityError } from "./errors";
import type { CatalogResponse, HealthResponse, Profile, Today } from "./types";

type ReadOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

export interface HealthOptions {
  signal?: AbortSignal;
  // Probes are untracked. The first request of a page load passes true, so the wake-up logic watches it.
  track?: boolean;
}

// Only the operations F0 mocks; later packages add theirs here.
export interface Endpoints {
  health(options?: HealthOptions): Promise<HealthResponse>; // E01
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
