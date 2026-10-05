"use client";

import { useId, type ReactNode } from "react";
import { MasteryBadge } from "@/components/progress/MasteryBadge";
import { addDays, formatLearningDate, upcomingReviewDate } from "@/components/today/today-model";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import type { PlanOverviewMessages } from "@/i18n/plan-overview-messages";
import { progressMessages } from "@/i18n/progress-messages";
import { renderTemplate } from "@/i18n/template";
import type { TodayMessages } from "@/i18n/today-messages";
import type { CatalogEdition, Plan, ProgressResponse, Today } from "@/lib/api/types";
import { cx } from "@/lib/cx";
import { goalLines, nextStep, stageLabel, stageRows, type StageRow } from "./plan-overview-model";

// UI-screens P-13: a `section` with an `h2` per pair. Label in the section size, text in the compact body size, 12 px between.
export function PlanSection({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-q24">
      <h2 id={id} className="text-section text-ink">
        {label}
      </h2>
      <div className="mt-q12 flex flex-col gap-q4 text-body-compact text-ink">{children}</div>
    </section>
  );
}

// Arabic titles and references keep their own direction inside an English line, and the other way round.
const Isolated = ({ lang, children }: { lang?: string; children: ReactNode }) => (
  <bdi lang={lang} dir="auto">
    {children}
  </bdi>
);

function StageName({ locale, row }: { locale: Locale; row: StageRow }) {
  const label = stageLabel(locale, row);
  return <Isolated lang={label.lang}>{label.text}</Isolated>;
}

interface Props {
  locale: Locale;
  t: PlanOverviewMessages;
  today: TodayMessages;
  plan: Plan;
  edition: CatalogEdition | null;
  data: Today;
  progress: ProgressResponse;
}

// The six labelled sections in full, in the fixed order of UI-design 1.1 (owner-requested): goal, total time, daily time, stages, reviews, next step.
export function PlanSections({ locale, t, today, plan, edition, data, progress }: Props) {
  const lines = goalLines(locale, t, plan, edition);
  const estimate = plan.agreedEstimate;
  const rows = stageRows(plan, progress, data);
  const nextReview = upcomingReviewDate(progress, plan.planId, data.learningDate);
  const next = nextStep(data, progress, plan.planId);
  const words = estimate.newWordsPerDay;
  const pending = typeof plan.pendingSessionMinutes === "number";

  return (
    <>
      <PlanSection label={t.sections.goal}>
        <p>
          <Isolated>{lines.head}</Isolated>
        </p>
        <p className="text-ink-secondary">{lines.detail}</p>
      </PlanSection>

      <PlanSection label={t.sections.totalTime}>
        <p>{t.totalTime(estimate.days, formatInteger(locale, estimate.days), formatLearningDate(locale, estimate.endDate))}</p>
      </PlanSection>

      <PlanSection label={t.sections.dailyTime}>
        <p>{`${today.daily.text(formatInteger(locale, plan.sessionMinutes), plan.sessionMinutes, formatInteger(locale, words), words)}.`}</p>
        {pending ? <p className="text-small text-ink-secondary">{today.banners.pending(formatLearningDate(locale, addDays(data.learningDate, 1)))}</p> : null}
      </PlanSection>

      <PlanSection label={t.sections.stages}>
        <StageList locale={locale} t={t} rows={rows} />
      </PlanSection>

      <PlanSection label={t.sections.reviews}>
        <p>{t.reviews.rhythm}</p>
        <p>{data.dueReviews > 0 ? today.reviews.due(formatInteger(locale, data.dueReviews)) : today.reviews.none}</p>
        {nextReview !== null ? <p className="text-small text-ink-secondary">{today.reviews.next(formatLearningDate(locale, nextReview))}</p> : null}
      </PlanSection>

      <PlanSection label={t.sections.nextStep}>
        <p>
          {next.kind === "passage"
            ? renderTemplate(t.next.passage, { section: <Isolated lang="ar">{next.section}</Isolated>, reference: <bdi dir="ltr">{next.reference}</bdi> })
            : next.kind === "review"
              ? t.next.review(formatLearningDate(locale, next.date))
              : t.next.none}
        </p>
      </PlanSection>
    </>
  );
}

// The stages are a native disclosure (UI-tokens 6.25): open when there are five or fewer, and the summary row names the current stage and the
// count. The list is ordered, and the current row carries aria-current="step". A row's badge is icon plus text.
function StageList({ locale, t, rows }: { locale: Locale; t: PlanOverviewMessages; rows: StageRow[] }) {
  const badges = progressMessages(locale).badges;
  const current = rows.find((row) => row.current);
  const count = formatInteger(locale, rows.length);
  return (
    <details open={rows.length <= 5} className="rounded-md border border-divider bg-surface">
      <summary className="flex min-h-row cursor-pointer flex-wrap items-center justify-between gap-x-q12 gap-y-q4 rounded-md px-q16 py-q8">
        <span className="font-semibold">{t.stages.summary(count)}</span>
        {current !== undefined ? (
          <span className="text-small text-ink-secondary">
            {renderTemplate(t.stages.currentIn, { title: <StageName locale={locale} row={current} /> })}
          </span>
        ) : null}
      </summary>
      {rows.length === 0 ? null : (
        <ol className="flex flex-col border-t border-divider">
          {rows.map((row) => (
            <li
              key={row.ordinal}
              aria-current={row.current ? "step" : undefined}
              className={cx("flex min-h-row flex-wrap items-center justify-between gap-x-q12 gap-y-q8 px-q16 py-q8 not-last:border-b not-last:border-divider", row.current && "bg-selection")}
            >
              <span className="min-w-0 flex-1">
                <StageName locale={locale} row={row} />
                {row.current ? <span className="block text-small text-ink-accent">{t.stages.current}</span> : null}
              </span>
              <span className="flex items-center gap-q12">
                <MasteryBadge status={row.status} label={badges[row.status]} />
                <span className="min-w-q48 text-end">{t.stages.percent(formatInteger(locale, row.percent))}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
