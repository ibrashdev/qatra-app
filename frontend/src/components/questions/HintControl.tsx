"use client";

import { useId } from "react";
import { TextButton } from "@/components/ui/TextButton";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import { cx } from "@/lib/cx";
import type { Question } from "@/lib/api/types";
import { AssistedChip } from "./AssistedChip";
import { originalFontClass } from "./OriginalText";
import { Icon } from "@/components/ui/Icon";
import type { HintEffect, TextKind } from "./types";

// UI-tokens 6.16: a tertiary button with a lightbulb, one use per question. After the use it is disabled (aria-disabled, still focusable) and the
// marker «بمساعدة» stays. The screen owns the state: `effect` is null until the hint is used, and then it carries what the hint revealed.
// This component only shows the result of the hint; applying it to the answer (a locked token, a removed option) belongs to the piece.
export function HintControl({
  question,
  effect,
  disabled = false,
  onUse,
  textKind,
}: {
  question: Question;
  effect: HintEffect | null;
  disabled?: boolean;
  onUse: () => void;
  textKind: TextKind;
}) {
  const { locale, direction } = useLocale();
  const messages = questionMessages(locale);
  const notesId = useId();
  const used = effect !== null;
  const inert = used || disabled;

  // The helper before the press (UG-09) and the review-round note (O-35) are one description of the button.
  const notes: string[] = [];
  if (question.type === "similar_distinction") notes.push(messages.hint.similarHelper);
  if (question.role === "review") notes.push(messages.hint.reviewHelper);

  return (
    <div className="flex flex-col gap-q8">
      <div className="flex flex-wrap items-center gap-q8">
        <TextButton aria-disabled={inert ? true : undefined} aria-describedby={notes.length > 0 ? notesId : undefined} onClick={onUse}>
          <Icon name="hint" size="md" />
          {messages.hint.label}
        </TextButton>
        {used ? <AssistedChip /> : null}
      </div>
      {effect !== null && effect.kind === "first_letter" ? (
        <p className="text-small text-ink-secondary">
          {messages.hint.firstLetterLabel}{" "}
          <bdi lang="ar" dir="rtl" className={cx("text-token text-ink", originalFontClass(textKind))}>
            {effect.letter}
          </bdi>
        </p>
      ) : null}
      {notes.length > 0 ? (
        <p id={notesId} lang={locale} dir={direction} className="text-small text-ink-secondary">
          {notes.join(" ")}
        </p>
      ) : null}
    </div>
  );
}
