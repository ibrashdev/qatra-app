"use client";

import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { cx } from "@/lib/cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary";

// UI-tokens 6.1. The disabled recipe is set by aria-disabled as well as by the attribute: a button that waits stays focusable.
const BASE =
  "inline-flex min-h-button min-w-22 items-center justify-center gap-q8 rounded-sm px-q24 text-button transition-[color,background-color,border-color] duration-(--q-duration-fast) " +
  "disabled:border-transparent disabled:bg-disabled disabled:text-ink-secondary aria-disabled:border-transparent aria-disabled:bg-disabled aria-disabled:text-ink-secondary";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary hover:bg-primary-deep active:bg-primary-pressed",
  secondary: "border border-edge bg-surface text-primary-deep hover:border-edge-selected hover:bg-selection active:border-primary-deep active:bg-selection",
};

export interface ButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "className"> {
  variant?: ButtonVariant;
  // The label stays, a spinner leads it, and a press does nothing (the width does not change).
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({ variant = "primary", loading = false, fullWidth = false, type = "button", onClick, children, ...rest }: ButtonProps) {
  const inert = loading || rest["aria-disabled"] === true || rest["aria-disabled"] === "true";

  // preventDefault also stops the form: Enter in a field presses the default button, so a waiting form cannot be sent twice.
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (inert) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return (
    <button
      {...rest}
      type={type}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={cx(BASE, VARIANTS[variant], fullWidth && "w-full")}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
