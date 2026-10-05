"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

// A cut every 5 minutes keeps each interval well under the 30 minutes E21 accepts for one of them.
export const ACTIVITY_CUT_MS = 5 * 60 * 1000;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

const readVisible = (): boolean => document.visibilityState !== "hidden";
const readVisibleOnServer = (): boolean => true;

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, readVisible, readVisibleOnServer);
}

// Active time (D40, S-19 "Answer flow"): an interval runs while the page is visible and `running` is true (the pause sheet and the finish stop it).
// Every interval that ends is handed to `onInterval`, which queues it; `close()` ends the open one by hand (before a flush). Nothing ticks on screen.
export function useActivityClock({ running, onInterval }: { running: boolean; onInterval: (startedAtMs: number, endedAtMs: number) => void }): { close: () => void } {
  const visible = usePageVisible();
  const active = running && visible;
  const startedAt = useRef<number | null>(null);
  const report = useRef(onInterval);
  useEffect(() => {
    report.current = onInterval;
  });

  const close = useCallback(() => {
    const started = startedAt.current;
    if (started === null) return;
    startedAt.current = null;
    report.current(started, Date.now());
  }, []);

  useEffect(() => {
    if (!active) return;
    startedAt.current = Date.now();
    const timer = window.setInterval(() => {
      close();
      startedAt.current = Date.now();
    }, ACTIVITY_CUT_MS);
    return () => {
      window.clearInterval(timer);
      close();
    };
  }, [active, close]);

  return { close };
}
