"use client";

import { Button } from "@/components/ui/Button";
import { PageTitle } from "@/components/ui/PageTitle";
import { PublicShell } from "@/components/ui/PublicShell";
import { useLocale } from "@/i18n/LocaleProvider";
import { getTermsText } from "@/i18n/terms-text";
import { TermsBody } from "./TermsBody";
import { useTermsReturn } from "./use-terms-return";

// S-03 in the public shell. Guard 13: always open, so there is no session probe and no redirect. It calls no API, so the wake-up line is off.
export function TermsScreen() {
  const { locale, messages } = useLocale();
  const { opener, back, goBack } = useTermsReturn();
  return (
    <PublicShell back={back} logo={false} wakeUp={false} reading>
      <PageTitle screenName={messages.screens.terms} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.screens.terms}
      </h1>
      <TermsBody />
      <div className="mt-q32">
        <Button variant="secondary" onClick={goBack}>
          {getTermsText(locale).returnButton[opener]}
        </Button>
      </div>
    </PublicShell>
  );
}
