"use client";

import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { gamesMessages } from "@/i18n/games-messages";
import type { SheetState } from "./use-game-round";

// P-23, the leave sheet: a native dialog (nothing is deleted, so not an alert dialog), docked at the bottom edge on a phone and centred from 768 px.
// «متابعة اللعب» is the safe action: it has the initial focus, and Esc, a press on the backdrop and the first button all mean keep playing.
// Leaving sends the pending events and E22, then goes to the games. If that fails the dialog stays open with its own Error banner, «إعادة المحاولة»
// first and «المغادرة دون حفظ» second. The «saving» label is the one S-19 uses while its sheet saves; the second button is inert meanwhile.
export function LeaveSheet({
  sheet,
  onKeepPlaying,
  onLeave,
  onRetry,
  onLeaveUnsaved,
}: {
  sheet: SheetState;
  onKeepPlaying: () => void;
  onLeave: () => void;
  onRetry: () => void;
  onLeaveUnsaved: () => void;
}) {
  const { locale } = useLocale();
  const t = gamesMessages(locale).round.sheet;
  const status = sheet.open ? sheet.status : "idle";
  const failed = status === "failed";

  return (
    <Dialog
      open={sheet.open}
      title={t.title}
      primary={failed ? { label: t.retry, onPress: onRetry } : { label: t.keepGoing, onPress: onKeepPlaying }}
      secondary={failed ? { label: t.leaveUnsaved, onPress: onLeaveUnsaved } : { label: status === "saving" ? t.saving : t.leave, onPress: onLeave }}
      onCancel={onKeepPlaying}
    >
      {t.body}
      {failed ? (
        <span role="alert" className="mt-q12 flex items-start gap-q8 text-body-compact text-error-ink">
          <Icon name="error" size="md" />
          <span>{t.failed}</span>
        </span>
      ) : null}
    </Dialog>
  );
}
