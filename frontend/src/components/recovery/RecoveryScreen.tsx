"use client";

import { useState } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import { PublicShell } from "@/components/ui/PublicShell";
import { useLocale } from "@/i18n/LocaleProvider";
import { recoveryMessages } from "@/i18n/recovery-messages";
import { useSignedInRedirect } from "@/lib/auth/use-signed-in-redirect";
import { RecoveryResetStep } from "./RecoveryResetStep";
import { RecoveryVerifyStep } from "./RecoveryVerifyStep";
import type { ResetGrant, RestartNotice } from "./recovery-model";

// The two steps change in place and add no history entry, so the browser's back button leaves the flow (S-05 section 2). The grant of E06 and
// the username live in this state only: a reload, or leaving the screen, discards them (O-10). Step 3 is S-04, reached by replace navigation.
function RecoveryFlow() {
  const { messages } = useLocale();
  useSignedInRedirect();

  const [username, setUsername] = useState("");
  const [grant, setGrant] = useState<ResetGrant | null>(null);
  // Set when step 2 sends the visitor back to step 1; step 1 shows the generic refusal and moves focus to its heading.
  const [restart, setRestart] = useState<RestartNotice | null>(null);

  return (
    <div className="mx-auto w-full max-w-form">
      <PageTitle screenName={messages.screens.recovery} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.screens.recovery}
      </h1>
      {grant === null ? (
        <RecoveryVerifyStep
          username={username}
          restart={restart}
          onVerified={(verifiedUsername, verifiedGrant) => {
            setUsername(verifiedUsername);
            setRestart(null);
            setGrant(verifiedGrant);
          }}
        />
      ) : (
        <RecoveryResetStep
          username={username}
          grant={grant}
          onRestart={(notice) => {
            setGrant(null);
            setRestart(notice);
          }}
        />
      )}
    </div>
  );
}

// S-05 in the public shell: the back control names S-07 (the public catalog) and goes to /login until S-07 ships in Batch 2; there is no logo
// (the page carries its own heading) and the wake-up line is shown above each button instead of at the top.
export function RecoveryScreen() {
  const { locale } = useLocale();
  return (
    <PublicShell back={{ destination: recoveryMessages(locale).backDestination, href: "/login" }} logo={false} wakeUp={false}>
      <RecoveryFlow />
    </PublicShell>
  );
}
