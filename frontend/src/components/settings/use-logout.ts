"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { logoutAlreadyDone } from "@/components/consent/consent-failure";
import { endConsentVisit } from "@/components/consent/consent-state";
import { logout } from "@/lib/api/account-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft } from "@/lib/auth/register-draft";

export interface Logout {
  loggingOut: boolean;
  failed: boolean;
  press: () => Promise<void>;
}

// c19 of S-22 (UI-screens S-22 "Logout (E10)"): no dialog in option B, since nothing is unsynced. `204` and `401` both mean the session is gone, which is what
// the learner asked for: the in-memory state is cleared and the screen goes to S-01. `403`, `503` or no answer keep the learner here with an error banner.
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
    let done = false;
    try {
      await logout(client);
      done = true;
    } catch (error) {
      done = logoutAlreadyDone(error);
    }
    if (!done) {
      if (mounted.current) {
        setFailed(true);
        setLoggingOut(false);
      }
      return;
    }
    // Nothing kept in memory for this learner outlives the session: the register draft, a recovery code that was never shown, and the consent box.
    clearRegisterDraft();
    wipeRecoveryCode();
    endConsentVisit();
    if (mounted.current) router.replace("/login");
  }

  return { loggingOut, failed, press };
}
