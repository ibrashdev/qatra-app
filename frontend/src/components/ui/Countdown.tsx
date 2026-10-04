"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatClock } from "@/i18n/format";

const secondsLeft = (endsAt: number): number => Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));

// The visible line under a throttled button (P-06). It counts on the monotonic clock and is hidden from assistive technology,
// so a screen reader hears the banner at the start and the status at the end, never every second.
// `endsAt` is a performance.now() value; `totalSeconds` is what is left at the start.
export function Countdown({ endsAt, totalSeconds, onDone }: { endsAt: number; totalSeconds: number; onDone: () => void }) {
  const { locale } = useLocale();
  const [remaining, setRemaining] = useState(totalSeconds);
  const finish = useEffectEvent(onDone);

  useEffect(() => {
    const timer = setInterval(() => {
      const left = secondsLeft(endsAt);
      setRemaining(left);
      if (left === 0) {
        clearInterval(timer);
        finish();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [endsAt]);

  return (
    <p aria-hidden="true" className="text-center text-small text-ink-secondary">
      <bdi dir="ltr">{formatClock(locale, remaining)}</bdi>
    </p>
  );
}
