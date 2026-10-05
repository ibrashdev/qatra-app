"use client";

import { useId } from "react";
import { ProgressBar } from "@/components/today/ProgressBar";
import { formatLearningDate } from "@/components/today/today-model";
import { Notice } from "@/components/ui/Notice";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import { progressMessages } from "@/i18n/progress-messages";
import { todayMessages } from "@/i18n/today-messages";
import type { DailyProgress, PlanProgress } from "@/lib/api/types";
import { DailyIndicator } from "./DailyIndicator";
import { MasteryBadge } from "./MasteryBadge";
import { clampPercent, groupSections, sectionKind, type GroupId, type SectionGroup } from "./progress-model";

const CARD = "rounded-md border border-divider bg-surface p-q16";

// c2 to c4: the daily indicator, its basis line and the streak line. The streak comes from E18; without it the line is left out.
export function DailyCard({ locale, daily, streakDays }: { locale: Locale; daily: DailyProgress; streakDays: number | null }) {
  const t = progressMessages(locale);
  return (
    <section aria-label={todayMessages(locale).daily.barLabel} className={CARD}>
      <DailyIndicator locale={locale} daily={daily} label="h2" />
      <p className="mt-q12 text-small text-ink-secondary">{t.basis}</p>
      {streakDays !== null ? <p className="mt-q8 text-body-compact text-ink">{streakDays > 0 ? t.streak.days(formatInteger(locale, streakDays)) : t.streak.none}</p> : null}
    </section>
  );
}

// c5, c6 and c11: the overall indicator with its counts and the notice. The percent is the server's `overallPercent`, printed as received.
export function OverallCard({ locale, plan }: { locale: Locale; plan: PlanProgress }) {
  const t = progressMessages(locale);
  const labelId = useId();
  const percent = clampPercent(plan.overallPercent);
  const formatted = formatInteger(locale, percent);
  return (
    <section aria-label={t.overall.label} className={CARD}>
      <div className="flex items-baseline justify-between gap-q12">
        <h2 id={labelId} className="text-section text-ink">
          {t.overall.label}
        </h2>
        <span className="text-display text-ink">{t.overall.percent(formatted)}</span>
      </div>
      <div className="mt-q8">
        <ProgressBar percent={percent} labelledBy={labelId} valueText={t.overall.valueText(formatted)} />
      </div>
      <p className="mt-q12 text-body-compact text-ink">{t.overall.words(formatInteger(locale, plan.confirmedWords), formatInteger(locale, plan.totalWords))}</p>
      <p className="mt-q4 text-body-compact text-ink">
        {t.overall.sections(formatInteger(locale, plan.confirmedSections), formatInteger(locale, plan.totalSections), sectionKind(plan))}
      </p>
      {plan.confirmedWords === 0 ? <p className="mt-q12 text-small text-ink-secondary">{t.overall.zero}</p> : null}
      <div className="mt-q12">
        <Notice>{t.overall.notice}</Notice>
      </div>
    </section>
  );
}

// c7: the next review date, or the empty line.
export function NextReviewLine({ locale, date }: { locale: Locale; date: string | null }) {
  const t = progressMessages(locale);
  return <p className="text-body-compact text-ink">{date !== null ? t.nextReview.date(formatLearningDate(locale, date)) : t.nextReview.none}</p>;
}

// c8 to c10: three native disclosures. The summary is the control (Enter and Space), rows are plain text and not interactive.
export function SectionGroups({ locale, plan }: { locale: Locale; plan: PlanProgress }) {
  const groups = groupSections(plan);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-q16">
      {groups.map((group) => (
        <Group key={group.id} locale={locale} group={group} />
      ))}
    </div>
  );
}

function Group({ locale, group }: { locale: Locale; group: SectionGroup }) {
  const t = progressMessages(locale);
  const label: Record<GroupId, string> = { needsRefresh: t.groups.needsRefresh, progress: t.groups.progress, confirmed: t.groups.confirmed };
  return (
    <details open={group.open} className="group rounded-md border border-divider bg-surface">
      <summary className="flex min-h-row cursor-pointer list-none items-center justify-between gap-q12 rounded-md px-q16 text-section text-ink focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden">
        <span>{t.groups.name(label[group.id], formatInteger(locale, group.rows.length))}</span>
        <span aria-hidden="true" className="size-q8 shrink-0 rotate-45 border-b-2 border-e-2 border-ink-secondary rtl:-scale-x-100 group-open:rotate-[225deg]" />
      </summary>
      <div className="border-t border-divider">
        {group.id === "needsRefresh" ? <p className="px-q16 pt-q12 text-small text-ink-secondary">{t.refreshNote}</p> : null}
        <ul>
          {group.rows.map((section) => (
            <li key={section.ordinal} className="flex min-h-row flex-wrap items-center gap-x-q12 gap-y-q4 border-b border-divider px-q16 py-q8 last:border-b-0">
              <span className="min-w-0 flex-1 text-body-compact text-ink">
                <bdi dir="auto">{locale === "en" ? section.titleEn : section.titleAr}</bdi>
              </span>
              <MasteryBadge status={section.status} label={t.badges[section.status]} />
              <span className="text-body-compact text-ink">{t.sectionPercent(formatInteger(locale, clampPercent(section.percent)))}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
