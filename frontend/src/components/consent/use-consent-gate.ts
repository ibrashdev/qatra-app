"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, ConnectivityError, isAbortError, isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { TERMS_VERSION } from "@/lib/config";

export type GateFailure = "connectivity" | "unavailable" | "internal";

export type GateState =
  | { status: "loading" }
  | { status: "ready"; username: string }
  | { status: "error"; failure: GateFailure }
  // A redirect is on its way (no session, or no pending change): nothing of the gate is shown.
  | { status: "leaving" };

export interface ConsentGate {
  state: GateState;
  reload: () => void;
}

function classifyLoadError(error: unknown): GateFailure {
  if (error instanceof ConnectivityError) return "connectivity";
  if (error instanceof ApiError && error.code === "unavailable") return "unavailable";
  return "internal";
}

// A change is pending when the profile holds a terms version other than the one this build shows. A build without a version cannot compare, so
// it shows the gate and lets the server judge (E05 `400 terms_required`).
export function termsChangePending(profileVersion: string, bundledVersion: string | null): boolean {
  return bundledVersion === null || profileVersion !== bundledVersion;
}

// The entry rules of S-06: without a session `/login?next=/consent`, without a pending change `/today`, otherwise the gate with the account
// name from E11. Both redirects replace the history entry, so back never returns to a gate that has nothing to ask.
export function useConsentGate(): ConsentGate {
  const { api, boot, wakeUp } = useApiRuntime();
  const router = useRouter();
  const [state, setState] = useState<GateState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // A child effect runs before the provider's, so the first request of the page load (E01) is sent here, ahead of E11.
    boot();
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const profile = await api.me({ signal });
        if (signal.aborted) return;
        if (termsChangePending(profile.termsVersion, TERMS_VERSION)) {
          setState({ status: "ready", username: profile.username });
          return;
        }
        setState({ status: "leaving" });
        router.replace("/today");
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        if (isSessionEnded(error)) {
          setState({ status: "leaving" });
          router.replace(`/login?next=${encodeURIComponent("/consent")}`);
          return;
        }
        setState({ status: "error", failure: classifyLoadError(error) });
      }
    })();
    return () => controller.abort();
  }, [api, boot, router, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  // A read is repeated once a sleeping server answers (P-04), and again when the connection is back.
  useEffect(() => {
    const stop = wakeUp.onReady(() => {
      if (state.status === "error" && state.failure === "connectivity") reload();
    });
    return stop;
  }, [wakeUp, state, reload]);

  useEffect(() => {
    if (state.status !== "error") return;
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, [state, reload]);

  return { state, reload };
}
