export type ApiMode = "mock" | "live";

export function resolveApiMode(value: string | undefined, nodeEnv: string | undefined): ApiMode {
  const mode = value?.trim();
  if (mode === "mock" || mode === "live") return mode;
  if (mode) throw new Error('NEXT_PUBLIC_API_MODE must be "mock" or "live".');
  return nodeEnv === "development" ? "mock" : "live";
}

// The two public variables. Each is read with a literal process.env access so the build can inline it.
export const API_MODE: ApiMode = resolveApiMode(process.env.NEXT_PUBLIC_API_MODE, process.env.NODE_ENV);

// Must equal the backend TERMS_VERSION (UA-16); null when unset, and the server stays the judge (400 terms_required).
export const TERMS_VERSION: string | null = process.env.NEXT_PUBLIC_TERMS_VERSION?.trim() || null;
