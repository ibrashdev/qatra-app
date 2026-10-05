"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { finalizeAnswer, validateAnswer, type HintEffect, type QuestionError, type QuestionResult, type QuestionViewHandle } from "@/components/questions";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { SessionEventQueue, type FlushResult } from "@/components/session/event-queue";
import { gradeLocally } from "@/components/session/local-grade";
import { activityEvent, answerEvent, newEventId } from "@/components/session/session-events";
import { retriesByItself, type SessionFailure } from "@/components/session/session-failure";
import { useActivityClock } from "@/components/session/use-activity";
import { useBackGuard } from "@/components/session/use-back-guard";
import { useApiRuntime } from "@/lib/api/react";
import { completeSession, postSessionEvents } from "@/lib/api/session-endpoints";
import type { AnswerPayload, CompleteResponse, EventsResponse, Question, SessionEvent } from "@/lib/api/types";
import { classifyGameError, clearRound, type GameRound } from "./game-model";

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

// "inactive": the plan no longer takes answers (G-11). "closed": the round has ended on the server. "revoked": the edition was withdrawn, so no text is
// shown or guessed (G-20, P-22). Each ends the round: the answer area is inert and the action bar offers only the way back to the games.
export type Ended = "inactive" | "closed" | "revoked" | null;

export type SheetState = { open: false } | { open: true; status: "idle" | "saving" | "failed" };

// P-25: the screen changes in place after the last question. While E22 runs, or after it failed, the summary area keeps a skeleton.
export type ResultState = { status: "loading" } | { status: "failed"; failure: SessionFailure } | { status: "ready"; complete: CompleteResponse };

export type RoundAction = "check" | "next" | "finish";

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30_000;

export interface GameRoundRun {
  index: number;
  question: Question | undefined;
  position: { k: number; n: number };
  action: RoundAction;
  draft: Draft;
  answered: Readonly<Record<string, AnsweredQuestion>>;
  ended: Ended;
  sheet: SheetState;
  sync: SessionFailure | null;
  phase: "playing" | "result";
  result: ResultState | null;
  questionRef: RefObject<QuestionViewHandle | null>;
  setAnswer: (answer: AnswerPayload | null) => void;
  noteHint: (effect: HintEffect) => void;
  press: () => void;
  retrySync: () => void;
  retryResult: () => void;
  openSheet: () => void;
  closeSheet: () => void;
  leave: () => void;
  retrySheet: () => void;
  leaveUnsaved: () => void;
  goGames: () => void;
}

// The runtime of a round (S-15 to S-18, P-18 to P-25): the question loop, the answers and their first verdict, the outbox of events, the active time, the
// end of the round and the leave sheet. The snapshot is only read, and the server grades every answer: its `results[]` replace the first verdict.
export function useGameRound({ round, questions }: { round: GameRound; questions: readonly Question[] }): GameRoundRun {
  const router = useRouter();
  const { client } = useApiRuntime();
  const sessionId = round.snapshot.sessionId;

  const [index, setIndex] = useState(0);
  const [answered, setAnswered] = useState<Record<string, AnsweredQuestion>>({});
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [ended, setEnded] = useState<Ended>(null);
  const [sheet, setSheet] = useState<SheetState>({ open: false });
  const [sync, setSync] = useState<SessionFailure | null>(null);
  const [phase, setPhase] = useState<"playing" | "result">("playing");
  const [result, setResult] = useState<ResultState | null>(null);
  const [idempotencyKey] = useState(newEventId);

  const questionRef = useRef<QuestionViewHandle>(null);
  const mounted = useRef(true);
  const eventQuestion = useRef(new Map<string, string>());
  const shownAt = useRef(0);
  const finishingNow = useRef(false);
  const attempts = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const flushAgain = useRef<() => void>(() => undefined);

  const [queue] = useState(() => new SessionEventQueue({ send: (events: SessionEvent[]) => postSessionEvents(client, sessionId, events) }));

  const goGames = useCallback(() => {
    clearRound();
    router.replace("/games");
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

  // The answer of E21: the verdicts of the server replace the first ones; a rejected or pending answer is a calm line (P-22); some codes end the round.
  useEffect(() => {
    queue.setResponseHandler((response: EventsResponse) => {
      const statusOf = new Map<string, "rejected" | "pending">();
      let endedNow: Ended = null;
      for (const entry of response.rejected) {
        if (entry.code === "edition_mismatch") endedNow = "revoked";
        else if (entry.code === "plan_not_active" && endedNow === null) endedNow = "inactive";
        else if (entry.code === "session_closed" && endedNow === null) endedNow = "closed";
        statusOf.set(entry.clientEventId, "rejected");
      }
      for (const entry of response.pending) statusOf.set(entry.clientEventId, "pending");
      if (endedNow !== null) setEnded(endedNow);

      if (response.results.length === 0 && statusOf.size === 0) return;
      setAnswered((previous) => {
        const next = { ...previous };
        for (const entry of response.results) {
          const existing = next[entry.questionId];
          if (existing === undefined || existing.clientEventId !== entry.clientEventId) continue;
          const changed = existing.result.correct !== entry.correct || existing.result.assisted !== entry.assisted;
          next[entry.questionId] = {
            ...existing,
            result: { ...existing.result, correct: entry.correct, assisted: entry.assisted, expected: entry.expected, ...(changed ? { updated: true } : {}) },
          };
        }
        for (const [clientEventId, status] of statusOf) {
          const questionId = eventQuestion.current.get(clientEventId);
          const existing = questionId === undefined ? undefined : next[questionId];
          if (questionId !== undefined && existing !== undefined) next[questionId] = { ...existing, result: { ...existing.result, status } };
        }
        return next;
      });
    });
  }, [queue]);

  const handleFailure = useCallback(
    (error: unknown): SessionFailure | null => {
      const failure = classifyGameError(error);
      if (failure.kind === "aborted") return null;
      if (failure.kind === "session_ended") {
        redirectToLogin(router, "/games");
        return null;
      }
      if (failure.kind === "not_found") {
        goGames();
        return null;
      }
      return failure;
    },
    [router, goGames],
  );

  const runFlush = useCallback(async (): Promise<FlushResult> => {
    const flushed = await queue.flush();
    if (!mounted.current) return flushed;
    if (flushed.ok) {
      attempts.current = 0;
      setSync(null);
      return flushed;
    }
    const failure = handleFailure(flushed.error);
    if (failure === null) return flushed;
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
    return flushed;
  }, [queue, handleFailure]);

  useEffect(() => {
    flushAgain.current = () => void runFlush();
  }, [runFlush]);

  // Active time (D40): queued as it ends, sent at once. The leave sheet and the end of the round stop it; nothing ticks on screen.
  const activity = useActivityClock({
    running: phase === "playing" && !sheet.open && ended === null,
    onInterval: (startedAtMs, endedAtMs) => {
      const event = activityEvent(startedAtMs, endedAtMs);
      if (event === null) return;
      queue.enqueue(event);
      void runFlush();
    },
  });

  // The connection is back: resend what waits.
  useEffect(() => {
    const onOnline = () => {
      if (queue.size > 0) flushAgain.current();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [queue]);

  const question = questions[index];
  const answeredHere = question === undefined ? undefined : answered[question.questionId];
  const checked = answeredHere !== undefined;
  const last = index >= questions.length - 1;
  const action: RoundAction = !checked ? "check" : last ? "finish" : "next";

  const focusPrimary = useCallback(() => {
    window.setTimeout(() => document.querySelector<HTMLElement>("[data-round-primary]")?.focus(), 0);
  }, []);

  // P-25: the pending events are sent, then E22 (idempotent, so a repeat is safe). The result frame opens at once and keeps a skeleton until it answers.
  const finish = useCallback(async () => {
    if (finishingNow.current) return;
    finishingNow.current = true;
    setPhase("result");
    setResult({ status: "loading" });
    activity.close();
    const fail = (error: unknown) => {
      finishingNow.current = false;
      const failure = handleFailure(error);
      if (failure !== null) setResult({ status: "failed", failure });
    };
    const flushed = await queue.flush();
    if (!mounted.current) return;
    if (!flushed.ok) {
      fail(flushed.error);
      return;
    }
    setSync(null);
    try {
      const complete = await completeSession(client, sessionId, { idempotencyKey });
      if (!mounted.current) return;
      setResult({ status: "ready", complete });
      finishingNow.current = false;
    } catch (error) {
      if (mounted.current) fail(error);
    }
  }, [activity, queue, client, sessionId, idempotencyKey, handleFailure]);

  const advance = useCallback(() => {
    if (last) {
      void finish();
      return;
    }
    setIndex((value) => value + 1);
    setDraft(EMPTY_DRAFT);
    shownAt.current = Date.now();
  }, [last, finish]);

  // P-21: an incomplete answer sends nothing and moves focus to the first control that needs one; a complete one is queued and shown at once from the
  // answer key the snapshot ships.
  const check = useCallback(() => {
    if (question === undefined || checked || ended !== null) return;
    const payload = finalizeAnswer(question, draft.answer);
    if (payload === null) {
      setDraft((previous) => ({ ...previous, error: validateAnswer(question, previous.answer) }));
      window.setTimeout(() => questionRef.current?.focusAnswer(), 0);
      return;
    }
    const now = Date.now();
    const hintUsed = draft.hint !== null;
    const event = answerEvent({ questionId: question.questionId, answer: payload, hintUsed, occurredAtMs: now, durationMs: now - shownAt.current });
    eventQuestion.current.set(event.clientEventId, question.questionId);
    queue.enqueue(event);
    const graded = gradeLocally(question, payload, hintUsed);
    setAnswered((previous) => ({ ...previous, [question.questionId]: { clientEventId: event.clientEventId, hintUsed, result: graded } }));
    setDraft((previous) => ({ ...previous, answer: payload, error: null }));
    void runFlush();
    focusPrimary();
  }, [question, checked, ended, draft, queue, runFlush, focusPrimary]);

  const press = useCallback(() => {
    if (ended !== null || phase !== "playing") return;
    if (action === "check") check();
    else advance();
  }, [ended, phase, action, check, advance]);

  // P-23: opening the sheet stops the clock, queues the open interval and sends everything waiting.
  const openSheet = useCallback(() => {
    if (sheet.open || phase !== "playing" || ended !== null) return;
    activity.close();
    setSheet({ open: true, status: "idle" });
    void queue.flush().then((flushed) => {
      if (!mounted.current || flushed.ok) return;
      const failure = handleFailure(flushed.error);
      if (failure !== null) setSheet({ open: true, status: "failed" });
    });
  }, [sheet.open, phase, ended, activity, queue, handleFailure]);

  // While the answers are being saved the first button is inert (P-23).
  const closeSheet = useCallback(() => setSheet((previous) => (previous.open && previous.status === "saving" ? previous : { open: false })), []);

  // Leaving sends the pending events, then E22, goes to S-14 by `replace` and drops the snapshot. If they fail the sheet stays open with its own banner.
  const saveThenLeave = useCallback(async () => {
    setSheet({ open: true, status: "saving" });
    const flushed = await queue.flush();
    if (!mounted.current) return;
    if (!flushed.ok) {
      if (handleFailure(flushed.error) !== null) setSheet({ open: true, status: "failed" });
      return;
    }
    try {
      await completeSession(client, sessionId, { idempotencyKey });
    } catch (error) {
      if (mounted.current && handleFailure(error) !== null) setSheet({ open: true, status: "failed" });
      return;
    }
    if (mounted.current) goGames();
  }, [queue, client, sessionId, idempotencyKey, handleFailure, goGames]);

  const leave = useCallback(() => {
    if (!sheet.open || sheet.status === "saving") return;
    void saveThenLeave();
  }, [sheet, saveThenLeave]);

  const retrySheet = useCallback(() => {
    if (sheet.open && sheet.status === "saving") return;
    void saveThenLeave();
  }, [sheet, saveThenLeave]);

  // After a failed save the learner may still leave: the unsent events are lost, nothing else.
  const leaveUnsaved = useCallback(() => goGames(), [goGames]);

  // Esc opens the sheet; inside it the dialog treats Esc as "keep playing".
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !sheet.open) openSheet();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sheet.open, openSheet]);

  // P-23: back, the iOS edge swipe and the Android back gesture open the sheet while the round is on. After the result the guard is released.
  useBackGuard({ enabled: phase === "playing" && ended === null, onAttempt: openSheet });

  // The guard left one history entry of its own. After the result, the first back goes to S-14 instead of staying on this route.
  useEffect(() => {
    if (phase !== "result") return;
    const toGames = () => goGames();
    window.addEventListener("popstate", toGames, { once: true });
    return () => window.removeEventListener("popstate", toGames);
  }, [phase, goGames]);

  // Between questions focus goes to the H2 (P-18); the first question leaves it on the H1 that the route took (P-19).
  const seenIndex = useRef(index);
  useEffect(() => {
    if (seenIndex.current === index) return;
    seenIndex.current = index;
    document.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [index]);

  // P-25: the app bar title becomes the result title and takes focus.
  useEffect(() => {
    if (phase === "result") document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }, [phase]);

  return {
    index,
    question,
    position: { k: Math.min(index + 1, questions.length), n: questions.length },
    action,
    draft,
    answered,
    ended,
    sheet,
    sync,
    phase,
    result,
    questionRef,
    setAnswer: (answer) => setDraft((previous) => ({ ...previous, answer, error: null })),
    noteHint: (effect) => setDraft((previous) => (previous.hint === null ? { ...previous, hint: effect } : previous)),
    press,
    retrySync: () => void runFlush(),
    retryResult: () => void finish(),
    openSheet,
    closeSheet,
    leave,
    retrySheet,
    leaveUnsaved,
    goGames,
  };
}
