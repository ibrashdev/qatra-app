"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import type { TabId } from "@/i18n/messages";
import { PageTitle } from "./PageTitle";

export type PlaceholderScreen = TabId | "login";

// Stands in for a screen that arrives in a later batch (F0 builds no real screen). It says so plainly and holds no other control.
export function PlaceholderPage({ screen }: { screen: PlaceholderScreen }) {
  const { messages } = useLocale();
  const name = screen === "login" ? messages.screens.login : messages.tabs[screen];
  return (
    <>
      <PageTitle screenName={name} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {name}
      </h1>
      <p className="mt-q16 text-body text-ink-secondary">{messages.placeholder.notBuilt}</p>
    </>
  );
}
