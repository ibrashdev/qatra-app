// "Resumed" (S-19 "States"): in the same tab, a session left by «إيقاف مؤقت والخروج» continues at the step after the last one the learner finished.
// The position lives in page memory only. After a reload it is gone and the session starts at its first step (a re-answer is a new attempt; a review
// round counts the first attempt, UG-01).
const positions = new Map<string, number>();

export function rememberResume(sessionId: string, index: number): void {
  positions.set(sessionId, index);
}

// Read without removing it, so a development double render reads the same position; a finished session clears it.
export function peekResume(sessionId: string): number | null {
  return positions.get(sessionId) ?? null;
}

export function clearResume(sessionId: string): void {
  positions.delete(sessionId);
}

export function clearResumeForTests(): void {
  positions.clear();
}
