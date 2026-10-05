"use client";

import { RecoveryCodeUnavailableBanner } from "@/components/auth/RecoveryCodeUnavailableBanner";
import { FocusShell } from "@/components/ui/FocusShell";
import { useLocale } from "@/i18n/LocaleProvider";

// Placeholder only: the start and goal screen (S-08) is built in Batch 2. The login screen sends an account without a plan here, and S-04
// continues here after registration. Until S-08 arrives it shows the note of S-04 about a code that was left unconfirmed or is gone.
export default function StartPage() {
  const { messages } = useLocale();
  return (
    <FocusShell title={messages.screens.start}>
      <div className="flex flex-col gap-q16">
        <RecoveryCodeUnavailableBanner />
        <p className="text-body text-ink-secondary">{messages.placeholder.notBuilt}</p>
      </div>
    </FocusShell>
  );
}
