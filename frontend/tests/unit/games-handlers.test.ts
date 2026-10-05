import { describe, expect, it } from "vitest";
import { createMockFetch, MOCK_PLAN_ID, mockHandlers } from "@/lib/api/mock";
import { MOCK_GAME_RECALL_WORDS, mockGameQuestions, withGameMock } from "@/lib/api/mock/game-handlers";
import type { EventsResponse, GameKind, SessionSnapshot, CompleteResponse } from "@/lib/api/types";

const UUID = "123e4567-e89b-42d3-a456-";
const KINDS: GameKind[] = ["word_order", "word_choice", "similar_distinction", "word_recall"];

function backend(scenario: { signedIn?: boolean; hasPlan?: boolean } = {}, empty: GameKind[] = []) {
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn: true, hasPlan: true, ...scenario }, handlers: withGameMock(mockHandlers, { empty }) });
  async function call(method: string, path: string, body?: unknown) {
    const response = await mock(`/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as unknown };
  }
  return { call };
}

const gameBody = (gameType: GameKind) => ({ kind: "game", planId: MOCK_PLAN_ID, expectedPlanVersion: 1, gameType });

async function openGame(api: ReturnType<typeof backend>, gameType: GameKind): Promise<SessionSnapshot> {
  const created = await api.call("POST", "/sessions", gameBody(gameType));
  expect(created.status).toBe(201);
  return created.body as SessionSnapshot;
}

const answerEvent = (suffix: string, questionId: string, answer: unknown, hintUsed = false) => ({
  clientEventId: `${UUID}${suffix.padStart(12, "0")}`,
  type: "answer",
  questionId,
  answer,
  hintUsed,
  occurredAt: "2026-10-05T07:00:00Z",
  durationMs: 1200,
});

const fieldsOf = (body: unknown) => (body as { error: { details: { fields: { field: string; rule: string }[] } } }).error.details.fields;

describe("game mock handlers, E20 game", () => {
  it("creates a game snapshot of question steps only, role game, for the plan and its edition", async () => {
    const api = backend();
    for (const kind of KINDS) {
      const snapshot = await openGame(api, kind);
      expect(snapshot).toMatchObject({ kind: "game", planId: MOCK_PLAN_ID, planVersion: 1, status: "open" });
      const questions = snapshot.steps.flatMap((step) => (step.type === "question" ? [step.question] : []));
      expect(questions).toHaveLength(snapshot.steps.length);
      expect(questions.length).toBeGreaterThan(0);
      expect(questions.every((question) => question.type === kind && question.role === "game")).toBe(true);
    }
  });

  it("creates a new round on every press: it is never a get-or-create", async () => {
    const api = backend();
    expect((await openGame(api, "word_order")).sessionId).not.toBe((await openGame(api, "word_order")).sessionId);
  });

  it("is judged by the contract: forbidden fields, then the types, then the plan, its state and its version", async () => {
    const api = backend();
    expect(fieldsOf((await api.call("POST", "/sessions", { ...gameBody("word_order"), userId: "x" })).body)).toEqual([{ field: "userId", rule: "forbidden_field" }]);
    expect(fieldsOf((await api.call("POST", "/sessions", { kind: "game", planId: MOCK_PLAN_ID, expectedPlanVersion: 1 })).body)).toEqual([{ field: "gameType", rule: "invalid_type" }]);
    expect(fieldsOf((await api.call("POST", "/sessions", { ...gameBody("word_order"), gameType: "memory" })).body)).toEqual([{ field: "gameType", rule: "game_type_invalid" }]);
    expect((await api.call("POST", "/sessions", { ...gameBody("word_order"), planId: "44444444-4444-4444-8444-0000000000ff" })).status).toBe(404);
    const stale = await api.call("POST", "/sessions", { ...gameBody("word_order"), expectedPlanVersion: 9 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "version_conflict", details: { reason: "plan_version", currentVersion: 1 } } });
  });

  it("answers plan_not_active without a plan, 401 to a visitor, and leaves the daily E20 to the handler that was there", async () => {
    expect((await backend({ hasPlan: false }).call("POST", "/sessions", gameBody("word_order"))).body).toMatchObject({ error: { code: "version_conflict", details: { reason: "plan_not_active" } } });
    expect((await backend({ signedIn: false }).call("POST", "/sessions", gameBody("word_order"))).status).toBe(401);
    const daily = await backend().call("POST", "/sessions", { kind: "daily", planId: MOCK_PLAN_ID, expectedPlanVersion: 1 });
    expect(daily.status).toBe(201);
    expect((daily.body as SessionSnapshot).kind).toBe("daily");
  });

  it("answers 201 with no question step for a game with nothing to play (G-26)", async () => {
    const api = backend({}, ["similar_distinction"]);
    expect((await openGame(api, "similar_distinction")).steps).toEqual([]);
    expect((await openGame(api, "word_order")).steps.length).toBeGreaterThan(0);
  });
});

describe("game mock handlers, E21 and E22", () => {
  it("grades like the server: the answer key, a normalised recall, one outcome per event, and an assisted answer counted as assisted", async () => {
    const api = backend();
    const snapshot = await openGame(api, "word_recall");
    const [first, second] = mockGameQuestions("word_recall");
    expect(snapshot.steps).toHaveLength(2);
    const sent = await api.call("POST", `/sessions/${snapshot.sessionId}/events`, {
      events: [answerEvent("1", first?.questionId ?? "", { text: MOCK_GAME_RECALL_WORDS[0] }), answerEvent("2", second?.questionId ?? "", { text: "خطأ" }, true)],
    });
    expect(sent.status).toBe(200);
    const body = sent.body as EventsResponse;
    expect(body.acknowledged).toHaveLength(2);
    expect(body.results.map((result) => [result.correct, result.assisted])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(body.results[1]?.expected).toEqual({ word: MOCK_GAME_RECALL_WORDS[1] });
  });

  it("keeps the idempotency of clientEventId and rejects an unknown question and a wrong answer shape", async () => {
    const api = backend();
    const snapshot = await openGame(api, "word_choice");
    const first = mockGameQuestions("word_choice")[0];
    const event = answerEvent("1", first?.questionId ?? "", { optionId: "w-a" });
    await api.call("POST", `/sessions/${snapshot.sessionId}/events`, { events: [event] });
    const again = (await api.call("POST", `/sessions/${snapshot.sessionId}/events`, { events: [event] })).body as EventsResponse;
    expect(again.duplicate).toEqual([event.clientEventId]);
    const rejected = (
      await api.call("POST", `/sessions/${snapshot.sessionId}/events`, {
        events: [answerEvent("2", "unknown", { optionId: "w-a" }), answerEvent("3", first?.questionId ?? "", { order: ["1:1"] })],
      })
    ).body as EventsResponse;
    expect(rejected.rejected.map((entry) => entry.code)).toEqual(["question_not_in_session", "invalid_answer_shape"]);
  });

  it("credits verified active time to the day without a completion by itself, and completes idempotently", async () => {
    const api = backend();
    const snapshot = await openGame(api, "word_order");
    const activity = {
      clientEventId: `${UUID}${"9".padStart(12, "0")}`,
      type: "activity",
      startedAt: "2026-10-05T07:00:00Z",
      endedAt: "2026-10-05T07:01:00Z",
      activeMs: 60_000,
    };
    const events = (await api.call("POST", `/sessions/${snapshot.sessionId}/events`, { events: [activity] })).body as EventsResponse;
    expect(events.acknowledged).toEqual([activity.clientEventId]);
    expect(events.daily.dailyActiveMs).toBe(480_000);
    const first = (await api.call("POST", `/sessions/${snapshot.sessionId}/complete`)).body as CompleteResponse;
    expect(first.summary).toMatchObject({ answered: 0, correct: 0, newPassages: 0, activeMs: 60_000 });
    expect((await api.call("POST", `/sessions/${snapshot.sessionId}/complete`)).body).toEqual(first);
    const late = (await api.call("POST", `/sessions/${snapshot.sessionId}/events`, { events: [answerEvent("4", "x", { text: "ب" })] })).body as EventsResponse;
    expect(late.rejected).toEqual([{ clientEventId: `${UUID}${"4".padStart(12, "0")}`, code: "session_closed" }]);
  });

  it("leaves the sessions it does not hold to the handler that was there", async () => {
    expect((await backend().call("POST", "/sessions/55555555-5555-4555-8555-000000000009/complete")).status).toBe(404);
  });
});
