"use client";

import type { ReactNode } from "react";
import { OfflineNotice } from "@/components/pwa/OfflineNotice";
import { useConnectivityStatus } from "@/lib/net/use-connectivity";
import { BackControl, type BackTarget } from "./BackControl";
import { SkipLink } from "./SkipLink";
import { WakeUpStatus } from "./WakeUpStatus";
import { PageTitle } from "./PageTitle";
import { useRouteFocus } from "./use-page-chrome";
import { useWrappedBar } from "./use-wrapped-bar";

// Focus-flow shell (UA-10): back control and title in the bar, no tab bar and no rail at any width.
// The bar is sticky while it is one row and static once it has wrapped (use-wrapped-bar.ts): a title that grows to many lines at large
// text must not take the window for good. The bar and the action bar declare themselves with data-bar; the page's scroll padding (globals.css)
// keeps the room of exactly the bars that are there, so a focused control is never left under them.
// A flow that is open when the connection drops keeps its state, so the shell only says so (no switch to the downloaded plan, which would leave the flow):
// `offlineNotice` is true unless the screen already shows its own offline line, or runs on the device with its own backend (the offline plan).
export function FocusShell({
  title,
  back,
  actions,
  actionBar,
  offlineNotice = true,
  children,
}: {
  title: string;
  back?: BackTarget;
  actions?: ReactNode;
  actionBar?: ReactNode;
  offlineNotice?: boolean;
  children: ReactNode;
}) {
  useRouteFocus();
  const { barRef, wrapped } = useWrappedBar();
  const { status } = useConnectivityStatus();

  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={title} />
      <SkipLink />
      <header ref={barRef} data-bar="top" data-wrapped={wrapped} className="sticky top-0 z-(--q-z-sticky) bg-page pt-[env(safe-area-inset-top)] data-[wrapped=true]:static">
        <div className="flex min-h-appbar items-center gap-q12 px-page">
          {back ? <BackControl {...back} /> : null}
          <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
            {title}
          </h1>
          {actions}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24">
        <WakeUpStatus>{offlineNotice && status === "offline" ? <OfflineNotice kind="offline" /> : null}</WakeUpStatus>
        {children}
      </main>
      {actionBar ? (
        <div data-bar="bottom" className="sticky bottom-0 z-(--q-z-sticky) border-t border-divider bg-page px-page pt-q12 pb-[calc(var(--q-space-12)+env(safe-area-inset-bottom))]">
          {actionBar}
        </div>
      ) : null}
    </div>
  );
}
