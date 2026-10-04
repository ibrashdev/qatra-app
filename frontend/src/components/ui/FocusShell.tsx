"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { SkipLink } from "./SkipLink";
import { WakeUpStatus } from "./WakeUpStatus";
import { PageTitle } from "./PageTitle";
import { useRouteFocus } from "./use-page-chrome";

export interface FocusShellBack {
  destination: string; // where the control goes, named for assistive technology: "Back to {destination}"
  href?: string;
  onClick?: () => void;
}

const backClassName =
  "inline-flex min-h-target min-w-target shrink-0 items-center justify-center rounded-sm px-q8 text-button text-primary-deep transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection";

// Focus-flow shell (UA-10): back control and title in the bar, no tab bar and no rail at any width.
// The text back control stands in for the arrow icon of UI-tokens 6.6; no icon set has been chosen (antislop R-04).
export function FocusShell({
  title,
  back,
  actions,
  actionBar,
  children,
}: {
  title: string;
  back?: FocusShellBack;
  actions?: ReactNode;
  actionBar?: ReactNode;
  children: ReactNode;
}) {
  const { messages } = useLocale();
  useRouteFocus();
  const backName = back ? messages.backTo(back.destination) : undefined;

  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={title} />
      <SkipLink />
      <header className="sticky top-0 z-(--q-z-sticky) bg-page pt-[env(safe-area-inset-top)]">
        <div className="flex min-h-appbar items-center gap-q12 px-page">
          {back?.href ? (
            <Link href={back.href} aria-label={backName} className={backClassName}>
              {messages.back}
            </Link>
          ) : back ? (
            <button type="button" aria-label={backName} onClick={back.onClick} className={backClassName}>
              {messages.back}
            </button>
          ) : null}
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
