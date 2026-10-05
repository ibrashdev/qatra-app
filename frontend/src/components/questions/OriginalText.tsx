"use client";

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import type { TokenView } from "@/lib/api/types";
import { joinTokens } from "./question-logic";
import type { TextKind } from "./types";

// The font of the book text (UI-screens P-20): Amiri Quran for a Quran edition, Amiri for a hadith edition, at the token size.
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

// Context words are plain text around the interactive area for orientation; they are not coverage (D64).
export function ContextLine({
  before,
  after,
  slot,
  textKind,
}: {
  before: readonly TokenView[];
  after: readonly TokenView[];
  slot: ReactNode;
  textKind: TextKind;
}) {
  return (
    <OriginalText textKind={textKind}>
      {before.length > 0 ? <>{joinTokens(before)} </> : null}
      {slot}
      {after.length > 0 ? <> {joinTokens(after)}</> : null}
    </OriginalText>
  );
}

// Plain context on one side of a word-order answer line.
export function ContextSide({ tokens, textKind }: { tokens: readonly TokenView[]; textKind: TextKind }) {
  if (tokens.length === 0) return null;
  return <OriginalText textKind={textKind}>{joinTokens(tokens)}</OriginalText>;
}
