"use client";

import { useState } from "react";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import { ClearLocalControl } from "./ClearLocalControl";
import { SyncChip } from "./SyncStatus";
import { outboxCountsOf, useLocalPlan } from "./use-offline-state";

// The offline rows of S-22 (offline-spec 4.3). The sync chip of c4 reads the device: «متزامن» when nothing waits, «محفوظ على الجهاز، بانتظار المزامنة» when answers
// do (G-22). Without a downloaded plan the screen is exactly what it was before the offline plan existed.
export function AccountSyncChip() {
  const { inspection } = useLocalPlan();
  return <SyncChip counts={outboxCountsOf(inspection)} />;
}

// «الخطة على هذا الجهاز» and the clear control, shown only while a copy (or unsynced answers) is on the device.
export function OfflineAccountRows() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).settings;
  const { inspection, refresh } = useLocalPlan();
  // The copy is gone after a clear, and so is the control that said so: the confirmation stays until the screen is left.
  const [cleared, setCleared] = useState(false);
  if (inspection === null) return null;
  const counts = outboxCountsOf(inspection);
  if (inspection.record === null && counts.total === 0) {
    return cleared ? (
      <p role="status" aria-live="polite" className="text-small text-success-ink">
        {t.cleared}
      </p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-q8">
      <p className="text-body text-ink">
        {t.planLabel} <span className="text-ink-secondary">{inspection.status === "ready" ? t.planReady : t.planNone}</span>
      </p>
      <ClearLocalControl
        unsynced={counts.total}
        onCleared={() => {
          setCleared(true);
          void refresh();
        }}
      />
    </div>
  );
}

// S-27: what deleting the account does to a copy kept on this device. Shown only when there is one.
export function LocalCopyDeletionNote() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).settings;
  const { inspection } = useLocalPlan();
  if (inspection === null) return null;
  if (inspection.record === null && inspection.counts.total === 0) return null;
  return <Notice>{t.logoutLine}</Notice>;
}
