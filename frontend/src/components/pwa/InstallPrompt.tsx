"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import { getInstallController } from "@/lib/pwa/install";
import type { InstallState } from "@/lib/offline/types";

const SERVER_STATE: InstallState = { kind: "unsupported", inAppBrowser: null };

// S-33 install help (offline-spec 3.3). The browser's own install event is never assumed: «تثبيت التطبيق» only shows when it was captured, the iOS Safari
// steps only on iOS, and an in-app browser is told to open the page in the browser (D67). Nothing is shown when the app is already installed. Installing alone
// never proves the plan is ready, so the line says so and the card keeps its download state beside it.
export function InstallPrompt() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).install;
  const controller = getInstallController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, () => SERVER_STATE);

  switch (state.kind) {
    case "available":
      return (
        <div className="flex flex-col items-start gap-q8">
          <Button variant="secondary" onClick={() => void controller.prompt()}>
            {t.cta}
          </Button>
          <Notice>{t.notProof}</Notice>
        </div>
      );
    case "ios_instructions":
      return (
        <div className="flex flex-col gap-q8">
          <p className="text-body-compact text-ink">{t.iosInstructions}</p>
          <Notice>{t.notProof}</Notice>
        </div>
      );
    case "in_app_browser":
      return (
        <div className="flex flex-col gap-q8">
          <p className="text-body-compact text-ink">{t.openInBrowser}</p>
          <Notice>{t.openInBrowserHint}</Notice>
        </div>
      );
    default:
      return null;
  }
}
