"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { getProgress } from "@/lib/api/today-endpoints";
import type { ProgressResponse, Today } from "@/lib/api/types";
import { subscribeOfflineMessages } from "@/lib/offline/broadcast";
import { classifyTodayError, type TodayFailure } from "./today-failure";

export type TodayLoad =
  | { status: "loading" }
  | { status: "error"; failure: TodayFailure }
  // `progress` is null when E19 failed: the stage row then loses its percent and the next review date is left out (S-11 "Data").
  | { status: "ready"; today: Today; progress: ProgressResponse | null };

export interface TodayData {
  state: TodayLoad;
  reload: () => void;
  // True once a reload turned `dailyCompleted` on while the screen was open: the only time the goal is announced (S-11 "Day goal reached").
  goalReachedNow: boolean;
}

// E18 and E19 load in parallel. E18 decides the screen; a failed E19 only thins it out, except when it says the session ended.
// A foreground sync that finished (the online journal reached the server) refreshes the figures in place: the screen stays as it is while it reads, and a
// refresh that fails changes nothing.
export function useTodayData(): TodayData {
  const { api, client } = useApiRuntime();
  const [state, setState] = useState<TodayLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [goalReachedNow, setGoalReachedNow] = useState(false);
  const lastCompleted = useRef<boolean | null>(null);
  const quietRefresh = useRef(false);
  // True while the screen shows data: only then may a refresh be quiet (a screen still loading must show its failure).
  const showing = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const quiet = quietRefresh.current && showing.current;
    quietRefresh.current = false;
    void (async () => {
      const [todayResult, progressResult] = await Promise.allSettled([api.today({ signal }), getProgress(client, { signal })]);
      if (signal.aborted) return;
      if (todayResult.status === "rejected") {
        if (!quiet) setState({ status: "error", failure: classifyTodayError(todayResult.reason) });
        return;
      }
      if (progressResult.status === "rejected" && isSessionEnded(progressResult.reason)) {
        setState({ status: "error", failure: { kind: "session_ended" } });
        return;
      }
      const today = todayResult.value;
      setGoalReachedNow(lastCompleted.current === false && today.dailyCompleted);
      lastCompleted.current = today.dailyCompleted;
      showing.current = true;
      setState({ status: "ready", today, progress: progressResult.status === "fulfilled" ? progressResult.value : null });
    })();
    return () => controller.abort();
  }, [api, client, attempt]);

  const reload = useCallback(() => {
    showing.current = false;
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  // The sync of the online journal completed (here or in another tab): what the server confirmed may have changed the day's figures.
  useEffect(
    () =>
      subscribeOfflineMessages((message) => {
        if (message.type !== "SYNC_DONE" || message.outcome !== "completed") return;
        quietRefresh.current = true;
        setAttempt((value) => value + 1);
      }),
    [],
  );

  return { state, reload, goalReachedNow };
}
