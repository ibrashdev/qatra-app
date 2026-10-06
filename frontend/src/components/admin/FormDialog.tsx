"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { Button } from "@/components/ui/Button";

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const FIELDS = "input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

export interface FormDialogProps {
  title: string;
  // The sentence under the title; it is the accessible description.
  description?: ReactNode;
  // A confirmation that asks before something is lost is an alert dialog (UI-tokens 6.9).
  role?: "dialog" | "alertdialog";
  // The fields. They sit inside the form of the dialog, so Enter in a text field sends it.
  children: ReactNode;
  // The failure of the last press, between the fields and the buttons.
  banner?: ReactNode;
  confirm: { label: string; busy: boolean };
  cancel: { label: string };
  // The safe choice goes first: Cancel is the primary button and takes the initial focus, and Enter in a choice never sends the form.
  // Without it the dialog is an ordinary edit form: Save is primary and the first field takes the focus.
  safeCancel?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

// The dialog of an edit form or of an irreversible action that needs a reason. The kit Dialog (UI-tokens 6.9 and 6.22) holds a sentence and two
// buttons; this one holds fields as well, and is otherwise built the same way: a native <dialog> opened with showModal(), so the page behind it is
// inert; a sheet docked to the bottom edge below 768 px and a centred dialog of at most 400 px from it; focus stays inside; Escape cancels; focus
// goes back to the element that held it; and the page does not scroll while it is open. A press on the backdrop does not cancel, so a typed value is
// never lost by a stray press. It exists only while it is mounted: the caller mounts it to open it and unmounts it to close it. While a press is in
// flight nothing cancels it, so the answer always finds the dialog.
export function FormDialog({ title, description, role = "dialog", children, banner, confirm, cancel, safeCancel = false, onSubmit, onCancel }: FormDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const { busy } = confirm;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    alive.current = true;
    const active = document.activeElement;
    const returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
    dialog.showModal();
    const first = safeCancel ? dialog.querySelector<HTMLElement>("[data-dialog-primary]") : (dialog.querySelector<HTMLElement>(FIELDS) ?? dialog.querySelector<HTMLElement>("[data-dialog-primary]"));
    first?.focus();
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      // The caller has taken the dialog away: the page is released first, then the focus goes back.
      alive.current = false;
      if (dialog.open) dialog.close();
      root.style.overflow = previousOverflow;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [safeCancel]);

  // Escape: the browser asks to cancel; the caller decides, so the dialog stays until it is unmounted.
  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    if (!busy) onCancel();
  }

  // A browser that closes the dialog on its own (a second Escape it does not let us cancel) must not leave the caller believing it is open.
  function handleClose(event: SyntheticEvent<HTMLDialogElement>) {
    if (alive.current && !event.currentTarget.open && !busy) onCancel();
  }

  // The browser keeps focus out of the page behind; this keeps it going round inside the dialog on every browser.
  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Enter in a radio, a checkbox or a select must not send an irreversible form: only its button does. A text field keeps its Enter.
  function handleFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (!safeCancel || event.key !== "Enter") return;
    const { target } = event;
    const isChoice = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio"));
    if (isChoice) event.preventDefault();
  }

  const cancelButton = (
    <Button
      variant={safeCancel ? "primary" : "secondary"}
      fullWidth
      data-dialog-primary={safeCancel ? "" : undefined}
      aria-disabled={busy ? true : undefined}
      onClick={onCancel}
    >
      {cancel.label}
    </Button>
  );
  const confirmButton = (
    <Button type="submit" variant={safeCancel ? "secondary" : "primary"} fullWidth data-dialog-primary={safeCancel ? undefined : ""} loading={busy}>
      {confirm.label}
    </Button>
  );

  return (
    <dialog
      ref={dialogRef}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={handleCancel}
      onClose={handleClose}
      onKeyDown={handleKeyDown}
      className="m-0 mt-auto max-h-[calc(100dvh-3rem)] w-full max-w-full overflow-y-auto rounded-md rounded-b-none border-0 bg-surface p-0 text-ink shadow-raised backdrop:bg-scrim tablet:m-auto tablet:max-w-[25rem] tablet:rounded-b-md motion-safe:max-tablet:open:transition-[translate] motion-safe:max-tablet:open:duration-(--q-duration-slow) motion-safe:max-tablet:open:ease-standard motion-safe:max-tablet:open:starting:translate-y-full"
    >
      <form
        noValidate
        method="post"
        onKeyDown={handleFormKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        <div className="px-q24 pt-q24">
          <h2 id={titleId} className="text-section text-ink">
            {title}
          </h2>
          {description === undefined ? null : (
            <div id={descriptionId} className="mt-q12 text-body text-ink">
              {description}
            </div>
          )}
          <div className="mt-q16 flex flex-col gap-q16">{children}</div>
          {banner}
        </div>
        {/* The buttons stay at the bottom of the dialog, so when the text is enlarged until the dialog scrolls, the fields are reached first and the
            focused button is still in view. */}
        <div className="sticky bottom-0 bg-surface px-q24 pt-q24 pb-[calc(var(--q-space-24)+env(safe-area-inset-bottom))] tablet:pb-q24">
          <div className="flex flex-col gap-q8 tablet:flex-row tablet:flex-wrap">
            {safeCancel ? (
              <>
                <div className="tablet:flex-auto">{cancelButton}</div>
                <div className="tablet:flex-auto">{confirmButton}</div>
              </>
            ) : (
              <>
                <div className="tablet:flex-auto">{confirmButton}</div>
                <div className="tablet:flex-auto">{cancelButton}</div>
              </>
            )}
          </div>
        </div>
      </form>
    </dialog>
  );
}
