import { beforeEach, describe, expect, it } from "vitest";
import { clearAccountCache } from "@/lib/offline/db";
import { enqueueEvents } from "@/lib/offline/outbox";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { discardClosedRuns, finishRun, listRuns, readRun, saveRun, startRun } from "@/lib/offline/run-store";
import { DAILY_SESSION, OTHER_OWNER_ID, OWNER_ID, USERNAME, answerAt, dumpAllStores, makeSnapshot, resetOfflineEnvironment } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());

async function ready() {
  const snapshot = makeSnapshot();
  await cacheActivePlan(snapshot, { username: USERNAME });
  return snapshot;
}

describe("activeRuns (saved before the page closes)", () => {
  it("starts a run with a new run id every time, sequence 0, over the same prepared session", async () => {
    const snapshot = await ready();
    const a = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    const b = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    expect(a.clientRunId).not.toBe(b.clientRunId);
    expect(a).toMatchObject({ ownerId: OWNER_ID, snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily", stepIndex: 0, nextLocalSequence: 0, status: "active", answered: {}, extra: {} });
    expect(a.clientRunId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("saves the step, the provisional verdicts and small UI state, and reads them back after a reload", async () => {
    const snapshot = await ready();
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    await saveRun(OWNER_ID, run.clientRunId, { stepIndex: 2, answered: { "q-choice": { clientEventId: "e1", correct: true, assisted: false } }, extra: { round: 1, hinted: false } });
    const restored = await readRun(OWNER_ID, run.clientRunId);
    expect(restored).toMatchObject({ stepIndex: 2, answered: { "q-choice": { correct: true } }, extra: { round: 1 } });
    expect((restored?.updatedAt ?? "") >= run.updatedAt).toBe(true);
  });

  it("keeps a restored run's sequence where the last enqueue left it", async () => {
    const snapshot = await ready();
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "game" });
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [answerAt(snapshot, run.clientRunId, 0), answerAt(snapshot, run.clientRunId, 1, 10)]);
    expect((await readRun(OWNER_ID, run.clientRunId))?.nextLocalSequence).toBe(2);
  });

  it("lists by status, finishes, and discards closed runs", async () => {
    const snapshot = await ready();
    const a = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    const b = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "game" });
    await finishRun(OWNER_ID, a.clientRunId, "finished");
    await finishRun(OWNER_ID, b.clientRunId, "abandoned");
    const c = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    expect((await listRuns(OWNER_ID)).length).toBe(3);
    expect((await listRuns(OWNER_ID, "active")).map((run) => run.clientRunId)).toEqual([c.clientRunId]);
    expect(await discardClosedRuns(OWNER_ID)).toBe(2);
    expect((await listRuns(OWNER_ID)).map((run) => run.clientRunId)).toEqual([c.clientRunId]);
  });

  it("refuses another owner, a run that is not there, and a copy that was cleared", async () => {
    const snapshot = await ready();
    await expect(startRun(OTHER_OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" })).rejects.toMatchObject({ code: "owner_mismatch" });
    await expect(startRun(OWNER_ID, { snapshotId: "", sessionId: DAILY_SESSION, kind: "daily" })).rejects.toMatchObject({ code: "invalid_run" });
    await expect(saveRun(OWNER_ID, "missing", { stepIndex: 1 })).rejects.toMatchObject({ code: "not_found" });
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    expect(await readRun(OTHER_OWNER_ID, run.clientRunId)).toBeNull();
    expect(await listRuns(OTHER_OWNER_ID)).toEqual([]);

    await clearAccountCache(OWNER_ID);
    expect(await readRun(OWNER_ID, run.clientRunId)).toBeNull();
    await expect(saveRun(OWNER_ID, run.clientRunId, { stepIndex: 3 })).rejects.toMatchObject({ code: "owner_mismatch" });
    expect((await dumpAllStores()).activeRuns).toEqual([]);
  });

  it("a run from before a clear cannot be written after the same learner downloads again (generation_mismatch)", async () => {
    const snapshot = await ready();
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    await clearAccountCache(OWNER_ID);
    await cacheActivePlan(snapshot, { username: USERNAME });
    await expect(startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" }, { generation: run.generation })).rejects.toMatchObject({ code: "generation_mismatch" });
  });
});
