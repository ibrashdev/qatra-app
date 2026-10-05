"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";
import { isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { getProgress } from "@/lib/api/today-endpoints";
import type { CatalogResponse, Profile, ProgressResponse, Today } from "@/lib/api/types";
import { raiseLoginArrival } from "@/lib/auth/flash";
import { useConnectivity } from "@/lib/net/use-connectivity";

export type PlanLoad =
  | { status: "loading" }
  | { status: "error"; failure: TodayFailure }
  // E18 and E19 decide the screen. `catalog` (E14, the edition label and the section count) and `profile` (E11, the demo flag) only refine it.
  | { status: "ready"; today: Today; progress: ProgressResponse; catalog: CatalogResponse | null; profile: Profile | null };

export interface PlanData {
  state: PlanLoad;
  // A reload that keeps the screen as it is until the answer arrives (after a resume, or «تحديث» on a moved plan).
  refresh: () => void;
  reload: () => void;
  online: boolean;
  waking: boolean;
}

// G-03: the session ended. S-01 shows its banner once and brings the learner back to `next`.
export function useSessionEndedRedirect(failureKind: string | null, next: string): void {
  const router = useRouter();
  useEffect(() => {
    if (failureKind !== "session_ended") return;
    raiseLoginArrival("session_ended");
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [failureKind, next, router]);
}

// E18, E19, E14 and E11 load in parallel for S-12 and S-13 (UI-screens S-12 and S-13 section 4). A failed E14 or E11 only thins the screen,
// except when it says the session ended. A read that failed while the server was waking is sent again once health answers (P-04), once per wake-up.
export function usePlanData(): PlanData {
  const { api, client } = useApiRuntime();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const [state, setState] = useState<PlanLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const [today, progress, catalog, profile] = await Promise.allSettled([api.today({ signal }), getProgress(client, { signal }), api.catalog({ signal }), api.me({ signal })]);
      if (signal.aborted) return;
      const ended = [today, progress, catalog, profile].some((result) => result.status === "rejected" && isSessionEnded(result.reason));
      if (ended) {
        setState({ status: "error", failure: { kind: "session_ended" } });
        return;
      }
      const required = today.status === "rejected" ? today : progress.status === "rejected" ? progress : null;
      if (required !== null) {
        setState({ status: "error", failure: classifyTodayError(required.reason) });
        return;
      }
      if (today.status !== "fulfilled" || progress.status !== "fulfilled") return;
      setState({
        status: "ready",
        today: today.value,
        progress: progress.value,
        catalog: catalog.status === "fulfilled" ? catalog.value : null,
        profile: profile.status === "fulfilled" ? profile.value : null,
      });
    })();
    return () => controller.abort();
  }, [api, client, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

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

  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  return { state, refresh, reload, online, waking: online && waking };
}
