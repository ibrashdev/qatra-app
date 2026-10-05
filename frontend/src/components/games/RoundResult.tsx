"use client";

import { useId, type ReactNode } from "react";
import { DailyIndicator } from "@/components/progress/DailyIndicator";
import { SessionFailureBanner } from "@/components/session/SessionBanners";
import type { TodayFailure } from "@/components/today/today-failure";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { formatInteger } from "@/i18n/format";
import { gamesMessages } from "@/i18n/games-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { renderTemplate } from "@/i18n/template";
import { resultMessages } from "@/i18n/result-messages";
import { useWakeUpState } from "@/lib/api/react";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { RoundShell } from "./RoundShell";
import { StartFailureBanner } from "./StartFailureBanner";
import { formatActiveTime } from "./game-model";
import type { ResultState } from "./use-game-round";

// The state of «العب مرة أخرى» (P-19): the screen that owns the round holds it, because a replay replaces the round in place.
export type ReplayState = { status: "idle" } | { status: "starting" } | { status: "failed"; failure: TodayFailure };

// P-25: the result of a round, in place of the question and the action bar. Counts only: never a percentage, a score, a streak, a certificate, a share
// action or a comparison. E22 does not give the number of answers that had help, so the screen counts them from the E21 results.
export function RoundResult({
  result,
  withHelp,
  replay,
  onRetry,
  onBack,
  onPlayAgain,
  onRefresh,
}: {
  result: ResultState;
  withHelp: number;
  replay: ReplayState;
  onRetry: () => void;
  onBack: () => void;
  onPlayAgain: () => void;
  onRefresh: () => void;
}) {
  const { locale, messages } = useLocale();
  const t = gamesMessages(locale).round.result;
  const answers = resultMessages(locale);
  const { online } = useConnectivity();
  const wake = useWakeUpState();
  const replayBannerId = useId();
  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  const count = (value: number) => formatInteger(locale, value);
  const complete = result.status === "ready" ? result.complete : null;

  return (
    <RoundShell title={t.title} backLabel={messages.backTo(t.backToGames)} onBack={onBack}>
      {/* Slot B of the result screen: an E22 failure (the answers are already saved) and the failures of a replay, in a polite region that stays in the page. */}
      <div role="status" aria-live="polite" className="empty:hidden has-[*]:mb-q24">
        {result.status === "failed" ? (
          <SessionFailureBanner failure={result.failure} online={online} waking={waking} onRetry={onRetry} onRefresh={onRetry} />
        ) : replay.status === "failed" ? (
          <StartFailureBanner failure={replay.failure} id={replayBannerId} online={online} waking={waking} onRefresh={onRefresh} />
        ) : null}
      </div>

      {complete === null ? (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            {t.loading}
          </p>
          <div aria-hidden="true" className="flex flex-col gap-q16">
            <SkeletonBlock className="h-q48 w-full" />
            <SkeletonBlock className="h-q48 w-full" />
            <SkeletonBlock className="h-q48 w-full" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-q24">
          <ul>
            <Row>
              <span className="text-body text-ink">{answers.answers.label}</span>
              <span className="text-section text-ink">
                {complete.summary.answered > 0 ? answers.answers.value(count(complete.summary.correct), count(complete.summary.answered)) : answers.answers.none}
              </span>
            </Row>
            {withHelp > 0 ? (
              <Row>
                <span className="text-body text-ink">{t.withHelp(count(withHelp))}</span>
              </Row>
            ) : null}
            <Row>
              <span className="text-body text-ink">{answers.activeTime.label}</span>
              <span className="text-section text-ink">
                {renderTemplate(answers.activeTime.value, { time: <bdi dir="ltr">{formatActiveTime(locale, complete.summary.activeMs)}</bdi> })}
              </span>
            </Row>
          </ul>

          <DailyIndicator locale={locale} daily={complete.daily} label="p" />

          {complete.summary.answered > complete.summary.correct ? (
            <p className="flex items-start gap-q8 text-small text-ink-secondary">
              <Icon name="info" size="sm" className="mt-1" />
              <span>{t.needsReview}</span>
            </p>
          ) : null}

          <div className="flex flex-col items-stretch gap-q12">
            <Button fullWidth loading={replay.status === "starting"} onClick={onPlayAgain}>
              {t.playAgain}
            </Button>
            <Button fullWidth variant="secondary" onClick={onBack}>
              {t.games}
            </Button>
          </div>
        </div>
      )}
    </RoundShell>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <li className="flex min-h-row flex-wrap items-center justify-between gap-x-q12 gap-y-q4 border-b border-divider py-q8 first:border-t">{children}</li>;
}
