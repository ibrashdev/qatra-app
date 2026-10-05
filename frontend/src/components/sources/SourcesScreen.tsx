"use client";

import { useId, useRef } from "react";
import { CatalogEmpty } from "@/components/catalog/CatalogEmpty";
import { CatalogFailureBanner } from "@/components/catalog/CatalogFailure";
import { CatalogSkeleton } from "@/components/catalog/CatalogSkeleton";
import { useSessionEndedRedirect } from "@/components/plan-overview/use-plan-data";
import { PlanHeader } from "@/components/plan-overview/PlanHeader";
import { BannerSlot } from "@/components/ui/FormBanners";
import { Notice } from "@/components/ui/Notice";
import { PageTitle } from "@/components/ui/PageTitle";
import { useLocale } from "@/i18n/LocaleProvider";
import { catalogMessages } from "@/i18n/catalog-messages";
import { sourcesMessages } from "@/i18n/sources-messages";
import { useWakeUpState } from "@/lib/api/react";
import { isAlertFailure } from "@/lib/catalog/catalog-failure";
import { isPlanEditionUnavailable } from "@/lib/catalog/catalog-model";
import { useCatalog } from "@/lib/catalog/use-catalog";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { SourceCard } from "./SourceCard";
import { UnavailableCard } from "./UnavailableCard";

// S-25 Sources (UI-screens Batch 4, package F11): where the books come from, as metadata only (E14). E18 loads in parallel to learn whether the plan's
// book is still listed (O-49); its failure leaves the flag out, except a 401, which ends the session (G-03). Read-only, so a retry is always safe.
// The signed-in shell speaks for the wake-up (P-04), so this screen adds no line of its own.
export function SourcesScreen() {
  const { locale, messages } = useLocale();
  const t = sourcesMessages(locale);
  const notice = catalogMessages(locale).notice;
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  const { state, reload } = useCatalog({ withPlan: true });
  const bannerId = useId();
  const frameRef = useRef<HTMLDivElement>(null);

  const failure = state.status === "error" ? state.failure : null;
  const waking = online && (wake.phase === "waking" || wake.phase === "timed_out");
  const alertFailure = failure !== null && isAlertFailure(failure);
  useSessionEndedRedirect(failure?.kind === "session_ended" ? "session_ended" : null, "/settings/sources");

  // The loading state puts focus back on the heading (state table); the retry button is gone by then, so focus would otherwise fall to the page.
  function retry() {
    reload();
    frameRef.current?.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }

  const failureNode = failure === null ? null : <CatalogFailureBanner failure={failure} online={online} waking={waking} id={bannerId} onRetry={retry} />;
  const empty = state.status === "ready" && state.editions.length === 0;
  const unavailable = state.status === "ready" && isPlanEditionUnavailable(state.editions, state.plan) ? state.plan : null;

  let body = null;
  if (state.status === "loading" || (failure?.kind === "connectivity" && waking)) {
    body = <CatalogSkeleton loadingText={messages.server.busy} />;
  } else if (state.status === "ready") {
    body = (
      <>
        {unavailable !== null || state.editions.length > 0 ? (
          <ul className="mt-q24 flex flex-col gap-q16">
            {unavailable !== null ? <UnavailableCard plan={unavailable} /> : null}
            {state.editions.map((edition) => (
              <SourceCard key={edition.editionId} edition={edition} />
            ))}
          </ul>
        ) : null}
        {empty ? <CatalogEmpty title={t.empty} /> : null}
      </>
    );
  }

  return (
    <div ref={frameRef}>
      <PageTitle screenName={t.screenName} />
      <PlanHeader title={t.screenName} backDestination={messages.tabs.settings} backHref="/settings" />

      <BannerSlot
        polite={alertFailure ? null : failureNode}
        alert={alertFailure ? failureNode : null}
        announcement={
          <>
            {empty ? <p>{t.empty}</p> : null}
            {reconnected && online ? <p>{messages.form.backOnline}</p> : null}
          </>
        }
      />

      <div className="mt-q24">
        <Notice>{notice}</Notice>
      </div>

      {body}
    </div>
  );
}
