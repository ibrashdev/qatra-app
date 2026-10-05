"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { BannerSlot, OfflineBanner, ServiceAlert, ThrottleBanner, UnavailableBanner, WakeUpBanner } from "@/components/ui/FormBanners";
import { useLocale } from "@/i18n/LocaleProvider";
import { useWakeUpState } from "@/lib/api/react";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { CommonFailure } from "./account-failure";

// P-06: a request that waits longer than this (the server holds the answer after the fifth failure) says it is still working.
const SLOW_REQUEST_MS = 5_000;

// What the last press left behind in Slot B. Connectivity speaks through its own banners, except the uncertain outcome of P-10.
export type SubmitResult =
  | { kind: "internal" }
  | { kind: "unavailable" }
  | { kind: "origin" }
  | { kind: "uncertain" }
  | { kind: "throttled"; retryAfterSec: number; endsAt: number }; // endsAt is a performance.now() value

export interface SubmitState {
  submitting: boolean;
  slow: boolean;
  result: SubmitResult | null;
  throttled: boolean;
  throttleOver: boolean;
  pressedWhileWaking: boolean;
  mounted: RefObject<boolean>;
  // Starts a press: clears the last result and marks the form busy. The function it returns ends the press; `leaving` keeps the busy state
  // while the next screen opens.
  begin: () => (leaving?: boolean) => void;
  report: (failure: CommonFailure) => void;
  markUncertain: () => void;
  clearResult: () => void;
  endThrottle: () => void;
}

// The state every account form shares: the busy flag, the slow-request line, the throttle, and what the last press left in Slot B.
export function useSubmitState(): SubmitState {
  const wake = useWakeUpState();
  const mounted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [throttleOver, setThrottleOver] = useState(false);
  // True when the last press was sent, or failed, while the server was waking: only then does «the server is ready» need announcing.
  const [pressedWhileWaking, setPressedWhileWaking] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function begin() {
    setResult(null);
    setThrottleOver(false);
    setPressedWhileWaking(wake.phase === "waking" || wake.phase === "timed_out");
    setSubmitting(true);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_REQUEST_MS);
    return (leaving = false) => {
      clearTimeout(slowTimer);
      setSlow(false);
      // On success the button keeps its loading state while the next screen opens.
      if (!leaving) setSubmitting(false);
    };
  }

  function report(failure: CommonFailure) {
    switch (failure.kind) {
      case "throttled":
        setResult({ kind: "throttled", retryAfterSec: failure.retryAfterSec, endsAt: performance.now() + failure.retryAfterSec * 1000 });
        break;
      case "unavailable":
      case "origin":
      case "internal":
        setResult({ kind: failure.kind });
        break;
      case "connectivity":
        setPressedWhileWaking(true);
        break;
      case "aborted":
        break;
    }
  }

  return {
    submitting,
    slow,
    result,
    throttled: result?.kind === "throttled",
    throttleOver,
    pressedWhileWaking,
    mounted,
    begin,
    report,
    markUncertain: () => {
      setPressedWhileWaking(true);
      setResult({ kind: "uncertain" });
    },
    clearResult: () => setResult(null),
    endThrottle: () => {
      setResult(null);
      setThrottleOver(true);
    },
  };
}

// Slot B of an account form (UI-screens "Banner slots"): the polite status area, the alert area and the screen-reader announcements.
// While the browser is offline or the server is waking, an earlier answer is stale; only the uncertain outcome belongs beside those banners.
// `uncertain` is the P-10 banner's content; `alert` is a banner of the screen's own (G-04, G-18, a failed logout).
export function ResultSlot({
  state,
  bannerId,
  submittingText,
  uncertain,
  alert,
  announcement,
}: {
  state: SubmitState;
  bannerId: string;
  submittingText: string;
  uncertain?: ReactNode;
  alert?: ReactNode;
  announcement?: ReactNode;
}) {
  const { messages } = useLocale();
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  const { result } = state;

  const offline = !online;
  const waking = !offline && (wake.phase === "waking" || wake.phase === "timed_out");
  const shown = result !== null && (result.kind === "uncertain" || !(offline || waking)) ? result : null;
  const politeBanners = [
    offline ? <OfflineBanner key="offline" /> : waking ? <WakeUpBanner key="waking" timedOut={wake.phase === "timed_out"} /> : null,
    shown?.kind === "uncertain" ? (
      <Banner key="uncertain" variant="warning">
        {uncertain}
      </Banner>
    ) : null,
    shown?.kind === "throttled" ? <ThrottleBanner key="throttled" id={bannerId} retryAfterSec={shown.retryAfterSec} /> : null,
    shown?.kind === "unavailable" ? <UnavailableBanner key="unavailable" /> : null,
  ].filter((banner) => banner !== null);
  const alertBanner =
    shown?.kind === "internal" || shown?.kind === "origin" ? <ServiceAlert kind={shown.kind} onReload={reloadPage} /> : offline || waking ? null : alert;

  return (
    <BannerSlot
      polite={
        <>
          {politeBanners.length > 0 ? <div className="flex flex-col gap-q16">{politeBanners}</div> : null}
          {state.slow ? <p className="mt-q8 text-small text-ink-secondary">{messages.form.stillProcessing}</p> : null}
        </>
      }
      alert={alertBanner}
      announcement={
        <>
          {state.submitting ? <p>{submittingText}</p> : null}
          {wake.phase === "ready" && state.pressedWhileWaking ? <p>{messages.server.ready}</p> : null}
          {reconnected && online ? <p>{messages.form.backOnline}</p> : null}
          {state.throttleOver ? <p>{messages.form.throttleOver}</p> : null}
          {announcement}
        </>
      }
    />
  );
}

// The primary button of an account form with the throttle line under it (P-06): a throttled or otherwise inert button keeps focus and does nothing.
// `inert` is a reason of the screen's own (a logout in flight).
export function SubmitRow({
  state,
  bannerId,
  label,
  loadingLabel,
  inert = false,
  type = "submit",
  onPress,
}: {
  state: SubmitState;
  bannerId: string;
  label: string;
  loadingLabel: string;
  inert?: boolean;
  type?: "submit" | "button";
  onPress?: () => void;
}) {
  const { result, throttled, submitting } = state;
  return (
    <div className="mt-q24">
      <Button
        type={type}
        fullWidth
        loading={submitting}
        aria-disabled={throttled || inert || undefined}
        aria-describedby={throttled ? bannerId : undefined}
        onClick={onPress}
      >
        {submitting ? loadingLabel : label}
      </Button>
      {result?.kind === "throttled" ? (
        <div className="mt-q8">
          <Countdown endsAt={result.endsAt} totalSeconds={result.retryAfterSec} onDone={state.endThrottle} />
        </div>
      ) : null}
    </div>
  );
}
