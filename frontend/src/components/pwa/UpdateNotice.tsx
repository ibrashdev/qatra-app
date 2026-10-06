"use client";

import { useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import { applyUpdateWhenSafe, inspectUpdate, isRunActiveAnywhere, watchForUpdates } from "@/lib/pwa/update";
import type { UpdateState } from "@/lib/offline/types";

const IDLE: UpdateState = { phase: "idle" };

// S-33 update state (offline-spec 3.4): a new version waits in the service worker. A calm banner offers «حدّث الآن», enabled only when no run is open in any
// tab and nothing is being written; the page never replaces itself under a session. Activation is the page's own call, then a reload on `controllerchange`.
export function UpdateNotice() {
  const { locale } = useLocale();
  const t = offlineMessages(locale).update;
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [state, setState] = useState<UpdateState>(IDLE);
  const [safe, setSafe] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then(
      (found) => {
        if (cancelled || found === undefined) return;
        setRegistration(found);
        setState(inspectUpdate(found));
        stop = watchForUpdates(found, (next) => {
          if (!cancelled) setState(next);
        });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Whether a run is open anywhere is read when the banner shows and whenever the page becomes visible again.
  useEffect(() => {
    if (state.phase === "idle") return;
    let cancelled = false;
    const check = () => {
      isRunActiveAnywhere().then(
        (active) => {
          if (!cancelled) setSafe(!active);
        },
        () => undefined,
      );
    };
    check();
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 4000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [state.phase]);

  if (registration === null || state.phase === "idle") return null;
  const applying = state.phase === "applying";

  return (
    <div role="status" aria-live="polite">
      <Banner
        variant={state.phase === "failed" ? "warning" : "info"}
        title={t.title}
        action={
          <Button
            variant="secondary"
            loading={applying}
            aria-disabled={!safe || undefined}
            onClick={() => {
              if (!safe) return;
              setState({ phase: "applying" });
              applyUpdateWhenSafe(registration).then(
                (next) => setState(next),
                () => setState({ phase: "failed" }),
              );
            }}
          >
            {applying ? t.applying : t.apply}
          </Button>
        }
      >
        {state.phase === "failed" ? t.failed : safe ? t.body : t.blocked}
      </Banner>
    </div>
  );
}
