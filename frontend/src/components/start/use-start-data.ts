"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError, isApiError, isConnectivityError, isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import type { CatalogEdition, Profile } from "@/lib/api/types";

// connectivity: no usable answer (offline, a sleeping server); unavailable: 503; internal: any other answer of the envelope (P-05, P-07).
export type CatalogFailure = "connectivity" | "unavailable" | "internal";

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; editions: readonly CatalogEdition[] }
  | { status: "error"; kind: CatalogFailure; sessionEnded: boolean };

// E14, the source of every level of the cascade (D78). A failed read shows no stale list; the retry is a read, so it is safe to repeat.
// A read that failed on connectivity runs again by itself once a sleeping server answers (P-04), as the guest screens do.
export function useCatalog(): { state: CatalogState; retry: () => void } {
  const { api, wakeUp } = useApiRuntime();
  const [attempt, setAttempt] = useState(0);
  // The answer belongs to the attempt that asked for it; an answer of an older attempt reads as "loading" again for the new one.
  const [answer, setAnswer] = useState<{ attempt: number; state: CatalogState } | null>(null);
  const failedOnConnectivity = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    failedOnConnectivity.current = false;
    api
      .catalog({ signal: controller.signal })
      .then((catalog) => {
        if (!controller.signal.aborted) setAnswer({ attempt, state: { status: "ready", editions: catalog.editions } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const kind: CatalogFailure = isConnectivityError(error) ? "connectivity" : isApiError(error) && error.code === "unavailable" ? "unavailable" : "internal";
        failedOnConnectivity.current = kind === "connectivity";
        setAnswer({ attempt, state: { status: "error", kind, sessionEnded: isSessionEnded(error) } });
      });
    return () => controller.abort();
  }, [api, attempt]);

  const state: CatalogState = answer !== null && answer.attempt === attempt ? answer.state : { status: "loading" };

  useEffect(
    () =>
      wakeUp.onReady(() => {
        if (failedOnConnectivity.current) setAttempt((count) => count + 1);
      }),
    [wakeUp],
  );

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { state, retry };
}

export interface StartContext {
  profile: Profile | null; // E11: the default minutes and the time zone of the date control
  openPlanChatId: string | null; // E18: the open plan conversation, for the banner of c4
  hasActivePlan: boolean; // E18: with an active plan the screen gets a close control to S-12 (O-31)
}

const NO_CONTEXT: StartContext = { profile: null, openPlanChatId: null, hasActivePlan: false };

// E11 and E18 only refine the screen, so neither blocks it: a failed read leaves the defaults (10 minutes, the browser time zone, no banner).
export function useStartContext(): StartContext {
  const { api } = useApiRuntime();
  const [context, setContext] = useState<StartContext>(NO_CONTEXT);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void api
      .me({ signal })
      .then((profile) => {
        if (!signal.aborted) setContext((current) => ({ ...current, profile }));
      })
      .catch(() => undefined);
    void api
      .today({ signal })
      .then((today) => {
        if (!signal.aborted) setContext((current) => ({ ...current, openPlanChatId: today.openPlanChatId ?? null, hasActivePlan: today.plan !== null }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  return context;
}
