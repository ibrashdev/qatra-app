"use client";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { sessionMessages } from "@/i18n/session-messages";
import type { SheetState } from "./use-session-run";

// c19, the pause and leave sheet (P-12): a native dialog, docked at the bottom edge on a phone. «متابعة الجلسة» is the safe action: it has the initial
// focus, and Esc, a press on the backdrop and the first button all mean continue. «إيقاف مؤقت والخروج» completes nothing; it goes to Today.
// Opening the sheet stops the clock and sends what waits. If that fails the sheet says so, offers a retry, and leaving stays possible.
export function PauseSheet({ sheet, onKeepGoing, onLeave, onRetry }: { sheet: SheetState; onKeepGoing: () => void; onLeave: () => void; onRetry: () => void }) {
  const { locale } = useLocale();
  const t = sessionMessages(locale).pauseSheet;
  const status = sheet.open ? sheet.status : "idle";

  return (
    <Dialog
      open={sheet.open}
      title={t.title}
      primary={{ label: t.keepGoing, onPress: onKeepGoing }}
      secondary={{ label: status === "saving" ? t.saving : t.leave, onPress: onLeave }}
      onCancel={onKeepGoing}
    >
      {t.body}
      {status === "failed" ? (
        <span className="mt-q12 flex flex-col items-start gap-q8">
          <span role="alert" className="flex items-start gap-q8 text-body-compact text-error-ink">
            <Icon name="error" size="md" />
            <span>{t.failed}</span>
          </span>
          <Button variant="secondary" onClick={onRetry}>
            {t.retry}
          </Button>
        </span>
      ) : null}
    </Dialog>
  );
}
