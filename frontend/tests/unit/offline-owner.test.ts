import { beforeEach, describe, expect, it } from "vitest";
import { clearAccountCache } from "@/lib/offline/db";
import { countOutbox, enqueueEvent } from "@/lib/offline/outbox";
import { bindOnlineAccount, countOnlineEvents, currentOnlineBinding, recordOnlineEvents } from "@/lib/offline/online-journal";
import { adoptOwner, clearLocalCopy, completePendingLogout, isOfflineLocked, logoutLocally, matchOwner, readOwnerState, wipeIfDifferentAccount } from "@/lib/offline/owner";
import { cacheActivePlan, readReadyPlan } from "@/lib/offline/plan-cache";
import type { OwnerState } from "@/lib/offline/types";
import { FakeServer, OTHER_OWNER_ID, OWNER_ID, USERNAME, answerAt, envelopeError, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";
import { ONLINE_SESSION, dumpStore, onlineAnswerAt } from "./offline-online-support";

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
    // Nothing to wipe on a clean device. (The login above recorded its username on the cleared owner, so the device is cleared first: a third username would
    // wipe that one, which is the next test.)
    await clearAccountCache();
    expect(await wipeIfDifferentAccount("anyone")).toBe(false);
  });
});

describe("a username-only owner, the account of the online journal (PWA-design 7)", () => {
  async function onlineOnly(username = USERNAME) {
    const binding = await bindOnlineAccount(username);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0), onlineAnswerAt(10)]);
    return binding;
  }

  it("records the username after a login on a device that has nothing yet, so an online session binds without a request", async () => {
    expect(await readOwnerState()).toBeNull();
    expect(await wipeIfDifferentAccount("  Test.Learner ")).toBe(false);
    expect(await readOwnerState()).toMatchObject({ ownerId: null, username: "Test.Learner", logoutPending: false });
    expect(await currentOnlineBinding()).toEqual({ accountKey: "test.learner", generation: 1 });
  });

  it("records it on a cleared owner too, and never renames an owner that already has a username", async () => {
    await downloaded();
    await clearAccountCache();
    expect(((await readOwnerState()) as OwnerState).username).toBeNull();
    expect(await wipeIfDifferentAccount(USERNAME)).toBe(false);
    expect(((await readOwnerState()) as OwnerState).username).toBe(USERNAME);
    // The same account in another spelling keeps what is there.
    expect(await wipeIfDifferentAccount(" TEST.learner ")).toBe(false);
    expect(((await readOwnerState()) as OwnerState).username).toBe(USERNAME);
  });

  it("keeps the journal when the same account logs in again", async () => {
    await onlineOnly();
    expect(await wipeIfDifferentAccount(" TEST.learner ")).toBe(false);
    expect(await countOnlineEvents("test.learner")).toMatchObject({ total: 2 });
  });

  it("wipes the journal first when another username logs in, even though no ownership id was ever recorded", async () => {
    await onlineOnly();
    expect(((await readOwnerState()) as OwnerState).ownerId).toBeNull();
    expect(await wipeIfDifferentAccount("someone.else")).toBe(true);
    expect(await countOnlineEvents("test.learner")).toMatchObject({ total: 0 });
    expect(await dumpStore("onlineEvents")).toEqual([]);
    // The new account owns the device now.
    expect(await readOwnerState()).toMatchObject({ ownerId: null, username: "someone.else" });
    await expect(bindOnlineAccount(USERNAME)).rejects.toMatchObject({ code: "owner_mismatch" });
  });

  it("does not adopt a downloaded copy for another account on top of it", async () => {
    await onlineOnly();
    await expect(adoptOwner({ ownerId: OTHER_OWNER_ID, username: "someone.else" })).rejects.toMatchObject({ code: "owner_mismatch" });
    expect(await readOwnerState()).toMatchObject({ ownerId: null, username: USERNAME });
    // The same account may download: the journal and the copy then share one owner.
    await expect(adoptOwner({ ownerId: OWNER_ID, username: " TEST.learner" })).resolves.toMatchObject({ ownerId: OWNER_ID });
    expect(await countOnlineEvents("test.learner")).toMatchObject({ total: 2 });
  });

  it("settles an owed offline logout and still records the username of the new login", async () => {
    await downloaded();
    await logoutLocally({ serverLogoutDone: false });
    expect(await wipeIfDifferentAccount("someone.else")).toBe(false);
    expect(await readOwnerState()).toMatchObject({ ownerId: null, username: "someone.else", logoutPending: false });
  });

  it("an offline logout counts the unsent online answers it discards and still records that the server logout is owed", async () => {
    await onlineOnly();
    expect(await logoutLocally({ serverLogoutDone: false })).toEqual({ discardedEvents: 2, serverLogoutPending: true });
    expect(await readOwnerState()).toMatchObject({ ownerId: null, username: null, logoutPending: true });
    expect(await dumpStore("onlineEvents")).toEqual([]);
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
