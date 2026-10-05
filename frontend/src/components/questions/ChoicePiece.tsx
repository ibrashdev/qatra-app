"use client";

import { useId, type ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import type { AnswerPayload, SimilarQuestion, WordChoiceQuestion } from "@/lib/api/types";
import { ErrorLine } from "./ErrorLine";
import { Blank, ContextLine } from "./OriginalText";
import { OptionTiles } from "./OptionTiles";
import { errorMessage, optionIdOf, visibleOptions } from "./question-logic";
import type { HintEffect, QuestionError, QuestionResult, TextKind } from "./types";

export interface ChoicePieceProps<Q extends WordChoiceQuestion | SimilarQuestion> {
  question: Q;
  answer: AnswerPayload | null;
  onAnswerChange: (answer: AnswerPayload | null) => void;
  readOnly: boolean;
  result: QuestionResult | null;
  hint: HintEffect | null;
  hintRow: ReactNode;
  error: QuestionError | null;
  textKind: TextKind;
  announce: (text: string) => void;
}

// S-16 and S-17 share one layout: the whole passage with the blank (D92), the option group, the error line, then the hint row.
export function ChoicePiece<Q extends WordChoiceQuestion | SimilarQuestion>({
  question,
  answer,
  onAnswerChange,
  readOnly,
  result,
  hint,
  hintRow,
  error,
  textKind,
  announce,
}: ChoicePieceProps<Q>) {
  const { locale } = useLocale();
  const messages = questionMessages(locale);
  const errorId = useId();
  const segment = question.type === "word_choice" && question.variant === "segment";

  const options = visibleOptions(question.options, hint);
  const correctId = result?.expected.optionId ?? (result?.correct === true ? optionIdOf(answer) : null);
  // The correct option fills the blank once the answer is checked (S-16).
  const filledText = result !== null ? (question.options.find((option) => option.optionId === correctId)?.text ?? null) : null;

  return (
    <div className="flex flex-col gap-q16">
      <ContextLine context={question.context} textKind={textKind} slot={<Blank part={segment} filled={filledText} />} />
      <OptionTiles
        options={options}
        selectedId={optionIdOf(answer)}
        onSelect={(optionId) => onAnswerChange({ optionId })}
        readOnly={readOnly}
        result={result}
        kind={question.type}
        stacked={segment}
        textKind={textKind}
        groupLabel={messages.groups.options}
        describedBy={error !== null ? errorId : undefined}
        invalid={error !== null}
        announce={announce}
        firstTargetAttribute
      />
      {error !== null ? <ErrorLine id={errorId} message={errorMessage(question, error, messages)} /> : null}
      {hintRow}
    </div>
  );
}
