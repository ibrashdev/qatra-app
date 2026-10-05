"use client";

import { useEffect, useId, useState, type ChangeEvent, type KeyboardEvent, type Ref } from "react";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { cx } from "@/lib/cx";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInteger } from "@/i18n/format";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import { MESSAGE_LIMIT, messageLength, sendBlock } from "./rules";

// How long the over-limit message must stand before it is announced, so typing past the limit does not read it on every key (UI-screens S-34).
const ANNOUNCE_DELAY_MS = 600;

export interface ComposerProps {
  isDemo: boolean;
  replying: boolean;
  locked: boolean; // the conversation can no longer take a message (plan not active, confirming)
  lastReply: boolean; // modelTurnsLeft is 1
  onSend: (text: string) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
}

// UI-screens S-34 c15 to c17. Learner accounts: Enter sends, Shift+Enter inserts a newline, Enter during IME composition does nothing; the text
// is trimmed, counted in code points, never cut. A blocked send leaves the text area editable, so a draft is never lost. A demo account has
// the area read-only with a note, and no counter or privacy helper (D29).
export function Composer({ isDemo, replying, locked, lastReply, onSend, textareaRef }: ComposerProps) {
  const { locale } = useLocale();
  const text = planChatMessages(locale);
  const fieldId = useId();
  const noteId = useId();
  const helperId = useId();
  const [value, setValue] = useState("");
  const [announced, setAnnounced] = useState(false);

  const length = messageLength(value);
  const over = length > MESSAGE_LIMIT;
  const block = sendBlock(value, { replying, isDemo, locked });

  useEffect(() => {
    if (!over) return;
    const timer = setTimeout(() => setAnnounced(true), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [over, value]);

  function change(event: ChangeEvent<HTMLTextAreaElement>) {
    if (isDemo) return;
    setValue(event.target.value);
    if (messageLength(event.target.value) <= MESSAGE_LIMIT) setAnnounced(false);
  }

  function submit() {
    if (block !== null) return;
    const trimmed = value.trim();
    setValue("");
    setAnnounced(false);
    onSend(trimmed);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  const describedBy = [isDemo ? noteId : null, isDemo ? null : helperId].filter(Boolean).join(" ");

  return (
    <div>
      <label htmlFor={fieldId} className="mb-q8 block text-body-compact font-semibold text-ink">
        {text.composer.label}
      </label>
      {isDemo ? (
        <div id={noteId} className="mb-q8">
          <Notice>{text.composer.demoNote}</Notice>
        </div>
      ) : null}
      <div className="flex items-end gap-q8">
        <div
          className={cx(
            "flex min-w-0 flex-1 rounded-sm border bg-surface has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-focus",
            over ? "border-error-edge shadow-[inset_0_0_0_1px_var(--q-color-error-border)]" : "border-edge hover:border-ink-secondary",
          )}
        >
          <textarea
            ref={textareaRef}
            id={fieldId}
            rows={1}
            dir="auto"
            enterKeyHint="send"
            readOnly={isDemo}
            aria-disabled={isDemo || undefined}
            aria-invalid={over || undefined}
            aria-describedby={describedBy || undefined}
            value={value}
            onChange={change}
            onKeyDown={keyDown}
            className="max-h-(--q-size-textarea-max) min-h-input min-w-0 flex-1 resize-none rounded-sm bg-transparent px-q16 py-q12 text-body text-ink outline-none field-sizing-content"
          />
        </div>
        <button
          type="button"
          aria-label={text.composer.send}
          aria-disabled={block !== null || undefined}
          onClick={submit}
          className="inline-flex size-target shrink-0 items-center justify-center rounded-sm bg-primary text-on-primary transition-[color,background-color] duration-(--q-duration-fast) hover:bg-primary-deep active:bg-primary-pressed aria-disabled:bg-disabled aria-disabled:text-ink-secondary"
        >
          {/* The send arrow points to the end edge: the back arrow already mirrors in Arabic, so this flip points it the other way in both. */}
          <span className="inline-flex -scale-x-100">
            <Icon name="back" size="lg" />
          </span>
        </button>
      </div>
      {isDemo ? null : (
        <div className="mt-q8 flex items-start justify-between gap-q12 text-small">
          {over ? (
            <p id={helperId} className="flex items-start gap-q8 text-error-ink">
              <Icon name="error" size="sm" className="mt-1" />
              {text.composer.tooLong}
            </p>
          ) : (
            <p id={helperId} className="text-ink-secondary">
              {text.composer.helper}
              {lastReply ? ` ${text.composer.lastReply}` : ""}
            </p>
          )}
          <p className={cx("shrink-0", over ? "text-error-ink" : "text-ink-secondary")}>
            <bdi dir="ltr">{text.composer.counter(formatInteger(locale, length), formatInteger(locale, MESSAGE_LIMIT))}</bdi>
          </p>
        </div>
      )}
      {over && announced ? (
        <p role="alert" className="sr-only">
          {text.composer.tooLong}
        </p>
      ) : null}
    </div>
  );
}
