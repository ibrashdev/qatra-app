// The recovery code on its way to S-04 (UI-screens S-04, UA-06). It arrives with the response of the screen that asked for it, is held here
// in memory, and S-04 wipes it on continue, on leave and on reload (a reload makes this module new). Never storage, URL, history state,
// title, a live region, a log or analytics.
import type { Endpoints } from "@/lib/api/endpoints";
import { isAbortError } from "@/lib/api/errors";
import { homeDestination, type HomePath } from "./destination";

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

// The contract of E03, E07 and E08: 32 lowercase hexadecimal characters in eight groups of four joined by "-".
const CODE_PATTERN = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/;

// The eight groups, or null when the text is not a recovery code: the screen then treats the code as absent instead of showing it.
export function recoveryCodeGroups(code: string): string[] | null {
  return CODE_PATTERN.test(code) ? code.split("-") : null;
}

export const RECOVERY_CODE_FILE_NAME = "qatra-recovery-code.txt";

// The downloaded file (S-04 section 3): three lines in the interface language, never the username (O-17).
export function recoveryCodeFileText(lines: { title: string; code: string; warning: string }): string {
  return [lines.title, lines.code, lines.warning].join("\n");
}

// Where the continue action of S-04 goes: S-08 after registration (a placeholder until Batch 2), S-01 after a recovery, S-22 after a rotation.
export type NextScreen = "/start" | "/login" | "/settings";

const NEXT_SCREEN: Record<RecoveryHost, NextScreen> = { register: "/start", recovery: "/login", settings: "/settings" };

export function nextScreen(host: RecoveryHost): NextScreen {
  return NEXT_SCREEN[host];
}

// Guard 9 (UI-design 2.3): without the code S-04 returns to its host. A reload loses the host with the code, so the answer comes from
// the session: a visitor can only have been in the recovery, and goes to S-01 with the wording that says to log in first; a learner
// goes home with the default wording.
export interface AbsentDestination {
  path: HomePath | "/login";
  variant: "default" | "recovery";
}

const SESSION_PROBE_TIMEOUT_MS = 8_000;

// null when the caller aborted. A failed probe (a sleeping server, no network) is treated as a visitor: S-01 asks the session again and
// sends a learner on, so nobody is stranded on a screen that has nothing to show.
export async function resolveAbsentDestination(api: Pick<Endpoints, "me" | "today">, signal: AbortSignal): Promise<AbsentDestination | null> {
  try {
    await api.me({ signal, timeoutMs: SESSION_PROBE_TIMEOUT_MS });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return null;
    return { path: "/login", variant: "recovery" };
  }
  const path = await homeDestination(api, signal);
  return signal.aborted ? null : { path, variant: "default" };
}
