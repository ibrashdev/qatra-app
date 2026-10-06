"use client";

import { FailureBanner } from "@/components/today/FailureBanner";
import { isAlertFailure } from "@/components/today/today-failure";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { useLocale } from "@/i18n/LocaleProvider";
import { demoMessages } from "@/i18n/demo-messages";
import { todayMessages } from "@/i18n/today-messages";
import { isTodayKind, type DemoFailure } from "./demo-failure";

export interface DemoFailureBannerProps {
  failure: DemoFailure;
  id: string;
  online: boolean;
  waking: boolean; // the shell already shows the wake-up line (P-04)
  // A read has «إعادة المحاولة»; the build press has none, because pressing the build button again is the retry.
  onRetry?: () => void;
  // «إعادة تحميل الصفحة» of the race with another plan (G-13).
  onRefresh: () => void;
}

// An error raised by a press is read out at once; the others wait in the polite area (P-07).
export function isAlertDemoFailure(failure: DemoFailure): boolean {
  return isTodayKind(failure) && isAlertFailure(failure);
}

// One banner for every way the demo reads and the build press can fail: generic, from the copy deck, never the API `message` (UI-tokens 6.8).
// The failures that S-11 already words are worded by its banner; the demo adds the lost race and the vanished scenario.
export function DemoFailureBanner({ failure, id, online, waking, onRetry, onRefresh }: DemoFailureBannerProps) {
  const { locale, messages } = useLocale();
  const text = demoMessages(locale).scenario.failure;

  if (isTodayKind(failure)) {
    return <FailureBanner failure={failure} t={todayMessages(locale)} online={online} waking={waking} id={id} onRetry={onRetry} onRefresh={onRefresh} />;
  }
  switch (failure.kind) {
    case "active_plan_conflict":
      return (
        <Banner
          id={id}
          variant="warning"
          action={
            <Button variant="secondary" onClick={onRefresh}>
              {messages.form.reloadPage}
            </Button>
          }
        >
          <span className="[overflow-wrap:anywhere]">{text.activePlanRace}</span>
        </Banner>
      );
    case "unknown_scenario":
      return (
        <Banner id={id} variant="warning">
          <span className="[overflow-wrap:anywhere]">{text.unknownScenario}</span>
        </Banner>
      );
    case "forbidden":
      // The screen is already leaving for S-11: there is nothing to say here.
      return null;
  }
}
