"use client";

import { Icon } from "@/components/ui/Icon";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { sessionMessages } from "@/i18n/session-messages";
import { cx } from "@/lib/cx";
import type { Stage } from "./session-model";

// c5, the stage indicator (UI-tokens 6.23): a non-interactive ordered list of the stages the snapshot holds, each a 24 px marker with its name beneath,
// joined by 2 px connectors. The current one carries aria-current="step"; a finished one says so in words for assistive technology. Never focusable.
export function StageIndicator({ stages, current }: { stages: readonly Stage[]; current: Stage }) {
  const { locale } = useLocale();
  const t = sessionMessages(locale).stages;
  const names: Record<Stage, string> = { review: t.review, new: t.fresh, test: t.test };
  const currentAt = stages.indexOf(current);

  return (
    <ol aria-label={t.label} className="flex">
      {stages.map((stage, position) => {
        const state = position < currentAt ? "done" : position === currentAt ? "current" : "upcoming";
        const last = position === stages.length - 1;
        return (
          <li
            key={stage}
            aria-current={state === "current" ? "step" : undefined}
            className={cx(
              "relative flex flex-1 flex-col items-center gap-q4",
              !last &&
                "after:absolute after:top-[calc(var(--q-size-step-marker)/2-1px)] after:start-[calc(50%+var(--q-size-step-marker)/2)] after:h-0.5 after:w-[calc(100%-var(--q-size-step-marker))]",
              !last && (state === "done" ? "after:bg-primary" : "after:bg-divider"),
            )}
          >
            <span
              aria-hidden="true"
              className={cx(
                "flex size-step-marker items-center justify-center rounded-full text-caption",
                state === "done" && "bg-primary text-on-primary",
                state === "current" && "border-2 border-edge-selected bg-selection text-ink-accent",
                state === "upcoming" && "border border-edge bg-surface text-ink-secondary",
              )}
            >
              {state === "done" ? <Icon name="check" size="sm" active /> : formatInteger(locale, position + 1)}
            </span>
            <span className={cx("text-caption", state === "current" ? "font-semibold text-primary-deep" : state === "upcoming" ? "text-ink-secondary" : "text-ink")}>
              {names[stage]}
              {state === "done" ? <span className="sr-only"> ({t.done})</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
