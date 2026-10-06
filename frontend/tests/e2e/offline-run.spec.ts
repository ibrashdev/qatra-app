import { expect, test } from "@playwright/test";
import { TEXT, configureStub, downloadPlan, newTenant, readStores, signIn, stubState, type StubState } from "./support/offline-harness";
import { ANSWERS, ENVELOPE, goOffline, outbox, playDaily, playGame } from "./support/offline-play";

// R23 cases 3, 4 and 5 (QA-and-evaluation.md): the five prepared sessions offline, an enveloped outbox on the device before any feedback, then the
// reconnect and the replay with a lost answer, with no second effect for the same ids. The server here is the stateful stub with the tenant cookie.

test.describe.configure({ mode: "parallel" });

// The offline plan is about the service worker: it is allowed here although the project blocks it for the other specs.
test.use({ serviceWorkers: "allow" });

test.describe("R23 cases 3 and 4: the prepared sessions offline", () => {
  test("runs the daily session and the four games offline with no /api request, and writes enveloped events before the feedback", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    const log = await goOffline(page);

    await playDaily(page);
    for (const [name, answer] of Object.entries(ANSWERS)) await playGame(page, name, answer);

    // Every answer and interval is on the device with the full nine-field envelope; one run id per run.
    const events = await outbox(page);
    const answers = events.filter((entry) => entry.event.type === "answer");
    expect(answers).toHaveLength(2 + 4 * 2);
    for (const entry of events) {
      expect(entry.state).toBe("queued");
      for (const key of ENVELOPE) expect(entry.event, `${key} of ${entry.clientEventId}`).toHaveProperty(key);
      expect(entry.event.protocolVersion).toBe(1);
      expect(entry.event.normalizationPolicyVersion).toBe("arabic-norm-v1");
    }
    const runs = new Set(events.map((entry) => entry.event.clientRunId));
    expect(runs.size).toBe(5);
    const stores = await readStores(page);
    expect(stores.activeRuns).toHaveLength(5);
    expect((stores.activeRuns as { status: string }[]).every((run) => run.status === "finished")).toBe(true);
    // The sessions are the ones the server prepared, in their own descriptors.
    expect(new Set(events.map((entry) => entry.sessionId)).size).toBe(5);

    // Nothing was asked of the server, and every file of the screens was already cached (no failed same-origin load, no RSC payload).
    expect(log.api(), "no /api request while offline").toEqual([]);
    expect(log.rsc()).toEqual([]);
    expect(log.failedSameOrigin()).toEqual([]);
    expect((await stubState(tenant)).acknowledged).toEqual([]);

    // The fonts of the interface and of the book text loaded from the cache.
    const fonts = await page.evaluate(async () => ({ cairo: document.fonts.check("16px Cairo"), amiri: document.fonts.check("16px 'Amiri Quran'") }));
    expect(fonts.cairo).toBe(true);
    expect(fonts.amiri).toBe(true);
  });

  test("shows provisional minutes that never pass 100 percent, and keeps the day open until the server says otherwise (D40)", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await goOffline(page);
    // Eleven minutes of activity on the device clock today: the provisional figure is capped, and the day is never called completed.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("qatra-offline");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const read = db.transaction(["ownerState", "planSnapshots"], "readonly");
            const owner = read.objectStore("ownerState").get("current");
            const snapshots = read.objectStore("planSnapshots").getAll();
            read.oncomplete = () => {
              const record = (snapshots.result as { snapshotId: string; planId: string; planVersion: number; editionId: string; bankVersion: number }[])[0]!;
              const ownerId = (owner.result as { ownerId: string; generation: number }).ownerId;
              const write = db.transaction("pendingEvents", "readwrite");
              const now = Date.now();
              const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
              [0, 1].forEach((n) => {
                const startedAt = new Date(now - 11 * 60_000 + n * 5.5 * 60_000).toISOString();
                const endedAt = new Date(now - 11 * 60_000 + (n + 1) * 5.5 * 60_000).toISOString();
                const event = {
                  clientEventId: id(n),
                  type: "activity",
                  startedAt,
                  endedAt,
                  activeMs: 330_000,
                  clientRunId: id(100 + n),
                  snapshotId: record.snapshotId,
                  protocolVersion: 1,
                  planVersion: record.planVersion,
                  editionId: record.editionId,
                  bankVersion: record.bankVersion,
                  normalizationPolicyVersion: "arabic-norm-v1",
                  scoringPolicyVersion: "v1",
                  localSequence: n,
                };
                write.objectStore("pendingEvents").put({
                  clientEventId: id(n),
                  ownerId,
                  generation: (owner.result as { generation: number }).generation,
                  snapshotId: record.snapshotId,
                  sessionId: "55555555-5555-4555-8555-000000000000",
                  clientRunId: id(100 + n),
                  localSequence: n,
                  state: "queued",
                  event,
                  orderMs: Date.parse(startedAt),
                  attempts: 0,
                  createdAt: startedAt,
                  updatedAt: startedAt,
                });
              });
              write.oncomplete = () => {
                db.close();
                resolve();
              };
              write.onerror = () => reject(write.error);
            };
          };
        }),
    );
    await page.reload();
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(page.getByText("١١ من ١٠ دقيقة (مؤقت)").first()).toBeVisible();
    await expect(page.getByText(TEXT.savedOnDevice).first()).toBeVisible();
    await expect(page.getByText(/اليوم مكتمل|أكملت هدف اليوم/)).toHaveCount(0);
  });
});

test.describe("R23 case 5: reconnect, replay, a lost answer", () => {
  test("sends the queue in order, survives a committed-then-lost answer with the same ids, and counts every answer once", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await goOffline(page);
    await playDaily(page);
    const before = await outbox(page);
    const ids = before.map((entry) => entry.clientEventId);
    expect(ids.length).toBeGreaterThanOrEqual(3);

    // The server will commit the first batch and then lose its answer.
    await configureStub(tenant, { dropEventResponses: 1 });
    await context.setOffline(false);
    // The connection is back: the shell checks the account, revalidates and replays. The first batch is committed and its answer lost, so the events wait.
    await expect.poll(async () => (await stubState(tenant)).batches, { message: "the first batch reached the server" }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await stubState(tenant)).acknowledged.length, { message: "the server committed the batch" }).toBe(ids.length);

    // The resend carries the same ids and comes back as `duplicate`: nothing is counted twice.
    await page.waitForURL(/\/today$/, { timeout: 60_000 }).catch(async () => {
      // The first answer was lost, so the shell stays and offers the retry: the learner presses it.
      await page.getByRole("button", { name: /زامن الآن|إعادة المحاولة/ }).first().click();
      await page.waitForURL(/\/today$/, { timeout: 60_000 });
    });
    const after: StubState = await stubState(tenant);
    expect(new Set(after.acknowledged)).toEqual(new Set(ids));
    expect(after.acknowledged).toHaveLength(ids.length);
    expect(after.answerResults).toHaveLength(2);
    expect(after.batches).toBeGreaterThanOrEqual(2);
    // The ids the server logged are the ones stored on the device, in the order of their occurrence, under their original run and snapshot.
    for (const logged of after.eventLog) {
      const stored = before.find((entry) => entry.clientEventId === logged.clientEventId);
      expect(stored, logged.clientEventId).toBeDefined();
      expect(logged.clientRunId).toBe(stored?.event.clientRunId);
      expect(logged.snapshotId).toBe(stored?.event.snapshotId);
    }
    // Acknowledged events leave the outbox, and only then.
    await expect.poll(async () => (await outbox(page)).length).toBe(0);
    expect(after.daily.dailyCompleted).toBe(false);
  });

  test("waits and retries when the server answers 429 and 503, and does not call a slow wake-up a stale plan", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await goOffline(page);
    await playDaily(page);
    const ids = (await outbox(page)).map((entry) => entry.clientEventId);
    await configureStub(tenant, { rateLimitNext: 1, unavailableNext: 1 });
    await context.setOffline(false);
    // The outbox keeps everything until the server has it; the plan is never marked stale for a throttle or an outage.
    await expect.poll(async () => (await stubState(tenant)).requests.filter((entry) => entry.includes("/events")).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);
    let state = await stubState(tenant);
    if (state.acknowledged.length < ids.length) {
      await page.getByRole("button", { name: /زامن الآن|إعادة المحاولة/ }).first().click().catch(() => undefined);
    }
    for (let attempt = 0; attempt < 6 && (await stubState(tenant)).acknowledged.length < ids.length; attempt += 1) {
      await page.goto("/offline");
      await page.waitForTimeout(1500);
    }
    state = await stubState(tenant);
    expect(new Set(state.acknowledged)).toEqual(new Set(ids));
    const stores = await readStores(page);
    expect(JSON.stringify(stores.syncState ?? [])).not.toContain('"status":"stale"');
  });

  test("replays the queue from two tabs of one profile without sending an event twice", async ({ context, page }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await goOffline(page);
    await playDaily(page);
    const ids = (await outbox(page)).map((entry) => entry.clientEventId);
    const second = await context.newPage();
    await context.setOffline(false);
    await Promise.all([page.goto("/offline"), second.goto("/offline")]);
    await expect.poll(async () => (await stubState(tenant)).acknowledged.length, { timeout: 60_000 }).toBe(ids.length);
    const state = await stubState(tenant);
    // One effect per event whatever the number of tabs: the server's ids are unique and every answer was graded once.
    expect(new Set(state.acknowledged).size).toBe(ids.length);
    expect(state.answerResults).toHaveLength(2);
  });
});
