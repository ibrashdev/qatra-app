import { mockProfile } from "../../src/lib/api/mock";
import { expect, NAV_NAME, signInOnSettingsRoutes, TAB_NAMES, test, VIEWPORTS } from "./fixtures";

// S-22 reads E11 on load; without a session the tab would end on the login screen. Pages outside /settings still see the visitor's 401.
test.beforeEach(async ({ page }) => {
  await signInOnSettingsRoutes(page);
});

test.describe("direction, language and the five tabs (Arabic default)", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("/ is the S-07 public catalog for a visitor: metadata cards in the public shell, no tab bar", async ({ page }) => {
    const response = await page.goto("/");
    expect(new URL(page.url()).pathname).toBe("/");
    expect(response?.ok()).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("تصفّح الكتب");
    await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: "عنوان الكتاب (عنصر نائب)" })).toBeVisible();
    // Below 768 px the two actions sit under the intro; the header instances are hidden.
    await expect(page.getByRole("link", { name: "إنشاء حساب" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "تسجيل الدخول" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "إنشاء حساب" })).toHaveAttribute("href", "/register");
    await expect(page).toHaveTitle("تصفّح الكتب · قطرة غيث");
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("the register route is the S-02 screen, in the public shell with a back control, not a placeholder", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("إنشاء الحساب");
    await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "اللغة" })).toBeVisible();
    await expect(page.getByRole("link", { name: "رجوع إلى تصفّح الكتب" })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page).toHaveTitle("إنشاء الحساب · قطرة غيث");
  });

  test("the recovery route is the built S-05 screen in the public shell: a back control and the switch, no tab bar", async ({ page }) => {
    await page.goto("/recovery");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("استرجاع الحساب");
    await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "اللغة" })).toBeVisible();
    await expect(page.getByRole("link", { name: "رجوع إلى تصفّح الكتب" })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("the consent route is the built S-06 gate in the focus shell: the brand alone in the bar, no switch, no tab bar", async ({ page }) => {
    // The gate needs a session whose terms version differs from the build's.
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...mockProfile, termsVersion: "2025-01-01" }) }));
    await page.goto("/consent");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("موافقة جديدة على الشروط");
    await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "اللغة" })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("the start route is the built S-08 screen in the focus shell: its own language switch, no tab bar, no placeholder", async ({ page }) => {
    await page.goto("/start");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ما هي خطتك؟");
    await expect(page.getByRole("radiogroup", { name: "اللغة" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "الباب" })).toBeVisible();
    await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("the shell renders dir=rtl with the five tabs, today first at the start edge (the right)", async ({ page }) => {
    await page.goto("/today");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const nav = page.getByRole("navigation", { name: NAV_NAME.ar });
    const links = nav.getByRole("link");
    await expect(links).toHaveText([...TAB_NAMES.ar]);
    await expect(links).toHaveCount(5);
    const hrefs = await links.evaluateAll((items) => items.map((item) => item.getAttribute("href")));
    expect(hrefs).toEqual(["/today", "/lessons", "/games", "/progress", "/settings"]);

    const boxes = await Promise.all([0, 1, 2, 3, 4].map((index) => links.nth(index).boundingBox()));
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
    await expect(page).toHaveTitle("Your step today · Qatra");
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

  test("each tab opens its own page (built screens and placeholders); focus moves to the heading and the title follows", async ({ page }) => {
    await page.goto("/today");
    // No autofocus on the first load.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    const nav = page.getByRole("navigation", { name: NAV_NAME.ar });
    // [tab name, path, heading, is it still a placeholder (null: not asserted)]: S-11, S-21 and S-22 are built and name their own heading; the games hub
    // is being built, so its placeholder text is not asserted either way.
    const expected: [string, string, string, boolean | null][] = [
      ["الألعاب", "/games", "الألعاب", null],
      ["التقدم", "/progress", "النتائج والتقدم", false],
      ["الإعدادات", "/settings", "الإعدادات", false],
      ["اليوم", "/today", "خطوتك اليوم", false],
    ];
    for (const [name, path, heading, placeholder] of expected) {
      await nav.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(page).toHaveTitle(`${heading} · قطرة غيث`);
      await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(nav.locator("[aria-current=page]")).toHaveCount(1);
      if (placeholder !== null) await expect(page.getByText("هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة.")).toHaveCount(placeholder ? 1 : 0);
    }
  });

  test("the product name links to the home destination of each shell", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("link", { name: "قطرة غيث" }).first().click();
    await expect(page).toHaveURL(/\/today$/);

    // The public screens with a back control (S-02, S-03, S-05) carry no lockup in the header, and the login page carries it in the page itself.
    await page.goto("/recovery");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("استرجاع الحساب");
    await expect(page.getByRole("link", { name: "قطرة غيث" })).toHaveCount(0);
  });

  test("the side rail opens each destination too, in English", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto("/today");
    const rail = page.getByRole("navigation", { name: NAV_NAME.en });
    for (const [name, path, heading] of [
      ["Games", "/games", "Games"],
      ["Progress", "/progress", "Results and progress"],
      ["Settings", "/settings", "Settings"],
      ["Today", "/today", "Your step today"],
    ] as const) {
      await rail.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(rail.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page).toHaveTitle(`${heading} · Qatra`);
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
    // A visitor's home is the public catalog (S-07, the link target of the 404 page).
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("تصفّح الكتب");
  });
});
