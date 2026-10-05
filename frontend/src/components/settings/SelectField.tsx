"use client";

import type { ComponentPropsWithoutRef } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends Omit<ComponentPropsWithoutRef<"select">, "id" | "className" | "children"> {
  label: string;
  options: readonly SelectOption[];
  // The id of the select, for the label.
  id: string;
}

// UI-tokens 6.2 and 6.5: a native select styled as a text input (six or more options use the platform picker, which brings RTL and screen-reader
// support). Visible label above, 48 px high, 16 px inline padding, the focus ring and the hover border of the text field.
export function SelectField({ label, options, id, ...select }: SelectFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-q8 block text-body-compact font-semibold text-ink">
        {label}
      </label>
      <select
        {...select}
        id={id}
        className="min-h-input w-full rounded-sm border border-edge bg-surface px-q16 text-body text-ink transition-[border-color] duration-(--q-duration-fast) hover:border-ink-secondary focus-visible:border-primary-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
