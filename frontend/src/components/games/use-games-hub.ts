"use client";

import { useCallback, useEffect, useState } from "react";
import { classifySessionError, type SessionFailure } from "@/components/session/session-failure";
import { useApiRuntime } from "@/lib/api/react";
import type { CatalogEdition, Plan } from "@/lib/api/types";

export type HubLoad =
  | { status: "loading" }
  | { status: "error"; failure: SessionFailure }
  // `plan` is null for an account with no active plan (G-24). `editions` is null when the catalog (E14) did not answer: it only decides the font of the
  // book text in a round, so the hub still works without it.
  | { status: "ready"; plan: Plan | null; editions: readonly CatalogEdition[] | null };

// S-14 reads E18 once (the plan line and the guard of G-24) and the catalog alongside it. A repeat load is a read, so a retry is safe.
export function useGamesHub(): { state: HubLoad; reload: () => void } {
  const { api } = useApiRuntime();
  const [state, setState] = useState<HubLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const [todayResult, catalogResult] = await Promise.allSettled([api.today({ signal }), api.catalog({ signal })]);
      if (signal.aborted) return;
      if (todayResult.status === "rejected") {
        const failure = classifySessionError(todayResult.reason);
        if (failure.kind !== "aborted") setState({ status: "error", failure });
        return;
      }
      setState({
        status: "ready",
        plan: todayResult.value.plan,
        editions: catalogResult.status === "fulfilled" ? catalogResult.value.editions : null,
      });
    })();
    return () => controller.abort();
  }, [api, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}
