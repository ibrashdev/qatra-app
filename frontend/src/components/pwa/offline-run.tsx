"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoundRun } from "@/components/games/RoundRun";
import { roundQuestions, type GameRound } from "@/components/games/game-model";
import type { FlushResult, ResponseHandler } from "@/components/session/event-queue";
import type { RunBackend, RunQueue } from "@/components/session/run-backend";
import { SessionRun } from "@/components/session/SessionRun";
import { freezeDeep } from "@/components/session/session-model";
import { Button } from "@/components/ui/Button";
import { FocusShell } from "@/components/ui/FocusShell";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import type { DailyProgress, GameKind, PlanSnapshot, SessionEvent, SessionSnapshot } from "@/lib/api/types";
import { EnvelopeStamper } from "@/lib/offline/envelope";
import { enqueueEvent } from "@/lib/offline/outbox";
import { finishRun, startRun } from "@/lib/offline/run-store";
import type { EnvelopedEvent } from "@/lib/offline/types";
import { holdRunLock } from "@/lib/pwa/update";
import { questionsOfSession, snapshotTextKind, summarizeRun, type LocalRunSummary } from "./offline-model";

// The seam of an offline run (offline-spec 4.4): the same SessionRun and RoundRun screens as online, with a backend that keeps every answer in IndexedDB
// before the screen shows it as checked, stamps each event with the replay envelope even while the device is online (the server rejects an un-enveloped
// event on a prepared session), ends the run on the device with a provisional summary and leaves into the shell instead of the router.

type Store = (ownerId: string, sessionId: string, event: EnvelopedEvent) => Promise<unknown>;

// The durable twin of SessionEventQueue. Its enqueue resolves when the event is committed; a screen shows no feedback before that. Nothing is sent from a run:
// the foreground sync replays the outbox, so `flush` only waits for the writes still in flight and the queue never "waits to be sent" (size stays 0).
export class DurableRunQueue implements RunQueue {
  readonly size = 0;
  private readonly inflight = new Set<Promise<void>>();
  // The events committed by this run, as stamped, for the local summary.
  readonly committed: EnvelopedEvent[] = [];

  constructor(
    private readonly ownerId: string,
    private readonly sessionId: string,
    private readonly stamper: EnvelopeStamper,
    private readonly store: Store = enqueueEvent,
  ) {}

  // An offline run is never answered by the server, so no handler is ever called.
  setResponseHandler(handler: ResponseHandler): void {
    void handler;
  }

  enqueue(event: SessionEvent): Promise<void> {
    // The sequence is handed out here, in call order, so events keep their order whatever the order the writes finish in.
    const stamped = this.stamper.stamp(event);
    const write = this.store(this.ownerId, this.sessionId, stamped).then(() => {
      this.committed.push(stamped);
    });
    const tracked = write.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(tracked);
    void tracked.then(() => this.inflight.delete(tracked));
    return write;
  }

  // A write that failed was already shown by whoever enqueued it, so a flush only waits for the settled state.
  async flush(): Promise<FlushResult> {
    await Promise.all([...this.inflight]);
    return { ok: true };
  }
}

export interface OfflineRunCallbacks {
  // The run ended after its last step. The shell closes the run view and shows the summary.
  onFinished: (summary: LocalRunSummary) => void;
  // The learner left (or there is nothing to run): back to the sessions.
  onLeave: () => void;
  // E21, E22 or another call answered 401 during the run: the shell shows the G-03 line.
  onSessionEnded: () => void;
}

interface Started {
  queue: DurableRunQueue;
  clientRunId: string;
}

// Starts the run record, makes the queue, holds the run lock (so another tab and the update flow know a run is active) and builds the backend that the run
// hooks read. The record is made once per mount even where React runs an effect twice.
export function useOfflineRunBackend({
  ownerId,
  snapshot,
  session,
  kind,
  callbacks,
}: {
  ownerId: string;
  snapshot: PlanSnapshot;
  session: SessionSnapshot;
  kind: "daily" | "game";
  callbacks: OfflineRunCallbacks;
}): { backend: RunBackend | null; failed: boolean } {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const [started, setStarted] = useState<Started | null>(null);
  const [failed, setFailed] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const startPromise = useRef<Promise<Started> | null>(null);
  const callbackRef = useRef(callbacks);
  useEffect(() => {
    callbackRef.current = callbacks;
  });

  useEffect(() => {
    let cancelled = false;
    startPromise.current ??= startRun(ownerId, { snapshotId: snapshot.snapshotId, sessionId: session.sessionId, kind }).then((run) => ({
      clientRunId: run.clientRunId,
      queue: new DurableRunQueue(ownerId, session.sessionId, new EnvelopeStamper(snapshot, run.clientRunId, run.nextLocalSequence)),
    }));
    startPromise.current.then(
      (value) => {
        if (!cancelled) setStarted(value);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ownerId, snapshot, session.sessionId, kind]);

  // While a run is open no other tab and no update replaces the page under it (PWA-design 8). The lock is released with the page.
  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    holdRunLock().then(
      (value) => {
        if (cancelled) value();
        else release = value;
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      release?.();
    };
  }, []);

  const questions = useMemo(() => questionsOfSession(session), [session]);

  const close = useCallback(
    async (status: "finished" | "abandoned") => {
      if (started === null) return;
      // A failed close must not lose the answers, which are already committed: the record only says the run is over.
      await finishRun(ownerId, started.clientRunId, status).catch(() => undefined);
    },
    [ownerId, started],
  );

  const reportStorageFailure = useCallback((error: unknown) => {
    void error;
    setStorageFailed(true);
  }, []);

  const backend = useMemo<RunBackend | null>(() => {
    if (started === null) return null;
    return {
      queue: started.queue,
      banner: storageFailed ? { variant: "warning", text: t.run.storageFailed } : { variant: "info", text: t.shell.offlinePending },
      finish: async () => {
        const summary = summarizeRun(started.queue.committed, questions);
        await close("finished");
        callbackRef.current.onFinished(summary);
      },
      leave: () => {
        void close("abandoned");
        callbackRef.current.onLeave();
      },
      sessionEnded: () => callbackRef.current.onSessionEnded(),
      storageFailed: reportStorageFailure,
    };
  }, [started, storageFailed, t, questions, close, reportStorageFailure]);

  return { backend, failed };
}

function RunStarting({ failed, onLeave }: { failed: boolean; onLeave: () => void }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  return (
    <FocusShell title={t.shell.screenName}>
      {failed ? (
        <div role="alert" className="flex flex-col items-start gap-q16 rounded-md border border-divider bg-surface p-q16">
          <p className="text-body text-ink">{t.run.startFailed}</p>
          <Button variant="secondary" onClick={onLeave}>
            {t.result.back}
          </Button>
        </div>
      ) : (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            {t.run.starting}
          </p>
          <div aria-hidden="true" className="flex flex-col gap-q24">
            <SkeletonBlock className="h-q48 w-full" />
            <SkeletonBlock className="h-q32 w-full" />
            <SkeletonBlock className="h-40 w-full" />
          </div>
        </div>
      )}
    </FocusShell>
  );
}

// The prepared daily descriptor (learn steps, questions, the test) in the S-19 screen.
export function OfflineSessionRun({
  ownerId,
  snapshot,
  session,
  daily,
  callbacks,
}: {
  ownerId: string;
  snapshot: PlanSnapshot;
  session: SessionSnapshot;
  daily: DailyProgress;
  callbacks: OfflineRunCallbacks;
}) {
  const frozen = useMemo(() => freezeDeep(structuredClone(session)), [session]);
  const textKind = useMemo(() => snapshotTextKind(snapshot), [snapshot]);
  const { backend, failed } = useOfflineRunBackend({ ownerId, snapshot, session, kind: "daily", callbacks });
  if (backend === null) return <RunStarting failed={failed} onLeave={callbacks.onLeave} />;
  return <SessionRun snapshot={frozen} daily={daily} textKind={textKind} restarted={false} backend={backend} />;
}

const NO_REPLAY = { status: "idle" } as const;
const NOOP = (): void => undefined;

// A prepared game descriptor in the round screen of its template. There is no replay and no plan refresh offline: a repeat is the same descriptor started again
// from the list, with a new run id (G-02).
export function OfflineGameRun({
  ownerId,
  snapshot,
  session,
  gameType,
  callbacks,
}: {
  ownerId: string;
  snapshot: PlanSnapshot;
  session: SessionSnapshot;
  gameType: GameKind;
  callbacks: OfflineRunCallbacks;
}) {
  const frozen = useMemo(() => freezeDeep(structuredClone(session)), [session]);
  const round = useMemo<GameRound>(
    () => ({ snapshot: frozen, gameType, plan: { planId: snapshot.planId, planVersion: snapshot.planVersion }, textKind: snapshotTextKind(snapshot) }),
    [frozen, gameType, snapshot],
  );
  const questions = useMemo(() => roundQuestions(frozen), [frozen]);
  const { backend, failed } = useOfflineRunBackend({ ownerId, snapshot, session, kind: "game", callbacks });
  if (backend === null) return <RunStarting failed={failed} onLeave={callbacks.onLeave} />;
  return <RoundRun key={session.sessionId} round={round} questions={questions} replay={NO_REPLAY} onPlayAgain={NOOP} onRefreshPlan={NOOP} backend={backend} />;
}
