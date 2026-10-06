"use client";

import { useId, useState } from "react";
import { ChoiceList } from "@/components/ui/ChoiceList";
import { Icon } from "@/components/ui/Icon";
import { TextArea } from "@/components/ui/TextArea";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { characterCount, TEXT_LIMITS } from "@/lib/admin/admin-rules";
import { withdrawEdition } from "@/lib/api/admin-endpoints";
import { WITHDRAW_REASONS, type EditionDetail, type WithdrawReason } from "@/lib/api/admin-types";
import { fieldRuleText, hasErrors, withdrawErrors, type FieldErrors } from "./admin-model";
import { ActionFailure } from "./AdminFailureBanner";
import { FormDialog } from "./FormDialog";
import { useAdminAction } from "./use-admin-action";

export interface WithdrawDialogProps {
  edition: EditionDetail;
  next: string;
  onWithdrawn: (edition: EditionDetail) => void;
  onCancel: () => void;
  onReload: () => void;
}

// Withdrawing an edition is final: learners stop receiving it and nothing brings it back (docs/Content-admin.md section 5). The dialog is an alert
// dialog whose safe choice, Cancel, is the primary button and takes the focus. It says the action cannot be undone, asks for one of the three
// reasons of the CLI and for a note of 1 to 500 characters, and sends once per press. Enter in a choice never sends it.
export function WithdrawDialog({ edition, next, onWithdrawn, onCancel, onReload }: WithdrawDialogProps) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const copy = t.edition.withdrawDialog;
  const action = useAdminAction(next);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const noteId = useId();
  const reasonErrorId = useId();

  const errors: FieldErrors<"reason" | "note"> = submitted ? withdrawErrors({ reason, note }) : {};
  const used = characterCount(note.trim());
  const counterTone = used > TEXT_LIMITS.note ? "error" : used >= TEXT_LIMITS.note * 0.9 ? "warning" : "normal";
  const saving = action.busy !== null;

  async function submit() {
    if (saving) return;
    setSubmitted(true);
    const broken = withdrawErrors({ reason, note });
    if (hasErrors(broken)) {
      if (broken.reason === undefined) document.getElementById(noteId)?.focus();
      return;
    }
    const result = await action.run("withdraw", (client) =>
      withdrawEdition(client, edition.id, { expectedUpdatedAt: edition.updatedAt, reason: reason as WithdrawReason, note: note.trim() }),
    );
    if (result.ok) onWithdrawn(result.value);
  }

  return (
    <FormDialog
      role="alertdialog"
      safeCancel
      title={copy.title}
      description={copy.warning}
      confirm={{ label: saving ? t.buttons.saving : copy.confirm, busy: saving }}
      cancel={{ label: t.buttons.cancel }}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      banner={<ActionFailure failure={action.failure} onReload={onReload} />}
    >
      <div>
        <ChoiceList
          legend={copy.reasonLegend}
          options={WITHDRAW_REASONS.map((value) => ({ value, title: t.withdrawReasons[value] }))}
          value={reason}
          onChange={setReason}
        />
        {errors.reason === undefined ? null : (
          <p id={reasonErrorId} className="mt-q8 flex items-start gap-q8 text-small text-error-ink">
            <Icon name="error" size="sm" className="mt-1" />
            {t.rules.chooseReason}
          </p>
        )}
      </div>
      <TextArea
        id={noteId}
        label={copy.noteLabel}
        helper={copy.noteHelper}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        counter={{ text: `${formatInteger(locale, used)}/${formatInteger(locale, TEXT_LIMITS.note)}`, tone: counterTone }}
        error={errors.note === undefined ? undefined : fieldRuleText(locale, t, errors.note, TEXT_LIMITS.note)}
      />
    </FormDialog>
  );
}
