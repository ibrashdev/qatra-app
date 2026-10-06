"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { classifyAdminError, type AdminFailure } from "./admin-failure";

export type AdminLoad<T> = { status: "loading" } | { status: "error"; failure: AdminFailure } | { status: "ready"; data: T };

export interface AdminResource<T> {
  state: AdminLoad<T>;
  // Reads again from the start: the screen shows its loading state, as the first read did.
  reload: () => void;
  // The answer of a write replaces the part of the data it changed, so the screen follows without another read.
  replace: (update: (current: T) => T) => void;
  online: boolean;
  reconnected: boolean; // the browser reported the connection back (P-05)
  waking: boolean;
}

// One read of the admin API for a screen. `key` names what is read (a route id), so the read starts again when it changes. A read that failed while
// the server was waking is sent again once health answers (P-04), once per wake-up so a failing server cannot loop. A read is always safe to repeat.
export function useAdminResource<T>(key: string, load: (client: ApiClient, signal: AbortSignal) => Promise<T>): AdminResource<T> {
  const { client } = useApiRuntime();
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  const [state, setState] = useState<AdminLoad<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // The loader is a new function on every render; the effect below reads the latest one and runs only for a new key or a new attempt.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const data = await loadRef.current(client, signal);
        if (!signal.aborted) setState({ status: "ready", data });
      } catch (error) {
        if (signal.aborted) return;
        const failure = classifyAdminError(error);
        if (failure.kind !== "aborted") setState({ status: "error", failure });
      }
    })();
    return () => controller.abort();
  }, [client, key, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  const replace = useCallback((update: (current: T) => T) => {
    setState((current) => (current.status === "ready" ? { status: "ready", data: update(current.data) } : current));
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
  return { state, reload, replace, online, reconnected, waking: online && waking };
}
