import type { ApiClient } from "@/lib/api/client";
import { createEndpoints } from "@/lib/api/endpoints";
import { ApiError, isAbortError } from "@/lib/api/errors";
import { sleep as defaultSleep } from "@/lib/api/sleep";
import { POLL_BACKOFF_MS, POLL_CAP_MS, WAKE_MAX_MS, pollDelayMs } from "@/lib/api/wakeup";

// The wake-up loop of the free server for the offline code (API-spec 1.11, D48, G-13): short health probes, never one long request, at 1, 2, 4, 8 s and then
// every 10 s, for at most 90 s. A free instance that is still asleep is connectivity, never a status: this loop never touches local data and never asks
// for a login.

export type WakeResult = "awake" | "timed_out" | "aborted";

export interface WaitForServerOptions {
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxWaitMs?: number;
  backoffMs?: readonly number[];
  capMs?: number;
  // Called after every failed probe with the time waited so far.
  onTick?: (waitedMs: number) => void;
}

// An answer from the application, whatever it says, proves the server is up. A platform page or a gateway answer does not (ConnectivityError).
async function probe(client: ApiClient, signal?: AbortSignal): Promise<boolean> {
  try {
    await createEndpoints(client).health({ signal });
    return true;
  } catch (error) {
    if (error instanceof ApiError) return true;
    return false;
  }
}

export async function waitForServer(client: ApiClient, options: WaitForServerOptions = {}): Promise<WakeResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxWaitMs = options.maxWaitMs ?? WAKE_MAX_MS;
  const startedAt = now();
  for (let index = 0; ; index += 1) {
    if (options.signal?.aborted) return "aborted";
    if (await probe(client, options.signal)) return "awake";
    if (options.signal?.aborted) return "aborted";
    const waited = now() - startedAt;
    options.onTick?.(waited);
    if (waited >= maxWaitMs) return "timed_out";
    try {
      await sleep(Math.min(pollDelayMs(index, options.backoffMs ?? POLL_BACKOFF_MS, options.capMs ?? POLL_CAP_MS), Math.max(0, maxWaitMs - waited)), options.signal);
    } catch (error) {
      if (isAbortError(error)) return "aborted";
      throw error;
    }
  }
}
