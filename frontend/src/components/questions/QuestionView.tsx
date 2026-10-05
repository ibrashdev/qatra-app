"use client";

import { useImperativeHandle, useRef, type Ref } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import type { AnswerPayload, Question } from "@/lib/api/types";
import { AnswerFeedback } from "./AnswerFeedback";
import { HintControl } from "./HintControl";
import { QuestionSource } from "./QuestionSource";
import { Recall } from "./Recall";
import { SimilarDistinction } from "./SimilarDistinction";
import { WordChoice } from "./WordChoice";
import { WordOrder } from "./WordOrder";
import { optionIdOf, orderOf, placeFirst, resolveHint } from "./question-logic";
import type { HintEffect, QuestionError, QuestionResult, QuestionViewHandle, TextKind } from "./types";
import { usePoliteStatus } from "./use-polite-status";

export interface QuestionViewProps {
  question: Question;
  // The current answer, owned by the screen. Null means nothing is answered yet.
  answer: AnswerPayload | null;
  onAnswerChange: (answer: AnswerPayload | null) => void;
  // Edition format of the plan (O-39); decides the original-text font.
  textKind: TextKind;
  // Read-only: the answer cannot change (after «تحقق», or while a screen waits).
  disabled?: boolean;
  // S-19 and the games show the hint control; S-09 never does.
  hintsEnabled?: boolean;
  // The effect of the hint once used, null before. The screen stores it from onHint and passes it back, which is what makes the hint one use.
  hint?: HintEffect | null;
  onHint?: (effect: HintEffect) => void;
  // S-09 shows no per-answer feedback: with showFeedback false nothing of `result` is drawn, neither the block nor the marks on the pieces.
  showFeedback?: boolean;
  result?: QuestionResult | null;
  error?: QuestionError | null;
  // The D50 notice follows the source line (O-39); the snapshot does not say, so the screen does.
  showD50Notice?: boolean;
  // Enter in the recall input (outside an IME composition) asks the screen to check.
  onSubmit?: () => void;
  // Word order only: the learner has just placed the last pool token. The screen owns the action button and takes focus there.
  onAllPlaced?: () => void;
  ref?: Ref<QuestionViewHandle>;
}

// The piece, hint row, feedback block, source line and notice of one question (UI-screens P-18 order, without the H2 and the action bar, which the
// screen owns). D92: nothing is shown under the question before it is answered; the source line and the notice come with the feedback. Controlled: props in, callbacks out. Give it key={question.questionId} when the screen moves to the next question, so no
// focus position or announcement carries over.
export function QuestionView({
  question,
  answer,
  onAnswerChange,
  textKind,
  disabled = false,
  hintsEnabled = false,
  hint = null,
  onHint,
  showFeedback = true,
  result = null,
  error = null,
  showD50Notice = false,
  onSubmit,
  onAllPlaced,
  ref,
}: QuestionViewProps) {
  const { locale } = useLocale();
  const messages = questionMessages(locale);
  const root = useRef<HTMLDivElement>(null);
  const { announce, region } = usePoliteStatus();

  useImperativeHandle(ref, () => ({
    focusAnswer: () => root.current?.querySelector<HTMLElement>("[data-answer-target]")?.focus(),
  }));

  const shownResult = showFeedback ? result : null;
  const readOnly = disabled || shownResult !== null;

  function applyHint() {
    if (hint !== null || readOnly || onHint === undefined) return;
    const effect = resolveHint(question, answer);
    if (effect === null) return;
    onHint(effect);
    if (effect.kind === "place_first") {
      onAnswerChange({ order: placeFirst(orderOf(answer), effect.ref) });
      announce(messages.hint.firstPlaced);
    } else if (effect.kind === "remove_option") {
      // A removed option cannot stay selected.
      if (optionIdOf(answer) === effect.optionId) onAnswerChange(null);
      announce(messages.hint.optionRemoved);
    } else {
      announce(messages.hint.firstLetter(effect.letter));
    }
  }

  const hintRow = hintsEnabled ? <HintControl question={question} effect={hint} disabled={readOnly} onUse={applyHint} textKind={textKind} /> : null;
  const shared = { answer, onAnswerChange, readOnly, result: shownResult, hint, hintRow, error, textKind, announce };

  return (
    <div ref={root} className="flex flex-col gap-q16">
      {question.type === "word_order" ? (
        <WordOrder key={question.questionId} question={question} {...shared} onAllPlaced={onAllPlaced} />
      ) : question.type === "word_choice" ? (
        <WordChoice key={question.questionId} question={question} {...shared} />
      ) : question.type === "similar_distinction" ? (
        <SimilarDistinction key={question.questionId} question={question} {...shared} />
      ) : (
        <Recall key={question.questionId} question={question} {...shared} onSubmit={onSubmit} />
      )}
      {region}
      {showFeedback ? <AnswerFeedback question={question} result={shownResult} textKind={textKind} /> : null}
      {shownResult !== null ? <QuestionSource source={question.source} showD50Notice={showD50Notice} /> : null}
    </div>
  );
}
