"use client";

import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";

export interface EntityActionsProps {
  name: string; // the title of the row, which names the buttons for assistive technology
  deletable: boolean; // nothing uses the row (docs/Content-admin.md section 3)
  deleting: boolean; // this row's delete is in flight
  onEdit: () => void;
  onDelete: () => void;
}

// The two buttons of a row in the lists of books, categories and sources. A row that something uses cannot be deleted: its button stays in the page,
// disabled the way the kit disables a button (aria-disabled, so it keeps its focus and its name), and the reason sits under it and describes it.
export function EntityActions({ name, deletable, deleting, onEdit, onDelete }: EntityActionsProps) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const hintId = useId();
  return (
    <div className="mt-q16">
      <div className="flex flex-wrap items-center gap-q12">
        <Button variant="secondary" aria-label={t.names.edit(name)} onClick={onEdit}>
          {t.buttons.edit}
        </Button>
        <Button
          variant="secondary"
          aria-label={t.names.delete(name)}
          aria-disabled={deletable ? undefined : true}
          aria-describedby={deletable ? undefined : hintId}
          loading={deleting}
          onClick={onDelete}
        >
          {t.buttons.delete}
        </Button>
      </div>
      {deletable ? null : (
        <p id={hintId} className="mt-q8 text-small text-ink-secondary">
          {t.failures.inUse}
        </p>
      )}
    </div>
  );
}
