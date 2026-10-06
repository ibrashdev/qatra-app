"use client";

import { useEffect, useState } from "react";
import { getAdminAccess } from "@/lib/api/admin-endpoints";
import { useApiRuntime } from "@/lib/api/react";

// AD-00: whether the signed-in account is a content manager. GET /admin/access answers 200 `{ contentManager }` to every signed-in account, false for a
// non-manager and for a demo account. The row in settings is shown only for `contentManager === true`; false, a 401, any other answer, an outage and no
// answer all leave it out, and none of them shows an error or a banner. The probe is untracked, so a slow or failing answer never raises the busy line
// or the wake-up line of the shell.
export function useAdminAccess(): boolean {
  const { client } = useApiRuntime();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAdminAccess(client, { signal: controller.signal, track: false }).then(
      (answer) => {
        if (!controller.signal.aborted) setAllowed(answer.contentManager === true);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [client]);
  return allowed;
}
