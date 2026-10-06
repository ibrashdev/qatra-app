"use client";

import { useEffect, useSyncExternalStore } from "react";
import { onlineRunLockName } from "@/lib/offline/sync";
import { IDLE_QUEUE_STATUS, type DurableOnlineQueue, type OnlineQueueStatus } from "./durable-online-queue";

// While a tab plays an online daily session or game round it holds the Web Lock `qatra-online-run:<sessionId>`. The foreground sync leaves such a session
// alone (that tab sends its own events), and takes it over the moment the lock is gone: a closed tab or a reload releases it with the page. The lock is
// held for the whole life of the screen and released when it unmounts. Where the Locks API is missing nothing is held and the sync skips nothing (a
// duplicate send is harmless: the server answers `duplicate`). The lesson reader does not use it: it has no run of its own.
export function useOnlineRunLock(sessionId: string, enabled = true): void {
  useEffect(() => {
    if (!enabled || sessionId === "") return;
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks === undefined || typeof locks.request !== "function") return;
    let release: (() => void) | null = null;
    let cancelled = false;
    try {
      locks
        .request(onlineRunLockName(sessionId), () => {
          // The screen went away before the lock was granted: take it and give it back at once.
          if (cancelled) return undefined;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => undefined);
    } catch {
      return;
    }
    return () => {
      cancelled = true;
      release?.();
    };
  }, [sessionId, enabled]);
}

const NEVER = (): (() => void) => () => undefined;

// What the run's banners need to know about where its answers live: on the device (durable), in this page only (memory), or a failed write.
export function useOnlineQueueStatus(queue: DurableOnlineQueue | null): OnlineQueueStatus {
  return useSyncExternalStore(
    queue === null ? NEVER : queue.subscribe,
    queue === null ? () => IDLE_QUEUE_STATUS : queue.getSnapshot,
    () => IDLE_QUEUE_STATUS,
  );
}
