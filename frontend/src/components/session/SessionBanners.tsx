"use client";

import { useId } from "react";
import { FailureBanner } from "@/components/today/FailureBanner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import { sessionMessages } from "@/i18n/session-messages";
import { todayMessages } from "@/i18n/today-messages";
import type { OnlineQueueStatus } from "./durable-online-queue";
import type { FinishPending, SessionFailure } from "./session-failure";

// The lines of an online run that has lost its connection (P-05): the retry line, then what is true about the answers. Where the device keeps them (the online
// journal) the fixed G-22 line says so; where it cannot, the answers live in this page and the line says not to leave it, and a failed write says why.
// `null` says this screen holds no answers at all (a session that could not even be loaded): only the retry line is true then. Left out, the answers are
// taken to live in the page's memory (a result screen whose finish failed, with no journal behind it).
export function OfflineRunLines({ durability }: { durability?: OnlineQueueStatus | null }) {
  const { locale } = useLocale();
  const t = sessionMessages(locale);
  if (durability === null) return <p>{t.banners.offlineQueue}</p>;
  const saved = durability?.mode === "durable" && !durability.storageProblem;
  return (
    <>
      <p>{t.banners.offlineQueue}</p>
      {durability?.storageProblem ? <p className="mt-q4">{t.banners.storageProblem}</p> : null}
      <p className="mt-q4">{saved ? offlineMessages(locale).sync.savedOnDevice : t.banners.keepOpen}</p>
    </>
  );
}

// One banner for every way E18, E20, E21 and E22 can fail while the session is open (P-04 to P-07, P-22). The generic ones are the copy of S-11;
// a lost connection speaks the line of the round, which is true here because the events wait and are sent again (E21 is idempotent).
export function SessionFailureBanner({
  failure,
  online,
  waking,
  onRetry,
  onRefresh,
  durability,
}: {
  failure: SessionFailure | FinishPending;
  online: boolean;
  waking: boolean;
  onRetry?: () => void;
  onRefresh: () => void;
  // Where the answers of this run live, for the line that says what is true about them while the connection is gone.
  durability?: OnlineQueueStatus | null;
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
    case "finish_pending":
      // The finish is recorded on the device and owed to the server: not an error. The result is confirmed only after the server answers.
      return (
        <Banner id={id} variant="info" action={retry}>
          {t.banners.finishPending}
        </Banner>
      );
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
            <OfflineRunLines durability={durability} />
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
