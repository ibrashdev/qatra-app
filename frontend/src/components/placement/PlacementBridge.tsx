"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { BannerSlot, OfflineBanner, ServiceAlert, ThrottleBanner, UnavailableBanner } from "@/components/ui/FormBanners";
import { FocusShell } from "@/components/ui/FocusShell";
import { classifyChatError, type ChatFailure } from "@/components/plan-chat/failure";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { useLocale } from "@/i18n/LocaleProvider";
import { placementMessages } from "@/i18n/placement-messages";
import { useApiRuntime } from "@/lib/api/react";
import { reloadPage } from "@/lib/browser";
import { getStartSelection } from "@/lib/plan/start-selection";
import { useConnectivity } from "@/lib/net/use-connectivity";

// What the last press left behind. Connectivity is not here: the offline banner speaks for it, and the server wake-up status is the shell's.
type Result = { kind: "edition" } | { kind: "options" } | Extract<ChatFailure, { kind: "throttled" | "unavailable" | "origin" | "internal" }>;

function resultOf(failure: ChatFailure): Result | null {
  switch (failure.kind) {
    case "validation":
      return failure.rules.includes("edition_not_available") ? { kind: "edition" } : { kind: "options" };
    case "throttled":
    case "unavailable":
    case "origin":
    case "internal":
      return failure;
    case "connectivity":
    case "aborted":
    case "session_ended":
      return null;
    default:
      return { kind: "internal" };
  }
}

// Interim /placement: S-09 (the placement test) is deferred, so this page is only its approved skip path (UG-12). It opens the plan
// conversation (E31) without a placement session, from the selection S-08 left in memory. S-09 replaces this page.
export function PlacementBridge() {
  const router = useRouter();
  const { locale } = useLocale();
  const { api } = useApiRuntime();
  const { online } = useConnectivity();
  const text = placementMessages(locale);
  const bannerId = useId();
  const sending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // Guard 5 (UG-01): the selection lives in memory, so a reload or a direct visit goes back to S-08.
  useEffect(() => {
    if (getStartSelection() === null) router.replace("/start");
  }, [router]);

  // P-14: E31 creates a row, so it is never retried automatically; the button is the retry, and an extra press while it waits is ignored.
  async function proceed() {
    if (sending.current) return;
    const selection = getStartSelection();
    if (selection === null) {
      router.replace("/start");
      return;
    }
    sending.current = true;
    setResult(null);
    setSubmitting(true);
    let leaving = false;
    try {
      const chat = await api.createPlanChat({
        editionId: selection.editionId,
        targetScope: selection.targetScope,
        paths: selection.paths,
        sessionMinutes: selection.sessionMinutes,
        ...(selection.preferredDate === null ? {} : { preferredDate: selection.preferredDate }),
        goalText: selection.goalText,
        language: locale,
      });
      leaving = true;
      router.replace(`/plan/chat/${chat.chatId}`);
    } catch (error) {
      const failure = classifyChatError(error);
      if (failure.kind === "session_ended") redirectToLogin(router, "/start");
      else setResult(resultOf(failure));
    } finally {
      // On success the button keeps its loading state while the conversation opens.
      if (!leaving) {
        sending.current = false;
        setSubmitting(false);
      }
    }
  }

  const editOptions = (
    <Button variant="secondary" onClick={() => router.replace("/start")}>
      {text.editOptions}
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
    alertBanner = (
      <Banner variant="error" role="alert" action={editOptions}>
        {result.kind === "edition" ? text.editionUnavailable : text.conversationFailed}
      </Banner>
    );
  } else if (!offline && (result?.kind === "origin" || result?.kind === "internal")) {
    alertBanner = <ServiceAlert kind={result.kind} onReload={reloadPage} />;
  }

  return (
    <FocusShell
      title={text.title}
      back={{ destination: text.backDestination, href: "/start" }}
      actionBar={
        <div className="mx-auto w-full max-w-column">
          <Button fullWidth loading={submitting} onClick={() => void proceed()}>
            {submitting ? text.preparing : text.continue}
          </Button>
        </div>
      }
    >
      <p className="text-body text-ink">{text.notAvailable}</p>
      <BannerSlot polite={politeBanner} alert={alertBanner} announcement={submitting ? <p>{text.preparing}</p> : null} />
    </FocusShell>
  );
}
