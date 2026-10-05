"use client";

import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import type { Direction, Locale } from "@/i18n/messages";
import { questionMessages, type QuestionMessages } from "@/i18n/question-messages";
import { cx } from "@/lib/cx";
import type { Question } from "@/lib/api/types";
import { AssistedChip } from "./AssistedChip";
import { OriginalText } from "./OriginalText";
import { expectedOriginal, showsOriginal } from "./question-logic";
import type { QuestionResult, TextKind } from "./types";

// UI-tokens 6.17 and UI-screens P-21, P-22: the block after an answer. The region is always present and only its content comes and goes, so the
// polite status is announced without moving focus. Correct uses the success tokens; needs review uses the warning tokens with a gentle phrase, never
// an error tone, and shows the correct original. No percentage, score or blame appears here. The source line follows the block (QuestionSource).
export function AnswerFeedback({ question, result, textKind }: { question: Question; result: QuestionResult | null; textKind: TextKind }) {
  const { locale, direction } = useLocale();
  const messages = questionMessages(locale);

  return (
    <div role="status" aria-live="polite">
      {result === null ? null : <FeedbackBody question={question} result={result} textKind={textKind} messages={messages} locale={locale} direction={direction} />}
    </div>
  );
}

function FeedbackBody({
  question,
  result,
  textKind,
  messages,
  locale,
  direction,
}: {
  question: Question;
  result: QuestionResult;
  textKind: TextKind;
  messages: QuestionMessages;
  locale: Locale;
  direction: Direction;
}) {
  const original = showsOriginal(question, result) ? expectedOriginal(question, result) : null;
  const status = result.status ?? "counted";

  return (
    <div
      lang={locale}
      dir={direction}
      className={cx("flex flex-col gap-q12 rounded-md border p-q16 text-ink", result.correct ? "border-success-edge bg-success-tint" : "border-warning-edge bg-warning-tint")}
    >
      <p className={cx("flex items-start gap-q8 text-section", result.correct ? "text-success-ink" : "text-warning-ink")}>
        {result.correct ? <Icon name="success" size="lg" active /> : <Icon name="refresh" size="lg" />}
        <span>{result.correct ? messages.feedback.correct : messages.feedback.needsReview}</span>
      </p>
      {original !== null ? <OriginalText textKind={textKind} tint>{original}</OriginalText> : null}
      {result.assisted ? (
        <div className="flex flex-col items-start gap-q8">
          <AssistedChip />
          <p className="text-small text-ink">{messages.feedback.assistedNote}</p>
        </div>
      ) : null}
      {status === "rejected" ? <p className="text-small text-ink">{messages.feedback.rejected}</p> : null}
      {status === "pending" ? <p className="text-small text-ink">{messages.feedback.pending}</p> : null}
      {result.updated === true ? <p className="text-small text-ink">{messages.feedback.updated}</p> : null}
    </div>
  );
}
