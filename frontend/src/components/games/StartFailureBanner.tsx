"use client";

import { FailureBanner } from "@/components/today/FailureBanner";
import type { TodayFailure } from "@/components/today/today-failure";
import { Banner } from "@/components/ui/Banner";
import { TextLink } from "@/components/ui/TextLink";
import { gamesMessages } from "@/i18n/games-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { todayMessages } from "@/i18n/today-messages";

// The banner for every way E18 and E20 `game` can fail on S-14 and on the result screen (P-19, P-04 to P-07), never the API `message`. The kinds of S-11
// carry over; G-20 differs in its action: «ابدأ خطتك» goes to S-08, and the plan and its history stay.
export function StartFailureBanner({
  failure,
  id,
  online,
  waking,
  onRetry,
  onRefresh,
}: {
  failure: TodayFailure;
  id: string;
  online: boolean;
  waking: boolean;
  // A read has «إعادة المحاولة»; a press has none, because the pressed control is the retry (P-19).
  onRetry?: () => void;
  onRefresh: () => void;
}) {
  const { locale } = useLocale();
  const t = gamesMessages(locale);
  if (failure.kind === "revoked") {
    return (
      <Banner id={id} variant="warning" action={<TextLink href="/start">{t.unavailable.action}</TextLink>}>
        {t.unavailable.text}
      </Banner>
    );
  }
  return <FailureBanner failure={failure} t={todayMessages(locale)} online={online} waking={waking} id={id} onRetry={onRetry} onRefresh={onRefresh} />;
}
