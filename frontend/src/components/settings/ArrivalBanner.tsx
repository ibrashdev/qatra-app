"use client";

import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { useLocale } from "@/i18n/LocaleProvider";
import { settingsMessages } from "@/i18n/settings-messages";
import { clearCodeUnavailable, peekCodeUnavailable } from "@/lib/auth/flash";
import { clearSettingsArrival, peekSettingsArrival } from "@/lib/settings/arrival";

type Arrival = "code_unavailable" | "password_changed" | "code_rotated";

// One at most, in this order (UI-screens S-22 section 4): S-04 left unconfirmed, then a password changed (S-23), then a code rotated (S-04 after E08).
function pickArrival(): Arrival | null {
  return peekCodeUnavailable() ? "code_unavailable" : peekSettingsArrival();
}

// The arrival banner of P-26: from in-memory state, never the URL, dismissible, shown once. It has no live-region role and is not announced on load:
// it follows the H1, which has focus after the route change, so it is read next.
export function ArrivalBanner() {
  const { locale, messages } = useLocale();
  const t = settingsMessages(locale).arrival;
  const [arrival, setArrival] = useState<Arrival | null>(pickArrival);

  useEffect(() => {
    // What is on screen is in state now, so the in-memory notes have done their job. The one that lost the priority is not shown later.
    clearCodeUnavailable();
    clearSettingsArrival();
  }, []);

  if (arrival === null) return null;

  function dismiss() {
    setArrival(null);
    document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }

  const dismissControl = { label: messages.form.dismiss, onDismiss: dismiss };
  return arrival === "code_unavailable" ? (
    <Banner variant="info" dismiss={dismissControl}>
      {messages.recoveryCode.unavailable}
    </Banner>
  ) : (
    <Banner variant="success" dismiss={dismissControl}>
      {arrival === "password_changed" ? t.passwordChanged : t.codeRotated}
    </Banner>
  );
}
