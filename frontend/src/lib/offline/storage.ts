import type { EstimateStorageFn, RequestPersistenceFn, StorageInfo } from "./types";

// PWA-design 8 and offline-spec 2.4. `estimate()` is an estimate and `persist()` is a request: neither is a guarantee, and a browser may still evict.

// G-13: refuse a download when the free space is below this many times the snapshot size (the JSON, plus the copy the transaction makes).
export const MIN_FREE_SPACE_FACTOR = 3;

export const estimateStorage: EstimateStorageFn = async () => {
  try {
    if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") return null;
    const { quota, usage } = await navigator.storage.estimate();
    const q = typeof quota === "number" && Number.isFinite(quota) ? quota : null;
    const u = typeof usage === "number" && Number.isFinite(usage) ? usage : null;
    const info: StorageInfo = { quota: q, usage: u, free: q !== null && u !== null ? Math.max(0, q - u) : null };
    return info;
  } catch {
    return null;
  }
};

// Asked once after the first successful download, where the browser has it. The answer is not stored or promised.
export const requestPersistence: RequestPersistenceFn = async () => {
  try {
    if (typeof navigator === "undefined" || typeof navigator.storage?.persist !== "function") return null;
    if (typeof navigator.storage.persisted === "function" && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
};

// Unknown free space (no estimate) is allowed: the write itself then reports a quota error if it does not fit.
export function hasEnoughSpace(info: StorageInfo | null, snapshotBytes: number, factor = MIN_FREE_SPACE_FACTOR): boolean {
  if (info === null || info.free === null) return true;
  return info.free >= snapshotBytes * factor;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return named.name === "QuotaExceededError" || named.code === 22;
}
