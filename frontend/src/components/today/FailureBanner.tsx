"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ThrottleBanner } from "@/components/ui/FormBanners";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import type { TodayMessages } from "@/i18n/today-messages";
import { reloadPage } from "@/lib/browser";
import { isAlertFailure, type TodayFailure } from "./today-failure";

export interface FailureBannerProps {
  failure: TodayFailure;
  t: TodayMessages;
  online: boolean;
  waking: boolean; // the shell already shows the wake-up line (P-04)
  id: string;
  // A read has «إعادة المحاولة» (S-11 section 4); a press has none, because the session button is the retry.
  onRetry?: () => void;
  onRefresh: () => void;
}

// One banner for every way E18, E19 and E20 can fail: generic, from the copy deck, never the API `message` (UI-tokens 6.8).
export function FailureBanner({ failure, t, online, waking, id, onRetry, onRefresh }: FailureBannerProps) {
  const { messages } = useLocale();
  const alert = isAlertFailure(failure) ? ("alert" as const) : undefined;
  const retry =
    onRetry === undefined ? undefined : (
      <Button variant="secondary" onClick={onRetry}>
        {t.retry}
      </Button>
    );
  const refresh = (
    <Button variant="secondary" onClick={onRefresh}>
      {t.conflict.refresh}
    </Button>
  );

  switch (failure.kind) {
    case "connectivity":
      // P-05 offline is an Info banner. With the browser online, a waking server is spoken for by the shell, and anything else is a plain outage.
      if (!online) return <Banner id={id} variant="info" action={retry}>{messages.form.offline}</Banner>;
      if (waking) return null;
      return <Banner id={id} variant="warning" action={retry}>{messages.form.unavailable}</Banner>;
    case "unavailable":
      return <Banner id={id} variant="warning" action={retry}>{messages.form.unavailable}</Banner>;
    case "internal":
      return <Banner id={id} variant="error" role={alert} action={retry}>{messages.form.internal}</Banner>;
    case "origin":
      return (
        <Banner
          id={id}
          variant="error"
          role={alert}
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
      return <ThrottleBanner id={id} retryAfterSec={failure.retryAfterSec} />;
    case "plan_version":
      return <Banner id={id} variant="warning" action={refresh}>{t.conflict.planVersion}</Banner>;
    case "plan_not_active":
      return <Banner id={id} variant="warning" action={refresh}>{t.conflict.planNotActive}</Banner>;
    case "revoked":
      return (
        <Banner id={id} variant="error" role={alert} title={t.revoked.label} action={<TextLink href="/start">{t.revoked.startNew}</TextLink>}>
          {t.revoked.text}
        </Banner>
      );
    case "session_ended":
    case "aborted":
      return null;
  }
}
