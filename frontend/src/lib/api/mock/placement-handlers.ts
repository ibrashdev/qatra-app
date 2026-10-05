// Mock handlers for E20 `placement` (S-09) and what hangs on it: E21 and E22 of a placement session, and E31 with `placementSessionId`. Synthetic data only: the
// words are placeholders («كلمة١»), never a verse or a hadith. The shared handlers know `daily` sessions alone and hold no placement session, so these sit
// beside them: `withPlacementMock(handlers)` returns the same handlers with the four keys below taking the placement cases and passing every other
// request to the handler that was there before.
//   createMockFetch({ handlers: withPlacementMock(mockHandlers) })
// State lives per mock scenario, so every mock fetch starts clean. A placement session never adds to the day (it is never counted in daily time).
import { normalizeArabicWord } from "@/components/session/arabic-norm";
import type { AnswerPayload, AnswerResult, CompleteResponse, DailyProgress, EventsResponse, Question, SessionSnapshot, SourceRef } from "../types";
import { mockCatalog, mockToday } from "./fixtures";
import type { MockHandler, MockRequest, MockResponse, MockScenario } from "./handlers";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => failure(422, "validation_error", "The request body is not valid.", { fields });
const notFound = (): MockResponse => failure(404, "not_found", "The session was not found.");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_SPAN_MS = 30 * 60 * 1000;

const SESSION_ID_PREFIX = "99999999-9999-4999-8999-0000000000";

export const MOCK_PLACEMENT_QUESTION_IDS = {
  choice: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  recall: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
  segment: "aaaaaaaa-aaaa-4aaa-8aaa-000000000003",
} as const;

// The target of the recall question as the book has it; the answer key keeps only its normalised form.
export const MOCK_PLACEMENT_RECALL_WORD = "كلمة٨";

const source = (reference: string): SourceRef => ({ publisher: "ناشر اصطناعي", editionLabel: "نسخة اصطناعية", bookTitleAr: "كتاب اصطناعي", reference, url: "https://example.invalid/ref/1", pages: [] });
const policy = { normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1" } as const;

function buildQuestions(): Question[] {
  const placement = { reviewRoundId: null, role: "placement", policy } as const;
  return [
    {
      ...placement,
      questionId: MOCK_PLACEMENT_QUESTION_IDS.choice,
      type: "word_choice",
      variant: "word",
      passageId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
      context: { before: [{ ref: "1:0", text: "كلمة١" }], after: [{ ref: "1:2", text: "كلمة٣" }] },
      source: source("1:1"),
      options: [
        { optionId: "p-a", text: "كلمة٢" },
        { optionId: "p-b", text: "كلمة٤" },
        { optionId: "p-c", text: "كلمة٥" },
        { optionId: "p-d", text: "كلمة٦" },
      ],
      answerKey: { optionId: "p-a" },
    },
    {
      ...placement,
      questionId: MOCK_PLACEMENT_QUESTION_IDS.recall,
      type: "word_recall",
      passageId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
      context: { before: [{ ref: "2:0", text: "كلمة٧" }], after: [{ ref: "2:2", text: "كلمة٩" }] },
      source: source("2:1"),
      hintFirstLetter: MOCK_PLACEMENT_RECALL_WORD.charAt(0),
      answerKey: { acceptedNorms: [normalizeArabicWord(MOCK_PLACEMENT_RECALL_WORD)] },
    },
    {
      ...placement,
      questionId: MOCK_PLACEMENT_QUESTION_IDS.segment,
      type: "word_choice",
      variant: "word",
      passageId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
      context: { before: [{ ref: "3:0", text: "كلمة١٠" }], after: [{ ref: "3:2", text: "كلمة١٢" }] },
      source: source("3:1"),
      options: [
        { optionId: "q-a", text: "كلمة١١" },
        { optionId: "q-b", text: "كلمة١٣" },
        { optionId: "q-c", text: "كلمة١٤" },
        { optionId: "q-d", text: "كلمة١٥" },
      ],
      answerKey: { optionId: "q-a" },
    },
  ];
}

interface PlacementRecord {
  snapshot: SessionSnapshot;
  answers: { questionId: string; correct: boolean }[];
  completed: CompleteResponse | null;
}

interface PlacementStore {
  sessions: Map<string, PlacementRecord>;
  acknowledged: Set<string>;
}

const stores = new WeakMap<MockScenario, PlacementStore>();

function storeOf(scenario: MockScenario): PlacementStore {
  let store = stores.get(scenario);
  if (store === undefined) {
    store = { sessions: new Map(), acknowledged: new Set() };
    stores.set(scenario, store);
  }
  return store;
}

// A placement session adds nothing to the day, so the figures are the fixture's own.
const daily = (): DailyProgress => ({
  learningDate: mockToday.learningDate,
  dailyActiveMs: mockToday.dailyActiveMs,
  dailyGoalMs: mockToday.dailyGoalMs,
  dailyPercent: mockToday.dailyPercent,
  dailyCompleted: mockToday.dailyCompleted,
  extraActiveMs: mockToday.extraActiveMs,
});

const SELF_RATINGS: readonly unknown[] = ["none", "some", "most"];
const PLACEMENT_FIELDS: readonly string[] = ["kind", "editionId", "targetScope", "selfRating"];

// E20 `placement` (API-spec 4.7): the body is validated in the order of the contract, and a valid one always creates a session.
const createPlacement: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const fields = isRecord(body) ? body : {};
  const forbidden = Object.keys(fields)
    .filter((field) => !PLACEMENT_FIELDS.includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  if (forbidden.length > 0) return validation(forbidden);
  if (fields.kind !== "placement") return validation([{ field: "kind", rule: "kind_invalid" }]);
  const edition = mockCatalog.editions.find((candidate) => candidate.editionId === fields.editionId);
  if (edition === undefined) return validation([{ field: "editionId", rule: "edition_not_available" }]);
  const rules: { field: string; rule: string }[] = [];
  const ordinals = isRecord(fields.targetScope) ? fields.targetScope.sectionOrdinals : undefined;
  const known = edition.sections.map((section) => section.ordinal);
  if (!Array.isArray(ordinals) || ordinals.length === 0 || ordinals.length > 60 || !ordinals.every((ordinal) => typeof ordinal === "number" && known.includes(ordinal))) {
    rules.push({ field: "targetScope", rule: "scope_invalid" });
  }
  if (fields.selfRating !== undefined && !SELF_RATINGS.includes(fields.selfRating)) rules.push({ field: "selfRating", rule: "self_rating_invalid" });
  if (rules.length > 0) return validation(rules);

  const store = storeOf(scenario);
  const sessionId = `${SESSION_ID_PREFIX}${String(store.sessions.size + 1).padStart(2, "0")}`;
  const snapshot: SessionSnapshot = {
    sessionId,
    kind: "placement",
    planId: null,
    planVersion: null,
    editionId: edition.editionId,
    bankVersion: 1,
    learningDate: mockToday.learningDate,
    status: "open",
    steps: buildQuestions().map((question) => ({ type: "question" as const, question })),
    createdAt: "2026-10-05T07:00:00Z",
  };
  store.sessions.set(sessionId, { snapshot, answers: [], completed: null });
  return { status: 201, body: snapshot };
};

const questionsOf = (snapshot: SessionSnapshot): Question[] => snapshot.steps.flatMap((step) => (step.type === "question" ? [step.question] : []));

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
    case "word_choice":
    case "similar_distinction":
      if (!("optionId" in payload)) return null;
      return { correct: payload.optionId === question.answerKey.optionId, expected: { optionId: question.answerKey.optionId } };
    case "word_recall":
      if (!("text" in payload)) return null;
      return { correct: question.answerKey.acceptedNorms.includes(normalizeArabicWord(payload.text)), expected: { word: MOCK_PLACEMENT_RECALL_WORD } };
    case "word_order":
      if (!("order" in payload)) return null;
      return { correct: payload.order.length === question.answerKey.order.length && payload.order.every((ref, position) => ref === question.answerKey.order[position]), expected: { order: question.answerKey.order } };
  }
}

type Parsed = { ok: true; events: Record<string, unknown>[] } | { ok: false; response: MockResponse };

function parseEvents(body: unknown): Parsed {
  if (!isRecord(body) || !Array.isArray(body.events)) return { ok: false, response: validation([{ field: "events", rule: "invalid_type" }]) };
  const extra = Object.keys(body).filter((field) => field !== "events");
  if (extra.length > 0) return { ok: false, response: validation(extra.map((field) => ({ field, rule: "forbidden_field" }))) };
  if (body.events.length === 0) return { ok: false, response: validation([{ field: "events", rule: "events_empty" }]) };
  if (body.events.length > 100) return { ok: false, response: validation([{ field: "events", rule: "events_too_many" }]) };
  const problems: { field: string; rule: string }[] = [];
  body.events.forEach((event: unknown, position) => {
    const at = `events[${position}]`;
    if (!isRecord(event)) {
      problems.push({ field: at, rule: "invalid_type" });
      return;
    }
    if (typeof event.clientEventId !== "string" || !UUID.test(event.clientEventId)) problems.push({ field: `${at}.clientEventId`, rule: "invalid_uuid" });
    if (event.type !== "answer" && event.type !== "activity") {
      problems.push({ field: `${at}.type`, rule: "invalid_type" });
      return;
    }
    if (event.type === "answer") {
      if (typeof event.questionId !== "string") problems.push({ field: `${at}.questionId`, rule: "invalid_type" });
      if (answerShape(event.answer) === null) problems.push({ field: `${at}.answer`, rule: "invalid_answer_shape" });
      if (typeof event.hintUsed !== "boolean") problems.push({ field: `${at}.hintUsed`, rule: "invalid_type" });
      if (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) problems.push({ field: `${at}.occurredAt`, rule: "invalid_datetime" });
      if (typeof event.durationMs !== "number" || !Number.isInteger(event.durationMs) || event.durationMs < 0) problems.push({ field: `${at}.durationMs`, rule: "invalid_type" });
      else if (event.durationMs > MAX_SPAN_MS) problems.push({ field: `${at}.durationMs`, rule: "less_than_equal" });
    }
  });
  return problems.length > 0 ? { ok: false, response: validation(problems) } : { ok: true, events: body.events as Record<string, unknown>[] };
}

// E21: the first accepted payload of a `clientEventId` wins and a repeat is a `duplicate`; an answer is graded like the server does (answer key and
// `arabic-norm-v1`), the active time of an `activity` event is acknowledged and never credited.
const postEvents: MockHandler = ({ body, params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const record = store.sessions.get(params?.id ?? "");
  if (record === undefined) return notFound();
  const parsed = parseEvents(body);
  if (!parsed.ok) return parsed.response;
  const response: EventsResponse = { acknowledged: [], duplicate: [], pending: [], rejected: [], results: [], daily: daily() };
  const questions = new Map(questionsOf(record.snapshot).map((question) => [question.questionId, question]));
  for (const event of parsed.events) {
    const id = event.clientEventId as string;
    if (store.acknowledged.has(id)) {
      response.duplicate.push(id);
      continue;
    }
    if (record.completed !== null) {
      response.rejected.push({ clientEventId: id, code: "session_closed" });
      continue;
    }
    if (event.type === "activity") {
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
    store.acknowledged.add(id);
    record.answers.push({ questionId: question.questionId, correct: graded.correct });
    response.acknowledged.push(id);
    response.results.push({
      clientEventId: id,
      questionId: question.questionId,
      correct: graded.correct,
      assisted: event.hintUsed === true,
      expected: graded.expected,
      passage: { passageId: question.passageId, status: "new", coveredParts: 0, totalParts: 1, consecutiveCorrect: 0 },
    });
  }
  return { status: 200, body: response };
};

// E22: idempotent, so a repeat returns the stored answer. It adds no time and creates no daily completion.
const completePlacement: MockHandler = ({ params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const record = storeOf(scenario).sessions.get(params?.id ?? "");
  if (record === undefined) return notFound();
  record.completed ??= {
    summary: { answered: record.answers.length, correct: record.answers.filter((entry) => entry.correct).length, newPassages: 0, reviewsPassed: 0, reviewsFailed: 0, activeMs: 0 },
    daily: daily(),
  };
  return { status: 200, body: record.completed };
};

// The handlers for placement sessions alone: a session id they do not hold answers 404, so merge them with `withPlacementMock`, which keeps the others.
export const placementMockHandlers: Readonly<Record<string, MockHandler>> = {
  "POST /sessions": createPlacement,
  "POST /sessions/:id/events": postEvents,
  "POST /sessions/:id/complete": completePlacement,
};

function bodyWithout(body: unknown, field: string): unknown {
  if (!isRecord(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));
}

// E31 with `placementSessionId` (API-spec 4.10.1): the session must be the caller's and for the same edition, otherwise `404 not_found`. A known one is taken
// out of the body and the conversation is created by the handler that was there before, which has no placement session of its own.
function conversationWith(previous: MockHandler | undefined): MockHandler {
  return (request: MockRequest, scenario: MockScenario) => {
    if (previous === undefined) return notFound();
    const fields = isRecord(request.body) ? request.body : {};
    if (fields.placementSessionId === undefined) return previous(request, scenario);
    const known = typeof fields.placementSessionId === "string" ? storeOf(scenario).sessions.get(fields.placementSessionId) : undefined;
    if (known === undefined || known.snapshot.editionId !== fields.editionId) return notFound();
    return previous({ ...request, body: bodyWithout(request.body, "placementSessionId") }, scenario);
  };
}

function takingPlacement(own: MockHandler, previous: MockHandler | undefined, isPlacement: (request: MockRequest, scenario: MockScenario) => boolean): MockHandler {
  return (request, scenario) => (previous === undefined || isPlacement(request, scenario) ? own(request, scenario) : previous(request, scenario));
}

export function withPlacementMock(handlers: Readonly<Record<string, MockHandler>>): Record<string, MockHandler> {
  const holds = (request: MockRequest, scenario: MockScenario): boolean => storeOf(scenario).sessions.has(request.params?.id ?? "");
  return {
    ...handlers,
    "POST /sessions": takingPlacement(createPlacement, handlers["POST /sessions"], ({ body }) => isRecord(body) && body.kind === "placement"),
    "POST /sessions/:id/events": takingPlacement(postEvents, handlers["POST /sessions/:id/events"], holds),
    "POST /sessions/:id/complete": takingPlacement(completePlacement, handlers["POST /sessions/:id/complete"], holds),
    "POST /plan-chats": conversationWith(handlers["POST /plan-chats"]),
  };
}
