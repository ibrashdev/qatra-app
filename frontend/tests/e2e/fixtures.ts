import { expect, test as base, type Page, type Route } from "@playwright/test";

interface Options {
  // The wake-up tests make /api/health fail on purpose, and the browser logs those failures.
  allowConsoleErrors: boolean;
}

// Every test fails if the page logged a console error or threw (the console check of antislop R-35).
export const test = base.extend<Options & { consoleErrors: string[] }>({
  allowConsoleErrors: [false, { option: true }],
  consoleErrors: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      await use(errors);
      if (!allowConsoleErrors) expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const TAB_NAMES = {
  ar: ["اليوم", "الألعاب", "التقدم", "الإعدادات"],
  en: ["Today", "Games", "Progress", "Settings"],
} as const;

export const NAV_NAME = { ar: "التنقل الرئيسي", en: "Main navigation" } as const;

export const WAKE_LINE = {
  ar: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
  en: "Starting the free server, this may take about a minute.",
} as const;

export type HealthMode = "ok" | "hang" | "gateway";

// Controls what the browser sees for GET /api/health. "hang" never answers, like a sleeping free server that accepted the connection.
export async function controlHealth(page: Page, initial: HealthMode) {
  const state = { mode: initial, requests: 0 };
  await page.route("**/api/health", async (route: Route) => {
    state.requests += 1;
    if (state.mode === "ok") {
      await route.fulfill({ status: 200, contentType: "application/json", json: { status: "ok", version: "e2e", time: new Date().toISOString() } });
    } else if (state.mode === "gateway") {
      await route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" });
    }
  });
  return state;
}

// The page's first request is GET /api/health, issued once React has hydrated and the effects have run.
// Fake-clock tests and tests that inject DOM wait for it, so they never race the hydration.
export async function waitForFirstHealthRequest(health: { requests: number }) {
  await expect.poll(() => health.requests, { message: "the page's first health request" }).toBeGreaterThan(0);
}

// Remembers whether the wake-up line was ever in the DOM, even for a moment.
export async function recordWakeLine(page: Page) {
  await page.addInitScript((lines: string[]) => {
    (window as unknown as { __sawWakeLine: boolean }).__sawWakeLine = false;
    const check = () => {
      const text = document.body?.textContent ?? "";
      if (lines.some((line) => text.includes(line))) (window as unknown as { __sawWakeLine: boolean }).__sawWakeLine = true;
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
  }, [WAKE_LINE.ar, WAKE_LINE.en]);
  return () => page.evaluate(() => (window as unknown as { __sawWakeLine: boolean }).__sawWakeLine);
}

export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  phoneSmall: { width: 360, height: 780 },
  floor: { width: 320, height: 640 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
} as const;
