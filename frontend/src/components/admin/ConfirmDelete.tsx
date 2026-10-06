"use client";

import type { ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { renderTemplate } from "@/i18n/template";

export interface ConfirmDeleteProps {
  // The row to delete, or null while the dialog is closed. `name` is the title of the row, written into the sentence.
  target: { name: string } | null;
  copy: { title: string; body: string; confirm: string }; // body has {name}
  onConfirm: () => void;
  onCancel: () => void;
}

// A deletion is asked for first: an alert dialog whose safe choice, Cancel, is the primary button and takes the focus. The words of the confirming
// button name what it deletes, and the sentence says it cannot be undone.
export function ConfirmDelete({ target, copy, onConfirm, onCancel }: ConfirmDeleteProps) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const name: ReactNode = target === null ? "" : <bdi dir="auto">{target.name}</bdi>;
  return (
    <Dialog
      open={target !== null}
      role="alertdialog"
      title={copy.title}
      primary={{ label: t.buttons.cancel, onPress: onCancel }}
      secondary={{ label: copy.confirm, onPress: onConfirm }}
      onCancel={onCancel}
    >
      {renderTemplate(copy.body, { name })}
    </Dialog>
  );
}
