"use client";

import { useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { FocusShell } from "@/components/ui/FocusShell";
import { Notice } from "@/components/ui/Notice";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { sessionMessages } from "@/i18n/session-messages";
import { todayMessages } from "@/i18n/today-messages";
import { useWakeUpState } from "@/lib/api/react";
import type { DailyProgress, SessionSnapshot } from "@/lib/api/types";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { TextKind } from "@/components/questions";
import { DailyLine } from "./DailyLine";
import { LearnStep } from "./LearnStep";
import { PauseSheet } from "./PauseSheet";
import { QuestionStep } from "./QuestionStep";
import { PlanInactiveBanner, RevokedView, SessionFailureBanner } from "./SessionBanners";
import { StageIndicator } from "./StageIndicator";
import { peekResume } from "./resume-store";
import { firstIndexFrom, passageFacts, questionPosition, stageOfStep, stagesOf, stepLineOf } from "./session-model";
import { useSessionRun } from "./use-session-run";

export interface SessionRunProps {
  snapshot: SessionSnapshot;
  daily: DailyProgress;
  textKind: TextKind;
  // True after a reload or a direct visit: the session starts again at its first step, and the step line says so.
  restarted: boolean;
}


// The open session (UI-screens S-19): focus-flow chrome, the compact daily bar, the stage indicator, the step region and the sticky action bar with its one
// button. Every answer is graded by the server; the screen shows the first verdict from the snapshot's key and takes the server's when it arrives.
export function SessionRun({ snapshot, daily, textKind, restarted }: SessionRunProps) {
  const { locale } = useLocale();
  const t = sessionMessages(locale);
  const today = todayMessages(locale);
  const { online } = useConnectivity();
  const wake = useWakeUpState();
  // The step a pause in this tab left off at (S-19 "Resumed"); a reload has lost it and starts at the first step.
  const [resumeAt] = useState(() => peekResume(snapshot.sessionId));
  const run = useSessionRun({ snapshot, initialDaily: daily, resumeAt });
  const steps = snapshot.steps;
  const facts = useMemo(() => passageFacts(steps), [steps]);
  const stages = useMemo(() => stagesOf(steps), [steps]);
  const firstIndex = useMemo(() => firstIndexFrom(steps, 0), [steps]);

  // The first step takes focus once, unless the learner has already put it somewhere (S-19 "Focus order").
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) document.querySelector<HTMLElement>("[data-step-heading]")?.focus({ preventScroll: true });
  }, []);

  const step = run.index === null ? null : (steps[run.index] ?? null);
  const stepLine = stepLineOf(steps, restarted && resumeAt === null);
  const lineText = stepLine === null ? null : stepLine === "review" ? t.line.review : stepLine === "light" ? t.line.light : t.line.restart;
  const showLine = lineText !== null && run.index !== null && run.index === firstIndex;
  const revoked = run.ended === "revoked";

  const primaryLabel =
    run.finishing
      ? t.primary.finishing
      : run.finishFailure !== null
        ? t.primary.retry
        : run.action === "start_practice"
          ? t.learn.start
          : run.action === "check"
            ? t.primary.check
            : run.action === "next"
              ? t.primary.next
              : t.primary.finish;

  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  // One banner at a time in the slot under the bar: what ended the session, then a failed finish, then a failed send, then the lost connection.
  const slot =
    run.ended === "inactive" ? (
      <PlanInactiveBanner onBack={run.goToday} />
    ) : run.finishFailure !== null ? (
      <SessionFailureBanner failure={run.finishFailure} online={online} waking={waking} onRefresh={() => window.location.reload()} />
    ) : run.sync !== null ? (
      <SessionFailureBanner failure={run.sync} online={online} waking={waking} onRetry={run.retrySync} onRefresh={() => window.location.reload()} />
    ) : !online ? (
      <Banner variant="info">{t.banners.offlineQueue}</Banner>
    ) : null;

  const actionBar =
    step === null || revoked ? undefined : (
      <div className="mx-auto w-full max-w-column">
        <Button fullWidth data-session-primary loading={run.finishing} onClick={run.press}>
          {primaryLabel}
        </Button>
      </div>
    );

  const questionStep = step?.type === "question" ? step : null;
  const questionId = questionStep?.question.questionId;
  const result = questionId === undefined ? null : (run.answered[questionId]?.result ?? null);
  const position = run.index === null ? { k: 0, n: 0 } : questionPosition(steps, run.index);
  const passageFact = questionStep === null ? undefined : facts.get(questionStep.question.passageId);

  return (
    <FocusShell
      title={t.title}
      back={{ destination: t.backDestination, onClick: run.openSheet }}
      actions={
        <button
          type="button"
          aria-label={t.pause}
          onClick={run.openSheet}
          className="inline-flex size-target shrink-0 items-center justify-center rounded-sm text-ink-secondary transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection hover:text-primary-deep"
        >
          <Icon name="pause" size="lg" />
        </button>
      }
      actionBar={actionBar}
    >
      {/* Slot T: sticks under the bar. The polite region stays in the page while empty, so a banner added later is announced. */}
      <div
        role="status"
        aria-live="polite"
        className="sticky top-[calc(var(--q-size-appbar)+env(safe-area-inset-top))] z-(--q-z-sticky) bg-page has-[*]:pb-q16"
      >
        {slot}
      </div>

      {revoked ? (
        <RevokedView onBack={run.goToday} />
      ) : step === null ? (
        <div role="status" className="flex flex-col items-start gap-q16 rounded-md border border-divider bg-surface p-q16">
          <p className="text-body text-ink">{t.empty.text}</p>
          <Button variant="secondary" onClick={run.goToday}>
            {t.empty.action}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-q24">
          <div className="flex flex-col gap-q8">
            <DailyLine daily={run.daily} />
            {stages.length > 0 ? <StageIndicator stages={stages} current={stageOfStep(step)} /> : null}
          </div>
          {showLine ? <p className="text-body-compact text-ink-secondary">{lineText}</p> : null}
          <div role="status" aria-live="polite" className="empty:hidden">
            {run.skippedNotice ? <Notice>{t.question.skipped}</Notice> : null}
          </div>
          {step.type === "learn" ? (
            <LearnStep
              passage={step.passage}
              textKind={textKind}
              hidden={run.hidden}
              onToggle={() => run.toggleText({ hidden: t.learn.hiddenAnnounce, shown: t.learn.shownAnnounce })}
            />
          ) : (
            <QuestionStep
              question={step.question}
              k={position.k}
              n={position.n}
              streak={run.streaks[step.question.passageId] ?? 0}
              gradePath={passageFact?.path === "grade"}
              showD50Notice={passageFact?.showD50Notice ?? false}
              textKind={textKind}
              answer={run.draft.answer}
              onAnswerChange={run.setAnswer}
              hint={run.draft.hint}
              onHint={run.noteHint}
              result={result}
              error={run.draft.error}
              disabled={run.finishing}
              onSubmit={() => {
                if (run.action === "check") run.press();
              }}
              onAllPlaced={() => document.querySelector<HTMLElement>("[data-session-primary]")?.focus()}
              questionRef={run.questionRef}
            />
          )}
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {run.announcement === null ? null : <p key={run.announcement.key}>{run.announcement.text}</p>}
        {run.goalNote ? <p>{today.daily.reached}</p> : null}
      </div>

      <PauseSheet sheet={run.sheet} onKeepGoing={run.closeSheet} onLeave={run.leave} onRetry={run.retrySheet} />
    </FocusShell>
  );
}
