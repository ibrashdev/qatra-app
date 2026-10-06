import type { Page } from "@playwright/test";
import { mockProfile } from "../../src/lib/api/mock";
import { controlHealth, expect, signInOnSettingsRoutes, test, waitForFirstHealthRequest } from "./fixtures";

// F0 follow-up: the page's scroll padding is the room of the sticky bars that are on the page at this width, per shell (globals.css, data-bar).
// From 1024 px the public and the focus shells keep their sticky top bar, while the app shell has none (the side rail takes over): the padding
// used to be 8 px for all three from there, so an anchor or a focused control could land under the bar. In a real browser, production build.

const BAR = 56; // the app bar, 3.5 rem
const GAP = 8; // half a rem, kept clear below the bar
const TAB_BAR = 64; // the app shell's tab bar, below 1024 px
const WIDTHS = [1024, 1280] as const;
const HEIGHT = 420; // short on purpose: the pages scroll, so focus has something to scroll under

type Language = "ar" | "en";

interface Opened {
  path: string;
  what: string;
}

// The screens with a sticky top bar at every width: a public one (S-02, S-03), the flow shell of S-06, the focus shell of S-08.
const SHELLS: Opened[] = [
  { path: "/register", what: "public shell (S-02)" },
  { path: "/terms", what: "public shell (S-03)" },
  { path: "/consent", what: "flow shell with the brand alone (S-06)" },
  { path: "/start", what: "focus shell (S-08)" },
];

// Opens the page once React has hydrated (the first health request is the sign).
async function open(page: Page, path: string, { width, height = HEIGHT, language = "ar" }: { width: number; height?: number; language?: Language }) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize({ width, height });
  const health = await controlHealth(page, "ok");
  // S-06 needs a session whose terms version differs from the build's; the settings routes need a session as well.
  if (path === "/consent") {
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...mockProfile, termsVersion: "2025-01-01" }) }));
  }
  if (path.startsWith("/settings")) await signInOnSettingsRoutes(page);
  await page.goto(path);
  await waitForFirstHealthRequest(health);
  await page.evaluate(() => document.fonts.ready);
}

const padding = (page: Page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { start: Number.parseFloat(style.scrollPaddingBlockStart), end: Number.parseFloat(style.scrollPaddingBlockEnd) };
  });

// Puts a tall run of buttons after the page's own content, so a window of 420 px has plenty to scroll through. It waits until React has taken over
// everything in the page's main (a route's own boundary can hydrate after the first health request): extra nodes that were put there before are
// removed when it does.
async function addTallRun(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll("main *")].every((element) => Object.keys(element).some((key) => key.startsWith("__reactFiber$"))));
  await page.evaluate(() => {
    const run = document.createElement("div");
    run.id = "e2e-run";
    for (let index = 1; index <= 24; index += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `run ${index}`;
      button.style.cssText = "display:block;height:48px;margin-block:32px;";
      run.append(button);
    }
    document.querySelector("main")?.append(run);
  });
}

// From the last control of the page, Shift+Tab walks up through every control. Each one is checked where the browser left it: not under the
// sticky top bar. Returns what is wrong, one line each.
async function walkUp(page: Page, steps = 60) {
  await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>("main a[href], main button, main input, main summary")].filter((element) => element.checkVisibility());
    controls[controls.length - 1]?.focus();
  });
  const hidden: string[] = [];
  let visited = 0;
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press("Shift+Tab");
    const seen = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const bar = document.querySelector("header") as HTMLElement;
      return {
        // Past the first control focus leaves the page: nothing is left to check.
        left: element === document.body || element === document.documentElement,
        name: element.getAttribute("aria-label") ?? (element.textContent ?? "").trim().slice(0, 24),
        // The controls of the bar, and the skip link that opens over it, are not hidden by it.
        inBar: element.closest("header") !== null || element.getAttribute("href") === "#main",
        top: element.getBoundingClientRect().top,
        barBottom: bar.getBoundingClientRect().bottom,
        sticky: getComputedStyle(bar).position === "sticky",
      };
    });
    if (seen.left) break;
    if (seen.inBar) continue;
    visited += 1;
    // A static bar covers nothing: only the window's top edge counts. A sticky bar covers its own height.
    const limit = seen.sticky ? seen.barBottom : 0;
    if (seen.top < limit - 0.5) hidden.push(`${seen.name} at ${seen.top} px under a bar that ends at ${limit} px`);
  }
  expect(visited, "the walk went through controls of the page").toBeGreaterThan(20);
  return hidden;
}

test.describe("a sticky top bar at every width: the padding keeps its room from 1024 px too (public and focus shells)", () => {
  for (const width of WIDTHS) {
    for (const { path, what } of SHELLS) {
      test(`${width} px ${path} (${what}): the bar is sticky and the scroll padding is its 56 px and 8 px, and the bottom keeps 8 px`, async ({ page }) => {
        await open(page, path, { width });
        const bar = page.getByRole("banner");
        await expect(bar).toHaveAttribute("data-bar", "top");
        expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
        expect(await padding(page)).toEqual({ start: BAR + GAP, end: GAP });
      });

      test(`${width} px ${path} (${what}): a control focused from below is never left under the bar`, async ({ page }) => {
        await open(page, path, { width });
        await addTallRun(page);
        expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), "the page scrolls").toBe(true);
        expect(await walkUp(page)).toEqual([]);
      });
    }

    test(`${width} px: the walk does see the old defect, so the check has teeth (8 px of padding puts controls under the bar)`, async ({ page }) => {
      await open(page, "/register", { width });
      await addTallRun(page);
      await page.addStyleTag({ content: "html { scroll-padding-block-start: 8px !important; }" });
      expect((await walkUp(page)).length).toBeGreaterThan(0);
    });
  }

  for (const width of WIDTHS) {
    for (const [hash, name, language] of [
      ["#terms", "شروط الاستخدام", "ar"],
      ["#privacy", "بيان الخصوصية", "ar"],
      ["#privacy", "Privacy statement", "en"],
    ] as const) {
      test(`${width} px ${language}: /terms${hash} puts its heading 8 px under the sticky bar, with no workaround on the heading`, async ({ page }) => {
        await open(page, `/terms${hash}`, { width, height: 800, language });
        const anchor = page.getByRole("heading", { level: 2, name, exact: true });
        await expect(anchor).toBeFocused();
        const barBottom = await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().bottom);
        const top = await anchor.evaluate((element) => element.getBoundingClientRect().top);
        expect(top, "not under the bar").toBeGreaterThanOrEqual(barBottom);
        expect(Math.round(top)).toBe(BAR + GAP);
        expect(await anchor.evaluate((element) => getComputedStyle(element).scrollMarginBlockStart)).toBe("0px");
      });
    }
  }
});

test.describe("the app shell has a top bar below 1024 px only, and the padding follows it", () => {
  for (const width of WIDTHS) {
    test(`${width} px /today: no bar is shown, so the padding is 8 px at the top and 8 px at the bottom (the side rail keeps nothing in the way)`, async ({ page }) => {
      await open(page, "/today", { width });
      await expect(page.getByRole("banner")).toHaveCount(0);
      expect(await page.locator("header[data-bar]").evaluate((element) => getComputedStyle(element).display)).toBe("none");
      expect(await padding(page)).toEqual({ start: GAP, end: GAP });
    });

    test(`${width} px /settings/privacy#privacy: the anchored heading sits 8 px from the top of the window, nothing is above it`, async ({ page }) => {
      await open(page, "/settings/privacy#privacy", { width, height: 800 });
      const anchor = page.getByRole("heading", { level: 2, name: "بيان الخصوصية", exact: true });
      await expect(anchor).toBeFocused();
      expect(Math.round(await anchor.evaluate((element) => element.getBoundingClientRect().top))).toBe(GAP);
    });
  }

  for (const width of [1023, 768, 390]) {
    test(`${width} px /today: the sticky bar and the tab bar are shown, and the padding keeps 56 + 8 px at the top and 64 + 8 px at the bottom`, async ({ page }) => {
      await open(page, "/today", { width, height: 800 });
      await expect(page.getByRole("banner")).toHaveAttribute("data-bar", "top-below-rail");
      expect(await padding(page)).toEqual({ start: BAR + GAP, end: TAB_BAR + GAP });
    });
  }

  test("/settings/privacy#privacy below 1024 px sits under the sticky bar, at 1023 px", async ({ page }) => {
    await open(page, "/settings/privacy#privacy", { width: 1023, height: 800 });
    const anchor = page.getByRole("heading", { level: 2, name: "بيان الخصوصية", exact: true });
    await expect(anchor).toBeFocused();
    const barBottom = await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().bottom);
    const top = await anchor.evaluate((element) => element.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(barBottom);
    expect(Math.round(top)).toBe(BAR + GAP);
  });

  test("the padding follows the window across 1024 px without a reload, in both directions", async ({ page }) => {
    await open(page, "/today", { width: 1280, height: 800 });
    expect(await padding(page)).toEqual({ start: GAP, end: GAP });
    await page.setViewportSize({ width: 800, height: 800 });
    await expect.poll(() => padding(page)).toEqual({ start: BAR + GAP, end: TAB_BAR + GAP });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => padding(page)).toEqual({ start: GAP, end: GAP });
  });
});

test.describe("a page with no sticky bar at the bottom keeps only 8 px there, at every width", () => {
  for (const width of [390, 768, 1024, 1280]) {
    test(`${width} px /terms (public shell): 8 px at the bottom`, async ({ page }) => {
      await open(page, "/terms", { width, height: 800 });
      expect((await padding(page)).end).toBe(GAP);
    });
  }
});
