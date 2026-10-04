"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { Spinner } from "./Spinner";
import { StatusMessage } from "./StatusMessage";

// G-01 and G-23. The polite live region is always in the DOM, so a screen reader announces what appears inside it.
export function WakeUpStatus() {
  const { messages } = useLocale();
  const { wakeUp } = useApiRuntime();
  const { phase } = useWakeUpState();

  return (
    <div role="status" aria-live="polite" className="has-[*]:mb-q16">
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
    </div>
  );
}
