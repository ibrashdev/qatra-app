"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { ApiError } from "@/lib/api/errors";
import type { DailyProgress, PlanSnapshot } from "@/lib/api/types";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { useHydrated } from "@/lib/dom/use-hydrated";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { listPendingEvents } from "@/lib/offline/outbox";
import { clearLocalCopy, repairOfflineStorage } from "@/lib/offline/owner";
import { getOfflineSyncController } from "@/lib/offline/sync";
import type { SyncTrigger } from "@/lib/offline/types";
import { OfflineChrome } from "./OfflineChrome";
import { OfflineHome } from "./OfflineHome";
import { learningDateOf, provisionalDaily, provisionalTodayMs, sessionEntries, type LocalRunSummary, type OfflineSessionEntry } from "./offline-model";
import { OfflineResult } from "./OfflineResult";
import { OfflineGameRun, OfflineSessionRun, type OfflineRunCallbacks } from "./offline-run";
import {
  IncompletePanel,
  LockedPanel,
  NoPlanPanel,
  OwnerMismatchPanel,
  SchemaPanel,
  SessionEndedBanner,
  StalePanel,
  StoragePanel,
  UnavailablePanel,
  UnsupportedPanel,
  WakingBanner,
} from "./StatusPanels";
import { SyncStatus } from "./SyncStatus";
import { UpdateNotice } from "./UpdateNotice";
import { outboxCountsOf, useLocalPlan, usePendingEvents, useShellReady, useSyncProgress } from "./use-offline-state";

// What the foreground check found. "stay": the server answered but the local view has its own reason to stay (locked, newer data than the app).
type ShellNet = "checking" | "ok" | "stay" | "offline" | "unreachable" | "unauthenticated" | "mismatch";

type ShellView =
  | { kind: "home" }
  | { kind: "run"; runKey: number; entry: OfflineSessionEntry; snapshot: PlanSnapshot; ownerId: string; daily: DailyProgress }
  | { kind: "result"; summary: LocalRunSummary };

const MAX_AUTO_RETRIES = 5; // a sync that stopped on a throttle or an outage is tried again by itself this many times, then the button is the way
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS = 30_000;
const BOOT_GRACE_MS = 1200; // how long a pending check holds the loading view before a ready local plan is shown
const SKELETON_DELAY_MS = 300; // UI-tokens 6.14

// S-31 at /offline (the PWA start_url). Public and prerendered; everything personal is read from IndexedDB after hydration, and nothing in it is a <Link> or
// a router transition (offline-spec 4.2). The state machine:
//   booting, then the foreground check (G-10): online and the account answers, sync, then replace to /today; 401 keeps the local copy and says so (G-03);
//   a waking server shows the G-01 line while the local day stays usable; offline or unreachable stays here and shows the local day, a run, or the
//   reason there is nothing to show (no plan, incomplete, stale, revoked, expired, locked, newer data than the app, a storage failure, another account's copy).
export function OfflineShell() {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const router = useRouter();
  const { api, wakeUp } = useApiRuntime();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const hydrated = useHydrated();
  const { inspection, refresh } = useLocalPlan();
  const progress = useSyncProgress();
  const shellReady = useShellReady();
  const showSkeleton = useAfterDelay(SKELETON_DELAY_MS);
  const bootGrace = useAfterDelay(BOOT_GRACE_MS);

  const [net, setNet] = useState<ShellNet>("checking");
  const [view, setView] = useState<ShellView>({ kind: "home" });
  const [clearing, setClearing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [now] = useState(() => Date.now());
  const launching = useRef(false);
  const retryTimer = useRef<number | null>(null);
  const retryAttempts = useRef(0);
  const launchAgain = useRef<(trigger: SyncTrigger) => Promise<void>>(async () => undefined);
  const redirected = useRef(false);
  const runCount = useRef(0);
  const sawOffline = useRef(false);

  const effectiveNet: ShellNet = online ? net : "offline";

  // A sync that stopped because the server throttled it or was out for a moment leaves answers on the device. The launcher does not move on to the online
  // app and forget them: it stays, shows the sync status with its button, and tries again by itself (the wait the server named, or a doubling one).
  const scheduleRetry = useCallback((retryAfterSec: number | null | undefined) => {
    if (retryAttempts.current >= MAX_AUTO_RETRIES) return;
    retryAttempts.current += 1;
    const wait = Math.max((retryAfterSec ?? 0) * 1000, Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (retryAttempts.current - 1)));
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      void launchAgain.current("manual");
    }, wait);
  }, []);

  // The foreground check of PWA-design 6 and G-10. With a local copy the sync does the waking, the account check, E25 and the replay itself; without one
  // (nothing to sync) the account is asked directly. Either way a 401 never wipes anything.
  const launch = useCallback(
    async (trigger: SyncTrigger) => {
      if (launching.current) return;
      launching.current = true;
      let next: ShellNet = "unreachable";
      try {
        const result = await getOfflineSyncController().run(trigger);
        switch (result.outcome) {
          case "unauthenticated":
            next = "unauthenticated";
            break;
          case "owner_mismatch":
            next = "mismatch";
            break;
          case "server_unreachable":
            next = "unreachable";
            break;
          case "offline":
            next = "offline";
            break;
          case "locked":
          case "schema_incompatible":
            next = "stay";
            break;
          case "completed":
            retryAttempts.current = 0;
            next = "ok";
            break;
          case "throttled":
          case "unavailable":
          case "failed":
          case "locked_elsewhere":
            next = "stay";
            scheduleRetry(result.retryAfterSec);
            break;
          default:
            // Nothing to sync, or a sync that stopped for a reason the server gave: the account is asked once, so the launcher still knows who is there.
            try {
              await api.me();
              next = "ok";
            } catch (error) {
              next = error instanceof ApiError && error.code === "unauthenticated" ? "unauthenticated" : "unreachable";
            }
        }
      } catch {
        next = "unreachable";
      } finally {
        launching.current = false;
      }
      setNet(next);
      void refresh();
    },
    [api, refresh, scheduleRetry],
  );
  useEffect(() => {
    launchAgain.current = launch;
  }, [launch]);
  useEffect(
    () => () => {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  // Online at open, and again whenever the browser reports the connection back. `navigator.onLine` is a hint: the check is a real request.
  useEffect(() => {
    if (!hydrated) return;
    if (!online) {
      sawOffline.current = true;
      return;
    }
    void launch(sawOffline.current ? "reconnect" : "app_open");
  }, [online, hydrated, launch]);

  const counts = outboxCountsOf(inspection);
  const snapshot = inspection?.status === "ready" ? inspection.snapshot : null;
  const ownerId = inspection?.owner?.ownerId ?? null;

  // The launcher: online and the account answers, then the online app. Postponed while a run is open; answers made in the meantime are synced first.
  useEffect(() => {
    if (effectiveNet !== "ok" || view.kind !== "home" || redirected.current || inspection === null) return;
    redirected.current = true;
    void (async () => {
      if (inspection.counts.queued > 0) await getOfflineSyncController().run("reconnect").catch(() => undefined);
      router.replace("/today");
    })();
  }, [effectiveNet, view.kind, inspection, router]);

  const events = usePendingEvents(ownerId, `${counts.queued}:${counts.pending}:${counts.blocked}`);
  const dailyToday = useMemo(
    () => (snapshot === null ? null : provisionalDaily(learningDateOf(now, snapshot.learningTimeZone), snapshot.dailyGoalMs, provisionalTodayMs(events, snapshot.learningTimeZone, now))),
    [snapshot, events, now],
  );
  const revalidation = inspection?.revalidation ?? null;
  const entries = useMemo(() => (snapshot === null ? [] : sessionEntries(snapshot, revalidation)), [snapshot, revalidation]);

  const callbacks = useMemo<OfflineRunCallbacks>(
    () => ({
      onFinished: (summary) => {
        setView({ kind: "result", summary });
        void refresh();
      },
      onLeave: () => {
        setView({ kind: "home" });
        void refresh();
      },
      onSessionEnded: () => {
        setNet("unauthenticated");
        setView({ kind: "home" });
      },
    }),
    [refresh],
  );

  async function start(entry: OfflineSessionEntry) {
    if (snapshot === null || ownerId === null) return;
    const pending = await listPendingEvents(ownerId).catch(() => []);
    const startedAt = Date.now();
    const daily = provisionalDaily(learningDateOf(startedAt, snapshot.learningTimeZone), snapshot.dailyGoalMs, provisionalTodayMs(pending, snapshot.learningTimeZone, startedAt));
    runCount.current += 1;
    setView({ kind: "run", runKey: runCount.current, entry, snapshot, ownerId, daily });
  }

  async function clearAndContinue() {
    setClearing(true);
    try {
      await clearLocalCopy();
      await refresh();
      setNet("ok");
    } finally {
      setClearing(false);
    }
  }

  async function repair() {
    setRepairing(true);
    try {
      await repairOfflineStorage();
    } finally {
      await refresh();
      setRepairing(false);
    }
  }

  // The learner's own press starts the automatic tries over.
  function pressSync() {
    retryAttempts.current = 0;
    void launch("manual");
  }

  function retryCheck() {
    wakeUp.retry();
    void launch("manual");
  }

  // ----- a run fills the screen with its own focus shell -----
  if (view.kind === "run") {
    const common = { ownerId: view.ownerId, snapshot: view.snapshot, session: view.entry.session, callbacks };
    return view.entry.kind === "daily" ? (
      <OfflineSessionRun key={view.runKey} {...common} daily={view.daily} />
    ) : (
      <OfflineGameRun key={view.runKey} {...common} gameType={view.entry.kind} />
    );
  }

  const waking =
    online && ((progress.phase === "waiting_server" && progress.waitedMs >= 1000) || ((wake.phase === "waking" || wake.phase === "timed_out") && effectiveNet !== "ok"));
  const timedOut = progress.timedOut || wake.phase === "timed_out";
  const connected = online && effectiveNet !== "unreachable";

  const booting = !hydrated || inspection === null || (effectiveNet === "checking" && !bootGrace);

  // The answers that wait on the device are shown under a plan that cannot run any more: they stay recorded, pending or not counted, and are never deleted
  // by a stale, revoked or expired plan (D59, G-06).
  const withOutbox = (panel: ReactNode): ReactNode => (
    <>
      {panel}
      {counts.total > 0 ? <SyncStatus counts={counts} progress={progress} onSync={pressSync} /> : null}
    </>
  );

  let body: ReactNode;
  if (booting) {
    body = (
      <div aria-busy="true">
        <p role="status" className="sr-only">
          {online && hydrated ? t.shell.launcherOpening : t.shell.booting}
        </p>
        {showSkeleton ? (
          <div aria-hidden="true" className="flex flex-col gap-q16">
            <SkeletonBlock className="h-q32 w-3/5" />
            <SkeletonBlock className="h-24 w-full" />
            <SkeletonBlock className="h-24 w-full" />
          </div>
        ) : null}
      </div>
    );
  } else if (effectiveNet === "mismatch") {
    body = <OwnerMismatchPanel onClear={() => void clearAndContinue()} clearing={clearing} />;
  } else if (view.kind === "result") {
    body = <OfflineResult summary={view.summary} onBack={() => setView({ kind: "home" })} />;
  } else {
    switch (inspection.status) {
      case "ready":
        body =
          snapshot !== null && dailyToday !== null ? (
            <OfflineHome
              snapshot={snapshot}
              daily={dailyToday}
              entries={entries}
              counts={counts}
              progress={progress}
              connected={connected}
              shellReady={shellReady}
              blocked={false}
              onStart={(entry) => void start(entry)}
              onSync={pressSync}
              onCleared={() => void refresh()}
            />
          ) : null;
        break;
      case "stale":
        body = withOutbox(<StalePanel />);
        break;
      case "revoked":
      case "expired":
        body = withOutbox(<UnavailablePanel expired={inspection.status === "expired"} />);
        break;
      case "locked":
        body = <LockedPanel onRepair={() => void repair()} repairing={repairing} />;
        break;
      case "schema_incompatible":
        body = <SchemaPanel />;
        break;
      case "storage_error":
        body = <StoragePanel onRetry={() => void refresh()} />;
        break;
      default:
        body = inspection.failureCode === "unsupported" ? <UnsupportedPanel /> : inspection.status === "incomplete" ? <IncompletePanel /> : <NoPlanPanel />;
    }
  }

  return (
    <OfflineChrome title={t.shell.screenName}>
      {/* The polite region stays in the page while empty, so a banner added later is announced. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-q12 empty:hidden">
        {effectiveNet === "unauthenticated" ? <SessionEndedBanner /> : null}
        {waking ? <WakingBanner timedOut={timedOut} onRetry={retryCheck} /> : null}
      </div>
      <UpdateNotice />
      {body}
    </OfflineChrome>
  );
}
