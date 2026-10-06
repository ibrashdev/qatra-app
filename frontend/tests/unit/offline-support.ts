import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import { createApiClient, type ApiClient } from "@/lib/api/client";
import type { EventsResponse, PlanSnapshot, Profile, Question, SessionEvent, SessionSnapshot } from "@/lib/api/types";
import { closeOfflineDb } from "@/lib/offline/db";
import { closeOfflinePublisher } from "@/lib/offline/broadcast";
import { attachEnvelope, buildEnvelope } from "@/lib/offline/envelope";
import type { EnvelopedEvent } from "@/lib/offline/types";

// Synthetic data only: no real learner, no real text. IDs are UUIDs so the outbox accepts them.

export const OWNER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_OWNER_ID = "22222222-2222-4222-8222-222222222222";
export const USERNAME = "test.learner";
export const PLAN_ID = "33333333-3333-4333-8333-333333333333";
export const EDITION_ID = "44444444-4444-4444-8444-444444444444";
export const DAILY_SESSION = "55555555-5555-4555-8555-555555555551";
export const GAME_SESSION = "55555555-5555-4555-8555-555555555552";

let counter = 0;
export function uuid(): string {
  counter += 1;
  const tail = counter.toString(16).padStart(12, "0");
  return `aaaaaaaa-0000-4000-8000-${tail}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Environment: a fresh IndexedDB, empty localStorage, an in-memory BroadcastChannel
// ---------------------------------------------------------------------------------------------------------------------------------------------

export class FakeBroadcastChannel {
  static channels = new Set<FakeBroadcastChannel>();
  static log: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.add(this);
  }
  postMessage(message: unknown): void {
    FakeBroadcastChannel.log.push(message);
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) channel.onmessage?.({ data: message } as MessageEvent<unknown>);
    }
  }
  close(): void {
    FakeBroadcastChannel.channels.delete(this);
  }
}

export function resetOfflineEnvironment(): void {
  closeOfflineDb();
  closeOfflinePublisher();
  FakeBroadcastChannel.channels.clear();
  FakeBroadcastChannel.log = [];
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  window.localStorage.clear();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SOURCE = { publisher: "Synthetic", editionLabel: "Test edition", bookTitleAr: "كتاب اختبار", reference: "T:1", url: "https://example.invalid/t/1", pages: [] };
const POLICY = { normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1" } as const;

export function choiceQuestion(id: string, passageId: string): Question {
  return {
    questionId: id,
    type: "word_choice",
    passageId,
    role: "game",
    reviewRoundId: null,
    context: { before: [], after: [] },
    policy: POLICY,
    source: SOURCE,
    variant: "word",
    options: [
      { optionId: `${id}-a`, text: "alpha" },
      { optionId: `${id}-b`, text: "beta" },
    ],
    answerKey: { optionId: `${id}-a` },
  } as Question;
}

export function recallQuestion(id: string, passageId: string): Question {
  return {
    questionId: id,
    type: "word_recall",
    passageId,
    role: "game",
    reviewRoundId: null,
    context: { before: [], after: [] },
    policy: POLICY,
    source: SOURCE,
    hintFirstLetter: "a",
    answerKey: { acceptedNorms: ["alpha"] },
  } as Question;
}

export function orderQuestion(id: string, passageId: string): Question {
  return {
    questionId: id,
    type: "word_order",
    passageId,
    role: "game",
    reviewRoundId: null,
    context: { before: [], after: [] },
    policy: POLICY,
    source: SOURCE,
    tokens: [
      { ref: "1:1", text: "one" },
      { ref: "1:0", text: "zero" },
    ],
    answerKey: { order: ["1:0", "1:1"] },
  } as Question;
}

export function passage(passageId: string) {
  return {
    passageId,
    path: "quran",
    reference: "T:1",
    sectionTitleAr: "اختبار",
    units: [{ unitRef: 1, kind: "ayah", reference: "T:1", text: "alpha beta" }],
    highlight: { startRef: "1:0", endRef: "1:1" },
    takhrij: null,
    grade: null,
    showD50Notice: false,
    source: SOURCE,
  } as const;
}

export function preparedSession(sessionId: string, kind: "daily" | "game", questions: Question[], passageId: string): SessionSnapshot {
  return {
    sessionId,
    kind,
    planId: PLAN_ID,
    planVersion: 1,
    editionId: EDITION_ID,
    bankVersion: 3,
    learningDate: "2026-10-06",
    status: "prepared",
    steps: [{ type: "learn", passage: passage(passageId) } as unknown as SessionSnapshot["steps"][number], ...questions.map((question) => ({ type: "question" as const, question }))],
    createdAt: "2026-10-05T10:00:00.000Z",
  };
}

export function makeSnapshot(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  const passageId = "66666666-6666-4666-8666-666666666666";
  const questions = [choiceQuestion("q-choice", passageId), recallQuestion("q-recall", passageId), orderQuestion("q-order", passageId)];
  return {
    snapshotId: "77777777-7777-4777-8777-777777777777",
    schemaVersion: 1,
    protocolVersion: 1,
    userId: OWNER_ID,
    planId: PLAN_ID,
    planVersion: 1,
    editionId: EDITION_ID,
    bankVersion: 3,
    targetScope: { sectionOrdinals: [1] },
    downloadedTargetRefs: [passageId],
    learningTimeZone: "Asia/Dubai",
    dailyGoalMs: 600_000,
    contentHashes: {},
    verifiedAt: "2026-10-05T10:00:00.000Z",
    contentValidity: { checkedAt: "2026-10-05T10:00:00.000Z", result: "valid" },
    normalizationPolicyVersion: "arabic-norm-v1",
    scoringPolicyVersion: "v1",
    preparedSessions: [preparedSession(DAILY_SESSION, "daily", questions.slice(0, 2), passageId), preparedSession(GAME_SESSION, "game", questions.slice(2), passageId)],
    lessons: [passage(passageId)] as unknown as PlanSnapshot["lessons"],
    games: questions,
    references: [SOURCE],
    ...overrides,
  };
}

export function answerAt(snapshot: PlanSnapshot, clientRunId: string, localSequence: number, offsetMs = 0, overrides: Partial<SessionEvent> = {}): EnvelopedEvent {
  const base: SessionEvent = {
    clientEventId: uuid(),
    type: "answer",
    questionId: "q-choice",
    answer: { optionId: "q-choice-a" },
    hintUsed: false,
    occurredAt: new Date(Date.parse("2026-10-05T10:00:00.000Z") + offsetMs).toISOString(),
    durationMs: 1500,
  };
  return attachEnvelope({ ...base, ...overrides } as SessionEvent, buildEnvelope(snapshot, clientRunId, localSequence));
}

export function activityAt(snapshot: PlanSnapshot, clientRunId: string, localSequence: number, offsetMs: number, spanMs = 5000): EnvelopedEvent {
  const startedAt = Date.parse("2026-10-05T10:00:00.000Z") + offsetMs;
  const event: SessionEvent = {
    clientEventId: uuid(),
    type: "activity",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + spanMs).toISOString(),
    activeMs: spanMs,
  };
  return attachEnvelope(event, buildEnvelope(snapshot, clientRunId, localSequence));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A fake backend behind the real ApiClient
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (call: Call, index: number) => Reply | Promise<Reply>;

export const profile = (username = USERNAME): Profile => ({
  username,
  language: "ar",
  timeZone: "Asia/Dubai",
  sessionMinutes: 10,
  reminderSettings: { inApp: true },
  isDemo: false,
  termsVersion: "2026-10-04",
  termsAcceptedAt: "2026-10-04T00:00:00.000Z",
  createdAt: "2026-10-04T00:00:00.000Z",
  pendingSettings: null,
});

export function envelopeError(code: string, status: number, details: Record<string, unknown> = {}, headers: Record<string, string> = {}): Reply {
  return { status, body: { error: { code, message: "Safe text.", details } }, headers };
}

export function ackAll(calls: Call): EventsResponse {
  const events = (calls.body as { events: SessionEvent[] }).events;
  return {
    acknowledged: events.map((event) => event.clientEventId),
    duplicate: [],
    pending: [],
    rejected: [],
    results: [],
    daily: { learningDate: "2026-10-06", dailyActiveMs: 60_000, dailyGoalMs: 600_000, dailyPercent: 10, dailyCompleted: false, extraActiveMs: 0 },
  };
}

export class FakeServer {
  readonly calls: Call[] = [];
  readonly overrides = new Map<string, Handler>();
  username = USERNAME;
  failNextNetwork = 0; // the next N requests fail with a network error (no answer)
  extraHeaders: Record<string, string> = {}; // added to every answer (a test puts a session cookie here)

  constructor() {
    this.fetch = this.fetch.bind(this);
  }

  on(key: string, handler: Handler | Reply): void {
    this.overrides.set(key, typeof handler === "function" ? handler : () => handler);
  }

  count(prefix: string): number {
    return this.calls.filter((call) => `${call.method} ${call.path}`.startsWith(prefix)).length;
  }

  list(prefix: string): Call[] {
    return this.calls.filter((call) => `${call.method} ${call.path}`.startsWith(prefix));
  }

  private defaultReply(call: Call): Reply {
    const key = `${call.method} ${call.path}`;
    if (key === "GET /health") return { body: { status: "ok", version: "test", time: "2026-10-05T10:00:00.000Z" } };
    if (key === "GET /me") return { body: profile(this.username) };
    if (key === "POST /offline/revalidate") {
      const request = call.body as { expectedPlanVersion: number };
      return { body: { status: "available", currentPlanVersion: request.expectedPlanVersion, allowedSessionRefs: [DAILY_SESSION, GAME_SESSION], catalogVersion: 3, reasonCode: "current" } };
    }
    if (/^POST \/sessions\/[^/]+\/events$/.test(key)) return { body: ackAll(call) };
    if (/^POST \/sessions\/[^/]+\/complete$/.test(key)) return { body: { summary: { answered: 0, correct: 0, newPassages: 0, reviewsPassed: 0, reviewsFailed: 0, activeMs: 0 }, daily: ackAll({ ...call, body: { events: [] } }).daily } };
    if (key === "POST /auth/logout") return { status: 204 };
    return envelopeError("not_found", 404);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const path = url.replace(/^\/api/, "");
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    this.calls.push(call);
    if (this.failNextNetwork > 0) {
      this.failNextNetwork -= 1;
      throw new TypeError("network down");
    }
    const key = `${call.method} ${call.path}`;
    const handler = [...this.overrides.entries()].find(([pattern]) => pattern === key || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1))) || (pattern.startsWith("re:") && new RegExp(pattern.slice(3)).test(key)))?.[1];
    const reply = handler ? await handler(call, this.calls.length - 1) : this.defaultReply(call);
    const status = reply.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body ?? {}), { status, headers: { "Content-Type": "application/json", ...this.extraHeaders, ...reply.headers } });
  }

  client(): ApiClient {
    return createApiClient({ fetch: this.fetch as typeof fetch, sleep: async () => undefined });
  }
}

export const noSleep = async (): Promise<void> => undefined;

// A clock that moves only when it is told to, for the wake-up loop.
export function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export interface StoreDump {
  ownerState: unknown[];
  planSnapshots: unknown[];
  activeRuns: unknown[];
  pendingEvents: unknown[];
  syncState: unknown[];
}

export async function dumpAllStores(): Promise<StoreDump> {
  const factory = (globalThis as { indexedDB: IDBFactory }).indexedDB;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("qatra-offline");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const result: StoreDump = { ownerState: [], planSnapshots: [], activeRuns: [], pendingEvents: [], syncState: [] };
    for (const name of Array.from(db.objectStoreNames) as (keyof StoreDump)[]) {
      result[name] = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(name, "readonly").objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
      });
    }
    return result;
  } finally {
    db.close();
  }
}
