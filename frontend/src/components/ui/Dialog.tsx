"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { Button } from "./Button";

export interface DialogAction {
  label: string;
  onPress: () => void;
}

export interface DialogProps {
  open: boolean;
  title: string;
  // The sentence under the title; it is the accessible description.
  children: ReactNode;
  // A confirmation that asks before something is lost is an alert dialog (UI-tokens 6.9).
  role?: "dialog" | "alertdialog";
  // The safe action: it takes the initial focus, and Escape and a press on the backdrop do what onCancel does.
  primary: DialogAction;
  secondary: DialogAction;
  // The caller closes the dialog by setting `open` to false.
  onCancel: () => void;
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

// UI-tokens 6.9 and 6.22: a native <dialog> opened with showModal(), so the page behind it is inert. Below 768 px it is a sheet docked to the
// bottom edge that slides up; from 768 px it is a centred dialog of at most 400 px. The buttons stack with the primary first on a phone and
// form a row from 768 px, the primary at the start edge. Focus starts on the primary button and stays inside, Escape and the backdrop cancel,
// focus goes back to the element that held it, and the page does not scroll while the dialog is open.
export function Dialog({ open, title, children, role = "dialog", primary, secondary, onCancel }: DialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Whether the caller still wants the dialog open, for the native close event.
  const wanted = useRef(open);

  useEffect(() => {
    wanted.current = open;
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const active = document.activeElement;
    const returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-dialog-primary]")?.focus();
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      // Runs when `open` turns false and when the dialog goes away: the page is released first, then the focus goes back.
      if (dialog.open) dialog.close();
      root.style.overflow = previousOverflow;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [open]);

  // Escape: the browser asks to cancel; the caller decides, so the dialog stays until `open` turns false.
  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    onCancel();
  }

  // A browser that closes the dialog on its own (a second Escape it does not let us cancel) must not leave the caller believing it is open.
  // The event arrives after the fact, so a dialog that has been opened again since is left alone.
  function handleClose(event: SyntheticEvent<HTMLDialogElement>) {
    if (wanted.current && !event.currentTarget.open) onCancel();
  }

  // The dialog element itself is only the backdrop around its content box: the padding belongs to the inner box.
  function handleBackdropPress(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onCancel();
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

  return (
    <dialog
      ref={dialogRef}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={handleCancel}
      onClose={handleClose}
      onClick={handleBackdropPress}
      onKeyDown={handleKeyDown}
      className="m-0 mt-auto max-h-[calc(100dvh-3rem)] w-full max-w-full overflow-y-auto rounded-md rounded-b-none border-0 bg-surface p-0 text-ink shadow-raised backdrop:bg-scrim tablet:m-auto tablet:max-w-[25rem] tablet:rounded-b-md motion-safe:max-tablet:open:transition-[translate] motion-safe:max-tablet:open:duration-(--q-duration-slow) motion-safe:max-tablet:open:ease-standard motion-safe:max-tablet:open:starting:translate-y-full"
    >
      <div className="px-q24 pt-q24">
        <h2 id={titleId} className="text-section text-ink">
          {title}
        </h2>
        <p id={bodyId} className="mt-q12 text-body text-ink">
          {children}
        </p>
      </div>
      {/* The buttons stay at the bottom of the dialog, so when the text is enlarged until the dialog scrolls, the title and the sentence are read
          first and the focused button is still in view. From 768 px they make a row; each takes the width of its label, and the second drops to
          its own row when both do not fit 352 px. */}
      <div className="sticky bottom-0 bg-surface px-q24 pt-q24 pb-[calc(var(--q-space-24)+env(safe-area-inset-bottom))] tablet:pb-q24">
        <div className="flex flex-col gap-q8 tablet:flex-row tablet:flex-wrap">
          <div className="tablet:flex-auto">
            <Button data-dialog-primary fullWidth onClick={primary.onPress}>
              {primary.label}
            </Button>
          </div>
          <div className="tablet:flex-auto">
            <Button variant="secondary" fullWidth onClick={secondary.onPress}>
              {secondary.label}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
