"use client";

import { useId, type ComponentPropsWithoutRef, type Ref } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";

export interface CheckboxProps extends Omit<ComponentPropsWithoutRef<"input">, "id" | "type" | "className" | "children" | "aria-invalid" | "aria-describedby"> {
  // The visible label, which is also the accessible name: the whole row is the target.
  label: string;
  // A helper line under the row, part of the checkbox's description; the error message comes after it (UI-screens P-03).
  description?: string;
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
  // The id of the input, for an error summary that links to it.
  id: string;
}

// UI-tokens 6.3: a 24 px box with a 2 px border in a row of at least 44 px, the label part of the target, a white check on the primary fill
// when checked, and the ring around the whole row. The input is the real, native checkbox, laid over the box and made transparent, so the
// keyboard, the checked state and the name all come from the platform.
export function Checkbox({ label, description, error, inputRef, id, ...input }: CheckboxProps) {
  const descriptionId = useId();
  const errorId = useId();
  const describedBy = [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div>
      <label className="group flex min-h-target cursor-pointer items-center gap-q12 rounded-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus">
        <span
          className={cx(
            "relative flex size-checkbox shrink-0 items-center justify-center rounded-xs border-2 bg-surface transition-[color,background-color,border-color] duration-(--q-duration-fast) group-has-[:checked]:border-primary group-has-[:checked]:bg-primary",
            error ? "border-error-edge" : "border-edge group-hover:bg-selection",
          )}
        >
          <input
            {...input}
            id={id}
            ref={inputRef}
            type="checkbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy || undefined}
            className="absolute inset-0 m-0 size-full cursor-pointer opacity-0"
          />
          {/* The faded check forms a stacking layer above the input that comes first, so it must let the press through to the input. */}
          <Icon name="check" size="sm" className="pointer-events-none text-on-primary opacity-0 group-has-[:checked]:opacity-100" />
        </span>
        <span className="text-body text-ink">{label}</span>
      </label>
      {/* Indented past the box so the line sits under the label text it explains. */}
      {description ? (
        <p id={descriptionId} className="ps-[calc(var(--q-size-checkbox)+var(--q-space-12))] text-small text-ink-secondary">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-q4 flex items-start gap-q8 text-small text-error-ink">
          <Icon name="error" size="sm" className="mt-1" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
