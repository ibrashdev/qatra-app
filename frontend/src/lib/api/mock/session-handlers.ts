// Mock handlers for E20 (`daily`), E21 and E22 as the memorization session (S-19) uses them. Synthetic data only: the words are placeholders («كلمة١»), never
// a verse or a hadith. Registered by the coordinator after todayMockHandlers, which holds an empty E20 of its own:
//   handlers: { ...mockHandlers, ...todayMockHandlers, ...sessionMockHandlers }
// The mock grades like the server does (answer key and policy `arabic-norm-v1`), answers each event with exactly one outcome, keeps the idempotency of
// `clientEventId`, and returns `daily` in every E21 answer. State lives per mock scenario, so every mock fetch starts clean.
import { normalizeArabicWord } from "@/components/session/arabic-norm";
import type { AnswerPayload, AnswerResult, CompleteResponse, DailyProgress, EventsResponse, Question, SessionSnapshot, Step } from "../types";
import { mockToday } from "./fixtures";
import type { MockHandler, MockRequest, MockResponse, MockScenario } from "./handlers";
import { mockContext, mockSource, type MockAyah } from "./question-fixtures";
import { todayMockHandlers } from "./today-handlers";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => failure(422, "validation_error", "The request body is not valid.", { fields });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SESSION_ID_PREFIX = "55555555-5555-4555-8555-00000000000";
const MAX_BODY_CHARS = 64 * 1024; // API-spec 1.7: 64 KiB
const MAX_SPAN_MS = 30 * 60 * 1000;

export const MOCK_REVIEW_PASSAGE_ID = "66666666-6666-4666-8666-000000000001";
export const MOCK_NEW_PASSAGE_ID = "66666666-6666-4666-8666-000000000003";
export const MOCK_REVIEW_ROUND_ID = "88888888-8888-4888-8888-000000000001";

export const MOCK_QUESTION_IDS = {
  review: "77777777-7777-4777-8777-000000000001",
  order: "77777777-7777-4777-8777-000000000002",
  segment: "77777777-7777-4777-8777-000000000003",
  recall: "77777777-7777-4777-8777-000000000004",
  similar: "77777777-7777-4777-8777-000000000005",
  test: "77777777-7777-4777-8777-000000000006",
} as const;

// The target of the recall question as the book has it (the second word of the second unit of the learn passage); the answer key keeps only its normalised form.
export const MOCK_RECALL_WORD = "كلمة٦";

// The placeholder passages as the server sends them (D92): every question carries the whole passage of its own around the blank.
const REVIEW_PASSAGE: readonly MockAyah[] = [{ unit: 1, words: ["كلمة١", "كلمة٢", "كلمة٣", "كلمة٤"] }];
const NEW_PASSAGE: readonly MockAyah[] = [
  { unit: 1, words: ["كلمة١", "كلمة٢", "كلمة٣", "كلمة٤"] },
  { unit: 2, words: ["كلمة٥", "كلمة٦", "كلمة٧", "كلمة٨"] },
];
const source = mockSource;

const policy = { normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1" } as const;

function buildSteps(): Step[] {
  const review: Question = {
    questionId: MOCK_QUESTION_IDS.review,
    type: "word_choice",
    variant: "word",
    passageId: MOCK_REVIEW_PASSAGE_ID,
    role: "review",
    reviewRoundId: MOCK_REVIEW_ROUND_ID,
    context: mockContext(REVIEW_PASSAGE, "1:1"),
    policy,
    source: source("1:1", "سورة اصطناعية، الآية ١"),
    options: [
      { optionId: "opt-a", text: "كلمة٢" },
      { optionId: "opt-b", text: "كلمة٤" },
      { optionId: "opt-c", text: "كلمة٥" },
      { optionId: "opt-d", text: "كلمة٦" },
    ],
    answerKey: { optionId: "opt-a" },
  };
  const training = { passageId: MOCK_NEW_PASSAGE_ID, role: "training", reviewRoundId: null, policy, source: source("2:1") } as const;
  const order: Question = {
    ...training,
    questionId: MOCK_QUESTION_IDS.order,
    type: "word_order",
    context: mockContext(NEW_PASSAGE, "1:1", "1:3"),
    tokens: [
      { ref: "1:2", text: "كلمة٣" },
      { ref: "1:1", text: "كلمة٢" },
      { ref: "1:3", text: "كلمة٤" },
    ],
    answerKey: { order: ["1:1", "1:2", "1:3"] },
  };
  const segment: Question = {
    ...training,
    questionId: MOCK_QUESTION_IDS.segment,
    type: "word_choice",
    variant: "segment",
    context: mockContext(NEW_PASSAGE, "1:2", "1:3"),
    options: [
      { optionId: "seg-a", text: "كلمة٣ كلمة٤" },
      { optionId: "seg-b", text: "كلمة٧ كلمة٨" },
      { optionId: "seg-c", text: "كلمة٥ كلمة٦" },
    ],
    answerKey: { optionId: "seg-a" },
  };
  const recall: Question = {
    ...training,
    questionId: MOCK_QUESTION_IDS.recall,
    type: "word_recall",
    context: mockContext(NEW_PASSAGE, "2:1"),
    hintFirstLetter: MOCK_RECALL_WORD.charAt(0),
    answerKey: { acceptedNorms: [normalizeArabicWord(MOCK_RECALL_WORD)] },
  };
  const similar: Question = {
    ...training,
    questionId: MOCK_QUESTION_IDS.similar,
    type: "similar_distinction",
    context: mockContext(NEW_PASSAGE, "2:1"),
    options: [
      { optionId: "sim-a", text: "متشابه١" },
      { optionId: "sim-b", text: "متشابه٢" },
    ],
    answerKey: { optionId: "sim-a" },
  };
  const test: Question = {
    questionId: MOCK_QUESTION_IDS.test,
    type: "word_choice",
    variant: "word",
    passageId: MOCK_NEW_PASSAGE_ID,
    role: "test",
    reviewRoundId: null,
    context: mockContext(NEW_PASSAGE, "2:1"),
    policy,
    source: source("2:2"),
    options: [
      { optionId: "t-a", text: "كلمة٦" },
      { optionId: "t-b", text: "كلمة٨" },
      { optionId: "t-c", text: "كلمة٩" },
      { optionId: "t-d", text: "كلمة١٠" },
    ],
    answerKey: { optionId: "t-a" },
  };
  return [
    { type: "question", question: review },
    {
      type: "learn",
      passage: {
        passageId: MOCK_NEW_PASSAGE_ID,
        path: "quran",
        reference: "2:1-2",
        referenceAr: "سورة اصطناعية، الآيات ١\u2013٢",
        sectionTitleAr: "اسم القسم (عنصر نائب) ٢",
        units: [
          { unitRef: 1, kind: "ayah", reference: "2:1", text: "كلمة١ كلمة٢ كلمة٣ كلمة٤" },
          { unitRef: 2, kind: "ayah", reference: "2:2", text: "كلمة٥ كلمة٦ كلمة٧ كلمة٨" },
        ],
        highlight: { startRef: "1:1", endRef: "2:1" },
        takhrij: null,
        grade: null,
        showD50Notice: false,
        source: source("2:1-2"),
      },
    },
    { type: "question", question: order },
    { type: "question", question: segment },
    { type: "question", question: recall },
    { type: "question", question: similar },
    { type: "question", question: test },
  ];
}

export function mockSessionSnapshot(sessionId: string, planId: string, planVersion: number, editionId: string): SessionSnapshot {
  return {
    sessionId,
    kind: "daily",
    planId,
    planVersion,
    editionId,
    bankVersion: 1,
    learningDate: mockToday.learningDate,
    status: "open",
    steps: buildSteps(),
    createdAt: "2026-10-05T07:00:00Z",
  };
}

interface AnswerLog {
  clientEventId: string;
  questionId: string;
  passageId: string;
  role: Question["role"];
  correct: boolean;
  assisted: boolean;
}

interface SessionRecord {
  snapshot: SessionSnapshot;
  answers: AnswerLog[];
  intervals: [number, number][];
  streaks: Map<string, number>;
  completed: CompleteResponse | null;
}

interface SessionStore {
  sessions: Map<string, SessionRecord>;
  acknowledged: Set<string>; // ids are unique per account, across sessions
  created: number;
}

const stores = new WeakMap<MockScenario, SessionStore>();

function storeOf(scenario: MockScenario): SessionStore {
  let store = stores.get(scenario);
  if (store === undefined) {
    store = { sessions: new Map(), acknowledged: new Set(), created: 0 };
    stores.set(scenario, store);
  }
  return store;
}

const questionsOf = (snapshot: SessionSnapshot): Question[] => snapshot.steps.flatMap((step) => (step.type === "question" ? [step.question] : []));

function unionMs(intervals: readonly [number, number][]): number {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let reachedEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (end <= reachedEnd) continue;
    total += end - Math.max(start, reachedEnd);
    reachedEnd = end;
  }
  return total;
}

// The figures of the day: the E18 fixture's active time plus the verified intervals of every session of this mock (the union, never a sum).
function dailyOf(store: SessionStore): DailyProgress {
  const all = [...store.sessions.values()].flatMap((record) => record.intervals);
  const active = mockToday.dailyActiveMs + unionMs(all);
  const goal = mockToday.dailyGoalMs;
  return {
    learningDate: mockToday.learningDate,
    dailyActiveMs: active,
    dailyGoalMs: goal,
    dailyPercent: Math.min(100, Math.floor((active * 100) / goal)),
    dailyCompleted: active >= goal,
    extraActiveMs: Math.max(0, active - goal),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function answerShape(value: unknown): AnswerPayload | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.order) && value.order.every((ref) => typeof ref === "string")) return { order: value.order as string[] };
  if (typeof value.optionId === "string") return { optionId: value.optionId };
  if (typeof value.text === "string") return { text: value.text };
  return null;
}

type Graded = { correct: boolean; expected: AnswerResult["expected"] } | null;

// null: the payload does not fit the question type (`invalid_answer_shape`).
function grade(question: Question, payload: AnswerPayload): Graded {
  switch (question.type) {
    case "word_order": {
      if (!("order" in payload)) return null;
      const key = question.answerKey.order;
      return { correct: payload.order.length === key.length && payload.order.every((ref, index) => ref === key[index]), expected: { order: key } };
    }
    case "word_choice":
    case "similar_distinction":
      if (!("optionId" in payload)) return null;
      return { correct: payload.optionId === question.answerKey.optionId, expected: { optionId: question.answerKey.optionId } };
    case "word_recall":
      if (!("text" in payload)) return null;
      return { correct: question.answerKey.acceptedNorms.includes(normalizeArabicWord(payload.text)), expected: { word: MOCK_RECALL_WORD } };
  }
}

const FORBIDDEN_EVENT_FIELDS = ["correct", "userId", "mode"] as const;

type Parsed = { ok: true; events: Record<string, unknown>[] } | { ok: false; response: MockResponse };

function parseEvents(body: unknown): Parsed {
  if (!isRecord(body) || !Array.isArray(body.events)) return { ok: false, response: validation([{ field: "events", rule: "invalid_type" }]) };
  const extra = Object.keys(body).filter((field) => field !== "events");
  if (extra.length > 0) return { ok: false, response: validation(extra.map((field) => ({ field, rule: "forbidden_field" }))) };
  if (body.events.length === 0) return { ok: false, response: validation([{ field: "events", rule: "events_empty" }]) };
  if (body.events.length > 100) return { ok: false, response: validation([{ field: "events", rule: "events_too_many" }]) };
  const problems: { field: string; rule: string }[] = [];
  body.events.forEach((event: unknown, position) => {
    if (!isRecord(event)) {
      problems.push({ field: `events[${position}]`, rule: "invalid_type" });
      return;
    }
    for (const field of FORBIDDEN_EVENT_FIELDS) if (field in event) problems.push({ field: `events[${position}].${field}`, rule: "forbidden_field" });
    if (typeof event.clientEventId !== "string" || !UUID.test(event.clientEventId)) problems.push({ field: `events[${position}].clientEventId`, rule: "invalid_uuid" });
    if (event.type === "answer") {
      if (typeof event.questionId !== "string") problems.push({ field: `events[${position}].questionId`, rule: "invalid_type" });
      if (answerShape(event.answer) === null) problems.push({ field: `events[${position}].answer`, rule: "invalid_answer_shape" });
      if (typeof event.hintUsed !== "boolean") problems.push({ field: `events[${position}].hintUsed`, rule: "invalid_type" });
      if (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) problems.push({ field: `events[${position}].occurredAt`, rule: "invalid_datetime" });
      if (typeof event.durationMs !== "number" || !Number.isInteger(event.durationMs) || event.durationMs < 0) problems.push({ field: `events[${position}].durationMs`, rule: "invalid_type" });
      else if (event.durationMs > MAX_SPAN_MS) problems.push({ field: `events[${position}].durationMs`, rule: "less_than_equal" });
    } else if (event.type === "activity") {
      for (const field of ["startedAt", "endedAt"] as const) {
        const value = event[field];
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) problems.push({ field: `events[${position}].${field}`, rule: "invalid_datetime" });
      }
      if (typeof event.activeMs !== "number" || !Number.isInteger(event.activeMs) || event.activeMs < 0) problems.push({ field: `events[${position}].activeMs`, rule: "invalid_type" });
    } else {
      problems.push({ field: `events[${position}].type`, rule: "invalid_type" });
    }
  });
  return problems.length > 0 ? { ok: false, response: validation(problems) } : { ok: true, events: body.events as Record<string, unknown>[] };
}

const createSession: MockHandler = (request, scenario) => {
  // The body, the plan, its state and its version are judged by the E20 handler of S-11; only the snapshot differs.
  const base = todayMockHandlers["POST /sessions"];
  if (base === undefined) return failure(500, "internal", "The mock has no E20 handler.");
  const answer = base(request, scenario);
  if (answer.status !== 201) return answer;
  const store = storeOf(scenario);
  const open = [...store.sessions.values()].find((record) => record.completed === null);
  // An open daily session is returned as it is (200): nothing is written (API-spec E20).
  if (open !== undefined) return { status: 200, body: open.snapshot };
  const seed = answer.body as SessionSnapshot;
  store.created += 1;
  const snapshot = mockSessionSnapshot(`${SESSION_ID_PREFIX}${store.created}`, seed.planId ?? "", seed.planVersion ?? 1, seed.editionId);
  store.sessions.set(snapshot.sessionId, { snapshot, answers: [], intervals: [], streaks: new Map(), completed: null });
  return { status: 201, body: snapshot };
};

function applyEvents(record: SessionRecord, store: SessionStore, events: Record<string, unknown>[], scenario: MockScenario): EventsResponse {
  const response: EventsResponse = { acknowledged: [], duplicate: [], pending: [], rejected: [], results: [], daily: dailyOf(store) };
  const questions = new Map(questionsOf(record.snapshot).map((question) => [question.questionId, question]));
  for (const event of events) {
    const id = event.clientEventId as string;
    if (store.acknowledged.has(id)) {
      response.duplicate.push(id);
      continue;
    }
    if (record.completed !== null) {
      response.rejected.push({ clientEventId: id, code: "session_closed" });
      continue;
    }
    if (!scenario.hasPlan) {
      response.rejected.push({ clientEventId: id, code: "plan_not_active" });
      continue;
    }
    if (event.type === "activity") {
      const start = Date.parse(event.startedAt as string);
      const end = Date.parse(event.endedAt as string);
      const activeMs = event.activeMs as number;
      if (end < start || end - start > MAX_SPAN_MS || activeMs > end - start + 1000) {
        response.rejected.push({ clientEventId: id, code: "activity_out_of_bounds" });
        continue;
      }
      record.intervals.push([start, start + Math.min(activeMs, end - start)]);
      store.acknowledged.add(id);
      response.acknowledged.push(id);
      continue;
    }
    const question = questions.get(event.questionId as string);
    if (question === undefined) {
      response.rejected.push({ clientEventId: id, code: "question_not_in_session" });
      continue;
    }
    const payload = answerShape(event.answer);
    const graded = payload === null ? null : grade(question, payload);
    if (graded === null) {
      response.rejected.push({ clientEventId: id, code: "invalid_answer_shape" });
      continue;
    }
    const assisted = event.hintUsed === true;
    store.acknowledged.add(id);
    record.answers.push({ clientEventId: id, questionId: question.questionId, passageId: question.passageId, role: question.role, correct: graded.correct, assisted });
    // An assisted answer covers no part and changes no streak; a wrong one starts the count again (D64, D66).
    const before = record.streaks.get(question.passageId) ?? 0;
    const streak = assisted ? before : graded.correct ? before + 1 : 0;
    record.streaks.set(question.passageId, streak);
    const covered = new Set(record.answers.filter((entry) => entry.passageId === question.passageId && entry.role === "training" && entry.correct && !entry.assisted).map((entry) => entry.questionId));
    response.acknowledged.push(id);
    response.results.push({
      clientEventId: id,
      questionId: question.questionId,
      correct: graded.correct,
      assisted,
      expected: graded.expected,
      passage: { passageId: question.passageId, status: question.role === "review" ? "reviewing" : "learning", coveredParts: Math.min(3, covered.size), totalParts: 3, consecutiveCorrect: streak },
    });
  }
  response.daily = dailyOf(store);
  return response;
}

const postEvents: MockHandler = ({ body, params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const record = store.sessions.get(params?.id ?? "");
  if (record === undefined) return failure(404, "not_found", "The session was not found.");
  if (JSON.stringify(body ?? null).length > MAX_BODY_CHARS) return failure(413, "payload_too_large", "The request body is too large.");
  const parsed = parseEvents(body);
  if (!parsed.ok) return parsed.response;
  return { status: 200, body: applyEvents(record, store, parsed.events, scenario) };
};

// A round passes only when every first attempt in it is correct and unassisted (S-6); an unfinished round counts in neither.
function summaryOf(record: SessionRecord): CompleteResponse["summary"] {
  const reviews = questionsOf(record.snapshot).filter((question) => question.role === "review");
  const firstAttempts = reviews.map((question) => record.answers.find((entry) => entry.questionId === question.questionId));
  const finished = reviews.length > 0 && firstAttempts.every((entry) => entry !== undefined);
  const passed = finished && firstAttempts.every((entry) => entry?.correct === true && !entry.assisted);
  return {
    answered: record.answers.length,
    correct: record.answers.filter((entry) => entry.correct).length,
    newPassages: new Set(record.answers.filter((entry) => entry.role !== "review").map((entry) => entry.passageId)).size,
    reviewsPassed: passed ? 1 : 0,
    reviewsFailed: finished && !passed ? 1 : 0,
    activeMs: unionMs(record.intervals),
  };
}

const completeHandler: MockHandler = ({ params }: MockRequest, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const record = store.sessions.get(params?.id ?? "");
  if (record === undefined) return failure(404, "not_found", "The session was not found.");
  // Idempotent: the first call stores the answer and a repeat returns it with no second effect.
  record.completed ??= { summary: summaryOf(record), daily: dailyOf(store) };
  return { status: 200, body: record.completed };
};

// Keys are "METHOD /path", like mockHandlers.
export const sessionMockHandlers: Record<string, MockHandler> = {
  "POST /sessions": createSession,
  "POST /sessions/:id/events": postEvents,
  "POST /sessions/:id/complete": completeHandler,
};
