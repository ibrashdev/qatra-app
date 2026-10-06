"use client";

import { useId, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import type { DemoMessages } from "@/i18n/demo-messages";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import type { DemoSimulation, DemoSimulationDay } from "@/lib/api/demo-endpoints";
import { correctRatePercent, simulationTitle } from "./demo-model";

type Text = DemoMessages["simulations"];

// One simulation: its title, the label that says it was computed in advance, the synthetic profile and the scripted learner it assumes, then the days.
// The days are a table from 768 px and a list of day cards below it, because six columns do not fit a 320 px screen; one of the two is hidden by
// CSS (display none), so assistive technology reads the days once. Nothing here is interactive except the focusable scroll region of the table.
export function SimulationCard({ locale, t, simulation }: { locale: Locale; t: Text; simulation: DemoSimulation }) {
  const headingId = useId();
  const profileId = useId();
  const scriptId = useId();
  const title = simulationTitle(locale, simulation);
  const fmt = (value: number) => formatInteger(locale, value);
  const dayList = (days: readonly number[]) => (days.length === 0 ? t.none : days.map(fmt).join(t.listSeparator));
  const { profile, learnerScript } = simulation;

  // overflow-wrap is inherited: at 200 % text on 320 px the card is about 160 px wide, so a long word has to break rather than push the page sideways.
  return (
    <section aria-labelledby={headingId} className="rounded-md border border-divider bg-surface p-q16 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-x-q12 gap-y-q8">
        <h2 id={headingId} className="min-w-0 text-section text-ink">
          <bdi>{title}</bdi>
        </h2>
        {/* The chip may wrap onto a second line at large text, so its height is a minimum and its width never passes the card. */}
        <span className="inline-flex min-h-badge max-w-full items-center gap-q4 rounded-sm bg-info-tint px-q12 py-q4 text-caption text-info-ink">
          <Icon name="info" size="sm" />
          <span className="min-w-0">{t.label}</span>
        </span>
      </div>

      <div className="mt-q16 grid gap-q16 tablet:grid-cols-2">
        <div>
          <h3 id={profileId} className="text-body-compact font-semibold text-ink">
            {t.profileHeading}
          </h3>
          <dl aria-labelledby={profileId} className="mt-q8 flex flex-col gap-q4 text-body-compact text-ink">
            <Row label={t.profileName}>
              <bdi dir="ltr">{profile.name === "" ? t.none : profile.name}</bdi>
            </Row>
            <Row label={t.profileWords}>{fmt(profile.totalWords)}</Row>
            <Row label={t.profileMinutes}>{fmt(profile.sessionMinutes)}</Row>
          </dl>
        </div>
        <div>
          <h3 id={scriptId} className="text-body-compact font-semibold text-ink">
            {t.scriptHeading}
          </h3>
          <dl aria-labelledby={scriptId} className="mt-q8 flex flex-col gap-q4 text-body-compact text-ink">
            <Row label={t.correctRate}>{t.percent(fmt(correctRatePercent(learnerScript.dailyCorrectRate)))}</Row>
            <Row label={t.absentDays}>{dayList(learnerScript.absentDays)}</Row>
            <Row label={t.errorDays}>{dayList(learnerScript.errorDays)}</Row>
          </dl>
          <p className="mt-q8 text-small text-ink-secondary">{t.scriptNote}</p>
        </div>
      </div>

      <DayTable locale={locale} t={t} title={title} days={simulation.days} />
      <DayCards locale={locale} t={t} title={title} days={simulation.days} />
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-q8">
      <dt className="text-ink-secondary">{`${label}:`}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const adjustmentText = (t: Text, day: DemoSimulationDay): string => t.adjustment[day.adjustment ?? "none"];

const CELL = "border-b border-divider px-q8 py-q8 text-start align-top";

function DayTable({ locale, t, title, days }: { locale: Locale; t: Text; title: string; days: readonly DemoSimulationDay[] }) {
  const fmt = (value: number) => formatInteger(locale, value);
  const caption = t.table.caption(title);
  return (
    // A table that is wider than its column (large text) scrolls inside this region, which can be reached and scrolled from the keyboard.
    <div role="region" aria-label={caption} tabIndex={0} className="mt-q16 hidden overflow-x-auto tablet:block">
      <table className="w-full border-collapse text-small text-ink">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {[t.table.day, t.table.newWords, t.table.reviews, t.table.adjustment, t.table.confirmed, t.table.overall].map((heading) => (
              <th key={heading} scope="col" className={`${CELL} font-semibold text-ink-secondary`}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row" className={`${CELL} font-semibold`}>
                {t.dayLabel(fmt(day.day))}
              </th>
              <td className={CELL}>{fmt(day.newWords)}</td>
              <td className={CELL}>{fmt(day.reviews)}</td>
              <td className={CELL}>
                {adjustmentText(t, day)}
                {day.lightReviewDay ? <span className="block text-ink-secondary">{t.lightReview}</span> : null}
              </td>
              <td className={CELL}>{fmt(day.confirmedWordsCumulative)}</td>
              <td className={CELL}>{t.percent(fmt(day.overallPercent))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayCards({ locale, t, title, days }: { locale: Locale; t: Text; title: string; days: readonly DemoSimulationDay[] }) {
  const fmt = (value: number) => formatInteger(locale, value);
  return (
    <ol aria-label={t.table.caption(title)} className="mt-q16 flex flex-col gap-q8 tablet:hidden">
      {days.map((day) => (
        <li key={day.day} className="rounded-sm border border-divider p-q12">
          <p className="text-body-compact font-semibold text-ink">{t.dayLabel(fmt(day.day))}</p>
          <dl className="mt-q4 flex flex-col gap-q4 text-small text-ink">
            <Row label={t.table.newWords}>{fmt(day.newWords)}</Row>
            <Row label={t.table.reviews}>{fmt(day.reviews)}</Row>
            <Row label={t.table.adjustment}>
              {adjustmentText(t, day)}
              {day.lightReviewDay ? <span className="block text-ink-secondary">{t.lightReview}</span> : null}
            </Row>
            <Row label={t.table.confirmed}>{fmt(day.confirmedWordsCumulative)}</Row>
            <Row label={t.table.overall}>{t.percent(fmt(day.overallPercent))}</Row>
          </dl>
        </li>
      ))}
    </ol>
  );
}
