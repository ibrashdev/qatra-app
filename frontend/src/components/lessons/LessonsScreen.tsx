"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { LinkButton } from "@/components/progress/LinkButton";
import { FailureBanner } from "@/components/today/FailureBanner";
import { isAlertFailure, type TodayFailure } from "@/components/today/today-failure";
import { BannerSlot } from "@/components/ui/FormBanners";
import { Icon } from "@/components/ui/Icon";
import { PageTitle } from "@/components/ui/PageTitle";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { lessonsMessages, type LessonsMessages } from "@/i18n/lessons-messages";
import { todayMessages } from "@/i18n/today-messages";
import { useWakeUpState } from "@/lib/api/react";
import type { LessonSection } from "@/lib/api/types";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { LessonsFailure } from "./lessons-model";
import { useLessonsList } from "./use-lessons";

const SKELETON_DELAY_MS = 300; // UI-tokens 6.14

// The list shows a withdrawn edition (404) with the banner of G-20, like the other learner screens.
const asTodayFailure = (failure: LessonsFailure): TodayFailure => (failure.kind === "not_found" ? { kind: "revoked" } : failure);

// The lessons tab (D92, owner approval of 5 October 2026): the surahs or hadiths of the learner's own plan, to read. One card per section, in the plan's
// order, each a link to the reader. There is no question, no game, no score and no way into a session here; reading time counts toward the day (the
// reader sends it). An account without an active plan keeps the tab and is pointed to the start of one.
export function LessonsScreen() {
  const { locale, messages } = useLocale();
  const t = lessonsMessages(locale);
  const router = useRouter();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const { state, reload } = useLessonsList();
  const showSkeleton = useAfterDelay(SKELETON_DELAY_MS);
  const bannerId = useId();

  const failure: TodayFailure | null = state.status === "error" ? asTodayFailure(state.failure) : null;

  // G-03: the session ended. S-01 shows its banner once and brings the learner back here.
  useEffect(() => {
    if (failure?.kind === "session_ended") redirectToLogin(router, "/lessons");
  }, [failure?.kind, router]);

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
  const alertFailure = failure !== null && isAlertFailure(failure);
  const failureNode =
    failure === null ? null : <FailureBanner failure={failure} t={todayMessages(locale)} online={online} waking={waking} id={bannerId} onRetry={reload} onRefresh={reload} />;

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>

      <BannerSlot polite={alertFailure ? null : failureNode} alert={alertFailure ? failureNode : null} />

      {state.status === "loading" ? (
        <div aria-busy="true" className="mt-q24">
          <p role="status" className="sr-only">
            {messages.server.busy}
          </p>
          {showSkeleton ? (
            <div aria-hidden="true" className="flex flex-col gap-q24">
              <SkeletonBlock className="h-q24 w-4/5" />
              <div className="flex flex-col gap-q8">
                {[0, 1, 2].map((row) => (
                  <SkeletonBlock key={row} className="h-22 w-full" />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.status === "no_plan" ? (
        <div className="mt-q24 flex flex-col gap-q24">
          <p className="text-body-compact text-ink-secondary">{t.lead}</p>
          <EmptyState title={t.empty.title} text={t.empty.text} action={<LinkButton href="/start">{t.empty.action}</LinkButton>} />
        </div>
      ) : null}

      {state.status === "ready" ? (
        <div className="mt-q24 flex flex-col gap-q24">
          <p className="text-body-compact text-ink-secondary">{t.lead}</p>
          {state.lessons.sections.length === 0 ? (
            <EmptyState title={t.noSections.title} text={t.noSections.text} />
          ) : (
            <ul aria-label={t.listLabel} className="divide-y divide-divider overflow-hidden rounded-md border border-divider bg-surface">
              {state.lessons.sections.map((section) => (
                <SectionCard key={section.sectionId} section={section} t={t} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-start gap-q16 rounded-md border border-divider bg-surface p-q16">
      <Icon name="info" size="lg" className="text-info-edge" />
      <p className="text-section text-ink">{title}</p>
      <p className="text-body-compact text-ink-secondary">{text}</p>
      {action ?? null}
    </div>
  );
}

// A card is a link whose name is the reference the learner knows (the surah or the hadith title). A surah also says how many passages the plan holds of
// it; a hadith does not, because its passages are the paths one narration is read on, not separate lessons. The chevron points to the end edge in both
// directions, as the games rows do.
function SectionCard({ section, t }: { section: LessonSection; t: LessonsMessages }) {
  const nameId = useId();
  const descriptionId = useId();
  const described = section.kind === "surah";
  return (
    <li>
      <Link
        href={`/lessons/${section.sectionId}`}
        aria-labelledby={nameId}
        aria-describedby={described ? descriptionId : undefined}
        data-section={section.sectionId}
        className="flex min-h-22 w-full items-center gap-q12 px-q16 py-q12 text-start transition-[background-color] duration-(--q-duration-fast) hover:bg-selection focus-visible:outline-offset-[-2px]"
      >
        <span aria-hidden="true" className="flex size-target shrink-0 items-center justify-center rounded-sm bg-selection text-ink-accent">
          <Icon name="lessons" size="lg" />
        </span>
        <span className="min-w-0 flex-1">
          <span id={nameId} className="block text-body font-semibold text-ink">
            <bdi lang="ar">{section.referenceAr}</bdi>
          </span>
          {described ? (
            <span id={descriptionId} className="block text-small text-ink-secondary">
              {t.passages(section.passageCount)}
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="flex shrink-0 rotate-180 text-ink-secondary">
          <Icon name="back" size="md" />
        </span>
      </Link>
    </li>
  );
}
