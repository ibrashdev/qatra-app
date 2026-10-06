"use client";

import { useId, useRef, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import { cx } from "@/lib/cx";
import type { AnswerPayload, RecallQuestion } from "@/lib/api/types";
import { ErrorLine } from "./ErrorLine";
import { Blank, ContextLine, originalFontClass } from "./OriginalText";
import { errorMessage, textOf } from "./question-logic";
import type { QuestionError, QuestionResult, TextKind } from "./types";

// S-18: the learner types one missing word, with no options. The client does not normalise the text: the server grades with arabic-norm-v1,
// so a typed word goes out as typed (the screen trims the outer spaces with finalizeAnswer before it sends).
export function Recall({
  question,
  answer,
  onAnswerChange,
  readOnly,
  result,
  hintRow,
  error,
  textKind,
  onSubmit,
}: {
  question: RecallQuestion;
  answer: AnswerPayload | null;
  onAnswerChange: (answer: AnswerPayload | null) => void;
  readOnly: boolean;
  result: QuestionResult | null;
  hintRow: ReactNode;
  error: QuestionError | null;
  textKind: TextKind;
  onSubmit?: () => void;
}) {
  const { locale } = useLocale();
  const messages = questionMessages(locale);
  const inputId = useId();
  const helperId = useId();
  const errorId = useId();
  const composing = useRef(false);

  const describedBy = [helperId, error !== null ? errorId : null].filter(Boolean).join(" ");
  const checked = result !== null;

  return (
    <div className="flex flex-col gap-q16">
      <ContextLine context={question.context} textKind={textKind} slot={<Blank />} />
      <div>
        <label htmlFor={inputId} className="mb-q8 block text-body-compact font-semibold text-ink">
          {messages.recallLabel}
        </label>
        <div
          className={cx(
            "flex min-h-input-recall items-center rounded-sm border bg-surface transition-[border-color] duration-(--q-duration-fast) has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus",
            error !== null && "border-error-edge shadow-[inset_0_0_0_1px_var(--q-color-error-border)]",
            error === null && !checked && "border-edge hover:border-ink-secondary has-[input:focus-visible]:border-primary-deep",
            checked && result.correct && "border-success-edge bg-success-tint shadow-[inset_0_0_0_1px_var(--q-color-success-border)]",
            checked && !result.correct && "border-warning-edge bg-warning-tint shadow-[inset_0_0_0_1px_var(--q-color-warning-border)]",
          )}
        >
          <input
            id={inputId}
            type="text"
            inputMode="text"
            dir="rtl"
            lang="ar"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={readOnly || checked}
            aria-invalid={error !== null ? true : undefined}
            aria-describedby={describedBy}
            data-answer-target=""
            value={textOf(answer)}
            onChange={(event) => onAnswerChange(event.target.value === "" ? null : { text: event.target.value })}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              // Enter checks, except while an IME composition is open (S-18).
              if (event.key !== "Enter" || composing.current || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onSubmit?.();
            }}
            className={cx("min-w-0 flex-1 self-stretch rounded-sm bg-transparent px-q16 text-token text-ink outline-none", originalFontClass(textKind))}
          />
          {checked ? (
            <span className="pe-q16">{result.correct ? <Icon name="success" size="md" active /> : <Icon name="refresh" size="md" />}</span>
          ) : null}
        </div>
        <p id={helperId} className="mt-q8 text-small text-ink-secondary">
          {messages.helpers.recall}
        </p>
        {error !== null ? (
          <div className="mt-q8">
            <ErrorLine id={errorId} message={errorMessage(question, error, messages)} />
          </div>
        ) : null}
      </div>
      {hintRow}
    </div>
  );
}
