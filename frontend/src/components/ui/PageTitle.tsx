"use client";

import { useLocale } from "@/i18n/LocaleProvider";

// React hoists <title> into <head> and updates it with the language. Next's metadata title is not used:
// it commits after hydration and would overwrite the language the client has just resolved.
export function PageTitle({ screenName }: { screenName: string }) {
  const { messages } = useLocale();
  return <title>{messages.documentTitle(screenName)}</title>;
}
