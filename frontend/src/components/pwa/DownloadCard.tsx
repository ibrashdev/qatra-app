"use client";

import { useId, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages, type OfflineMessages } from "@/i18n/offline-messages";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { downloadPlanForOffline } from "@/lib/offline/plan-cache";
import type { DownloadFailureCode, DownloadPhase, LocalPlanInspection } from "@/lib/offline/types";
import { detectEnvironment } from "@/lib/pwa/environment";
import { ClearLocalControl } from "./ClearLocalControl";
import { InstallPrompt } from "./InstallPrompt";
import { UpdateNotice } from "./UpdateNotice";
import { outboxCountsOf, useLocalPlan, useShellReady } from "./use-offline-state";

type CardStatus = "download" | "update" | "ready" | "unavailable" | "locked" | "schema" | "storage";

// Which of the card's states the local copy is in, for the plan the learner is looking at. A copy of another plan or version is an update to offer, never a
// ready plan: only the plan and version of today's screen count as «ready» (PWA-design 4).
export function cardStatus(inspection: LocalPlanInspection, planId: string, planVersion: number): CardStatus {
  switch (inspection.status) {
    case "ready":
      return inspection.record?.planId === planId && inspection.record.planVersion === planVersion ? "ready" : "update";
    case "stale":
      return "update";
    case "revoked":
    case "expired":
      return "unavailable";
    case "locked":
      return "locked";
    case "schema_incompatible":
      return "schema";
    case "storage_error":
      return "storage";
    default:
      return "download";
  }
}

function failureLine(code: DownloadFailureCode, t: OfflineMessages): { text: string; refresh?: boolean; title?: string } {
  switch (code) {
    case "storage_quota":
    case "storage_insufficient":
      return { text: t.download.storageFull };
    case "storage_failed":
      return { text: t.download.storageFailed };
    case "unsupported":
      return { text: t.download.unsupported };
    case "offline":
      return { text: t.download.offline };
    case "plan_not_active":
    case "plan_version":
      return { text: t.download.planChanged, refresh: true };
    case "edition_not_downloadable":
    case "edition_not_available":
    case "target_refs_invalid":
    case "not_found":
      return { title: t.download.notAvailable, text: t.download.notAvailableBody };
    case "throttled":
      return { text: t.download.throttled };
    case "unauthenticated":
      return { text: t.shell.sessionEnded };
    case "schema_too_new":
      return { text: t.download.schemaTooNew };
    case "owner_mismatch":
      return { text: t.download.ownerMismatch };
    case "locked":
      return { text: t.shell.locked.body };
    default:
      return { text: t.download.failed };
  }
}

// S-32 «الخطة جاهزة دون اتصال»: a card of S-11 (offline-spec 4.3). It owns the whole download: the privacy note about the device, the progress phases, the
// failure and storage messages, the ready state (shown only once the app files are cached too, never on the plan alone), the update offer when the plan moved
// on, the clear-local-copy control and, beside them, the install help. The call omits the target passages: the server chooses them (decision G-01).
export function DownloadCard({ planId, planVersion }: { planId: string; planVersion: number }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const { online } = useConnectivity();
  const { inspection, refresh } = useLocalPlan();
  const shellReady = useShellReady();
  const headingId = useId();
  const [phase, setPhase] = useState<DownloadPhase | null>(null);
  const [failure, setFailure] = useState<DownloadFailureCode | null>(null);
  const [running, setRunning] = useState(false);
  // The copy is gone after a clear, so the control that said so is gone too: the card keeps the confirmation until the next download.
  const [cleared, setCleared] = useState(false);
  const [inApp] = useState(() => (typeof window === "undefined" ? false : detectEnvironment().inAppBrowser !== null));

  if (inspection === null) return null;
  // A browser that cannot keep data on the device (no IndexedDB) is not offered a download it cannot hold; an in-app browser still gets its hint.
  if (inspection.failureCode === "unsupported" && !inApp) return null;
  const status = cardStatus(inspection, planId, planVersion);
  const counts = outboxCountsOf(inspection);
  const hasCopy = inspection.record !== null || counts.total > 0;
  const failed = failure === null ? null : failureLine(failure, t);

  async function press() {
    if (running) return;
    setRunning(true);
    setCleared(false);
    setFailure(null);
    setPhase("checking_storage");
    try {
      const result = await downloadPlanForOffline({ planId, expectedPlanVersion: planVersion }, { onPhase: setPhase });
      if (!result.ready) setFailure(result.failureCode ?? "failed");
    } catch {
      setFailure("failed");
    } finally {
      setRunning(false);
      setPhase(null);
      await refresh();
    }
  }

  const ready = status === "ready";
  const cta = status === "update" ? t.download.update : t.download.cta;

  return (
    <section aria-labelledby={headingId} className="mt-q16 flex flex-col gap-q12 rounded-md border border-divider bg-surface p-q16">
      <h2 id={headingId} className="flex items-center gap-q8 text-section text-ink">
        <Icon name="download" size="md" className="text-primary" />
        {t.download.heading}
      </h2>

      {inApp ? (
        <InstallPrompt />
      ) : (
        <>
          <UpdateNotice />
          {ready ? (
            shellReady === false ? (
              <p className="text-body-compact text-ink">{t.download.shellPending}</p>
            ) : (
              <div className="flex flex-col items-start gap-q8">
                <span className="inline-flex min-h-badge items-center gap-q4 rounded-sm bg-success-tint px-q12 text-caption text-success-ink">
                  <Icon name="success" size="sm" />
                  {t.shell.ready}
                </span>
                <p className="text-body-compact text-ink">{t.download.readyBody}</p>
              </div>
            )
          ) : (
            <p className="text-body-compact text-ink">{status === "update" ? t.download.staleBody : t.download.body}</p>
          )}

          {status === "unavailable" ? <Banner variant="info" title={t.revalidation.revokedLabel}>{t.revalidation.revokedBody}</Banner> : null}
          {status === "schema" ? <Banner variant="warning">{t.download.schemaTooNew}</Banner> : null}
          {status === "locked" ? <Banner variant="warning">{t.shell.locked.body}</Banner> : null}
          {status === "storage" ? <Banner variant="warning">{t.shell.storageError.body}</Banner> : null}

          {/* The polite region stays in the page while empty, so the phase and the result are announced when they appear. */}
          <div role="status" aria-live="polite" className="flex flex-col gap-q8 empty:hidden">
            {running && phase !== null ? <p className="text-small text-ink-secondary">{t.download.phases[phase]}</p> : null}
            {!online && !ready ? <p className="text-small text-ink-secondary">{t.download.offline}</p> : null}
            {cleared ? <p className="text-small text-success-ink">{t.settings.cleared}</p> : null}
          </div>
          {failed !== null ? (
            <Banner
              variant="warning"
              role="alert"
              title={failed.title}
              action={
                failed.refresh === true ? (
                  <Button variant="secondary" onClick={reloadPage}>
                    {t.download.refresh}
                  </Button>
                ) : undefined
              }
            >
              {failed.text}
            </Banner>
          ) : null}

          {!ready && status !== "locked" && status !== "schema" ? (
            <div>
              <Button loading={running} onClick={() => void press()}>
                {cta}
              </Button>
            </div>
          ) : null}
          {!ready ? <Notice>{t.download.privacy}</Notice> : null}

          <InstallPrompt />
          {hasCopy ? <ClearLocalControl
              unsynced={counts.total}
              onCleared={() => {
                setCleared(true);
                void refresh();
              }}
            /> : null}
        </>
      )}
    </section>
  );
}
