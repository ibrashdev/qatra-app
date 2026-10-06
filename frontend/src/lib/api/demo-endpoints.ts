import { THROTTLED_REQUEST_TIMEOUT_MS, type ApiClient, type RequestOptions } from "./client";
import type { Plan, RegisterRequest, RegisterResponse, TargetScope } from "./types";

// E26 to E29 as the demo screens (S-28, S-29, S-30) use them. Kept apart from endpoints.ts while that file belongs to another package; the
// functions take the client of the runtime, so the mock layer and the real server behave alike. E26 and E28 create rows, so neither is ever
// retried automatically (P-14): a press is the retry. The client sends no `isDemo` and no mode: the server decides both (API-spec 4.9).

type PressOptions = Pick<RequestOptions, "signal">;
type ReadOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

// E27: a scenario the server could resolve against the published catalog. The goal text of the fixture never leaves the server.
export interface DemoScenario {
  scenarioId: string;
  titleAr: string;
  titleEn: string;
  editionKey: string;
  targetScope: TargetScope;
}

export interface DemoScenariosResponse {
  scenarios: DemoScenario[];
}

// E28: the scenario id is all there is. No goal text, no placement answers; `placementSessionId` is optional and not sent by S-29 (phase 1).
export interface CreateDemoPlanRequest {
  scenarioId: string;
  placementSessionId?: string;
}

export type SimulationAdjustment = "absence_light_review" | "error_priority" | "pace_reduced";

export interface DemoSimulationDay {
  day: number;
  newWords: number;
  reviews: number;
  lightReviewDay: boolean;
  adjustment: SimulationAdjustment | null;
  confirmedWordsCumulative: number;
  overallPercent: number;
}

// E29 element (the fixture schema of the demo decisions): precomputed from a scripted learner, never a live run.
export interface DemoSimulation {
  simulationId: string;
  scenarioId: string;
  titleAr: string;
  titleEn: string;
  label: "precomputed_synthetic";
  profile: { name: string; totalWords: number; sessionMinutes: number };
  learnerScript: { dailyCorrectRate: number; absentDays: number[]; errorDays: number[] };
  days: DemoSimulationDay[];
}

export interface DemoSimulationsResponse {
  simulations: DemoSimulation[];
}

// E26: the body of E03. Waits as long as registration does: a client timeout would turn a success into an uncertain outcome (P-10).
export function registerDemo(client: ApiClient, request: RegisterRequest, options?: PressOptions): Promise<RegisterResponse> {
  return client.post<RegisterResponse>("/demo/accounts", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}

export function listDemoScenarios(client: ApiClient, options?: ReadOptions): Promise<DemoScenariosResponse> {
  return client.get<DemoScenariosResponse>("/demo/scenarios", options);
}

// E28 waits for the model call (up to 8 s) and the processing, so it has the long timeout too: giving up early would hide a plan that was built.
export function createDemoPlan(client: ApiClient, request: CreateDemoPlanRequest, options?: PressOptions): Promise<Plan> {
  return client.post<Plan>("/demo/plans", request, { signal: options?.signal, timeoutMs: THROTTLED_REQUEST_TIMEOUT_MS });
}

export function listDemoSimulations(client: ApiClient, options?: ReadOptions): Promise<DemoSimulationsResponse> {
  return client.get<DemoSimulationsResponse>("/demo/simulations", options);
}
