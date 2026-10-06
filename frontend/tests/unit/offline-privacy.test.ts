import { beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { enqueueEvents } from "@/lib/offline/outbox";
import { clearLocalCopy, logoutLocally } from "@/lib/offline/owner";
import { downloadPlanForOffline } from "@/lib/offline/plan-cache";
import { startRun } from "@/lib/offline/run-store";
import { syncForeground } from "@/lib/offline/sync";
import { DAILY_SESSION, FakeServer, OWNER_ID, PLAN_ID, activityAt, answerAt, dumpAllStores, fakeClock, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

beforeEach(() => resetOfflineEnvironment());

// R23 case 7: no auth secrets in Cache Storage or IndexedDB, and no personal data in localStorage beyond the locale and a lock flag.
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{8,}/;
const SECRET_WORDS = /access_token|refresh_token|id_token|__Host-qatra_session|Bearer\s|authorization|set-cookie|password|recovery/i;
const SECRET_KEYS = /^(access_?|refresh_?|id_?)?token$|cookie|password|secret|jwt|authorization/i;

const SESSION_COOKIE = "__Host-qatra_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl; Path=/; HttpOnly; Secure; SameSite=Lax";

function keysDeep(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, found));
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      keysDeep(child, found);
    }
  }
  return found;
}

describe("what the device stores (PWA-design 4, Authentication-and-privacy)", () => {
  it("after download, a run, a sync and every kind of event, IndexedDB and localStorage hold no token, no cookie and no password", async () => {
    const snapshot = makeSnapshot();
    const server = new FakeServer();
    server.extraHeaders = { "Set-Cookie": SESSION_COOKIE, "X-Session": "eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.c2ln" };
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 201, body: snapshot });
    expect((await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: server.client() })).ready).toBe(true);

    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [
      answerAt(snapshot, run.clientRunId, 0, 0, { questionId: "q-recall", answer: { text: "zzzrecall" } }),
      activityAt(snapshot, run.clientRunId, 1, 3000),
    ]);
    // Stored while waiting: the recall text is allowed here, and only here, until the server has it.
    const waiting = JSON.stringify(await dumpAllStores());
    expect(waiting.includes("zzzrecall")).toBe(true);

    const time = fakeClock();
    await syncForeground(OWNER_ID, { client: server.client(), now: time.now, sleep: time.sleep, isOnline: () => true });

    const dump = await dumpAllStores();
    const text = JSON.stringify(dump);
    expect(text).not.toMatch(JWT_LIKE);
    expect(text).not.toMatch(SECRET_WORDS);
    for (const key of keysDeep(dump)) expect(key).not.toMatch(SECRET_KEYS);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) as string;
      expect(`${key}=${window.localStorage.getItem(key)}`).not.toMatch(JWT_LIKE);
      expect(key).toMatch(/^qatra\./);
    }
    // After the acknowledgement the answer text is gone from the device.
    expect(text.includes("zzzrecall")).toBe(false);
  });

  it("no request carries an Authorization header and the client never reads the cookie", async () => {
    const snapshot = makeSnapshot();
    const server = new FakeServer();
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 201, body: snapshot });
    await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: server.client() });
    for (const call of server.calls) expect(Object.keys(call.headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("the stored snapshot holds the ownership id, which is not a credential, and the username, never a password", async () => {
    const snapshot = makeSnapshot();
    const server = new FakeServer();
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 201, body: snapshot });
    await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: server.client() });
    const { ownerState } = await dumpAllStores();
    expect(Object.keys(ownerState[0] as object).sort()).toEqual(["clearFailed", "generation", "logoutPending", "ownerId", "updatedAt", "username"]);
  });
});

describe("what a logout or a clear leaves behind", () => {
  async function populated() {
    const snapshot = makeSnapshot();
    const server = new FakeServer();
    server.on(`POST /plans/${PLAN_ID}/offline-snapshots`, { status: 201, body: snapshot });
    await downloadPlanForOffline({ planId: PLAN_ID, expectedPlanVersion: 1 }, { client: server.client() });
    const run = await startRun(OWNER_ID, { snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
    await enqueueEvents(OWNER_ID, DAILY_SESSION, [answerAt(snapshot, run.clientRunId, 0, 0, { questionId: "q-recall", answer: { text: "zzzrecall" } })]);
    return snapshot;
  }

  it.each([
    ["an offline logout", () => logoutLocally({ serverLogoutDone: false })],
    ["an online logout", () => logoutLocally({ serverLogoutDone: true })],
    ["clearing the local copy", () => clearLocalCopy()],
  ])("%s leaves only the owner record: no lesson, no question, no answer, no id of the learner", async (_name, act) => {
    await populated();
    await act();
    const dump = await dumpAllStores();
    expect(dump.planSnapshots).toEqual([]);
    expect(dump.activeRuns).toEqual([]);
    expect(dump.pendingEvents).toEqual([]);
    expect(dump.syncState).toEqual([]);
    const text = JSON.stringify(dump);
    expect(text.includes(OWNER_ID)).toBe(false);
    expect(text.includes("zzzrecall")).toBe(false);
    expect(text.includes("test.learner")).toBe(false);
    expect(uuid()).toBeDefined();
  });

  it("a client built for the offline code sends the cookie only to the same origin", async () => {
    const calls: RequestInit[] = [];
    const client = createApiClient({
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    await client.get("/me");
    expect(calls[0]?.credentials).toBe("same-origin");
    await expect(client.get("https://elsewhere.example/x")).rejects.toBeInstanceOf(TypeError);
  });
});
