"use client";

import { useId } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  // The language of the label when it differs from the page (WCAG 3.1.2): a language switch names each language in its own.
  lang?: string;
}

// UI-tokens 6.4: native radios in a labelled radiogroup, equal-width segments at least 44 px high and 88 px wide (136 px for the two segments
// of a level-2 choice). The visible legend is the accessible name; arrow keys come from the platform, so they follow the reading direction.
// The selected segment shows a check as well as the fill and the heavier border, so the choice is never colour alone (6.0).
export function SegmentedControl<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  segmentWidth = "compact",
  describedBy,
}: {
  legend: string;
  options: readonly SegmentOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  segmentWidth?: "compact" | "wide";
  describedBy?: string;
}) {
  const name = useId();
  return (
    <fieldset role="radiogroup" aria-describedby={describedBy} className="min-w-0">
      <legend className="mb-q8 text-body-compact font-semibold text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-q8">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              lang={option.lang}
              className={cx(
                "relative inline-flex min-h-target flex-1 cursor-pointer items-center justify-center gap-q4 rounded-sm px-q12 text-body-compact font-semibold transition-[color,background-color,border-color] duration-(--q-duration-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                segmentWidth === "wide" ? "min-w-34" : "min-w-22",
                checked ? "border-2 border-edge-selected bg-selection text-ink-accent" : "border border-edge bg-surface px-[calc(var(--q-space-12)+1px)] py-px text-ink hover:bg-selection",
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(option.value)}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="absolute -inset-0.5 m-0 size-[calc(100%+4px)] cursor-pointer opacity-0"
              />
              {checked ? <Icon name="check" size="sm" active /> : null}
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
