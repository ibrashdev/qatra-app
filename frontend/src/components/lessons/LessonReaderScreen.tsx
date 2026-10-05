"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { LinkButton } from "@/components/progress/LinkButton";
import { FailureBanner } from "@/components/today/FailureBanner";
import type { TodayFailure } from "@/components/today/today-failure";
import { Icon } from "@/components/ui/Icon";
import { FocusShell } from "@/components/ui/FocusShell";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { lessonsMessages } from "@/i18n/lessons-messages";
import { todayMessages } from "@/i18n/today-messages";
import { useWakeUpState } from "@/lib/api/react";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { parseSectionId, type LessonsFailure } from "./lessons-model";
import { PassageReader } from "./PassageReader";
import { useLessonSection } from "./use-lessons";
import { useReadingActivity } from "./use-reading-activity";

const SKELETON_DELAY_MS = 300; // UI-tokens 6.14

const asTodayFailure = (failure: LessonsFailure): TodayFailure => (failure.kind === "not_found" ? { kind: "revoked" } : failure);

// The reader of one section (D92): a focus screen, so no tab bar and no rail, with a back control to the list. It shows the text read only and credits the
// time on screen to today's daily session (use-reading-activity.ts). The title is the surah or the hadith, once the section is in.
export function LessonReaderScreen({ rawId }: { rawId: string }) {
  const { locale, messages } = useLocale();
  const t = lessonsMessages(locale);
  const router = useRouter();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const sectionId = parseSectionId(rawId);
  const { state, reload } = useLessonSection(sectionId);
  const showSkeleton = useAfterDelay(SKELETON_DELAY_MS);
  const bannerId = useId();

  useReadingActivity(state.status === "ready");

  const failure: TodayFailure | null = state.status === "error" ? asTodayFailure(state.failure) : null;

  // G-03: the session ended. S-01 shows its banner once and brings the learner back to this section.
  useEffect(() => {
    if (failure?.kind === "session_ended") redirectToLogin(router, `/lessons/${rawId}`);
  }, [failure?.kind, router, rawId]);

  // P-04: a read that failed while the server was waking is sent again once health answers, once per wake-up.
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
  const title = state.status === "ready" ? state.detail.referenceAr : t.screenName;

  return (
    <FocusShell title={title} back={{ destination: t.screenName, href: "/lessons" }}>
      <div role="status" aria-live="polite" className="has-[*]:mb-q16">
        {failure === null ? null : <FailureBanner failure={failure} t={todayMessages(locale)} online={online} waking={waking} id={bannerId} onRetry={reload} onRefresh={reload} />}
      </div>

      {state.status === "loading" ? (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            {messages.server.busy}
          </p>
          {showSkeleton ? (
            <div aria-hidden="true" className="flex flex-col gap-q24">
              <SkeletonBlock className="h-40 w-full" />
              <SkeletonBlock className="h-q24 w-3/5" />
            </div>
          ) : null}
        </div>
      ) : null}

      {state.status === "out_of_plan" ? (
        <div role="status" className="flex flex-col items-start gap-q16 rounded-md border border-divider bg-surface p-q16">
          <Icon name="info" size="lg" className="text-info-edge" />
          <p className="text-section text-ink">{t.reader.outOfPlan.title}</p>
          <p className="text-body-compact text-ink-secondary">{t.reader.outOfPlan.text}</p>
          <LinkButton href="/lessons">{t.reader.outOfPlan.action}</LinkButton>
        </div>
      ) : null}

      {state.status === "ready" ? <PassageReader detail={state.detail} /> : null}
    </FocusShell>
  );
}
