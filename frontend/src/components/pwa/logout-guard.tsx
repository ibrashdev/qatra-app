"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";

// The logout dialog of UI-screens S-22 §6.9 (deferred to option C): when answers are still unsynced, logging out deletes them from the device, so the learner is
// asked first. The button that logs out lives in SettingsScreen, which another branch edits, so the question is a tiny module: `useLogout` awaits
// `confirmUnsyncedLogout(n)`, and `UnsyncedLogoutDialog` (mounted inside the account section of the same screen) shows it and answers.

interface Request {
  count: number;
  resolve: (confirmed: boolean) => void;
}

let request: Request | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): Request | null => request;
const readOnServer = (): Request | null => null;

// Resolves true when the learner confirmed. With no dialog on screen to ask, it resolves false: answers are never deleted without being asked about.
export function confirmUnsyncedLogout(count: number): Promise<boolean> {
  if (hosts === 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    request?.resolve(false);
    request = { count, resolve };
    notify();
  });
}

function answer(confirmed: boolean): void {
  const current = request;
  request = null;
  notify();
  current?.resolve(confirmed);
}

export function resetLogoutGuardForTests(): void {
  request?.resolve(false);
  request = null;
  hosts = 0;
  listeners.clear();
}

function useHostCount(): void {
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      if (hosts === 0) {
        const current = request;
        request = null;
        current?.resolve(false);
      }
    };
  }, []);
}

export function UnsyncedLogoutDialog() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).logoutDialog;
  const current = useSyncExternalStore(subscribe, read, readOnServer);
  // The dialog counts itself as the host while it is mounted, so a request made with none on screen is refused instead of waiting for ever.
  useHostCount();
  return (
    <Dialog
      open={current !== null}
      role="alertdialog"
      title={t.title}
      primary={{ label: t.cancel, onPress: () => answer(false) }}
      secondary={{ label: t.confirm, onPress: () => answer(true) }}
      onCancel={() => answer(false)}
    >
      {t.body(formatInteger(locale, current?.count ?? 0))}
    </Dialog>
  );
}
