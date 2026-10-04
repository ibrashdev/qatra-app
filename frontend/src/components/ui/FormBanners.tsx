"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatClock, formatInteger } from "@/i18n/format";
import { renderTemplate } from "@/i18n/template";
import { useApiRuntime } from "@/lib/api/react";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

// The three live areas of a form (UI-screens "Slot B", directly above the submit button, so a banner raised by a press is where the finger is).
// Both status areas stay in the page while empty, because a polite region announces only what is added to a region that already exists.
export function BannerSlot({ polite, alert, announcement }: { polite?: ReactNode; alert?: ReactNode; announcement?: ReactNode }) {
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="false" className="has-[*]:mt-q24">
        {polite}
      </div>
      <div className="has-[*]:mt-q24">{alert}</div>
      <div role="status" aria-live="polite" aria-atomic="false" className="sr-only">
        {announcement}
      </div>
    </>
  );
}

// P-05: no connection. Info, not an error: nothing was lost and nothing is retried on its own.
export function OfflineBanner() {
  const { messages } = useLocale();
  return <Banner variant="info">{messages.form.offline}</Banner>;
}

// P-04: the free server is waking up. The loader is static under reduced motion; after 90 s the banner gains a retry that restarts the polling.
export function WakeUpBanner({ timedOut }: { timedOut: boolean }) {
  const { messages } = useLocale();
  const { wakeUp } = useApiRuntime();
  return (
    <Banner
      variant="info"
      icon={<Spinner />}
      action={
        timedOut ? (
          <Button variant="secondary" onClick={() => wakeUp.retry()}>
            {messages.server.retry}
          </Button>
        ) : null
      }
    >
      {messages.server.waking}
    </Banner>
  );
}

// P-06: static wording frozen at receipt. Up to a minute it counts in seconds, longer (the 15-minute lock) as mm:ss.
export function ThrottleBanner({ id, retryAfterSec }: { id: string; retryAfterSec: number }) {
  const { locale, messages } = useLocale();
  const text =
    retryAfterSec <= 60
      ? messages.form.throttleSeconds(formatInteger(locale, retryAfterSec))
      : renderTemplate(messages.form.throttleClock, { time: <bdi dir="ltr">{formatClock(locale, retryAfterSec)}</bdi> });
  return (
    <Banner id={id} variant="warning">
      {text}
    </Banner>
  );
}

// P-07: generic service errors. A press raised them, so the two errors are alerts; "unavailable" is a warning in the polite area.
export function ServiceAlert({ kind, onReload }: { kind: "internal" | "origin"; onReload: () => void }) {
  const { messages } = useLocale();
  if (kind === "internal") {
    return (
      <Banner variant="error" role="alert">
        {messages.form.internal}
      </Banner>
    );
  }
  return (
    <Banner
      variant="error"
      role="alert"
      action={
        <Button variant="secondary" onClick={onReload}>
          {messages.form.reloadPage}
        </Button>
      }
    >
      {messages.form.forbiddenOrigin}
    </Banner>
  );
}

export function UnavailableBanner() {
  const { messages } = useLocale();
  return <Banner variant="warning">{messages.form.unavailable}</Banner>;
}
