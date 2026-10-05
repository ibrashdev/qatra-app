"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import { FailureBanner } from "@/components/today/FailureBanner";
import { EmptyPlan } from "@/components/today/TodaySections";
import { isAlertFailure } from "@/components/today/today-failure";
import { Banner } from "@/components/ui/Banner";
import { BannerSlot } from "@/components/ui/FormBanners";
import { PageTitle } from "@/components/ui/PageTitle";
import { useLocale } from "@/i18n/LocaleProvider";
import { progressMessages } from "@/i18n/progress-messages";
import { todayMessages } from "@/i18n/today-messages";
import { useWakeUpState } from "@/lib/api/react";
import { raiseLoginArrival } from "@/lib/auth/flash";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { ProgressSkeleton } from "./ProgressSkeleton";
import { DailyCard, NextReviewLine, OverallCard, SectionGroups } from "./ProgressSections";
import { selectPlan } from "./progress-model";
import { useProgressData } from "./use-progress-data";

// S-21 Results and progress (UI-screens Batch 4, package F10): two independent indicators (daily time, overall confirmed words) and the state of the
// material. Read-only: it has no primary action and never certifies memorization (D66). E19 and E18 load in parallel.
export function ProgressScreen() {
  const { locale } = useLocale();
  const t = progressMessages(locale);
  const today = todayMessages(locale);
  const router = useRouter();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const { state, reload } = useProgressData();
  const bannerId = useId();

  const failure = state.status === "error" ? state.failure : null;

  // G-03: the session ended. S-01 shows its banner once and brings the learner back here.
  useEffect(() => {
    if (failure?.kind !== "session_ended") return;
    raiseLoginArrival("session_ended");
    router.replace(`/login?next=${encodeURIComponent("/progress")}`);
  }, [failure?.kind, router]);

  // P-04: a read that failed while the server was waking is sent again once health answers, once per wake-up so a failing server cannot loop.
  const autoReloaded = useRef(false);
  useEffect(() => {
    if (wake.phase !== "ready") {
      autoReloaded.current = false;
      return;
    }
    if (!autoReloaded.current && state.status === "error" && state.failure.kind === "connectivity") {
      autoReloaded.current = true;
      reload();
    }
  }, [wake.phase, state, reload]);

  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  const failureNode =
    failure === null ? null : <FailureBanner failure={failure} t={today} online={online} waking={waking} id={bannerId} onRetry={reload} onRefresh={reload} />;
  const alertFailure = failure !== null && isAlertFailure(failure);

  const view = state.status === "ready" ? selectPlan(state.progress) : null;

  let body = null;
  if (state.status === "loading") {
    body = <ProgressSkeleton loadingText={today.loading} />;
  } else if (state.status === "ready" && view !== null) {
    if (view.kind === "plan") {
      const { plan } = view;
      // From 1280 px the two cards sit side by side in a 960 px band: the negative margin widens them beyond the 720 px column.
      body = (
        <div className="mt-q24 flex flex-col gap-q24">
          <div className="grid gap-q16 desktop:mx-[calc((100%-960px)/2)] desktop:grid-cols-2">
            <DailyCard locale={locale} daily={state.progress.daily} streakDays={state.streakDays} />
            <OverallCard locale={locale} plan={plan} />
          </div>
          <NextReviewLine locale={locale} date={plan.nextReviewDate} />
          <SectionGroups locale={locale} plan={plan} />
        </div>
      );
    } else {
      body = <EmptyPlan t={today} hasPausedPlan={view.hasPausedPlan} />;
    }
  }

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>

      <div className="mt-q24 flex flex-col gap-q16 empty:hidden">{view?.kind === "plan" && view.completed ? <Banner variant="info">{today.banners.completed}</Banner> : null}</div>
      <BannerSlot polite={alertFailure ? null : failureNode} alert={alertFailure ? failureNode : null} />

      {body}
    </div>
  );
}
