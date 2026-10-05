// Mock handlers for E20 `game` (S-14 to S-18) and what hangs on it: E21 and E22 of a game round. Synthetic data only: the words are placeholders
// («كلمة١»), never a verse or a hadith. The shared handlers know `daily` sessions alone and hold no game round, so these sit beside them:
// `withGameMock(handlers)` returns the same handlers with the three keys below taking the game cases and passing every other request to the handler
// that was there before. It layers over any other wrapper:
//   createMockFetch({ handlers: withGameMock(withPlacementMock(mockHandlers)) })
// State lives per mock scenario, so every mock fetch starts clean. A game round adds its verified active time to the day (D40), never a completion by itself.
import { normalizeArabicWord } from "@/components/session/arabic-norm";
import type { AnswerPayload, AnswerResult, CompleteResponse, DailyProgress, EventsResponse, GameKind, Question, SessionSnapshot } from "../types";
import { MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockToday } from "./fixtures";
import type { MockHandler, MockRequest, MockResponse, MockScenario } from "./handlers";
import { mockContext, mockSource, type MockAyah } from "./question-fixtures";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => failure(422, "validation_error", "The request body is not valid.", { fields });
const notFound = (): MockResponse => failure(404, "not_found", "The session was not found.");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_SPAN_MS = 30 * 60 * 1000;

export const MOCK_GAME_SESSION_PREFIX = "99999999-9999-4999-8999-1000000000";

// The target of the recall questions as the book has it; the answer key keeps only its normalised form.
export const MOCK_GAME_RECALL_WORDS = ["كلمة٦", "كلمة٩"] as const;

const GAME_KINDS: readonly GameKind[] = ["word_order", "word_choice", "similar_distinction", "word_recall"];

const source = (reference: string) => mockSource(reference, "سورة اصطناعية، الآية ١");
// The whole placeholder passage of each question, as the server sends it (D90).
const PASSAGE_1: readonly MockAyah[] = [{ unit: 1, words: ["كلمة١", "كلمة٢", "كلمة٣", "كلمة٤", "كلمة٥"] }];
const PASSAGE_2: readonly MockAyah[] = [{ unit: 2, words: ["كلمة٥", "كلمة٦", "كلمة٧", "كلمة٨"] }];
const policy = { normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1" } as const;
const base = { role: "game", reviewRoundId: null, policy } as const;

const ids = (kind: string, position: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-${kind}${String(position).padStart(12 - kind.length, "0")}`;
const passage = (position: number): string => `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${position}`;

// Two questions per game: enough to show the counter, the last-question label and the result (a real round has up to 10).
export function mockGameQuestions(kind: GameKind): Question[] {
  switch (kind) {
    case "word_order":
      return [
        {
          ...base,
          questionId: ids("a1", 1),
          type: "word_order",
          passageId: passage(1),
          context: mockContext(PASSAGE_1, "1:1", "1:3"),
          source: source("1:1"),
          tokens: [
            { ref: "1:3", text: "كلمة٤" },
            { ref: "1:1", text: "كلمة٢" },
            { ref: "1:2", text: "كلمة٣" },
          ],
          answerKey: { order: ["1:1", "1:2", "1:3"] },
        },
        {
          ...base,
          questionId: ids("a1", 2),
          type: "word_order",
          passageId: passage(2),
          context: mockContext(PASSAGE_2, "2:1", "2:3"),
          source: source("2:1"),
          tokens: [
            { ref: "2:2", text: "كلمة٧" },
            { ref: "2:1", text: "كلمة٦" },
            { ref: "2:3", text: "كلمة٨" },
          ],
          answerKey: { order: ["2:1", "2:2", "2:3"] },
        },
      ];
    case "word_choice":
      return [
        {
          ...base,
          questionId: ids("b1", 1),
          type: "word_choice",
          variant: "word",
          passageId: passage(1),
          context: mockContext(PASSAGE_1, "1:1"),
          source: source("1:1"),
          options: [
            { optionId: "w-a", text: "كلمة٢" },
            { optionId: "w-b", text: "كلمة٤" },
            { optionId: "w-c", text: "كلمة٥" },
            { optionId: "w-d", text: "كلمة٦" },
          ],
          answerKey: { optionId: "w-a" },
        },
        {
          ...base,
          questionId: ids("b1", 2),
          type: "word_choice",
          variant: "segment",
          passageId: passage(2),
          context: mockContext(PASSAGE_2, "2:2", "2:3"),
          source: source("2:1"),
          options: [
            { optionId: "s-a", text: "كلمة٣ كلمة٤" },
            { optionId: "s-b", text: "كلمة٧ كلمة٨" },
            { optionId: "s-c", text: "كلمة٥ كلمة٦" },
          ],
          answerKey: { optionId: "s-a" },
        },
      ];
    case "similar_distinction":
      return [
        {
          ...base,
          questionId: ids("c1", 1),
          type: "similar_distinction",
          passageId: passage(1),
          context: mockContext(PASSAGE_1, "1:1"),
          source: source("1:1"),
          options: [
            { optionId: "m-a", text: "متشابه١" },
            { optionId: "m-b", text: "متشابه٢" },
          ],
          answerKey: { optionId: "m-a" },
        },
        {
          ...base,
          questionId: ids("c1", 2),
          type: "similar_distinction",
          passageId: passage(2),
          context: mockContext(PASSAGE_2, "2:1"),
          source: source("2:1"),
          options: [
            { optionId: "n-a", text: "متشابه٣" },
            { optionId: "n-b", text: "متشابه٤" },
          ],
          answerKey: { optionId: "n-b" },
        },
      ];
    case "word_recall":
      return MOCK_GAME_RECALL_WORDS.map((word, position): Question => ({
        ...base,
        questionId: ids("d1", position + 1),
        type: "word_recall",
        passageId: passage(position + 1),
        context: mockContext([{ unit: position + 1, words: ["كلمة٥", word, "كلمة٧", "كلمة٨"] }], `${position + 1}:1`),
        source: source(`${position + 1}:1`),
        hintFirstLetter: word.charAt(0),
        answerKey: { acceptedNorms: [normalizeArabicWord(word)] },
      }));
  }
}

interface AnswerLog {
  questionId: string;
  correct: boolean;
  assisted: boolean;
}

interface GameRecord {
  snapshot: SessionSnapshot;
  gameType: GameKind;
  answers: AnswerLog[];
  intervals: [number, number][];
  completed: CompleteResponse | null;
}

interface GameStore {
  sessions: Map<string, GameRecord>;
  acknowledged: Set<string>;
}

const stores = new WeakMap<MockScenario, GameStore>();

function storeOf(scenario: MockScenario): GameStore {
  let store = stores.get(scenario);
  if (store === undefined) {
    store = { sessions: new Map(), acknowledged: new Set() };
    stores.set(scenario, store);
  }
  return store;
}

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

// The figures of the day: the E18 fixture's active time plus the verified intervals of every game round of this mock (the union, never a sum).
function dailyOf(store: GameStore): DailyProgress {
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

const GAME_FIELDS: readonly string[] = ["kind", "planId", "expectedPlanVersion", "gameType", "passageIds"];

export interface GameMockOptions {
  // Games whose E20 answers 201 with no question step (G-26, P-24): nothing eligible to play.
  empty?: readonly GameKind[];
}

// E20 `game` (API-spec 4.7) answers in the order of the contract: the body shape, then the plan, then its state, then its version. A valid body always
// creates a round (never a get-or-create), so a repeat press gives a new session.
function createGame(options: GameMockOptions): MockHandler {
  return ({ body }, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    const fields = isRecord(body) ? body : {};
    const forbidden = Object.keys(fields)
      .filter((field) => !GAME_FIELDS.includes(field))
      .map((field) => ({ field, rule: "forbidden_field" }));
    if (forbidden.length > 0) return validation(forbidden);
    const rules: { field: string; rule: string }[] = [];
    if (typeof fields.planId !== "string") rules.push({ field: "planId", rule: "invalid_type" });
    if (typeof fields.expectedPlanVersion !== "number") rules.push({ field: "expectedPlanVersion", rule: "invalid_type" });
    if (typeof fields.gameType !== "string") rules.push({ field: "gameType", rule: "invalid_type" });
    else if (!GAME_KINDS.includes(fields.gameType as GameKind)) rules.push({ field: "gameType", rule: "game_type_invalid" });
    if (rules.length > 0) return validation(rules);
    if (fields.planId !== MOCK_PLAN_ID) return notFound();
    const plan = mockToday.plan;
    if (!scenario.hasPlan || plan === null) return failure(409, "version_conflict", "The plan is not active.", { reason: "plan_not_active" });
    if (fields.expectedPlanVersion !== plan.currentVersion) {
      return failure(409, "version_conflict", "The plan was changed.", { reason: "plan_version", currentVersion: plan.currentVersion });
    }

    const gameType = fields.gameType as GameKind;
    const store = storeOf(scenario);
    const sessionId = `${MOCK_GAME_SESSION_PREFIX}${String(store.sessions.size + 1).padStart(2, "0")}`;
    const snapshot: SessionSnapshot = {
      sessionId,
      kind: "game",
      planId: MOCK_PLAN_ID,
      planVersion: plan.currentVersion,
      editionId: MOCK_QURAN_EDITION_ID,
      bankVersion: 1,
      learningDate: mockToday.learningDate,
      status: "open",
      steps: (options.empty?.includes(gameType) ? [] : mockGameQuestions(gameType)).map((question) => ({ type: "question" as const, question })),
      createdAt: "2026-10-05T07:00:00Z",
    };
    store.sessions.set(sessionId, { snapshot, gameType, answers: [], intervals: [], completed: null });
    return { status: 201, body: snapshot };
  };
}

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
    case "word_recall": {
      if (!("text" in payload)) return null;
      const position = question.passageId.endsWith("2") ? 1 : 0;
      return { correct: question.answerKey.acceptedNorms.includes(normalizeArabicWord(payload.text)), expected: { word: MOCK_GAME_RECALL_WORDS[position] ?? MOCK_GAME_RECALL_WORDS[0] } };
    }
    case "word_order":
      if (!("order" in payload)) return null;
      return {
        correct: payload.order.length === question.answerKey.order.length && payload.order.every((ref, position) => ref === question.answerKey.order[position]),
        expected: { order: question.answerKey.order },
      };
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
    if (event.type === "answer") {
      if (typeof event.questionId !== "string") problems.push({ field: `${at}.questionId`, rule: "invalid_type" });
      if (answerShape(event.answer) === null) problems.push({ field: `${at}.answer`, rule: "invalid_answer_shape" });
      if (typeof event.hintUsed !== "boolean") problems.push({ field: `${at}.hintUsed`, rule: "invalid_type" });
      if (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) problems.push({ field: `${at}.occurredAt`, rule: "invalid_datetime" });
      if (typeof event.durationMs !== "number" || !Number.isInteger(event.durationMs) || event.durationMs < 0) problems.push({ field: `${at}.durationMs`, rule: "invalid_type" });
      else if (event.durationMs > MAX_SPAN_MS) problems.push({ field: `${at}.durationMs`, rule: "less_than_equal" });
    } else if (event.type === "activity") {
      for (const field of ["startedAt", "endedAt"] as const) {
        const value = event[field];
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) problems.push({ field: `${at}.${field}`, rule: "invalid_datetime" });
      }
      if (typeof event.activeMs !== "number" || !Number.isInteger(event.activeMs) || event.activeMs < 0) problems.push({ field: `${at}.activeMs`, rule: "invalid_type" });
    } else {
      problems.push({ field: `${at}.type`, rule: "invalid_type" });
    }
  });
  return problems.length > 0 ? { ok: false, response: validation(problems) } : { ok: true, events: body.events as Record<string, unknown>[] };
}

// E21: the first accepted payload of a `clientEventId` wins and a repeat is a `duplicate`; an answer is graded like the server does (answer key and
// `arabic-norm-v1`), every event gets exactly one outcome, and the answer carries `daily`. An assisted answer covers no part (D66).
const postEvents: MockHandler = ({ body, params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const record = store.sessions.get(params?.id ?? "");
  if (record === undefined) return notFound();
  const parsed = parseEvents(body);
  if (!parsed.ok) return parsed.response;
  const response: EventsResponse = { acknowledged: [], duplicate: [], pending: [], rejected: [], results: [], daily: dailyOf(store) };
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
    record.answers.push({ questionId: question.questionId, correct: graded.correct, assisted });
    response.acknowledged.push(id);
    response.results.push({
      clientEventId: id,
      questionId: question.questionId,
      correct: graded.correct,
      assisted,
      expected: graded.expected,
      passage: { passageId: question.passageId, status: "learning", coveredParts: graded.correct && !assisted ? 1 : 0, totalParts: 3, consecutiveCorrect: 0 },
    });
  }
  response.daily = dailyOf(store);
  return { status: 200, body: response };
};

// E22: idempotent, so a repeat returns the stored answer. It adds no time and creates no daily completion.
const completeGame: MockHandler = ({ params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const record = store.sessions.get(params?.id ?? "");
  if (record === undefined) return notFound();
  record.completed ??= {
    summary: {
      answered: record.answers.length,
      correct: record.answers.filter((entry) => entry.correct).length,
      newPassages: 0,
      reviewsPassed: 0,
      reviewsFailed: 0,
      activeMs: unionMs(record.intervals),
    },
    daily: dailyOf(store),
  };
  return { status: 200, body: record.completed };
};

function taking(own: MockHandler, previous: MockHandler | undefined, isGame: (request: MockRequest, scenario: MockScenario) => boolean): MockHandler {
  return (request, scenario) => (previous === undefined || isGame(request, scenario) ? own(request, scenario) : previous(request, scenario));
}

export function withGameMock(handlers: Readonly<Record<string, MockHandler>>, options: GameMockOptions = {}): Record<string, MockHandler> {
  const holds = (request: MockRequest, scenario: MockScenario): boolean => storeOf(scenario).sessions.has(request.params?.id ?? "");
  return {
    ...handlers,
    "POST /sessions": taking(createGame(options), handlers["POST /sessions"], ({ body }) => isRecord(body) && body.kind === "game"),
    "POST /sessions/:id/events": taking(postEvents, handlers["POST /sessions/:id/events"], holds),
    "POST /sessions/:id/complete": taking(completeGame, handlers["POST /sessions/:id/complete"], holds),
  };
}
