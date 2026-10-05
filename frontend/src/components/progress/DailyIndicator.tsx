"use client";

import { useId } from "react";
import { ProgressBar } from "@/components/today/ProgressBar";
import { minutesOf } from "@/components/today/today-model";
import { Icon } from "@/components/ui/Icon";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import { todayMessages } from "@/i18n/today-messages";
import type { DailyProgress } from "@/lib/api/types";

// UI-tokens 6.10 daily: label at the start edge, value at the end edge, the track below, then the completion and the extra-time lines.
// `daily` is authoritative and capped at 100 %; extra time is separate and never a second completion (D40). Shared by S-20 and S-21.
// `emphasis` (FC-14, S-21 only) sets the percent in the display size, as the overall card does; the words and the order stay the same.
export function DailyIndicator({ locale, daily, label, emphasis = false }: { locale: Locale; daily: DailyProgress; label: "h2" | "p"; emphasis?: boolean }) {
  const t = todayMessages(locale).daily;
  const labelId = useId();
  const Label = label;
  const goalMinutes = minutesOf(daily.dailyGoalMs);
  const doneMinutes = Math.min(minutesOf(daily.dailyActiveMs), goalMinutes);
  const extraMinutes = minutesOf(daily.extraActiveMs);
  const percent = Math.min(100, Math.max(0, daily.dailyPercent));
  const done = formatInteger(locale, doneMinutes);
  const goal = formatInteger(locale, goalMinutes);
  const comma = locale === "ar" ? "،" : ",";
  return (
    <div>
      <div className={emphasis ? "flex flex-wrap items-baseline justify-between gap-x-q12 gap-y-q4" : "flex items-baseline justify-between gap-q12"}>
        <Label id={labelId} className="text-section text-ink">
          {t.barLabel}
        </Label>
        <span className="text-body-compact text-ink">
          <bdi dir="ltr">
            {done}/{goal}
          </bdi>{" "}
          {t.unit(goalMinutes)}
          {comma}{" "}
          {emphasis ? <span className="text-display">{t.percent(formatInteger(locale, percent))}</span> : t.percent(formatInteger(locale, percent))}
        </span>
      </div>
      <div className="mt-q8">
        <ProgressBar percent={percent} labelledBy={labelId} valueText={t.valueText(done, goal, goalMinutes, formatInteger(locale, percent))} />
      </div>
      {daily.dailyCompleted ? (
        <p className="mt-q8 inline-flex items-center gap-q8 rounded-sm bg-success-tint px-q12 py-q4 text-body-compact text-success-ink">
          <Icon name="check" size="md" />
          {t.reached}
        </p>
      ) : null}
      {extraMinutes > 0 ? <p className="mt-q8 text-small text-ink-secondary">{t.extra(formatInteger(locale, extraMinutes), extraMinutes)}</p> : null}
    </div>
  );
}
