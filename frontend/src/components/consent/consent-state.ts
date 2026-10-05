import { takeReturnPath } from "@/lib/auth/return-path";

// What S-06 keeps in memory while it is open and while the learner reads S-03 (UI-screens S-06 "Entry" and "Validation"). Never storage, never
// the URL: a reload forgets all of it, and the gate then returns to the home screen.

// The box: unchecked when first shown; a return from S-03 keeps what the learner set.
let agreed = false;

export function readConsentDraft(): boolean {
  return agreed;
}

export function saveConsentDraft(value: boolean): void {
  agreed = value;
}

// The path to return to after consent. The login screen hands it over once (takeReturnPath), but this screen can mount twice (a development
// remount, or a return from S-03), so the first claim keeps it until consent or logout ends the visit.
let claimed: string | null = null;

export function claimReturnPath(): string | null {
  claimed ??= takeReturnPath();
  // The gate itself is never a destination: a login that sent the visitor back here after a lapsed session would loop.
  return claimed === "/consent" ? null : claimed;
}

// Consent or logout ends the visit: nothing typed or kept outlives it.
export function endConsentVisit(): void {
  agreed = false;
  claimed = null;
}

export function resetConsentStateForTests(): void {
  endConsentVisit();
}
