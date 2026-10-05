"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import type { QuickReply } from "@/lib/api/types";

// UI-screens S-34 c12: the chips of `quickReplies`, rendered exactly as returned (never added, computed or reordered), one tab stop with a
// roving tabindex. Arrows move in the logical direction (Left is next in Arabic), Home and End jump, Enter and Space press. While a reply is
// pending the chips stay in place and in the order but press nothing (aria-disabled).
export function QuickReplies({ replies, disabled, onPick }: { replies: readonly QuickReply[]; disabled: boolean; onPick: (reply: QuickReply) => void }) {
  const { locale, direction } = useLocale();
  const text = planChatMessages(locale);
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  if (replies.length === 0) return null;

  const current = Math.min(active, replies.length - 1);
  const nextKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  const previousKey = direction === "rtl" ? "ArrowRight" : "ArrowLeft";

  function move(to: number) {
    const index = (to + replies.length) % replies.length;
    setActive(index);
    buttons.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case nextKey:
        event.preventDefault();
        move(index + 1);
        break;
      case previousKey:
        event.preventDefault();
        move(index - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(replies.length - 1);
        break;
    }
  }

  return (
    <div role="group" aria-label={text.quickGroup} className="flex flex-wrap gap-q8">
      {replies.map((reply, index) => {
        const label = locale === "ar" ? reply.labelAr : reply.labelEn;
        return (
          <button
            key={reply.code}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            data-quick-reply={reply.code}
            tabIndex={index === current ? 0 : -1}
            aria-disabled={disabled || undefined}
            onFocus={() => setActive(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => {
              if (!disabled) onPick(reply);
            }}
            className="inline-flex min-h-target items-center rounded-sm border border-edge bg-surface px-q16 text-caption text-ink transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection aria-disabled:text-ink-secondary aria-disabled:hover:bg-surface"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
