"use client";

import { Banner } from "@/components/ui/Banner";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";

// A signed-in account that is not a content manager (403 `forbidden`): the page says so and offers the way back. It shows no data and no control of
// the admin, and no wording that tells how a manager is named.
export function NotManagerView() {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  return (
    <div className="mt-q24 flex flex-col items-start gap-q16">
      <Banner variant="warning">{t.notManager}</Banner>
      <TextLink href="/settings">{t.backToSettings}</TextLink>
    </div>
  );
}
