"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { classifyChatError, type ChatFailure } from "@/components/plan-chat/failure";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { finalizeAnswer, validateAnswer, type QuestionError, type QuestionViewHandle, type TextKind } from "@/components/questions";
import { SessionEventQueue } from "@/components/session/event-queue";
import { gradeLocally } from "@/components/session/local-grade";
import { answerEvent } from "@/components/session/session-events";
import { useBackGuard } from "@/components/session/use-back-guard";
import { useLocale } from "@/i18n/LocaleProvider";
import { placementMessages } from "@/i18n/placement-messages";
import { useApiRuntime } from "@/lib/api/react";
import { completeSession, postSessionEvents, startSession } from "@/lib/api/session-endpoints";
import type { AnswerPayload, EventsResponse, Question } from "@/lib/api/types";
import { getStartSelection } from "@/lib/plan/start-selection";
import { placementQuestions, textKindOf, type SelfRating } from "./placement-model";

// What the last press left behind. Connectivity is not here: the offline banner speaks for it, and the server wake-up status is the shell's.
export type Result =
  | { kind: "edition" }
  | { kind: "options"; stage: "questions" | "conversation" }
  | Extract<ChatFailure, { kind: "throttled" | "unavailable" | "origin" | "internal" }>;

function resultOf(failure: ChatFailure, stage: "questions" | "conversation"): Result | null {
  switch (failure.kind) {
    case "validation":
      return failure.rules.includes("edition_not_available") ? { kind: "edition" } : { kind: "options", stage };
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

// G-03: a lost login is the one failure of E21 and E22 that matters here; every other one waits for the next flush or is ignored.
const endedBy = (failure: unknown): boolean => classifyChatError(failure).kind === "session_ended";

export type Phase = "rating" | "question" | "done";
export type DialogKind = "leave" | "skip" | null;

interface ActiveSession {
  sessionId: string;
  queue: SessionEventQueue;
  questions: Question[];
  textKind: TextKind;
}

export interface PlacementRun {
  phase: Phase;
  rating: SelfRating | null;
  setRating: (rating: SelfRating) => void;
  question: Question | null;
  k: number;
  n: number;
  textKind: TextKind;
  answer: AnswerPayload | null;
  setAnswer: (answer: AnswerPayload | null) => void;
  error: QuestionError | null;
  verdicts: Readonly<Record<string, boolean>>;
  creating: boolean;
  opening: boolean;
  busy: boolean;
  result: Result | null;
  dialog: DialogKind;
  questionRef: RefObject<QuestionViewHandle | null>;
  start: () => void;
  next: () => void;
  skipQuestion: () => void;
  proceed: () => void;
  openLeave: () => void;
  openSkip: () => void;
  closeDialog: () => void;
  confirmLeave: () => void;
  confirmSkip: () => void;
}

// The runtime of S-09: E20 `placement` once per press (P-14), the answers as E21 events with stable ids, E22 best effort and E31 at the end.
// Nothing is graded or shown per answer: the local verdict only decides the calm line of the done step, and the server's replaces it when it arrives.
export function usePlacementRun(): PlacementRun {
  const router = useRouter();
  const { locale } = useLocale();
  const { api, client } = useApiRuntime();
  const text = placementMessages(locale);

  const [rating, setRatingState] = useState<SelfRating | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswerState] = useState<AnswerPayload | null>(null);
  const [error, setError] = useState<QuestionError | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const questionRef = useRef<QuestionViewHandle>(null);
  const sending = useRef(false);
  const shownAt = useRef(0);
  const busy = creating || opening;

  // Guard 5 (UG-01): the selection lives in memory, so a reload or a direct visit goes back to S-08.
  useEffect(() => {
    if (getStartSelection() === null) router.replace("/start");
  }, [router]);

  const endSession = useCallback(() => redirectToLogin(router, "/start"), [router]);

  // Answers go out as they are made; what does not reach the server waits in the queue and goes with the next flush (E21 is idempotent).
  const flush = useCallback(
    (active: ActiveSession) => {
      void active.queue.flush().then((outcome) => {
        if (!outcome.ok && endedBy(outcome.error)) endSession();
      });
    },
    [endSession],
  );

  useEffect(() => {
    if (session === null) return;
    const onOnline = () => {
      if (session.queue.size > 0) flush(session);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [session, flush]);

  const questions = session?.questions ?? [];
  const question = session === null ? null : (questions[index] ?? null);
  const phase: Phase = session === null ? "rating" : question === null ? "done" : "question";

  // After each step focus moves to its prompt or heading (S-09 "Focus order"); the first step keeps the page title's focus.
  const stepKey = `${phase}:${index}`;
  const seenStep = useRef(stepKey);
  useEffect(() => {
    if (seenStep.current === stepKey) return;
    seenStep.current = stepKey;
    document.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [stepKey]);

  const setRating = useCallback((value: SelfRating) => setRatingState(value), []);
  const setAnswer = useCallback((value: AnswerPayload | null) => {
    setAnswerState(value);
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (sending.current || session !== null) return;
    const selection = getStartSelection();
    if (selection === null) {
      router.replace("/start");
      return;
    }
    sending.current = true;
    setResult(null);
    setCreating(true);
    try {
      const snapshot = await startSession(client, {
        kind: "placement",
        editionId: selection.editionId,
        targetScope: selection.targetScope,
        ...(rating === null ? {} : { selfRating: rating }),
      });
      const queue = new SessionEventQueue({ send: (events) => postSessionEvents(client, snapshot.sessionId, events) });
      queue.setResponseHandler((response: EventsResponse) => {
        if (response.results.length === 0) return;
        setVerdicts((previous) => {
          const next = { ...previous };
          for (const entry of response.results) next[entry.questionId] = entry.correct;
          return next;
        });
      });
      shownAt.current = Date.now();
      setIndex(0);
      setSession({ sessionId: snapshot.sessionId, queue, questions: placementQuestions(snapshot), textKind: textKindOf(selection.paths) });
    } catch (failure) {
      const classified = classifyChatError(failure);
      if (classified.kind === "session_ended") endSession();
      else setResult(resultOf(classified, "questions"));
    } finally {
      sending.current = false;
      setCreating(false);
    }
  }, [client, rating, router, session, endSession]);

  const moveOn = useCallback(() => {
    setIndex((previous) => previous + 1);
    setAnswerState(null);
    setError(null);
    shownAt.current = Date.now();
  }, []);

  const next = useCallback(() => {
    if (busy || session === null || question === null) return;
    const payload = finalizeAnswer(question, answer);
    if (payload === null) {
      const invalid = validateAnswer(question, answer);
      // Nothing chosen speaks the S-09 line (P-03); a recall of several words keeps the piece's own message.
      setError(invalid === null ? null : invalid.kind === "empty" ? { kind: "empty", message: text.chooseOrSkip } : invalid);
      window.setTimeout(() => questionRef.current?.focusAnswer(), 0);
      return;
    }
    const now = Date.now();
    session.queue.enqueue(answerEvent({ questionId: question.questionId, answer: payload, hintUsed: false, occurredAtMs: now, durationMs: now - shownAt.current }));
    setVerdicts((previous) => ({ ...previous, [question.questionId]: gradeLocally(question, payload, false).correct }));
    flush(session);
    moveOn();
  }, [busy, session, question, answer, text.chooseOrSkip, flush, moveOn]);

  // A skipped question sends no event and counts as unanswered.
  const skipQuestion = useCallback(() => {
    if (busy || question === null) return;
    moveOn();
  }, [busy, question, moveOn]);

  // E22 is best effort: the answers are flushed and the session completed once, and a failure there never stops the conversation (only a lost login does).
  const settle = useCallback(
    async (active: ActiveSession) => {
      const flushed = await active.queue.flush();
      if (!flushed.ok && endedBy(flushed.error)) throw flushed.error;
      try {
        await completeSession(client, active.sessionId, { retry: { delaysMs: [] } });
      } catch (failure) {
        if (endedBy(failure)) throw failure;
      }
    },
    [client],
  );

  // P-14: E31 creates a row, so it is never retried automatically; the button is the retry, and an extra press while it waits is ignored.
  const openConversation = useCallback(
    async (withSession: boolean) => {
      if (sending.current) return;
      const selection = getStartSelection();
      if (selection === null) {
        router.replace("/start");
        return;
      }
      sending.current = true;
      setResult(null);
      setOpening(true);
      let leaving = false;
      try {
        let placementSessionId: string | undefined;
        if (withSession && session !== null) {
          await settle(session);
          placementSessionId = session.sessionId;
        }
        const chat = await api.createPlanChat({
          editionId: selection.editionId,
          targetScope: selection.targetScope,
          paths: selection.paths,
          sessionMinutes: selection.sessionMinutes,
          ...(selection.preferredDate === null ? {} : { preferredDate: selection.preferredDate }),
          ...(placementSessionId === undefined ? {} : { placementSessionId }),
          goalText: selection.goalText,
          language: locale,
        });
        leaving = true;
        router.replace(`/plan/chat/${chat.chatId}`);
      } catch (failure) {
        const classified = classifyChatError(failure);
        if (classified.kind === "session_ended") endSession();
        else setResult(resultOf(classified, "conversation"));
      } finally {
        // On success the button keeps its loading state while the conversation opens.
        if (!leaving) {
          sending.current = false;
          setOpening(false);
        }
      }
    },
    [api, locale, router, session, settle, endSession],
  );

  const openLeave = useCallback(() => {
    if (!busy) setDialog((current) => current ?? "leave");
  }, [busy]);
  const openSkip = useCallback(() => {
    if (!busy) setDialog((current) => current ?? "skip");
  }, [busy]);
  const closeDialog = useCallback(() => setDialog(null), []);

  const confirmLeave = useCallback(() => {
    setDialog(null);
    router.replace("/start");
  }, [router]);

  // UG-12: the plan conversation opens without a placement session, at any step.
  const confirmSkip = useCallback(() => {
    setDialog(null);
    void openConversation(false);
  }, [openConversation]);

  // Back, the browser back and the edge swipe ask first (UA-09); Esc does the same.
  useBackGuard({ enabled: true, onAttempt: openLeave });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) openLeave();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openLeave]);

  return {
    phase,
    rating,
    setRating,
    question,
    k: Math.min(index + 1, questions.length),
    n: questions.length,
    textKind: session?.textKind ?? "quran",
    answer,
    setAnswer,
    error,
    verdicts,
    creating,
    opening,
    busy,
    result,
    dialog,
    questionRef,
    start: () => void start(),
    next,
    skipQuestion,
    proceed: () => void openConversation(true),
    openLeave,
    openSkip,
    closeDialog,
    confirmLeave,
    confirmSkip,
  };
}
