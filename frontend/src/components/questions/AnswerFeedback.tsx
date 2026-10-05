"use client";

import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import type { Direction, Locale } from "@/i18n/messages";
import { questionMessages, type QuestionMessages } from "@/i18n/question-messages";
import { cx } from "@/lib/cx";
import type { Question } from "@/lib/api/types";
import { AssistedChip } from "./AssistedChip";
import { Blank, ContextLine, OriginalText, PassageRuns } from "./OriginalText";
import { expectedFiller, showsOriginal } from "./question-logic";
import type { QuestionResult, TextKind } from "./types";

// UI-tokens 6.17 and UI-screens P-21, P-22: the block after an answer. The region is always present and only its content comes and goes, so the
// polite status is announced without moving focus. Correct uses the success tokens; needs review uses the warning tokens with a gentle phrase, never
// an error tone, and shows the correct original: the whole passage of the question with the expected words marked in the blank (D90). No percentage,
// score or blame appears here. The source line follows the block (QuestionSource), and only an answered question has it.
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
  const filler = showsOriginal(question, result) ? expectedFiller(question, result) : null;
  const status = result.status ?? "counted";

  return (
    <div
      lang={locale}
      dir={direction}
      data-feedback={result.correct ? "correct" : "needs-review"}
      data-assisted={result.assisted ? "true" : undefined}
      className={cx("flex min-w-0 flex-col gap-q16 rounded-md border p-q16 text-ink", result.correct ? "border-success-edge bg-success-tint" : "border-warning-edge bg-warning-tint")}
    >
      {/* FC-04: 16 px separate the status from the original, the original from the assisted note and the note from the calm lines (a region is 16 px
          inside, P-18). The icon never shrinks and the phrase wraps, so enlarged text and narrow widths reflow instead of overlapping. */}
      <p data-feedback-status className={cx("flex items-start gap-q8 text-section", result.correct ? "text-success-ink" : "text-warning-ink")}>
        <span className="shrink-0">{result.correct ? <Icon name="success" size="lg" active /> : <Icon name="refresh" size="lg" />}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{result.correct ? messages.feedback.correct : messages.feedback.needsReview}</span>
      </p>
      {filler !== null ? (
        <OriginalText textKind={textKind} tint>
          <PassageRuns context={question.context} slot={<mark className="bg-selection text-ink [box-decoration-break:clone]">{filler}</mark>} />
        </OriginalText>
      ) : null}
      {/* A recall answer is judged before the server names the word: the passage with its blank stands there until `expected.word` arrives. */}
      {filler === null && !result.correct && question.type === "word_recall" ? (
        <ContextLine context={question.context} slot={<Blank />} textKind={textKind} />
      ) : null}
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
