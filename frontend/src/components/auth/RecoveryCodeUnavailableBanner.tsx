"use client";

import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { useLocale } from "@/i18n/LocaleProvider";
import { clearCodeUnavailable, peekCodeUnavailable } from "@/lib/auth/flash";

// The Info banner a screen after S-04 shows once when the code was never confirmed or is gone (S-04 section 4, "Leave attempt" and "Code absent").
// It comes from in-memory state, never the URL, and it has no live-region role: it follows the heading, which has focus, so it is read next.
// S-01 shows its own wording through the arrival banners of the login screen.
export function RecoveryCodeUnavailableBanner() {
  const { messages } = useLocale();
  const [shown, setShown] = useState(peekCodeUnavailable);

  useEffect(() => {
    // The banner is in state now, so the in-memory flag has done its job.
    clearCodeUnavailable();
  }, []);

  if (!shown) return null;

  function dismiss() {
    setShown(false);
    document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }

  return (
    <Banner variant="info" dismiss={{ label: messages.form.dismiss, onDismiss: dismiss }}>
      {messages.recoveryCode.unavailable}
    </Banner>
  );
}
