"use client";

import { Fragment, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import type { QuestionContext, TokenView } from "@/lib/api/types";
import type { TextKind } from "./types";

// The font of the book text (UI-screens P-20): the original-text font (Scheherazade New, D92) at the token size, for a Quran edition and a hadith
// edition alike. `font-quran` and `font-hadith` stay two names so each kind keeps its own size token.
export function originalFontClass(textKind: TextKind): string {
  return textKind === "quran" ? "font-quran" : "font-hadith";
}

// UI-tokens 6.12 and P-20: right to left and Arabic in both interface languages, aligned to the start, never truncated, no letter spacing.
// `tint` is the feedback block, where the text sits on the status tint instead of the reading surface.
// FC-09 (D86): the reading surface has 24 px of padding on every side; it has no fixed or minimum height, so it grows with the text and the text size.
export function OriginalText({ textKind, tint = false, children }: { textKind: TextKind; tint?: boolean; children: ReactNode }) {
  return (
    <div dir="rtl" lang="ar" className={cx("text-start text-token text-ink [overflow-wrap:anywhere]", originalFontClass(textKind), !tint && "rounded-md bg-surface p-q24")}>
      {children}
    </div>
  );
}

// A blank slot of at least 56 by 44 px with a dashed border (P-20). Its name is UI text, so it carries the interface language.
export function Blank({ part = false, filled }: { part?: boolean; filled?: string | null }) {
  const { locale, direction } = useLocale();
  const messages = questionMessages(locale);
  if (filled !== undefined && filled !== null) {
    return (
      <span className="mx-q4 inline-block min-h-target min-w-14 rounded-xs border border-success-edge bg-success-tint px-q8 text-center align-middle">{filled}</span>
    );
  }
  return (
    <span
      role="img"
      lang={locale}
      dir={direction}
      aria-label={part ? messages.blank.part : messages.blank.word}
      className="mx-q4 inline-block min-h-target min-w-14 rounded-xs border border-dashed border-edge align-middle"
    />
  );
}

// D92: the number of an ayah end between two ayat of a Quran passage, in Arabic-Indic digits inside ornate brackets. It is decoration beside the text
// (the reference line already names the ayat), so it is hidden from assistive technology and is never part of a token.
export function AyahEndMark({ number }: { number: number }) {
  return (
    <span aria-hidden="true" data-ayah-end={number} className="text-ink-secondary">
      {"﴿"}
      {formatInteger("ar", number)}
      {"﴾"}
    </span>
  );
}

// The tokens of one side of the blank, separated by single spaces, with the ayah end after each token that closes an ayah.
function TokenRun({ tokens, ends }: { tokens: readonly TokenView[]; ends: ReadonlyMap<string, number> }) {
  return (
    <>
      {tokens.map((token, index) => {
        const end = ends.get(token.ref);
        return (
          <Fragment key={token.ref}>
            {index > 0 ? " " : null}
            {token.text}
            {end !== undefined ? (
              <>
                {" "}
                <AyahEndMark number={end} />
              </>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}

// The whole passage with `slot` where the target sits (D92): everything before it, the slot, everything after it. Context words are plain text around
// the interactive area for orientation; they are not coverage (D64). The passage text is never altered: the ayah ends come from `context.ayahEnds`.
// An end that belongs to neither side is the one that closes the blank's own ayah, so it is drawn right after the slot.
export function PassageRuns({ context, slot }: { context: QuestionContext; slot: ReactNode }) {
  const { before, after } = context;
  const ends = new Map((context.ayahEnds ?? []).map((end) => [end.afterRef, end.number] as const));
  const shown = new Set([...before, ...after].map((token) => token.ref));
  const closing = [...ends].filter(([ref]) => !shown.has(ref));
  return (
    <>
      {before.length > 0 ? (
        <>
          <TokenRun tokens={before} ends={ends} />{" "}
        </>
      ) : null}
      {slot}
      {closing.map(([ref, number]) => (
        <Fragment key={ref}>
          {" "}
          <AyahEndMark number={number} />
        </Fragment>
      ))}
      {after.length > 0 ? (
        <>
          {" "}
          <TokenRun tokens={after} ends={ends} />
        </>
      ) : null}
    </>
  );
}

export function ContextLine({ context, slot, textKind }: { context: QuestionContext; slot: ReactNode; textKind: TextKind }) {
  return (
    <OriginalText textKind={textKind}>
      <PassageRuns context={context} slot={slot} />
    </OriginalText>
  );
}
