import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";
import { ApiError } from "@/lib/api/errors";

// What S-29 and S-30 do with each way E11, E27, E28 and E29 can fail. The failures of S-11 are reused as they are; the demo adds the three
// that only a demo endpoint raises. The API `message` is never shown.
export type DemoFailure =
  | TodayFailure
  | { kind: "forbidden" } // 403 on a demo operation: the account is not a demo account
  | { kind: "unknown_scenario" } // E28 422: the scenario left the published catalog since E27
  | { kind: "active_plan_conflict" }; // E28 409: another plan became active in between (G-13)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The rule names of a validation_error, from details.fields. The shape is not trusted: anything else is an empty list.
function ruleNames(error: ApiError): string[] {
  const { fields } = error.details;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((entry: unknown) => (isRecord(entry) && typeof entry.rule === "string" ? [entry.rule] : []));
}

export function classifyDemoError(error: unknown): DemoFailure {
  if (error instanceof ApiError) {
    if (error.code === "forbidden") return { kind: "forbidden" };
    if (error.code === "validation_error" && (error.details.reason === "unknown_scenario" || ruleNames(error).includes("unknown_scenario"))) return { kind: "unknown_scenario" };
    if (error.code === "version_conflict" && error.details.reason === "active_plan_conflict") return { kind: "active_plan_conflict" };
  }
  return classifyTodayError(error);
}

// The failures that go to the generic banner of S-11; the others have wording of their own or end the screen.
export function isTodayKind(failure: DemoFailure): failure is TodayFailure {
  return failure.kind !== "forbidden" && failure.kind !== "unknown_scenario" && failure.kind !== "active_plan_conflict";
}
