import { expect, NAV_NAME, TAB_NAMES, test, VIEWPORTS } from "./fixtures";

test.describe("direction, language and the four tabs (Arabic default)", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("/ redirects to /login, which is a placeholder in the public shell", async ({ page }) => {
    const response = await page.goto("/");
    expect(new URL(page.url()).pathname).toBe("/login");
    expect(response?.ok()).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("الدخول");
    await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toBeVisible();
    // A placeholder, not the login screen: no field and no submit button.
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page).toHaveTitle("الدخول · قطرة غيث");
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("the shell renders dir=rtl with the four tabs, today first at the start edge (the right)", async ({ page }) => {
    await page.goto("/today");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const nav = page.getByRole("navigation", { name: NAV_NAME.ar });
    const links = nav.getByRole("link");
    await expect(links).toHaveText([...TAB_NAMES.ar]);
    await expect(links).toHaveCount(4);
    const hrefs = await links.evaluateAll((items) => items.map((item) => item.getAttribute("href")));
    expect(hrefs).toEqual(["/today", "/games", "/progress", "/settings"]);

    const boxes = await Promise.all([0, 1, 2, 3].map((index) => links.nth(index).boundingBox()));
    const xs = boxes.map((box) => (box?.x ?? 0) + (box?.width ?? 0) / 2);
    expect(xs).toEqual([...xs].sort((a, b) => b - a));
    expect(xs[0]).toBeGreaterThan(VIEWPORTS.phone.width / 2);
    await expect(nav.getByRole("link", { name: "اليوم" })).toHaveAttribute("aria-current", "page");
  });

  test("a browser in English with no stored choice gets dir=ltr and English tab names", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US", viewport: VIEWPORTS.phone });
    const page = await context.newPage();
    await page.goto("/today");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("navigation", { name: NAV_NAME.en }).getByRole("link")).toHaveText([...TAB_NAMES.en]);
    await expect(page).toHaveTitle("Today · Qatra");
    await context.close();
  });

  test("a browser in another language falls back to Arabic", async ({ browser }) => {
    const context = await browser.newContext({ locale: "fr-FR" });
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await context.close();
  });
});

test.describe("language switch «العربية | EN»", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("switching to EN gives dir=ltr and English text; the choice survives a reload and a navigation", async ({ page }) => {
    await page.goto("/login");
    const group = page.getByRole("radiogroup", { name: "اللغة" });
    await expect(group.getByRole("radio")).toHaveCount(2);
    await expect(group.getByRole("radio", { name: "العربية" })).toBeChecked();

    await group.getByRole("radio", { name: "English (EN)" }).check();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Log in");
    await expect(page).toHaveTitle("Log in · Qatra");
    await expect(page.getByText("Language changed to English")).toBeAttached();
    await expect(page.getByRole("radio", { name: "English (EN)" })).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("qatra.language"))).toBe("en");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Log in");

    await page.goto("/games");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("navigation", { name: NAV_NAME.en }).getByRole("link").first()).toHaveText("Today");

    await page.goto("/login");
    await page.getByRole("radio", { name: "العربية" }).check();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    expect(await page.evaluate(() => localStorage.getItem("qatra.language"))).toBe("ar");
  });

  test("the tab order is mirrored with the direction: today is at the left in LTR", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await page.goto("/today");
    const links = page.getByRole("navigation", { name: NAV_NAME.en }).getByRole("link");
    const xs = await Promise.all([0, 1, 2, 3].map(async (index) => (await links.nth(index).boundingBox())?.x ?? 0));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(xs[0]).toBeLessThan(VIEWPORTS.phone.width / 2);
  });

  test("the switch works from the keyboard and keeps focus", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("radio", { name: "العربية" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("radio", { name: "English (EN)" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "English (EN)" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("still works when localStorage is blocked (UA-17), and the visit keeps its choice", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    });
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.getByRole("radio", { name: "English (EN)" }).check();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Log in");
  });
});

test.describe("navigation and focus", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("each tab opens its own placeholder page; focus moves to the heading and the title follows", async ({ page }) => {
    await page.goto("/today");
    // No autofocus on the first load.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    const nav = page.getByRole("navigation", { name: NAV_NAME.ar });
    const expected: [string, string][] = [
      ["الألعاب", "/games"],
      ["التقدم", "/progress"],
      ["الإعدادات", "/settings"],
      ["اليوم", "/today"],
    ];
    for (const [name, path] of expected) {
      await nav.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(page).toHaveTitle(`${name} · قطرة غيث`);
      await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(nav.locator("[aria-current=page]")).toHaveCount(1);
      await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toBeVisible();
    }
  });

  test("the product name links to the home destination of each shell", async ({ page }) => {
    await page.goto("/games");
    await page.getByRole("link", { name: "قطرة غيث" }).first().click();
    await expect(page).toHaveURL(/\/today$/);

    await page.goto("/login");
    await page.getByRole("link", { name: "قطرة غيث" }).click();
    // The public home is / until the catalog ships, and / leads to /login.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("الدخول");
  });

  test("the side rail opens each destination too, in English", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto("/today");
    const rail = page.getByRole("navigation", { name: NAV_NAME.en });
    for (const [name, path] of [
      ["Games", "/games"],
      ["Progress", "/progress"],
      ["Settings", "/settings"],
      ["Today", "/today"],
    ] as const) {
      await rail.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(rail.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page).toHaveTitle(`${name} · Qatra`);
    }
  });

  test("the skip link is the first tab stop, becomes visible, and moves focus to main", async ({ page }) => {
    await page.goto("/today");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "انتقل إلى المحتوى" });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box?.width).toBeGreaterThan(40);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
  });

  test("keyboard focus is visible: a 2 px ring in the focus colour on every stop", async ({ page }) => {
    await page.goto("/today");
    const stops: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      const style = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const computed = getComputedStyle(element);
        return {
          label: (element.textContent ?? "").trim() || element.getAttribute("aria-label") || element.tagName,
          style: computed.outlineStyle,
          width: computed.outlineWidth,
          color: computed.outlineColor,
        };
      });
      stops.push(style.label);
      expect(style.style, style.label).toBe("solid");
      expect(style.width, style.label).toBe("2px");
      expect(style.color, style.label).toBe("rgb(23, 79, 118)");
    }
    expect(stops.length).toBe(6);
  });

});

test.describe("not found", () => {
  test.use({ viewport: VIEWPORTS.phone, allowConsoleErrors: true });

  test("an unknown route shows the not-found page in the public shell, with a working link", async ({ page, consoleErrors }) => {
    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("الصفحة غير موجودة");
    await expect(page).toHaveTitle("الصفحة غير موجودة · قطرة غيث");
    await expect(page.getByRole("radiogroup", { name: "اللغة" })).toBeVisible();
    // The browser itself logs the 404 of the document; nothing else may be logged.
    expect(consoleErrors.filter((message) => !/status of 404/.test(message))).toEqual([]);
    await page.getByRole("link", { name: "الذهاب إلى الصفحة الرئيسية" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});
