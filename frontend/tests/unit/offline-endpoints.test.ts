import { describe, expect, it } from "vitest";
import { OFFLINE_SNAPSHOT_RETRY, OFFLINE_SNAPSHOT_TIMEOUT_MS, createOfflineSnapshot, readOfflineSnapshot, revalidateOffline } from "@/lib/api/offline-endpoints";
import { ApiError } from "@/lib/api/errors";
import { FakeServer, PLAN_ID, envelopeError, makeSnapshot, uuid } from "./offline-support";

describe("E23 createOfflineSnapshot", () => {
  it("posts exactly the contract body, with no field the server forbids, and omits the target refs when the caller has none (G-01)", async () => {
    const server = new FakeServer();
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 201, body: makeSnapshot() });
    const operationId = uuid();
    const snapshot = await createOfflineSnapshot(server.client(), PLAN_ID, { clientOperationId: operationId, expectedPlanVersion: 2 });
    expect(snapshot.snapshotId).toBeDefined();
    expect(server.calls[0]).toMatchObject({ method: "POST", path: `/plans/${PLAN_ID}/offline-snapshots`, body: { clientOperationId: operationId, expectedPlanVersion: 2 } });
    expect(Object.keys(server.calls[0]?.body as object)).toEqual(["clientOperationId", "expectedPlanVersion"]);
  });

  it("sends the target refs when given and ignores any other property of the request", async () => {
    const server = new FakeServer();
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 200, body: makeSnapshot() });
    await createOfflineSnapshot(server.client(), PLAN_ID, { clientOperationId: uuid(), expectedPlanVersion: 1, downloadTargetRefs: ["a", "b"], userId: "x", mode: "demo" } as never);
    expect(Object.keys(server.calls[0]?.body as object).sort()).toEqual(["clientOperationId", "downloadTargetRefs", "expectedPlanVersion"]);
  });

  it("is marked safe to repeat, waits 60 s and retries a lost answer once with the same id", async () => {
    expect(OFFLINE_SNAPSHOT_TIMEOUT_MS).toBe(60_000);
    expect(OFFLINE_SNAPSHOT_RETRY.delaysMs).toEqual([2000]);
    const server = new FakeServer();
    server.failNextNetwork = 1;
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { body: makeSnapshot() });
    await createOfflineSnapshot(server.client(), PLAN_ID, { clientOperationId: uuid(), expectedPlanVersion: 1 });
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0]?.body).toEqual(server.calls[1]?.body);
  });

  it("encodes the plan id in the path and surfaces an API error as ApiError", async () => {
    const server = new FakeServer();
    server.on("POST /plans/*", envelopeError("version_conflict", 409, { reason: "plan_version", currentVersion: 3 }));
    const error = await createOfflineSnapshot(server.client(), "a/b", { clientOperationId: uuid(), expectedPlanVersion: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details).toMatchObject({ reason: "plan_version", currentVersion: 3 });
    expect(server.calls[0]?.path).toBe("/plans/a%2Fb/offline-snapshots");
  });
});

describe("E24 readOfflineSnapshot", () => {
  it("is a GET without a body, never creates anything, and 404 stays an ApiError", async () => {
    const server = new FakeServer();
    server.on("GET /offline-snapshots/s1", { body: makeSnapshot() });
    await readOfflineSnapshot(server.client(), "s1");
    expect(server.calls[0]).toMatchObject({ method: "GET", path: "/offline-snapshots/s1", body: undefined });
    server.on("GET /offline-snapshots/gone", envelopeError("not_found", 404));
    await expect(readOfflineSnapshot(server.client(), "gone")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("E25 revalidateOffline", () => {
  it("posts the four values the device holds and nothing else", async () => {
    const server = new FakeServer();
    const result = await revalidateOffline(server.client(), { snapshotId: "s", expectedPlanVersion: 2, editionId: "e", bankVersion: 3, extra: "no" } as never);
    expect(server.calls[0]?.body).toEqual({ snapshotId: "s", expectedPlanVersion: 2, editionId: "e", bankVersion: 3 });
    expect(result).toMatchObject({ status: "available", reasonCode: "current" });
  });

  it("returns the status in the body of a 200, whatever it says", async () => {
    const server = new FakeServer();
    server.on("POST /offline/revalidate", { body: { status: "revoked", currentPlanVersion: 2, allowedSessionRefs: [], catalogVersion: 4, reasonCode: "content_revoked" } });
    await expect(revalidateOffline(server.client(), { snapshotId: "s", expectedPlanVersion: 1, editionId: "e", bankVersion: 3 })).resolves.toMatchObject({ status: "revoked" });
  });
});
