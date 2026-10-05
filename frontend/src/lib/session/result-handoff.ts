import type { CompleteResponse } from "@/lib/api/types";

// S-19 keeps the E22 answer here before it opens S-20. S-20 never calls E22 itself: a reload or a direct visit finds nothing and goes to
// S-21 (/progress).
export interface SessionResult {
  sessionId: string;
  complete: CompleteResponse;
}

let held: SessionResult | null = null;

export function holdSessionResult(result: SessionResult): void {
  held = result;
}

export function peekSessionResult(sessionId: string): SessionResult | null {
  return held !== null && held.sessionId === sessionId ? held : null;
}

export function clearSessionResult(): void {
  held = null;
}
