import { safeNextPath } from "./safe-path";

// The path a visitor returns to once the re-consent gate (S-06) is done. In memory only; a reload forgets it and the gate falls back to the home screen.
let pending: string | null = null;

export function setReturnPath(path: string | null): void {
  pending = safeNextPath(path);
}

// Hands the path over once.
export function takeReturnPath(): string | null {
  const path = pending;
  pending = null;
  return path;
}
