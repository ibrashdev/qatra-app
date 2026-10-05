"use client";

import { useId, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatPosition, questionMessages } from "@/i18n/question-messages";
import { cx } from "@/lib/cx";
import type { AnswerPayload, TokenRef, TokenView, WordOrderQuestion } from "@/lib/api/types";
import { ErrorLine } from "./ErrorLine";
import { ContextSide, originalFontClass } from "./OriginalText";
import { errorMessage, orderOf } from "./question-logic";
import type { HintEffect, QuestionError, QuestionResult, TextKind } from "./types";
import { useRoving } from "./use-roving";

const CHIP_BASE =
  "inline-flex min-h-target min-w-target items-center justify-center gap-q8 rounded-sm py-q8 text-token transition-[color,background-color,border-color] duration-(--q-duration-fast)";

// S-15: the learner puts the words of one part back in the book's order by tapping. A tap places a pool chip or removes a placed one; undo
// removes the last unlocked chip. There is no drag in this build, so the tap path is the only path (WCAG 2.5.7).
export function WordOrder({
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
  onAllPlaced,
}: {
  question: WordOrderQuestion;
  answer: AnswerPayload | null;
  onAnswerChange: (answer: AnswerPayload | null) => void;
  readOnly: boolean;
  result: QuestionResult | null;
  hint: HintEffect | null;
  hintRow: ReactNode;
  error: QuestionError | null;
  textKind: TextKind;
  announce: (text: string) => void;
  // Called when the last pool token is placed by the learner, so the screen can move focus to its action button (S-15 4, Placing).
  onAllPlaced?: () => void;
}) {
  const { locale, direction } = useLocale();
  const messages = questionMessages(locale);
  const errorId = useId();
  const helperId = useId();

  const byRef = new Map<TokenRef, TokenView>(question.tokens.map((token) => [token.ref, token]));
  const order = orderOf(answer).filter((ref) => byRef.has(ref));
  const placed = new Set(order);
  const total = question.tokens.length;
  const lockedRef = hint !== null && hint.kind === "place_first" ? hint.ref : null;
  const poolRefs = question.tokens.map((token) => token.ref);
  const unusedRefs = poolRefs.filter((ref) => !placed.has(ref));

  const answerRoving = useRoving(order);
  const poolRoving = useRoving(poolRefs, { skipped: placed });

  const inactive = readOnly || result !== null;
  const lastUnlocked = [...order].reverse().find((ref) => ref !== lockedRef);

  function wordOf(ref: TokenRef): string {
    return byRef.get(ref)?.text ?? "";
  }

  function emit(next: TokenRef[]) {
    onAnswerChange({ order: next });
  }

  function place(ref: TokenRef) {
    if (inactive || placed.has(ref)) return;
    const next = [...order, ref];
    emit(next);
    announce(messages.order.placed(wordOf(ref), formatPosition(locale, next.length)));
    // Focus goes to the next unused pool chip after this one; when none is left it stays with the answer line.
    const stillUnused = new Set(next);
    const after = poolRefs.slice(poolRefs.indexOf(ref) + 1).find((candidate) => !stillUnused.has(candidate));
    const target = after ?? poolRefs.find((candidate) => !stillUnused.has(candidate));
    if (target !== undefined) poolRoving.focusItem(target);
    else answerRoving.focusItem(ref);
    if (target === undefined) onAllPlaced?.();
  }

  function remove(ref: TokenRef) {
    if (inactive || ref === lockedRef) return;
    const index = order.indexOf(ref);
    if (index < 0) return;
    const next = order.filter((placedRef) => placedRef !== ref);
    emit(next);
    announce(messages.order.removed(wordOf(ref)));
    // The chip now in that slot, else the previous one, else the first pool chip.
    const target = next[index] ?? next[index - 1];
    if (target !== undefined) answerRoving.focusItem(target);
    else poolRoving.focusItem(poolRefs.find((candidate) => !next.includes(candidate)) ?? ref);
  }

  function undo() {
    if (inactive || lastUnlocked === undefined) return;
    const next = order.filter((ref) => ref !== lastUnlocked);
    emit(next);
    announce(messages.order.removed(wordOf(lastUnlocked)));
  }

  const firstUnused = unusedRefs[0];
  const inPlaceAt = (index: number): boolean => {
    const expected = result?.expected.order;
    // A correct verdict without an expected order means every placed chip is where the key has it.
    return expected === undefined ? result?.correct === true : expected[index] === order[index];
  };

  return (
    <div className="flex flex-col gap-q16">
      <p id={helperId} className="text-small text-ink-secondary">
        {messages.helpers.wordOrder}
      </p>
      <ContextSide tokens={question.context.before} textKind={textKind} />

      <div role="group" aria-label={messages.groups.answerLine} aria-describedby={error !== null ? errorId : undefined}>
        <ol dir="rtl" lang="ar" className="flex min-h-tile flex-wrap gap-q8 rounded-md border border-edge bg-surface p-q8">
          {order.map((ref, index) => {
            const locked = ref === lockedRef;
            const word = wordOf(ref);
            const position = formatPosition(locale, index + 1);
            const checkedView = result !== null ? (inPlaceAt(index) ? "in" : "out") : null;
            const name =
              checkedView !== null
                ? messages.order.checkedChip(word, position, formatPosition(locale, total), checkedView === "in")
                : locked
                  ? messages.order.lockedChip(word, position)
                  : messages.order.placedChip(word, position, formatPosition(locale, total));
            return (
              <li key={ref}>
                <button
                  ref={answerRoving.register(ref)}
                  type="button"
                  aria-label={name}
                  aria-disabled={inactive || locked || undefined}
                  tabIndex={answerRoving.tabStopId === ref ? 0 : -1}
                  onFocus={() => answerRoving.setActiveId(ref)}
                  onClick={() => remove(ref)}
                  onKeyDown={(event) => {
                    if (answerRoving.handleArrowKey(event, ref, "rtl")) return;
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      remove(ref);
                    }
                  }}
                  className={cx(
                    CHIP_BASE,
                    originalFontClass(textKind),
                    checkedView === "in" && "border-2 border-success-edge bg-success-tint px-[calc(var(--q-space-16)-1px)] text-ink",
                    checkedView === "out" && "border-2 border-warning-edge bg-warning-tint px-[calc(var(--q-space-16)-1px)] text-ink",
                    checkedView === null && "border-2 border-edge-selected bg-selection px-[calc(var(--q-space-16)-1px)] text-ink-accent",
                  )}
                >
                  {checkedView === "in" ? <Icon name="success" size="md" active /> : null}
                  {checkedView === "out" ? <Icon name="refresh" size="md" /> : null}
                  {checkedView === null && locked ? <Icon name="lock" size="md" /> : null}
                  {word}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <ContextSide tokens={question.context.after} textKind={textKind} />

      <div role="group" aria-label={messages.groups.pool} dir="rtl" lang="ar" className="flex flex-wrap gap-q8">
        {question.tokens.map((token) => {
          const used = placed.has(token.ref);
          return (
            <button
              key={token.ref}
              ref={poolRoving.register(token.ref)}
              type="button"
              aria-label={used ? messages.order.usedChip(token.text) : undefined}
              aria-disabled={used || inactive || undefined}
              tabIndex={poolRoving.tabStopId === token.ref ? 0 : -1}
              data-answer-target={token.ref === firstUnused ? "" : undefined}
              onFocus={() => poolRoving.setActiveId(token.ref)}
              onClick={() => place(token.ref)}
              onKeyDown={(event) => poolRoving.handleArrowKey(event, token.ref, "rtl")}
              className={cx(
                CHIP_BASE,
                originalFontClass(textKind),
                used ? "border border-transparent bg-disabled px-q16 text-ink-secondary" : "border border-edge bg-surface px-q16 text-ink hover:bg-selection",
              )}
            >
              {token.text}
            </button>
          );
        })}
      </div>

      <div className="flex items-start justify-between gap-q8">
        <div className="min-w-0 flex-1">{hintRow}</div>
        <button
          type="button"
          aria-label={messages.order.undo}
          aria-disabled={inactive || lastUnlocked === undefined || undefined}
          onClick={undo}
          lang={locale}
          dir={direction}
          className="inline-flex size-target shrink-0 items-center justify-center rounded-sm text-primary-deep hover:bg-selection aria-disabled:text-ink-secondary aria-disabled:hover:bg-transparent"
        >
          <Icon name="undo" size="md" />
        </button>
      </div>

      {error !== null ? <ErrorLine id={errorId} message={errorMessage(question, error, messages)} /> : null}
    </div>
  );
}
