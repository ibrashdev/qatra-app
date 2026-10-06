"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { Banner } from "@/components/ui/Banner";
import { BannerSlot } from "@/components/ui/FormBanners";
import { PageTitle } from "@/components/ui/PageTitle";
import { TextLink } from "@/components/ui/TextLink";
import { demoMessages } from "@/i18n/demo-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ApiClient } from "@/lib/api/client";
import { listDemoSimulations } from "@/lib/api/demo-endpoints";
import { useWakeUpState } from "@/lib/api/react";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { DemoFailureBanner, isAlertDemoFailure } from "./DemoFailureBanner";
import { DemoSkeleton } from "./DemoSkeleton";
import { SimulationCard } from "./SimulationCard";
import { readSimulations } from "./demo-model";
import { useDemoAccess } from "./use-demo-access";
import { useDemoRead } from "./use-demo-read";

const NEXT_PATH = "/demo/simulations";

const loadSimulations = (client: ApiClient, options: { signal: AbortSignal }) => listDemoSimulations(client, options).then(readSimulations);

// S-30: the precomputed multi-day simulations, read only (E29). Every result carries the label «محسوبة سلفًا لا تشغيلًا حيًا» at the top of the screen and
// on its own card, and the synthetic profile and the scripted learner behind it are stated beside the days. Nothing on this screen runs anything.
export function DemoSimulationsScreen() {
  const router = useRouter();
  const { locale } = useLocale();
  const t = demoMessages(locale).simulations;
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const { access, retry: recheck } = useDemoAccess(NEXT_PATH);
  const { state, reload } = useDemoRead(loadSimulations, access.status === "allowed");
  const bannerId = useId();

  // G-03 and guard 11 for an answer that arrives after the guard has let the account in.
  const readFailure = state.status === "error" ? state.failure : null;
  const readFailureKind = readFailure?.kind;
  useEffect(() => {
    if (readFailureKind === "session_ended") redirectToLogin(router, NEXT_PATH);
    else if (readFailureKind === "forbidden") router.replace("/today");
  }, [readFailureKind, router]);

  const guardFailure = access.status === "failed" ? access.failure : null;
  const failure = guardFailure ?? readFailure;
  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  const failureNode =
    failure === null ? null : <DemoFailureBanner failure={failure} id={bannerId} online={online} waking={waking} onRetry={guardFailure !== null ? recheck : reload} onRefresh={reloadPage} />;
  const alertFailure = failure !== null && isAlertDemoFailure(failure);

  const checking = access.status === "checking" || access.status === "leaving" || (access.status === "allowed" && state.status === "loading");
  const simulations = state.status === "ready" ? state.data : null;

  let body = null;
  if (checking) {
    body = <DemoSkeleton loadingText={t.loading} />;
  } else if (simulations !== null && simulations.length === 0) {
    body = <Banner variant="info">
        <span className="[overflow-wrap:anywhere]">{t.empty}</span>
      </Banner>;
  } else if (simulations !== null) {
    body = (
      <div className="flex flex-col gap-q24">
        {simulations.map((simulation) => (
          <SimulationCard key={simulation.simulationId} locale={locale} t={t} simulation={simulation} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>

      <div className="mt-q24">
        {/* The label is the banner's title, written as its first line here so that a long word may break at large text (200 % at 320 px). */}
        <Banner variant="info">
          <p className="mb-q4 text-section [overflow-wrap:anywhere]">{t.label}</p>
          <p className="[overflow-wrap:anywhere]">{t.labelBody}</p>
        </Banner>
      </div>
      <BannerSlot polite={alertFailure ? null : failureNode} alert={alertFailure ? failureNode : null} />

      <div className="mt-q24">{body}</div>

      <div className="mt-q24 flex flex-col items-start">
        <TextLink href="/today">{t.backToday}</TextLink>
        <TextLink href="/demo/scenario">{t.chooseOther}</TextLink>
      </div>
    </div>
  );
}
