import type { AnswerPayload, ISODateTime, SessionEvent } from "@/lib/api/types";

// API-spec E21: an interval or an answer duration is at most 30 minutes.
export const MAX_EVENT_SPAN_MS = 30 * 60 * 1000;

const HEX = "0123456789abcdef";

// A UUID v4. `crypto.randomUUID` exists only in secure contexts, so a page opened over plain http on a local network falls back to getRandomValues.
export function newEventId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => HEX.charAt(byte >> 4) + HEX.charAt(byte & 15)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const iso = (millis: number): ISODateTime => new Date(millis).toISOString();

export interface AnswerEventInput {
  clientEventId?: string;
  questionId: string;
  answer: AnswerPayload;
  hintUsed: boolean;
  occurredAtMs: number;
  durationMs: number;
}

// One E21 `answer` event. The id is made here once and stays with the event for every resend (it is never regenerated).
export function answerEvent(input: AnswerEventInput): SessionEvent {
  return {
    clientEventId: input.clientEventId ?? newEventId(),
    type: "answer",
    questionId: input.questionId,
    answer: input.answer,
    hintUsed: input.hintUsed,
    occurredAt: iso(input.occurredAtMs),
    durationMs: Math.min(MAX_EVENT_SPAN_MS, Math.max(0, Math.round(input.durationMs))),
  };
}

// One E21 `activity` event for an interval of active time. `activeMs` equals the interval, so it never exceeds `endedAt - startedAt + 1000`.
// Null for an interval too short to count or one that runs backwards (a clock change).
export function activityEvent(startedAtMs: number, endedAtMs: number, clientEventId?: string): SessionEvent | null {
  const span = endedAtMs - startedAtMs;
  if (!Number.isFinite(span) || span < 1000) return null;
  const activeMs = Math.min(MAX_EVENT_SPAN_MS, Math.round(span));
  return { clientEventId: clientEventId ?? newEventId(), type: "activity", startedAt: iso(startedAtMs), endedAt: iso(startedAtMs + activeMs), activeMs };
}
