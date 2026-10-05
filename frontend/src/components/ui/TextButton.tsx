"use client";

import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { cx } from "@/lib/cx";

// UI-tokens 6.1 tertiary button: no fill, deep-blue label, the selection fill on hover. At least 44 px high and 88 px wide, so it is always
// a comfortable target; the disabled recipe is aria-disabled, so a button that has nothing to do stays focusable (it keeps focus after a press).
export const TEXT_BUTTON_CLASS =
  "inline-flex min-h-target min-w-22 items-center justify-center gap-q8 rounded-sm px-q12 text-button text-primary-deep transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection active:bg-selection aria-disabled:text-ink-secondary aria-disabled:hover:bg-transparent";

export type TextButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className" | "type">;

export function TextButton({ onClick, children, ...rest }: TextButtonProps) {
  const inert = rest["aria-disabled"] === true || rest["aria-disabled"] === "true";

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (inert) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return (
    <button {...rest} type="button" onClick={handleClick} className={cx(TEXT_BUTTON_CLASS)}>
      {children}
    </button>
  );
}
