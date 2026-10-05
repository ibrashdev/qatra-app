import type { Locator, Page } from "@playwright/test";
import { axeViolationsAtRest, controlHealth, expect, signInOnSettingsRoutes, smallTargets, termsChunk, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// S-26 "Route loading; text unavailable" (UI-screens S-26 section 4) in a real browser, against a production build in live mode. The text of S-26
// is the chunk that holds the terms text, which loads with the route only: a test holds it back or makes it fail, as the S-03 specs do. The frame of
// the route (back control and H1) is the layout, so it stays; the app shell moves focus to that H1 when the route changes.

type Language = "ar" | "en";

const COPY = {
  ar: {
    title: "شروط الاستخدام وبيان الخصوصية",
    termsHeading: "شروط الاستخدام",
    privacyHeading: "بيان الخصوصية",
    topic: "البيانات التي نجمعها",
    back: "رجوع إلى الإعدادات",
    row: "الخصوصية والبيانات",
    deleteLink: "بيان الخصوصية",
    unavailable: "تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.",
    retry: "إعادة المحاولة",
    loading: "جارٍ التحميل",
  },
  en: {
    title: "Terms of use and privacy statement",
    termsHeading: "Terms of use",
    privacyHeading: "Privacy statement",
    topic: "Data we collect",
    back: "Back to Settings",
    row: "Privacy and data",
    deleteLink: "Privacy statement",
    unavailable: "The terms of use and privacy statement could not be opened. Check your connection and try again.",
    retry: "Try again",
    loading: "Loading",
  },
} as const;

const BAR = 56;
const GAP = 8;

async function open(page: Page, path: string, { language = "ar", viewport = VIEWPORTS.phone }: { language?: Language; viewport?: { width: number; height: number } } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, "ok");
  await signInOnSettingsRoutes(page);
  await page.goto(path);
  await waitForFirstHealthRequest(health);
}

const heading = (page: Page, level: number, name: string) => page.getByRole("heading", { level, name, exact: true });
const top = (locator: Locator) => locator.evaluate((element) => element.getBoundingClientRect().top);
const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// What has the keyboard focus, as a short description: the tag, and the heading's own mark when it has one.
const focused = (page: Page) => page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()}${document.activeElement?.hasAttribute("data-page-heading") ? "[data-page-heading]" : ""}`);

function holdChunk(page: Page) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return page
    .route(`**/_next/static/chunks/${termsChunk("privacy")}`, async (route) => {
      await gate;
      await route.continue();
    })
    .then(() => release);
}

test.describe("route loading (S-26 section 4)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: keeps the frame, shows a skeleton after 300 ms with the wait announced, keeps focus on the same H1, and lands on the text when it arrives`, async ({ page }) => {
      const copy = COPY[language];
      const release = await holdChunk(page);
      await open(page, "/settings", { language });
      await page.getByRole("link", { name: copy.row, exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/privacy$/);

      // The frame is there at once: the H1 holds the focus the shell moved to it, and the back control names Settings.
      const h1 = heading(page, 1, copy.title);
      await expect(h1).toBeFocused();
      await expect(page.getByRole("link", { name: copy.back, exact: true }).first()).toBeVisible();
      await h1.evaluate((element) => element.setAttribute("data-mark", "same-node"));

      const busy = page.locator("main [aria-busy=true]");
      await expect(busy).toHaveCount(1);
      await expect(busy.getByRole("status")).toHaveText(copy.loading);
      // Skeleton blocks stand in for the text: decorative, in the disabled fill, and no real text is shown besides the heading.
      const blocks = busy.locator("div[aria-hidden=true]");
      expect(await blocks.count()).toBeGreaterThan(5);
      expect(await blocks.first().evaluate((element) => ({ fill: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderTopLeftRadius }))).toEqual({
        fill: "rgb(223, 234, 242)",
        radius: "8px",
      });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolationsAtRest(page), "loading state").toEqual([]);
      await expect(h1).toBeFocused();

      release();
      await expect(heading(page, 2, copy.privacyHeading)).toBeVisible();
      await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
      // The same element, still in focus: nothing was unmounted under it.
      await expect(h1).toHaveAttribute("data-mark", "same-node");
      await expect(h1).toBeFocused();
      expect(await focused(page)).toBe("h1[data-page-heading]");
      await expect(heading(page, 3, copy.topic)).toBeVisible();
    });
  }

  for (const [name, viewport, anchorTop] of [
    ["phone", VIEWPORTS.phone, BAR + GAP],
    ["desktop", VIEWPORTS.desktop, GAP],
  ] as const) {
    test(`${name}: opened with #privacy from S-27, focus is on the H1 while loading and on the privacy heading once the text is there, scrolled to its place`, async ({ page }) => {
      const copy = COPY.ar;
      const release = await holdChunk(page);
      await open(page, "/settings/delete-account", { viewport });
      await page.getByRole("link", { name: copy.deleteLink, exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/privacy#privacy$/);
      await expect(heading(page, 1, copy.title)).toBeFocused();
      await expect(page.locator("main [aria-busy=true]")).toHaveCount(1);

      release();
      const anchor = heading(page, 2, copy.privacyHeading);
      await expect(anchor).toBeFocused();
      await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
      // Under the sticky bar of a phone, and at the top of the window where the side rail replaces the bar (from 1024 px).
      expect(Math.round(await top(anchor))).toBe(anchorTop);
    });
  }

  test("the text arrives within the wait: no skeleton shows and no heading changes", async ({ page }) => {
    await open(page, "/settings");
    await page.getByRole("link", { name: COPY.ar.row, exact: true }).click();
    await expect(heading(page, 2, COPY.ar.privacyHeading)).toBeVisible();
    await expect(heading(page, 1, COPY.ar.title)).toBeFocused();
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  });
});

test.describe("text unavailable (S-26 section 4)", () => {
  // The browser logs a failed request and the failed chunk load; nothing else may be logged.
  test.use({ allowConsoleErrors: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: when the chunk fails, the error banner with its retry button sits under the frame, focus goes to the button, and a retry brings the text and returns focus to the H1`, async ({ page, consoleErrors }) => {
      const copy = COPY[language];
      let blocked = true;
      await page.route(`**/_next/static/chunks/${termsChunk("privacy")}`, (route) => (blocked ? route.abort("failed") : route.continue()));
      await open(page, "/settings", { language });
      await page.getByRole("link", { name: copy.row, exact: true }).click();
      await expect(page).toHaveURL(/\/settings\/privacy$/);

      const alert = page.locator("[role=alert]:not(#__next-route-announcer__)");
      await expect(alert).toHaveCount(1);
      await expect(alert).toContainText(copy.unavailable);
      const retry = alert.getByRole("button", { name: copy.retry, exact: true });
      await expect(retry).toBeFocused();
      // The frame stays: the H1 and the back control, and the banner has its own icon next to the text, never colour alone.
      await expect(heading(page, 1, copy.title)).toBeVisible();
      await expect(heading(page, 1, copy.title)).not.toBeFocused();
      await expect(page.getByRole("link", { name: copy.back, exact: true }).first()).toBeVisible();
      await expect(alert.locator("svg[aria-hidden=true]")).toHaveCount(1);
      expect(await alert.evaluate((element) => ({ fill: getComputedStyle(element).backgroundColor, edge: getComputedStyle(element).borderTopColor }))).toEqual({
        fill: "rgb(253, 236, 234)",
        edge: "rgb(192, 54, 44)",
      });
      expect(await axeViolationsAtRest(page), "error state").toEqual([]);
      expect(await smallTargets(page), "targets").toEqual([]);

      blocked = false;
      await retry.click();
      await expect(heading(page, 2, copy.privacyHeading)).toBeVisible();
      await expect(alert).toHaveCount(0);
      // The retry button went with the banner: focus is on the page heading, not lost to the page.
      await expect(heading(page, 1, copy.title)).toBeFocused();
      await expect(heading(page, 3, copy.topic)).toBeVisible();
      expect(consoleErrors.filter((message) => !/Failed to load resource|ChunkLoadError/.test(message))).toEqual([]);
    });
  }

  test("opened with #privacy from S-27, a retry that succeeds focuses the privacy heading", async ({ page }) => {
    const copy = COPY.ar;
    let blocked = true;
    await page.route(`**/_next/static/chunks/${termsChunk("privacy")}`, (route) => (blocked ? route.abort("failed") : route.continue()));
    await open(page, "/settings/delete-account");
    await page.getByRole("link", { name: copy.deleteLink, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/privacy#privacy$/);
    const retry = page.getByRole("button", { name: copy.retry, exact: true });
    await expect(retry).toBeFocused();
    blocked = false;
    await retry.click();
    await expect(heading(page, 2, copy.privacyHeading)).toBeFocused();
  });
});
