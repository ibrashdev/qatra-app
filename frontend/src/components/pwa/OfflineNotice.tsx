"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";

// The Info banner of a page that is still open when the connection drops (PWA-design 6; P-05 is an Info banner, never an error). It says what is true: the
// page stays, what was typed here lives on this page only and is not saved, what needs a connection, and that the downloaded plan works offline. It never
// says the learner's answers are safe on the device: only the offline plan keeps them there. The shell that renders it owns the polite live region, which
// stays in the page while empty so that this banner is announced when it arrives.
//   kind "offline": this device has no connection.
//   kind "server":  the browser is online but the free server has not answered after the wake-up wait; the downloaded plan can be used meanwhile.
export function OfflineNotice({ kind, onOpenOffline }: { kind: "offline" | "server"; onOpenOffline?: () => void }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).notice;
  return (
    <Banner
      variant="info"
      title={kind === "offline" ? t.title : undefined}
      action={
        onOpenOffline === undefined ? undefined : (
          <Button variant="secondary" onClick={onOpenOffline}>
            {t.open}
          </Button>
        )
      }
    >
      {kind === "offline" ? t.body : t.server}
    </Banner>
  );
}
