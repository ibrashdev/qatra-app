"use client";

import { useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatClock, formatInteger } from "@/i18n/format";
import { renderTemplate } from "@/i18n/template";
import { reloadPage } from "@/lib/browser";
import type { CatalogFailure } from "@/lib/catalog/catalog-failure";

export interface CatalogFailureBannerProps {
  failure: CatalogFailure;
  online: boolean;
  // The wake-up line is already on screen, so a lost connection adds nothing (P-04).
  waking: boolean;
  id: string;
  onRetry: () => void;
}

// One banner for every way E14 can fail on S-07 and S-25: generic, from the copy deck, never the API `message` (UI-tokens 6.8). A read is safe to
// repeat, so each one offers «إعادة المحاولة». The service errors take focus to that button, as the state tables say; offline and the throttle leave it.
export function CatalogFailureBanner({ failure, online, waking, id, onRetry }: CatalogFailureBannerProps) {
  const { messages } = useLocale();
  const retry = (focused: boolean) => (
    <Button variant="secondary" autoFocus={focused} onClick={onRetry}>
      {messages.server.retry}
    </Button>
  );

  switch (failure.kind) {
    case "connectivity":
      // P-05 offline is an Info banner. With the browser online, a waking server is spoken for by the wake-up line, and anything else is a plain outage.
      if (!online) return <Banner id={id} variant="info" action={retry(false)}>{messages.form.offline}</Banner>;
      if (waking) return null;
      return <Banner id={id} variant="warning" action={retry(true)}>{messages.form.unavailable}</Banner>;
    case "unavailable":
      return <Banner id={id} variant="warning" action={retry(true)}>{messages.form.unavailable}</Banner>;
    case "internal":
      return <Banner id={id} variant="error" role="alert" action={retry(true)}>{messages.form.internal}</Banner>;
    case "origin":
      return (
        <Banner
          id={id}
          variant="error"
          role="alert"
          action={
            <Button variant="secondary" onClick={reloadPage}>
              {messages.form.reloadPage}
            </Button>
          }
        >
          {messages.form.forbiddenOrigin}
        </Banner>
      );
    case "throttled":
      return <ThrottledBanner id={id} retryAfterSec={failure.retryAfterSec} onRetry={onRetry} />;
    case "session_ended":
    case "aborted":
      return null;
  }
}

// P-06: the wording is frozen at receipt (seconds up to a minute, mm:ss after). The retry stays focusable but inert until the time is up, a line under
// it counts for the eye only, and the end is announced once.
function ThrottledBanner({ id, retryAfterSec, onRetry }: { id: string; retryAfterSec: number; onRetry: () => void }) {
  const { locale, messages } = useLocale();
  const [endsAt] = useState(() => performance.now() + retryAfterSec * 1000);
  const [over, setOver] = useState(false);
  const text =
    retryAfterSec <= 60
      ? messages.form.throttleSeconds(formatInteger(locale, retryAfterSec))
      : renderTemplate(messages.form.throttleClock, { time: <bdi dir="ltr">{formatClock(locale, retryAfterSec)}</bdi> });

  return (
    <>
      <Banner
        id={id}
        variant="warning"
        action={
          <div className="flex flex-wrap items-center gap-x-q12 gap-y-q8">
            <Button variant="secondary" aria-disabled={over ? undefined : true} aria-describedby={over ? undefined : id} onClick={onRetry}>
              {messages.server.retry}
            </Button>
            {over ? null : <Countdown endsAt={endsAt} totalSeconds={retryAfterSec} onDone={() => setOver(true)} />}
          </div>
        }
      >
        {text}
      </Banner>
      {over ? <p className="sr-only">{messages.form.throttleOver}</p> : null}
    </>
  );
}
