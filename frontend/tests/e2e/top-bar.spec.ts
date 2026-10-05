import type { Locator, Page } from "@playwright/test";
import { mockProfile } from "../../src/lib/api/mock";
import { axeViolations, controlHealth, expect, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// The top bar of the shells is sticky while it is one row and static once it has wrapped (UI-tokens 6.6 and 7; WCAG 1.4.4, 1.4.10, 2.4.11):
// at 200 % text on 320 px the public bar was 305 px of a 568 px window, for good. "Wrapped" is a row taller than one row plus half a rem,
// the room that the page's scroll padding keeps clear below the top edge. In a real browser, against a production build.

type Language = "ar" | "en";

const DIVIDER = "rgb(215, 230, 240)";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

// The shells that have a top bar. The app shell hides its bar from 1024 px (the side rail takes over).
const PAGES = [
  ["/terms", "public shell: back control and switch"],
  ["/login", "public shell: the switch alone"],
  ["/consent", "focus shell: the brand only (S-06)"],
  ["/start", "focus shell: a title and the switch (S-08)"],
  ["/today", "app shell: the brand"],
] as const;

interface BarState {
  wrapped: string | null;
  position: string;
  display: string;
  top: number;
  bottom: number;
  height: number;
  safe: number; // the padding at the top of the bar for the notch of a phone (none in the test browser)
  barHeight: number; // the height of the bar below that padding: what the rule compares with its limit
  row: number; // the height of the bar's row
  oneRow: number; // what one row needs (its min-height)
  rem: number;
  padding: number; // the page's scroll-padding-block-start
  scrollY: number;
  border: string;
  mainTop: number; // in page coordinates
  width: number;
}

const barState = (page: Page): Promise<BarState> =>
  page.evaluate(() => {
    const bar = document.querySelector("header") as HTMLElement;
    const row = bar.firstElementChild as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const style = getComputedStyle(bar);
    return {
      wrapped: bar.getAttribute("data-wrapped"),
      position: style.position,
      display: style.display,
      top: Math.round(rect.top * 10) / 10,
      bottom: Math.round(rect.bottom * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      safe: Number.parseFloat(style.paddingTop),
      barHeight: Math.round((rect.height - Number.parseFloat(style.paddingTop)) * 10) / 10,
      row: Math.round(row.getBoundingClientRect().height * 10) / 10,
      oneRow: Number.parseFloat(getComputedStyle(row).minHeight),
      rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      padding: Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBlockStart),
      scrollY: Math.round(window.scrollY),
      border: style.borderBottomColor,
      mainTop: Math.round((document.querySelector("main") as HTMLElement).getBoundingClientRect().top + window.scrollY),
      width: window.innerWidth,
    };
  });

// What the rule says about the state of a bar, as a list of what is wrong with it (empty: consistent). The limit is the one in
// use-wrapped-bar.ts: the height of the bar, below the safe area, against one row plus half a rem.
function problems(state: BarState): string[] {
  const found: string[] = [];
  const wrapped = state.barHeight > state.oneRow + state.rem / 2;
  if (state.wrapped !== String(wrapped)) found.push(`data-wrapped is ${state.wrapped}, a bar of ${state.barHeight} px with one row ${state.oneRow} px and rem ${state.rem} px is ${wrapped ? "wrapped" : "one row"}`);
  if (state.position !== (wrapped ? "static" : "sticky")) found.push(`position is ${state.position}`);
  // Below 1024 px the page's scroll padding is meant for a bar that is there (from 1024 px it assumes the side rail, a separate matter).
  if (state.width < 1024 && state.row > 0) {
    if (wrapped && Math.abs(state.padding - (state.safe + state.rem / 2)) > 0.5) found.push(`a static bar, and the scroll padding is ${state.padding} px, not the notch (${state.safe} px) and half a rem (${state.rem / 2} px)`);
    if (!wrapped && state.barHeight + state.safe > state.padding + 0.5) found.push(`a sticky bar of ${state.barHeight + state.safe} px is taller than the scroll padding of ${state.padding} px, so a focused control could hide under it`);
  }
  return found;
}

async function open(page: Page, path: string, { language = "ar", viewport = VIEWPORTS.floor, zoom = 100 }: { language?: Language; viewport?: { width: number; height: number }; zoom?: number } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, "ok");
  // S-06 needs a session whose terms version differs from the build's; without one it sends the visitor to /login.
  if (path === "/consent") {
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...mockProfile, termsVersion: "2025-01-01" }) }));
  }
  await page.goto(path);
  await waitForFirstHealthRequest(health);
  await page.evaluate(() => document.fonts.ready);
  return zoom === 100 ? undefined : setZoom(page, zoom);
}

// Text enlarged as a browser's text-size setting does: the size of the root, in percent.
async function setZoom(page: Page, percent: number) {
  return page.addStyleTag({ content: `html { font-size: ${percent}% !important; }` });
}

const removeStyle = (handle: Awaited<ReturnType<Page["addStyleTag"]>> | undefined) => handle?.evaluate((element) => (element as Element).remove());

async function expectConsistent(page: Page, label: string) {
  await expect.poll(async () => problems(await barState(page)), { message: label, timeout: 6_000 }).toEqual([]);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("no bounding box");
  return result;
}

// The animations and transitions running on the bar or inside it right now: how many, and the longest one in milliseconds.
const motion = (page: Page): Promise<{ count: number; longest: number }> =>
  page.evaluate(() => {
    const running = (document.querySelector("header") as HTMLElement).getAnimations({ subtree: true });
    return { count: running.length, longest: Math.max(0, ...running.map((animation) => Number(animation.effect?.getTiming().duration ?? 0))) };
  });

test.describe("the rule holds on every page, in both languages, at each width and text size (UI-tokens 6.6, 7)", () => {
  for (const language of ["ar", "en"] as const) {
    for (const [path, what] of PAGES) {
      test(`${language} ${path} (${what}): sticky exactly when the row is one row plus half a rem, and the scroll padding agrees`, async ({ page }) => {
        await open(page, path, { language });
        for (const width of [320, 360, 768, 1280]) {
          await page.setViewportSize({ width, height: 568 });
          let handle: Awaited<ReturnType<typeof setZoom>> | undefined;
          for (const zoom of [100, 125, 150, 200, 300]) {
            await removeStyle(handle);
            handle = zoom === 100 ? undefined : await setZoom(page, zoom);
            await expectConsistent(page, `${path} ${language} at ${width} px and ${zoom} %`);
          }
          await removeStyle(handle);
        }
      });
    }
  }
});

test.describe("at normal text size the bar stays where it is (sticky, one row)", () => {
  test("S-03 at 320 px: it keeps the top of the window while the page scrolls, and the divider appears under it", async ({ page }) => {
    await open(page, "/terms");
    await expectConsistent(page, "at rest");
    const rest = await barState(page);
    expect([rest.wrapped, rest.position, rest.height]).toEqual(["false", "sticky", 57]);
    expect(rest.border).toBe(TRANSPARENT);
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect.poll(async () => (await barState(page)).border).toBe(DIVIDER);
    const scrolled = await barState(page);
    expect([scrolled.top, scrolled.scrollY]).toEqual([0, 800]);
  });

  test("S-06's focus bar holds the brand alone: one row, sticky, at 320 px and 100 % in English", async ({ page }) => {
    await open(page, "/consent", { language: "en" });
    await expectConsistent(page, "consent bar");
    const state = await barState(page);
    expect([state.wrapped, state.position]).toEqual(["false", "sticky"]);
  });
});

test.describe("the limit is one row plus half a rem, to the pixel", () => {
  // Padding is added to the row of a wide window, where it is one row of controls, to make the bar a chosen height. The controls are
  // 2.75 rem tall, one row is 3.5 rem and the limit 4 rem (the room that the page's scroll padding keeps clear). The bar is its row
  // and the 1 px divider under it.
  for (const [zoom, rem] of [
    [100, 16],
    [200, 32],
  ] as const) {
    test(`at ${zoom} %: a bar 1 px under ${4 * rem} px is sticky, one of ${4 * rem} px is sticky, and one 1 px over it is static`, async ({ page }) => {
      await open(page, "/terms", { viewport: { width: 768, height: 800 }, zoom });
      await expectConsistent(page, "natural");
      const padding = (barHeight: number) => `header > div { padding-block: ${(barHeight - 1 - 2.75 * rem) / 2}px !important; }`;
      for (const [barHeight, wrapped] of [
        [4 * rem - 1, "false"],
        [4 * rem + 1, "true"],
        [4 * rem, "false"],
      ] as const) {
        const handle = await page.addStyleTag({ content: padding(barHeight) });
        await expectConsistent(page, `a bar of ${barHeight} px`);
        const state = await barState(page);
        expect(state.barHeight, "the bar has the height that was asked for").toBeCloseTo(barHeight, 0);
        expect([state.wrapped, state.position], `a bar of ${barHeight} px`).toEqual([wrapped, wrapped === "true" ? "static" : "sticky"]);
        await removeStyle(handle);
      }
    });
  }
});

test.describe("at 200 % text on 320 px a wrapped bar is static and scrolls away with the page", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: S-03's bar (back control and switch on three rows) was 305 px of 568 px: it now scrolls away and leaves the window to the text`, async ({ page }) => {
      await open(page, "/terms", { language, zoom: 200 });
      await expectConsistent(page, "at 200 %");
      const at = await barState(page);
      expect([at.wrapped, at.position]).toEqual(["true", "static"]);
      expect(at.height).toBeGreaterThan(300);
      expect(at.border).toBe(TRANSPARENT);

      await page.evaluate(() => window.scrollTo(0, 400));
      await expect.poll(async () => (await barState(page)).scrollY).toBe(400);
      const away = await barState(page);
      expect(away.top).toBe(-400);
      expect(away.bottom).toBeLessThan(0);
      // Nothing scrolls under a bar that scrolls away, so there is no divider, and the window is all text: the point under where the bar was is text.
      expect(away.border).toBe(TRANSPARENT);
      expect(await page.evaluate(() => document.elementFromPoint(160, 20)?.closest("header") ?? null)).toBeNull();

      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(async () => (await barState(page)).top).toBe(0);
    });

    test(`${language}: the stacked segments of the switch on S-01 (no back control) make a bar of 192 px, and it is static too`, async ({ page }) => {
      await open(page, "/login", { language, zoom: 200 });
      await expectConsistent(page, "S-01 at 200 %");
      const state = await barState(page);
      expect([state.wrapped, state.position, state.row]).toEqual(["true", "static", 192]);
    });

    test(`${language}: a focus bar with a title and the switch is static once it has wrapped (S-08, 200 %)`, async ({ page }) => {
      await open(page, "/start", { language, zoom: 200 });
      await expectConsistent(page, "start at 200 %");
      const state = await barState(page);
      expect([state.wrapped, state.position]).toEqual(["true", "static"]);
      expect(state.row).toBeGreaterThan(state.oneRow + state.rem / 2);
    });
  }

  test("S-08's focus bar (a title and the language switch) wraps at 200 % on 320 px, so it is static and the rule stays consistent (start, ar)", async ({ page }) => {
    // The placeholder had a two-line title alone (123 px, sticky). The built screen adds the switch to the bar, so it is taller than the limit.
    await open(page, "/start", { language: "ar", zoom: 200 });
    await expectConsistent(page, "start at 200 %");
    const state = await barState(page);
    expect([state.wrapped, state.position]).toEqual(["true", "static"]);
    expect(state.height).toBeGreaterThan(state.padding);
  });

  test("the app shell's bar holds one item and never wraps, whatever the text size (today)", async ({ page }) => {
    for (const zoom of [100, 200, 300]) {
      await open(page, "/today", { zoom });
      await expectConsistent(page, `today at ${zoom} %`);
      const state = await barState(page);
      expect([state.wrapped, state.position]).toEqual(["false", "sticky"]);
    }
  });
});

test.describe("it follows the page as the page changes, in both directions, without a reload", () => {
  test("the text size: sticky at 100 %, static at 200 %, sticky again at 100 %", async ({ page }) => {
    await open(page, "/terms");
    expect((await barState(page)).position).toBe("sticky");
    const handle = await setZoom(page, 200);
    await expect.poll(async () => (await barState(page)).position).toBe("static");
    await removeStyle(handle);
    await expect.poll(async () => (await barState(page)).position).toBe("sticky");
    await expectConsistent(page, "back at 100 %");
  });

  test("the window: sticky at 1280 px and 200 %, static at 320 px, sticky again at 1280 px", async ({ page }) => {
    await open(page, "/terms", { viewport: VIEWPORTS.desktop, zoom: 200 });
    await expectConsistent(page, "1280 px");
    expect((await barState(page)).position).toBe("sticky");
    await page.setViewportSize({ width: 320, height: 568 });
    await expect.poll(async () => (await barState(page)).position).toBe("static");
    await page.setViewportSize(VIEWPORTS.desktop);
    await expect.poll(async () => (await barState(page)).position).toBe("sticky");
    await expectConsistent(page, "1280 px again");
  });

  test("the language: the bar is re-read when the labels change, and stays consistent in each language", async ({ page }) => {
    await open(page, "/terms", { zoom: 150 });
    for (const [name, language] of [
      ["English (EN)", "en"],
      ["العربية", "ar"],
    ] as const) {
      const radio = await box(page.getByRole("radio", { name }));
      await page.mouse.click(radio.x + radio.width / 2, radio.y + radio.height / 2);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expectConsistent(page, `after the switch to ${language}`);
    }
  });
});

test.describe("the safe area at the top of a phone's screen (the notch)", () => {
  // The test browser can be given a notch: Chromium's own override of env(safe-area-inset-top). The bar then has that padding above its row.
  async function withNotch(page: Page, top: number) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top } });
  }

  test("it is not part of the bar's height for the rule, and the scroll padding keeps its share: sticky, 44 px more of padding (100 %)", async ({ page }) => {
    await withNotch(page, 44);
    await open(page, "/terms", { viewport: { width: 768, height: 800 } });
    await expectConsistent(page, "with a notch");
    const state = await barState(page);
    expect([state.safe, state.barHeight, state.height]).toEqual([44, 57, 101]);
    expect([state.wrapped, state.position]).toEqual(["false", "sticky"]);
    // 3.5 rem for the bar, 44 px for the notch and 0.5 rem: the bar is under the notch, and the page keeps both clear.
    expect(state.padding).toBe(56 + 44 + 8);
  });

  test("a wrapped bar is static, and the page still keeps the notch clear above a focused control (200 %, 320 px)", async ({ page }) => {
    await withNotch(page, 44);
    await open(page, "/terms", { zoom: 200 });
    await expectConsistent(page, "wrapped with a notch");
    const state = await barState(page);
    expect([state.wrapped, state.position, state.safe]).toEqual(["true", "static", 44]);
    expect(state.padding).toBe(44 + 16);
    await page.evaluate(() => document.getElementById("privacy")?.scrollIntoView({ block: "start" }));
    expect((await box(page.locator("#privacy"))).y).toBeCloseTo(44 + 16, 0);
  });
});

test.describe("nothing moves when the bar changes between sticky and static", () => {
  test("the page content keeps its place and the bar its height when only the position changes (100 % and 200 %)", async ({ page }) => {
    for (const zoom of [100, 200]) {
      await open(page, "/terms", { zoom });
      await expectConsistent(page, `${zoom} %`);
      const natural = await barState(page);
      for (const forced of ["sticky", "static"]) {
        const handle = await page.addStyleTag({ content: `header { position: ${forced} !important; }` });
        const state = await barState(page);
        expect([state.mainTop, state.height], `${zoom} % forced ${forced}`).toEqual([natural.mainTop, natural.height]);
        await handle.evaluate((element) => (element as Element).remove());
      }
    }
  });
});

test.describe("a focused control is never hidden by the bar, in either state (2.4.11, at 320 by 568 and at 200 % text)", () => {
  // S-02 has the most controls of the built screens. From the last control of the page, Shift+Tab walks up through the others.
  async function walkUp(page: Page) {
    await page.evaluate(() => {
      const controls = [...document.querySelectorAll<HTMLElement>("main a[href], main button, main input")].filter((element) => element.checkVisibility());
      controls[controls.length - 1]?.focus();
    });
    const hidden: string[] = [];
    for (let step = 0; step < 14; step += 1) {
      await page.keyboard.press("Shift+Tab");
      const seen = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const bar = document.querySelector("header") as HTMLElement;
        return {
          // Past the first control focus leaves the page: nothing is left to check.
          left: element === document.body || element === document.documentElement,
          name: element.getAttribute("aria-label") ?? (element.textContent ?? "").trim().slice(0, 20),
          // The controls of the bar, and the skip link that opens over it, are not hidden by it.
          inBar: element.closest("header") !== null || element.getAttribute("href") === "#main",
          top: element.getBoundingClientRect().top,
          barBottom: bar.getBoundingClientRect().bottom,
          sticky: getComputedStyle(bar).position === "sticky",
        };
      });
      if (seen.left) break;
      if (seen.inBar) continue;
      // A static bar covers nothing: only the window's top edge counts. A sticky bar covers its own height.
      const limit = seen.sticky ? seen.barBottom : 0;
      if (seen.top < limit - 0.5) hidden.push(`${seen.name} at ${seen.top} px under a bar that ends at ${limit} px`);
    }
    return hidden;
  }

  test("at 320 by 568 and 100 %: the bar is sticky and the controls stay below it", async ({ page }) => {
    await open(page, "/register");
    expect((await barState(page)).position).toBe("sticky");
    expect(await walkUp(page)).toEqual([]);
  });

  test("at 320 by 568 and 200 %: the bar is static and the controls reach the top of the window", async ({ page }) => {
    await open(page, "/register", { zoom: 200 });
    await expectConsistent(page, "register at 200 %");
    expect((await barState(page)).position).toBe("static");
    expect(await walkUp(page)).toEqual([]);
  });

  test("an anchor lands under a sticky bar at 100 % and at the top of the window under a static one at 200 %", async ({ page }) => {
    await open(page, "/terms");
    await page.evaluate(() => document.getElementById("privacy")?.scrollIntoView({ block: "start" }));
    const sticky = await barState(page);
    expect((await box(page.locator("#privacy"))).y).toBeCloseTo(sticky.padding, 0);
    expect(sticky.padding).toBe(64);

    const handle = await setZoom(page, 200);
    await expectConsistent(page, "200 %");
    await page.evaluate(() => document.getElementById("privacy")?.scrollIntoView({ block: "start" }));
    const wrapped = await barState(page);
    expect(wrapped.padding).toBe(16);
    expect((await box(page.locator("#privacy"))).y).toBeCloseTo(16, 0);
    await removeStyle(handle);
  });
});

test.describe("motion and the keyboard (reduced motion respected)", () => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`reduced motion ${reducedMotion}: the switch is immediate, nothing on or in the bar lasts longer than 1 ms`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
      await open(page, "/terms");
      // With reduced motion, the global rule of globals.css gives every element a 0.01 ms transition, so a changed font size can list a few
      // of them for a frame. They are not the switch (position cannot animate); what must never exist is a real animation.
      const expectImmediate = async (when: string) => {
        const { count, longest } = await motion(page);
        expect(longest, when).toBeLessThanOrEqual(1);
        if (reducedMotion === "no-preference") expect(count, when).toBe(0);
      };
      await expectImmediate("at rest");
      const handle = await setZoom(page, 200);
      await expect.poll(async () => (await barState(page)).position).toBe("static");
      await expectImmediate("static");
      await removeStyle(handle);
      await expect.poll(async () => (await barState(page)).position).toBe("sticky");
      await expectImmediate("sticky again");
      const transition = await page.evaluate(() => getComputedStyle(document.querySelector("header") as HTMLElement).transitionDuration);
      expect(["0s", "1e-05s"]).toContain(transition);
    });
  }

  test("the tab order is the same in both states: skip link, back control, switch", async ({ page }) => {
    for (const zoom of [100, 200]) {
      await open(page, "/terms", { zoom });
      await expectConsistent(page, `${zoom} %`);
      const stops: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        await page.keyboard.press("Tab");
        stops.push(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("aria-label") ?? (document.activeElement?.textContent ?? "").trim()));
      }
      expect(stops, `${zoom} %`).toEqual(["انتقل إلى المحتوى", "رجوع إلى الصفحة الرئيسية", "العربية"]);
    }
  });
});

test.describe("axe (NFR-09): no violation in either state", () => {
  for (const language of ["ar", "en"] as const) {
    for (const [path, zoom] of [
      ["/terms", 200],
      ["/login", 200],
      ["/consent", 200],
      ["/start", 200],
      ["/consent", 100],
      ["/terms", 100],
    ] as const) {
      test(`${language} ${path} at 320 by 568 and ${zoom} %`, async ({ page }) => {
        await open(page, path, { language, zoom });
        await expectConsistent(page, `${path} at ${zoom} %`);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
});
