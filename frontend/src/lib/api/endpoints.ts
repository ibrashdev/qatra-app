import { HEALTH_REQUEST_TIMEOUT_MS, THROTTLED_REQUEST_TIMEOUT_MS, type ApiClient, type RequestOptions } from "./client";
import { ConnectivityError } from "./errors";
import type {
  CatalogResponse,
  ConfirmPlanChatRequest,
  CreatePlanChatRequest,
  HealthResponse,
  LoginRequest,
  LoginResponse,
  Plan,
  PlanChat,
  PlanChatTurnRequest,
  Profile,
  RegisterRequest,
  RegisterResponse,
  Today,
} from "./types";

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
  // Plan conversation (D75). E31, E32 and E34 create rows, so none is retried automatically (P-14); the caller decides what a retry does.
  createPlanChat(request: CreatePlanChatRequest, options?: Pick<RequestOptions, "signal">): Promise<PlanChat>; // E31
  sendPlanChatTurn(chatId: string, request: PlanChatTurnRequest, options?: Pick<RequestOptions, "signal">): Promise<PlanChat>; // E32
  planChat(chatId: string, options?: ReadOptions): Promise<PlanChat>; // E33
  confirmPlanChat(chatId: string, request: ConfirmPlanChatRequest, options?: Pick<RequestOptions, "signal">): Promise<Plan>; // E34
}

const chatPath = (chatId: string, suffix = ""): string => `/plan-chats/${encodeURIComponent(chatId)}${suffix}`;

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
    createPlanChat: (request, options) => client.post<PlanChat>("/plan-chats", request, { signal: options?.signal }),
    sendPlanChatTurn: (chatId, request, options) => client.post<PlanChat>(chatPath(chatId, "/messages"), request, { signal: options?.signal }),
    planChat: (chatId, options) => client.get<PlanChat>(chatPath(chatId), options),
    confirmPlanChat: (chatId, request, options) => client.post<Plan>(chatPath(chatId, "/confirm"), request, { signal: options?.signal }),
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
