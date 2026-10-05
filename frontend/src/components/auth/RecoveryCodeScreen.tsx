"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/ui/BrandMark";
import { PageTitle } from "@/components/ui/PageTitle";
import { SkipLink } from "@/components/ui/SkipLink";
import { ToastProvider } from "@/components/ui/Toast";
import { TopBar } from "@/components/ui/TopBar";
import { useRouteFocus } from "@/components/ui/use-page-chrome";
import { useLocale } from "@/i18n/LocaleProvider";
import { useApiRuntime } from "@/lib/api/react";
import { raiseCodeUnavailable, raiseLoginArrival } from "@/lib/auth/flash";
import { peekRecoveryCode, recoveryCodeGroups, resolveAbsentDestination, wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { RecoveryCodeSave } from "./RecoveryCodeSave";

// The focus screen of UI-design 2.1 for S-04: the header holds the droplet and the product name and nothing else (not a link, no back
// control, no language switch), and there is no tab bar. Going back would abandon a code that is shown once.
function RecoveryCodeShell({ children }: { children: ReactNode }) {
  const { messages } = useLocale();
  useRouteFocus();
  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={messages.screens.recoveryCode} />
      <SkipLink />
      <TopBar>
        <BrandMark />
      </TopBar>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24 tablet:py-q32">
        <div className="mx-auto w-full max-w-form">{children}</div>
      </main>
    </div>
  );
}

// Guard 9 (UI-design 2.3): the code is gone (a reload, a deep link), so there is nothing to show. The screen asks the session where the
// learner belongs and replaces itself with that screen, which shows the Info banner once. Nothing but the empty frame is on screen meanwhile.
function RecoveryCodeAbsent() {
  const router = useRouter();
  const { api } = useApiRuntime();

  useEffect(() => {
    // Whatever was held is not a code that can be shown.
    wipeRecoveryCode();
    const controller = new AbortController();
    void resolveAbsentDestination(api, controller.signal).then((destination) => {
      if (destination === null) return;
      if (destination.variant === "recovery") raiseLoginArrival("code_unavailable");
      else raiseCodeUnavailable();
      router.replace(destination.path);
    });
    return () => controller.abort();
  }, [api, router]);

  return <div aria-busy="true" />;
}

// S-04 (UI-screens Batch 1): the recovery code, shown once. The code arrives in memory from the screen that asked for it (E03 today; E07 and E08
// later) and is read once, here; a value that is not a recovery code is treated as no code at all.
export function RecoveryCodeScreen() {
  const [held] = useState(peekRecoveryCode);
  const groups = held === null ? null : recoveryCodeGroups(held.code);

  return (
    <RecoveryCodeShell>
      {held !== null && groups !== null ? (
        <ToastProvider>
          <RecoveryCodeSave code={held.code} groups={groups} host={held.host} />
        </ToastProvider>
      ) : (
        <RecoveryCodeAbsent />
      )}
    </RecoveryCodeShell>
  );
}
