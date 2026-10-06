"use client";

import { LearningCue } from "@/components/learning-cue";
import type { Ref } from "react";
import { QuestionView, questionPrompt, type HintEffect, type QuestionError, type QuestionResult, type QuestionViewHandle, type TextKind } from "@/components/questions";
import type { RunBackend } from "@/components/session/run-backend";
import { SessionFailureBanner } from "@/components/session/SessionBanners";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { gamesMessages } from "@/i18n/games-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import { sessionMessages } from "@/i18n/session-messages";
import { useWakeUpState } from "@/lib/api/react";
import type { AnswerPayload, Question } from "@/lib/api/types";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { GameRound } from "./game-model";
import { LeaveSheet } from "./LeaveSheet";
import { RoundResult, type ReplayState } from "./RoundResult";
import { RoundShell } from "./RoundShell";
import { useGameRound } from "./use-game-round";

// A round in progress (UI-screens S-15 to S-18, P-18): the H1 of the game, the counter and prompt as the H2, the shared question piece with its hint row,
// feedback and source line, the explanatory learning cue, and the sticky action bar with its one button («تحقق», «التالي», «إنهاء الجولة»). The answers
// are graded by the server; the first verdict comes from the answer key of the snapshot and the server's entry replaces it. At the end the screen turns
// into the result (P-25) in place.
export function RoundRun({
  round,
  questions,
  replay,
  onPlayAgain,
  onRefreshPlan,
  backend,
}: {
  round: GameRound;
  questions: readonly Question[];
  replay: ReplayState;
  onPlayAgain: () => void;
  onRefreshPlan: () => void;
  // The offline shell passes its backend (durable outbox, local finish); online there is none and the round behaves as before.
  backend?: RunBackend;
}) {
  const { locale } = useLocale();
  const t = gamesMessages(locale);
  const copy = t.games[round.gameType];
  const session = sessionMessages(locale);
  const { online } = useConnectivity();
  const wake = useWakeUpState();
  const run = useGameRound({ round, questions, backend });
  const waking = wake.phase === "waking" || wake.phase === "timed_out";

  if (run.phase === "result") {
    const withHelp = Object.values(run.answered).filter((entry) => entry.result.assisted && (entry.result.status ?? "counted") === "counted").length;
    return (
      <RoundResult
        result={run.result ?? { status: "loading" }}
        withHelp={withHelp}
        replay={replay}
        onRetry={run.retryResult}
        onBack={run.goGames}
        onPlayAgain={onPlayAgain}
        onRefresh={onRefreshPlan}
      />
    );
  }

  const { question } = run;
  const revoked = run.ended === "revoked";
  const result = question === undefined ? null : (run.answered[question.questionId]?.result ?? null);

  // One banner at a time in the slot under the bar (P-22): what ended the round, then a failed send, then the lost connection.
  const slot =
    run.ended === "inactive" ? (
      <Banner variant="warning">{t.round.banners.planInactive}</Banner>
    ) : run.ended === "closed" ? (
      <Banner variant="warning">{t.round.banners.sessionClosed}</Banner>
    ) : revoked ? (
      <Banner variant="warning">{t.unavailable.text}</Banner>
    ) : run.sync !== null ? (
      <SessionFailureBanner failure={run.sync} online={online} waking={waking} onRetry={run.retrySync} onRefresh={reloadPage} />
    ) : backend !== undefined ? (
      // Offline round: the answers are on the device and are verified at the next sync, so the line is the fixed one, not «سنعيد المحاولة».
      backend.banner === null ? null : (
        <Banner variant={backend.banner.variant}>{backend.banner.text}</Banner>
      )
    ) : !online ? (
      <Banner variant="info">
        <p>{session.banners.offlineQueue}</p>
        <p className="mt-q4">{session.banners.keepOpen}</p>
      </Banner>
    ) : null;

  const primaryLabel = run.action === "check" ? t.round.primary.check : run.action === "next" ? t.round.primary.next : t.round.primary.finish;
  const actionBar =
    run.ended !== null ? (
      <Button fullWidth onClick={run.goGames}>
        {t.round.banners.backToGames}
      </Button>
    ) : (
      <Button fullWidth data-round-primary onClick={run.press}>
        {primaryLabel}
      </Button>
    );

  return (
    <RoundShell title={copy.name} backLabel={t.round.leave} onBack={run.openSheet} actionBar={actionBar}>
      {/* Slot T: sticks under the bar. The polite region stays in the page while empty, so a banner added later is announced. */}
      <div
        role="status"
        aria-live="polite"
        className="sticky top-[calc(var(--q-size-appbar)+env(safe-area-inset-top))] z-(--q-z-sticky) bg-page has-[*]:pb-q16"
      >
        {slot}
      </div>

      {question === undefined || revoked ? null : (
        <div className="flex flex-col gap-q24">
          <div className="flex flex-col gap-q16">
            <RoundQuestion
              question={question}
              k={run.position.k}
              n={run.position.n}
              textKind={round.textKind}
              answer={run.draft.answer}
              onAnswerChange={run.setAnswer}
              hint={run.draft.hint}
              onHint={run.noteHint}
              result={result}
              error={run.draft.error}
              disabled={run.ended !== null}
              onSubmit={() => {
                if (run.action === "check") run.press();
              }}
              onAllPlaced={() => document.querySelector<HTMLElement>("[data-round-primary]")?.focus()}
              questionRef={run.questionRef}
            />          </div>
          <LearningCue />
        </div>
      )}

      <LeaveSheet sheet={run.sheet} onKeepPlaying={run.closeSheet} onLeave={run.leave} onRetry={run.retrySheet} onLeaveUnsaved={run.leaveUnsaved} />
    </RoundShell>
  );
}

interface RoundQuestionProps {
  question: Question;
  k: number;
  n: number;
  textKind: TextKind;
  answer: AnswerPayload | null;
  onAnswerChange: (answer: AnswerPayload | null) => void;
  hint: HintEffect | null;
  onHint: (effect: HintEffect) => void;
  result: QuestionResult | null;
  error: QuestionError | null;
  disabled: boolean;
  onSubmit: () => void;
  onAllPlaced: () => void;
  questionRef: Ref<QuestionViewHandle>;
}

// The H2 (counter and prompt, UI-screens P-18) and the shared piece with its hint row, feedback and source line. The piece is keyed by the question, so no
// focus position or announcement carries over from the one before.
function RoundQuestion({ question, k, n, textKind, answer, onAnswerChange, hint, onHint, result, error, disabled, onSubmit, onAllPlaced, questionRef }: RoundQuestionProps) {
  const { locale } = useLocale();
  const t = gamesMessages(locale);
  return (
    <>
      <h2 data-step-heading tabIndex={-1} className="text-section text-ink">
        <span className="block text-small font-normal text-ink-secondary">{t.round.counter(k, n, locale)}</span>
        <span className="sr-only">. </span>
        {questionPrompt(question, questionMessages(locale))}
      </h2>
      <QuestionView
        key={question.questionId}
        ref={questionRef}
        question={question}
        answer={answer}
        onAnswerChange={onAnswerChange}
        textKind={textKind}
        disabled={disabled}
        hintsEnabled
        hint={hint}
        onHint={onHint}
        showFeedback
        result={result}
        error={error}
        onSubmit={onSubmit}
        onAllPlaced={onAllPlaced}
      />
    </>
  );
}