"use client";

import { BackControl } from "@/components/ui/BackControl";
import { PageTitle } from "@/components/ui/PageTitle";
import { useLocale } from "@/i18n/LocaleProvider";
import { accountSecurityMessages } from "@/i18n/account-security-messages";

// c1 of S-23, S-24 and S-27 (P-26): the back control to S-22 at the start edge and the H1. The signed-in shell has no bar slot for a back
// control, so the pair sits at the top of the page, as on S-12 and S-13. After a route change the shell moves focus to the H1 (data-page-heading).
export function ScreenHeader({ title }: { title: string }) {
  const { locale } = useLocale();
  const copy = accountSecurityMessages(locale);
  return (
    <>
      <PageTitle screenName={title} />
      <div className="flex items-center gap-q12">
        <BackControl destination={copy.backDestination} href="/settings" />
        <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
          {title}
        </h1>
      </div>
    </>
  );
}
