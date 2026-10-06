"use client";

import { useEffect, useRef } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { formatClock, formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import type { LocalRunSummary } from "./offline-model";

// The end of a run on the device: a local, provisional summary (offline-spec 4.4). It makes no claim of a completed day, no streak and no mastery: the E22
// summary and the result screen of S-20 exist only after the answers have been replayed and verified by the server (D40, D59).
export function OfflineResult({ summary, onBack }: { summary: LocalRunSummary; onBack: () => void }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const heading = useRef<HTMLHeadingElement>(null);

  // The result takes focus once, like the title of the result screen online.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section className="flex flex-col gap-q16">
      <h2 ref={heading} tabIndex={-1} className="text-section text-ink">
        {t.result.title}
      </h2>
      <ul className="flex flex-col gap-q8 rounded-md border border-divider bg-surface p-q16 text-body text-ink">
        <li>{t.result.answered(formatInteger(locale, summary.answered))}</li>
        <li>{t.result.correct(formatInteger(locale, summary.correct))}</li>
        <li>
          {t.result.activeTime("")}
          <bdi dir="ltr">{formatClock(locale, Math.floor(summary.activeMs / 1000))}</bdi>
        </li>
      </ul>
      <Banner variant="info">
        <p>{t.shell.offlinePending}</p>
        <p className="mt-q8">{t.result.note}</p>
      </Banner>
      <div>
        <Button onClick={onBack}>{t.result.back}</Button>
      </div>
    </section>
  );
}
