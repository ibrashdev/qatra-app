import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";
import { ApiError } from "@/lib/api/errors";
import type { Estimate } from "@/lib/api/types";

// What S-12 and S-13 do with each way E15, E17, E18, E19, E30 and E31 can fail (UI-screens S-12 and S-13 section 4). The API `message` is never shown.
// The failures of S-11 are reused as they are; the screens add the three that only a write of the plan can raise.
export type PlanFailure =
  | TodayFailure
  | { kind: "forbidden" } // G-06
  | { kind: "not_found" } // G-07
  | { kind: "estimate_changed"; estimate: Estimate | null } // G-12
  | { kind: "validation"; rules: string[] }; // the rule names of `details.fields`

const TODAY_KINDS: ReadonlySet<string> = new Set(["session_ended", "connectivity", "unavailable", "internal", "origin", "throttled", "plan_version", "plan_not_active", "revoked", "aborted"]);

export function isTodayFailure(failure: PlanFailure): failure is TodayFailure {
  return TODAY_KINDS.has(failure.kind);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readEstimate(value: unknown): Estimate | null {
  if (!isRecord(value)) return null;
  const { days, endDate, newWordsPerDay, sessionMinutes } = value;
  if (typeof days !== "number" || typeof endDate !== "string" || typeof newWordsPerDay !== "number" || typeof sessionMinutes !== "number") return null;
  return value as unknown as Estimate;
}

function fieldRules(details: Readonly<Record<string, unknown>>): string[] {
  const { fields } = details;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((entry: unknown) => (isRecord(entry) && typeof entry.rule === "string" ? [entry.rule] : []));
}

export function classifyPlanError(error: unknown): PlanFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "forbidden":
        return { kind: "forbidden" };
      case "not_found":
        return { kind: "not_found" };
      case "version_conflict":
        if (error.details.reason === "estimate_changed") return { kind: "estimate_changed", estimate: readEstimate(error.details.estimate) };
        break;
      case "validation_error": {
        const today = classifyTodayError(error);
        return today.kind === "revoked" ? today : { kind: "validation", rules: fieldRules(error.details) };
      }
    }
  }
  return classifyTodayError(error);
}

// An error raised by a press is read out at once; the others wait in the polite area (P-07).
export function isAlertPlanFailure(failure: PlanFailure): boolean {
  return failure.kind === "internal" || failure.kind === "origin" || failure.kind === "revoked" || failure.kind === "validation";
}
