"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { Button } from "@/components/ui/Button";
import { FocusShell } from "@/components/ui/FocusShell";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { sessionMessages } from "@/i18n/session-messages";
import { useWakeUpState } from "@/lib/api/react";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { routeBefore } from "@/lib/nav/route-history";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { OnlineQueueStatus } from "./durable-online-queue";
import { RevokedView, SessionFailureBanner } from "./SessionBanners";
import { SessionRun } from "./SessionRun";
import { useSessionLoad } from "./use-session-load";

const SKELETON_DELAY_MS = 300; // UI-tokens 6.14

// A session that could not be loaded holds no answers in this page; when the device already has some of it, they are saved there.
const HELD_ON_DEVICE: OnlineQueueStatus = { mode: "durable", storageProblem: false };

// S-19 at /session/[id] (UI-screens Batch 4): loads the daily session (E18, then E20 `daily`) and runs it. Before the snapshot is in, the screen is the focus
// shell with a skeleton or the reason it failed; a guard sends an id the server does not answer to back to Today.
export function SessionScreen({ routeId }: { routeId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { locale, messages } = useLocale();
  const t = sessionMessages(locale);
  const { online } = useConnectivity();
  const wake = useWakeUpState();
  const showSkeleton = useAfterDelay(SKELETON_DELAY_MS);
  const { state, reload } = useSessionLoad(routeId);
  // Read once, while the screen renders, before the tracker has seen this route: no earlier route means a reload or a direct visit.
  const [restarted] = useState(() => routeBefore(pathname) === null);

  const failureKind = state.status === "failed" ? state.failure.kind : null;

  // G-03 for the load; guard 8 and "no plan to run": Today.
  useEffect(() => {
    if (state.status === "leave") router.replace("/today");
    else if (failureKind === "session_ended") redirectToLogin(router, "/today");
  }, [state.status, failureKind, router]);

  if (state.status === "ready") {
    return (
      <SessionRun key={state.snapshot.sessionId} snapshot={state.snapshot} daily={state.daily} textKind={state.textKind} restarted={restarted} journal={state.journal} />
    );
  }

  const failure = state.status === "failed" ? state.failure : null;
  const held = state.status === "failed" && state.held;
  const waking = wake.phase === "waking" || wake.phase === "timed_out";

  return (
    <FocusShell title={t.title} back={{ destination: t.backDestination, href: "/today" }} offlineNotice={false}>
      <div role="status" aria-live="polite" className="has-[*]:mb-q16">
        {failure === null || failure.kind === "revoked" ? null : (
          <SessionFailureBanner failure={failure} online={online} waking={waking} onRetry={reload} onRefresh={reload} durability={held ? HELD_ON_DEVICE : null} />
        )}
      </div>

      {failure?.kind === "revoked" ? <RevokedView onBack={() => router.replace("/today")} /> : null}

      {failure === null ? (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            {messages.server.busy}
          </p>
          {showSkeleton ? (
            <div aria-hidden="true" className="flex flex-col gap-q24">
              <SkeletonBlock className="h-q48 w-full" />
              <SkeletonBlock className="h-q32 w-full" />
              <SkeletonBlock className="h-40 w-full" />
            </div>
          ) : null}
        </div>
      ) : failure.kind === "revoked" ? null : (
        <div className="flex flex-wrap gap-q12">
          <Button variant="secondary" onClick={() => router.replace("/today")}>
            {t.banners.backToToday}
          </Button>
        </div>
      )}
    </FocusShell>
  );
}
