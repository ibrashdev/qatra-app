"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import type { ApiClient } from "@/lib/api/client";
import { useAdminAction, type AdminAction } from "./use-admin-action";
import { useHeadingFocus } from "./use-heading-focus";

export interface DeleteFlowConfig<T extends { id: string }> {
  next: string; // where sign-in returns to after a 401
  send: (client: ApiClient, row: T) => Promise<void>;
  onDeleted: (row: T) => void;
}

export interface DeleteFlow<T extends { id: string }> {
  action: AdminAction;
  // The row whose deletion is being asked for, or null.
  target: T | null;
  ask: (row: T) => void;
  cancel: () => void;
  confirm: () => Promise<void>;
}

// The deletion of a row of a list: the manager asks, the alert dialog confirms, and the request is sent once. A row that something uses never reaches
// this (its button is disabled); if the server still answers 409 the banner says why. After a deletion the toast speaks and the focus goes to the
// heading, because the button that asked is gone.
export function useDeleteFlow<T extends { id: string }>({ next, send, onDeleted }: DeleteFlowConfig<T>): DeleteFlow<T> {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const toast = useToast();
  const focusHeading = useHeadingFocus();
  const action = useAdminAction(next);
  const [target, setTarget] = useState<T | null>(null);

  async function confirm() {
    const row = target;
    if (row === null) return;
    setTarget(null);
    const result = await action.run(row.id, (client) => send(client, row));
    if (!result.ok) return;
    onDeleted(row);
    toast.show(t.toasts.deleted);
    focusHeading();
  }

  return { action, target, ask: setTarget, cancel: () => setTarget(null), confirm };
}
