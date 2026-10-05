"use client";

import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages, type QuestionMessages } from "@/i18n/question-messages";
import { cx } from "@/lib/cx";
import type { ChoiceOption } from "@/lib/api/types";
import { originalFontClass } from "./OriginalText";
import type { QuestionResult, TextKind } from "./types";
import { useRoving } from "./use-roving";

type TileTone = "default" | "selected" | "success" | "warning";

interface TileView {
  tone: TileTone;
  phrase: string | null;
  glyph: "check" | "success" | "warning" | "refresh" | null;
  name: string | null;
  // The learner's own pick keeps its 2 px selected border after checking (S-17).
  keepSelectedBorder: boolean;
}

// UI-tokens 6.16 and UI-screens S-16, S-17: the state of a tile before and after «تحقق». Correctness is never colour alone: a phrase and a glyph come with it.
function viewOf(option: ChoiceOption, selectedId: string | null, result: QuestionResult | null, kind: "word_choice" | "similar_distinction", messages: QuestionMessages): TileView {
  const chosen = option.optionId === selectedId;
  if (result === null) {
    return { tone: chosen ? "selected" : "default", phrase: null, glyph: chosen ? "check" : null, name: null, keepSelectedBorder: false };
  }
  const correctId = result.expected.optionId ?? (result.correct ? selectedId : null);
  if (option.optionId === correctId) {
    return { tone: "success", phrase: messages.tile.correct, glyph: "success", name: messages.tile.correctName(option.text), keepSelectedBorder: false };
  }
  if (kind === "similar_distinction") {
    // D31: the wrong option is labelled a memorization error in words and glyph. Its text lives only inside this tile.
    return { tone: "warning", phrase: messages.tile.mistake, glyph: "warning", name: messages.tile.mistakeName(option.text), keepSelectedBorder: chosen };
  }
  if (chosen) {
    return { tone: "warning", phrase: messages.tile.chosenNeedsReview, glyph: "refresh", name: messages.tile.chosenNeedsReviewName(option.text), keepSelectedBorder: false };
  }
  return { tone: "default", phrase: null, glyph: null, name: null, keepSelectedBorder: false };
}

const TONE_CLASS: Record<TileTone, string> = {
  default: "border border-edge bg-surface px-[calc(var(--q-space-16)+1px)] text-ink hover:bg-selection",
  selected: "border-2 border-edge-selected bg-selection px-q16 text-ink-accent",
  success: "border-2 border-success-edge bg-success-tint px-q16 text-ink",
  warning: "border-2 border-warning-edge bg-warning-tint px-q16 text-ink",
};

// Radio tiles of the word choice and the similar distinction (UI-tokens 6.16). One tab stop per group; arrows only move focus, Space or Enter selects.
// Single words sit in two columns when each tile is at least 128 px wide, otherwise in one; segments are always stacked.
export function OptionTiles({
  options,
  selectedId,
  onSelect,
  readOnly,
  result,
  kind,
  stacked,
  textKind,
  groupLabel,
  describedBy,
  invalid,
  announce,
  firstTargetAttribute,
}: {
  options: readonly ChoiceOption[];
  selectedId: string | null;
  onSelect: (optionId: string) => void;
  readOnly: boolean;
  result: QuestionResult | null;
  kind: "word_choice" | "similar_distinction";
  stacked: boolean;
  textKind: TextKind;
  groupLabel: string;
  describedBy?: string;
  invalid: boolean;
  announce: (text: string) => void;
  // The first tile is where focus goes when the answer is missing.
  firstTargetAttribute: boolean;
}) {
  const { locale, direction } = useLocale();
  const messages = questionMessages(locale);
  const ids = options.map((option) => option.optionId);
  const roving = useRoving(ids, { preferredId: selectedId });

  function select(option: ChoiceOption) {
    if (readOnly) return;
    onSelect(option.optionId);
    // The wrong option of a similar distinction is never repeated outside its own tile (S-17), so only the word choice announces the pick.
    if (kind === "word_choice") announce(messages.tile.selected(option.text));
  }

  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      aria-readonly={readOnly || undefined}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="grid gap-q8"
      style={{
        gridTemplateColumns: stacked ? "1fr" : "repeat(auto-fit, minmax(max(8rem, calc((100% - var(--q-space-8)) / 2)), 1fr))",
      }}
    >
      {options.map((option, index) => {
        const view = viewOf(option, selectedId, result, kind, messages);
        const checked = option.optionId === selectedId;
        return (
          <button
            key={option.optionId}
            ref={roving.register(option.optionId)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={readOnly || undefined}
            aria-label={view.name ?? undefined}
            tabIndex={roving.tabStopId === option.optionId ? 0 : -1}
            data-answer-target={firstTargetAttribute && index === 0 ? "" : undefined}
            dir="rtl"
            lang="ar"
            onFocus={() => roving.setActiveId(option.optionId)}
            onClick={() => select(option)}
            onKeyDown={(event) => roving.handleArrowKey(event, option.optionId, "rtl", { vertical: true })}
            className={cx(
              "flex min-h-tile w-full items-center gap-q12 rounded-sm py-q8 text-start transition-[color,background-color,border-color] duration-(--q-duration-fast)",
              TONE_CLASS[view.tone],
              view.keepSelectedBorder && "border-edge-selected!",
            )}
          >
            {view.glyph === "refresh" ? <Icon name="refresh" size="md" /> : view.glyph !== null ? <Icon name={view.glyph} size="md" active /> : null}
            <span className="min-w-0 flex-1">
              <span className={cx("block text-token [overflow-wrap:anywhere]", originalFontClass(textKind))}>{option.text}</span>
              {view.phrase !== null ? (
                <span lang={locale} dir={direction} className="block text-caption">
                  {view.phrase}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
