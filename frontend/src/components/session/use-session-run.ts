"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { finalizeAnswer, validateAnswer, type HintEffect, type QuestionError, type QuestionResult, type QuestionViewHandle } from "@/components/questions";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { useApiRuntime } from "@/lib/api/react";
import { completeSession, postSessionEvents } from "@/lib/api/session-endpoints";
import type { AnswerPayload, DailyProgress, EventsResponse, SessionEvent, SessionSnapshot } from "@/lib/api/types";
import { holdSessionResult } from "@/lib/session/result-handoff";
import type { OnlineAnswered, OnlineRunRecord } from "@/lib/offline/types";
import { DurableOnlineQueue, resolveOnlineBinding, type OnlineQueueStatus, type SessionJournal } from "./durable-online-queue";
import type { FlushResult } from "./event-queue";
import { gradeLocally } from "./local-grade";
import { clearResume, rememberResume } from "./resume-store";
import { isPromiseLike, type RunBackend, type RunQueue } from "./run-backend";
import { activityEvent, answerEvent, newEventId } from "./session-events";
import { classifySessionError, FINISH_PENDING, leavesFinishPending, retriesByItself, type FinishPending, type SessionFailure } from "./session-failure";
import { firstIndexFrom, nextStep, primaryAction, recallTarget, type PrimaryAction } from "./session-model";
import { useActivityClock } from "./use-activity";
import { useBackGuard } from "./use-back-guard";
import { useOnlineQueueStatus, useOnlineRunLock } from "./use-online-run-lock";

export interface Draft {
  answer: AnswerPayload | null;
  hint: HintEffect | null;
  error: QuestionError | null;
}

const EMPTY_DRAFT: Draft = { answer: null, hint: null, error: null };

export interface AnsweredQuestion {
  clientEventId: string;
  hintUsed: boolean;
  result: QuestionResult;
}

// "inactive": the plan or the session no longer takes events (a Warning banner). "revoked": the edition was withdrawn, so no text is shown (G-20).
export type Ended = "inactive" | "revoked" | null;

export type SheetState = { open: false } | { open: true; status: "idle" | "saving" | "failed" };

export interface SessionRunInput {
  snapshot: SessionSnapshot;
  initialDaily: DailyProgress;
  resumeAt: number | null;
  // The offline shell passes a backend (durable enveloped outbox, local finish, shell navigation). Online it is absent: the run then keeps its answers in the
  // online journal (PWA-design 4), and a reload finds them again through `journal`.
  backend?: RunBackend;
  // What the journal holds for this session, read next to E18: the run state (resume step, answers given, a finish that is owed) and the events that were
  // never acknowledged. Absent when there is nothing to restore (the first visit, no storage, the offline shell).
  journal?: SessionJournal;
}

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;

// The answers a reload restores, as the screen holds them: what the server said about each one before the page went away. Never the typed answer.
function answersOf(run: OnlineRunRecord | null): Record<string, AnsweredQuestion> {
  const restored: Record<string, AnsweredQuestion> = {};
  if (run === null) return restored;
  for (const [questionId, entry] of Object.entries(run.answered)) {
    restored[questionId] = {
      clientEventId: entry.clientEventId,
      hintUsed: entry.hintUsed,
      result: { correct: entry.result.correct, assisted: entry.result.assisted, expected: entry.result.expected, ...(entry.result.status === undefined ? {} : { status: entry.result.status }), ...(entry.result.updated === undefined ? {} : { updated: entry.result.updated }) },
    };
  }
  return restored;
}

// The reverse: what the journal keeps of the answers given so far.
function journalAnswers(answered: Readonly<Record<string, AnsweredQuestion>>): Record<string, OnlineAnswered> {
  const kept: Record<string, OnlineAnswered> = {};
  for (const [questionId, entry] of Object.entries(answered)) kept[questionId] = { clientEventId: entry.clientEventId, hintUsed: entry.hintUsed, result: entry.result };
  return kept;
}

export interface SessionRun {
  index: number | null;
  action: PrimaryAction | null;
  checked: boolean;
  draft: Draft;
  answered: Readonly<Record<string, AnsweredQuestion>>;
  streaks: Readonly<Record<string, number>>;
  hidden: boolean;
  skippedNotice: boolean;
  daily: DailyProgress;
  goalNote: boolean;
  ended: Ended;
  sheet: SheetState;
  sync: SessionFailure | null;
  finishing: boolean;
  // `finish_pending` is not a failure: the finish is recorded on the device and will be confirmed when the connection is back.
  finishFailure: SessionFailure | FinishPending | null;
  // Where the answers of this run live (the online journal, or this page only). Null for the offline shell, whose backend speaks for itself.
  durability: OnlineQueueStatus | null;
  announcement: { key: number; text: string } | null;
  questionRef: RefObject<QuestionViewHandle | null>;
  setAnswer: (answer: AnswerPayload | null) => void;
  noteHint: (effect: HintEffect) => void;
  toggleText: (labels: { hidden: string; shown: string }) => void;
  press: () => void;
  retrySync: () => void;
  openSheet: () => void;
  closeSheet: () => void;
  leave: () => void;
  retrySheet: () => void;
  goToday: () => void;
}

// The runtime of S-19: the step machine, the answers and their first verdict, the outbox of events, the active time, the finish and the pause.
// The snapshot is only read. The server's answers are authoritative: `daily` and each result replace the local figures.
export function useSessionRun({ snapshot, initialDaily, resumeAt, backend, journal }: SessionRunInput): SessionRun {
  const router = useRouter();
  const { api, client } = useApiRuntime();
  const steps = snapshot.steps;
  const sessionId = snapshot.sessionId;
  // The journal is for the online run only: the offline shell has its own durable outbox and its own run records.
  const restored = backend === undefined ? (journal?.run ?? null) : null;

  const [index, setIndex] = useState<number | null>(() => firstIndexFrom(steps, resumeAt ?? 0));
  const [answered, setAnswered] = useState<Record<string, AnsweredQuestion>>(() => answersOf(restored));
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [hidden, setHidden] = useState(false);
  const [skippedNotice, setSkippedNotice] = useState(false);
  const [daily, setDaily] = useState<DailyProgress>(initialDaily);
  const [goalNote, setGoalNote] = useState(false);
  const [streaks, setStreaks] = useState<Record<string, number>>({});
  const [ended, setEnded] = useState<Ended>(null);
  const [sheet, setSheet] = useState<SheetState>({ open: false });
  const [sync, setSync] = useState<SessionFailure | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishFailure, setFinishFailure] = useState<SessionFailure | FinishPending | null>(null);
  const [announcement, setAnnouncement] = useState<{ key: number; text: string } | null>(null);
  // The key of the finish when nothing could be recorded on the device: the same one for every retry of this page. With the journal the stored key wins.
  const [idempotencyKey] = useState(newEventId);

  const questionRef = useRef<QuestionViewHandle>(null);
  const mounted = useRef(true);
  // The question an event belongs to, so a verdict that comes back by event id lands on its question. A restored answer keeps its id.
  const [eventQuestion] = useState(() => new Map(Object.entries(answersOf(restored)).map(([questionId, entry]) => [entry.clientEventId, questionId] as const)));
  const shownAt = useRef(0);
  const goalWasReached = useRef(initialDaily.dailyCompleted);
  const finishingNow = useRef(false);
  const attempts = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const announcementKey = useRef(0);
  const flushAgain = useRef<() => void>(() => undefined);
  // The backend's methods are read when they run, so a changing banner never re-creates the callbacks below.
  const backendRef = useRef(backend);
  useEffect(() => {
    backendRef.current = backend;
  });
  const storing = useRef(false);

  // The offline shell brings its own durable queue. An ordinary online session writes every answer to the online journal before it counts it (PWA-design 4),
  // and takes back the events of an earlier page that were never acknowledged; where the device cannot hold them the queue is the old page-memory one.
  const [wiring] = useState<{ queue: RunQueue; online: DurableOnlineQueue | null }>(() => {
    if (backend !== undefined) return { queue: backend.queue, online: null };
    const online = new DurableOnlineQueue({
      sessionId,
      kind: "daily",
      send: (events: SessionEvent[]) => postSessionEvents(client, sessionId, events),
      resolveBinding: () => resolveOnlineBinding(api),
    });
    online.restore(journal?.queued ?? []);
    return { queue: online, online };
  });
  const { queue, online } = wiring;
  const durability = useOnlineQueueStatus(online);
  // The foreground sync leaves this session to this tab while the lock is held.
  useOnlineRunLock(sessionId, online !== null);
  useEffect(() => {
    void online?.start();
  }, [online]);

  const announce = useCallback((text: string) => {
    announcementKey.current += 1;
    setAnnouncement({ key: announcementKey.current, text });
  }, []);

  const goToday = useCallback(() => {
    const offline = backendRef.current;
    if (offline !== undefined) offline.leave();
    else router.replace("/today");
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    shownAt.current = Date.now();
    const timers = retryTimer;
    return () => {
      mounted.current = false;
      if (timers.current !== null) window.clearTimeout(timers.current);
    };
  }, []);

  // The answer of E21: the figures of the day and the verdicts of the server replace the local ones.
  useEffect(() => {
    queue.setResponseHandler((response: EventsResponse) => {
      setDaily(response.daily);
      if (response.daily.dailyCompleted && !goalWasReached.current) setGoalNote(true);
      goalWasReached.current = response.daily.dailyCompleted;

      if (response.results.length > 0) {
        setStreaks((previous) => {
          const next = { ...previous };
          for (const result of response.results) next[result.passage.passageId] = result.passage.consecutiveCorrect;
          return next;
        });
      }

      const statusOf = new Map<string, "rejected" | "pending">();
      let endedNow: Ended = null;
      for (const entry of response.rejected) {
        if (entry.code === "edition_mismatch") endedNow = "revoked";
        else if ((entry.code === "plan_not_active" || entry.code === "session_closed") && endedNow === null) endedNow = "inactive";
        statusOf.set(entry.clientEventId, "rejected");
      }
      for (const entry of response.pending) statusOf.set(entry.clientEventId, "pending");
      if (endedNow !== null) setEnded(endedNow);

      if (response.results.length > 0 || statusOf.size > 0) {
        setAnswered((previous) => {
          const next = { ...previous };
          for (const result of response.results) {
            const existing = next[result.questionId];
            if (existing === undefined || existing.clientEventId !== result.clientEventId) continue;
            const changed = existing.result.correct !== result.correct || existing.result.assisted !== result.assisted;
            next[result.questionId] = {
              ...existing,
              result: { ...existing.result, correct: result.correct, assisted: result.assisted, expected: result.expected, ...(changed ? { updated: true } : {}) },
            };
          }
          for (const [clientEventId, status] of statusOf) {
            const questionId = eventQuestion.get(clientEventId);
            const existing = questionId === undefined ? undefined : next[questionId];
            if (questionId !== undefined && existing !== undefined) next[questionId] = { ...existing, result: { ...existing.result, status } };
          }
          return next;
        });
      }
    });
  }, [queue, eventQuestion]);

  const handleFailure = useCallback(
    (error: unknown): SessionFailure | null => {
      const failure = classifySessionError(error);
      if (failure.kind === "aborted") return null;
      if (failure.kind === "session_ended") {
        const offline = backendRef.current;
        if (offline !== undefined) offline.sessionEnded();
        else redirectToLogin(router, "/today");
        return null;
      }
      if (failure.kind === "not_found") {
        goToday();
        return null;
      }
      return failure;
    },
    [router, goToday],
  );

  const runFlush = useCallback(async (): Promise<FlushResult> => {
    const result = await queue.flush();
    if (!mounted.current) return result;
    if (result.ok) {
      attempts.current = 0;
      setSync(null);
      return result;
    }
    const failure = handleFailure(result.error);
    if (failure === null) return result;
    setSync(failure);
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    let delay: number | null = null;
    if (failure.kind === "throttled") delay = failure.retryAfterSec * 1000;
    else if (retriesByItself(failure)) delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempts.current);
    attempts.current += 1;
    if (delay !== null) {
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        flushAgain.current();
      }, delay);
    }
    return result;
  }, [queue, handleFailure]);

  useEffect(() => {
    flushAgain.current = () => void runFlush();
  }, [runFlush]);

  // Active time: queued as it ends, sent at once (a hide, a cut and the pause all flush).
  const activity = useActivityClock({
    running: index !== null && !sheet.open && !finishing && ended !== "revoked",
    onInterval: (startedAtMs, endedAtMs) => {
      const event = activityEvent(startedAtMs, endedAtMs);
      if (event === null) return;
      const stored = queue.enqueue(event);
      // A durable queue settles when the interval is committed; a failed write is the backend's to show, and the interval is lost with it.
      if (isPromiseLike(stored)) stored.catch((error: unknown) => backendRef.current?.storageFailed(error));
      void runFlush();
    },
  });

  // The connection is back: resend what waits, and send a finish that was left for later with the same key.
  const finishAgain = useRef<() => void>(() => undefined);
  const finishIsPending = useRef(false);
  useEffect(() => {
    const onOnline = () => {
      if (queue.size > 0) flushAgain.current();
      if (finishIsPending.current) finishAgain.current();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [queue]);
  useEffect(() => {
    finishIsPending.current = finishFailure?.kind === "finish_pending";
  }, [finishFailure]);

  // What the events that an earlier page left in the journal need: they go out again with their own ids (the server answers `duplicate` for any it has).
  useEffect(() => {
    if ((journal?.queued.length ?? 0) > 0 && backend === undefined) flushAgain.current();
    // Only once, when the run opens: `journal` is the page's own snapshot of the journal and never changes while the run is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = index === null ? null : (steps[index] ?? null);
  const answeredHere = current?.type === "question" ? answered[current.question.questionId] : undefined;
  const checked = answeredHere !== undefined;
  const action = index === null ? null : primaryAction(steps, index, checked);

  const focusPrimary = useCallback(() => {
    window.setTimeout(() => document.querySelector<HTMLElement>("[data-session-primary]")?.focus(), 0);
  }, []);

  const finish = useCallback(async () => {
    if (finishingNow.current) return;
    finishingNow.current = true;
    setFinishing(true);
    setFinishFailure(null);
    activity.close();
    // An online session records the finish on the device BEFORE it sends anything: from here on the finish is owed to the server, and every attempt, from this
    // page or after a reload, sends the identical Idempotency-Key. Where nothing can be recorded the page's own key serves, as before.
    let key = idempotencyKey;
    let owed = false;
    if (online !== null) {
      const requested = await online.requestCompletion(idempotencyKey);
      if (!mounted.current) return;
      key = requested.key;
      owed = requested.durable;
    }
    const flushed = await queue.flush();
    if (!mounted.current) return;
    const fail = (error: unknown) => {
      const failure = handleFailure(error);
      finishingNow.current = false;
      setFinishing(false);
      if (failure === null) return;
      // The finish is recorded on the device: a connection that is gone, or a free server that is not answering, only means the result comes later.
      setFinishFailure(owed && leavesFinishPending(failure) ? FINISH_PENDING : failure);
    };
    if (!flushed.ok) {
      fail(flushed.error);
      return;
    }
    setSync(null);
    try {
      const offline = backendRef.current;
      if (offline !== undefined) {
        // G-03: no E22 for a prepared descriptor. The shell closes the run on the device and shows the local, provisional summary.
        await offline.finish();
        clearResume(sessionId);
        return;
      }
      const complete = await completeSession(client, sessionId, { idempotencyKey: key });
      if (!mounted.current) return;
      // The server holds the finished session: what was owed is settled, and only now does the confirmed result open.
      if (owed) await online?.confirmCompletion();
      holdSessionResult({ sessionId, complete });
      clearResume(sessionId);
      // The button keeps its loading state while the result screen opens.
      router.push(`/session/${encodeURIComponent(sessionId)}/result`);
    } catch (error) {
      if (mounted.current) fail(error);
    }
  }, [activity, queue, online, client, sessionId, idempotencyKey, router, handleFailure]);

  useEffect(() => {
    finishAgain.current = () => void finish();
  }, [finish]);

  // A page that was closed after the learner finished: the finish is still owed, so it goes out at once with the stored key (the events come first).
  useEffect(() => {
    if (restored?.completion != null) finishAgain.current();
    // Only once, when the run opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = useCallback(() => {
    if (index === null) return;
    const next = nextStep(steps, index);
    if (next.index === null) {
      void finish();
      return;
    }
    setIndex(next.index);
    setDraft(EMPTY_DRAFT);
    setHidden(false);
    setSkippedNotice(next.skipped > 0);
    shownAt.current = Date.now();
  }, [index, steps, finish]);

  const check = useCallback(() => {
    if (current === null || current.type !== "question" || checked || finishing || storing.current) return;
    const { question } = current;
    const payload = finalizeAnswer(question, draft.answer);
    if (payload === null) {
      setDraft((previous) => ({ ...previous, error: validateAnswer(question, previous.answer) }));
      window.setTimeout(() => questionRef.current?.focusAnswer(), 0);
      return;
    }
    const now = Date.now();
    const hintUsed = draft.hint !== null;
    const event = answerEvent({ questionId: question.questionId, answer: payload, hintUsed, occurredAtMs: now, durationMs: now - shownAt.current });
    eventQuestion.set(event.clientEventId, question.questionId);
    const stored = queue.enqueue(event);
    const graded = gradeLocally(question, payload, hintUsed);
    const target = graded.correct ? null : recallTarget(steps, question);
    const result = target === null ? graded : { ...graded, expected: { word: target } };
    const show = () => {
      setAnswered((previous) => ({ ...previous, [question.questionId]: { clientEventId: event.clientEventId, hintUsed, result } }));
      setDraft((previous) => ({ ...previous, answer: payload, error: null }));
      void runFlush();
      focusPrimary();
    };
    if (!isPromiseLike(stored)) {
      show();
      return;
    }
    // A durable queue: the feedback is shown only after the answer is committed to IndexedDB. A failed write shows none and the learner may press again.
    storing.current = true;
    stored.then(
      () => {
        storing.current = false;
        if (mounted.current) show();
      },
      (error: unknown) => {
        storing.current = false;
        eventQuestion.delete(event.clientEventId);
        if (mounted.current) backendRef.current?.storageFailed(error);
      },
    );
  }, [current, checked, finishing, draft, queue, runFlush, focusPrimary, steps, eventQuestion]);

  const press = useCallback(() => {
    if (action === null || finishing) return;
    if (action === "check") check();
    else if (action === "finish") void finish();
    else advance();
  }, [action, finishing, check, finish, advance]);

  // The step after the last one the learner finished, for «إيقاف مؤقت والخروج».
  const resumeIndex = useCallback((): number => {
    if (index === null) return 0;
    return checked ? (nextStep(steps, index).index ?? index) : index;
  }, [index, checked, steps]);

  // PWA-design 4: where a reload resumes and what was answered, written best effort after each answer that was committed, each step and each verdict of the
  // server. The first render writes nothing, so a session that was only opened leaves no record.
  const baseline = useRef<{ index: number | null; answers: number } | null>({ index, answers: Object.keys(answered).length });
  useEffect(() => {
    if (online === null || index === null) return;
    const first = baseline.current;
    if (first !== null && first.index === index && first.answers === Object.keys(answered).length) return;
    baseline.current = null;
    void online.saveRun({ resumeIndex: resumeIndex(), answered: journalAnswers(answered), planId: snapshot.planId, planVersion: snapshot.planVersion });
  }, [online, index, answered, resumeIndex, snapshot.planId, snapshot.planVersion]);

  const leaveNow = useCallback(() => {
    rememberResume(sessionId, resumeIndex());
    goToday();
  }, [sessionId, resumeIndex, goToday]);

  // Opening the sheet stops the clock: the open interval is queued and everything waiting is sent (S-19 c19).
  const openSheet = useCallback(() => {
    if (sheet.open || finishing || ended === "revoked") return;
    activity.close();
    setSheet({ open: true, status: "idle" });
    void queue.flush().then((result) => {
      if (!mounted.current || result.ok) return;
      const failure = handleFailure(result.error);
      if (failure !== null) setSheet({ open: true, status: "failed" });
    });
  }, [sheet.open, finishing, ended, activity, queue, handleFailure]);

  const closeSheet = useCallback(() => setSheet({ open: false }), []);

  const saveThenLeave = useCallback(async () => {
    setSheet({ open: true, status: "saving" });
    const result = await queue.flush();
    if (!mounted.current) return;
    if (result.ok) {
      leaveNow();
      return;
    }
    const failure = handleFailure(result.error);
    if (failure !== null) setSheet({ open: true, status: "failed" });
  }, [queue, leaveNow, handleFailure]);

  const leave = useCallback(() => {
    if (!sheet.open || sheet.status === "saving") return;
    // After a failed save the learner may still leave: the unsent events are lost, nothing else.
    if (sheet.status === "failed") leaveNow();
    else void saveThenLeave();
  }, [sheet, leaveNow, saveThenLeave]);

  const retrySheet = useCallback(() => {
    if (sheet.open && sheet.status === "saving") return;
    void saveThenLeave();
  }, [sheet, saveThenLeave]);

  // Esc opens the sheet; inside it the dialog treats Esc as "continue".
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !sheet.open) openSheet();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sheet.open, openSheet]);

  useBackGuard({ enabled: index !== null && !finishing, onAttempt: openSheet });

  // Between steps focus goes to the step heading; the first step does not take it from the learner's own position (S-19 "Focus order").
  const seenIndex = useRef<number | null>(index);
  useEffect(() => {
    if (index === null || seenIndex.current === index) return;
    seenIndex.current = index;
    document.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [index]);

  return {
    index,
    action,
    checked,
    draft,
    answered,
    streaks,
    hidden,
    skippedNotice,
    daily,
    goalNote,
    ended,
    sheet,
    sync,
    finishing,
    finishFailure,
    durability: online === null ? null : durability,
    announcement,
    questionRef,
    setAnswer: (answer) => setDraft((previous) => ({ ...previous, answer, error: null })),
    noteHint: (effect) => setDraft((previous) => (previous.hint === null ? { ...previous, hint: effect } : previous)),
    toggleText: (labels) => {
      const next = !hidden;
      setHidden(next);
      announce(next ? labels.hidden : labels.shown);
    },
    press,
    retrySync: () => void runFlush(),
    openSheet,
    closeSheet,
    leave,
    retrySheet,
    goToday,
  };
}
