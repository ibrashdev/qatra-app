import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type ConsoleMessage, type Page, type Route } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mockProfile } from "../../src/lib/api/mock";

interface Options {
  // The wake-up tests make /api/health fail on purpose, and the browser logs those failures.
  allowConsoleErrors: boolean;
  // A test that makes an API call answer 4xx, 5xx or nothing on purpose: the browser logs "Failed to load resource" for each.
  // Any other console error still fails the test, so a hydration warning or a thrown error is not hidden.
  allowFailedRequests: boolean;
}

// The guest screens ask E11 whether a session exists (UI-design 2.3 guard 2). A visitor is answered 401, and the browser logs every
// failed request as a console error on its own. That one line is expected; the app itself logs nothing.
function isVisitorProbe(message: ConsoleMessage): boolean {
  return /status of 401/.test(message.text()) && new URL(message.location().url || "http://none.invalid").pathname === "/api/me";
}

// Every test fails if the page logged a console error or threw (the console check of antislop R-35).
export const test = base.extend<Options & { consoleErrors: string[] }>({
  allowConsoleErrors: [false, { option: true }],
  allowFailedRequests: [false, { option: true }],
  consoleErrors: [
    async ({ page, allowConsoleErrors, allowFailedRequests }, use) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error" || isVisitorProbe(message)) return;
        if (allowFailedRequests && /^Failed to load resource/.test(message.text())) return;
        errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      await use(errors);
      if (!allowConsoleErrors) expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

// What axe-core finds on the page, one line per rule (rule, impact, nodes), so a failure says where. An empty list is a pass (NFR-09).
export async function axeViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return result.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => node.target.join(" ")).join(" | ")}`);
}

// As axeViolations, for long pages in the signed-in shell. axe counts a target that the fixed tab bar partly covers at the current scroll as too
// small (target-size), although scrolling uncovers it and scroll-padding keeps a focused one clear (2.4.11). Each such target is checked again
// once scrolled to the middle of the viewport, and only one that is still too small there is reported.
export async function axeViolationsAtRest(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const lines: string[] = [];
  for (const violation of result.violations) {
    let nodes = violation.nodes;
    if (violation.id === "target-size") {
      const remaining: typeof nodes = [];
      for (const node of nodes) {
        const selector = node.target.join(" ");
        await page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: "center" }));
        const again = await new AxeBuilder({ page }).include(selector).withRules(["target-size"]).analyze();
        if (again.violations.length > 0) remaining.push(node);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      nodes = remaining;
    }
    if (nodes.length > 0) lines.push(`${violation.id} (${violation.impact}): ${nodes.map((node) => node.target.join(" ")).join(" | ")}`);
  }
  return lines;
}

export const TAB_NAMES = {
  ar: ["اليوم", "الدروس", "الألعاب", "التقدم", "الإعدادات"],
  en: ["Today", "Lessons", "Games", "Progress", "Settings"],
} as const;

export const NAV_NAME = { ar: "التنقل الرئيسي", en: "Main navigation" } as const;

export const WAKE_LINE = {
  ar: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
  en: "Starting the free server, this may take about a minute.",
} as const;

// The settings screens (S-22 to S-27) read E11 on load, and the stub answers E11 as a visitor (401) so the guest screens stay put. A test that
// opens a settings route signs in for those routes only: E11 asked from a page under /settings gets the synthetic profile, any other falls
// through. Register it after controlHealth, so this route is consulted first.
export async function signInOnSettingsRoutes(page: Page) {
  await page.route("**/api/me", async (route: Route) => {
    if (new URL(page.url()).pathname.startsWith("/settings")) {
      await route.fulfill({ status: 200, contentType: "application/json", json: mockProfile });
    } else {
      await route.fallback();
    }
  });
}

// The chunk that holds the text of S-03 or of S-26 (each route has its own, and it loads with that route only), so a test can hold it back or make it
// fail. Both hold the terms text; the one of S-26 also holds the closing button of S-26, «العودة إلى الإعدادات», which the one of S-03 does not.
export function termsChunk(screen: "terms" | "privacy" = "terms"): string {
  const directory = path.resolve(process.cwd(), ".next/static/chunks");
  const file = readdirSync(directory).find((name) => {
    if (!name.endsWith(".js")) return false;
    const source = readFileSync(path.join(directory, name), "utf8");
    // A sentence of the terms text only: the shorter «الكتاب كما هو» is also in the catalog Notice of S-07 and S-25.
    return source.includes("التطبيق يحفظ الكتاب كما هو") && source.includes("العودة إلى الإعدادات") === (screen === "privacy");
  });
  if (file === undefined) throw new Error(`the chunk that holds the text of ${screen} was not found in the build`);
  return file;
}

export type HealthMode = "ok" | "hang" | "gateway";

// Controls what the browser sees for GET /api/health. "hang" never answers, like a sleeping free server that accepted the connection.
// A sleeping server fails every request, so the session probe of the guest screens (GET /api/me) follows the same mode.
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
  await page.route("**/api/me", async (route: Route) => {
    if (state.mode === "gateway") {
      await route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" });
    } else if (state.mode === "ok") {
      await route.fallback();
    }
  });
  // The built screens read E14, E18 and E19 on load. A sleeping server fails them too: were the stub to answer one first, the page would take the
  // server for awake and drop the wake-up line before the test could see it.
  await page.route(/\/api\/(catalog|today|progress)$/, async (route: Route) => {
    if (state.mode === "gateway") {
      await route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" });
    } else {
      await route.fallback();
    }
  });
  return state;
}

// Interactive elements smaller than 44 by 44 px (WCAG 2.5.8, the approved target size), one line each; empty means all are reachable.
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = "a[href], button, input, select, textarea, summary, [role=button], [role=link]";
    const small: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!element.checkVisibility()) continue;
      // A checkbox is a native input laid over its 24 px box; the target is the whole row, whose label is part of it (UI-tokens 6.3).
      const target = element instanceof HTMLInputElement && element.type === "checkbox" ? (element.closest("label") ?? element) : element;
      const rect = target.getBoundingClientRect();
      // The skip link is clipped until it receives focus.
      if (element.closest(".sr-only") === element && rect.width <= 1) continue;
      if (rect.width < 43.5 || rect.height < 43.5) small.push(`${element.tagName} "${(element.textContent ?? "").trim()}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    return small;
  });
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
