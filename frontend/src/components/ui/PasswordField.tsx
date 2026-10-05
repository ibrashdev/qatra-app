"use client";

import { useState } from "react";
import { Icon } from "./Icon";
import { TextField, type TextFieldProps } from "./TextField";

export interface PasswordFieldProps extends Omit<TextFieldProps, "type" | "endAdornment" | "dir"> {
  showLabel: string; // the accessible name while the password is hidden
  hideLabel: string; // and while it is shown
}

// P-08: text input with the show or hide button inside the field at the end edge (44 by 44; the glyph and the name both show the action).
// The name changes with the state and there is no aria-pressed: a toggle uses one of the two (O-07, decided 4 October 2026).
// dir="auto"; no maxlength, because it counts UTF-16 units and would truncate silently; paste and password managers are never blocked.
export function PasswordField({ showLabel, hideLabel, ...field }: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      {...field}
      dir="auto"
      type={shown ? "text" : "password"}
      endAdornment={
        <button
          type="button"
          aria-label={shown ? hideLabel : showLabel}
          onClick={() => setShown((current) => !current)}
          className="me-q4 flex size-target shrink-0 items-center justify-center rounded-sm text-ink-secondary transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection hover:text-primary-deep focus-visible:outline-offset-[-2px]"
        >
          <Icon name={shown ? "eye-off" : "eye"} size="lg" />
        </button>
      }
    />
  );
}
