"use client";

import { SkeletonLines } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { ConsentForm } from "./ConsentForm";
import { ConsentLoadFailure } from "./ConsentLoadFailure";
import { ConsentShell } from "./ConsentShell";
import { useConsentGate } from "./use-consent-gate";

function ConsentGate() {
  const { messages } = useLocale();
  const { state, reload } = useConsentGate();

  return (
    <>
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.screens.consent}
      </h1>
      {state.status === "ready" ? (
        <ConsentForm username={state.username} />
      ) : state.status === "error" ? (
        <ConsentLoadFailure failure={state.failure} onRetry={reload} />
      ) : (
        // Loading, or a redirect on its way: the account name is not known yet, so the form is not drawn.
        <div aria-busy="true" className="mt-q24">
          <p role="status" className="sr-only">
            {messages.server.busy}
          </p>
          <SkeletonLines lines={3} />
        </div>
      )}
    </>
  );
}

// S-06: the re-consent gate, a focus screen (no language switch, no tab bar, no back control). It asks the session who is signed in (E11) before it
// shows anything, because a visit with no session or no pending change belongs elsewhere.
export function ConsentScreen() {
  return (
    <ConsentShell>
      <ConsentGate />
    </ConsentShell>
  );
}
