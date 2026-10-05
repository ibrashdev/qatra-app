"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RecoveryCodeUnavailableBanner } from "@/components/auth/RecoveryCodeUnavailableBanner";
import { LinkButton } from "@/components/progress/LinkButton";
import { FailureBanner } from "@/components/today/FailureBanner";
import { TodaySkeleton } from "@/components/today/TodaySkeleton";
import { addDays, formatLearningDate } from "@/components/today/today-model";
import { Banner } from "@/components/ui/Banner";
import { Dialog } from "@/components/ui/Dialog";
import { BannerSlot } from "@/components/ui/FormBanners";
import { Icon } from "@/components/ui/Icon";
import { PageTitle } from "@/components/ui/PageTitle";
import { TextLink } from "@/components/ui/TextLink";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { planOverviewMessages } from "@/i18n/plan-overview-messages";
import { renderTemplate } from "@/i18n/template";
import { todayMessages } from "@/i18n/today-messages";
import { useApiRuntime } from "@/lib/api/react";
import { resumePlan } from "@/lib/api/plan-endpoints";
import type { PlanProgress } from "@/lib/api/types";
import { OtherPlans } from "./OtherPlans";
import { PlanFailureBanner } from "./PlanFailureBanner";
import { PlanHeader } from "./PlanHeader";
import { PlanSections } from "./PlanSections";
import { classifyPlanError, isAlertPlanFailure, type PlanFailure } from "./plan-failure";
import { editionOf, otherPlans } from "./plan-overview-model";
import { useSessionEndedRedirect, usePlanData } from "./use-plan-data";

// S-12 Plan overview (UI-screens Batch 2, package F7): the whole plan in the six labelled sections, the other plans, resuming a paused plan, and
// the ways to revise (S-13) or start another plan (S-08). E18, E19, E14 and E11 load in parallel; E30 runs once per press (P-14).
// The toast needs a provider that the app shell does not have, so the screen carries its own.
export function PlanOverviewScreen() {
  return (
    <ToastProvider>
      <PlanOverviewContent />
    </ToastProvider>
  );
}

function PlanOverviewContent() {
  const { locale } = useLocale();
  const toast = useToast();
  const t = planOverviewMessages(locale);
  const today = todayMessages(locale);
  const { client } = useApiRuntime();
  const data = usePlanData();
  const bannerId = useId();

  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeFailure, setResumeFailure] = useState<PlanFailure | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PlanProgress | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const failure: PlanFailure | null = resumeFailure ?? (data.state.status === "error" ? data.state.failure : null);
  useSessionEndedRedirect(failure?.kind ?? null, "/plan");

  async function runResume(target: PlanProgress) {
    if (resumingId !== null) return;
    setResumeFailure(null);
    setAnnouncement(null);
    setResumingId(target.planId);
    try {
      await resumePlan(client, target.planId);
      if (!mounted.current) return;
      toast.show(t.resumed);
      setAnnouncement(t.resumed);
      data.refresh();
      document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
    } catch (error) {
      if (!mounted.current) return;
      const next = classifyPlanError(error);
      if (next.kind === "aborted") return;
      setResumeFailure(next);
      // A plan that is gone or no longer resumable changes the list, so the list is read again.
      if (next.kind === "plan_not_active" || next.kind === "not_found") data.refresh();
    } finally {
      if (mounted.current) setResumingId(null);
    }
  }

  const ready = data.state.status === "ready" ? data.state : null;
  const plan = ready?.today.plan ?? null;
  const others = ready === null ? [] : otherPlans(ready.progress, plan?.planId ?? null);
  const edition = ready !== null && plan !== null ? editionOf(ready.catalog, plan) : null;
  // The edition left the catalog (E14 answered, and the plan's edition is not in it): the plan keeps its text, and the way out is S-08 (G-20).
  const revoked = ready !== null && plan !== null && ready.catalog !== null && edition === null;
  const canResume = ready?.profile?.isDemo === false;

  function requestResume(target: PlanProgress) {
    if (plan !== null) setPendingDialog(target);
    else void runResume(target);
  }

  const alert = failure !== null && isAlertPlanFailure(failure);
  const failureNode =
    failure === null ? null : (
      <PlanFailureBanner
        failure={failure}
        id={bannerId}
        online={data.online}
        waking={data.waking}
        onRetry={resumeFailure === null ? data.reload : undefined}
        onRefresh={() => {
          setResumeFailure(null);
          data.reload();
        }}
        completedWhenNotActive
      />
    );

  const planTitle = plan === null ? "" : locale === "ar" ? plan.titleAr : plan.titleEn;

  let body = null;
  if (data.state.status === "loading") {
    body = <TodaySkeleton loadingText={today.loading} />;
  } else if (ready !== null) {
    body = (
      <>
        {plan !== null ? (
          <>
            <PlanSections locale={locale} t={t} today={today} plan={plan} edition={edition} data={ready.today} progress={ready.progress} />
            <div className="mt-q24 flex flex-wrap items-center gap-x-q16 gap-y-q8">
              <LinkButton href="/plan/revise" variant="secondary">
                {t.buttons.revise}
              </LinkButton>
              <TextLink href="/start">{t.buttons.startAnother}</TextLink>
            </div>
          </>
        ) : (
          <section aria-label={today.empty.title} className="mt-q24 flex flex-col items-start gap-q12">
            <Icon name="droplet" size="xl" className="text-ink-secondary" />
            <h2 className="text-section text-ink">{today.empty.title}</h2>
            <LinkButton href="/start">{today.empty.action}</LinkButton>
          </section>
        )}
        <OtherPlans locale={locale} t={t} plans={others} canResume={canResume} resumingId={resumingId} onResume={requestResume} />
      </>
    );
  }

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <PlanHeader title={t.screenName} backDestination={t.backDestination} backHref="/today" />

      <div className="mt-q24 flex flex-col gap-q16 empty:hidden">
        <RecoveryCodeUnavailableBanner />
        {plan !== null && typeof plan.pendingSessionMinutes === "number" && ready !== null ? (
          <Banner variant="info">{today.banners.pending(formatLearningDate(locale, addDays(ready.today.learningDate, 1)))}</Banner>
        ) : null}
        {revoked ? <FailureBanner failure={{ kind: "revoked" }} t={today} online={data.online} waking={data.waking} id={`${bannerId}-revoked`} onRefresh={data.reload} /> : null}
      </div>
      <BannerSlot polite={alert ? null : failureNode} alert={alert ? failureNode : null} announcement={<p>{resumingId !== null ? t.others.resuming : announcement}</p>} />

      {body}

      <Dialog
        open={pendingDialog !== null}
        title={t.resumeDialog.title}
        primary={{ label: t.resumeDialog.cancel, onPress: () => setPendingDialog(null) }}
        secondary={{
          label: t.resumeDialog.confirm,
          onPress: () => {
            const target = pendingDialog;
            setPendingDialog(null);
            if (target !== null) void runResume(target);
          },
        }}
        onCancel={() => setPendingDialog(null)}
      >
        {renderTemplate(t.resumeDialog.body, { title: <bdi lang={locale}>{planTitle}</bdi> })}
      </Dialog>
    </div>
  );
}
