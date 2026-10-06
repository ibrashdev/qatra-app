import { expect, test, type Page } from "@playwright/test";
import { LOCALE_STORAGE_KEY } from "../../src/i18n/locale";
import { axeViolations, axeViolationsAtRest, smallTargets, VIEWPORTS } from "./fixtures";
import { TEXT, downloadPlan, newTenant, signIn } from "./support/offline-harness";
import { LABEL } from "./support/offline-play";

// The offline screens (S-31, S-32, the run in the shell) in Arabic RTL and English LTR at 320, 360, 390 and 1280 px: axe finds nothing, every target is at least
// 44 px, and the page never scrolls sideways (NFR-09, UI-tokens 2.5.8).

test.describe.configure({ mode: "parallel" });

// The offline plan is about the service worker: it is allowed here although the project blocks it for the other specs.
test.use({ serviceWorkers: "allow" });

const LOCALES = ["ar", "en"] as const;
const SIZES = [VIEWPORTS.floor, VIEWPORTS.phoneSmall, VIEWPORTS.phone, VIEWPORTS.desktop];

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

for (const language of LOCALES) {
  for (const size of SIZES) {
    test(`${language} at ${size.width} px: the download card, the offline day and a run are accessible`, async ({ page, context }) => {
      const tenant = newTenant();
      await signIn(context, tenant);
      await page.addInitScript(([key, value]) => localStorage.setItem(key as string, value as string), [LOCALE_STORAGE_KEY, language]);
      await page.setViewportSize(size);
      await page.goto("/today");
      await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
      // The card: not downloaded, then ready.
      await expect(page.getByRole("button", { name: language === "ar" ? TEXT.downloadCta : "Download the plan for offline use" })).toBeVisible();
      expect(await axeViolationsAtRest(page)).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
      await noSidewaysScroll(page);
      await downloadPlan(page);
      await expect(page.getByRole("button", { name: language === "ar" ? "احذف النسخة المحلية" : "Delete the local copy" })).toBeVisible();
      expect(await axeViolationsAtRest(page)).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
      await noSidewaysScroll(page);

      // The offline day.
      await context.setOffline(true);
      await page.goto("/offline");
      await expect(page.getByRole("button", { name: /^(ابدأ|Start): / }).first()).toBeVisible({ timeout: 30_000 });
      expect(await axeViolations(page)).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
      await noSidewaysScroll(page);

      // The first step of a run in the shell.
      await page.getByRole("button", { name: LABEL_FOR(language) }).first().click();
      await expect(page.locator("[data-session-primary]")).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      expect(await smallTargets(page)).toEqual([]);
      await noSidewaysScroll(page);
    });
  }
}

const LABEL_FOR = (language: "ar" | "en") => (language === "ar" ? LABEL("جلسة اليوم") : /^Start: Today's session/);

test("the shell with nothing downloaded is accessible in both languages", async ({ page }) => {
  for (const language of LOCALES) {
    await page.addInitScript(([key, value]) => localStorage.setItem(key as string, value as string), [LOCALE_STORAGE_KEY, language]);
    await page.goto("/offline");
    await expect(page.getByRole("heading", { level: 2, name: language === "ar" ? TEXT.noPlan : "No plan is downloaded on this device" })).toBeVisible({ timeout: 30_000 });
    expect(await axeViolations(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
  }
});
