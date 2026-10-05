"use client";

import { useCallback, useEffect, useState } from "react";
import { isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { getProgress } from "@/lib/api/today-endpoints";
import type { ProgressResponse } from "@/lib/api/types";
import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";

export type ProgressLoad =
  | { status: "loading" }
  | { status: "error"; failure: TodayFailure }
  // `streakDays` is null when E18 failed: only the streak line is left out (S-21 c4).
  | { status: "ready"; progress: ProgressResponse; streakDays: number | null };

export interface ProgressData {
  state: ProgressLoad;
  reload: () => void;
}

// E19 and E18 load in parallel. E19 decides the screen; E18 only adds the streak. Either one saying the session ended ends the screen (G-03).
export function useProgressData(): ProgressData {
  const { api, client } = useApiRuntime();
  const [state, setState] = useState<ProgressLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const [progressResult, todayResult] = await Promise.allSettled([getProgress(client, { signal }), api.today({ signal })]);
      if (signal.aborted) return;
      if (progressResult.status === "rejected") {
        setState({ status: "error", failure: classifyTodayError(progressResult.reason) });
        return;
      }
      if (todayResult.status === "rejected" && isSessionEnded(todayResult.reason)) {
        setState({ status: "error", failure: { kind: "session_ended" } });
        return;
      }
      const streak = todayResult.status === "fulfilled" ? todayResult.value.streakDays : null;
      setState({ status: "ready", progress: progressResult.value, streakDays: typeof streak === "number" ? streak : null });
    })();
    return () => controller.abort();
  }, [api, client, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}
