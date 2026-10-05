// P-09: a one-time arrival banner for the login screen, held in memory only. Never a URL parameter, never storage.
// Other screens raise it just before they send the visitor to /login; the login screen shows the strongest one once.

// "code_unavailable" is S-04 left unconfirmed, or opened without its code (guard 9), when the next screen is S-01 (the recovery host).
export type LoginArrival = "session_ended" | "reset_done" | "account_deleted" | "code_unavailable";

// Strongest first (G-03, then the end of a recovery, then a deleted account, then the note about a code that is gone).
const PRIORITY: readonly LoginArrival[] = ["session_ended", "reset_done", "account_deleted", "code_unavailable"];

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

// S-04 left unconfirmed, or opened without its code (guard 9): the same note for the screens that follow it (S-08 now, S-22 later).
// It belongs to the redirect that raised it, so it expires: a destination that does not show it yet cannot show it long afterwards.
const CODE_UNAVAILABLE_LIFETIME_MS = 30_000;

// A performance.now() value, so a change of the clock cannot keep it alive.
let codeUnavailableAt: number | null = null;

export function raiseCodeUnavailable(): void {
  codeUnavailableAt = performance.now();
}

export function peekCodeUnavailable(): boolean {
  return codeUnavailableAt !== null && performance.now() - codeUnavailableAt <= CODE_UNAVAILABLE_LIFETIME_MS;
}

export function clearCodeUnavailable(): void {
  codeUnavailableAt = null;
}
