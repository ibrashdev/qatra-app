"use client";

import type { ReactNode } from "react";
import { BackControl, type BackTarget } from "./BackControl";
import { SkipLink } from "./SkipLink";
import { WakeUpStatus } from "./WakeUpStatus";
import { PageTitle } from "./PageTitle";
import { useRouteFocus } from "./use-page-chrome";

// Focus-flow shell (UA-10): back control and title in the bar, no tab bar and no rail at any width.
export function FocusShell({
  title,
  back,
  actions,
  actionBar,
  children,
}: {
  title: string;
  back?: BackTarget;
  actions?: ReactNode;
  actionBar?: ReactNode;
  children: ReactNode;
}) {
  useRouteFocus();

  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={title} />
      <SkipLink />
      <header className="sticky top-0 z-(--q-z-sticky) bg-page pt-[env(safe-area-inset-top)]">
        <div className="flex min-h-appbar items-center gap-q12 px-page">
          {back ? <BackControl {...back} /> : null}
          <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
            {title}
          </h1>
          {actions}
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24">
        <WakeUpStatus />
        {children}
      </main>
      {actionBar ? (
        <div className="sticky bottom-0 z-(--q-z-sticky) border-t border-divider bg-page px-page pt-q12 pb-[calc(var(--q-space-12)+env(safe-area-inset-bottom))]">
          {actionBar}
        </div>
      ) : null}
    </div>
  );
}
