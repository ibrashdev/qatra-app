"use client";

import { useCallback, useEffect, useState } from "react";
import type { TextKind } from "@/components/questions";
import { inactivePlan } from "@/components/today/today-model";
import { useApiRuntime } from "@/lib/api/react";
import { startDailySession } from "@/lib/api/session-endpoints";
import { getProgress } from "@/lib/api/today-endpoints";
import type { CatalogEdition, DailyProgress, SessionSnapshot, Today } from "@/lib/api/types";
import { classifySessionError, type SessionFailure } from "./session-failure";
import { freezeDeep, textKindOf } from "./session-model";

export type SessionLoad =
  | { status: "loading" }
  | { status: "failed"; failure: SessionFailure }
  // The route does not name this session (guard 8), or there is no plan to run one for: the screen goes to Today.
  | { status: "leave" }
  | { status: "ready"; snapshot: SessionSnapshot; daily: DailyProgress; textKind: TextKind };

const dailyOf = (today: Today): DailyProgress => ({
  learningDate: today.learningDate,
  dailyActiveMs: today.dailyActiveMs,
  dailyGoalMs: today.dailyGoalMs,
  dailyPercent: today.dailyPercent,
  dailyCompleted: today.dailyCompleted,
  extraActiveMs: today.extraActiveMs,
});

// A reload of /session/[id] runs E20 `daily` again: the get-or-create answers the same open session, and any other id goes to Today (S-19 "Entry").
// E18 gives the plan and its version (a completed plan serves its maintenance reviews, so E19 names it) and the daily figures for the bar; the catalog
// (E14) names the edition's format, which decides the font of the book text. A catalog that does not answer only costs that choice its first source.
export function useSessionLoad(routeId: string): { state: SessionLoad; reload: () => void } {
  const { api, client } = useApiRuntime();
  const [state, setState] = useState<SessionLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const [todayResult, catalogResult] = await Promise.allSettled([api.today({ signal }), api.catalog({ signal })]);
        if (signal.aborted) return;
        if (todayResult.status === "rejected") throw todayResult.reason;
        const today = todayResult.value;

        let target = today.plan === null ? null : { planId: today.plan.planId, planVersion: today.plan.currentVersion };
        if (target === null) {
          const completed = inactivePlan(await getProgress(client, { signal }), "completed");
          target = completed === null ? null : { planId: completed.planId, planVersion: completed.currentVersion };
        }
        if (target === null) {
          setState({ status: "leave" });
          return;
        }

        const snapshot = await startDailySession(client, target, { signal });
        if (signal.aborted) return;
        if (typeof snapshot?.sessionId !== "string" || snapshot.sessionId !== routeId || !Array.isArray(snapshot.steps)) {
          setState({ status: "leave" });
          return;
        }
        const editions: readonly CatalogEdition[] | null = catalogResult.status === "fulfilled" ? catalogResult.value.editions : null;
        const frozen = freezeDeep(snapshot);
        setState({ status: "ready", snapshot: frozen, daily: dailyOf(today), textKind: textKindOf(frozen, editions) });
      } catch (error) {
        if (signal.aborted) return;
        const failure = classifySessionError(error);
        setState(failure.kind === "not_found" ? { status: "leave" } : { status: "failed", failure });
      }
    })();
    return () => controller.abort();
  }, [api, client, routeId, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}
