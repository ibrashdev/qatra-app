"use client";

import { useEffect, useRef } from "react";
import { useWakeUpState } from "@/lib/api/react";
import { getOfflineSyncController, hasOnlineWork } from "@/lib/offline/sync";
import type { SyncTrigger } from "@/lib/offline/types";

// The foreground trigger of the online journal (PWA-design 6). An ordinary online session writes its answers to the journal first, so a reload or a lost
// connection leaves them on the device; this component makes sure they reach the server without the learner doing anything: when the app opens, when the
// free server finishes waking up, and when the connection comes back. It renders nothing and starts the same foreground sync as the offline shell
// (reachability, account check, replay in order, owed finishes), and only when the journal actually holds something. There is no Background Sync: nothing is
// promised while the app is closed.

// At most one run in this window, except when the connection returns (a real change that should be tried at once).
export const ONLINE_SYNC_MIN_GAP_MS = 20_000;

export interface OnlineJournalSyncProps {
  // Seams for a test; the app passes none.
  hasWork?: () => Promise<boolean>;
  run?: (trigger: SyncTrigger) => Promise<unknown>;
  now?: () => number;
}

const startSync = (trigger: SyncTrigger): Promise<unknown> => getOfflineSyncController().run(trigger);

export function OnlineJournalSync({ hasWork = hasOnlineWork, run = startSync, now = Date.now }: OnlineJournalSyncProps = {}) {
  const wake = useWakeUpState();
  const lastRunAt = useRef<number | null>(null);
  // The latest seams, read when an event fires, so the listeners are attached once.
  const seams = useRef({ hasWork, run, now });
  useEffect(() => {
    seams.current = { hasWork, run, now };
  });

  const attempt = useRef((trigger: SyncTrigger, immediate: boolean): void => {
    const { hasWork: check, run: start, now: clock } = seams.current;
    // The browser's flag is only a hint, but it is cheap and a sync that cannot reach the server only waits.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const quiet = lastRunAt.current !== null && clock() - lastRunAt.current < ONLINE_SYNC_MIN_GAP_MS;
    if (quiet && !immediate) return;
    void (async () => {
      try {
        if (!(await check())) return;
        lastRunAt.current = clock();
        await start(trigger);
      } catch {
        // The sync reports its own outcome; a failed check or start is retried by the next trigger.
      }
    })();
  });

  // After hydration: the app was just opened.
  useEffect(() => {
    attempt.current("app_open", false);
  }, []);

  // The free server finished waking up: what could not be sent while it slept can go now.
  useEffect(() => {
    if (wake.phase === "ready") attempt.current("app_open", false);
  }, [wake.phase]);

  // The connection is back.
  useEffect(() => {
    const onOnline = () => attempt.current("reconnect", true);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  return null;
}
