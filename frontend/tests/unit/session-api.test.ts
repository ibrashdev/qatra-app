import { describe, expect, it, vi } from "vitest";
import { activityEvent, answerEvent, newEventId } from "@/components/session/session-events";
import { createApiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { MOCK_PLAN_ID } from "@/lib/api/mock/fixtures";
import { mockHandlers, type MockHandler, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_QUESTION_IDS, MOCK_RECALL_WORD, sessionMockHandlers } from "@/lib/api/mock/session-handlers";
import { MOCK_SESSION_ID, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { COMPLETE_RETRY_POLICY, completeSession, dailySessionBody, postSessionEvents, startDailySession } from "@/lib/api/session-endpoints";
import type { SessionEvent } from "@/lib/api/types";

function setup(scenario: Partial<MockScenario> = {}, wrap?: (real: typeof fetch) => typeof fetch, handlers: Record<string, MockHandler> = {}) {
  const mock = createMockFetch({ latencyMs: 0, handlers: { ...mockHandlers, ...todayMockHandlers, ...sessionMockHandlers, ...handlers }, scenario });
  const fetchImpl = vi.fn<typeof fetch>(wrap === undefined ? mock : wrap(mock));
  return { client: createApiClient({ fetch: fetchImpl }), fetchImpl };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The call was expected to fail.");
}

const request = { planId: MOCK_PLAN_ID, planVersion: 1 };
const T0 = Date.parse("2026-10-05T07:00:00Z");

const answer = (questionId: string, payload: Parameters<typeof answerEvent>[0]["answer"], hintUsed = false): SessionEvent =>
  answerEvent({ questionId, answer: payload, hintUsed, occurredAtMs: T0 + 5000, durationMs: 4000 });

describe("E20 daily as the session screen uses it (sessionMockHandlers)", () => {
  it("sends the S-11 body and answers 201 with a snapshot, then the same open session for the next call", async () => {
    const { client, fetchImpl } = setup();
    const first = await startDailySession(client, request);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/sessions");
    expect(JSON.parse(String(init?.body))).toEqual(dailySessionBody(request));
    expect(first).toMatchObject({ sessionId: MOCK_SESSION_ID, kind: "daily", status: "open", planId: MOCK_PLAN_ID });
    const second = await startDailySession(client, request);
    expect(second).toEqual(first);
  });

  it("holds one due review, a learn step and drills of the four kinds, each question with its answer key", async () => {
    const snapshot = await startDailySession(setup().client, request);
    const kinds = snapshot.steps.map((step) => (step.type === "learn" ? "learn" : `${step.question.role}:${step.question.type}`));
    expect(kinds).toEqual(["review:word_choice", "learn", "training:word_order", "training:word_choice", "training:word_recall", "training:similar_distinction", "test:word_choice"]);
    for (const step of snapshot.steps) if (step.type === "question") expect(step.question.answerKey).toBeDefined();
  });

  it("keeps the failures of the S-11 handler: stale version, inactive plan, visitor", async () => {
    const stale = await failureOf(startDailySession(setup().client, { ...request, planVersion: 9 }));
    expect([stale.status, stale.details.reason]).toEqual([409, "plan_version"]);
    const inactive = await failureOf(startDailySession(setup({ hasPlan: false }).client, request));
    expect([inactive.status, inactive.details.reason]).toEqual([409, "plan_not_active"]);
    const visitor = await failureOf(startDailySession(setup({ signedIn: false }).client, request));
    expect(visitor.status).toBe(401);
  });

  it("opens a new session once the last one is completed", async () => {
    const { client } = setup();
    const first = await startDailySession(client, request);
    await completeSession(client, first.sessionId);
    const next = await startDailySession(client, request);
    expect(next.sessionId).not.toBe(first.sessionId);
  });
});

describe("E21 POST /api/sessions/:id/events", () => {
  it("posts exactly { events } to the session path", async () => {
    const { client, fetchImpl } = setup();
    await startDailySession(client, request);
    const events = [answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" })];
    await postSessionEvents(client, MOCK_SESSION_ID, events);
    const [url, init] = fetchImpl.mock.calls[1] ?? [];
    expect(String(url)).toBe(`/api/sessions/${MOCK_SESSION_ID}/events`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ events });
  });

  it("refuses an empty batch and one of more than 100 before any request", async () => {
    const { client, fetchImpl } = setup();
    await expect(postSessionEvents(client, MOCK_SESSION_ID, [])).rejects.toBeInstanceOf(RangeError);
    const many = Array.from({ length: 101 }, () => activityEvent(T0, T0 + 5000) as SessionEvent);
    await expect(postSessionEvents(client, MOCK_SESSION_ID, many)).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is idempotent, so the client may repeat it after a lost answer with the same ids", async () => {
    let failures = 1;
    const { client, fetchImpl } = setup({}, (real) => async (input, init) => {
      if (String(input).endsWith("/events") && failures > 0) {
        failures -= 1;
        throw new TypeError("The connection failed.");
      }
      return real(input, init);
    });
    await startDailySession(client, request);
    const event = answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" });
    const response = await postSessionEvents(client, MOCK_SESSION_ID, [event], { retry: { delaysMs: [0] } });
    expect(response.acknowledged).toEqual([event.clientEventId]);
    const bodies = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/events")).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it("grades on the server: a verdict, the expected value and the state of the passage for each answer", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const events = [
      answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" }),
      answer(MOCK_QUESTION_IDS.order, { order: ["1:1", "1:2", "1:3"] }),
      answer(MOCK_QUESTION_IDS.segment, { optionId: "seg-b" }),
      answer(MOCK_QUESTION_IDS.recall, { text: ` ${MOCK_RECALL_WORD} ` }, true),
    ];
    const response = await postSessionEvents(client, MOCK_SESSION_ID, events);
    expect(response.acknowledged).toEqual(events.map((event) => event.clientEventId));
    expect(response.results.map((result) => [result.correct, result.assisted])).toEqual([
      [true, false],
      [true, false],
      [false, false],
      [true, true],
    ]);
    expect(response.results[0]?.expected).toEqual({ optionId: "opt-a" });
    expect(response.results[2]?.expected).toEqual({ optionId: "seg-a" });
    expect(response.results[3]?.expected).toEqual({ word: MOCK_RECALL_WORD });
    // A correct answer counts one in a row, a wrong one starts again, an assisted one changes nothing (D64, D66).
    expect(response.results[1]?.passage).toMatchObject({ status: "learning", totalParts: 3, consecutiveCorrect: 1 });
    expect(response.results[2]?.passage.consecutiveCorrect).toBe(0);
    expect(response.results[3]?.passage.consecutiveCorrect).toBe(0);
    expect(response.results[0]?.passage.status).toBe("reviewing");
  });

  it("answers every event once: a resent id is a duplicate with no second result", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const event = answer(MOCK_QUESTION_IDS.review, { optionId: "opt-b" });
    const first = await postSessionEvents(client, MOCK_SESSION_ID, [event]);
    expect(first.results).toHaveLength(1);
    const again = await postSessionEvents(client, MOCK_SESSION_ID, [event, answer(MOCK_QUESTION_IDS.order, { order: ["1:1", "1:2", "1:3"] })]);
    expect(again.duplicate).toEqual([event.clientEventId]);
    expect(again.acknowledged).toHaveLength(1);
    expect(again.results).toHaveLength(1);
  });

  it("rejects an unknown question and a payload that does not fit the type, per event", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const unknown = answer("77777777-7777-4777-8777-0000000000ff", { optionId: "opt-a" });
    const wrongShape = answer(MOCK_QUESTION_IDS.review, { text: "x" });
    const response = await postSessionEvents(client, MOCK_SESSION_ID, [unknown, wrongShape]);
    expect(response.rejected).toEqual([
      { clientEventId: unknown.clientEventId, code: "question_not_in_session" },
      { clientEventId: wrongShape.clientEventId, code: "invalid_answer_shape" },
    ]);
    expect(response.results).toEqual([]);
  });

  it("credits active time from the union of intervals and returns the day's figures in every answer (never a sum)", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const before = await postSessionEvents(client, MOCK_SESSION_ID, [answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" })]);
    expect(before.daily).toMatchObject({ dailyActiveMs: 420_000, dailyGoalMs: 600_000, dailyPercent: 70, dailyCompleted: false, extraActiveMs: 0 });
    const first = activityEvent(T0, T0 + 60_000);
    const overlapping = activityEvent(T0 + 30_000, T0 + 90_000);
    if (first === null || overlapping === null) throw new Error("intervals expected");
    const response = await postSessionEvents(client, MOCK_SESSION_ID, [first, overlapping]);
    expect(response.daily).toMatchObject({ dailyActiveMs: 510_000, dailyPercent: 85, dailyCompleted: false });
    const more = activityEvent(T0 + 600_000, T0 + 780_000);
    if (more === null) throw new Error("interval expected");
    const done = await postSessionEvents(client, MOCK_SESSION_ID, [more]);
    expect(done.daily).toMatchObject({ dailyActiveMs: 690_000, dailyPercent: 100, dailyCompleted: true, extraActiveMs: 90_000 });
  });

  it("rejects an interval that is longer than its bounds allow, without failing the request", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const event: SessionEvent = { clientEventId: newEventId(), type: "activity", startedAt: "2026-10-05T07:00:00Z", endedAt: "2026-10-05T07:01:00Z", activeMs: 300_000 };
    const response = await postSessionEvents(client, MOCK_SESSION_ID, [event]);
    expect(response.rejected).toEqual([{ clientEventId: event.clientEventId, code: "activity_out_of_bounds" }]);
  });

  it("fails the whole request with 422 for a forbidden property such as `correct`", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const event = { ...answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" }), correct: true };
    const error = await failureOf(client.post(`/sessions/${MOCK_SESSION_ID}/events`, { events: [event] }));
    expect([error.status, error.code]).toEqual([422, "validation_error"]);
    expect(error.details.fields).toEqual([{ field: "events[0].correct", rule: "forbidden_field" }]);
  });

  it("answers 404 for an unknown session, 401 for a visitor, and 413 for a body over 64 KiB", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const event = answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" });
    const missing = await failureOf(postSessionEvents(client, "55555555-5555-4555-8555-0000000000ff", [event]));
    expect([missing.status, missing.code]).toEqual([404, "not_found"]);
    const visitor = await failureOf(postSessionEvents(setup({ signedIn: false }).client, MOCK_SESSION_ID, [event]));
    expect(visitor.status).toBe(401);
    const big = answerEvent({ questionId: MOCK_QUESTION_IDS.recall, answer: { text: "ك".repeat(70_000) }, hintUsed: false, occurredAtMs: T0, durationMs: 1000 });
    const large = await failureOf(postSessionEvents(client, MOCK_SESSION_ID, [big]));
    expect([large.status, large.code]).toEqual([413, "payload_too_large"]);
  });

  it("rejects events with plan_not_active once the plan is no longer active", async () => {
    const real = sessionMockHandlers["POST /sessions/:id/events"];
    if (real === undefined) throw new Error("no E21 handler");
    const { client } = setup({}, undefined, {
      "POST /sessions/:id/events": (req, scenario) => {
        scenario.hasPlan = false;
        return real(req, scenario);
      },
    });
    await startDailySession(client, request);
    const event = answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" });
    const response = await postSessionEvents(client, MOCK_SESSION_ID, [event]);
    expect(response.rejected).toEqual([{ clientEventId: event.clientEventId, code: "plan_not_active" }]);
    expect(response.acknowledged).toEqual([]);
  });
});

describe("E22 POST /api/sessions/:id/complete", () => {
  it("sends no body, carries the idempotency key, and answers the summary and the day's figures", async () => {
    const { client, fetchImpl } = setup();
    await startDailySession(client, request);
    const key = newEventId();
    const complete = await completeSession(client, MOCK_SESSION_ID, { idempotencyKey: key });
    const [url, init] = fetchImpl.mock.calls[1] ?? [];
    expect(String(url)).toBe(`/api/sessions/${MOCK_SESSION_ID}/complete`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(key);
    expect(complete.summary).toEqual({ answered: 0, correct: 0, newPassages: 0, reviewsPassed: 0, reviewsFailed: 0, activeMs: 0 });
    expect(complete.daily.dailyGoalMs).toBe(600_000);
  });

  it("summarises only acknowledged events, and a repeat returns the stored answer with no second effect", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const interval = activityEvent(T0, T0 + 90_000);
    if (interval === null) throw new Error("interval expected");
    await postSessionEvents(client, MOCK_SESSION_ID, [
      answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" }),
      answer(MOCK_QUESTION_IDS.order, { order: ["1:1", "1:2", "1:3"] }),
      answer(MOCK_QUESTION_IDS.segment, { optionId: "seg-b" }),
      interval,
    ]);
    const complete = await completeSession(client, MOCK_SESSION_ID);
    expect(complete.summary).toEqual({ answered: 3, correct: 2, newPassages: 1, reviewsPassed: 1, reviewsFailed: 0, activeMs: 90_000 });
    expect(complete.daily.dailyActiveMs).toBe(510_000);
    expect(await completeSession(client, MOCK_SESSION_ID)).toEqual(complete);
  });

  it("closes the session: later events are rejected with session_closed, and a resent acknowledged one stays a duplicate", async () => {
    const { client } = setup();
    await startDailySession(client, request);
    const early = answer(MOCK_QUESTION_IDS.review, { optionId: "opt-a" });
    await postSessionEvents(client, MOCK_SESSION_ID, [early]);
    await completeSession(client, MOCK_SESSION_ID);
    const late = answer(MOCK_QUESTION_IDS.order, { order: ["1:1", "1:2", "1:3"] });
    const response = await postSessionEvents(client, MOCK_SESSION_ID, [early, late]);
    expect(response.duplicate).toEqual([early.clientEventId]);
    expect(response.rejected).toEqual([{ clientEventId: late.clientEventId, code: "session_closed" }]);
  });

  it("is retried after a lost answer: twice by default (1 s, 2 s), and the call may be repeated safely", async () => {
    expect(COMPLETE_RETRY_POLICY.delaysMs).toEqual([1000, 2000]);
    let failures = 1;
    const { client, fetchImpl } = setup({}, (real) => async (input, init) => {
      if (String(input).endsWith("/complete") && failures > 0) {
        failures -= 1;
        throw new TypeError("The connection failed.");
      }
      return real(input, init);
    });
    await startDailySession(client, request);
    const complete = await completeSession(client, MOCK_SESSION_ID, { retry: { delaysMs: [0] } });
    expect(complete.summary.answered).toBe(0);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/complete"))).toHaveLength(2);
  });

  it("answers 404 for an unknown session and 401 for a visitor", async () => {
    const missing = await failureOf(completeSession(setup().client, "55555555-5555-4555-8555-0000000000ff"));
    expect(missing.status).toBe(404);
    const visitor = await failureOf(completeSession(setup({ signedIn: false }).client, MOCK_SESSION_ID));
    expect(visitor.status).toBe(401);
  });
});

describe("event builders", () => {
  it("makes UUID v4 ids that differ, and keeps an id it is given", () => {
    const first = newEventId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newEventId()).not.toBe(first);
    expect(activityEvent(T0, T0 + 5000, first)?.clientEventId).toBe(first);
  });

  it("bounds an answer duration and an interval to 30 minutes, and drops one too short or reversed", () => {
    const long = answerEvent({ questionId: "q", answer: { optionId: "a" }, hintUsed: false, occurredAtMs: T0, durationMs: 99 * 60_000 });
    expect(long).toMatchObject({ type: "answer", durationMs: 30 * 60_000, occurredAt: "2026-10-05T07:00:00.000Z" });
    const interval = activityEvent(T0, T0 + 99 * 60_000);
    expect(interval).toMatchObject({ type: "activity", activeMs: 30 * 60_000 });
    expect(activityEvent(T0, T0 + 500)).toBeNull();
    expect(activityEvent(T0, T0 - 5000)).toBeNull();
  });

  it("keeps activeMs inside endedAt minus startedAt", () => {
    const event = activityEvent(T0, T0 + 61_234);
    if (event === null || event.type !== "activity") throw new Error("interval expected");
    expect(event.activeMs).toBeLessThanOrEqual(Date.parse(event.endedAt) - Date.parse(event.startedAt) + 1000);
  });
});
