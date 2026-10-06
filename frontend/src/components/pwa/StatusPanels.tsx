"use client";

import type { ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";

// The states of S-31 and S-33 that replace the local day: nothing downloaded, incomplete, locked, newer data than the app, a storage failure, another account's
// copy, an unsupported browser, a plan that is stale, revoked or expired. Each is a calm card with the reason in words (never colour alone) and, where the
// learner can act, one button. None offers to create a plan or to sign in: those need the network (offline-spec 2.1).

function Panel({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-q12 rounded-md border border-divider bg-surface p-q16">
      <Icon name={icon} size="xl" className="text-info-edge" />
      <h2 className="text-section text-ink">{title}</h2>
      <p className="text-body text-ink">{children}</p>
      {action}
    </section>
  );
}

export function NoPlanPanel() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell.noPlan;
  return (
    <Panel icon="download" title={t.title}>
      {t.body}
    </Panel>
  );
}

export function IncompletePanel() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell.incomplete;
  return (
    <Panel icon="warning" title={t.title}>
      {t.body}
    </Panel>
  );
}

export function LockedPanel({ onRepair, repairing }: { onRepair: () => void; repairing: boolean }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell.locked;
  return (
    <Panel
      icon="lock"
      title={t.title}
      action={
        <Button variant="secondary" loading={repairing} onClick={onRepair}>
          {t.action}
        </Button>
      }
    >
      {t.body}
    </Panel>
  );
}

export function SchemaPanel() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell.schemaIncompatible;
  return (
    <Panel icon="refresh" title={t.title}>
      {t.body}
    </Panel>
  );
}

export function StoragePanel({ onRetry }: { onRetry: () => void }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  return (
    <Panel
      icon="error"
      title={t.shell.storageError.title}
      action={
        <Button variant="secondary" onClick={onRetry}>
          {t.shell.retry}
        </Button>
      }
    >
      {t.shell.storageError.body}
    </Panel>
  );
}

export function OwnerMismatchPanel({ onClear, clearing }: { onClear: () => void; clearing: boolean }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell.ownerMismatch;
  return (
    <Panel
      icon="lock"
      title={t.title}
      action={
        <Button loading={clearing} onClick={onClear}>
          {clearing ? t.clearing : t.action}
        </Button>
      }
    >
      {t.body}
    </Panel>
  );
}

export function UnsupportedPanel() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell;
  return (
    <Panel icon="info" title={t.screenName}>
      {t.unsupported}
    </Panel>
  );
}

// S-33 stale: display and new runs of the downloaded material stop until a fresh download. The outbox is untouched.
export function StalePanel() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).revalidation;
  return (
    <Panel icon="refresh" title={t.staleTitle}>
      {t.staleBody}
    </Panel>
  );
}

// S-33 revoked or expired (G-20): the material was hidden and deleted; the label is the fixed «غير متاح».
export function UnavailablePanel({ expired }: { expired: boolean }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).revalidation;
  return (
    <Panel icon="info" title={t.revokedLabel}>
      {expired ? t.expiredBody : t.revokedBody}
    </Panel>
  );
}

// The login link is a plain anchor: a router transition would need the network, and the service worker answers a navigation without one by returning to
// the shell.
function LoginLink() {
  const { locale } = useLocale();
  return (
    <a href="/login" className="inline-flex min-h-target items-center rounded-sm text-body text-link underline underline-offset-4">
      {offlineMessages(locale).shell.login}
    </a>
  );
}

// G-03: the session ended. The local copy and the outbox are kept.
export function SessionEndedBanner() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell;
  return (
    <Banner variant="warning" action={<LoginLink />}>
      {t.sessionEnded}
    </Banner>
  );
}

// A visitor who never signed in on this device, and so has no session to end: a neutral invitation with the same link.
export function SignInPromptBanner() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell;
  return (
    <Banner variant="info" action={<LoginLink />}>
      {t.signInPrompt}
    </Banner>
  );
}

// G-01: the free server is waking. The local day stays usable; after 90 s the retry button appears.
export function WakingBanner({ timedOut, onRetry }: { timedOut: boolean; onRetry: () => void }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).shell;
  return (
    <Banner
      variant="info"
      icon={<Spinner />}
      action={
        timedOut ? (
          <Button variant="secondary" onClick={onRetry}>
            {t.retry}
          </Button>
        ) : null
      }
    >
      {t.serverWaking}
    </Banner>
  );
}
