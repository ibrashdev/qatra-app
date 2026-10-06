"use client";

import { useId } from "react";
import { FailureBanner } from "@/components/today/FailureBanner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import { sessionMessages } from "@/i18n/session-messages";
import { todayMessages } from "@/i18n/today-messages";
import type { SessionFailure } from "./session-failure";

// One banner for every way E18, E20, E21 and E22 can fail while the session is open (P-04 to P-07, P-22). The generic ones are the copy of S-11;
// a lost connection speaks the line of the round, which is true here because the events wait and are sent again (E21 is idempotent).
export function SessionFailureBanner({
  failure,
  online,
  waking,
  onRetry,
  onRefresh,
}: {
  failure: SessionFailure;
  online: boolean;
  waking: boolean;
  onRetry?: () => void;
  onRefresh: () => void;
}) {
  const { locale } = useLocale();
  const t = sessionMessages(locale);
  const id = useId();
  const retry =
    onRetry === undefined ? undefined : (
      <Button variant="secondary" onClick={onRetry}>
        {t.primary.retry}
      </Button>
    );

  switch (failure.kind) {
    case "too_large":
      return (
        <Banner id={id} variant="error" role="alert">
          {t.banners.tooLarge}
        </Banner>
      );
    case "not_found":
    case "session_ended":
    case "aborted":
      return null;
    default:
      if (failure.kind === "connectivity" && !online) {
        return (
          <Banner id={id} variant="info" action={retry}>
            <p>{t.banners.offlineQueue}</p>
            <p className="mt-q4">{t.banners.keepOpen}</p>
          </Banner>
        );
      }
      return <FailureBanner failure={failure} t={todayMessages(locale)} online={online} waking={waking} id={id} onRetry={onRetry} onRefresh={onRefresh} />;
  }
}

// G-11 and the rejected codes that end the plan's part (`plan_not_active`, `session_closed`): the session takes no more answers.
export function PlanInactiveBanner({ onBack }: { onBack: () => void }) {
  const { locale } = useLocale();
  const t = sessionMessages(locale).banners;
  return (
    <Banner
      variant="warning"
      action={
        <Button variant="secondary" onClick={onBack}>
          {t.backToToday}
        </Button>
      }
    >
      {t.planInactive}
    </Banner>
  );
}

// G-20: the edition was withdrawn. The text and the questions are not shown or guessed; the only ways on are Today and a new plan.
export function RevokedView({ onBack }: { onBack: () => void }) {
  const { locale } = useLocale();
  const t = sessionMessages(locale).banners;
  const today = todayMessages(locale).revoked;
  return (
    <Banner
      variant="error"
      role="alert"
      title={today.label}
      action={
        <div className="flex flex-wrap items-center gap-q12">
          <Button variant="secondary" onClick={onBack}>
            {t.backToToday}
          </Button>
          <TextLink href="/start">{today.startNew}</TextLink>
        </div>
      }
    >
      {today.text}
    </Banner>
  );
}
