"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RecoveryCodeUnavailableBanner } from "@/components/auth/RecoveryCodeUnavailableBanner";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { FocusShell } from "@/components/ui/FocusShell";
import { BannerSlot, OfflineBanner } from "@/components/ui/FormBanners";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { Notice } from "@/components/ui/Notice";
import { TextLink } from "@/components/ui/TextLink";
import { demoMessages } from "@/i18n/demo-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ApiClient } from "@/lib/api/client";
import { createDemoPlan, listDemoScenarios } from "@/lib/api/demo-endpoints";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import type { Plan } from "@/lib/api/types";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { DemoFailureBanner, isAlertDemoFailure } from "./DemoFailureBanner";
import { DemoSkeleton } from "./DemoSkeleton";
import { ScenarioList } from "./ScenarioList";
import { classifyDemoError, type DemoFailure } from "./demo-failure";
import { readScenarios } from "./demo-model";
import { useDemoAccess } from "./use-demo-access";
import { useDemoRead } from "./use-demo-read";

const NEXT_PATH = "/demo/scenario";

// P-06: a request that waits longer than this says it is still working. E28 waits for the model call (up to 8 s) before it falls back.
const SLOW_REQUEST_MS = 5_000;

const loadScenarios = (client: ApiClient, options: { signal: AbortSignal }) => listDemoScenarios(client, options).then(readScenarios);

interface Throttle {
  retryAfterSec: number;
  endsAt: number; // a performance.now() value
}

// S-29: the demo account chooses a ready-made synthetic goal and the constrained planner builds the plan from it (E27, E28). It replaces the goal
// box of S-08 for a demo account: no free text exists here, and only the scenario id is sent. E28 creates a plan, so it is sent once per press, never
// retried by the screen, and a press while one is in flight is ignored.
export function DemoScenarioScreen() {
  const router = useRouter();
  const { locale, messages } = useLocale();
  const { client } = useApiRuntime();
  const text = demoMessages(locale).scenario;
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  const { access, retry: recheck } = useDemoAccess(NEXT_PATH);
  const { state: list, reload } = useDemoRead(loadScenarios, access.status === "allowed");

  const helperId = useId();
  const bannerId = useId();
  const builtHeadingId = useId();
  const builtHeadingRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Set at once by the press, before any render: two quick presses cannot send two requests.
  const inFlight = useRef(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [slow, setSlow] = useState(false);
  const [built, setBuilt] = useState<Plan | null>(null);
  const [buildFailure, setBuildFailure] = useState<DemoFailure | null>(null);
  const [throttle, setThrottle] = useState<Throttle | null>(null);
  const [throttleOver, setThrottleOver] = useState(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The session ended or the account is not a demo account: the same two exits as the guard, for an answer that arrives later (G-03, guard 11).
  const readFailure = list.status === "error" ? list.failure : null;
  const readFailureKind = readFailure?.kind;
  useEffect(() => {
    if (readFailureKind === "session_ended") redirectToLogin(router, NEXT_PATH);
    else if (readFailureKind === "forbidden") router.replace("/today");
  }, [readFailureKind, router]);

  useEffect(() => {
    if (built !== null) builtHeadingRef.current?.focus();
  }, [built]);

  function fail(failure: DemoFailure) {
    switch (failure.kind) {
      case "session_ended":
        redirectToLogin(router, NEXT_PATH);
        return;
      case "forbidden":
        router.replace("/today");
        return;
      case "unknown_scenario":
        // The list changed under the learner: the choice is dropped and the list is read again (a read, so it is safe).
        setSelected(null);
        setBuildFailure(failure);
        reload();
        return;
      case "throttled":
        setThrottle({ retryAfterSec: failure.retryAfterSec, endsAt: performance.now() + failure.retryAfterSec * 1000 });
        setBuildFailure(failure);
        return;
      case "aborted":
        return;
      default:
        setBuildFailure(failure);
    }
  }

  async function build(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || throttle !== null || selected === null) return;
    inFlight.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBuildFailure(null);
    setThrottleOver(false);
    setBuilding(true);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_REQUEST_MS);
    try {
      const plan = await createDemoPlan(client, { scenarioId: selected }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // The form is replaced by the result, so a further press is impossible; the flag stays set.
      setBuilt(plan);
    } catch (error) {
      if (controller.signal.aborted) return;
      inFlight.current = false;
      fail(classifyDemoError(error));
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setBuilding(false);
    }
  }

  const offline = !online;
  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  const guardFailure = access.status === "failed" ? access.failure : null;
  const failure: DemoFailure | null = buildFailure ?? guardFailure ?? readFailure;
  const retryRead = buildFailure === null ? (guardFailure !== null ? recheck : reload) : undefined;

  // No answer to the press: the plan may exist, so the banner says to look before building another (P-10).
  const uncertain = buildFailure?.kind === "connectivity";
  const failureNode =
    failure === null ? null : uncertain ? (
      <div className="flex flex-col gap-q16">
        {offline ? <OfflineBanner /> : null}
        <Banner variant="warning" action={<TextLink href="/today">{text.failure.uncertainAction}</TextLink>}>
          <span className="[overflow-wrap:anywhere]">{text.failure.uncertain}</span>
        </Banner>
      </div>
    ) : (
      <div className="flex flex-col gap-q16">
        <DemoFailureBanner failure={failure} id={bannerId} online={online} waking={waking} onRetry={retryRead} onRefresh={reloadPage} />
        {buildFailure?.kind === "throttled" ? <Notice>{text.failure.dailyLimit}</Notice> : null}
      </div>
    );
  const alertFailure = failure !== null && !uncertain && isAlertDemoFailure(failure);

  const throttled = throttle !== null;
  const canBuild = selected !== null && !throttled;
  const helperText = selected === null ? text.chooseFirst : text.readyHelper;

  const checking = access.status === "checking" || access.status === "leaving" || (access.status === "allowed" && list.status === "loading");
  const scenarios = list.status === "ready" ? list.data : null;

  let body = null;
  if (built !== null) {
    const title = locale === "ar" ? built.titleAr : built.titleEn;
    body = (
      <section aria-labelledby={builtHeadingId} className="flex flex-col gap-q16">
        <h2 id={builtHeadingId} ref={builtHeadingRef} tabIndex={-1} className="text-section text-ink">
          {text.built.title}
        </h2>
        <Banner variant="success">
          <p className="[overflow-wrap:anywhere]">{built.planner.source === "teaching_agent" ? text.built.byPlanner : text.built.byRules}</p>
          <p className="mt-q4 [overflow-wrap:anywhere]">
            <bdi>{text.built.plan(title)}</bdi>
          </p>
        </Banner>
        <Button fullWidth onClick={() => router.replace("/today")}>
          {text.built.continue}
        </Button>
        <div>
          <TextLink href="/demo/simulations">{text.simulationsLink}</TextLink>
        </div>
      </section>
    );
  } else if (checking) {
    body = <DemoSkeleton loadingText={text.loading} />;
  } else if (scenarios !== null && scenarios.length === 0) {
    body = (
      <div className="flex flex-col gap-q8">
        <Banner variant="info" action={<TextLink href="/start">{text.empty.action}</TextLink>}>
          <span className="[overflow-wrap:anywhere]">{text.empty.text}</span>
        </Banner>
        <div>
          <TextLink href="/demo/simulations">{text.simulationsLink}</TextLink>
        </div>
      </div>
    );
  } else if (scenarios !== null) {
    body = (
      <form noValidate onSubmit={build} className="flex flex-col gap-q24">
        <ScenarioList legend={text.legend} locale={locale} scenarios={scenarios} selected={selected} onSelect={setSelected} busy={building} sectionCount={text.sectionCount} />
        <div>
          <Button type="submit" fullWidth loading={building} aria-disabled={!canBuild} aria-describedby={throttled ? bannerId : helperId}>
            {building ? text.building : text.build}
          </Button>
          <p id={helperId} className="mt-q8 text-small text-ink-secondary">
            {helperText}
          </p>
          {throttle !== null ? (
            <div className="mt-q8">
              <Countdown
                endsAt={throttle.endsAt}
                totalSeconds={throttle.retryAfterSec}
                onDone={() => {
                  setThrottle(null);
                  setBuildFailure(null);
                  setThrottleOver(true);
                }}
              />
            </div>
          ) : null}
        </div>
        <div>
          <TextLink href="/demo/simulations">{text.simulationsLink}</TextLink>
        </div>
      </form>
    );
  }

  return (
    <FocusShell title={text.screenName} actions={<LanguageSwitch />}>
      <div className="flex flex-col gap-q24">
        {/* Slot T: the note of S-04 when the recovery code was left unconfirmed, then what this screen is for and what it never sends. */}
        <RecoveryCodeUnavailableBanner />
        <div className="flex flex-col gap-q8">
          <p className="text-body text-ink-secondary">{text.intro}</p>
          <Notice>{text.privacyNote}</Notice>
        </div>
        <BannerSlot
          polite={
            <>
              {offline && !uncertain && failure === null ? <OfflineBanner /> : null}
              {alertFailure ? null : failureNode}
              {slow ? <p className="mt-q8 text-small text-ink-secondary">{messages.form.stillProcessing}</p> : null}
            </>
          }
          alert={alertFailure ? failureNode : null}
          announcement={
            <>
              {building ? <p>{text.buildingStatus}</p> : null}
              {reconnected && online ? <p>{messages.form.backOnline}</p> : null}
              {throttleOver ? <p>{messages.form.throttleOver}</p> : null}
            </>
          }
        />
        {body}
      </div>
    </FocusShell>
  );
}
