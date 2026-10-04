// P-09: a one-time arrival banner for the login screen, held in memory only. Never a URL parameter, never storage.
// Other screens raise it just before they send the visitor to /login; the login screen shows the strongest one once.

export type LoginArrival = "session_ended" | "reset_done" | "account_deleted";

// Strongest first (G-03, then the end of a recovery, then a deleted account).
const PRIORITY: readonly LoginArrival[] = ["session_ended", "reset_done", "account_deleted"];

const raised = new Set<LoginArrival>();

export function raiseLoginArrival(kind: LoginArrival): void {
  raised.add(kind);
}

// Reads without consuming, so a render can call it twice (development double render) and agree.
export function peekLoginArrival(): LoginArrival | null {
  return PRIORITY.find((kind) => raised.has(kind)) ?? null;
}

// Called once the banner is on screen: after that nothing is left to show.
export function clearLoginArrival(): void {
  raised.clear();
}
