import { MOCK_ADMIN } from "../../src/lib/api/mock";
import {
  axeViolations as violations,
  axeViolationsAtRest,
  controlHealth,
  expect,
  signInOnSettingsRoutes,
  stubAdminApi,
  test,
  VIEWPORTS,
  waitForFirstHealthRequest,
  WAKE_LINE,
} from "./fixtures";

test.describe("axe-core: no violation on any shell route (NFR-09 baseline)", () => {
  const routes = [
    "/",
    "/login",
    "/today",
    "/games",
    "/progress",
    "/settings",
    "/settings/password",
    "/settings/recovery-code",
    "/settings/delete-account",
    "/settings/sources",
    "/settings/privacy",
  ];
  const cases = [
    { language: "ar", viewport: VIEWPORTS.phone },
    { language: "ar", viewport: VIEWPORTS.desktop },
    { language: "en", viewport: VIEWPORTS.phone },
    { language: "en", viewport: VIEWPORTS.desktop },
  ] as const;

  for (const { language, viewport } of cases) {
    test(`${language} at ${viewport.width} px`, async ({ page }) => {
      await signInOnSettingsRoutes(page);
      await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(new URL(page.url()).pathname, "the route renders itself, not a redirect").toBe(route);
        expect(await axeViolationsAtRest(page), route).toEqual([]);
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
    // The indicator sits in a status region; the built S-11 skeleton carries the same words for screen readers outside any region.
    await expect(page.getByRole("status").getByText("جارٍ التحميل")).toBeVisible();
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

test.describe("axe-core: no violation on the content manager routes (D91)", () => {
  const routes = [
    "/admin",
    "/admin/books",
    "/admin/categories",
    "/admin/sources",
    `/admin/editions/${MOCK_ADMIN.editions.published}`,
    `/admin/editions/${MOCK_ADMIN.editions.revoked}`,
    `/admin/sections/${MOCK_ADMIN.sections.published}`,
    `/admin/sections/${MOCK_ADMIN.sections.hidden}`,
  ];
  const cases = [
    { language: "ar", viewport: VIEWPORTS.phone },
    { language: "ar", viewport: VIEWPORTS.desktop },
    { language: "en", viewport: VIEWPORTS.phone },
    { language: "en", viewport: VIEWPORTS.desktop },
  ] as const;

  for (const { language, viewport } of cases) {
    test(`${language} at ${viewport.width} px`, async ({ page }) => {
      await stubAdminApi(page);
      await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
        expect(new URL(page.url()).pathname, "the route renders itself, not a redirect").toBe(route);
        expect(await axeViolationsAtRest(page), route).toEqual([]);
      }
    });
  }

  test.describe("an account that is not a content manager", () => {
    // The overview is answered 403, and the browser logs that failed request as a console error on its own.
    test.use({ allowFailedRequests: true });

    test("the page says so and has no violation (403)", async ({ page }) => {
      await stubAdminApi(page, { contentManager: false });
      await page.setViewportSize(VIEWPORTS.phone);
      await page.goto("/admin");
      await expect(page.getByText("هذه الصفحة لمدير المحتوى فقط.")).toBeVisible();
      expect(await axeViolationsAtRest(page)).toEqual([]);
    });
  });

  for (const language of ["ar", "en"] as const) {
    test(`the open edit, withdraw and delete dialogs (${language})`, async ({ page }) => {
      await stubAdminApi(page);
      await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
      await page.setViewportSize(VIEWPORTS.phone);
      const name = (ar: string, en: string) => (language === "ar" ? ar : en);

      await page.goto(`/admin/editions/${MOCK_ADMIN.editions.published}`);
      await page.getByRole("button", { name: name("تغيير تسمية الطبعة", "Rename the edition") }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(await violations(page), "rename dialog").toEqual([]);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: name("سحب الطبعة", "Withdraw the edition") }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      expect(await violations(page), "withdraw dialog").toEqual([]);
      await page.getByRole("alertdialog").getByRole("button", { name: name("سحب الطبعة نهائيًا", "Withdraw permanently") }).click();
      await expect(page.getByRole("alertdialog").getByText(name("اختر سبب السحب.", "Choose the reason for the withdrawal."))).toBeVisible();
      expect(await violations(page), "withdraw dialog with errors").toEqual([]);
      await page.keyboard.press("Escape");

      await page.goto(`/admin/editions/${MOCK_ADMIN.editions.draft}`);
      await page.getByRole("button", { name: name("حذف المسودة", "Delete the draft") }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      expect(await violations(page), "delete dialog").toEqual([]);
    });
  }
});
