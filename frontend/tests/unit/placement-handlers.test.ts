import { describe, expect, it } from "vitest";
import { createMockFetch, MOCK_HADITH_EDITION_ID, MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockHandlers, mockToday } from "@/lib/api/mock";
import { MOCK_PLACEMENT_QUESTION_IDS, MOCK_PLACEMENT_RECALL_WORD, placementMockHandlers, withPlacementMock } from "@/lib/api/mock/placement-handlers";
import type { EventsResponse, SessionSnapshot } from "@/lib/api/types";

const UUID = "123e4567-e89b-42d3-a456-";

function backend(scenario: { signedIn?: boolean } = {}) {
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn: true, ...scenario }, handlers: withPlacementMock(mockHandlers) });
  async function call(method: string, path: string, body?: unknown) {
    const response = await mock(`/api${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as unknown };
  }
  return { call };
}

const placementBody = { kind: "placement", editionId: MOCK_QURAN_EDITION_ID, targetScope: { sectionOrdinals: [1, 2] } };

async function openPlacement(api: ReturnType<typeof backend>, extra: Record<string, unknown> = {}): Promise<SessionSnapshot> {
  const created = await api.call("POST", "/sessions", { ...placementBody, ...extra });
  expect(created.status).toBe(201);
  return created.body as SessionSnapshot;
}

const answerEvent = (suffix: string, questionId: string, answer: unknown) => ({
  clientEventId: `${UUID}${suffix.padStart(12, "0")}`,
  type: "answer",
  questionId,
  answer,
  hintUsed: false,
  occurredAt: "2026-10-05T07:00:00Z",
  durationMs: 1200,
});

describe("placement mock handlers, E20 placement", () => {
  it("creates a placement snapshot with question steps only, role placement, no plan, and the pinned edition", async () => {
    const api = backend();
    const snapshot = await openPlacement(api, { selfRating: "most" });
    expect(snapshot).toMatchObject({ kind: "placement", planId: null, planVersion: null, editionId: MOCK_QURAN_EDITION_ID, status: "open" });
    expect(snapshot.steps.map((step) => step.type)).toEqual(["question", "question", "question"]);
    expect(snapshot.steps.flatMap((step) => (step.type === "question" ? [step.question.role] : []))).toEqual(["placement", "placement", "placement"]);
    expect(snapshot.steps.flatMap((step) => (step.type === "question" ? [step.question.type] : []))).toEqual(["word_choice", "word_recall", "word_choice"]);
  });

  it("creates a new session each time", async () => {
    const api = backend();
    expect((await openPlacement(api)).sessionId).not.toBe((await openPlacement(api)).sessionId);
  });

  it("is judged by the contract: forbidden fields, edition, scope and self-rating", async () => {
    const api = backend();
    const rules = async (body: unknown) => ((await api.call("POST", "/sessions", body)).body as { error: { details: { fields: { field: string; rule: string }[] } } }).error.details.fields;
    expect(await rules({ ...placementBody, planId: "x" })).toEqual([{ field: "planId", rule: "forbidden_field" }]);
    expect(await rules({ ...placementBody, editionId: "11111111-1111-4111-8111-00000000dead" })).toEqual([{ field: "editionId", rule: "edition_not_available" }]);
    expect(await rules({ ...placementBody, targetScope: { sectionOrdinals: [] } })).toEqual([{ field: "targetScope", rule: "scope_invalid" }]);
    expect(await rules({ ...placementBody, targetScope: { sectionOrdinals: [99] } })).toEqual([{ field: "targetScope", rule: "scope_invalid" }]);
    expect(await rules({ ...placementBody, selfRating: "all" })).toEqual([{ field: "selfRating", rule: "self_rating_invalid" }]);
    expect((await api.call("POST", "/sessions", { ...placementBody, editionId: MOCK_HADITH_EDITION_ID, targetScope: { sectionOrdinals: [1] } })).status).toBe(201);
  });

  it("answers 401 to a visitor", async () => {
    expect((await backend({ signedIn: false }).call("POST", "/sessions", placementBody)).status).toBe(401);
  });

  it("leaves the daily E20 to the handler that was there", async () => {
    const daily = await backend().call("POST", "/sessions", { kind: "daily", planId: MOCK_PLAN_ID, expectedPlanVersion: mockToday.plan?.currentVersion });
    expect(daily.status).toBe(201);
    expect((daily.body as SessionSnapshot).kind).toBe("daily");
  });

  it("exports the placement-only handlers under the three keys they own", () => {
    expect(Object.keys(placementMockHandlers).sort()).toEqual(["POST /sessions", "POST /sessions/:id/complete", "POST /sessions/:id/events"]);
  });
});

describe("placement mock handlers, E21 and E22", () => {
  it("grades like the server, records the first payload of an id, answers a repeat as duplicate and never credits time", async () => {
    const api = backend();
    const { sessionId } = await openPlacement(api);
    const right = answerEvent("1", MOCK_PLACEMENT_QUESTION_IDS.choice, { optionId: "p-a" });
    const wrong = answerEvent("2", MOCK_PLACEMENT_QUESTION_IDS.recall, { text: "كلمة٩" });
    const recall = answerEvent("3", MOCK_PLACEMENT_QUESTION_IDS.segment, { optionId: "q-b" });
    const first = (await api.call("POST", `/sessions/${sessionId}/events`, { events: [right, wrong, recall] })).body as EventsResponse;
    expect(first.acknowledged).toEqual([right.clientEventId, wrong.clientEventId, recall.clientEventId]);
    expect(first.results.map((entry) => entry.correct)).toEqual([true, false, false]);
    expect(first.results[1]?.expected).toEqual({ word: MOCK_PLACEMENT_RECALL_WORD });
    expect(first.daily.dailyActiveMs).toBe(mockToday.dailyActiveMs);
    const again = (await api.call("POST", `/sessions/${sessionId}/events`, { events: [right, { ...right, answer: { optionId: "p-b" } }] })).body as EventsResponse;
    expect(again.duplicate).toEqual([right.clientEventId, right.clientEventId]);
    expect(again.acknowledged).toEqual([]);
  });

  it("acknowledges an activity event without crediting it, and rejects an unknown question and a wrong answer shape", async () => {
    const api = backend();
    const { sessionId } = await openPlacement(api);
    const activity = { clientEventId: `${UUID}00000000000a`, type: "activity", startedAt: "2026-10-05T07:00:00Z", endedAt: "2026-10-05T07:01:00Z", activeMs: 60_000 };
    const stranger = answerEvent("b", "aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff", { optionId: "p-a" });
    const misfit = answerEvent("c", MOCK_PLACEMENT_QUESTION_IDS.choice, { text: "x" });
    const answer = (await api.call("POST", `/sessions/${sessionId}/events`, { events: [activity, stranger, misfit] })).body as EventsResponse;
    expect(answer.acknowledged).toEqual([activity.clientEventId]);
    expect(answer.rejected).toEqual([
      { clientEventId: stranger.clientEventId, code: "question_not_in_session" },
      { clientEventId: misfit.clientEventId, code: "invalid_answer_shape" },
    ]);
    expect(answer.daily.dailyActiveMs).toBe(mockToday.dailyActiveMs);
  });

  it("validates the body of E21 and answers 401 and 404", async () => {
    const api = backend();
    const { sessionId } = await openPlacement(api);
    expect((await api.call("POST", `/sessions/${sessionId}/events`, { events: [] })).status).toBe(422);
    expect((await api.call("POST", `/sessions/${sessionId}/events`, { events: [{ type: "answer" }] })).status).toBe(422);
    expect((await api.call("POST", `/sessions/${sessionId}/events`, { events: [], extra: 1 })).status).toBe(422);
    expect((await api.call("POST", "/sessions/99999999-9999-4999-8999-0000000000ff/events", { events: [answerEvent("d", MOCK_PLACEMENT_QUESTION_IDS.choice, { optionId: "p-a" })] })).status).toBe(404);
    expect((await backend({ signedIn: false }).call("POST", "/sessions/x/events", { events: [] })).status).toBe(401);
  });

  it("completes once with a summary of the answers, returns the same answer on a repeat, and then rejects new events", async () => {
    const api = backend();
    const { sessionId } = await openPlacement(api);
    await api.call("POST", `/sessions/${sessionId}/events`, { events: [answerEvent("e", MOCK_PLACEMENT_QUESTION_IDS.choice, { optionId: "p-a" })] });
    const first = await api.call("POST", `/sessions/${sessionId}/complete`);
    expect(first.status).toBe(200);
    expect((first.body as { summary: unknown }).summary).toEqual({ answered: 1, correct: 1, newPassages: 0, reviewsPassed: 0, reviewsFailed: 0, activeMs: 0 });
    expect((await api.call("POST", `/sessions/${sessionId}/complete`)).body).toEqual(first.body);
    const late = (await api.call("POST", `/sessions/${sessionId}/events`, { events: [answerEvent("f", MOCK_PLACEMENT_QUESTION_IDS.recall, { text: "كلمة٨" })] })).body as EventsResponse;
    expect(late.rejected).toEqual([{ clientEventId: `${UUID}00000000000f`, code: "session_closed" }]);
  });
});

describe("placement mock handlers, E31 with placementSessionId", () => {
  const chat = (placementSessionId?: string, editionId = MOCK_QURAN_EDITION_ID) => ({
    editionId,
    targetScope: { sectionOrdinals: [1] },
    paths: ["quran"],
    sessionMinutes: 10,
    goalText: "Synthetic goal sentence",
    language: "ar",
    ...(placementSessionId === undefined ? {} : { placementSessionId }),
  });

  it("creates the conversation for a known placement session of the same edition", async () => {
    const api = backend();
    const { sessionId } = await openPlacement(api);
    expect((await api.call("POST", "/plan-chats", chat(sessionId))).status).toBe(201);
  });

  it("answers 404 for an unknown session and for one of another edition", async () => {
    const api = backend();
    const { sessionId } = await openPlacement(api);
    expect((await api.call("POST", "/plan-chats", chat("99999999-9999-4999-8999-0000000000ff"))).status).toBe(404);
    expect((await api.call("POST", "/plan-chats", { ...chat(sessionId, MOCK_HADITH_EDITION_ID), paths: ["matn"] })).status).toBe(404);
  });

  it("leaves a conversation without a placement session to the handler that was there", async () => {
    expect((await backend().call("POST", "/plan-chats", chat())).status).toBe(201);
  });
});
