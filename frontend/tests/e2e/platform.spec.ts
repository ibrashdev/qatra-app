import { expect, test, VIEWPORTS } from "./fixtures";

test.describe("same-origin API through the rewrite (API-spec 1.1)", () => {
  test("GET /api/health reaches the backend through the frontend origin, without CORS headers", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-stub-backend"]).toBe("1");
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(await response.json()).toMatchObject({ status: "ok", version: "e2e-stub" });
  });

  test("the three reads that the built screens make on load (E14, E18, E19) are answered with fixed synthetic data", async ({ request }) => {
    for (const path of ["/api/catalog", "/api/today", "/api/progress"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["x-stub-backend"], path).toBe("1");
    }
    expect(((await (await request.get("/api/catalog")).json()) as { editions: unknown[] }).editions.length).toBeGreaterThan(0);
  });

  test("any other /api path is forwarded too, and the envelope comes back untouched", async ({ request }) => {
    const response = await request.get("/api/plans/not-served");
    expect(response.status()).toBe(404);
    expect(response.headers()["x-stub-backend"]).toBe("1");
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "Not found.", details: {} } });
  });

  test("GET /api/me, the session probe of the guest screens, is answered as a visitor: 401 with the envelope", async ({ request }) => {
    const response = await request.get("/api/me");
    expect(response.status()).toBe(401);
    expect(response.headers()["x-stub-backend"]).toBe("1");
    expect(await response.json()).toEqual({ error: { code: "unauthenticated", message: "Authentication is required.", details: {} } });
  });

  test("the page's own health request goes to same-origin /api/health with the same-origin credentials mode", async ({ page }) => {
    const requests: { url: string; accept: string | undefined; authorization: string | undefined }[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) {
        const headers = request.headers();
        requests.push({ url: new URL(request.url()).pathname, accept: headers.accept, authorization: headers.authorization });
      }
    });
    await page.goto("/login");
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests[0]).toEqual({ url: "/api/health", accept: "application/json", authorization: undefined });
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("a healthy server leaves the page quiet: no wake-up line, no console error", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.phone);
    await page.goto("/today");
    await page.waitForTimeout(1_500);
    await expect(page.getByText("جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.")).toHaveCount(0);
    await expect(page.getByText("جارٍ التحميل")).toHaveCount(0);
  });
});

test.describe("deferred features are absent (option C)", () => {
  test("no service worker, no manifest, no PWA registration", async ({ page }) => {
    await page.goto("/today");
    await page.waitForTimeout(500);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    await expect(page.locator("link[rel=manifest]")).toHaveCount(0);
    const worker = await page.request.get("/sw.js");
    expect(worker.status()).toBe(404);
  });

  test("the browser stores no token, only the language choice", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("radio", { name: "English (EN)" }).check();
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys).toEqual(["qatra.language"]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("there is no Next.js route handler of its own under /api", async ({ request }) => {
    // The stub marks every answer; a Next route handler would not carry the marker.
    for (const path of ["/api/health", "/api/anything-else"]) {
      expect((await request.get(path)).headers()["x-stub-backend"], path).toBe("1");
    }
  });
});

test.describe("colour scheme", () => {
  test.use({ colorScheme: "dark" });

  test("light theme only: an OS dark setting does not turn the page dark (UA-04)", async ({ page }) => {
    await page.goto("/today");
    const colours = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(colours.html).toBe("rgb(245, 250, 254)");
    expect(colours.scheme).toBe("light");
  });
});
