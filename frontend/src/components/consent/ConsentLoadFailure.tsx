"use client";

import { Button } from "@/components/ui/Button";
import { BannerSlot, OfflineBanner, ServiceAlert, UnavailableBanner, WakeUpBanner } from "@/components/ui/FormBanners";
import { useLocale } from "@/i18n/LocaleProvider";
import { useWakeUpState } from "@/lib/api/react";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { GateFailure } from "./use-consent-gate";

// E11 did not answer, so the gate cannot say who is signed in or whether a change is pending. It never shows a form it cannot stand behind:
// the generic banners of P-04, P-05 and P-07 speak, and a retry reads again (it also runs by itself once the server answers or the network is back).
export function ConsentLoadFailure({ failure, onRetry }: { failure: GateFailure; onRetry: () => void }) {
  const { messages } = useLocale();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const waking = online && (wake.phase === "waking" || wake.phase === "timed_out");

  return (
    <div className="mt-q24">
      <BannerSlot
        polite={!online ? <OfflineBanner /> : waking ? <WakeUpBanner timedOut={wake.phase === "timed_out"} /> : failure === "unavailable" ? <UnavailableBanner /> : null}
        alert={failure === "internal" && online && !waking ? <ServiceAlert kind="internal" onReload={reloadPage} /> : null}
      />
      <div className="mt-q24">
        <Button variant="secondary" fullWidth onClick={onRetry}>
          {messages.server.retry}
        </Button>
      </div>
    </div>
  );
}
