import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { runTx } from "@/lib/offline/db";
import { uuid } from "./offline-support";

// Fixtures of the online journal (synthetic): events as an ordinary online session makes them, never enveloped.

export const ONLINE_SESSION = "55555555-5555-4555-8555-555555555581";
export const OTHER_ONLINE_SESSION = "55555555-5555-4555-8555-555555555582";

const BASE_MS = Date.parse("2026-10-06T10:00:00.000Z");

export function onlineAnswerAt(offsetMs = 0, overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    clientEventId: uuid(),
    type: "answer",
    questionId: "q-choice",
    answer: { optionId: "q-choice-a" },
    hintUsed: false,
    occurredAt: new Date(BASE_MS + offsetMs).toISOString(),
    durationMs: 1500,
    ...overrides,
  } as SessionEvent;
}

export function onlineActivityAt(offsetMs = 0, spanMs = 5000, overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    clientEventId: uuid(),
    type: "activity",
    startedAt: new Date(BASE_MS + offsetMs).toISOString(),
    endedAt: new Date(BASE_MS + offsetMs + spanMs).toISOString(),
    activeMs: spanMs,
    ...overrides,
  } as SessionEvent;
}

export function eventsResponse(partial: Partial<EventsResponse> = {}): EventsResponse {
  return {
    acknowledged: [],
    duplicate: [],
    pending: [],
    rejected: [],
    results: [],
    daily: { learningDate: "2026-10-06", dailyActiveMs: 0, dailyGoalMs: 600_000, dailyPercent: 0, dailyCompleted: false, extraActiveMs: 0 },
    ...partial,
  };
}

// Reads a whole store as it is on disk (the shared dump helper only knows the version 1 stores by name).
export async function dumpStore(name: string): Promise<unknown[]> {
  return runTx(["ownerState", "planSnapshots", "activeRuns", "pendingEvents", "syncState", "onlineRuns", "onlineEvents"], "readonly", (ctx) => ctx.all(name as "onlineEvents"));
}
