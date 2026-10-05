"use client";

import type { ReactNode } from "react";
import { FailureBanner } from "@/components/today/FailureBanner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { useLocale } from "@/i18n/LocaleProvider";
import { planOverviewMessages } from "@/i18n/plan-overview-messages";
import { todayMessages } from "@/i18n/today-messages";
import { isTodayFailure, type PlanFailure } from "./plan-failure";

export interface PlanFailureBannerProps {
  failure: PlanFailure;
  id: string;
  online: boolean;
  waking: boolean; // the shell already shows the wake-up line (P-04)
  // «إعادة المحاولة»: a read has it, and so does the start button of S-13. A press that writes has none, because pressing again is the retry.
  onRetry?: () => void;
  onRefresh: () => void;
  // The line of E30 or E31 `plan_not_active`: the plan completed, so it can be neither revised nor resumed (G-11).
  completedWhenNotActive?: boolean;
  // A control that goes with the banner: «تعديل بالنموذج» next to the retry, or the way back to S-12.
  action?: ReactNode;
}

// One banner for every way the reads and the presses of S-12 and S-13 can fail: generic, from the copy deck, never the API `message` (UI-tokens 6.8).
export function PlanFailureBanner({ failure, id, online, waking, onRetry, onRefresh, completedWhenNotActive = false, action }: PlanFailureBannerProps) {
  const { locale, messages } = useLocale();
  const text = planOverviewMessages(locale).failure;
  const today = todayMessages(locale);

  const controls =
    onRetry === undefined && action === undefined ? undefined : (
      <div className="flex flex-wrap items-center gap-q8">
        {onRetry === undefined ? null : (
          <Button variant="secondary" onClick={onRetry}>
            {today.retry}
          </Button>
        )}
        {action}
      </div>
    );

  switch (failure.kind) {
    case "forbidden":
      return <Banner id={id} variant="warning">{text.forbidden}</Banner>;
    case "not_found":
      return <Banner id={id} variant="warning" action={action}>{text.notFound}</Banner>;
    case "estimate_changed":
      return <Banner id={id} variant="warning">{text.estimateChanged}</Banner>;
    case "plan_not_active":
      return <Banner id={id} variant="warning" action={action}>{completedWhenNotActive ? text.notActiveCompleted : text.notActive}</Banner>;
    case "validation":
      // The screens send only values the plan or the form already holds, so a rule that has no field means something else is wrong.
      return <FailureBanner failure={{ kind: "internal" }} t={today} online={online} waking={waking} id={id} onRefresh={onRefresh} />;
    case "connectivity":
      // P-05 offline is an Info banner. With the browser online, a waking server is spoken for by the shell, and anything else is a plain outage.
      if (!online) return <Banner id={id} variant="info" action={controls}>{messages.form.offline}</Banner>;
      if (waking) return null;
      return <Banner id={id} variant="warning" action={controls}>{messages.form.unavailable}</Banner>;
    case "unavailable":
      return <Banner id={id} variant="warning" action={controls}>{messages.form.unavailable}</Banner>;
    case "internal":
      return <Banner id={id} variant="error" role="alert" action={controls}>{messages.form.internal}</Banner>;
    default:
      return isTodayFailure(failure) ? <FailureBanner failure={failure} t={today} online={online} waking={waking} id={id} onRetry={onRetry} onRefresh={onRefresh} /> : null;
  }
}
