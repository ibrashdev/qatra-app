"use client";

import { useEffect, useId } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageTitle } from "@/components/ui/PageTitle";
import { PublicShell } from "@/components/ui/PublicShell";
import { useLocale } from "@/i18n/LocaleProvider";
import { useTermsReturn } from "./use-terms-return";

// S-03 "Text unavailable": the route could not load. The header stays, an error banner says so, and focus goes to its button.
// The shell does not move focus on its own, so the heading is not chosen over the button; a later successful retry mounts the screen,
// which then moves focus to its heading.
export function TermsError({ retry }: { retry: () => void }) {
  const { messages } = useLocale();
  const { back } = useTermsReturn();
  const retryId = useId();

  useEffect(() => {
    document.getElementById(retryId)?.focus();
  }, [retryId]);

  return (
    <PublicShell back={back} logo={false} wakeUp={false} moveFocus={false} reading>
      <PageTitle screenName={messages.screens.terms} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.screens.terms}
      </h1>
      <div className="mt-q24">
        <Banner
          variant="error"
          role="alert"
          action={
            <Button id={retryId} variant="secondary" onClick={retry}>
              {messages.error.retry}
            </Button>
          }
        >
          {messages.terms.unavailable}
        </Banner>
      </div>
    </PublicShell>
  );
}
