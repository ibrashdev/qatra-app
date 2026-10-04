import { controlHealth, expect, recordWakeLine, test, VIEWPORTS, waitForFirstHealthRequest, WAKE_LINE } from "./fixtures";

// G-01 and API-spec 1.11 in a real browser: the first request of every page load is GET /api/health.
test.describe("free-server wake-up state (G-01)", () => {
  test.use({ viewport: VIEWPORTS.phone, allowConsoleErrors: true });

  test("a health answer that is slow: busy indicator at 1 s, the line at 3 s, gone once the server answers", async ({ page }) => {
    const health = await controlHealth(page, "hang");
    await page.goto("/today");
    const line = page.getByText(WAKE_LINE.ar);
    const busy = page.getByText("جارٍ التحميل");

    // The 1 s rule: a neutral indicator, no line yet.
    await expect(busy).toBeVisible({ timeout: 2_500 });
    await expect(line).toHaveCount(0);
    // The 2 s rule: the probe gets no answer, so the line replaces the indicator.
    await expect(line).toBeVisible({ timeout: 4_000 });
    await expect(busy).toHaveCount(0);
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toHaveCount(0);

    // The line sits in a polite live region, not an alert, and is not an error banner.
    const region = page.getByRole("status").filter({ hasText: WAKE_LINE.ar });
    await expect(region).toHaveAttribute("aria-live", "polite");
    // Next.js owns one hidden route announcer with role alert; the app adds none.
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)")).toHaveCount(0);

    health.mode = "ok";
    await expect(line).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByText("الخادم جاهز. يمكنك المحاولة الآن.")).toBeAttached();
    // The page itself was never reloaded or navigated away.
    expect(new URL(page.url()).pathname).toBe("/today");
  });

  test("a gateway answer outside the envelope shows the line at once", async ({ page }) => {
    const health = await controlHealth(page, "gateway");
    await page.goto("/login");
    await expect(page.getByText(WAKE_LINE.ar)).toBeVisible({ timeout: 1_500 });
    health.mode = "ok";
    await expect(page.getByText(WAKE_LINE.ar)).toHaveCount(0, { timeout: 8_000 });
  });

  test("the line has an English counterpart", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await controlHealth(page, "gateway");
    await page.goto("/login");
    await expect(page.getByText(WAKE_LINE.en)).toBeVisible({ timeout: 1_500 });
  });

  test("a healthy server shows neither the line nor the indicator", async ({ page }) => {
    const sawLine = await recordWakeLine(page);
    await controlHealth(page, "ok");
    await page.goto("/today");
    await page.waitForTimeout(2_500);
    await expect(page.getByText("جارٍ التحميل")).toHaveCount(0);
    expect(await sawLine()).toBe(false);
  });

  test("when the probe answers while the original request is still pending, only the neutral indicator shows", async ({ page }) => {
    const sawLine = await recordWakeLine(page);
    let calls = 0;
    await page.route("**/api/health", async (route) => {
      calls += 1;
      // The first request is the slow one; the probe that starts at 1 s is answered at once.
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 2_400));
      await route.fulfill({ status: 200, contentType: "application/json", json: { status: "ok", version: "e2e", time: new Date().toISOString() } }).catch(() => undefined);
    });
    await page.goto("/today");
    await expect(page.getByText("جارٍ التحميل")).toBeVisible({ timeout: 2_500 });
    await expect(page.getByText("جارٍ التحميل")).toHaveCount(0, { timeout: 4_000 });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await sawLine()).toBe(false);
  });

  test("after 90 s the retry button appears, the line stays, and the button starts a new round", async ({ page }) => {
    await page.clock.install();
    const health = await controlHealth(page, "hang");
    await page.goto("/today");
    await waitForFirstHealthRequest(health);
    const line = page.getByText(WAKE_LINE.ar);

    await page.clock.runFor(3_500);
    await expect(line).toBeVisible();
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toHaveCount(0);

    await page.clock.runFor(85_000);
    await expect(line).toBeVisible();
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toHaveCount(0);
    await page.clock.runFor(5_000);
    const retry = page.getByRole("button", { name: "إعادة المحاولة" });
    await expect(retry).toBeVisible();
    await expect(line).toBeVisible();

    const before = health.requests;
    health.mode = "ok";
    await retry.click();
    await expect(line).toHaveCount(0, { timeout: 5_000 });
    expect(health.requests).toBeGreaterThan(before);
    await expect(retry).toHaveCount(0);
  });

  test("the retry button is keyboard operable", async ({ page }) => {
    await page.clock.install();
    const health = await controlHealth(page, "hang");
    await page.goto("/today");
    await waitForFirstHealthRequest(health);
    await page.clock.runFor(95_000);
    const retry = page.getByRole("button", { name: "إعادة المحاولة" });
    await expect(retry).toBeVisible();
    health.mode = "ok";
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(WAKE_LINE.ar)).toHaveCount(0, { timeout: 5_000 });
  });

  test("the line appears in every shell, public and signed-in", async ({ page }) => {
    await controlHealth(page, "gateway");
    for (const path of ["/login", "/today", "/settings"]) {
      await page.goto(path);
      await expect(page.getByText(WAKE_LINE.ar)).toBeVisible({ timeout: 2_000 });
    }
  });
});
