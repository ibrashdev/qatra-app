"use client";

import { useId } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ThrottleBanner } from "@/components/ui/FormBanners";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { useWakeUpState } from "@/lib/api/react";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { isAlertFailure, type AdminFailure } from "./admin-failure";

export interface AdminFailureBannerProps {
  failure: AdminFailure;
  // A read has «إعادة المحاولة»; a press has none, because pressing the button again is the retry.
  onRetry?: () => void;
  // A row that changed or vanished under the manager: reads the data again.
  onReload?: () => void;
  id?: string;
}

// One banner for every way the admin API can fail: fixed copy from the deck, never the API `message` (UI-tokens 6.8).
export function AdminFailureBanner({ failure, onRetry, onReload, id }: AdminFailureBannerProps) {
  const { locale, messages } = useLocale();
  const t = adminMessages(locale);
  const { online } = useConnectivity();
  const wake = useWakeUpState();
  const fallbackId = useId();
  const bannerId = id ?? fallbackId;
  const waking = online && (wake.phase === "waking" || wake.phase === "timed_out");
  const role = isAlertFailure(failure) ? ("alert" as const) : undefined;

  const retry =
    onRetry === undefined ? undefined : (
      <Button variant="secondary" onClick={onRetry}>
        {messages.server.retry}
      </Button>
    );
  const reload =
    onReload === undefined ? undefined : (
      <Button variant="secondary" onClick={onReload}>
        {t.failures.reload}
      </Button>
    );

  switch (failure.kind) {
    case "connectivity":
      // P-05 offline is an Info banner. With the browser online, a waking server is spoken for by the shell, and anything else is a plain outage.
      if (!online) return <Banner id={bannerId} variant="info" action={retry}>{messages.form.offline}</Banner>;
      if (waking) return null;
      return <Banner id={bannerId} variant="warning" action={retry}>{messages.form.unavailable}</Banner>;
    case "unavailable":
      return <Banner id={bannerId} variant="warning" action={retry}>{messages.form.unavailable}</Banner>;
    case "internal":
      return <Banner id={bannerId} variant="error" role={role} action={retry}>{messages.form.internal}</Banner>;
    case "origin":
      return (
        <Banner
          id={bannerId}
          variant="error"
          role={role}
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
      return <ThrottleBanner id={bannerId} retryAfterSec={failure.retryAfterSec} />;
    case "forbidden":
      return <Banner id={bannerId} variant="error" role={role}>{t.notManager}</Banner>;
    case "not_found":
      return <Banner id={bannerId} variant="warning" role={role} action={reload}>{t.failures.notFound}</Banner>;
    case "stale":
      return <Banner id={bannerId} variant="warning" role={role} action={reload}>{t.failures.stale}</Banner>;
    case "state":
      return <Banner id={bannerId} variant="warning" role={role} action={reload}>{t.failures.state}</Banner>;
    case "in_use":
      return <Banner id={bannerId} variant="warning" role={role}>{t.failures.inUse}</Banner>;
    case "invalid":
      return <Banner id={bannerId} variant="error" role={role}>{t.failures.invalid}</Banner>;
    case "session_ended":
    case "aborted":
      return null;
  }
}

// The place of a press's failure, and of the plain line that says nothing was sent. The status region is in the page before anything is put in it,
// so what arrives is announced; an alert banner inside it is read out at once.
export function ActionFailure({ failure, note, onReload }: { failure: AdminFailure | null; note?: string | null; onReload?: () => void }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-col gap-q12 has-[*]:mt-q16">
      {note ? <p className="text-body-compact text-ink-secondary">{note}</p> : null}
      {failure === null ? null : <AdminFailureBanner failure={failure} onReload={onReload} />}
    </div>
  );
}
