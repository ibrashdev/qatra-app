"use client";

import { useId } from "react";
import { cx } from "@/lib/cx";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { Icon } from "./Icon";
import { SkeletonBlock } from "./Skeleton";

export interface ChoiceOption {
  value: string;
  title: string;
  // The second line of a row (the author and the edition of a book). Not shown in the native select, which has one line per option.
  detail?: string;
  // The language of the catalog text, so a title in the other language is read and shaped correctly.
  lang?: string;
}

// UI-tokens 6.5: up to five options are radio rows of at least 56 px; six or more use a native select, styled as a field, for the native
// pickers and their right-to-left and screen-reader support. Loading shows skeleton rows after 300 ms (6.14).
export const MAX_RADIO_ROWS = 5;

export function ChoiceList({
  legend,
  options,
  value,
  onChange,
  loading = false,
}: {
  legend: string;
  options: readonly ChoiceOption[];
  value: string | null;
  onChange: (value: string) => void;
  loading?: boolean;
}) {
  const name = useId();
  const selectId = useId();
  const showSkeleton = useAfterDelay(300);

  if (loading) {
    return (
      <fieldset aria-busy="true" className="min-w-0">
        <legend className="mb-q8 text-body-compact font-semibold text-ink">{legend}</legend>
        {showSkeleton ? (
          <div className="flex flex-col gap-q8">
            <SkeletonBlock className="h-row" />
            <SkeletonBlock className="h-row" />
          </div>
        ) : (
          <div className="h-row" aria-hidden="true" />
        )}
      </fieldset>
    );
  }

  if (options.length > MAX_RADIO_ROWS) {
    return (
      <div>
        <label htmlFor={selectId} className="mb-q8 block text-body-compact font-semibold text-ink">
          {legend}
        </label>
        <select
          id={selectId}
          value={value ?? ""}
          onChange={(event) => {
            if (event.target.value !== "") onChange(event.target.value);
          }}
          className="min-h-input w-full rounded-sm border border-edge bg-surface px-q16 text-body text-ink hover:border-ink-secondary focus-visible:border-primary-deep"
        >
          {value === null ? <option value="" disabled /> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value} lang={option.lang}>
              {option.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <fieldset role="radiogroup" className="min-w-0">
      <legend className="mb-q8 text-body-compact font-semibold text-ink">{legend}</legend>
      <div className="flex flex-col gap-q8">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cx(
                "relative flex min-h-row cursor-pointer items-center gap-q12 rounded-sm px-q16 transition-[color,background-color,border-color] duration-(--q-duration-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                checked ? "border-2 border-edge-selected bg-selection text-ink-accent" : "border border-edge bg-surface px-[calc(var(--q-space-16)+1px)] text-ink hover:bg-selection",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="absolute -inset-0.5 m-0 size-[calc(100%+4px)] cursor-pointer opacity-0"
              />
              <span className="min-w-0 flex-1 py-q8">
                <span className="block text-body font-semibold">
                  <bdi lang={option.lang}>{option.title}</bdi>
                </span>
                {option.detail ? (
                  <span className="block text-small text-ink-secondary">
                    <bdi>{option.detail}</bdi>
                  </span>
                ) : null}
              </span>
              {checked ? <Icon name="check" size="md" active /> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
