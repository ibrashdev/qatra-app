import { expect, test, type Page } from "@playwright/test";
import { TEXT, configureStub, newTenant, readStores, signIn, stubState, waitForShellReady } from "./support/offline-harness";

// Offline phase 2: an ordinary ONLINE session keeps its answers on the device (the online journal, PWA-design 4) and sends them to the ORIGINAL session
// through the foreground sync, exactly once, with the same ids and the same finish key. Everything runs against the production build with the stateful stub
// (cookie `qatra_e2e`); the service worker is allowed only where the scenario needs it (a reload with no connection).

test.describe.configure({ mode: "parallel" });
test.setTimeout(90_000);

const OFFLINE_QUEUE = "لا يوجد اتصال بالشبكة. سنعيد المحاولة تلقائيًا، أو اضغط «إعادة المحاولة».";
const KEEP_OPEN = "إجاباتك محفوظة في هذه الصفحة فقط إلى أن تُرسل، فلا تُعِد تحميلها ولا تغلقها.";
const FINISH_PENDING = "انتهت الجلسة على هذا الجهاز. ستُعتمد نتيجتها بعد عودة الاتصال.";
const RESTART_LINE = "نبدأ من أول الجلسة؛ إجاباتك السابقة محفوظة.";
const RESULT_H1 = "انتهت الجلسة";
const PASSWORD = "a synthetic passphrase for docs only";

const primary = (page: Page) => page.locator("[data-session-primary]");

interface JournalEvent {
  clientEventId: string;
  sessionId: string;
  kind: string;
  state: string;
  event: { type: string; [key: string]: unknown };
}
interface JournalRun {
  sessionId: string;
  kind: string;
  resumeIndex: number;
  answered: Record<string, unknown>;
  completion: null | { state: string; idempotencyKey: string };
}

// The online journal as it is on disk.
async function journal(page: Page): Promise<{ events: JournalEvent[]; runs: JournalRun[] }> {
  const stores = await readStores(page);
  return { events: (stores.onlineEvents ?? []) as JournalEvent[], runs: (stores.onlineRuns ?? []) as JournalRun[] };
}
const answerRecords = async (page: Page) => (await journal(page)).events.filter((record) => record.event.type === "answer");
const serverAnswers = async (tenant: string) => (await stubState(tenant)).eventLog.filter((entry) => entry.type === "answer");

async function startOnlineSession(page: Page): Promise<string> {
  await page.goto("/today");
  await page.getByRole("button", { name: "ابدأ جلسة اليوم" }).click();
  await page.waitForURL(/\/session\/[^/]+$/);
  return decodeURIComponent(new URL(page.url()).pathname.split("/")[2] ?? "");
}

// The learn step, then the choice question.
async function answerChoice(page: Page) {
  await primary(page).click();
  await page.getByRole("radio", { name: "كلمة1أ" }).click();
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(primary(page)).toHaveText("التالي");
}

// «التالي», then the recall question.
async function answerRecall(page: Page) {
  await primary(page).click();
  await page.getByRole("textbox").fill("كلمة٦");
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(primary(page)).toHaveText("إنهاء الجلسة");
}

test.describe("(a) an answer given offline reaches the original session once, after an offline reload", () => {
  test.use({ serviceWorkers: "allow" });

  test("the durable line shows, the answer survives an offline reload, and the foreground sync sends it once and empties the journal", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await page.goto("/today");
    await waitForShellReady(page, { control: true });
    const sessionId = await startOnlineSession(page);
    await answerChoice(page);
    await expect.poll(async () => (await serverAnswers(tenant)).length).toBe(1);
    // The server answered: nothing is waiting on the device.
    await expect.poll(async () => (await answerRecords(page)).length).toBe(0);

    await context.setOffline(true);
    // The answers of an online run are on the device, which the line says in the fixed words, and not only in this page.
    await expect(page.getByText(OFFLINE_QUEUE)).toBeVisible();
    await expect(page.getByText(TEXT.savedOnDevice)).toBeVisible();
    await expect(page.getByText(KEEP_OPEN)).toHaveCount(0);
    await answerRecall(page);
    const waiting = await answerRecords(page);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ sessionId, kind: "daily", state: "queued" });
    // An online event carries no replay envelope.
    expect(Object.keys(waiting[0]?.event ?? {})).not.toEqual(expect.arrayContaining(["clientRunId", "snapshotId", "localSequence"]));
    expect((await journal(page)).runs[0]).toMatchObject({ sessionId, resumeIndex: 2 });
    expect((await serverAnswers(tenant)).length).toBe(1);

    // A reload with no connection: the page opens with the worker's shell, the session cannot be loaded, and what the screen says is true: nothing is lost,
    // the answer is saved on the device (the old line, "kept on this page only", would be false here and frightening).
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "جلسة الحفظ" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(OFFLINE_QUEUE)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(TEXT.savedOnDevice)).toBeVisible();
    await expect(page.getByText(KEEP_OPEN)).toHaveCount(0);
    expect(await answerRecords(page)).toHaveLength(1);

    await context.setOffline(false);
    await expect.poll(async () => (await serverAnswers(tenant)).length, { timeout: 60_000 }).toBe(2);
    await expect.poll(async () => (await journal(page)).events.length, { timeout: 30_000 }).toBe(0);
    const state = await stubState(tenant);
    // Both answers belong to the session the learner started, each was counted once, and nothing was sent twice.
    const answers = state.eventLog.filter((entry) => entry.type === "answer");
    expect(new Set(answers.map((entry) => entry.clientEventId)).size).toBe(2);
    for (const entry of state.eventLog) expect(entry.sessionId).toBe(sessionId);
    expect(state.duplicates).toBe(0);
    expect(waiting[0] && answers.some((entry) => entry.clientEventId === waiting[0]?.clientEventId)).toBe(true);
  });
});

test.describe("(b) a reload while online resumes where the learner was", () => {
  test.use({ serviceWorkers: "block" });

  test("resumes at the next step with the earlier answer kept, and sends nothing twice", async ({ page }) => {
    const tenant = newTenant();
    await signIn(page.context(), tenant);
    const sessionId = await startOnlineSession(page);
    await answerChoice(page);
    await expect.poll(async () => (await serverAnswers(tenant)).length).toBe(1);
    await expect.poll(async () => (await journal(page)).runs[0]?.resumeIndex).toBe(2);
    expect(Object.keys((await journal(page)).runs[0]?.answered ?? {})).toHaveLength(1);

    await page.reload();
    // The recall question, not the learn step and not the choice question again, and no line about starting again.
    await expect(page.getByRole("textbox")).toBeVisible();
    await expect(page.getByRole("button", { name: "ابدأ التدريب" })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByText(RESTART_LINE)).toHaveCount(0);
    await page.getByRole("textbox").fill("كلمة٦");
    await page.getByRole("button", { name: "تحقق" }).click();
    await expect(primary(page)).toHaveText("إنهاء الجلسة");
    await primary(page).click();
    await page.waitForURL(/\/session\/[^/]+\/result$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { level: 1, name: RESULT_H1 })).toBeVisible();

    const state = await stubState(tenant);
    const answers = state.eventLog.filter((entry) => entry.type === "answer");
    expect(answers).toHaveLength(2);
    expect(new Set(answers.map((entry) => entry.clientEventId)).size).toBe(2);
    expect(state.duplicates).toBe(0);
    for (const entry of state.eventLog) expect(entry.sessionId).toBe(sessionId);
    // The server holds the finished session: no run record is left.
    await expect.poll(async () => (await journal(page)).runs.length).toBe(0);
  });

  test("an answer the server never received is sent after the reload with its own id, once", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await startOnlineSession(page);
    await configureStub(tenant, { unavailableNext: 1000 });
    await answerChoice(page);
    await expect.poll(async () => (await answerRecords(page)).length).toBe(1);
    const [waiting] = await answerRecords(page);
    expect((await serverAnswers(tenant)).length).toBe(0);

    await configureStub(tenant, { unavailableNext: 0 });
    await page.reload();
    await expect(page.getByRole("textbox")).toBeVisible();
    await expect.poll(async () => (await serverAnswers(tenant)).map((entry) => entry.clientEventId), { timeout: 30_000 }).toEqual([waiting?.clientEventId]);
    await expect.poll(async () => (await journal(page)).events.length).toBe(0);
    expect((await stubState(tenant)).duplicates).toBe(0);
  });
});

test.describe("(c) a lost response", () => {
  test.use({ serviceWorkers: "block" });

  test("the retry sends the same ids and each answer is counted once (the server says duplicate)", async ({ page }) => {
    const tenant = newTenant();
    await signIn(page.context(), tenant);
    await startOnlineSession(page);
    await configureStub(tenant, { dropEventResponses: 1 });
    await answerChoice(page);
    const [waiting] = await answerRecords(page);
    // The server processed the batch and the answer was lost: the id stays in the journal until a later answer settles it.
    await expect.poll(async () => (await stubState(tenant)).duplicates, { timeout: 45_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await journal(page)).events.length, { timeout: 30_000 }).toBe(0);
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toHaveCount(0);
    await answerRecall(page);
    await primary(page).click();
    await page.waitForURL(/\/session\/[^/]+\/result$/, { timeout: 30_000 });
    const answers = (await serverAnswers(tenant)).map((entry) => entry.clientEventId);
    expect(answers).toHaveLength(2);
    expect(new Set(answers).size).toBe(2);
    if (waiting !== undefined) expect(answers).toContain(waiting.clientEventId);
    // Counted once: the figures of the server hold one interval per event and one result per answer.
    expect((await stubState(tenant)).answerResults).toHaveLength(2);
  });
});

test.describe("(d) a finish with no connection", () => {
  test.use({ serviceWorkers: "block" });

  test("shows the provisional line, keeps the same key on every attempt, and opens the confirmed result only after the server answers", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await startOnlineSession(page);
    await answerChoice(page);
    await answerRecall(page);
    await expect.poll(async () => (await serverAnswers(tenant)).length).toBe(2);

    await context.setOffline(true);
    await primary(page).click();
    await expect(page.getByText(FINISH_PENDING)).toBeVisible({ timeout: 30_000 });
    // Not the result yet, and the button offers the retry.
    await expect(primary(page)).toHaveText("إعادة المحاولة");
    expect(new URL(page.url()).pathname).not.toMatch(/\/result$/);
    expect((await stubState(tenant)).completions).toHaveLength(0);
    const [run] = (await journal(page)).runs;
    expect(run?.completion).toMatchObject({ state: "pending" });
    const key = run?.completion?.idempotencyKey ?? "";
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    await context.setOffline(false);
    await page.waitForURL(/\/session\/[^/]+\/result$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1, name: RESULT_H1 })).toBeVisible();
    const { completions } = await stubState(tenant);
    expect(completions.length).toBeGreaterThanOrEqual(1);
    for (const completion of completions) expect(completion.key).toBe(key);
    await expect.poll(async () => (await journal(page)).runs.length).toBe(0);
  });
});

test.describe("(e) another account", () => {
  test.use({ serviceWorkers: "block" });

  test("answers of account A left in the journal are never sent under account B, and B's login wipes them after the logout dialog counted them", async ({ page, context }) => {
    const tenant = newTenant();
    await signIn(context, tenant);
    await startOnlineSession(page);
    await configureStub(tenant, { unavailableNext: 1000 });
    await answerChoice(page);
    await expect.poll(async () => (await answerRecords(page)).length).toBe(1);

    // The logout dialog counts the answers that would be deleted, and cancelling keeps them.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1, name: "الإعدادات" })).toBeVisible();
    await page.getByRole("button", { name: "تسجيل الخروج", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: TEXT.logoutDialogTitle })).toBeVisible();
    await expect(dialog).toContainText(/لديك .+ إجابات لم تُزامن بعد\. إن خرجت الآن فستُحذف من هذا الجهاز\./);
    await dialog.getByRole("button", { name: "إلغاء" }).click();
    expect((await stubState(tenant)).logoutCalls).toBe(0);
    expect((await answerRecords(page)).length).toBe(1);

    // Someone else is now signed in at the server: whatever the app does next, A's answer is not sent for B.
    await configureStub(tenant, { user: "learner.b", signedIn: true, unavailableNext: 0 });
    const before = (await stubState(tenant)).requests.filter((request) => request === "GET /api/me").length;
    await page.goto("/today");
    await expect.poll(async () => (await stubState(tenant)).requests.filter((request) => request === "GET /api/me").length, { timeout: 30_000 }).toBeGreaterThan(before);
    await page.waitForTimeout(1_500);
    expect((await stubState(tenant)).acknowledged).toEqual([]);
    expect((await answerRecords(page)).length).toBe(1);

    // B signs in through the form: the journal of A is wiped before anything of B is shown, and nothing was sent.
    await configureStub(tenant, { signedIn: false });
    await page.goto("/login");
    await page.getByLabel("اسم المستخدم").fill("learner.b");
    await page.getByRole("textbox", { name: "كلمة المرور", exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "دخول", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    const stores = await readStores(page);
    expect(stores.onlineEvents ?? []).toHaveLength(0);
    expect(stores.onlineRuns ?? []).toHaveLength(0);
    expect(((stores.ownerState ?? []) as { username: string | null }[])[0]?.username).toBe("learner.b");
    expect((await stubState(tenant)).acknowledged).toEqual([]);
  });
});

test.describe("(f) a slow backend", () => {
  test.use({ serviceWorkers: "block" });

  test("sends each answer once, never twice, and the finish works", async ({ page }) => {
    const tenant = newTenant();
    await signIn(page.context(), tenant);
    await startOnlineSession(page);
    await configureStub(tenant, { eventDelayMs: 1_500 });
    await answerChoice(page);
    // The verdict is there at once, while the server is still thinking.
    await expect(page.locator("[data-feedback]")).toBeVisible();
    await answerRecall(page);
    await primary(page).click();
    await page.waitForURL(/\/session\/[^/]+\/result$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1, name: RESULT_H1 })).toBeVisible();
    const state = await stubState(tenant);
    const answers = state.eventLog.filter((entry) => entry.type === "answer");
    expect(answers).toHaveLength(2);
    expect(new Set(answers.map((entry) => entry.clientEventId)).size).toBe(2);
    expect(state.duplicates).toBe(0);
    expect(state.completions.length).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await journal(page)).events.length).toBe(0);
  });
});
