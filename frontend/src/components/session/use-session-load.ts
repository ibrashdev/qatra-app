"use client";

import { useCallback, useEffect, useState } from "react";
import type { TextKind } from "@/components/questions";
import { inactivePlan } from "@/components/today/today-model";
import { useApiRuntime } from "@/lib/api/react";
import { startDailySession } from "@/lib/api/session-endpoints";
import { getProgress } from "@/lib/api/today-endpoints";
import type { CatalogEdition, DailyProgress, SessionSnapshot, Today } from "@/lib/api/types";
import { confirmOnlineCompletion } from "@/lib/offline/online-journal";
import { EMPTY_JOURNAL, readSessionJournal, type SessionJournal } from "./durable-online-queue";
import { classifySessionError, type SessionFailure } from "./session-failure";
import { freezeDeep, textKindOf } from "./session-model";

export type SessionLoad =
  | { status: "loading" }
  // `held`: the device already holds answers or a run record for this session (the online journal), whatever the load could not reach.
  | { status: "failed"; failure: SessionFailure; held: boolean }
  // The route does not name this session (guard 8), or there is no plan to run one for: the screen goes to Today.
  | { status: "leave" }
  // `journal` is what the online journal holds for this session (an empty one where there is nothing, no storage or no known account).
  | { status: "ready"; snapshot: SessionSnapshot; daily: DailyProgress; textKind: TextKind; journal: SessionJournal };

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
// The online journal is read in parallel with E18 (the recorded account only, never E11, so the load never waits for it): where a reload resumes, the answers
// already given and the events that were never acknowledged. A journal that cannot be read reads as nothing.
export function useSessionLoad(routeId: string): { state: SessionLoad; reload: () => void } {
  const { api, client } = useApiRuntime();
  const [state, setState] = useState<SessionLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      let held = false;
      try {
        const [todayResult, catalogResult, journalResult] = await Promise.allSettled([api.today({ signal }), api.catalog({ signal }), readSessionJournal(routeId)]);
        if (signal.aborted) return;
        if (journalResult.status === "fulfilled") held = journalResult.value.run !== null || journalResult.value.queued.length > 0;
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
        let journal = journalResult.status === "fulfilled" ? journalResult.value : EMPTY_JOURNAL;
        if (snapshot.status === "completed" && journal.accountKey !== null && journal.run !== null) {
          // The server already holds the finished session: what the journal still owed for it is settled.
          void confirmOnlineCompletion(journal.accountKey, snapshot.sessionId).catch(() => undefined);
          journal = { ...journal, run: null };
        }
        setState({ status: "ready", snapshot: frozen, daily: dailyOf(today), textKind: textKindOf(frozen, editions), journal });
      } catch (error) {
        if (signal.aborted) return;
        const failure = classifySessionError(error);
        setState(failure.kind === "not_found" ? { status: "leave" } : { status: "failed", failure, held });
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
