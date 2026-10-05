"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import type { CatalogEdition } from "@/lib/api/types";
import { classifyCatalogError, type CatalogFailure } from "./catalog-failure";
import { planEditionOf, type PlanEdition } from "./catalog-model";

export type CatalogLoad =
  | { status: "loading" }
  | { status: "error"; failure: CatalogFailure }
  // `plan` is the learner's plan book, only when `withPlan` was asked and E18 answered with a plan; otherwise null.
  | { status: "ready"; editions: CatalogEdition[]; plan: PlanEdition | null };

export interface CatalogData {
  state: CatalogLoad;
  reload: () => void;
}

// E14 decides the screen. With `withPlan` (S-25) E18 loads in parallel only to learn which book the plan uses: its failure is left out silently,
// except a 401, which means the session ended (G-03).
export function useCatalog({ withPlan = false }: { withPlan?: boolean } = {}): CatalogData {
  const { api } = useApiRuntime();
  const wake = useWakeUpState();
  const [state, setState] = useState<CatalogLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const [catalogResult, todayResult] = await Promise.allSettled([api.catalog({ signal }), withPlan ? api.today({ signal }) : Promise.resolve(null)]);
      if (signal.aborted) return;
      if (catalogResult.status === "rejected") {
        setState({ status: "error", failure: classifyCatalogError(catalogResult.reason) });
        return;
      }
      if (todayResult.status === "rejected" && isSessionEnded(todayResult.reason)) {
        setState({ status: "error", failure: { kind: "session_ended" } });
        return;
      }
      const plan = todayResult.status === "fulfilled" && todayResult.value !== null ? planEditionOf(todayResult.value.plan) : null;
      setState({ status: "ready", editions: catalogResult.value.editions, plan });
    })();
    return () => controller.abort();
  }, [api, withPlan, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  // P-04: a read that failed while the server was waking is sent again once health answers, once per wake-up so a failing server cannot loop.
  const autoReloaded = useRef(false);
  useEffect(() => {
    if (wake.phase !== "ready") {
      autoReloaded.current = false;
      return;
    }
    if (!autoReloaded.current && state.status === "error" && state.failure.kind === "connectivity") {
      autoReloaded.current = true;
      reload();
    }
  }, [wake.phase, state, reload]);

  return { state, reload };
}
