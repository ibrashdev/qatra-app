"use client";

import { PageTitle } from "@/components/ui/PageTitle";
import { PublicShell } from "@/components/ui/PublicShell";
import { SkeletonBlock, SkeletonLines } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { useTermsReturn } from "./use-terms-return";

// UI-tokens 6.14: a skeleton shows only if the wait lasts longer than this.
export const SKELETON_DELAY_MS = 300;

// What stands in for the text while its route loads: the text as skeleton lines after 300 ms, and the wait announced. The announcement region is
// in the page from the start, so what is added to it is read. S-03 puts it under its own heading and S-26 under the heading of its frame.
export function TermsLoadingRegion() {
  const { messages } = useLocale();
  const waiting = useAfterDelay(SKELETON_DELAY_MS);
  return (
    <div aria-busy="true">
      <div role="status" aria-live="polite" className="sr-only">
        {waiting ? messages.server.busy : null}
      </div>
      {waiting ? (
        <div className="mt-q24 flex flex-col gap-q24">
          <SkeletonBlock className="h-q16 w-1/3" />
          <SkeletonLines lines={4} />
          <SkeletonLines lines={3} />
          <SkeletonBlock className="h-q16 w-1/3" />
          <SkeletonLines lines={4} />
        </div>
      ) : null}
    </div>
  );
}

// S-03 "Route loading": the header and the heading stay, the text is standing in as skeleton lines after 300 ms, and the wait is announced.
// It must not move focus (it leaves the route change to the screen that follows).
export function TermsLoading() {
  const { messages } = useLocale();
  const { back } = useTermsReturn();
  return (
    <PublicShell back={back} logo={false} wakeUp={false} moveFocus={false} reading>
      <PageTitle screenName={messages.screens.terms} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.screens.terms}
      </h1>
      <TermsLoadingRegion />
    </PublicShell>
  );
}
