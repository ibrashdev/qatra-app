import { controlHealth, expect, NAV_NAME, test, VIEWPORTS, WAKE_LINE } from "./fixtures";

test.describe("tab bar below 1024 px, side rail from 1024 px (UA-03)", () => {
  test("at 390 px the bar is fixed to the bottom edge, full width, 64 px tall, and there is no rail", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.phone);
    await page.goto("/today");
    const nav = page.getByRole("navigation", { name: NAV_NAME.ar });
    await expect(nav).toHaveCount(1);
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box?.x ?? -1)).toBe(0);
    expect(Math.round(box?.width ?? 0)).toBe(VIEWPORTS.phone.width);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(VIEWPORTS.phone.height);
    expect(Math.round(box?.height ?? 0)).toBe(64);
    const items = await nav.getByRole("link").evaluateAll((links) => links.map((link) => link.getBoundingClientRect().width));
    for (const width of items) expect(width).toBeCloseTo(VIEWPORTS.phone.width / 4, 0);
  });

  test("at 1280 px the rail sits at the start edge (the right in Arabic), 240 px wide, full height, and there is no bar", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto("/today");
    const nav = page.getByRole("navigation", { name: NAV_NAME.ar });
    await expect(nav).toHaveCount(1);
    const box = await nav.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(240);
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(VIEWPORTS.desktop.width);
    expect(Math.round(box?.height ?? 0)).toBe(VIEWPORTS.desktop.height);
    const first = await nav.getByRole("link", { name: "اليوم" }).boundingBox();
    const last = await nav.getByRole("link", { name: "الإعدادات" }).boundingBox();
    expect(first?.y).toBeLessThan(last?.y ?? 0);
    // The top bar is gone: the rail carries the name.
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "قطرة غيث" })).toBeVisible();
  });

  test("the rail is on the left in English", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto("/today");
    const box = await page.getByRole("navigation", { name: NAV_NAME.en }).boundingBox();
    expect(Math.round(box?.x ?? -1)).toBe(0);
  });

  for (const [width, kind] of [
    [767, "bar"],
    [768, "bar"],
    [1023, "bar"],
    [1024, "rail"],
    [1025, "rail"],
  ] as const) {
    test(`at ${width} px the navigation is the ${kind}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/today");
      const box = await page.getByRole("navigation", { name: NAV_NAME.ar }).boundingBox();
      if (kind === "rail") expect(Math.round(box?.width ?? 0)).toBe(240);
      else expect(Math.round(box?.width ?? 0)).toBe(width);
    });
  }

  test("the bar reserves its own space: the last content is never hidden behind it, even in a very short window", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 200 });
    await page.goto("/today");
    // S-11 is built: wait until its content has loaded, scroll to the end, then look at the end of the content inside main.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("today-skeleton")).toHaveCount(0);
    const bar = await page.getByRole("navigation", { name: NAV_NAME.ar }).boundingBox();
    await expect
      .poll(async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        return page.evaluate(() => {
          const main = document.querySelector("main") as HTMLElement;
          // The toast region at the end of main is fixed and empty; the content is the last child that takes part in the flow.
          const inFlow = Array.from(main.children).filter((child) => getComputedStyle(child).position !== "fixed");
          return (inFlow.at(-1) ?? main).getBoundingClientRect().bottom;
        });
      })
      .toBeLessThanOrEqual(bar?.y ?? 0);
  });
});

test.describe("no horizontal scroll at any supported width (D67)", () => {
  const widths = [320, 360, 390, 430, 768, 1023, 1024, 1280];
  const routes = ["/login", "/today", "/games", "/progress", "/settings"];
  for (const language of ["ar", "en"] as const) {
    for (const width of widths) {
      test(`${language} at ${width} px`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
        await page.setViewportSize({ width, height: 700 });
        for (const route of routes) {
          await page.goto(route);
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          expect(scrollWidth, `${route} at ${width}`).toBeLessThanOrEqual(clientWidth);
        }
      });
    }
  }

  test.describe("with the wake-up banner showing", () => {
    test.use({ allowConsoleErrors: true });

    for (const language of ["ar", "en"] as const) {
      test(`the banner does not overflow at 320 px (${language})`, async ({ page }) => {
        await controlHealth(page, "gateway");
        await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
        await page.setViewportSize(VIEWPORTS.floor);
        await page.goto("/today");
        await expect(page.getByText(WAKE_LINE[language])).toBeVisible();
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }
  });
});

test.describe("touch targets (44 by 44 px, WCAG 2.5.8 approved stricter)", () => {
  async function smallTargets(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const selector = "a[href], button, input, select, textarea, summary, [role=button], [role=link]";
      const small: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        // The nav that the breakpoint hides is display:none through its parent, so it has no box.
        if (!element.checkVisibility()) continue;
        const rect = element.getBoundingClientRect();
        // The skip link is clipped until it receives focus.
        if (element.closest(".sr-only") === element && rect.width <= 1) continue;
        if (rect.width < 43.5 || rect.height < 43.5) {
          small.push(`${element.tagName} "${(element.textContent ?? "").trim()}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        }
      }
      return small;
    });
  }

  for (const [name, viewport] of [
    ["phone", VIEWPORTS.phone],
    ["floor", VIEWPORTS.floor],
    ["desktop", VIEWPORTS.desktop],
  ] as const) {
    for (const route of ["/login", "/today"]) {
      test(`${route} at ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(route);
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  }

  test("the two language segments are at least 8 px apart", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.floor);
    await page.goto("/login");
    const arabic = await page.locator("label[lang=ar]").boundingBox();
    const english = await page.locator("label[lang=en]").boundingBox();
    const gap = Math.min(Math.abs((arabic?.x ?? 0) - ((english?.x ?? 0) + (english?.width ?? 0))), Math.abs((english?.x ?? 0) - ((arabic?.x ?? 0) + (arabic?.width ?? 0))));
    expect(gap).toBeGreaterThanOrEqual(8);
  });
});

test.describe("reduced motion (UI-tokens 8)", () => {
  test.use({ allowConsoleErrors: true });

  test("the loader rotates normally and is a static ring under prefers-reduced-motion", async ({ page }) => {
    await controlHealth(page, "gateway");
    await page.goto("/today");
    await expect(page.getByText(WAKE_LINE.ar)).toBeVisible();
    // The built S-11 has live regions of its own, so the loader is looked up inside the wake-up line's region.
    const spinner = page.getByRole("status").filter({ hasText: WAKE_LINE.ar }).locator("span[aria-hidden=true]").first();
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("spin");

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    const duration = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--q-duration-base").trim());
    expect(Number.parseFloat(duration)).toBe(0);
  });

  test("the tab bar colour transition is off under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(VIEWPORTS.phone);
    await page.goto("/today");
    const duration = await page
      .getByRole("navigation", { name: NAV_NAME.ar })
      .getByRole("link", { name: "الألعاب" })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(duration)).toBeLessThan(0.001);
  });
});
