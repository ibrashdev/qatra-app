// P-26: a one-time arrival banner for the settings screen (S-22), held in memory only. Never a URL parameter, never storage.
// S-23 raises "password_changed" before it replaces itself with S-22; S-04 raises "code_rotated" when its continue action returns to S-22
// after E08. The note about a code that can no longer be shown (S-04 left unconfirmed) stays in lib/auth/flash.ts (raiseCodeUnavailable).
export type SettingsArrival = "password_changed" | "code_rotated";

let raised: SettingsArrival | null = null;

export function raiseSettingsArrival(kind: SettingsArrival): void {
  raised = kind;
}

// Reads without consuming, so a render can call it twice (development double render) and agree.
export function peekSettingsArrival(): SettingsArrival | null {
  return raised;
}

// Called once the banner is on screen: after that nothing is left to show.
export function clearSettingsArrival(): void {
  raised = null;
}
