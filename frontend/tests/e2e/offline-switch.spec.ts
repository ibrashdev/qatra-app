import { expect, test, type Page } from "@playwright/test";
import { axeViolations, controlHealth, smallTargets, waitForFirstHealthRequest, WAKE_LINE } from "./fixtures";
import { TEXT, downloadPlan, newTenant, signIn, stubState } from "./support/offline-harness";
import { LABEL } from "./support/offline-play";

// PWA-design 6 for a page that is already open: when the connection drops, the page does not reload and the address does not change. A page that only reads
// makes way for the downloaded plan in place; any other page keeps itself and what was typed in it, and a notice says what is and is not saved. A free
// server that is only waking up is none of this. Everything runs against the production build with the stateful stub (cookie `qatra_e2e`).

test.describe.configure({ mode: "parallel" });

const TODAY_H1 = "خطوتك اليوم";
const OFFLINE_H1 = "التعلم دون اتصال";
const NOTICE_TITLE = "أنت غير متصل بالإنترنت";
const NOTICE_BODY = /ولم يُحفظ بعد/;
const SERVER_NOTICE = "الخادم غير متاح الآن. يمكنك متابعة التعلم بالخطة المحمّلة على هذا الجهاز.";
const OPEN_PLAN = "افتح الخطة المحمّلة";
const BACK_TO_PAGE = "العودة إلى الصفحة";
// Since offline phase 2 the answers of an online run are written to the device first, so the line is the fixed G-22 one, not the «this page only» line.
const SAVED_ON_DEVICE = "محفوظ على الجهاز، بانتظار المزامنة";
const KEEP_OPEN = "إجاباتك محفوظة في هذه الصفحة فقط إلى أن تُرسل، فلا تُعِد تحميلها ولا تغلقها.";
const OFFLINE_QUEUE = "لا يوجد اتصال بالشبكة. سنعيد المحاولة تلقائيًا، أو اضغط «إعادة المحاولة».";

const pathOf = (page: Page) => new URL(page.url()).pathname;
const h1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });

// Every navigation of the main frame from now on, same-document ones (a router replace) included, so "no redirect to /offline" is a fact and not a hope.
function recordNavigations(page: Page): () => string[] {
  const seen: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) seen.push(new URL(frame.url()).pathname);
  });
  return () => seen;
}

test.describe("a page that only reads gives way to the downloaded plan, in place", () => {
  test.use({ serviceWorkers: "allow" });

  test("Today with a downloaded plan: offline shows the offline day at the same address, online brings Today back with no redirect and no loop", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await expect(h1(page, TODAY_H1)).toBeVisible();
    const navigations = recordNavigations(page);

    await context.setOffline(true);
    // No navigation was made: the open page was swapped, so the heading of the offline day appears at /today and Today itself is gone.
    await expect(h1(page, OFFLINE_H1)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(TEXT.ready).first()).toBeVisible();
    await expect(page.getByRole("button", { name: LABEL("جلسة اليوم") })).toBeVisible();
    await expect(h1(page, TODAY_H1)).toHaveCount(0);
    expect(pathOf(page)).toBe("/today");
    // The page that came back has no way back to the page: this was the automatic swap.
    await expect(page.getByRole("button", { name: BACK_TO_PAGE })).toHaveCount(0);

    await context.setOffline(false);
    await expect(h1(page, TODAY_H1)).toBeVisible({ timeout: 45_000 });
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);
    expect(pathOf(page)).toBe("/today");
    // It stays: the same episode does not swap again, and nothing sent the page to /offline and back.
    await page.waitForTimeout(2_500);
    await expect(h1(page, TODAY_H1)).toBeVisible();
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);
    expect(navigations().filter((path) => path !== "/today")).toEqual([]);
    expect((await stubState(tenant)).requests.filter((entry) => entry.endsWith("/auth/logout"))).toEqual([]);
  });

  test("a second drop of the connection swaps again, because it is a new episode", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    for (let round = 0; round < 2; round += 1) {
      await context.setOffline(true);
      await expect(h1(page, OFFLINE_H1)).toBeVisible({ timeout: 30_000 });
      expect(pathOf(page)).toBe("/today");
      await context.setOffline(false);
      await expect(h1(page, TODAY_H1)).toBeVisible({ timeout: 45_000 });
    }
  });

  test("Today with no downloaded plan: offline says so at the same address", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await page.goto("/today");
    await expect(h1(page, TODAY_H1)).toBeVisible();

    await context.setOffline(true);
    await expect(h1(page, OFFLINE_H1)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(TEXT.noPlan)).toBeVisible();
    await expect(page.getByRole("button", { name: /^ابدأ: / })).toHaveCount(0);
    expect(pathOf(page)).toBe("/today");

    await context.setOffline(false);
    await expect(h1(page, TODAY_H1)).toBeVisible({ timeout: 45_000 });
    expect(pathOf(page)).toBe("/today");
  });
});

test.describe("a run that is open keeps its state and its answers wait on the device", () => {
  test.use({ serviceWorkers: "block" });

  test("an online daily session: the same question and verdict stay, both answers are acknowledged once after the connection returns, and the session finishes", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await page.goto("/today");
    await page.getByRole("button", { name: "ابدأ جلسة اليوم" }).click();
    await page.waitForURL(/\/session\/[^/]+$/);
    const sessionUrl = page.url();
    const navigations = recordNavigations(page);

    // The learn step, then the first question answered online.
    await page.locator("[data-session-primary]").click();
    await page.getByRole("radio", { name: "كلمة1أ" }).click();
    await page.getByRole("button", { name: "تحقق" }).click();
    await expect(page.locator("[data-session-primary]")).toHaveText("التالي");
    const heading = (await page.locator("[data-step-heading]").innerText()).trim();
    const verdict = (await page.locator("[data-feedback]").innerText()).trim();
    expect(verdict).not.toBe("");
    await expect.poll(async () => (await stubState(tenant)).eventLog.filter((entry) => entry.type === "answer").length).toBe(1);
    await expect(page.getByText(OFFLINE_QUEUE)).toHaveCount(0);

    await context.setOffline(true);
    // The run stays exactly where it was: same address, same question, same verdict, and the line says the answers are saved on the device.
    await expect(page.getByText(OFFLINE_QUEUE)).toBeVisible();
    await expect(page.getByText(SAVED_ON_DEVICE)).toBeVisible();
    await expect(page.getByText(KEEP_OPEN)).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);
    expect((await page.locator("[data-step-heading]").innerText()).trim()).toBe(heading);
    expect((await page.locator("[data-feedback]").innerText()).trim()).toBe(verdict);
    // The run says it once: the notice of the page is not added.
    await expect(page.getByText(NOTICE_TITLE)).toHaveCount(0);
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);

    // The second question is answered offline: the first verdict comes from the page itself.
    await page.locator("[data-session-primary]").click();
    await page.getByRole("textbox").fill("كلمة٦");
    await page.getByRole("button", { name: "تحقق" }).click();
    await expect(page.locator("[data-session-primary]")).toHaveText("إنهاء الجلسة");
    await expect(page.locator("[data-feedback]")).toBeVisible();
    await expect(page.getByText(SAVED_ON_DEVICE)).toBeVisible();
    expect(page.url()).toBe(sessionUrl);
    expect((await stubState(tenant)).eventLog.filter((entry) => entry.type === "answer")).toHaveLength(1);

    await context.setOffline(false);
    await expect.poll(async () => (await stubState(tenant)).eventLog.filter((entry) => entry.type === "answer").length, { timeout: 30_000 }).toBe(2);
    const answers = (await stubState(tenant)).eventLog.filter((entry) => entry.type === "answer").map((entry) => entry.clientEventId);
    expect(new Set(answers).size).toBe(2);
    expect((await stubState(tenant)).acknowledged).toEqual(expect.arrayContaining(answers));
    await expect(page.getByText(SAVED_ON_DEVICE)).toHaveCount(0);
    await expect(page.getByText(OFFLINE_QUEUE)).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);

    await page.locator("[data-session-primary]").click();
    await page.waitForURL(/\/session\/[^/]+\/result$/, { timeout: 30_000 });
    // Nothing was reloaded or sent to /offline on the way, and no answer was sent twice.
    expect(navigations().some((path) => path === "/offline")).toBe(false);
    const finalAnswers = (await stubState(tenant)).eventLog.filter((entry) => entry.type === "answer").map((entry) => entry.clientEventId);
    expect(finalAnswers.sort()).toEqual([...answers].sort());
  });
});

test.describe("a page with a form keeps itself and what was typed in it", () => {
  test.use({ serviceWorkers: "allow" });

  test("the typed value survives, the notice says what is not saved, and the plan can be opened and left again", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await downloadPlan(page);
    await page.goto("/settings/password");
    const field = page.getByRole("textbox", { name: "كلمة المرور الحالية" });
    await expect(field).toBeVisible();
    await field.fill("a synthetic passphrase for docs only");
    const navigations = recordNavigations(page);

    await context.setOffline(true);
    await expect(page.getByText(NOTICE_TITLE)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(NOTICE_BODY)).toBeVisible();
    expect(pathOf(page)).toBe("/settings/password");
    await expect(field).toHaveValue("a synthetic passphrase for docs only");
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);
    // The notice is a polite status, an Info banner with a reachable control.
    await expect(page.getByRole("status").filter({ hasText: NOTICE_TITLE })).toHaveAttribute("aria-live", "polite");
    expect(await axeViolations(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);

    await page.getByRole("button", { name: OPEN_PLAN }).click();
    await expect(h1(page, OFFLINE_H1)).toBeVisible();
    await expect(page.getByText(TEXT.ready).first()).toBeVisible();
    expect(pathOf(page)).toBe("/settings/password");
    // The page is still there, hidden (a role query no longer finds a hidden control), with its value.
    const hiddenField = page.locator('[hidden] input[autocomplete="current-password"]');
    await expect(hiddenField).toBeHidden();
    await expect(hiddenField).toHaveValue("a synthetic passphrase for docs only");
    await expect(field).toHaveCount(0);

    await page.getByRole("button", { name: BACK_TO_PAGE }).click();
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("a synthetic passphrase for docs only");
    await expect(page.getByText(NOTICE_TITLE)).toBeVisible();
    expect(pathOf(page)).toBe("/settings/password");

    await context.setOffline(false);
    await expect(page.getByText(NOTICE_TITLE)).toHaveCount(0, { timeout: 30_000 });
    await expect(field).toHaveValue("a synthetic passphrase for docs only");
    expect(navigations().filter((path) => path !== "/settings/password")).toEqual([]);
  });
});

test.describe("a free server that does not answer is not an offline device", () => {
  test.use({ serviceWorkers: "block" });

  test("the browser is online and the server is asleep: no swap, no offline notice, and the waking line may show", async ({ page }) => {
    await controlHealth(page, "gateway");
    await page.goto("/today");
    await expect(page.getByText(WAKE_LINE.ar)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1_500);
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);
    await expect(page.getByText(NOTICE_TITLE)).toHaveCount(0);
    expect(pathOf(page)).toBe("/today");
  });

  test("after the wait is over the page says the server is not available and offers the plan, still with no swap", async ({ page }) => {
    await page.clock.install();
    const health = await controlHealth(page, "hang");
    await page.goto("/today");
    await waitForFirstHealthRequest(health);
    await page.clock.runFor(3_500);
    await expect(page.getByText(WAKE_LINE.ar)).toBeVisible();
    await expect(page.getByText(SERVER_NOTICE)).toHaveCount(0);
    await page.clock.runFor(90_000);
    await expect(page.getByText(SERVER_NOTICE)).toBeVisible();
    await expect(page.getByText(NOTICE_TITLE)).toHaveCount(0);
    await expect(h1(page, OFFLINE_H1)).toHaveCount(0);
    expect(pathOf(page)).toBe("/today");
    await expect(page.getByRole("button", { name: OPEN_PLAN })).toBeVisible();
  });
});
