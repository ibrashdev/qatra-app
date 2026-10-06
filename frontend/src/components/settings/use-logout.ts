"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { logoutAlreadyDone } from "@/components/consent/consent-failure";
import { endConsentVisit } from "@/components/consent/consent-state";
import { confirmUnsyncedLogout } from "@/components/pwa/logout-guard";
import { logout } from "@/lib/api/account-endpoints";
import { ConnectivityError } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import { wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft } from "@/lib/auth/register-draft";
import { countOutbox } from "@/lib/offline/outbox";
import { logoutLocally, readOwnerState } from "@/lib/offline/owner";

export interface Logout {
  loggingOut: boolean;
  failed: boolean;
  press: () => Promise<void>;
}

// The answers waiting on this device for the account that is signed in; 0 where nothing is stored or storage is unavailable.
async function countUnsynced(): Promise<number> {
  try {
    const owner = await readOwnerState();
    return owner?.ownerId == null ? 0 : (await countOutbox(owner.ownerId)).total;
  } catch {
    return 0;
  }
}

// c19 of S-22 (UI-screens S-22 "Logout (E10)"). `204` and `401` both mean the session is gone, which is what the learner asked for: the in-memory state is cleared
// and the screen goes to S-01. `403`, `503` or no answer keep the learner here with an error banner. With a plan downloaded for offline use, answers that are not synced
// yet would be deleted with the local copy, so the learner is asked first (the dialog of §6.9), the copy is wiped after the server logout, and a logout pressed with no
// connection wipes the copy at once and records that the server logout is still owed (PWA-design 7).
export function useLogout(): Logout {
  const { client } = useApiRuntime();
  const router = useRouter();
  const mounted = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function press() {
    if (loggingOut) return;
    setFailed(false);
    setLoggingOut(true);
    const unsynced = await countUnsynced();
    if (unsynced > 0 && !(await confirmUnsyncedLogout(unsynced))) {
      if (mounted.current) setLoggingOut(false);
      return;
    }
    let done = false;
    let owedToServer = false;
    try {
      await logout(client);
      done = true;
    } catch (error) {
      done = logoutAlreadyDone(error);
      // No connection at all: the copy still has to leave this device now; the server logout is owed and is finished on the next foreground check.
      if (!done && error instanceof ConnectivityError && typeof navigator !== "undefined" && navigator.onLine === false) {
        done = true;
        owedToServer = true;
      }
    }
    if (!done) {
      if (mounted.current) {
        setFailed(true);
        setLoggingOut(false);
      }
      return;
    }
    // The local copy and its unsent answers leave with the session. A failed clear locks the personal view; it never blocks the logout itself.
    await logoutLocally({ serverLogoutDone: !owedToServer }).catch(() => undefined);
    // Nothing kept in memory for this learner outlives the session: the register draft, a recovery code that was never shown, and the consent box.
    clearRegisterDraft();
    wipeRecoveryCode();
    endConsentVisit();
    if (mounted.current) router.replace("/login");
  }

  return { loggingOut, failed, press };
}
