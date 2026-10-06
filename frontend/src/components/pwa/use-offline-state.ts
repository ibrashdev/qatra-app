"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeOfflineMessages } from "@/lib/offline/broadcast";
import { listPendingEvents } from "@/lib/offline/outbox";
import { inspectLocalPlan } from "@/lib/offline/plan-cache";
import { getOfflineSyncController } from "@/lib/offline/sync";
import { getShellStatus, subscribeShellReady } from "@/lib/pwa/register";
import type { LocalPlanInspection, OutboxCounts, PendingEvent, SyncProgress } from "@/lib/offline/types";

// What the offline screens read from the device. Each hook asks the storage layer of lib/offline (never IndexedDB directly), keeps its answer in React state
// and refreshes when another tab, or the sync, announces a change.

const NO_COUNTS: OutboxCounts = { queued: 0, pending: 0, blocked: 0, total: 0 };

export interface LocalPlan {
  // Null until the first read ends: the screens show their loading state until then.
  inspection: LocalPlanInspection | null;
  refresh: () => Promise<void>;
}

export function useLocalPlan(): LocalPlan {
  const [inspection, setInspection] = useState<LocalPlanInspection | null>(null);
  const alive = useRef(true);
  // Reads can overlap (a broadcast while a read runs): only the newest answer is kept.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    let next: LocalPlanInspection;
    try {
      next = await inspectLocalPlan();
    } catch {
      next = { status: "storage_error", owner: null, snapshot: null, record: null, revalidation: null, counts: NO_COUNTS };
    }
    if (alive.current && mine === latest.current) setInspection(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = subscribeOfflineMessages((message) => {
      if (message.type === "UPDATE_PENDING") return;
      void refresh();
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [refresh]);

  return { inspection, refresh };
}

export function outboxCountsOf(inspection: LocalPlanInspection | null): OutboxCounts {
  return inspection?.counts ?? NO_COUNTS;
}

const SERVER_SYNC: SyncProgress = { phase: "idle", trigger: null, startedAt: null, waitedMs: 0, timedOut: false, result: null };

// The state machine of the foreground sync (lib/offline/sync.ts), read through the external-store hook.
export function useSyncProgress(): SyncProgress {
  const controller = getOfflineSyncController();
  return useSyncExternalStore(controller.subscribe, controller.getState, () => SERVER_SYNC);
}

const NO_EVENTS: readonly PendingEvent[] = [];

// The events waiting on the device for one owner, read again whenever `signal` changes (the counts). Used for the provisional minutes of the day.
export function usePendingEvents(ownerId: string | null, signal: string | number): readonly PendingEvent[] {
  const [events, setEvents] = useState<readonly PendingEvent[]>(NO_EVENTS);
  useEffect(() => {
    if (ownerId === null) return;
    let cancelled = false;
    listPendingEvents(ownerId).then(
      (list) => {
        if (!cancelled) setEvents(list);
      },
      () => {
        if (!cancelled) setEvents(NO_EVENTS);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ownerId, signal]);
  return ownerId === null ? NO_EVENTS : events;
}

const SHELL_POLL_MS = 3000;
const SHELL_POLL_LIMIT = 20;

// Whether the service worker has cached every file of the shell (PWA-design 4: the plan alone never proves the app opens offline). Null until the first
// answer. While it is false the worker is asked again every few seconds, because the page that triggered the install is not told when it finishes.
export function useShellReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer: number | null = null;
    const check = () => {
      getShellStatus().then(
        (status) => {
          if (cancelled) return;
          setReady(status.shellReady);
          attempts += 1;
          if (!status.shellReady && attempts < SHELL_POLL_LIMIT) timer = window.setTimeout(check, SHELL_POLL_MS);
        },
        () => {
          if (!cancelled) setReady(false);
        },
      );
    };
    check();
    const unsubscribe = subscribeShellReady(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  return ready;
}
