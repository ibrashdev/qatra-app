"use client";

import { useId } from "react";
import { ProgressBar } from "@/components/today/ProgressBar";
import { minutesOf } from "@/components/today/today-model";
import { Icon } from "@/components/ui/Icon";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { todayMessages } from "@/i18n/today-messages";
import type { DailyProgress } from "@/lib/api/types";

// c4, the compact daily bar (UI-tokens 6.10, Daily variant). It shows active minutes against the goal and rises only when E21 answers with `daily`:
// the figure is the server's, never a clock on screen. At the goal it shows a check and the completion phrase and stays at 100 %; nothing closes.
export function DailyLine({ daily }: { daily: DailyProgress }) {
  const { locale } = useLocale();
  const t = todayMessages(locale).daily;
  const labelId = useId();
  const goalMinutes = minutesOf(daily.dailyGoalMs);
  const doneMinutes = Math.min(minutesOf(daily.dailyActiveMs), goalMinutes);
  const percent = Math.min(100, Math.max(0, daily.dailyPercent));
  const done = formatInteger(locale, doneMinutes);
  const goal = formatInteger(locale, goalMinutes);
  const comma = locale === "ar" ? "،" : ",";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-q12 text-small">
        <span id={labelId} className="text-ink-secondary">
          {t.barLabel}
        </span>
        <span className="text-ink">
          <bdi dir="ltr">
            {done}/{goal}
          </bdi>{" "}
          {t.unit(goalMinutes)}
          {comma} {t.percent(formatInteger(locale, percent))}
        </span>
      </div>
      <div className="mt-q8">
        <ProgressBar percent={percent} labelledBy={labelId} valueText={t.valueText(done, goal, goalMinutes, formatInteger(locale, percent))} />
      </div>
      {daily.dailyCompleted ? (
        <p className="mt-q8 inline-flex items-center gap-q8 rounded-sm bg-success-tint px-q12 py-q4 text-small text-success-ink">
          <Icon name="check" size="sm" />
          {t.reached}
        </p>
      ) : null}
    </div>
  );
}
