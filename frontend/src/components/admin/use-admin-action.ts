"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionEndedRedirect } from "@/components/plan-overview/use-plan-data";
import type { ApiClient } from "@/lib/api/client";
import { useApiRuntime } from "@/lib/api/react";
import { classifyAdminError, type AdminFailure } from "./admin-failure";

export type ActionResult<R> = { ok: true; value: R } | { ok: false };

export interface AdminAction {
  // The key of the press in flight, or null. A row's button shows its spinner when the key is its own.
  busy: string | null;
  failure: AdminFailure | null;
  clearFailure: () => void;
  // Runs one write. Only one runs at a time (a second press while one is in flight does nothing), the failure is classified, and a write is never
  // sent again on its own: the manager presses again, which is a new decision. The answer is dropped if the screen has gone.
  run: <R>(key: string, task: (client: ApiClient) => Promise<R>) => Promise<ActionResult<R>>;
}

// The state of the writes of one screen or dialog. A 401 ends the session: S-01 shows its banner once and brings the manager back to `next`.
export function useAdminAction(next: string): AdminAction {
  const { client } = useApiRuntime();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useSessionEndedRedirect(failure?.kind === "session_ended" ? "session_ended" : null, next);

  const clearFailure = useCallback(() => setFailure(null), []);

  const run = useCallback(
    async <R>(key: string, task: (client: ApiClient) => Promise<R>): Promise<ActionResult<R>> => {
      if (inFlight.current) return { ok: false };
      inFlight.current = true;
      setFailure(null);
      setBusy(key);
      try {
        const value = await task(client);
        return { ok: true, value };
      } catch (error) {
        const classified = classifyAdminError(error);
        if (mounted.current && classified.kind !== "aborted") setFailure(classified);
        return { ok: false };
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [client],
  );

  return { busy, failure, clearFailure, run };
}
