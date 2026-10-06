import { expect, test, type Page } from "@playwright/test";
import { TEXT, configureStub, downloadPlan, newTenant, readStores, signIn, stubState } from "./support/offline-harness";
import { goOffline, outbox, playDaily } from "./support/offline-play";

// R23 case 7 (logout, account switch, delete, then offline open) and the clearing rules of D58: the copy and the unsent answers leave the device with the
// account, the learner is asked first, and no secret is ever stored. The server is the stateful stub with the tenant cookie.

test.describe.configure({ mode: "parallel" });

// The offline plan is about the service worker: it is allowed here although the project blocks it for the other specs.
test.use({ serviceWorkers: "allow" });

// The learner played offline and is back online, but the server keeps answering 503, so the answers are still on the device (unsynced).
async function withUnsynced(page: Page, tenant: string) {
  await signIn(page.context(), tenant);
  await downloadPlan(page);
  await goOffline(page);
  await playDaily(page);
  const events = await outbox(page);
  expect(events.length).toBeGreaterThanOrEqual(3);
  await configureStub(tenant, { unavailableNext: 1000 });
  return events;
}

// Everything the browser keeps for the origin, as text, to look for what must never be there.
async function everythingStored(page: Page): Promise<string> {
  const stores = JSON.stringify(await readStores(page));
  const rest = await page.evaluate(async () => {
    const cacheEntries: string[] = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) cacheEntries.push(request.url);
    }
    return { cacheEntries, local: JSON.stringify({ ...localStorage }), cookies: document.cookie };
  });
  return `${stores}\n${rest.cacheEntries.join("\n")}\n${rest.local}\n${rest.cookies}`;
}

const SECRETS = /eyJ[A-Za-z0-9_-]{10,}|access_token|refresh_token|__Host-qatra_session|password|passphrase/i;

test.describe("R23 case 7: logout, account switch and delete", () => {
  test("asks before a logout that would delete unsynced answers, and wipes the copy, the answers and the generation when confirmed", async ({ page, context }) => {
    const tenant = newTenant();
    const events = await withUnsynced(page, tenant);
    await context.setOffline(false);
    const before = ((await readStores(page)).ownerState ?? []) as { generation: number; ownerId: string | null }[];
    expect(before[0]?.ownerId).not.toBeNull();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "الإعدادات" })).toBeVisible();
    // The sync chip of the settings row reads the device.
    await expect(page.getByText(TEXT.savedOnDevice).first()).toBeVisible();
    await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: TEXT.logoutDialogTitle })).toBeVisible();
    await expect(dialog).toContainText(/لديك .+ إجابات لم تُزامن بعد\. إن خرجت الآن فستُحذف من هذا الجهاز\./);
    // «إلغاء» has the initial focus and keeps everything.
    await expect(dialog.getByRole("button", { name: "إلغاء" })).toBeFocused();
    await dialog.getByRole("button", { name: "إلغاء" }).click();
    expect((await stubState(tenant)).logoutCalls).toBe(0);
    expect((await outbox(page)).length).toBe(events.length);

    await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    expect((await stubState(tenant)).logoutCalls).toBe(1);
    const stores = await readStores(page);
    expect(stores.planSnapshots ?? []).toHaveLength(0);
    expect(stores.pendingEvents ?? []).toHaveLength(0);
    expect(stores.activeRuns ?? []).toHaveLength(0);
    const owner = ((stores.ownerState ?? []) as { generation: number; ownerId: string | null; logoutPending: boolean }[])[0];
    expect(owner?.ownerId).toBeNull();
    expect(owner?.logoutPending).toBe(false);
    expect(owner?.generation).toBeGreaterThan(before[0]!.generation);
    // No token, cookie value or password in any store, cache or storage of the origin (R23 case 7).
    expect(await everythingStored(page)).not.toMatch(SECRETS);

    // Opened offline afterwards the previous account's plan and queue are not there.
    await page.context().setOffline(true);
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: TEXT.noPlan })).toBeVisible({ timeout: 30_000 });
  });

  test("keeps the plan and the answers when the same account logs in again, and wipes them when another account does", async ({ page, context }) => {
    const tenant = newTenant();
    const events = await withUnsynced(page, tenant);
    // The session of the learner ended on the server (not a logout): the device keeps its copy.
    await configureStub(tenant, { signedIn: false, unavailableNext: 0 });
    await context.setOffline(false);
    await page.goto("/login");
    await page.getByLabel("اسم المستخدم").fill("learner.a");
    await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill("a synthetic passphrase for docs only");
    await page.getByRole("button", { name: "دخول", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    expect((await outbox(page)).map((entry) => entry.clientEventId).sort()).toEqual(events.map((entry) => entry.clientEventId).sort());
    expect((((await readStores(page)).planSnapshots ?? []) as unknown[]).length).toBe(1);

    // Another account logs in on the same device: the copy of the first is wiped before anything of the second is shown, and nothing is sent for it.
    await configureStub(tenant, { signedIn: false });
    await page.goto("/login");
    await page.getByLabel("اسم المستخدم").fill("learner.b");
    await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill("a synthetic passphrase for docs only");
    await page.getByRole("button", { name: "دخول", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    const stores = await readStores(page);
    expect(stores.planSnapshots ?? []).toHaveLength(0);
    expect(stores.pendingEvents ?? []).toHaveLength(0);
    expect(((stores.ownerState ?? []) as { ownerId: string | null }[])[0]?.ownerId ?? null).toBeNull();
    expect((await stubState(tenant)).acknowledged).toEqual([]);
  });

  test("an offline logout wipes the copy at once, records the owed server logout, and calls it first when the connection returns", async ({ page, context }) => {
    const tenant = newTenant();
    await withUnsynced(page, tenant);
    await context.setOffline(false);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "الإعدادات" })).toBeVisible();
    await context.setOffline(true);
    await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
    // The learner lands on a screen that needs no account (the login screen or the offline shell), with nothing of the account on the device.
    await page.waitForURL(/\/(login|offline)$/, { timeout: 30_000 });
    const stores = await readStores(page);
    expect(stores.planSnapshots ?? []).toHaveLength(0);
    expect(stores.pendingEvents ?? []).toHaveLength(0);
    const owner = ((stores.ownerState ?? []) as { ownerId: string | null; logoutPending: boolean }[])[0];
    expect(owner?.ownerId).toBeNull();
    expect(owner?.logoutPending).toBe(true);
    expect((await stubState(tenant)).logoutCalls).toBe(0);

    // The connection returns and the learner opens the app again: the server logout owed is asked before the old session can be used, so the guest screen
    // is not sent on to the online app by the session that was never ended.
    await context.setOffline(false);
    await page.goto("/login");
    await expect.poll(async () => (await stubState(tenant)).logoutCalls, { timeout: 45_000 }).toBe(1);
    await expect.poll(async () => ((((await readStores(page)).ownerState ?? []) as { logoutPending: boolean }[])[0]?.logoutPending), { timeout: 30_000 }).toBe(false);
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  test("deleting the account removes the copy kept for offline use", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await page.goto("/settings/delete-account");
    await expect(page.getByText(/ستُحذف دون أن تُحفظ/)).toBeVisible();
    await page.getByRole("textbox", { name: "كلمة المرور الحالية" }).fill("a synthetic passphrase for docs only");
    await page.getByLabel("أفهم أن حذف حسابي نهائي ولا يمكن التراجع عنه").check();
    await page.getByRole("button", { name: "حذف حسابي نهائيًا" }).click();
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect.poll(async () => (((await readStores(page)).planSnapshots ?? []) as unknown[]).length, { timeout: 15_000 }).toBe(0);
    expect(((((await readStores(page)).ownerState ?? []) as { ownerId: string | null }[])[0])?.ownerId ?? null).toBeNull();
  });

  test("a failed clear keeps the personal view locked until the storage is repaired", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    // From here every clear of a store fails, as a broken profile does.
    await page.evaluate(() => {
      IDBObjectStore.prototype.clear = function failing() {
        throw new DOMException("The transaction failed.", "UnknownError");
      };
      IDBObjectStore.prototype.delete = function failing() {
        throw new DOMException("The transaction failed.", "UnknownError");
      };
    });
    await page.getByRole("button", { name: "احذف النسخة المحلية" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "احذف النسخة المحلية" }).click();
    await expect(page.getByText("تعذّر حذف النسخة المحلية")).toBeVisible({ timeout: 15_000 });
    await page.context().setOffline(true);
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: "الخطة المحفوظة مغلقة" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^ابدأ: / })).toHaveCount(0);
    await page.getByRole("button", { name: "إعادة المحاولة" }).click();
    await expect(page.getByRole("heading", { name: TEXT.noPlan })).toBeVisible({ timeout: 30_000 });
  });
});
