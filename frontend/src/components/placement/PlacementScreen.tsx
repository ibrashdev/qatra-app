"use client";

import { useRouter } from "next/navigation";
import { useId, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { BannerSlot, OfflineBanner, ServiceAlert, ThrottleBanner, UnavailableBanner } from "@/components/ui/FormBanners";
import { FocusShell } from "@/components/ui/FocusShell";
import { TextButton } from "@/components/ui/TextButton";
import { useLocale } from "@/i18n/LocaleProvider";
import { placementMessages } from "@/i18n/placement-messages";
import { reloadPage } from "@/lib/browser";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { DoneStep, PlacementQuestionStep, RatingStep } from "./PlacementSteps";
import { showsCalmLine } from "./placement-model";
import { usePlacementRun } from "./use-placement-run";

// S-09, the short placement test (UI-screens S-09): the optional self-rating, up to 8 recall questions, then the done step, which opens the plan
// conversation with the placement session. «تخطي الاختبار» opens it without one at any step (UG-12). The selection S-08 left in memory is the input.
export function PlacementScreen() {
  const router = useRouter();
  const { locale } = useLocale();
  const { online } = useConnectivity();
  const t = placementMessages(locale);
  const bannerId = useId();
  const run = usePlacementRun();
  const { result } = run;

  const editOptions = (
    <Button variant="secondary" onClick={() => router.replace("/start")}>
      {t.editOptions}
    </Button>
  );
  const offline = !online;
  const politeBanner = offline ? (
    <OfflineBanner />
  ) : result?.kind === "throttled" ? (
    <ThrottleBanner id={bannerId} retryAfterSec={result.retryAfterSec} />
  ) : result?.kind === "unavailable" ? (
    <UnavailableBanner />
  ) : null;
  let alertBanner: ReactNode = null;
  if (!offline && (result?.kind === "edition" || result?.kind === "options")) {
    const message = result.kind === "edition" ? t.editionUnavailable : result.stage === "questions" ? t.questionsFailed : t.conversationFailed;
    alertBanner = (
      <Banner variant="error" role="alert" action={editOptions}>
        {message}
      </Banner>
    );
  } else if (!offline && (result?.kind === "origin" || result?.kind === "internal")) {
    alertBanner = <ServiceAlert kind={result.kind} onReload={reloadPage} />;
  }

  const last = run.phase === "question" && run.k === run.n;
  const stepText = run.phase === "question" ? t.progress(run.k, run.n, locale) : run.phase === "done" ? t.done.title : null;
  const announcement = run.opening ? t.preparing : run.creating ? t.creating : stepText;

  let actionBar: ReactNode;
  if (run.phase === "rating") {
    actionBar = (
      <Button fullWidth loading={run.creating} onClick={run.start}>
        {run.creating ? t.creating : t.start}
      </Button>
    );
  } else if (run.phase === "question") {
    actionBar = (
      <div className="flex flex-col gap-q8">
        <Button fullWidth loading={run.opening} onClick={run.next}>
          {run.opening ? t.preparing : last ? t.finish : t.next}
        </Button>
        <Button variant="secondary" fullWidth aria-disabled={run.busy || undefined} onClick={run.skipQuestion}>
          {t.skipQuestion}
        </Button>
      </div>
    );
  } else {
    actionBar = (
      <Button fullWidth loading={run.opening} onClick={run.proceed}>
        {run.opening ? t.preparing : t.continue}
      </Button>
    );
  }

  return (
    <FocusShell
      title={t.title}
      back={{ destination: t.backDestination, onClick: run.openLeave }}
      actions={
        <TextButton aria-disabled={run.busy || undefined} onClick={run.openSkip}>
          {t.skipTest}
        </TextButton>
      }
      actionBar={<div className="mx-auto w-full max-w-column">{actionBar}</div>}
    >
      {run.phase === "rating" ? <RatingStep value={run.rating} onChange={run.setRating} /> : null}
      {run.phase === "question" && run.question !== null ? (
        <PlacementQuestionStep
          question={run.question}
          k={run.k}
          n={run.n}
          textKind={run.textKind}
          answer={run.answer}
          onAnswerChange={run.setAnswer}
          error={run.error}
          disabled={run.opening}
          onSubmit={run.next}
          questionRef={run.questionRef}
        />
      ) : null}
      {run.phase === "done" ? <DoneStep calm={showsCalmLine(run.rating, run.verdicts)} /> : null}
      <BannerSlot polite={politeBanner} alert={alertBanner} announcement={announcement === null ? null : <p key={`${run.phase}:${run.k}:${announcement}`}>{announcement}</p>} />
      <Dialog open={run.dialog === "leave"} title={t.leave.title} primary={{ label: t.leave.stay, onPress: run.closeDialog }} secondary={{ label: t.leave.exit, onPress: run.confirmLeave }} onCancel={run.closeDialog}>
        {t.leave.body}
      </Dialog>
      <Dialog open={run.dialog === "skip"} title={t.skip.title} primary={{ label: t.skip.stay, onPress: run.closeDialog }} secondary={{ label: t.skip.confirm, onPress: run.confirmSkip }} onCancel={run.closeDialog}>
        {t.skip.body}
      </Dialog>
    </FocusShell>
  );
}
