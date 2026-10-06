import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TEXT, downloadPlan, newTenant, signIn } from "./support/offline-harness";
import { LABEL } from "./support/offline-play";

// R23 case 8 (service worker update): a new version of the worker waits; the notice offers it only at a safe point; an open run is never replaced under the
// learner. The built `public/sw.js` is overwritten with a variant for the length of this file and restored at the end.
// Serial: the file is shared by the whole run, so no other spec of this file changes it meanwhile.

test.describe.configure({ mode: "serial" });

// The offline plan is about the service worker: it is allowed here although the project blocks it for the other specs.
test.use({ serviceWorkers: "allow" });

const SW_FILE = path.resolve(__dirname, "../../public/sw.js");
let original = "";

test.beforeAll(() => {
  original = readFileSync(SW_FILE, "utf8");
});

test.afterAll(() => {
  if (original !== "") writeFileSync(SW_FILE, original);
});

test("a new worker waits, the notice appears, an open run keeps its worker, and the update is applied only after the run", async ({ page, context }) => {
  const tenant = newTenant();
  await signIn(context, tenant);
  await downloadPlan(page);
  // A worker waits only while a page is controlled by the active one (with no controlled page a new worker activates at once), so the page is reloaded once,
  // as a learner's second visit does, and the worker then controls it.
  await page.reload();
  await expect.poll(async () => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: "the page is controlled by the worker" }).toBe(true);
  const before = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return { script: registration?.active?.scriptURL ?? null, waiting: registration?.waiting != null };
  });
  expect(before.waiting).toBe(false);

  // A new version of the worker: the file differs from the installed one.
  writeFileSync(SW_FILE, `${original}\n// e2e variant ${Date.now()}\n`);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await registration?.update();
  });
  await expect
    .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.waiting != null), { message: "the new worker waits", timeout: 30_000 })
    .toBe(true);
  writeFileSync(SW_FILE, original);
  // The page shows the calm notice, and nothing was activated by itself.
  await expect(page.getByText(TEXT.updateTitle).first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL ?? null)).toBe(before.script);

  // Open a run on the offline shell: the worker that serves it stays until the run is over.
  await context.setOffline(true);
  await page.goto("/offline");
  await expect(page.getByText(TEXT.ready).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: LABEL("جلسة اليوم") }).click();
  await expect(page.getByRole("heading", { level: 2, name: "مقطع جديد" })).toBeVisible();
  await page.waitForTimeout(5000);
  const during = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return { waiting: registration?.waiting != null, controlled: navigator.serviceWorker.controller !== null };
  });
  expect(during.waiting).toBe(true);
  await expect(page.getByRole("heading", { level: 2, name: "مقطع جديد" })).toBeVisible();

  // After the run the notice enables its button; pressing it activates the new worker and reloads, and the app still works offline.
  await page.getByRole("button", { name: "إيقاف", exact: true }).click();
  await page.getByRole("button", { name: "إيقاف مؤقت والخروج" }).click();
  await expect(page.getByText(TEXT.updateTitle).first()).toBeVisible();
  const apply = page.getByRole("button", { name: "حدّث الآن" });
  await expect(apply).not.toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
  await apply.click();
  // The page reloads on the new worker (the context of the old page goes away), so the check retries until the new page answers.
  await expect
    .poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.waiting == null).catch(() => false), { message: "no worker waits any more", timeout: 30_000 })
    .toBe(true);
  await expect(page.getByText(TEXT.ready).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(TEXT.updateTitle)).toHaveCount(0);
});
