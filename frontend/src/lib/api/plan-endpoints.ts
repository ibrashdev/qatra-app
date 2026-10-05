import type { ApiClient, RequestOptions } from "./client";
import type { Estimate, ISODate, Path, Plan, PlanOrder, TargetScope } from "./types";

// E15, E17 and E30 as the plan overview (S-12) and the plan revision (S-13) use them. Kept apart from endpoints.ts while that file belongs to
// another package; the coordinator may move the three functions into `Endpoints`. They take the client of the runtime, so the mock layer and the
// real server behave alike. None of them is retried automatically: E17 and E30 write, and E15 is only repeated by a press (P-14).

type PressOptions = Pick<RequestOptions, "signal">;

export type EstimateReason = "fits_preferred_date" | "exceeds_preferred_date" | "no_preferred_date";

// E15 (API-spec 4.5): no `placementSessionId` here, because S-13 does not send it (UG-07 is deferred).
export interface EstimateRequest {
  editionId: string;
  targetScope: TargetScope;
  paths: Path[];
  sessionMinutes: 5 | 10 | 15;
  preferredDate?: ISODate;
  order?: PlanOrder;
}

export interface EstimateResponse {
  estimate: Estimate;
  alternatives: Estimate[];
  reasonCode: EstimateReason;
}

// E17: the plan's version it was loaded at, and only the fields that changed. At least one of the optional fields must be present.
export interface RevisePlanRequest {
  expectedVersion: number;
  sessionMinutes?: 5 | 10 | 15;
  preferredDate?: ISODate;
  paths?: Path[];
  order?: PlanOrder;
  confirmedEstimate?: Estimate;
}

const planPath = (planId: string, suffix: string): string => `/plans/${encodeURIComponent(planId)}${suffix}`;

export function estimatePlan(client: ApiClient, request: EstimateRequest, options?: PressOptions): Promise<EstimateResponse> {
  return client.post<EstimateResponse>("/plans/estimate", request, { signal: options?.signal });
}

export function revisePlan(client: ApiClient, planId: string, request: RevisePlanRequest, options?: PressOptions): Promise<Plan> {
  return client.post<Plan>(planPath(planId, "/revise"), request, { signal: options?.signal });
}

// E30 has no body and is naturally idempotent, yet it is still sent once per press.
export function resumePlan(client: ApiClient, planId: string, options?: PressOptions): Promise<Plan> {
  return client.post<Plan>(planPath(planId, "/resume"), undefined, { signal: options?.signal });
}
