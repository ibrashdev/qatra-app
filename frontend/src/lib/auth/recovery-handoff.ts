// The recovery code on its way to S-04 (UI-screens S-04, UA-06). It arrives with the response of the screen that asked for it, is held here
// in memory, and S-04 wipes it on continue, on leave and on reload (a reload makes this module new). Never storage, URL, history state,
// title, a live region, a log or analytics.

// The screen whose response carried the code: it decides where S-04 goes next.
export type RecoveryHost = "register" | "recovery" | "settings";

export interface HeldRecoveryCode {
  code: string;
  host: RecoveryHost;
}

let held: HeldRecoveryCode | null = null;

export function holdRecoveryCode(code: string, host: RecoveryHost): void {
  held = { code, host };
}

export function peekRecoveryCode(): HeldRecoveryCode | null {
  return held === null ? null : { ...held };
}

export function wipeRecoveryCode(): void {
  held = null;
}
