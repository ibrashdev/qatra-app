"use client";

import { useId, useLayoutEffect, type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";

export interface TextAreaProps extends Omit<ComponentPropsWithoutRef<"textarea">, "id" | "className" | "aria-invalid" | "aria-describedby" | "maxLength" | "rows"> {
  label: string;
  helper?: string;
  // The counter line (for example 120/500), already written in the digits of the interface language.
  counter?: { text: string; tone: "normal" | "warning" | "error" };
  error?: string;
  // A control under the field (the restore button), shown by the caller only when it applies.
  action?: ReactNode;
  inputRef?: Ref<HTMLTextAreaElement>;
  // The id of the textarea, for an error summary that links to it.
  id: string;
}

// UI-tokens 6.2, multi-line variant (UI-screens S-08 c14 to c17): label above, the field from 96 px that grows with its text up to 168 px and then
// scrolls, then helper, counter and error. There is no maxLength: it would cut a paste silently, so the limit is shown and judged, not enforced.
export function TextArea({ label, helper, counter, error, action, inputRef, id, ...field }: TextAreaProps) {
  const helperId = useId();
  const counterId = useId();
  const errorId = useId();
  const describedBy = [helper ? helperId : null, counter ? counterId : null, error ? errorId : null].filter(Boolean).join(" ");

  // The height follows the content; the CSS minimum and maximum (the textarea tokens) clamp it.
  useLayoutEffect(() => {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLTextAreaElement)) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [field.value, id]);

  return (
    <div>
      <label htmlFor={id} className="mb-q8 block text-body-compact font-semibold text-ink">
        {label}
      </label>
      <textarea
        {...field}
        id={id}
        ref={inputRef}
        dir="auto"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cx(
          "block min-h-(--q-size-textarea-min) max-h-(--q-size-textarea-max) w-full resize-none overflow-y-auto rounded-sm border bg-surface px-q16 py-q12 text-body text-ink transition-[border-color,box-shadow] duration-(--q-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          error ? "border-error-edge shadow-[inset_0_0_0_1px_var(--q-color-error-border)]" : "border-edge hover:border-ink-secondary focus-visible:border-primary-deep",
        )}
      />
      <div className="mt-q8 flex flex-wrap items-start justify-between gap-x-q16 gap-y-q4">
        {helper ? (
          <p id={helperId} className="text-small text-ink-secondary">
            {helper}
          </p>
        ) : null}
        {counter ? (
          <p
            id={counterId}
            className={cx(
              "ms-auto flex items-center gap-q4 text-small",
              counter.tone === "normal" && "text-ink-secondary",
              counter.tone === "warning" && "text-warning-ink",
              counter.tone === "error" && "text-error-ink",
            )}
          >
            {counter.tone === "warning" ? <Icon name="warning" size="sm" /> : null}
            {counter.tone === "error" ? <Icon name="error" size="sm" /> : null}
            <bdi dir="ltr">{counter.text}</bdi>
          </p>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="mt-q8 flex items-start gap-q8 text-small text-error-ink">
          <Icon name="error" size="sm" className="mt-1" />
          {error}
        </p>
      ) : null}
      {action ? <div className="mt-q4">{action}</div> : null}
    </div>
  );
}
