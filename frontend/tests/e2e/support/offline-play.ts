import { expect, type Page } from "@playwright/test";
import { TEXT, readStores, recordRequests } from "./offline-harness";

// The offline play of the specs: go offline on the shell, play the prepared sessions by their Arabic labels, read the outbox of the device.

export const LABEL = (name: string) => new RegExp(`^ابدأ: ${name}`);

export async function goOffline(page: Page): Promise<ReturnType<typeof recordRequests>> {
  await page.context().setOffline(true);
  const log = recordRequests(page);
  await page.goto("/offline");
  await expect(page.getByText(TEXT.ready).first()).toBeVisible({ timeout: 30_000 });
  return log;
}

// The recorded events of the device, the sessions they belong to and the envelope each carries.
export async function outbox(page: Page) {
  const stores = await readStores(page);
  return (stores.pendingEvents ?? []) as { clientEventId: string; sessionId: string; state: string; reasonCode?: string; localSequence: number; event: Record<string, unknown> }[];
}

export const ENVELOPE = ["clientRunId", "snapshotId", "protocolVersion", "planVersion", "editionId", "bankVersion", "normalizationPolicyVersion", "scoringPolicyVersion", "localSequence"];

// Plays the daily descriptor: the learn step, a choice question, a recall question.
export async function playDaily(page: Page) {
  await page.getByRole("button", { name: LABEL("جلسة اليوم") }).click();
  await expect(page.getByRole("heading", { level: 2, name: "مقطع جديد" })).toBeVisible();
  // The text and its canonical source come from the snapshot.
  await expect(page.getByText("كلمة١ كلمة٢ كلمة٣ كلمة٤").first()).toBeVisible();
  await page.locator("[data-session-primary]").click();
  await page.getByRole("radio", { name: "كلمة1أ" }).click();
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page.locator("[data-session-primary]")).toHaveText("التالي");
  await page.locator("[data-session-primary]").click();
  await page.getByRole("textbox").fill("كلمة٦");
  await page.getByRole("button", { name: "تحقق" }).click();
  await expect(page.locator("[data-session-primary]")).toHaveText("إنهاء الجلسة");
  // An interval of active time shorter than a second is not recorded, so the run lasts a little longer than that and leaves an activity event.
  await page.waitForTimeout(1200);
  await page.locator("[data-session-primary]").click();
  await expect(page.getByRole("heading", { level: 2, name: "انتهت الجلسة على هذا الجهاز" })).toBeVisible();
  await page.getByRole("button", { name: "العودة إلى الجلسات" }).click();
}

export async function playGame(page: Page, name: string, answer: (page: Page) => Promise<void>) {
  await page.getByRole("button", { name: LABEL(name) }).click();
  for (let question = 0; question < 2; question += 1) {
    await answer(page);
    await page.getByRole("button", { name: "تحقق" }).click();
    await expect(page.locator("[data-round-primary]")).toHaveText(question === 0 ? "التالي" : "إنهاء الجولة");
    if (question === 1) await page.waitForTimeout(1200);
    await page.locator("[data-round-primary]").click();
  }
  await expect(page.getByRole("heading", { level: 2, name: "انتهت الجلسة على هذا الجهاز" })).toBeVisible();
  await page.getByRole("button", { name: "العودة إلى الجلسات" }).click();
}

export const ANSWERS: Record<string, (page: Page) => Promise<void>> = {
  "ترتيب الكلمات": async (page) => {
    for (const word of ["كلمة٢", "كلمة٣", "كلمة٤"]) await page.getByRole("button", { name: word, exact: true }).click();
  },
  "اختيار كلمة أو جزء": async (page) => {
    const options = page.getByRole("radio");
    await options.first().click();
  },
  "تمييز المتشابه": async (page) => {
    await page.getByRole("radio").first().click();
  },
  "استرجاع كلمة": async (page) => {
    await page.getByRole("textbox").fill("كلمة٦");
  },
};

