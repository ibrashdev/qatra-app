"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { FocusShell } from "./FocusShell";
import { PlaceholderPage } from "./PlaceholderPage";
import { PublicShell } from "./PublicShell";

export type PlaceholderRouteScreen = "register" | "recovery" | "consent" | "start";

// A route the account screens already link or navigate to, whose own screen comes later: the register and recovery screens sit in the
// public shell, the re-consent gate and the start of the plan flow in the focus shell (UI-design 2.1).
export function PlaceholderRoute({ screen }: { screen: PlaceholderRouteScreen }) {
  const { messages } = useLocale();
  if (screen === "consent" || screen === "start") {
    return (
      <FocusShell title={messages.screens[screen]}>
        <p className="text-body text-ink-secondary">{messages.placeholder.notBuilt}</p>
      </FocusShell>
    );
  }
  return (
    <PublicShell>
      <PlaceholderPage screen={screen} />
    </PublicShell>
  );
}
