"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isConnectivityError } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { homeDestination } from "./destination";

// Guard 2 (UI-design 2.3): a valid session sends the guest screens to /today, or to /start without a plan. E11 answers 200 only with a session.
// Any other answer, 401 included, leaves the form where it is. The probe is a read, so it runs again once a sleeping server answers (P-04).
export function useSignedInRedirect(): void {
  const router = useRouter();
  const { api, wakeUp, boot } = useApiRuntime();

  useEffect(() => {
    // A child effect runs before the provider's, so the first request of the page load (E01) is sent here, ahead of the probe.
    boot();
    let controller: AbortController | null = null;
    let retryWhenReady = false;

    async function probe() {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        await api.me({ signal: current.signal });
        const destination = await homeDestination(api, current.signal);
        if (!current.signal.aborted) router.replace(destination);
      } catch (error) {
        retryWhenReady = isConnectivityError(error);
      }
    }

    void probe();
    const stop = wakeUp.onReady(() => {
      if (retryWhenReady) void probe();
    });
    return () => {
      controller?.abort();
      stop();
    };
  }, [api, boot, router, wakeUp]);
}
