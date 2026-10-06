"use client";

import { LinkButton } from "@/components/progress/LinkButton";
import { TermsBody } from "@/components/terms/TermsBody";
import { useArrivalFocus } from "@/components/ui/use-page-chrome";
import { useLocale } from "@/i18n/LocaleProvider";
import { privacyMessages } from "@/i18n/privacy-messages";
import { usePrivacyGuard } from "./use-privacy-guard";

// S-26 Privacy and data (UI-screens Batch 4, package F11): the text of S-03 in the signed-in shell, with this frame's own closing button. The H1,
// the back control and the page title are in PrivacyFrame (the layout of the route), so they stay while this content loads, fails to load and arrives.
// The text is static and renders at once; opening it with `#privacy` or `#terms` focuses that heading, which the app shell does when the content is
// there at the route change, and this screen does when it arrives later (the headings of TermsBody carry `tabindex="-1"`).
// Presentation only: the wording is owned by terms-text.ts.
export function PrivacyScreen() {
  const { locale } = useLocale();
  const t = privacyMessages(locale);
  usePrivacyGuard();
  useArrivalFocus();

  return (
    <>
      <TermsBody />
      <div className="mt-q32">
        <LinkButton href="/settings" variant="secondary">
          {t.returnButton}
        </LinkButton>
      </div>
    </>
  );
}
