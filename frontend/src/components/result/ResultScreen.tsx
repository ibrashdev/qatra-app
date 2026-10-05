"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { DailyIndicator } from "@/components/progress/DailyIndicator";
import { LinkButton } from "@/components/progress/LinkButton";
import { Icon } from "@/components/ui/Icon";
import { PageTitle } from "@/components/ui/PageTitle";
import { TextLink } from "@/components/ui/TextLink";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { Locale } from "@/i18n/messages";
import { renderTemplate } from "@/i18n/template";
import { resultMessages } from "@/i18n/result-messages";
import { todayMessages } from "@/i18n/today-messages";
import type { CompleteResponse } from "@/lib/api/types";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { peekSessionResult } from "@/lib/session/result-handoff";

// S-20 Session result (UI-screens Batch 4, package F10). It shows the E22 answer that S-19 held in memory and never calls E22, so a session cannot be
// completed by address. A reload or a direct visit finds nothing held and goes to S-21.
export function ResultScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const held = peekSessionResult(sessionId);

  useEffect(() => {
    if (held === null) router.replace("/progress");
  }, [held, router]);

  if (held === null) return null;
  return <ResultBody complete={held.complete} />;
}

// m:ss with the digits of the interface language; the caller keeps it in <bdi dir="ltr"> so the order never flips.
function formatActiveTime(locale: Locale, activeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(activeMs / 1000));
  const seconds = new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-arab" : "en-u-nu-latn", { useGrouping: false, minimumIntegerDigits: 2 }).format(totalSeconds % 60);
  return `${formatInteger(locale, Math.floor(totalSeconds / 60))}:${seconds}`;
}

function Row({ label, icon, children }: { label: string; icon?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-row flex-wrap items-center justify-between gap-x-q12 gap-y-q4 border-b border-divider py-q8 first:border-t">
      <dt className="flex items-center gap-q8 text-body text-ink">
        {icon ? <Icon name="info" size="md" className="text-ink-secondary" /> : null}
        {label}
      </dt>
      <dd className="text-section text-ink">{children}</dd>
    </div>
  );
}

function ResultBody({ complete }: { complete: CompleteResponse }) {
  const { locale } = useLocale();
  const t = resultMessages(locale);
  const today = todayMessages(locale);
  const { summary, daily } = complete;
  const count = (value: number) => formatInteger(locale, value);

  // The region is in the page from the first render and its text arrives a moment later, so a polite reader announces it once (S-20 section 4).
  const announce = useAfterDelay(200) && daily.dailyCompleted;

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>
      <div role="status" aria-live="polite" className="sr-only">
        {announce ? today.daily.reached : null}
      </div>

      <dl className="mt-q24">
        <Row label={t.answers.label}>{summary.answered > 0 ? t.answers.value(count(summary.correct), count(summary.answered)) : t.answers.none}</Row>
        {summary.newPassages > 0 ? <Row label={t.newPassages}>{count(summary.newPassages)}</Row> : null}
        {summary.reviewsPassed > 0 ? <Row label={t.reviewsPassed}>{count(summary.reviewsPassed)}</Row> : null}
        {summary.reviewsFailed > 0 ? (
          <Row label={t.reviewsReturning} icon>
            {count(summary.reviewsFailed)}
          </Row>
        ) : null}
        <Row label={t.activeTime.label}>{renderTemplate(t.activeTime.value, { time: <bdi dir="ltr">{formatActiveTime(locale, summary.activeMs)}</bdi> })}</Row>
      </dl>

      <div className="mt-q24">
        <DailyIndicator locale={locale} daily={daily} label="p" />
      </div>

      <div className="mt-q24 flex flex-col items-stretch gap-q12">
        <LinkButton href="/today" fullWidth>
          {t.actions.today}
        </LinkButton>
        <LinkButton href="/games" variant="secondary" fullWidth>
          {t.actions.extra}
        </LinkButton>
        <div>
          <TextLink href="/progress">{t.actions.progress}</TextLink>
        </div>
      </div>
    </div>
  );
}
