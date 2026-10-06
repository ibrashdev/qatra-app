// Mock handlers for E23, E24 and E25 of the offline plan (API-spec 4.12, approved with A-04 and A-12; decision G-01 makes `downloadTargetRefs` optional).
// Synthetic data only: the words are placeholders («كلمة١»), never a verse or a hadith, and the ids are fake. Registered with one line each in handlers.ts and
// index.ts:   ...offlineMockHandlers
// The mock keeps the snapshots of one mock session (per scenario), answers a repeated `clientOperationId` with the same snapshot and 200, answers the plan
// version, plan-not-active and idempotency conflicts the way the server does, and lets a test change what E25 says (`mockOfflineControl`). A mock answer
// implies no server acceptance of anything: nothing here is a real snapshot, and no event is graded.
import { gradeLocally } from "@/components/session/local-grade";
import type {
  AnswerPayload,
  AnswerResult,
  CompleteResponse,
  DailyProgress,
  EventsResponse,
  GameKind,
  PassageView,
  PlanSnapshot,
  Question,
  SessionEvent,
  SessionSnapshot,
} from "../types";
import { MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockToday } from "./fixtures";
import { mockGameQuestions } from "./game-handlers";
import type { MockHandler, MockResponse, MockScenario } from "./handlers";
import { mockSessionSnapshot, sessionMockHandlers } from "./session-handlers";

const failure = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });
const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");
const notFound = (): MockResponse => failure(404, "not_found", "The snapshot was not found.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => failure(422, "validation_error", "The request body is not valid.", { fields });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const GAME_KINDS: readonly GameKind[] = ["word_order", "word_choice", "similar_distinction", "word_recall"];

export const MOCK_OFFLINE_USER_ID = "cccccccc-cccc-4ccc-8ccc-000000000001";
export const MOCK_OFFLINE_BANK_VERSION = 1;

const uuid = (kind: string, position: number): string => `dddddddd-dddd-4ddd-8ddd-${kind}${String(position).padStart(12 - kind.length, "0")}`;

// What E25 answers for the snapshots of this mock session. A test sets it before the sync it wants to see.
export interface MockOfflineControl {
  // The plan version the mock server says is current. A bump makes E23 answer 409 `plan_version` and E25 `stale`.
  currentPlanVersion: number;
  // Overrides the E25 status (`revoked` also answers E24 with 404, as the server does for a withdrawn edition).
  status: "available" | "stale" | "revoked" | "expired" | null;
  // The plan stops being active: E23 answers 409 `plan_not_active`.
  planActive: boolean;
  // The edition is not eligible for local download: E23 answers 422 `edition_not_downloadable`.
  downloadable: boolean;
}

interface OfflineStore {
  snapshots: Map<string, PlanSnapshot>;
  // What the mock server acknowledged for the prepared sessions of its snapshots (E21): event ids, the verified intervals of the day, the verdicts.
  acknowledged: Set<string>;
  intervals: [number, number][];
  answers: Map<string, { correct: boolean }[]>;
  byOperation: Map<string, { snapshotId: string; planVersion: number; refs: string }>;
  created: number;
  control: MockOfflineControl;
}

const stores = new WeakMap<MockScenario, OfflineStore>();

function storeOf(scenario: MockScenario): OfflineStore {
  let store = stores.get(scenario);
  if (store === undefined) {
    store = {
      snapshots: new Map(),
      acknowledged: new Set(),
      intervals: [],
      answers: new Map(),
      byOperation: new Map(),
      created: 0,
      control: { currentPlanVersion: mockToday.plan?.currentVersion ?? 1, status: null, planActive: true, downloadable: true },
    };
    stores.set(scenario, store);
  }
  return store;
}

export function mockOfflineControl(scenario: MockScenario): MockOfflineControl {
  return storeOf(scenario).control;
}

const asPrepared = (snapshot: SessionSnapshot): SessionSnapshot => ({ ...snapshot, status: "prepared" });

// A snapshot of the mock plan: the daily descriptor of the mock session (its learn passages become the lessons), one game descriptor per template, and
// every game question, so a device can run all five offline. At most 7 sessions and 60 targets, as the contract caps them.
export function buildMockPlanSnapshot(snapshotId: string, planId: string, planVersion: number, serial: number): PlanSnapshot {
  const editionId = MOCK_QURAN_EDITION_ID;
  const daily = asPrepared({ ...mockSessionSnapshot(uuid("e1", serial), planId, planVersion, editionId), bankVersion: MOCK_OFFLINE_BANK_VERSION });
  const lessons: PassageView[] = daily.steps.flatMap((step) => (step.type === "learn" ? [step.passage] : []));
  const games: Question[] = GAME_KINDS.flatMap((kind) => mockGameQuestions(kind));
  const gameSessions: SessionSnapshot[] = GAME_KINDS.map((kind, position) => ({
    sessionId: uuid("e2", serial * 10 + position + 1),
    kind: "game",
    planId,
    planVersion,
    editionId,
    bankVersion: MOCK_OFFLINE_BANK_VERSION,
    learningDate: mockToday.learningDate,
    status: "prepared",
    steps: mockGameQuestions(kind).map((question) => ({ type: "question", question })),
    createdAt: "2026-10-05T07:00:00Z",
  }));
  return {
    snapshotId,
    schemaVersion: 1,
    protocolVersion: 1,
    userId: MOCK_OFFLINE_USER_ID,
    planId,
    planVersion,
    editionId,
    bankVersion: MOCK_OFFLINE_BANK_VERSION,
    targetScope: mockToday.plan?.targetScope ?? { sectionOrdinals: [1, 2] },
    downloadedTargetRefs: lessons.map((lesson) => lesson.passageId),
    learningTimeZone: "Asia/Dubai",
    dailyGoalMs: mockToday.dailyGoalMs,
    contentHashes: {},
    verifiedAt: new Date().toISOString(),
    contentValidity: { checkedAt: new Date().toISOString(), result: "valid" },
    normalizationPolicyVersion: "arabic-norm-v1",
    scoringPolicyVersion: "v1",
    preparedSessions: [daily, ...gameSessions],
    lessons,
    games,
    references: [],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const E23_FIELDS = ["clientOperationId", "expectedPlanVersion", "downloadTargetRefs"] as const;

// E23 answers in the order of the contract: schema, then the plan and its state, then idempotency, then the version.
const createSnapshot: MockHandler = ({ params, body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const fields = isRecord(body) ? body : {};
  const unknown = Object.keys(fields).filter((field) => !(E23_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0) return validation(unknown.map((field) => ({ field, rule: "forbidden_field" })));
  const broken: { field: string; rule: string }[] = [];
  if (typeof fields.clientOperationId !== "string" || !UUID.test(fields.clientOperationId)) broken.push({ field: "clientOperationId", rule: "client_operation_id_invalid" });
  if (typeof fields.expectedPlanVersion !== "number" || !Number.isInteger(fields.expectedPlanVersion) || fields.expectedPlanVersion < 1) broken.push({ field: "expectedPlanVersion", rule: "invalid_type" });
  const refs = fields.downloadTargetRefs;
  if (refs !== undefined && (!Array.isArray(refs) || refs.length === 0 || refs.length > 60 || refs.some((ref) => typeof ref !== "string") || new Set(refs).size !== refs.length)) {
    broken.push({ field: "downloadTargetRefs", rule: "target_refs_invalid" });
  }
  if (broken.length > 0) return validation(broken);
  if (params?.id !== MOCK_PLAN_ID) return notFound();
  if (!store.control.planActive) return failure(409, "version_conflict", "The plan is not active.", { reason: "plan_not_active", currentVersion: store.control.currentPlanVersion });
  if (!store.control.downloadable) return validation([{ field: "planId", rule: "edition_not_downloadable" }]);

  const operationId = fields.clientOperationId as string;
  const expected = fields.expectedPlanVersion as number;
  const resolved = Array.isArray(refs) ? (refs as string[]).join(",") : "";
  const earlier = store.byOperation.get(operationId);
  if (earlier !== undefined) {
    // The same operation with a different input is a conflict; the same input returns the same snapshot and creates nothing.
    if (earlier.planVersion !== expected || (resolved !== "" && earlier.refs !== "" && earlier.refs !== resolved)) {
      return failure(409, "version_conflict", "The operation id was used with a different input.", { reason: "idempotency_input", currentVersion: store.control.currentPlanVersion });
    }
    const same = store.snapshots.get(earlier.snapshotId);
    return same === undefined ? notFound() : { status: 200, body: same };
  }
  if (expected !== store.control.currentPlanVersion) {
    return failure(409, "version_conflict", "The plan version moved on.", { reason: "plan_version", currentVersion: store.control.currentPlanVersion });
  }

  store.created += 1;
  const snapshotId = uuid("e0", store.created);
  const snapshot = buildMockPlanSnapshot(snapshotId, MOCK_PLAN_ID, expected, store.created);
  store.snapshots.set(snapshotId, snapshot);
  store.byOperation.set(operationId, { snapshotId, planVersion: expected, refs: resolved });
  return { status: 201, body: snapshot };
};

// E24 is read only and never creates a session. A withdrawn edition answers 404 (A-04); the reason is E25's.
const readSnapshot: MockHandler = ({ params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const snapshot = params?.id === undefined ? undefined : store.snapshots.get(params.id);
  if (snapshot === undefined || store.control.status === "revoked") return notFound();
  return { status: 200, body: snapshot };
};

const E25_FIELDS = ["snapshotId", "expectedPlanVersion", "editionId", "bankVersion"] as const;

// E25: the status is in the body, never an HTTP error. `snapshot_mismatch` is a 422 when the device sends values the snapshot does not hold.
const revalidate: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const store = storeOf(scenario);
  const fields = isRecord(body) ? body : {};
  const unknown = Object.keys(fields).filter((field) => !(E25_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0) return validation(unknown.map((field) => ({ field, rule: "forbidden_field" })));
  if (typeof fields.snapshotId !== "string" || typeof fields.expectedPlanVersion !== "number" || typeof fields.editionId !== "string" || typeof fields.bankVersion !== "number") {
    return validation(E25_FIELDS.filter((field) => typeof fields[field] !== (field === "expectedPlanVersion" || field === "bankVersion" ? "number" : "string")).map((field) => ({ field, rule: "invalid_type" })));
  }
  const snapshot = store.snapshots.get(fields.snapshotId);
  if (snapshot === undefined) return notFound();
  if (snapshot.planVersion !== fields.expectedPlanVersion || snapshot.editionId !== fields.editionId || snapshot.bankVersion !== fields.bankVersion) {
    return validation([{ field: "snapshotId", rule: "snapshot_mismatch" }]);
  }
  const { control } = store;
  const stale = control.currentPlanVersion !== snapshot.planVersion || !control.planActive;
  const status = control.status ?? (stale ? "stale" : "available");
  const reasonCode = status === "revoked" ? "content_revoked" : status === "expired" ? "validity_ended" : status === "stale" ? "plan_version_changed" : "current";
  return {
    status: 200,
    body: {
      status,
      currentPlanVersion: control.currentPlanVersion,
      allowedSessionRefs: status === "available" ? snapshot.preparedSessions.map((session) => session.sessionId) : [],
      catalogVersion: MOCK_OFFLINE_BANK_VERSION,
      reasonCode,
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// E21 and E22 for the prepared sessions of the mock snapshots. Any other session id goes to the session mock, which owns the sessions that E20 creates.
// Like the server: an event without the full envelope on a prepared session is rejected (`envelope_mismatch`); a plan that moved on keeps the event
// pending without credit (`plan_changed_unverifiable`, D59); a withdrawn edition rejects it (`edition_mismatch`).
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ENVELOPE_KEYS = ["clientRunId", "snapshotId", "protocolVersion", "planVersion", "editionId", "bankVersion", "normalizationPolicyVersion", "scoringPolicyVersion", "localSequence"] as const;

function sessionOf(store: OfflineStore, sessionId: string): { snapshot: PlanSnapshot; session: SessionSnapshot } | null {
  for (const snapshot of store.snapshots.values()) {
    const session = snapshot.preparedSessions.find((entry) => entry.sessionId === sessionId);
    if (session !== undefined) return { snapshot, session };
  }
  return null;
}

function answerShape(value: unknown): AnswerPayload | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.order) && value.order.every((ref) => typeof ref === "string")) return { order: value.order as string[] };
  if (typeof value.optionId === "string") return { optionId: value.optionId };
  if (typeof value.text === "string") return { text: value.text };
  return null;
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

function dailyOf(store: OfflineStore): DailyProgress {
  const active = mockToday.dailyActiveMs + unionMs(store.intervals);
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

const offlineEvents: MockHandler = (request, scenario) => {
  const store = storeOf(scenario);
  const found = request.params?.id === undefined ? null : sessionOf(store, request.params.id);
  if (found === null) return sessionMockHandlers["POST /sessions/:id/events"]?.(request, scenario) ?? notFound();
  if (!scenario.signedIn) return unauthenticated();
  const list = isRecord(request.body) && Array.isArray(request.body.events) ? (request.body.events as unknown[]) : null;
  if (list === null || list.length < 1 || list.length > 100) return validation([{ field: "events", rule: "invalid_type" }]);

  const response: EventsResponse = { acknowledged: [], duplicate: [], pending: [], rejected: [], results: [], daily: dailyOf(store) };
  const questions = new Map(found.session.steps.flatMap((step) => (step.type === "question" ? [[step.question.questionId, step.question] as const] : [])));
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.clientEventId !== "string" || !UUID.test(raw.clientEventId)) return validation([{ field: "events", rule: "invalid_type" }]);
    const event = raw as unknown as SessionEvent;
    const id = event.clientEventId;
    if (store.acknowledged.has(id)) {
      response.duplicate.push(id);
      continue;
    }
    if (!ENVELOPE_KEYS.every((key) => key in raw)) {
      response.rejected.push({ clientEventId: id, code: "envelope_mismatch" });
      continue;
    }
    if (store.control.status === "revoked") {
      response.rejected.push({ clientEventId: id, code: "edition_mismatch" });
      continue;
    }
    if (store.control.currentPlanVersion !== found.snapshot.planVersion) {
      response.pending.push({ clientEventId: id, reasonCode: "plan_changed_unverifiable" });
      continue;
    }
    if (event.type === "activity") {
      store.intervals.push([Date.parse(event.startedAt), Date.parse(event.endedAt)]);
      store.acknowledged.add(id);
      response.acknowledged.push(id);
      continue;
    }
    const question: Question | undefined = questions.get(event.questionId);
    const payload = answerShape(event.answer);
    if (question === undefined || payload === null) {
      response.rejected.push({ clientEventId: id, code: question === undefined ? "question_not_in_session" : "invalid_answer_shape" });
      continue;
    }
    const graded = gradeLocally(question, payload, event.hintUsed);
    const result: AnswerResult = {
      clientEventId: id,
      questionId: event.questionId,
      correct: graded.correct,
      assisted: graded.assisted,
      expected: graded.expected,
      passage: { passageId: question.passageId, status: "learning", coveredParts: 1, totalParts: 2, consecutiveCorrect: graded.correct ? 1 : 0 },
    };
    store.acknowledged.add(id);
    store.answers.set(found.session.sessionId, [...(store.answers.get(found.session.sessionId) ?? []), { correct: graded.correct }]);
    response.acknowledged.push(id);
    response.results.push(result);
  }
  response.daily = dailyOf(store);
  return { status: 200, body: response };
};

const offlineComplete: MockHandler = (request, scenario) => {
  const store = storeOf(scenario);
  const found = request.params?.id === undefined ? null : sessionOf(store, request.params.id);
  if (found === null) return sessionMockHandlers["POST /sessions/:id/complete"]?.(request, scenario) ?? notFound();
  if (!scenario.signedIn) return unauthenticated();
  const log = store.answers.get(found.session.sessionId) ?? [];
  const body: CompleteResponse = {
    summary: { answered: log.length, correct: log.filter((entry) => entry.correct).length, newPassages: 0, reviewsPassed: 0, reviewsFailed: 0, activeMs: unionMs(store.intervals) },
    daily: dailyOf(store),
  };
  return { status: 200, body };
};

export const offlineMockHandlers: Record<string, MockHandler> = {
  "POST /plans/:id/offline-snapshots": createSnapshot,
  "GET /offline-snapshots/:id": readSnapshot,
  "POST /offline/revalidate": revalidate,
  "POST /sessions/:id/events": offlineEvents,
  "POST /sessions/:id/complete": offlineComplete,
};
