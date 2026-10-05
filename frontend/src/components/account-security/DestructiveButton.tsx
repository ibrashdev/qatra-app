"use client";

import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { Spinner } from "@/components/ui/Spinner";

// UI-tokens 6.1 Destructive recipe, reserved for account deletion: the fill is --q-color-error-text, the label --q-color-on-primary, and hover and
// pressed use --q-color-error-pressed. ui/Button.tsx has no destructive variant yet, so this is its recipe with that fill: the label stays while a
// spinner leads it, a press does nothing while it waits, and the disabled recipe is aria-disabled as well as the attribute, so the button stays focusable.
const CLASS_NAME =
  "inline-flex min-h-button min-w-22 w-full items-center justify-center gap-q8 rounded-sm px-q24 text-button transition-[color,background-color,border-color] duration-(--q-duration-fast) " +
  "disabled:border-transparent disabled:bg-disabled disabled:text-ink-secondary aria-disabled:border-transparent aria-disabled:bg-disabled aria-disabled:text-ink-secondary " +
  "bg-error-ink text-on-primary hover:bg-error-pressed active:bg-error-pressed";

export interface DestructiveButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "className"> {
  loading?: boolean;
}

export function DestructiveButton({ loading = false, type = "button", onClick, children, ...rest }: DestructiveButtonProps) {
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
    <button {...rest} type={type} aria-busy={loading || undefined} onClick={handleClick} className={CLASS_NAME}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
