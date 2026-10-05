"use client";

import { LinkButton } from "@/components/progress/LinkButton";
import { TermsBody } from "@/components/terms/TermsBody";
import { BackControl } from "@/components/ui/BackControl";
import { PageTitle } from "@/components/ui/PageTitle";
import { useLocale } from "@/i18n/LocaleProvider";
import { privacyMessages } from "@/i18n/privacy-messages";
import { usePrivacyGuard } from "./use-privacy-guard";

// S-26 Privacy and data (UI-screens Batch 4, package F11): the text of S-03 in the signed-in shell, with this frame's own H1, back control and closing
// button. The text is static and renders at once; opening it with `#privacy` or `#terms` focuses that heading, which the app shell does on arrival
// (the headings of TermsBody carry `tabindex="-1"`). Presentation only: the wording is owned by terms-text.ts.
export function PrivacyScreen() {
  const { locale, messages } = useLocale();
  const t = privacyMessages(locale);
  usePrivacyGuard();

  return (
    <div>
      <PageTitle screenName={messages.screens.terms} />
      <div className="flex items-center gap-q12">
        <BackControl destination={messages.tabs.settings} href="/settings" />
        <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
          {messages.screens.terms}
        </h1>
      </div>
      <TermsBody />
      <div className="mt-q32">
        <LinkButton href="/settings" variant="secondary">
          {t.returnButton}
        </LinkButton>
      </div>
    </div>
  );
}
