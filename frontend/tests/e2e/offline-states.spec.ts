import { expect, test } from "@playwright/test";
import { TEXT, configureStub, downloadPlan, newTenant, readStores, signIn, stubState } from "./support/offline-harness";
import { axeViolations, smallTargets } from "./fixtures";
import { goOffline, outbox, playDaily } from "./support/offline-play";

// R23 case 6 (a revoked or changed plan on return), the 401 of a session that ended, the quota failure of case 8 and case 9 (no login or account offline).
// The server is the stateful stub with the tenant cookie; what the spec injects (`revoked`, `planVersion`, `me401`) is what the real server would say.

test.describe.configure({ mode: "parallel" });

// The offline plan is about the service worker: it is allowed here although the project blocks it for the other specs.
test.use({ serviceWorkers: "allow" });

// A learner who played the daily session offline, so the device holds answers when the connection comes back.
async function withAnswers(page: import("@playwright/test").Page, tenant: string) {
  await signIn(page.context(), tenant);
  await downloadPlan(page);
  await goOffline(page);
  await playDaily(page);
  const events = await outbox(page);
  expect(events.length).toBeGreaterThanOrEqual(3);
  return events;
}

test.describe("R23 case 6: a plan that changed or was withdrawn while the device was away", () => {
  test("a revoked edition wipes the material, blocks the answers visibly and sends no source text", async ({ page, context }) => {
    const tenant = newTenant();
    const events = await withAnswers(page, tenant);
    await configureStub(tenant, { revoked: true });
    await context.setOffline(false);
    await expect.poll(async () => (await stubState(tenant)).requests.some((entry) => entry.includes("/offline/revalidate")), { timeout: 30_000 }).toBe(true);
    await page.waitForURL(/\/today$/, { timeout: 60_000 });
    // Online: the card says the plan is unavailable; nothing of the withdrawn edition is offered.
    await expect(page.getByText(TEXT.unavailable).first()).toBeVisible();

    const state = await stubState(tenant);
    expect(state.acknowledged, "blocked answers are never sent as accepted").toEqual([]);
    const stores = await readStores(page);
    const stored = (stores.pendingEvents ?? []) as { state: string; clientEventId: string }[];
    // They stay on the device, visibly blocked, and are not deleted silently.
    expect(stored.map((entry) => entry.clientEventId).sort()).toEqual(events.map((entry) => entry.clientEventId).sort());
    expect(stored.every((entry) => entry.state === "blocked")).toBe(true);
    // The withdrawn material is gone from every store: no lesson text, no question, no answer key.
    const dump = JSON.stringify(stores);
    expect(dump).not.toContain("كلمة٥ كلمة٦ كلمة٧");
    expect(dump).not.toContain("answerKey");

    // Offline again: the shell says «غير متاح», runs nothing, and keeps the count of what was not counted.
    await context.setOffline(true);
    await page.goto("/offline");
    await expect(page.getByRole("heading", { level: 2, name: TEXT.unavailable })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^ابدأ: / })).toHaveCount(0);
    await expect(page.getByText(/إجابات لم تُحتسب/)).toBeVisible();
    await expect(page.getByText("لم تُحتسب هذه الإجابة.", { exact: false })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
  });

  test("a plan that moved on keeps the old answers pending without credit, stops new runs, and never re-attributes them", async ({ page, context }) => {
    const tenant = newTenant();
    const events = await withAnswers(page, tenant);
    const oldSnapshot = events[0]!.event.snapshotId;
    await configureStub(tenant, { planVersion: 2 });
    await context.setOffline(false);
    await page.waitForURL(/\/today$/, { timeout: 60_000 });
    await expect(page.getByRole("button", { name: "حدّث التنزيل" })).toBeVisible();
    await expect(page.getByText(TEXT.ready)).toHaveCount(0);

    const state = await stubState(tenant);
    // The server cannot prove precedence after a revision: the events come back pending, with no credit (D59).
    expect(state.acknowledged).toEqual([]);
    expect(new Set(state.pending)).toEqual(new Set(events.map((entry) => entry.clientEventId)));
    const pending = await outbox(page);
    expect(pending.every((entry) => entry.state === "pending" && entry.reasonCode === "plan_changed_unverifiable")).toBe(true);
    expect(pending.every((entry) => entry.event.snapshotId === oldSnapshot)).toBe(true);

    // Offline: new runs of the stale plan stop, the calm line says the answers are being verified.
    await context.setOffline(true);
    await page.goto("/offline");
    await expect(page.getByRole("heading", { level: 2, name: "الخطة المحمّلة قديمة" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^ابدأ: / })).toHaveCount(0);
    await expect(page.getByText("ما زالت هذه الإجابة قيد التحقق.", { exact: false })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);

    // Online again: the update downloads a new snapshot; the old answers keep their own snapshot and are not moved to the new one.
    await context.setOffline(false);
    await page.goto("/today");
    await page.getByRole("button", { name: "حدّث التنزيل" }).click();
    await expect(page.getByText(TEXT.ready).first()).toBeVisible({ timeout: 45_000 });
    const afterUpdate = await outbox(page);
    expect(afterUpdate.every((entry) => entry.event.snapshotId === oldSnapshot)).toBe(true);
    expect(afterUpdate.length).toBe(events.length);
    expect((await stubState(tenant)).snapshots).toBe(2);
  });

  test("a 401 stops the replay, keeps the local copy and the answers, and asks for an online login", async ({ page, context }) => {
    const tenant = newTenant();
    const events = await withAnswers(page, tenant);
    await configureStub(tenant, { me401: true });
    await context.setOffline(false);
    await expect(page.getByText(TEXT.sessionEnded)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("link", { name: "تسجيل الدخول" })).toHaveAttribute("href", "/login");
    // The local day is still there, and nothing was sent or wiped.
    await expect(page.getByText(TEXT.ready).first()).toBeVisible();
    expect((await stubState(tenant)).acknowledged).toEqual([]);
    expect((await outbox(page)).map((entry) => entry.clientEventId).sort()).toEqual(events.map((entry) => entry.clientEventId).sort());
    expect(new URL(page.url()).pathname).toBe("/offline");
    expect(await axeViolations(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
  });
});

test.describe("R23 case 8: storage that cannot hold the plan", () => {
  test("a full quota leaves the snapshot not ready, says so, and never claims the plan is downloaded", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    // Every write of the plan snapshot fails as a full disk does.
    await page.addInitScript(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
        if (this.name === "planSnapshots") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return original.apply(this, args);
      };
    });
    await page.goto("/today");
    await page.getByRole("button", { name: TEXT.downloadCta }).waitFor();
    await page.getByRole("button", { name: TEXT.downloadCta }).click();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("لا توجد مساحة كافية");
    await expect(page.getByText(TEXT.ready)).toHaveCount(0);
    // The retry stays, and nothing ready is on the device.
    await expect(page.getByRole("button", { name: TEXT.downloadCta })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    const stores = await readStores(page);
    expect(((stores.planSnapshots ?? []) as { ready: boolean }[]).filter((record) => record.ready)).toHaveLength(0);
  });
});

test.describe("R23 case 9: no login, registration or new plan offline", () => {
  test("the login form says there is no connection, creates nothing and reaches no server", async ({ page, context }) => {
    const answered: string[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/auth/")) answered.push(response.url());
    });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "دخول", exact: true })).toBeVisible();
    await context.setOffline(true);
    await page.getByLabel("اسم المستخدم").fill("learner.offline");
    await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill("a synthetic passphrase for docs only");
    await page.getByRole("button", { name: "دخول", exact: true }).click();
    await expect(page.getByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeVisible();
    expect(answered).toEqual([]);
    expect(new URL(page.url()).pathname).toBe("/login");
  });
});
