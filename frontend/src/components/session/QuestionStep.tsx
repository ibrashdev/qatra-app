"use client";

import type { Ref } from "react";
import { QuestionView, questionPrompt, type HintEffect, type QuestionError, type QuestionResult, type QuestionViewHandle, type TextKind } from "@/components/questions";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import { sessionMessages } from "@/i18n/session-messages";
import type { AnswerPayload, Question } from "@/lib/api/types";

// D41: the initial streak a passage needs before its reviews begin. The count itself comes from the server's answers.
export const STREAK_GOAL = 3;

export interface QuestionStepProps {
  question: Question;
  k: number;
  n: number;
  // Consecutive correct answers of the passage as the server last reported them; shown for training questions only.
  streak: number;
  gradePath: boolean;
  showD50Notice: boolean;
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

// A question step of S-19 (c15 to c21): the counter or streak line, the prompt as the step heading, then the shared piece with its hint control, feedback
// and source line. The piece is keyed by the question, so no focus position or announcement carries over from the one before.
export function QuestionStep({
  question,
  k,
  n,
  streak,
  gradePath,
  showD50Notice,
  textKind,
  answer,
  onAnswerChange,
  hint,
  onHint,
  result,
  error,
  disabled,
  onSubmit,
  onAllPlaced,
  questionRef,
}: QuestionStepProps) {
  const { locale } = useLocale();
  const t = sessionMessages(locale).question;
  const prompt = questionPrompt(question, questionMessages(locale), { gradePath });
  const counter = question.role === "training" ? `${t.counter(k, n, locale)} · ${t.streak(streak, STREAK_GOAL, locale)}` : t.counter(k, n, locale);

  return (
    <div className="flex flex-col gap-q16">
      <p className="text-small text-ink-secondary">{counter}</p>
      <h2 data-step-heading tabIndex={-1} className="text-section text-ink">
        {prompt}
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
        showD50Notice={showD50Notice}
        onSubmit={onSubmit}
        onAllPlaced={onAllPlaced}
      />
    </div>
  );
}
