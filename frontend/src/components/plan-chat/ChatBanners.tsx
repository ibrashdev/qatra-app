"use client";

import { useId } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { OfflineBanner, ServiceAlert, ThrottleBanner, UnavailableBanner } from "@/components/ui/FormBanners";
import { useLocale } from "@/i18n/LocaleProvider";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import { reloadPage } from "@/lib/browser";
import type { ChatFailure } from "./failure";
import type { ChatNotice } from "./use-plan-chat";

// The single banner of Slot T (UI-screens S-34 "States"; at most one at a time, none in an error tone for a conversation that works).
export function NoticeBanner({ notice, onStartOver, onRefresh }: { notice: ChatNotice; onStartOver: () => void; onRefresh: () => void }) {
  const { locale } = useLocale();
  const text = planChatMessages(locale);
  const throttleId = useId();
  switch (notice.kind) {
    case "stale":
      return <Banner variant="warning">{text.banners.stale}</Banner>;
    case "plan_moved":
      return (
        <Banner
          variant="warning"
          action={
            <Button variant="secondary" onClick={onStartOver}>
              {text.banners.startOver}
            </Button>
          }
        >
          {text.banners.planMoved}
        </Banner>
      );
    case "race":
      return (
        <Banner
          variant="warning"
          action={
            <Button variant="secondary" onClick={onRefresh}>
              {text.banners.refresh}
            </Button>
          }
        >
          {text.banners.race}
        </Banner>
      );
    case "not_active":
      return <Banner variant="warning">{text.banners.notActive}</Banner>;
    case "not_active_completed":
      return <Banner variant="warning">{text.banners.notActiveCompleted}</Banner>;
    case "throttled":
      return <ThrottleBanner id={throttleId} retryAfterSec={notice.retryAfterSec} />;
    case "unavailable":
      return <UnavailableBanner />;
    case "origin":
    case "internal":
      return <ServiceAlert kind={notice.kind} onReload={reloadPage} />;
  }
}

// What a failed first read of the conversation shows (P-04, P-05, P-06, P-07), with a retry: E33 is a read, so repeating it is safe.
export function LoadFailureBanner({ failure, offline, waking }: { failure: ChatFailure; offline: boolean; waking: boolean }) {
  const throttleId = useId();
  if (offline) return <OfflineBanner />;
  if (waking) return null; // the shell's wake-up status is already on the page
  switch (failure.kind) {
    case "throttled":
      return <ThrottleBanner id={throttleId} retryAfterSec={failure.retryAfterSec} />;
    case "origin":
      return <ServiceAlert kind="origin" onReload={reloadPage} />;
    case "internal":
    case "validation":
      return <ServiceAlert kind="internal" onReload={reloadPage} />;
    default:
      return <UnavailableBanner />;
  }
}
