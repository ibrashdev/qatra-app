"use client";

import { useId, type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";

export interface TextFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "id" | "className" | "aria-invalid" | "aria-describedby"> {
  label: string;
  helper?: string;
  error?: string;
  // A control that sits inside the field at the end edge (the show or hide button of a password).
  endAdornment?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  // The id of the input, for an error summary that links to it.
  id: string;
}

// UI-tokens 6.2: visible label above (never a placeholder), the field, helper text, then the error with its glyph.
// The border belongs to a box around a borderless input, so the end adornment stays at the end edge of the page
// even when dir="auto" turns the typed text the other way.
export function TextField({ label, helper, error, endAdornment, inputRef, id, ...input }: TextFieldProps) {
  const helperId = useId();
  const errorId = useId();
  const describedBy = [helper ? helperId : null, error ? errorId : null].filter(Boolean).join(" ");

  return (
    <div>
      <label htmlFor={id} className="mb-q8 block text-body-compact font-semibold text-ink">
        {label}
      </label>
      <div
        className={cx(
          "flex min-h-input items-center rounded-sm border bg-surface transition-[border-color,box-shadow] duration-(--q-duration-fast) has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus",
          error
            ? "border-error-edge shadow-[inset_0_0_0_1px_var(--q-color-error-border)]"
            : "border-edge hover:border-ink-secondary has-[input:focus-visible]:border-primary-deep",
        )}
      >
        <input
          {...input}
          id={id}
          ref={inputRef}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className="min-w-0 flex-1 self-stretch rounded-sm bg-transparent px-q16 text-body text-ink outline-none"
        />
        {endAdornment}
      </div>
      {helper ? (
        <p id={helperId} className="mt-q8 text-small text-ink-secondary">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-q8 flex items-start gap-q8 text-small text-error-ink">
          <Icon name="error" size="sm" className="mt-1" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
