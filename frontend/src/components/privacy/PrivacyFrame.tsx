"use client";

import type { ReactNode } from "react";
import { BackControl } from "@/components/ui/BackControl";
import { PageTitle } from "@/components/ui/PageTitle";
import { useLocale } from "@/i18n/LocaleProvider";

// The frame of S-26: the page title, the back control to Settings and the H1. It is the layout of the route, so it does not unmount when the
// content below it changes between the loading view, the text and the "text unavailable" view. The app shell moves focus to the page heading when
// the route changes, and that heading must be one that stays: a heading that belonged to a view would go with it, and focus would fall to the page.
export function PrivacyFrame({ children }: { children: ReactNode }) {
  const { messages } = useLocale();
  return (
    <div>
      <PageTitle screenName={messages.screens.terms} />
      <div className="flex items-center gap-q12">
        <BackControl destination={messages.tabs.settings} href="/settings" />
        <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
          {messages.screens.terms}
        </h1>
      </div>
      {children}
    </div>
  );
}
