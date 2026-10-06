"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages, type AdminMessages } from "@/i18n/admin-messages";
import type { Locale } from "@/i18n/messages";
import { TEXT_LIMITS } from "@/lib/admin/admin-rules";
import { fieldRuleText, type FieldErrors } from "./admin-model";
import { ActionFailure } from "./AdminFailureBanner";
import { FormDialog } from "./FormDialog";
import type { EditForm } from "./use-edit-form";

export interface EditDialogProps<V extends Record<string, string>> {
  title: string;
  form: EditForm<V>;
  onCancel: () => void;
  // The row changed or vanished under the manager (409 `stale`, `state`, 404): the screen closes the dialog and reads again.
  onReload: () => void;
  children: ReactNode;
}

// The error line of one field, in the interface language, or undefined while the field is fine.
export function fieldError<K extends string>(locale: Locale, t: AdminMessages, errors: FieldErrors<K>, field: K, max: number = TEXT_LIMITS.name): string | undefined {
  const rule = errors[field];
  return rule === undefined ? undefined : fieldRuleText(locale, t, rule, max);
}

// The frame of every edit dialog: the title, the fields, the line for "nothing changed", the failure of the last press, and Save and Cancel.
export function EditDialog<V extends Record<string, string>>({ title, form, onCancel, onReload, children }: EditDialogProps<V>) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  return (
    <FormDialog
      title={title}
      confirm={{ label: form.saving ? t.buttons.saving : t.buttons.save, busy: form.saving }}
      cancel={{ label: t.buttons.cancel }}
      onSubmit={() => void form.submit()}
      onCancel={onCancel}
      banner={<ActionFailure failure={form.action.failure} note={form.nothingToSave ? t.rules.noChange : null} onReload={onReload} />}
    >
      {children}
    </FormDialog>
  );
}
