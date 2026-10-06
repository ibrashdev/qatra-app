"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Notice } from "@/components/ui/Notice";
import { TextButton } from "@/components/ui/TextButton";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import { clearLocalCopy } from "@/lib/offline/owner";

type ClearState = "idle" | "confirm" | "clearing" | "failed" | "done";

// «احذف النسخة المحلية» (S-32, S-22): the learner's own clear of the saved plan. It asks first, says that it does not delete the account and that unsent answers
// are lost (D58, UI-screens S-27 line), and reports a failed clear without claiming it worked. The safe action, «إلغاء», takes the initial focus.
export function ClearLocalControl({ unsynced, onCleared }: { unsynced: number; onCleared?: () => void }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const [state, setState] = useState<ClearState>("idle");

  async function confirm() {
    setState("clearing");
    try {
      await clearLocalCopy();
      setState("done");
      onCleared?.();
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col items-start gap-q8">
      <TextButton onClick={() => setState("confirm")}>{t.settings.clearButton}</TextButton>
      <Notice>{t.download.clearNote}</Notice>
      <div role="status" aria-live="polite">
        {state === "clearing" ? <p className="text-small text-ink-secondary">{t.settings.clearing}</p> : null}
        {state === "done" ? <p className="text-small text-success-ink">{t.settings.cleared}</p> : null}
        {state === "failed" ? <p className="text-small text-error-ink">{t.settings.clearFailed}</p> : null}
      </div>
      <Dialog
        open={state === "confirm"}
        role="alertdialog"
        title={t.settings.clearTitle}
        primary={{ label: t.settings.clearCancel, onPress: () => setState("idle") }}
        secondary={{ label: t.settings.clearConfirm, onPress: () => void confirm() }}
        onCancel={() => setState("idle")}
      >
        {t.settings.clearBody(formatInteger(locale, unsynced))}
      </Dialog>
    </div>
  );
}
