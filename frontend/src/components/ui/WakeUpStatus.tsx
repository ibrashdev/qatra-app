"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { useConnectivityStatus } from "@/lib/net/use-connectivity";
import { Spinner } from "./Spinner";
import { StatusMessage } from "./StatusMessage";

// G-01 and G-23. The polite live region is always in the DOM, so a screen reader announces what appears inside it. A shell passes its offline notice as
// `children`, so the one region carries both. While the device itself is offline the free server is not "starting" and nothing is "loading" from it, so the
// busy, waking and ready lines are not shown (the notice of the shell speaks for the connection); the region itself stays in the page.
export function WakeUpStatus({ children }: { children?: ReactNode }) {
  const { messages } = useLocale();
  const { wakeUp } = useApiRuntime();
  const { phase: wakePhase } = useWakeUpState();
  const { status } = useConnectivityStatus();
  const phase = status === "offline" ? "idle" : wakePhase;

  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-q12 has-[*]:mb-q16">
      {phase === "busy" ? (
        <p className="flex items-center gap-q8 text-small text-ink-secondary">
          <Spinner />
          {messages.server.busy}
        </p>
      ) : null}
      {phase === "waking" || phase === "timed_out" ? (
        <StatusMessage
          leading={<Spinner className="mt-0.5" />}
          action={
            phase === "timed_out" ? (
              <button
                type="button"
                onClick={() => wakeUp.retry()}
                className="inline-flex min-h-button min-w-22 items-center justify-center rounded-sm border border-edge-selected bg-surface px-q24 text-button text-primary-deep transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection active:border-primary-deep"
              >
                {messages.server.retry}
              </button>
            ) : null
          }
        >
          {messages.server.waking}
        </StatusMessage>
      ) : null}
      {phase === "ready" ? <p className="sr-only">{messages.server.ready}</p> : null}
      {children}
    </div>
  );
}
