"use client";

import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages, type OfflineMessages } from "@/i18n/offline-messages";
import type { OutboxCounts, SyncOutcome, SyncProgress } from "@/lib/offline/types";

// The chip of S-22 c4 and of the shell: «متزامن» when nothing waits, «محفوظ على الجهاز، بانتظار المزامنة» when answers wait on the device (G-22). It sits in a
// polite status region with its text (UI-tokens 6.11), never by colour alone.
export function SyncChip({ counts, syncing = false }: { counts: OutboxCounts; syncing?: boolean }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).sync;
  const waiting = counts.queued + counts.pending > 0;
  const text = syncing ? t.syncing : waiting ? t.savedOnDevice : t.synced;
  return (
    <span role="status" aria-live="polite">
      <span
        className={
          waiting || syncing
            ? "inline-flex min-h-badge items-center gap-q4 rounded-sm bg-info-tint px-q12 text-caption text-info-ink"
            : "inline-flex min-h-badge items-center gap-q4 rounded-sm bg-success-tint px-q12 text-caption text-success-ink"
        }
      >
        <Icon name={waiting || syncing ? "clock" : "success"} size="sm" />
        {text}
      </span>
    </span>
  );
}

// The outcomes of a sync that deserve a line of their own. A sign-in problem and an owner mismatch have their own banners, so they are not here.
function outcomeLine(outcome: SyncOutcome | null, t: OfflineMessages["sync"]): string | null {
  switch (outcome) {
    case "server_unreachable":
    case "unavailable":
      return t.unreachable;
    case "throttled":
      return t.throttled;
    case "locked_elsewhere":
      return t.lockedElsewhere;
    case "failed":
      return t.failed;
    default:
      return null;
  }
}

// What the device knows about its unsent answers (S-33): the chip, the count the server has not verified yet, the answers that were not counted and stay
// recorded (G-21), the sync button, and the line of the last outcome.
export function SyncStatus({
  counts,
  progress,
  onSync,
  showButton = true,
}: {
  counts: OutboxCounts;
  progress: SyncProgress;
  onSync: () => void;
  showButton?: boolean;
}) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const labelId = useId();
  const syncing = progress.phase !== "idle" && progress.phase !== "done" && progress.phase !== "stopped";
  const line = outcomeLine(progress.result?.outcome ?? null, t.sync);
  const waiting = counts.queued + counts.pending;

  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-q12">
      <div className="flex flex-wrap items-center gap-q12">
        <span id={labelId} className="text-body text-ink">
          {t.sync.label}
        </span>
        <SyncChip counts={counts} syncing={syncing} />
      </div>
      {counts.pending > 0 ? (
        <p className="text-body-compact text-ink-secondary">
          {t.revalidation.pendingCount(formatInteger(locale, counts.pending))} {"·"} {t.revalidation.pendingVerification}
        </p>
      ) : null}
      {counts.blocked > 0 ? (
        <p className="text-body-compact text-ink-secondary">
          {t.revalidation.blockedCount(formatInteger(locale, counts.blocked))} {"·"} {t.revalidation.notCounted} {t.revalidation.blockedKept}
        </p>
      ) : null}
      {line !== null ? <Notice>{line}</Notice> : null}
      {showButton && (waiting > 0 || progress.timedOut) ? (
        <div>
          <Button variant="secondary" loading={syncing} onClick={onSync}>
            {progress.timedOut ? t.shell.retry : t.sync.syncNow}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
