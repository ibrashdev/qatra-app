import { beforeEach, describe, expect, it } from "vitest";
import { clearAccountCache } from "@/lib/offline/db";
import { countOutbox, enqueueEvent } from "@/lib/offline/outbox";
import { adoptOwner, clearLocalCopy, completePendingLogout, isOfflineLocked, logoutLocally, matchOwner, readOwnerState, wipeIfDifferentAccount } from "@/lib/offline/owner";
import { cacheActivePlan, readReadyPlan } from "@/lib/offline/plan-cache";
import type { OwnerState } from "@/lib/offline/types";
import { FakeServer, OTHER_OWNER_ID, OWNER_ID, USERNAME, answerAt, envelopeError, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());

async function downloaded() {
  const snapshot = makeSnapshot();
  await cacheActivePlan(snapshot, { username: USERNAME });
  return snapshot;
}

describe("owner state (G-04)", () => {
  it("records the owner at the first download and compares usernames case-insensitively", async () => {
    expect(await matchOwner(USERNAME)).toEqual({ kind: "none" });
    await downloaded();
    expect(await matchOwner(USERNAME)).toMatchObject({ kind: "match" });
    expect(await matchOwner("  Test.LEARNER ")).toMatchObject({ kind: "match" });
    expect(await matchOwner("someone.else")).toMatchObject({ kind: "mismatch" });
  });

  it("never overwrites another owner: a second account must wipe first", async () => {
    await downloaded();
    await expect(adoptOwner({ ownerId: OTHER_OWNER_ID, username: "someone.else" })).rejects.toMatchObject({ code: "owner_mismatch" });
    const result = await cacheActivePlan(makeSnapshot({ userId: OTHER_OWNER_ID, snapshotId: uuid() }), { username: "someone.else" });
    expect(result).toMatchObject({ ready: false, failureCode: "owner_mismatch" });
    expect(await readReadyPlan(OWNER_ID)).not.toBeNull();
  });

  it("keeps the copy when the same username logs in again, and wipes it first for another username", async () => {
    const snapshot = await downloaded();
    await enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0));
    expect(await wipeIfDifferentAccount(USERNAME)).toBe(false);
    expect(await countOutbox(OWNER_ID)).toMatchObject({ total: 1 });

    expect(await wipeIfDifferentAccount("someone.else")).toBe(true);
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect((await readOwnerState()) as OwnerState).toMatchObject({ ownerId: null });
    // Nothing to wipe on a clean device.
    expect(await wipeIfDifferentAccount("anyone")).toBe(false);
  });
});

describe("logout, clear and the owed server logout (PWA-design 7)", () => {
  it("an offline logout wipes at once, counts the unsent answers it discards and records logoutPending", async () => {
    const snapshot = await downloaded();
    await enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0));
    await enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 1, 100));

    const result = await logoutLocally({ serverLogoutDone: false });

    expect(result).toEqual({ discardedEvents: 2, serverLogoutPending: true });
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect((await readOwnerState()) as OwnerState).toMatchObject({ ownerId: null, logoutPending: true });
  });

  it("an online logout owes nothing", async () => {
    await downloaded();
    expect(await logoutLocally({ serverLogoutDone: true })).toEqual({ discardedEvents: 0, serverLogoutPending: false });
    expect(((await readOwnerState()) as OwnerState).logoutPending).toBe(false);
  });

  it("the pending logout calls the server first, and 204 or 401 both settle it", async () => {
    await downloaded();
    await logoutLocally({ serverLogoutDone: false });
    const server = new FakeServer();
    expect(await completePendingLogout(server.client())).toBe("done");
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /auth/logout"]);
    expect(((await readOwnerState()) as OwnerState).logoutPending).toBe(false);
    expect(await completePendingLogout(server.client())).toBe("none");

    await downloaded();
    await logoutLocally({ serverLogoutDone: false });
    server.on("POST /auth/logout", envelopeError("unauthenticated", 401));
    expect(await completePendingLogout(server.client())).toBe("done");
  });

  it("a failed server logout keeps the flag so the next foreground check tries again", async () => {
    await downloaded();
    await logoutLocally({ serverLogoutDone: false });
    const server = new FakeServer();
    server.failNextNetwork = 1;
    expect(await completePendingLogout(server.client())).toBe("failed");
    expect(((await readOwnerState()) as OwnerState).logoutPending).toBe(true);
  });

  it("a new login settles the owed logout without calling the server (the new session must not be logged out)", async () => {
    await downloaded();
    await logoutLocally({ serverLogoutDone: false });
    await wipeIfDifferentAccount(USERNAME);
    expect(((await readOwnerState()) as OwnerState).logoutPending).toBe(false);
    expect(await completePendingLogout(new FakeServer().client())).toBe("none");
  });

  it("clearing the local copy reports the unsent answers it deletes and does not touch the account", async () => {
    const snapshot = await downloaded();
    await enqueueEvent(OWNER_ID, "s1", answerAt(snapshot, uuid(), 0));
    const server = new FakeServer();
    expect(await clearLocalCopy()).toEqual({ discardedEvents: 1 });
    expect(server.calls).toHaveLength(0);
    expect(await readReadyPlan(OWNER_ID)).toBeNull();
    expect(await isOfflineLocked()).toBe(false);
  });

  it("an offline logout on an already clean device is harmless", async () => {
    await clearAccountCache();
    expect(await logoutLocally({ serverLogoutDone: false })).toEqual({ discardedEvents: 0, serverLogoutPending: true });
  });
});
