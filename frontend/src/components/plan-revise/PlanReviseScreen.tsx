"use client";

import { useId } from "react";
import { RecoveryCodeUnavailableBanner } from "@/components/auth/RecoveryCodeUnavailableBanner";
import { FailureBanner } from "@/components/today/FailureBanner";
import { TodaySkeleton } from "@/components/today/TodaySkeleton";
import { addDays, formatLearningDate } from "@/components/today/today-model";
import { PlanFailureBanner } from "@/components/plan-overview/PlanFailureBanner";
import { PlanHeader } from "@/components/plan-overview/PlanHeader";
import { PlanSection } from "@/components/plan-overview/PlanSections";
import { isAlertPlanFailure, type PlanFailure } from "@/components/plan-overview/plan-failure";
import { editionOf, goalLines } from "@/components/plan-overview/plan-overview-model";
import { useSessionEndedRedirect, usePlanData } from "@/components/plan-overview/use-plan-data";
import { LinkButton } from "@/components/progress/LinkButton";
import { hadithPathsOf } from "./revise-model";
import { todayIn, type HadithPath } from "@/components/start/start-model";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { Dialog } from "@/components/ui/Dialog";
import { BannerSlot } from "@/components/ui/FormBanners";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { PageTitle } from "@/components/ui/PageTitle";
import { TextButton } from "@/components/ui/TextButton";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import { planOverviewMessages } from "@/i18n/plan-overview-messages";
import { planReviseMessages } from "@/i18n/plan-revise-messages";
import { todayMessages } from "@/i18n/today-messages";
import { browserTimeZone } from "@/lib/browser";
import { PlanReviseForm } from "./PlanReviseForm";
import { useRevise } from "./use-revise";

const ALL_HADITH_PATHS: readonly HadithPath[] = ["matn", "sanad", "grade"];

// S-13 Plan revision (UI-screens Batch 2, package F7): starts a revision conversation for the plan in force (E31 with `planId`, then S-34), or,
// when the conversation is unavailable, a short structured form (E15 and E17). A revision takes effect from the next learning day (D57, D72).
// E18, E19, E14 and E11 load in parallel; every press that writes is sent once (P-14).
export function PlanReviseScreen({ revealForm = false }: { revealForm?: boolean }) {
  const { locale, messages } = useLocale();
  const t = planReviseMessages(locale);
  const overview = planOverviewMessages(locale);
  const today = todayMessages(locale);
  const data = usePlanData();
  const bannerId = useId();
  const formBannerId = useId();
  const startHelpId = useId();

  const ready = data.state.status === "ready" ? data.state : null;
  const plan = ready?.today.plan ?? null;
  const edition = ready !== null && plan !== null ? editionOf(ready.catalog, plan) : null;
  const isDemo = ready?.profile?.isDemo === true;
  const timeZone = ready?.profile?.timeZone ?? browserTimeZone();

  const revise = useRevise({
    plan,
    edition,
    locale,
    learningDate: ready?.today.learningDate ?? null,
    timeZone,
    revealForm,
    refresh: data.refresh,
  });

  const loadFailure = data.state.status === "error" ? data.state.failure : null;
  const failure: PlanFailure | null = loadFailure ?? revise.startFailure;
  const ended = [loadFailure, revise.startFailure, revise.formFailure].some((entry) => entry?.kind === "session_ended");
  useSessionEndedRedirect(ended ? "session_ended" : null, "/plan/revise");

  // The plan cannot be revised when E18 carries none: a completed plan shows G-11, a paused plan has no details here (E18 `plan` is the active
  // plan, O-52) and is resumed on S-12, and no plan at all is G-24.
  const completedPlan = ready !== null && plan === null && ready.progress.plans.some((entry) => entry.status === "completed");
  const pausedPlan = ready !== null && plan === null && ready.progress.plans.some((entry) => entry.status === "paused");
  const revokedByCatalog = ready !== null && plan !== null && ready.catalog !== null && edition === null;
  const closed = revise.closed ?? (revokedByCatalog ? "revoked" : null);

  const backToPlan = <LinkButton href="/plan" variant="secondary">{t.backToPlan}</LinkButton>;
  const isRetryable = failure?.kind === "internal" || failure?.kind === "unavailable" || failure?.kind === "connectivity";
  const alert = failure !== null && isAlertPlanFailure(failure);
  const revealButton = <TextButton onClick={revise.openForm}>{t.form.reveal}</TextButton>;

  const topFailure =
    failure === null ? null : (
      <PlanFailureBanner
        failure={failure}
        id={bannerId}
        online={data.online}
        waking={data.waking}
        onRetry={loadFailure !== null ? data.reload : isRetryable ? () => void revise.start() : undefined}
        onRefresh={data.reload}
        action={loadFailure === null && isRetryable && !revise.formOpen ? revealButton : undefined}
      />
    );

  const closedNode =
    closed === "revoked" ? (
      <FailureBanner failure={{ kind: "revoked" }} t={today} online={data.online} waking={data.waking} id={`${bannerId}-closed`} onRefresh={data.reload} />
    ) : closed === "not_found" ? (
      <PlanFailureBanner failure={{ kind: "not_found" }} id={`${bannerId}-closed`} online={data.online} waking={data.waking} onRefresh={data.reload} action={backToPlan} />
    ) : closed === "not_active" || completedPlan || pausedPlan ? (
      <PlanFailureBanner
        failure={{ kind: "plan_not_active" }}
        id={`${bannerId}-closed`}
        online={data.online}
        waking={data.waking}
        onRefresh={data.reload}
        completedWhenNotActive={closed === "not_active" || completedPlan}
        action={backToPlan}
      />
    ) : null;

  const formFailureNode =
    revise.formFailure === null ? null : (
      <PlanFailureBanner failure={revise.formFailure} id={formBannerId} online={data.online} waking={data.waking} onRefresh={revise.refreshPlan} />
    );
  const formAlert = revise.formFailure !== null && isAlertPlanFailure(revise.formFailure);

  const paused = plan?.status === "paused";
  const lines = plan === null ? null : goalLines(locale, overview, plan, edition);
  const pending = plan !== null && typeof plan.pendingSessionMinutes === "number" && ready !== null;
  const availablePaths = hadithPathsOf(edition?.availablePaths ?? ALL_HADITH_PATHS);

  const polite = [revise.starting ? t.start.starting : null, revise.calculating ? t.form.calculating : null, revise.confirming ? t.form.confirming : null];

  let body = null;
  if (data.state.status === "loading") {
    body = <TodaySkeleton loadingText={today.loading} />;
  } else if (ready !== null && plan !== null && lines !== null && closed === null) {
    body = (
      <>
        <PlanSection label={overview.sections.goal}>
          <p>{lines.head}</p>
          <p className="text-ink-secondary">{lines.detail}</p>
        </PlanSection>
        <PlanSection label={overview.sections.dailyTime}>
          <p>{`${today.daily.text(formatInteger(locale, plan.sessionMinutes), plan.sessionMinutes, formatInteger(locale, plan.agreedEstimate.newWordsPerDay), plan.agreedEstimate.newWordsPerDay)}.`}</p>
          {pending ? <p className="text-small text-ink-secondary">{today.banners.pending(formatLearningDate(locale, addDays(ready.today.learningDate, 1)))}</p> : null}
        </PlanSection>

        <p className="mt-q24 text-body text-ink">{t.explanation}</p>
        <p id={startHelpId} className="mt-q12 text-small text-ink-secondary">
          {isDemo ? t.helper.demo : t.helper.learner}
        </p>
        {paused ? <p className="mt-q8 text-small text-ink-secondary">{t.pausedNote}</p> : null}
        <div className="mt-q16">
          <Notice>{planChatMessages(locale).transparency}</Notice>
        </div>
        <div className="mt-q16">
          <Button
            fullWidth
            loading={revise.starting}
            aria-disabled={revise.throttle !== null || undefined}
            aria-describedby={startHelpId}
            onClick={() => void revise.start()}
          >
            {revise.starting ? t.start.starting : t.start.button}
          </Button>
          {revise.throttle !== null ? (
            <div className="mt-q8">
              <Countdown endsAt={revise.throttle.endsAt} totalSeconds={revise.throttle.retryAfterSec} onDone={revise.endThrottle} />
            </div>
          ) : null}
        </div>

        {revise.formOpen ? (
          <PlanReviseForm
            locale={locale}
            t={t}
            plan={plan}
            revise={revise}
            availablePaths={availablePaths}
            today={todayIn(timeZone)}
            banner={
              formAlert ? <div role="alert">{formFailureNode}</div> : formFailureNode
            }
          />
        ) : null}
      </>
    );
  } else if (ready !== null && plan === null && !completedPlan && !pausedPlan) {
    body = (
      <section aria-label={today.empty.title} className="mt-q24 flex flex-col items-start gap-q12">
        <Icon name="droplet" size="xl" className="text-ink-secondary" />
        <h2 className="text-section text-ink">{today.empty.title}</h2>
        <LinkButton href="/start">{today.empty.action}</LinkButton>
      </section>
    );
  }

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <PlanHeader title={t.screenName} backDestination={t.backDestination} backHref="/plan" />

      <div className="mt-q24 flex flex-col gap-q16 empty:hidden">
        <RecoveryCodeUnavailableBanner />
        {closedNode}
      </div>
      <BannerSlot
        polite={alert ? null : topFailure}
        alert={alert ? topFailure : null}
        announcement={
          <>
            {polite.map((line, index) => (line === null ? null : <p key={index}>{line}</p>))}
            {revise.estimate !== null && revise.previewTick > 0 ? <p key={revise.previewTick}>{t.preview.shown}</p> : null}
            {revise.throttleOver ? <p>{messages.form.throttleOver}</p> : null}
          </>
        }
      />

      {body}

      <Dialog
        open={revise.dialogOpen}
        title={t.dialog.title}
        primary={{ label: t.dialog.cancel, onPress: revise.closeDialog }}
        secondary={{ label: t.dialog.confirm, onPress: () => void revise.confirm() }}
        onCancel={revise.closeDialog}
      >
        {`${t.dialog.body}${paused ? ` ${t.dialog.paused}` : ""}`}
      </Dialog>
    </div>
  );
}
