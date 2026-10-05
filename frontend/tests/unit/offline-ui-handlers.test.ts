import { describe, expect, it } from "vitest";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID } from "@/lib/api/mock/fixtures";
import { mockHandlers, type MockHandler, type MockScenario } from "@/lib/api/mock/handlers";
import { mockOfflineControl, type MockOfflineControl } from "@/lib/api/mock/offline-handlers";
import { validatePlanSnapshot } from "@/lib/offline/plan-cache";
import type { EventsResponse, PlanSnapshot, RevalidationResult, SessionEvent } from "@/lib/api/types";

// The synthetic E23 to E25 of the mock layer (and E21 for the prepared sessions they hand out). A mock answer says nothing about the real server: these tests only
// pin that the mock keeps the contract's shape, so the offline screens can be built and tried against it.

const OP = "11111111-aaaa-4aaa-8aaa-000000000001";
const UUID = (n: number) => `22222222-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;

// The mock copies the scenario it is given, so the control of this mock session is reached through a handler that is handed the live one.
function setup(signedIn = true) {
  let live: MockScenario | null = null;
  const reach: MockHandler = (_request, scenario) => {
    live = scenario;
    return { status: 200, body: {} };
  };
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn, hasPlan: true }, handlers: { ...mockHandlers, "GET /__control": reach } });
  const control = async (): Promise<MockOfflineControl> => {
    await mock("/api/__control");
    return mockOfflineControl(live as unknown as MockScenario);
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await mock(`/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as unknown) };
  };
  return { control, call };
}

const create = (call: ReturnType<typeof setup>["call"], body: Record<string, unknown> = {}) =>
  call("POST", `/plans/${MOCK_PLAN_ID}/offline-snapshots`, { clientOperationId: OP, expectedPlanVersion: 1, ...body });

describe("E23 POST /plans/:id/offline-snapshots (mock)", () => {
  it("answers 201 with a snapshot the device accepts: one daily descriptor, one per game, the lessons and every question", async () => {
    const { call } = setup();
    const created = await create(call);
    expect(created.status).toBe(201);
    const snapshot = created.body as PlanSnapshot;
    expect(validatePlanSnapshot(snapshot)).toEqual({ ok: true });
    expect(snapshot).toMatchObject({ schemaVersion: 1, protocolVersion: 1, planId: MOCK_PLAN_ID, planVersion: 1, editionId: MOCK_QURAN_EDITION_ID, normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1" });
    expect(snapshot.preparedSessions.map((session) => `${session.kind}:${session.status}`)).toEqual(["daily:prepared", "game:prepared", "game:prepared", "game:prepared", "game:prepared"]);
    expect(snapshot.preparedSessions.length).toBeLessThanOrEqual(7);
    expect(snapshot.downloadedTargetRefs.length).toBeLessThanOrEqual(60);
    // Nothing secret, no commentary and no translation in a snapshot (API-spec section 1533).
    expect(JSON.stringify(snapshot)).not.toMatch(/"(accessToken|access_token|refresh_token|token|password|commentary|translation|tafsir)"s*:/i);
  });

  it("answers 200 with the same snapshot for the same operation, and creates no second one", async () => {
    const { call } = setup();
    const first = await create(call);
    const again = await create(call);
    expect(again.status).toBe(200);
    expect((again.body as PlanSnapshot).snapshotId).toBe((first.body as PlanSnapshot).snapshotId);
    const another = await create(call, { clientOperationId: "11111111-aaaa-4aaa-8aaa-000000000002" });
    expect(another.status).toBe(201);
    expect((another.body as PlanSnapshot).snapshotId).not.toBe((first.body as PlanSnapshot).snapshotId);
  });

  it("answers the conflicts: a stale plan version, a plan that is not active, the same operation with another input", async () => {
    const { call, control: reachControl } = setup();
    expect((await create(call, { expectedPlanVersion: 7 })).body).toMatchObject({ error: { code: "version_conflict", details: { reason: "plan_version", currentVersion: 1 } } });
    await create(call);
    expect((await create(call, { expectedPlanVersion: 2 })).body).toMatchObject({ error: { code: "version_conflict", details: { reason: "idempotency_input" } } });
    (await reachControl()).planActive = false;
    expect((await create(call, { clientOperationId: "11111111-aaaa-4aaa-8aaa-000000000003" })).body).toMatchObject({ error: { code: "version_conflict", details: { reason: "plan_not_active" } } });
  });

  it("answers 422 for what the contract forbids, 404 for a plan that is not the account's, 401 without a session", async () => {
    const { call } = setup();
    expect((await create(call, { userId: "x" })).body).toMatchObject({ error: { code: "validation_error", details: { fields: [{ field: "userId", rule: "forbidden_field" }] } } });
    expect((await create(call, { clientOperationId: "not-a-uuid" })).body).toMatchObject({ error: { details: { fields: [{ rule: "client_operation_id_invalid" }] } } });
    expect((await create(call, { downloadTargetRefs: [] })).body).toMatchObject({ error: { details: { fields: [{ rule: "target_refs_invalid" }] } } });
    expect((await create(call, { downloadTargetRefs: ["a", "a"] })).status).toBe(422);
    expect((await call("POST", "/plans/99999999-9999-4999-8999-999999999999/offline-snapshots", { clientOperationId: OP, expectedPlanVersion: 1 })).status).toBe(404);
    expect((await create(setup(false).call)).status).toBe(401);
    const { call: guarded, control: guardedControl } = setup();
    (await guardedControl()).downloadable = false;
    expect((await create(guarded)).body).toMatchObject({ error: { details: { fields: [{ rule: "edition_not_downloadable" }] } } });
  });
});

describe("E24 GET /offline-snapshots/:id (mock)", () => {
  it("reads an owned snapshot without creating a session, 404 for an unknown one and for a withdrawn edition", async () => {
    const { call, control: reachControl } = setup();
    const snapshot = (await create(call)).body as PlanSnapshot;
    expect((await call("GET", `/offline-snapshots/${snapshot.snapshotId}`)).body).toMatchObject({ snapshotId: snapshot.snapshotId });
    expect((await call("GET", `/offline-snapshots/${UUID(9)}`)).status).toBe(404);
    (await reachControl()).status = "revoked";
    expect((await call("GET", `/offline-snapshots/${snapshot.snapshotId}`)).status).toBe(404);
  });
});

describe("E25 POST /offline/revalidate (mock)", () => {
  async function revalidate(call: ReturnType<typeof setup>["call"], snapshot: PlanSnapshot, patch: Record<string, unknown> = {}) {
    return call("POST", "/offline/revalidate", { snapshotId: snapshot.snapshotId, expectedPlanVersion: snapshot.planVersion, editionId: snapshot.editionId, bankVersion: snapshot.bankVersion, ...patch });
  }

  it("derives the status: available with the runnable sessions, stale when the plan moved on or stopped, revoked and expired from the edition", async () => {
    const { call, control: reachControl } = setup();
    const snapshot = (await create(call)).body as PlanSnapshot;
    const available = (await revalidate(call, snapshot)).body as RevalidationResult;
    expect(available).toMatchObject({ status: "available", reasonCode: "current", currentPlanVersion: 1 });
    expect(available.allowedSessionRefs).toEqual(snapshot.preparedSessions.map((session) => session.sessionId));

    const control = await reachControl();
    control.currentPlanVersion = 2;
    expect((await revalidate(call, snapshot)).body).toMatchObject({ status: "stale", reasonCode: "plan_version_changed", currentPlanVersion: 2, allowedSessionRefs: [] });
    control.currentPlanVersion = 1;
    control.planActive = false;
    expect((await revalidate(call, snapshot)).body).toMatchObject({ status: "stale", reasonCode: "plan_version_changed" });
    control.planActive = true;
    control.status = "revoked";
    expect((await revalidate(call, snapshot)).body).toMatchObject({ status: "revoked", reasonCode: "content_revoked" });
    control.status = "expired";
    expect((await revalidate(call, snapshot)).body).toMatchObject({ status: "expired", reasonCode: "validity_ended" });
  });

  it("answers a 422 snapshot_mismatch for values the snapshot does not hold, a 404 for an unknown snapshot, and never an HTTP error for a status", async () => {
    const { call } = setup();
    const snapshot = (await create(call)).body as PlanSnapshot;
    expect((await revalidate(call, snapshot, { expectedPlanVersion: 9 })).body).toMatchObject({ error: { details: { fields: [{ rule: "snapshot_mismatch" }] } } });
    expect((await revalidate(call, snapshot, { bankVersion: 99 })).status).toBe(422);
    expect((await revalidate(call, { ...snapshot, snapshotId: UUID(1) })).status).toBe(404);
    expect((await revalidate(call, snapshot, { extra: 1 })).status).toBe(422);
  });
});

describe("E21 and E22 for the prepared sessions of a mock snapshot", () => {
  const event = (n: number, extra: Record<string, unknown> = {}): SessionEvent =>
    ({ clientEventId: UUID(n), type: "activity", startedAt: "2026-10-05T10:00:00.000Z", endedAt: "2026-10-05T10:00:30.000Z", activeMs: 30_000, ...extra }) as SessionEvent;
  const envelope = (snapshot: PlanSnapshot, sequence: number) => ({ clientRunId: UUID(500), snapshotId: snapshot.snapshotId, protocolVersion: 1, planVersion: 1, editionId: snapshot.editionId, bankVersion: snapshot.bankVersion, normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1", localSequence: sequence });

  it("rejects an event with no envelope on a prepared session, acknowledges an enveloped one, answers a repeat as duplicate and counts the interval once", async () => {
    const { call } = setup();
    const snapshot = (await create(call)).body as PlanSnapshot;
    const session = snapshot.preparedSessions[0]!.sessionId;
    const bare = (await call("POST", `/sessions/${session}/events`, { events: [event(1)] })).body as EventsResponse;
    expect(bare.rejected).toEqual([{ clientEventId: UUID(1), code: "envelope_mismatch" }]);
    const sent = [event(2, envelope(snapshot, 0)), event(3, { ...envelope(snapshot, 1), startedAt: "2026-10-05T10:00:10.000Z", endedAt: "2026-10-05T10:00:50.000Z", activeMs: 40_000 })];
    const first = (await call("POST", `/sessions/${session}/events`, { events: sent })).body as EventsResponse;
    expect(first.acknowledged).toEqual([UUID(2), UUID(3)]);
    expect(first.daily.dailyActiveMs - 420_000).toBe(50_000); // the union of the overlapping intervals, never the sum
    const again = (await call("POST", `/sessions/${session}/events`, { events: sent })).body as EventsResponse;
    expect(again.duplicate).toEqual([UUID(2), UUID(3)]);
    expect(again.daily.dailyActiveMs).toBe(first.daily.dailyActiveMs);
  });

  it("keeps the events pending without credit after a plan revision, and rejects them for a withdrawn edition (D59, G-06)", async () => {
    const { call, control: reachControl } = setup();
    const snapshot = (await create(call)).body as PlanSnapshot;
    const session = snapshot.preparedSessions[0]!.sessionId;
    const control = await reachControl();
    control.currentPlanVersion = 2;
    const pending = (await call("POST", `/sessions/${session}/events`, { events: [event(4, envelope(snapshot, 0))] })).body as EventsResponse;
    expect(pending.pending).toEqual([{ clientEventId: UUID(4), reasonCode: "plan_changed_unverifiable" }]);
    expect(pending.acknowledged).toEqual([]);
    control.currentPlanVersion = 1;
    control.status = "revoked";
    const rejected = (await call("POST", `/sessions/${session}/events`, { events: [event(5, envelope(snapshot, 1))] })).body as EventsResponse;
    expect(rejected.rejected).toEqual([{ clientEventId: UUID(5), code: "edition_mismatch" }]);
  });

  it("grades an answer from the key of the snapshot and leaves the sessions of E20 to the session mock", async () => {
    const { call } = setup();
    const snapshot = (await create(call)).body as PlanSnapshot;
    const game = snapshot.preparedSessions[1]!;
    const question = game.steps.flatMap((step) => (step.type === "question" ? [step.question] : []))[0]!;
    const answer = question.type === "word_order" ? { order: question.answerKey.order } : { optionId: "x" };
    const sent = event(6, { ...envelope(snapshot, 0), type: "answer", questionId: question.questionId, answer, hintUsed: false, occurredAt: "2026-10-05T10:00:00.000Z", durationMs: 1000 });
    const response = (await call("POST", `/sessions/${game.sessionId}/events`, { events: [sent] })).body as EventsResponse;
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ questionId: question.questionId, correct: true });
    // A session this mock never handed out is the session mock's: it answers its own 404.
    expect((await call("POST", `/sessions/${UUID(77)}/events`, { events: [event(7)] })).status).toBe(404);
    expect((await call("POST", `/sessions/${game.sessionId}/complete`)).body).toMatchObject({ summary: { answered: 1, correct: 1 } });
  });
});
