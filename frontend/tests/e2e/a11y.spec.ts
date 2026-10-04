import { axeViolations as violations, controlHealth, expect, test, VIEWPORTS, waitForFirstHealthRequest, WAKE_LINE } from "./fixtures";

test.describe("axe-core: no violation on any shell route (NFR-09 baseline)", () => {
  const routes = ["/login", "/today", "/games", "/progress", "/settings"];
  const cases = [
    { language: "ar", viewport: VIEWPORTS.phone },
    { language: "ar", viewport: VIEWPORTS.desktop },
    { language: "en", viewport: VIEWPORTS.phone },
    { language: "en", viewport: VIEWPORTS.desktop },
  ] as const;

  for (const { language, viewport } of cases) {
    test(`${language} at ${viewport.width} px`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await violations(page), route).toEqual([]);
      }
    });
  }
});

test.describe("axe-core on the not-found page", () => {
  test.use({ allowConsoleErrors: true });

  for (const language of ["ar", "en"] as const) {
    test(language, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
      await page.goto("/this-page-does-not-exist");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  }
});

test.describe("axe-core on the transient states", () => {
  test.use({ allowConsoleErrors: true });

  test("busy indicator, wake-up line and retry state", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize(VIEWPORTS.phone);
    const health = await controlHealth(page, "hang");
    await page.goto("/today");
    await waitForFirstHealthRequest(health);

    await page.clock.runFor(1_200);
    await expect(page.getByText("جارٍ التحميل")).toBeVisible();
    expect(await violations(page), "busy").toEqual([]);

    await page.clock.runFor(2_500);
    await expect(page.getByText(WAKE_LINE.ar)).toBeVisible();
    expect(await violations(page), "waking").toEqual([]);

    await page.clock.runFor(90_000);
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toBeVisible();
    expect(await violations(page), "timed out").toEqual([]);
  });

  test("the English wake-up line", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await controlHealth(page, "gateway");
    await page.goto("/login");
    await expect(page.getByText(WAKE_LINE.en)).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});

test("zoomed text still fits: 200 % at 320 px wide leaves no horizontal scroll and no clipped tab label", async ({ page }) => {
  // A 640 px layout at 200 % zoom is a 320 px viewport; the tab bar is the tightest component.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/today");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  const clipped = await page.getByRole("navigation").getByRole("link").evaluateAll((links) => links.filter((link) => link.scrollWidth > link.clientWidth).length);
  expect(clipped).toBe(0);
});
