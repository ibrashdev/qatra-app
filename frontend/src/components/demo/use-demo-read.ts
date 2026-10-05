"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import { isAbortError, isConnectivityError } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { classifyDemoError, type DemoFailure } from "./demo-failure";

export type DemoRead<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; failure: DemoFailure };

// One read of a demo endpoint (E27, E29). `load` must keep its identity between renders (a module-level function). `enabled` is false until the
// guard has let the account in, so nothing is asked of a visitor. The read is safe to repeat, so a failure on connectivity runs it again by itself
// once a sleeping server answers (P-04), and the retry button is a read too.
export function useDemoRead<T>(load: (client: ApiClient, options: { signal: AbortSignal }) => Promise<T>, enabled: boolean): { state: DemoRead<T>; reload: () => void } {
  const { client, wakeUp } = useApiRuntime();
  const [attempt, setAttempt] = useState(0);
  // The answer belongs to the attempt that asked for it; an answer of an older attempt reads as "loading" again for the new one.
  const [answer, setAnswer] = useState<{ attempt: number; state: DemoRead<T> } | null>(null);
  const failedOnConnectivity = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    failedOnConnectivity.current = false;
    load(client, { signal })
      .then((data) => {
        if (!signal.aborted) setAnswer({ attempt, state: { status: "ready", data } });
      })
      .catch((error: unknown) => {
        if (signal.aborted || isAbortError(error)) return;
        failedOnConnectivity.current = isConnectivityError(error);
        setAnswer({ attempt, state: { status: "error", failure: classifyDemoError(error) } });
      });
    return () => controller.abort();
  }, [client, load, attempt, enabled]);

  const state: DemoRead<T> = answer !== null && answer.attempt === attempt ? answer.state : { status: "loading" };

  useEffect(
    () =>
      wakeUp.onReady(() => {
        if (failedOnConnectivity.current) setAttempt((count) => count + 1);
      }),
    [wakeUp],
  );

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  return { state, reload };
}
