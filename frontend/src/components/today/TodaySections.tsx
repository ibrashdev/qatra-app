"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { TextLink } from "@/components/ui/TextLink";
import { dailyAmountText } from "@/i18n/daily-amount";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import type { TodayMessages } from "@/i18n/today-messages";
import { renderTemplate } from "@/i18n/template";
import type { Plan, Today } from "@/lib/api/types";
import { cx } from "@/lib/cx";
import { formatLearningDate, minutesOf, type CurrentStage } from "./today-model";
import { ProgressBar } from "./ProgressBar";

interface Common {
  locale: Locale;
  t: TodayMessages;
}

// UI-screens P-13: a `section` with an `h2` per pair. Label in the section size, text in the compact body size, 12 px between.
// FC-10 (D86): the regions sit 16 px apart.
function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-q16">
      <h2 id={id} className="text-section text-ink">
        {label}
      </h2>
      <div className="mt-q12 text-body-compact text-ink">{children}</div>
    </section>
  );
}

// Arabic titles and references keep their own direction inside an English line, and the other way round.
const Isolated = ({ children }: { children: ReactNode }) => <bdi dir="auto">{children}</bdi>;

export function GoalSection({ locale, t, plan }: Common & { plan: Plan }) {
  const title = locale === "ar" ? plan.titleAr : plan.titleEn;
  // No date: the title alone.
  const line =
    plan.preferredDate === null ? <Isolated>{title}</Isolated> : renderTemplate(t.goal.withDate, { title: <Isolated>{title}</Isolated>, date: formatLearningDate(locale, plan.preferredDate) });
  return (
    <Section label={t.goal.label}>
      <p>{line}</p>
    </Section>
  );
}

export function DailySection({ locale, t, today, plan, goalReached }: Common & { today: Today; plan: Plan; goalReached: boolean }) {
  const barLabelId = useId();
  const goalMinutes = minutesOf(today.dailyGoalMs);
  const doneMinutes = Math.min(minutesOf(today.dailyActiveMs), goalMinutes);
  const extraMinutes = minutesOf(today.extraActiveMs);
  const percent = Math.min(100, Math.max(0, today.dailyPercent));
  const done = formatInteger(locale, doneMinutes);
  const goal = formatInteger(locale, goalMinutes);
  const percentText = t.daily.percent(formatInteger(locale, percent));
  const comma = locale === "ar" ? "،" : ",";
  return (
    <Section label={t.daily.label}>
      <p>{t.daily.text(formatInteger(locale, plan.sessionMinutes), plan.sessionMinutes, dailyAmountText(locale, plan.agreedEstimate))}</p>
      <div className="mt-q12">
        {/* FC-10: the label above, the day's value on its own line in the section weight, so it reads before the plan's goal and stages; no whole-plan figure here (S-11 never shows it) */}
        <p id={barLabelId} className="text-small text-ink-secondary">
          {t.daily.barLabel}
        </p>
        <p data-testid="daily-value" className="mt-q4 text-section text-ink">
          <bdi dir="ltr">
            {done}/{goal}
          </bdi>{" "}
          {t.daily.unit(goalMinutes)}
          {comma} {percentText}
        </p>
        <div className="mt-q8">
          <ProgressBar percent={percent} labelledBy={barLabelId} valueText={t.daily.valueText(done, goal, goalMinutes, formatInteger(locale, percent))} />
        </div>
        {goalReached ? (
          <p className="mt-q8 inline-flex items-center gap-q8 rounded-sm bg-success-tint px-q12 py-q4 text-success-ink">
            <Icon name="check" size="md" />
            {t.daily.reached}
          </p>
        ) : null}
        {extraMinutes > 0 ? <p className="mt-q8 text-small text-ink-secondary">{t.daily.extra(formatInteger(locale, extraMinutes), extraMinutes)}</p> : null}
      </div>
      <div className="mt-q8">
        <TextLink href="/plan/revise">{t.daily.change}</TextLink>
      </div>
    </Section>
  );
}

export function StageSection({ locale, t, stage }: Common & { stage: CurrentStage }) {
  const titleId = useId();
  const title = locale === "en" && stage.titleEn !== null ? stage.titleEn : stage.titleAr;
  const percent = stage.percent;
  return (
    <Section label={t.stages.label}>
      <div className="rounded-md border border-divider bg-surface p-q16">
        <div className="flex items-baseline justify-between gap-q12">
          <p id={titleId} className="min-w-0 flex-1">
            <Isolated>{title}</Isolated>
          </p>
          {percent !== null ? <span>{t.stages.percent(formatInteger(locale, percent))}</span> : null}
        </div>
        <p className="text-small text-ink-secondary">{t.stages.current}</p>
        {percent !== null ? (
          <div className="mt-q8">
            <ProgressBar percent={percent} labelledBy={titleId} valueText={t.stages.percentText(formatInteger(locale, percent))} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

export function ReviewsSection({ locale, t, dueReviews, nextReviewDate }: Common & { dueReviews: number; nextReviewDate: string | null }) {
  return (
    <Section label={t.reviews.label}>
      <p>{dueReviews > 0 ? t.reviews.due(formatInteger(locale, dueReviews)) : t.reviews.none}</p>
      {nextReviewDate !== null ? <p className="mt-q4 text-small text-ink-secondary">{t.reviews.next(formatLearningDate(locale, nextReviewDate))}</p> : null}
    </Section>
  );
}

// The last section holds the primary action. On phones the button is sticky above the tab bar (`--q-size-tabbar` plus the safe area plus 8 px) and
// in flow from 1024 px. The section is `display: contents` below that width, so the button sticks to the whole page and not only to this section.
export function NextStepSection({ t, line, children }: { t: TodayMessages; line: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="contents rail:mt-q16 rail:block">
      <h2 id={id} className="mt-q16 text-section text-ink rail:mt-0">
        {t.next.label}
      </h2>
      <p className="mt-q12 text-body-compact text-ink">{line}</p>
      <StickyAction>{children}</StickyAction>
    </section>
  );
}

export function StickyAction({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="session-action"
      className="sticky bottom-[calc(var(--q-size-tabbar)+env(safe-area-inset-bottom,0px)+var(--q-space-8))] z-(--q-z-sticky) mt-q12 bg-page py-q8 rail:static rail:py-0"
    >
      {children}
    </div>
  );
}

export function nextPassageLine(t: TodayMessages, today: Today): ReactNode {
  const passage = today.nextNewPassage;
  if (passage === null) return t.next.nearHorizon;
  return renderTemplate(t.next.passage, { section: <Isolated>{passage.sectionTitleAr}</Isolated>, reference: <bdi dir="ltr">{passage.reference}</bdi> });
}

// c8 (UI-tokens 6.14): a 32 px line icon, the title, one button, no illustration.
export function EmptyPlan({ t, hasPausedPlan }: { t: TodayMessages; hasPausedPlan: boolean }) {
  return (
    <section aria-label={t.empty.title} className="mt-q24 flex flex-col items-start gap-q12">
      <Icon name="droplet" size="xl" className="text-ink-secondary" />
      <h2 className="text-section text-ink">{t.empty.title}</h2>
      <Link
        href="/start"
        className={cx(
          "inline-flex min-h-button min-w-22 items-center justify-center rounded-sm bg-primary px-q24 text-button text-on-primary transition-[color,background-color] duration-(--q-duration-fast)",
          "hover:bg-primary-deep active:bg-primary-pressed",
        )}
      >
        {t.empty.action}
      </Link>
      {hasPausedPlan ? <TextLink href="/plan">{t.empty.previousPlans}</TextLink> : null}
    </section>
  );
}
