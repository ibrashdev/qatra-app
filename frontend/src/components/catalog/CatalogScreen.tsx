"use client";

import { useId, useRef } from "react";
import { BannerSlot, WakeUpBanner } from "@/components/ui/FormBanners";
import { Notice } from "@/components/ui/Notice";
import { PageTitle } from "@/components/ui/PageTitle";
import { PublicShell } from "@/components/ui/PublicShell";
import { useLocale } from "@/i18n/LocaleProvider";
import { catalogMessages } from "@/i18n/catalog-messages";
import { useWakeUpState } from "@/lib/api/react";
import type { CatalogEdition } from "@/lib/api/types";
import { useSignedInRedirect } from "@/lib/auth/use-signed-in-redirect";
import { isAlertFailure } from "@/lib/catalog/catalog-failure";
import { categoryLabel, groupByCategory } from "@/lib/catalog/catalog-model";
import { useCatalog } from "@/lib/catalog/use-catalog";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { AuthActions } from "./AuthActions";
import { CatalogEmpty } from "./CatalogEmpty";
import { CatalogFailureBanner } from "./CatalogFailure";
import { CatalogSkeleton } from "./CatalogSkeleton";
import { EditionCard } from "./EditionCard";

// S-07 Public catalog (UI-screens Batch 2, package F5): what is published, before registering (D71). Metadata only: no verse, hadith, lesson or question
// is on this screen or reachable from it. E14 is public and read-only, so a retry is always safe. Guard 2 sends a signed-in learner away (useSignedInRedirect).
export function CatalogScreen() {
  const { locale, messages } = useLocale();
  const t = catalogMessages(locale);
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  const { state, reload } = useCatalog();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bannerId = useId();
  useSignedInRedirect();

  const failure = state.status === "error" ? state.failure : null;
  const waking = online && (wake.phase === "waking" || wake.phase === "timed_out");
  const alertFailure = failure !== null && isAlertFailure(failure);

  // The loading state puts focus back on the heading (state table); a press on «إعادة المحاولة» is the only way here, so the button is gone by then.
  function retry() {
    reload();
    headingRef.current?.focus();
  }

  const failureNode = failure === null ? null : <CatalogFailureBanner failure={failure} online={online} waking={waking} id={bannerId} onRetry={retry} />;
  // P-04 sits in the banner area below the intro on this screen (the page turns the shell's own wake-up line off). It never stands beside another banner:
  // the failure banner stays silent while the server wakes, and a failure with an answer of its own replaces the line.
  const wakeNode = waking && (failure === null || failure.kind === "connectivity") ? <WakeUpBanner timedOut={wake.phase === "timed_out"} /> : null;

  const empty = state.status === "ready" && state.editions.length === 0;

  let body = null;
  if (state.status === "loading" || (failure?.kind === "connectivity" && waking)) {
    body = <CatalogSkeleton loadingText={messages.server.busy} />;
  } else if (state.status === "ready") {
    body = empty ? (
      <CatalogEmpty title={t.empty.title} text={t.empty.text} />
    ) : (
      <div className="mt-q24 flex flex-col gap-q24">
        {groupByCategory(state.editions).map((group) => (
          <CategorySection key={group.slug} label={categoryLabel(locale, group.category)} editions={group.editions} />
        ))}
      </div>
    );
  }

  return (
    <PublicShell wakeUp={false} actions={<AuthActions />}>
      <PageTitle screenName={t.screenName} />
      <h1 ref={headingRef} data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>
      <p className="mt-q16 text-body text-ink">{t.intro}</p>
      <div className="mt-q24 flex flex-wrap items-center gap-q8 tablet:hidden">
        <AuthActions />
      </div>

      <BannerSlot
        polite={
          <>
            {wakeNode}
            {alertFailure ? null : failureNode}
          </>
        }
        alert={alertFailure ? failureNode : null}
        announcement={
          <>
            {empty ? <p>{t.empty.title}</p> : null}
            {wake.phase === "ready" ? <p>{messages.server.ready}</p> : null}
            {reconnected && online ? <p>{messages.form.backOnline}</p> : null}
          </>
        }
      />

      <div className="mt-q24">
        <Notice>{t.notice}</Notice>
      </div>

      {body}
    </PublicShell>
  );
}

// c6: the category heading, then its editions 16 px apart. Editions of one category share the heading.
function CategorySection({ label, editions }: { label: string; editions: CatalogEdition[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-section text-ink">
        <bdi dir="auto">{label}</bdi>
      </h2>
      <ul className="mt-q12 flex flex-col gap-q16">
        {editions.map((edition) => (
          <EditionCard key={edition.editionId} edition={edition} />
        ))}
      </ul>
    </section>
  );
}
