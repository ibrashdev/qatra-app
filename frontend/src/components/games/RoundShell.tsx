"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { PageTitle } from "@/components/ui/PageTitle";
import { SkipLink } from "@/components/ui/SkipLink";
import { useRouteFocus } from "@/components/ui/use-page-chrome";
import { useWrappedBar } from "@/components/ui/use-wrapped-bar";
import { WakeUpStatus } from "@/components/ui/WakeUpStatus";

// The focus-flow chrome of a round (UI-screens P-18): no tab bar, no rail, no language switch; the top bar holds the back control at the start edge and
// the H1 as the bar title; one reading column below; the action bar sticks to the bottom edge. It mirrors FocusShell, which names its back control
// «رجوع إلى {destination}» and cannot take the name of a round's control («مغادرة الجولة»), so the control is drawn here with the same recipe.
const BACK_CLASS =
  "inline-flex size-target shrink-0 items-center justify-center rounded-sm text-ink-secondary transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection hover:text-primary-deep";

export function RoundShell({
  title,
  backLabel,
  onBack,
  actionBar,
  children,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  actionBar?: ReactNode;
  children: ReactNode;
}) {
  useRouteFocus();
  const { barRef, wrapped } = useWrappedBar();

  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={title} />
      <SkipLink />
      <header ref={barRef} data-wrapped={wrapped} className="sticky top-0 z-(--q-z-sticky) bg-page pt-[env(safe-area-inset-top)] data-[wrapped=true]:static">
        <div className="flex min-h-appbar items-center gap-q12 px-page">
          <button type="button" aria-label={backLabel} onClick={onBack} className={BACK_CLASS}>
            <Icon name="back" size="lg" />
          </button>
          <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
            {title}
          </h1>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24">
        <WakeUpStatus />
        {children}
      </main>
      {actionBar ? (
        <div className="sticky bottom-0 z-(--q-z-sticky) border-t border-divider bg-page px-page pt-q12 pb-[calc(var(--q-space-12)+env(safe-area-inset-bottom))] tablet:static">
          <div className="mx-auto w-full max-w-column">{actionBar}</div>
        </div>
      ) : null}
    </div>
  );
}
