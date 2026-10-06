"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { RecoveryCodeUnavailableBanner } from "@/components/auth/RecoveryCodeUnavailableBanner";
import { takePlanConfirmed } from "@/components/plan-chat/confirmed-flash";
import { DownloadCard } from "@/components/pwa/DownloadCard";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { BannerSlot } from "@/components/ui/FormBanners";
import { PageTitle } from "@/components/ui/PageTitle";
import { TextLink } from "@/components/ui/TextLink";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import { todayMessages } from "@/i18n/today-messages";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { startDailySession } from "@/lib/api/today-endpoints";
import { raiseLoginArrival } from "@/lib/auth/flash";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { FailureBanner } from "./FailureBanner";
import { TodaySkeleton } from "./TodaySkeleton";
import { DailySection, EmptyPlan, GoalSection, nextPassageLine, NextStepSection, ReviewsSection, StageSection, StickyAction } from "./TodaySections";
import { isAlertFailure, classifyTodayError, type TodayFailure } from "./today-failure";
import { addDays, currentStage, formatLearningDate, inactivePlan, isReturnAfterAbsence, monotonicNow, pendingMinutes, upcomingReviewDate } from "./today-model";
import { useTodayData } from "./use-today-data";

interface Throttle {
  retryAfterSec: number;
  endsAt: number; // a performance.now() value
}

// S-11 Plan & today (UI-screens Batch 2, package F7): the learner's day at a glance and one button for the session.
// E18 and E19 load in parallel; the button calls E20 `daily` once per press (P-14) and opens the session screen (S-19) with the id it answers.
// The toast needs a provider that the app shell does not have, so the screen carries its own.
export function TodayScreen() {
  return (
    <ToastProvider>
      <TodayContent />
    </ToastProvider>
  );
}

function TodayContent() {
  const { locale, messages } = useLocale();
  const toast = useToast();
  const t = todayMessages(locale);
  const router = useRouter();
  const { client } = useApiRuntime();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const { state, reload, goalReachedNow } = useTodayData();
  const bannerId = useId();

  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<TodayFailure | null>(null);
  const [throttle, setThrottle] = useState<Throttle | null>(null);
  const [throttleOver, setThrottleOver] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Arrival from S-34: the one-time toast «تم اعتماد خطتك.» or «تم اعتماد التعديل.», read once from memory (never the URL).
  useEffect(() => {
    const kind = takePlanConfirmed();
    if (kind !== null) toast.show(planChatMessages(locale).toast[kind]);
    // Once per arrival: the locale at that moment is the one that counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failure: TodayFailure | null = startFailure ?? (state.status === "error" ? state.failure : null);

  // G-03: the session ended. S-01 shows its banner once and brings the learner back here.
  useEffect(() => {
    if (failure?.kind !== "session_ended") return;
    raiseLoginArrival("session_ended");
    router.replace(`/login?next=${encodeURIComponent("/today")}`);
  }, [failure?.kind, router]);

  // P-04: a read that failed while the server was waking is sent again once health answers (a press is never resent, P-14).
  // It runs when the failure arrives or when health answers, whichever is later, and only once per wake-up so a server that keeps failing cannot loop.
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

  function refresh() {
    setStartFailure(null);
    setThrottle(null);
    reload();
  }

  async function startSession(target: { planId: string; planVersion: number }) {
    if (starting || throttle !== null) return;
    setStartFailure(null);
    setThrottleOver(false);
    setStarting(true);
    let leaving = false;
    try {
      const snapshot = await startDailySession(client, target);
      if (!mounted.current) return;
      if (typeof snapshot?.sessionId !== "string" || snapshot.sessionId === "") {
        setStartFailure({ kind: "internal" });
        return;
      }
      leaving = true;
      router.push(`/session/${encodeURIComponent(snapshot.sessionId)}`);
    } catch (error) {
      if (!mounted.current) return;
      const next = classifyTodayError(error);
      if (next.kind === "aborted") return;
      if (next.kind === "throttled") setThrottle({ retryAfterSec: next.retryAfterSec, endsAt: monotonicNow() + next.retryAfterSec * 1000 });
      setStartFailure(next);
    } finally {
      // On success the button keeps its loading state while the next screen opens.
      if (!leaving) setStarting(false);
    }
  }

  const ready = state.status === "ready" ? state : null;
  const today = ready?.today ?? null;
  const progress = ready?.progress ?? null;
  const plan = today?.plan ?? null;
  const completedPlan = today !== null && plan === null ? inactivePlan(progress, "completed") : null;
  const pausedPlan = today !== null && plan === null ? inactivePlan(progress, "paused") : null;

  const sessionTarget =
    plan !== null ? { planId: plan.planId, planVersion: plan.currentVersion } : completedPlan !== null ? { planId: completedPlan.planId, planVersion: completedPlan.currentVersion } : null;
  const blocked = startFailure?.kind === "revoked" || throttle !== null;
  const waking = wake.phase === "waking" || wake.phase === "timed_out";

  const sessionButton =
    today !== null && sessionTarget !== null ? (
      <>
        <Button
          fullWidth
          loading={starting}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? bannerId : undefined}
          onClick={() => void startSession(sessionTarget)}
        >
          {starting ? t.next.starting : today.openSessionId !== null ? t.next.continueSession : t.next.start}
        </Button>
        {throttle !== null ? (
          <div className="mt-q8">
            <Countdown
              endsAt={throttle.endsAt}
              totalSeconds={throttle.retryAfterSec}
              onDone={() => {
                setThrottle(null);
                setStartFailure(null);
                setThrottleOver(true);
              }}
            />
          </div>
        ) : null}
      </>
    ) : null;

  const failureNode =
    failure === null ? null : (
      <FailureBanner
        failure={failure}
        t={t}
        online={online}
        waking={waking}
        id={bannerId}
        onRetry={startFailure === null ? reload : undefined}
        onRefresh={refresh}
      />
    );
  const alertFailure = failure !== null && isAlertFailure(failure);

  // Info banners keep to the page: no live-region role, they follow the heading that has focus (P-09).
  const infoBanners =
    today === null ? null : (
      <>
        {today.openPlanChatId ? (
          <Banner variant="info" action={<TextLink href={`/plan/chat/${encodeURIComponent(today.openPlanChatId)}`}>{t.banners.continueChat}</TextLink>}>
            {t.banners.openChat}
          </Banner>
        ) : null}
        {isReturnAfterAbsence(today, progress) ? <Banner variant="info">{t.banners.absence}</Banner> : null}
        {pendingMinutes(today) !== null ? <Banner variant="info">{t.banners.pending(formatLearningDate(locale, addDays(today.learningDate, 1)))}</Banner> : null}
        {completedPlan !== null ? <Banner variant="info">{t.banners.completed}</Banner> : null}
      </>
    );

  let body = null;
  if (state.status === "loading") {
    body = <TodaySkeleton loadingText={t.loading} />;
  } else if (today !== null) {
    if (plan !== null) {
      const stage = currentStage(today, progress);
      const nextLine = isReturnAfterAbsence(today, progress) ? t.next.lightReview : nextPassageLine(t, today);
      body = (
        <>
          <GoalSection locale={locale} t={t} plan={plan} />
          <DailySection locale={locale} t={t} today={today} plan={plan} goalReached={today.dailyCompleted} />
          {stage !== null ? <StageSection locale={locale} t={t} stage={stage} /> : null}
          <ReviewsSection locale={locale} t={t} dueReviews={today.dueReviews} nextReviewDate={upcomingReviewDate(progress, plan.planId, today.learningDate)} />
          <DownloadCard planId={plan.planId} planVersion={plan.currentVersion} />
          <NextStepSection t={t} line={nextLine}>
            {sessionButton}
          </NextStepSection>
        </>
      );
    } else if (completedPlan !== null) {
      // G-31: a completed plan keeps maintenance reviews. Only the reviews are shown, with the session button.
      body = (
        <>
          <ReviewsSection locale={locale} t={t} dueReviews={today.dueReviews} nextReviewDate={upcomingReviewDate(progress, completedPlan.planId, today.learningDate)} />
          <StickyAction>{sessionButton}</StickyAction>
        </>
      );
    } else {
      body = <EmptyPlan t={t} hasPausedPlan={pausedPlan !== null} />;
    }
  }

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      {plan !== null ? (
        <div className="flex justify-end">
          <TextLink href="/plan">{t.viewPlan}</TextLink>
        </div>
      ) : null}
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>

      <div className="mt-q16 flex flex-col gap-q16 empty:hidden">
        <RecoveryCodeUnavailableBanner />
        {infoBanners}
      </div>
      <BannerSlot
        polite={alertFailure ? null : failureNode}
        alert={alertFailure ? failureNode : null}
        announcement={
          <>
            {starting ? <p>{t.next.starting}</p> : null}
            {goalReachedNow ? <p>{t.daily.reached}</p> : null}
            {throttleOver ? <p>{messages.form.throttleOver}</p> : null}
          </>
        }
      />

      {body}
    </div>
  );
}
