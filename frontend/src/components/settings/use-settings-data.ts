"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyTodayError, type TodayFailure } from "@/components/today/today-failure";
import { isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import type { Profile } from "@/lib/api/types";
import { useConnectivity } from "@/lib/net/use-connectivity";

export type SettingsLoad =
  | { status: "loading" }
  | { status: "error"; failure: TodayFailure }
  // E11 decides the screen. E18 only says whether a plan is in force, for the link to S-13 (c11): when it fails the link is left out.
  | { status: "ready"; profile: Profile; hasPlan: boolean };

export interface SettingsData {
  state: SettingsLoad;
  reload: () => void;
  // The profile an E12 answer returned replaces the one that was read, so the controls and the pending line follow without another read.
  replaceProfile: (profile: Profile) => void;
  online: boolean;
  reconnected: boolean; // the browser reported the connection back (P-05): the polite status says so
  waking: boolean;
}

// E11 and E18 load in parallel (UI-screens S-22 section 4). Either one saying the session ended ends the screen (G-03). A read that failed while the
// server was waking is sent again once health answers (P-04), once per wake-up so a failing server cannot loop.
export function useSettingsData(): SettingsData {
  const { api } = useApiRuntime();
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  const [state, setState] = useState<SettingsLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const [profile, today] = await Promise.allSettled([api.me({ signal }), api.today({ signal })]);
      if (signal.aborted) return;
      const ended = [profile, today].some((result) => result.status === "rejected" && isSessionEnded(result.reason));
      if (ended) {
        setState({ status: "error", failure: { kind: "session_ended" } });
        return;
      }
      if (profile.status === "rejected") {
        setState({ status: "error", failure: classifyTodayError(profile.reason) });
        return;
      }
      setState({ status: "ready", profile: profile.value, hasPlan: today.status === "fulfilled" && Boolean(today.value.plan) });
    })();
    return () => controller.abort();
  }, [api, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  const replaceProfile = useCallback((profile: Profile) => {
    setState((current) => (current.status === "ready" ? { ...current, profile } : current));
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
  return { state, reload, replaceProfile, online, reconnected, waking: online && waking };
}
