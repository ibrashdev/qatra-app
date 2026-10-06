"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError, isConnectivityError, isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { classifyDemoError, type DemoFailure } from "./demo-failure";

export type DemoAccess =
  | { status: "checking" }
  | { status: "allowed" }
  | { status: "leaving" } // a redirect is under way: a visitor goes to S-01, a learner goes to S-11
  | { status: "failed"; failure: DemoFailure };

// The guard of S-29 and S-30 (UI-design 2.3 guards 1 and 11): a visitor goes to /login?next=<path>, an account that is not a demo account goes
// to /today, and only a demo account (E11 `isDemo`) sees the screen. A read that failed on connectivity runs again once a sleeping server answers (P-04).
export function useDemoAccess(next: string): { access: DemoAccess; retry: () => void } {
  const router = useRouter();
  const { api, wakeUp } = useApiRuntime();
  const [attempt, setAttempt] = useState(0);
  // The answer belongs to the attempt that asked for it; an answer of an older attempt reads as "checking" again for the new one.
  const [answer, setAnswer] = useState<{ attempt: number; access: DemoAccess } | null>(null);
  const failedOnConnectivity = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    failedOnConnectivity.current = false;
    api
      .me({ signal })
      .then((profile) => {
        if (signal.aborted) return;
        if (profile.isDemo) {
          setAnswer({ attempt, access: { status: "allowed" } });
          return;
        }
        setAnswer({ attempt, access: { status: "leaving" } });
        router.replace("/today");
      })
      .catch((error: unknown) => {
        if (signal.aborted || isAbortError(error)) return;
        // A visitor has no session: the return path is kept, and the banner of an ended session is not raised because nothing ended.
        if (isSessionEnded(error)) {
          setAnswer({ attempt, access: { status: "leaving" } });
          router.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        failedOnConnectivity.current = isConnectivityError(error);
        setAnswer({ attempt, access: { status: "failed", failure: classifyDemoError(error) } });
      });
    return () => controller.abort();
  }, [api, attempt, next, router]);

  const access: DemoAccess = answer !== null && answer.attempt === attempt ? answer.access : { status: "checking" };

  useEffect(
    () =>
      wakeUp.onReady(() => {
        if (failedOnConnectivity.current) setAttempt((count) => count + 1);
      }),
    [wakeUp],
  );

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { access, retry };
}
