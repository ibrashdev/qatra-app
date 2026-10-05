"use client";

import { useId, type Ref } from "react";
import { QuestionView, questionPrompt, type QuestionError, type QuestionViewHandle, type TextKind } from "@/components/questions";
import { Icon } from "@/components/ui/Icon";
import { SegmentedControl, type SegmentOption } from "@/components/ui/SegmentedControl";
import { useLocale } from "@/i18n/LocaleProvider";
import { placementMessages } from "@/i18n/placement-messages";
import { questionMessages } from "@/i18n/question-messages";
import type { AnswerPayload, Question } from "@/lib/api/types";
import type { SelfRating } from "./placement-model";

// UI-tokens 6.23, question count: the 6.10 track with the fill growing from the start edge, equal to the questions passed divided by n. The text above
// the track is the visible and the spoken value; there is no percent figure and no time.
function StepsProgress({ passed, total, text }: { passed: number; total: number; text: string }) {
  const labelId = useId();
  const percent = total === 0 ? 0 : Math.min(100, Math.round((passed * 100) / total));
  return (
    <div className="flex flex-col gap-q8">
      <p id={labelId} className="text-small text-ink-secondary">
        {text}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={passed}
        aria-valuetext={text}
        aria-labelledby={labelId}
        className="h-progress w-full overflow-hidden rounded-sm bg-disabled"
      >
        <div className="h-full rounded-sm bg-primary motion-safe:transition-[width] motion-safe:duration-(--q-duration-slow)" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// c4 to c6: the intro, then the optional three-segment self-rating with its helper. No rating is a valid state (O-21).
export function RatingStep({ value, onChange }: { value: SelfRating | null; onChange: (value: SelfRating) => void }) {
  const { locale } = useLocale();
  const t = placementMessages(locale);
  const helperId = useId();
  const options: SegmentOption<SelfRating>[] = [
    { value: "none", label: t.rating.none },
    { value: "some", label: t.rating.some },
    { value: "most", label: t.rating.most },
  ];
  return (
    <div className="flex flex-col gap-q24">
      <p className="text-small text-ink-secondary">{t.intro}</p>
      <div>
        <SegmentedControl legend={t.rating.legend} options={options} value={value} onChange={onChange} describedBy={helperId} />
        <p id={helperId} className="mt-q8 text-small text-ink-secondary">
          {t.rating.helper}
        </p>
      </div>
    </div>
  );
}

export interface QuestionStepProps {
  question: Question;
  k: number;
  n: number;
  textKind: TextKind;
  answer: AnswerPayload | null;
  onAnswerChange: (answer: AnswerPayload | null) => void;
  error: QuestionError | null;
  disabled: boolean;
  onSubmit: () => void;
  questionRef: Ref<QuestionViewHandle>;
}

// c8 to c11: the count, the prompt as the step heading, then the shared piece. S-09 is a measurement: no hint, and nothing of the answer is shown after it.
export function PlacementQuestionStep({ question, k, n, textKind, answer, onAnswerChange, error, disabled, onSubmit, questionRef }: QuestionStepProps) {
  const { locale } = useLocale();
  const t = placementMessages(locale);
  const prompt = questionPrompt(question, questionMessages(locale), { placement: true });
  return (
    <div className="flex flex-col gap-q24">
      <StepsProgress passed={k - 1} total={n} text={t.progress(k, n, locale)} />
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
        hintsEnabled={false}
        showFeedback={false}
        error={error}
        onSubmit={onSubmit}
      />
    </div>
  );
}

// c15 and the calm line: no score, no percentage, no pass or fail, and nothing about which answers were wrong.
export function DoneStep({ calm }: { calm: boolean }) {
  const { locale } = useLocale();
  const t = placementMessages(locale).done;
  return (
    <div className="flex flex-col gap-q12">
      <h2 data-step-heading tabIndex={-1} className="flex items-center gap-q8 text-section text-ink">
        <span className="text-ink-accent">
          <Icon name="success" size="lg" />
        </span>
        {t.title}
      </h2>
      <p className="text-body text-ink">{t.text}</p>
      {calm ? <p className="text-small text-ink-secondary">{t.calm}</p> : null}
    </div>
  );
}
