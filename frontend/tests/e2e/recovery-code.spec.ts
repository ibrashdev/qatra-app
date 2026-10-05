import { readFile } from "node:fs/promises";
import type { Locator, Page, Route } from "@playwright/test";
import { MOCK_PASSWORD, MOCK_RECOVERY_CODE, mockProfile, mockToday, mockTodayWithoutPlan } from "../../src/lib/api/mock";
import { axeViolations, controlHealth, expect, smallTargets, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// S-04 (UI-screens Batch 1) in a real browser, against a production build in live mode. The screen is reached the way a learner reaches it:
// by registering on S-02, whose E03 answer is route-intercepted. Only the registration host is reachable in this build; the other two
// hosts are covered by the unit tests. The stub backend answers E01 and, as a visitor, E11.

type Language = "ar" | "en";

const COPY = {
  ar: {
    heading: "حفظ رمز الاسترجاع",
    title: "حفظ رمز الاسترجاع · قطرة غيث",
    appName: "قطرة غيث",
    skip: "انتقل إلى المحتوى",
    lead: "يظهر هذا الرمز مرة واحدة فقط ولن نستطيع عرضه لك مرة أخرى. احفظه في مكان آمن خارج التطبيق.",
    warning: "لا يمكن استرجاع الحساب دون الرمز. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.",
    blockName: "رمز الاسترجاع",
    blockDescription: "يظهر مرة واحدة فقط",
    copy: "نسخ",
    download: "تنزيل",
    confirm: "حفظت الرمز في مكان آمن خارج التطبيق",
    confirmRequired: "أكّد أنك حفظت الرمز قبل المتابعة.",
    continue: "متابعة",
    copied: "تم النسخ",
    downloaded: "تم تنزيل الملف",
    copyUnavailable: "تعذّر النسخ تلقائيًا. حدّد الرمز وانسخه يدويًا.",
    file: ["قطرة غيث: رمز الاسترجاع", MOCK_RECOVERY_CODE, "احتفظ بهذا الملف في مكان آمن ولا تشاركه."],
    leaveTitle: "لم تؤكد حفظ الرمز",
    leaveBody: "إن غادرت الآن فلن يظهر هذا الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.",
    stay: "البقاء وحفظ الرمز",
    leave: "المغادرة دون حفظ",
    unavailable: "لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.",
    unavailableRecovery: "لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات بعد تسجيل الدخول.",
    dismiss: "إغلاق التنبيه",
    startHeading: "ما هي خطتك؟",
    loginHeading: "الدخول",
    todayHeading: "اليوم",
    createLink: "إنشاء حساب",
    registerUsername: "اسم المستخدم",
    registerPassword: "كلمة المرور",
    registerConfirmation: "تأكيد كلمة المرور",
    registerSubmit: "إنشاء الحساب",
  },
  en: {
    heading: "Save your recovery code",
    title: "Save your recovery code · Qatra",
    appName: "Qatra",
    skip: "Skip to content",
    lead: "This code is shown only once and we cannot show it to you again. Keep it in a safe place outside the app.",
    warning: "The account cannot be recovered without the code. If you lose both your password and this code, we cannot recover your account.",
    blockName: "Recovery code",
    blockDescription: "Shown once only",
    copy: "Copy",
    download: "Download",
    confirm: "I have saved the code in a safe place outside the app",
    confirmRequired: "Confirm that you have saved the code before you continue.",
    continue: "Continue",
    copied: "Copied",
    downloaded: "File downloaded",
    copyUnavailable: "Automatic copy is not available. Select the code and copy it by hand.",
    file: ["Qatra: recovery code", MOCK_RECOVERY_CODE, "Keep this file somewhere safe and do not share it."],
    leaveTitle: "You have not confirmed saving the code",
    leaveBody: "If you leave now this code will not be shown again. You can create a new one in Settings.",
    stay: "Stay and save the code",
    leave: "Leave without saving",
    unavailable: "The code cannot be shown again. You can create a new one in Settings.",
    unavailableRecovery: "The code cannot be shown again. You can create a new one in Settings after you log in.",
    dismiss: "Dismiss message",
    startHeading: "What is your plan?",
    loginHeading: "Log in",
    todayHeading: "Today",
    createLink: "Create an account",
    registerUsername: "Username",
    registerPassword: "Password",
    registerConfirmation: "Confirm password",
    registerSubmit: "Create account",
  },
} as const;

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

// Where the code must not be. A short piece of it is enough to find it in text the learner can see or the page holds in memory; in a file name
// (a build's chunks are named by hash) only the whole code, with or without its dashes, counts.
const SHORT_PIECES = /0123|4567|89ab|cdef/;
const WHOLE_CODE = new RegExp(`${MOCK_RECOVERY_CODE}|${MOCK_RECOVERY_CODE.replaceAll("-", "")}|0123-4567`);

// Elements that are not the learner's to read: the build's scripts and styles carry hashed file names.
const alerts = (page: Page) => page.locator("[role=alert]:not(#__next-route-announcer__)");

// Registers on S-02, with E03 answered by the example of the contract, and ends on S-04 with the heading focused. The login page is opened
// first, so the history has a page before the registration (the form is replaced by S-04, which is what the test of Back relies on).
async function reach(page: Page, { language = "ar", viewport = VIEWPORTS.phone }: { language?: Language; viewport?: { width: number; height: number } } = {}) {
  const copy = COPY[language];
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, "ok");
  await page.goto("/login");
  await waitForFirstHealthRequest(health);
  await page.getByRole("link", { name: copy.createLink, exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await page.route("**/api/auth/register", (route: Route) =>
    route.fulfill({ status: 201, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ profile: mockProfile, recoveryCode: MOCK_RECOVERY_CODE }) }),
  );
  await page.getByRole("textbox", { name: copy.registerUsername }).fill("fresh_user_01");
  await page.getByLabel(copy.registerPassword, { exact: true }).fill(MOCK_PASSWORD);
  await page.getByLabel(copy.registerConfirmation, { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: copy.registerSubmit }).click();
  await expect(page).toHaveURL(/\/recovery-code$/);
  await expect(page.getByRole("heading", { level: 1, name: copy.heading })).toBeFocused();
  return health;
}

// Prepares a visit with no code in memory (an address typed in, or a reload): the language, the viewport and E01 are set, and the test goes
// to /recovery-code itself, with whatever the session probe answers.
async function openWithoutCode(page: Page, { language = "ar", viewport = VIEWPORTS.phone }: { language?: Language; viewport?: { width: number; height: number } } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  await controlHealth(page, "ok");
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("no bounding box");
  return result;
}

const heading = (page: Page, language: Language) => page.getByRole("heading", { level: 1, name: COPY[language].heading });
const copyButton = (page: Page, language: Language) => page.getByRole("button", { name: COPY[language].copy, exact: true });
const downloadButton = (page: Page, language: Language) => page.getByRole("button", { name: COPY[language].download, exact: true });
const confirmBox = (page: Page, language: Language) => page.getByRole("checkbox", { name: COPY[language].confirm });
const continueButton = (page: Page, language: Language) => page.getByRole("button", { name: COPY[language].continue, exact: true });
const block = (page: Page, language: Language) => page.getByRole("group", { name: COPY[language].blockName });
const dialog = (page: Page) => page.getByRole("alertdialog");
// The four hex characters of a group; the lone dash between the two lines is not one.
const groups = (page: Page, language: Language) => block(page, language).locator("span").filter({ hasText: /^[0-9a-f]{4}$/ });
// The drawn 24 px box of the confirmation: the native input lies over it.
const confirmRow = (page: Page, language: Language) => confirmBox(page, language).locator("xpath=ancestor::label");
const style = (locator: Locator, properties: string[]) => locator.evaluate((element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])), properties);
const toastPill = (page: Page, text: string) => page.getByText(text, { exact: true }).locator("xpath=..");

const NO_OVERFLOW = () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth });

test.describe("layout and design (UI-screens S-04 sections 2, 5 and 6)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: the header, the heading, the lead, the warning, the code, the two actions, the box and Continue, top to bottom, in one column`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      const order = [
        heading(page, language),
        page.getByText(copy.lead, { exact: true }),
        page.getByText(copy.warning, { exact: true }),
        block(page, language),
        copyButton(page, language),
        downloadButton(page, language),
        confirmRow(page, language),
        continueButton(page, language),
      ];
      const tops = await Promise.all(order.map(async (item) => (await box(item)).y));
      expect(tops.slice(0, 5)).toEqual([...tops.slice(0, 5)].sort((a, b) => a - b));
      // Copy and Download share a row; everything after them is lower.
      expect(Math.round(tops[4] ?? 0)).toBe(Math.round(tops[5] ?? 1));
      expect(tops[6]).toBeGreaterThan(tops[5] ?? 0);
      expect(tops[7]).toBeGreaterThan(tops[6] ?? 0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("main")).toBeVisible();
      expect(await page.title()).toBe(copy.title);
    });

    test(`${language}: the header holds the droplet and the product name and nothing else: no link, no switch, no back control, no tab bar`, async ({ page }) => {
      await reach(page, { language });
      const header = page.getByRole("banner");
      await expect(header).toHaveText(COPY[language].appName);
      await expect(header.getByRole("link")).toHaveCount(0);
      await expect(header.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("radiogroup")).toHaveCount(0);
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expect(page.getByRole("link", { name: /^(رجوع|Back)/ })).toHaveCount(0);
      expect(await header.locator("svg").count()).toBe(1);
      expect(await header.locator("svg").evaluate((svg) => svg.getAttribute("aria-hidden"))).toBe("true");
      // The only link on the page is the skip link, hidden until it is focused.
      await expect(page.getByRole("link")).toHaveText([COPY[language].skip]);
    });
  }

  test("the regions are 24 px apart, the two actions 8 px apart, and the heading is 22 px bold", async ({ page }) => {
    await reach(page);
    const rects = {
      heading: await box(heading(page, "ar")),
      lead: await box(page.getByText(COPY.ar.lead, { exact: true })),
      warning: await box(page.getByText(COPY.ar.warning, { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]")),
      block: await box(block(page, "ar")),
      copy: await box(copyButton(page, "ar")),
      download: await box(downloadButton(page, "ar")),
      confirm: await box(confirmRow(page, "ar")),
      continue: await box(continueButton(page, "ar")),
    };
    const gap = (above: { y: number; height: number }, below: { y: number }) => Math.round(below.y - (above.y + above.height));
    expect(gap(rects.heading, rects.lead)).toBe(24);
    expect(gap(rects.lead, rects.warning)).toBe(24);
    expect(gap(rects.warning, rects.block)).toBe(24);
    expect(gap(rects.block, rects.copy)).toBe(24);
    expect(gap(rects.copy, rects.confirm)).toBe(24);
    expect(gap(rects.confirm, rects.continue)).toBe(24);
    // In Arabic the first action is at the right; the second is 8 px to its left.
    expect(Math.round(rects.copy.x - (rects.download.x + rects.download.width))).toBe(8);
    expect(await style(heading(page, "ar"), ["font-size", "font-weight", "color"])).toEqual({ "font-size": "22px", "font-weight": "700", color: "rgb(24, 59, 82)" });
  });

  test("the column is the viewport minus the 24 px margins on a phone, and 480 px, centred, from 560 px", async ({ page }) => {
    await reach(page, { viewport: { width: 360, height: 800 } });
    const phone = await box(block(page, "ar"));
    expect(Math.round(phone.x)).toBe(24);
    expect(Math.round(phone.width)).toBe(360 - 48);
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = await box(block(page, "ar"));
    expect(Math.round(desktop.width)).toBe(480);
    expect(Math.round(desktop.x)).toBe((1280 - 480) / 2);
    await page.setViewportSize({ width: 600, height: 800 });
    expect(Math.round((await box(block(page, "ar"))).width)).toBe(480);
    await page.setViewportSize({ width: 768, height: 1024 });
    expect(Math.round((await box(block(page, "ar"))).width)).toBe(480);
  });

  test("the code block is 122 px high with 24 px vertical and 16 px side padding (FC-07, D86), a 1 px border, the 12 px radius and the white surface, in 20 px mono on a 36 px line", async ({ page }) => {
    await reach(page);
    expect(await style(block(page, "ar"), ["padding-top", "padding-left", "border-top-width", "border-top-color", "border-top-left-radius", "background-color", "font-size", "line-height", "color", "user-select", "direction"])).toEqual({
      "padding-top": "24px",
      "padding-left": "16px",
      "border-top-width": "1px",
      "border-top-color": "rgb(120, 144, 163)",
      "border-top-left-radius": "12px",
      "background-color": "rgb(255, 255, 255)",
      "font-size": "20px",
      "line-height": "36px",
      color: "rgb(24, 59, 82)",
      "user-select": "all",
      direction: "ltr",
    });
    expect(Math.round((await box(block(page, "ar"))).height)).toBe(122);
    const family = await block(page, "ar").evaluate((element) => getComputedStyle(element).fontFamily);
    expect(family).toContain("monospace");
    expect(family).not.toContain("Cairo");
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: eight groups of four, two lines of four at 320, 360, 390, 768 and 1280 px, left to right, whatever the page direction`, async ({ page }) => {
      await reach(page, { language });
      for (const width of [320, 360, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const rects = await groups(page, language).evaluateAll((spans) => spans.map((span) => ({ text: span.textContent, ...span.getBoundingClientRect().toJSON() })));
        expect(rects.map((rect) => rect.text), `${width} px`).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
        const firstLine = rects.slice(0, 4);
        const secondLine = rects.slice(4);
        for (const rect of firstLine) expect(Math.round(rect.y), `${width} px first line`).toBe(Math.round(firstLine[0]?.y ?? 0));
        for (const rect of secondLine) expect(Math.round(rect.y), `${width} px second line`).toBe(Math.round(secondLine[0]?.y ?? 0));
        expect(Math.round((secondLine[0]?.y ?? 0) - (firstLine[0]?.y ?? 0))).toBe(36);
        // Left to right in both page directions.
        for (const line of [firstLine, secondLine]) expect(line.map((rect) => rect.x)).toEqual([...line.map((rect) => rect.x)].sort((a, b) => a - b));
        // Inside the block, with its padding, at every width.
        const frame = await box(block(page, language));
        for (const rect of rects) {
          expect(rect.x).toBeGreaterThanOrEqual(frame.x + 16);
          expect(rect.x + rect.width).toBeLessThanOrEqual(frame.x + frame.width - 16 + 0.5);
        }
      }
    });

    test(`${language}: the block text is the code with its dashes, in the page and in a copy by hand, and a press selects it whole`, async ({ page }) => {
      await reach(page, { language });
      await expect(block(page, language)).toHaveText(MOCK_RECOVERY_CODE);
      await expect(block(page, language)).toHaveAttribute("dir", "ltr");
      await expect(block(page, language)).toHaveAttribute("translate", "no");
      await expect(block(page, language)).not.toHaveAttribute("tabindex");
      await block(page, language).click();
      const selected = await page.evaluate(() => window.getSelection()?.toString().replace(/\s/g, ""));
      expect(selected).toBe(MOCK_RECOVERY_CODE);
    });
  }

  test("Copy and Download are 48 px high and at least 88 px wide; the box row is at least 44 px; Continue is 48 px and as wide as the column", async ({ page }) => {
    await reach(page);
    for (const button of [copyButton(page, "ar"), downloadButton(page, "ar")]) {
      const rect = await box(button);
      expect(Math.round(rect.height)).toBe(48);
      expect(rect.width).toBeGreaterThanOrEqual(88);
    }
    expect((await box(confirmRow(page, "ar"))).height).toBeGreaterThanOrEqual(44);
    const column = await box(block(page, "ar"));
    const next = await box(continueButton(page, "ar"));
    expect(Math.round(next.height)).toBe(48);
    expect(Math.round(next.width)).toBe(Math.round(column.width));
    expect(Math.round(next.x)).toBe(Math.round(column.x));
  });

  for (const language of ["ar", "en"] as const) {
    for (const viewport of [VIEWPORTS.phone, VIEWPORTS.floor, VIEWPORTS.desktop]) {
      test(`${language} at ${viewport.width} px: every control is at least 44 by 44 px`, async ({ page }) => {
        await reach(page, { language, viewport });
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  }

  test("the warning, the buttons and Continue use the tokens: the warning tint and edge, the primary fill, the outline recipe with the deep blue label", async ({ page }) => {
    await reach(page);
    const banner = page.getByText(COPY.ar.warning, { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
    expect(await style(banner, ["background-color", "border-top-color", "color", "border-top-left-radius", "padding-top"])).toEqual({
      "background-color": "rgb(255, 244, 219)",
      "border-top-color": "rgb(161, 92, 0)",
      color: "rgb(138, 83, 0)",
      "border-top-left-radius": "12px",
      "padding-top": "16px",
    });
    expect(await style(continueButton(page, "ar"), ["background-color", "color", "border-top-left-radius"])).toEqual({ "background-color": "rgb(29, 120, 181)", color: "rgb(255, 255, 255)", "border-top-left-radius": "8px" });
    expect(await style(copyButton(page, "ar"), ["background-color", "border-top-color", "color", "border-top-width"])).toEqual({
      "background-color": "rgb(255, 255, 255)",
      "border-top-color": "rgb(120, 144, 163)",
      color: "rgb(23, 79, 118)",
      "border-top-width": "1px",
    });
  });

  for (const language of ["ar", "en"] as const) {
    for (const width of [320, 360, 390, 768, 1280]) {
      test(`${language} at ${width} px: no horizontal scroll`, async ({ page }) => {
        await reach(page, { language, viewport: { width, height: 800 } });
        const { scrollWidth, clientWidth } = await page.evaluate(NO_OVERFLOW);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }
  }

  for (const language of ["ar", "en"] as const) {
    test(`${language}: text enlarged to 200 % on a 320 px screen reflows: no horizontal scroll, nothing clipped, the code still whole`, async ({ page }) => {
      await reach(page, { language, viewport: { width: 320, height: 568 } });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const { scrollWidth, clientWidth } = await page.evaluate(NO_OVERFLOW);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      const rects = await groups(page, language).evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().toJSON()));
      expect(rects).toHaveLength(8);
      for (const rect of rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(clientWidth);
      }
      await expect(block(page, language)).toHaveText(MOCK_RECOVERY_CODE);
      // The two actions drop to a second row rather than run off the page.
      for (const button of [copyButton(page, language), downloadButton(page, language), continueButton(page, language)]) {
        const rect = await box(button);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(clientWidth);
      }
    });

    test(`${language}: the text-spacing override of WCAG 1.4.12 loses nothing and adds no horizontal scroll`, async ({ page }) => {
      await reach(page, { language, viewport: { width: 320, height: 640 } });
      await page.addStyleTag({
        content: "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
      });
      const { scrollWidth, clientWidth } = await page.evaluate(NO_OVERFLOW);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      await expect(block(page, language)).toHaveText(MOCK_RECOVERY_CODE);
      await expect(continueButton(page, language)).toBeVisible();
    });
  }

  test("the page after the first load keeps the focus where the learner put it: nothing steals it on a reflow", async ({ page }) => {
    await reach(page);
    await copyButton(page, "ar").focus();
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(copyButton(page, "ar")).toBeFocused();
  });
});

test.describe("states of S-04 (section 4)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL ?? "").origin });
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: arrival: the code is shown with the box unchecked, the heading has focus, and it is described by the one-time sentence`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      await expect(heading(page, language)).toBeFocused();
      await expect(heading(page, language)).toHaveAccessibleDescription(copy.lead);
      await expect(confirmBox(page, language)).not.toBeChecked();
      await expect(block(page, language)).toHaveAccessibleDescription(copy.blockDescription);
      await expect(page.getByText(copy.warning, { exact: true })).toBeVisible();
      await expect(continueButton(page, language)).toBeEnabled();
      await expect(continueButton(page, language)).not.toHaveAttribute("aria-disabled");
      // Nothing is announced on arrival but the heading and its description: no toast, no alert, no notice.
      await expect(alerts(page)).toHaveCount(0);
      await expect(page.getByText(copy.copied)).toHaveCount(0);
      await expect(page.getByText(copy.copyUnavailable)).toHaveCount(0);
      await expect(page.getByText(copy.confirmRequired)).toHaveCount(0);
    });

    test(`${language}: Copy puts the code with its dashes on the clipboard, confirms with a polite toast and leaves focus on the button`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      await copyButton(page, language).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MOCK_RECOVERY_CODE);
      const toast = page.getByText(copy.copied, { exact: true });
      await expect(toast).toBeVisible();
      const region = toast.locator("xpath=ancestor::*[@aria-live][1]");
      await expect(region).toHaveAttribute("role", "status");
      await expect(region).toHaveAttribute("aria-live", "polite");
      await expect(region).toHaveAttribute("aria-atomic", "true");
      await expect(copyButton(page, language)).toBeFocused();
      await expect(page.getByText(copy.copyUnavailable)).toHaveCount(0);
    });
  }

  test("the toast is the inverse surface with white text, lies near the bottom edge, never takes a press, and goes after 6 seconds", async ({ page }) => {
    await page.clock.install();
    await reach(page);
    await copyButton(page, "ar").click();
    const pill = toastPill(page, COPY.ar.copied);
    await expect(pill).toBeVisible();
    expect(await style(pill, ["background-color", "color", "border-top-left-radius"])).toEqual({ "background-color": "rgb(24, 59, 82)", color: "rgb(255, 255, 255)", "border-top-left-radius": "12px" });
    const region = pill.locator("xpath=..");
    expect(await style(region, ["pointer-events", "position", "z-index"])).toEqual({ "pointer-events": "none", position: "fixed", "z-index": "40" });
    // 16 px above the bottom edge once it has slid into place.
    await expect
      .poll(async () => {
        const rect = await box(pill);
        return Math.round(VIEWPORTS.phone.height - (rect.y + rect.height));
      })
      .toBe(16);
    await page.clock.runFor(5_000);
    await expect(pill).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(page.getByText(COPY.ar.copied)).toHaveCount(0);
  });

  test("Escape closes the toast", async ({ page }) => {
    await reach(page);
    await copyButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.copied)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText(COPY.ar.copied)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("the toast does not cover a press: Continue stays reachable while it shows, even in a short window", async ({ page }) => {
    await reach(page, { viewport: { width: 360, height: 700 } });
    await copyButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.copied)).toBeVisible();
    await continueButton(page, "ar").click();
    await expect(confirmBox(page, "ar")).toBeFocused();
  });

  test("a second copy is announced again: the toast is a new element, with the same words", async ({ page }) => {
    await reach(page);
    await copyButton(page, "ar").click();
    const first = toastPill(page, COPY.ar.copied);
    await expect(first).toBeVisible();
    await first.evaluate((element) => element.setAttribute("data-first", "yes"));
    await copyButton(page, "ar").click();
    await expect(toastPill(page, COPY.ar.copied)).not.toHaveAttribute("data-first", "yes");
    await expect(page.getByText(COPY.ar.copied)).toHaveCount(1);
  });

  test("a toast gives way to the next one: copied, then downloaded, one at a time", async ({ page }) => {
    await reach(page);
    await copyButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.copied)).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), downloadButton(page, "ar").click()]);
    expect(download.suggestedFilename()).toBe("qatra-recovery-code.txt");
    await expect(page.getByText(COPY.ar.downloaded)).toBeVisible();
    await expect(page.getByText(COPY.ar.copied)).toHaveCount(0);
  });

  test("when the clipboard refuses, a notice appears below the buttons, the text is selected, focus stays on Copy and no toast is shown", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
    });
    await reach(page);
    await copyButton(page, "ar").click();
    const notice = page.getByText(COPY.ar.copyUnavailable, { exact: true });
    await expect(notice).toBeVisible();
    await expect(notice.locator("xpath=ancestor::*[@role='status'][1]")).toHaveAttribute("aria-live", "polite");
    expect((await box(notice)).y).toBeGreaterThan((await box(copyButton(page, "ar"))).y);
    expect((await box(notice)).y).toBeLessThan((await box(confirmRow(page, "ar"))).y);
    expect(await page.evaluate(() => window.getSelection()?.toString().replace(/\s/g, ""))).toBe(MOCK_RECOVERY_CODE);
    await expect(copyButton(page, "ar")).toBeFocused();
    await expect(page.getByText(COPY.ar.copied)).toHaveCount(0);
  });

  test("a copy by hand after a press on the block puts the plain code with its dashes on the clipboard, with no line break", async ({ page }) => {
    await reach(page);
    await block(page, "ar").click();
    await page.keyboard.press("ControlOrMeta+C");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MOCK_RECOVERY_CODE);
  });

  test("a copy by hand of the text that was selected when the clipboard refused the button gives the plain code too", async ({ page }) => {
    // Only the button's call is refused: the browser's own copy command and the reading of the clipboard still work.
    await page.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    });
    await reach(page);
    await copyButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.copyUnavailable)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+C");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MOCK_RECOVERY_CODE);
  });

  test("where there is no clipboard at all the same notice shows, in English too", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    });
    await reach(page, { language: "en" });
    await copyButton(page, "en").click();
    await expect(page.getByText(COPY.en.copyUnavailable, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString().replace(/\s/g, ""))).toBe(MOCK_RECOVERY_CODE);
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: Download saves qatra-recovery-code.txt, UTF-8, three lines in the language of the page, with no username and no byte-order mark`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton(page, language).click()]);
      expect(download.suggestedFilename()).toBe("qatra-recovery-code.txt");
      const path = await download.path();
      const bytes = await readFile(path);
      expect(bytes[0]).not.toBe(0xef);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(text.split("\n")).toEqual([...copy.file]);
      expect(text).not.toContain("fresh_user_01");
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
      await expect(page.getByText(copy.downloaded, { exact: true })).toBeVisible();
      await expect(downloadButton(page, language)).toBeFocused();
    });
  }

  test("Continue with the box unchecked: the error shows at the box instead of a disabled button, focus goes to the box, and nothing is sent or left", async ({ page }) => {
    const requests: string[] = [];
    await reach(page);
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await continueButton(page, "ar").click();
    const error = page.getByText(COPY.ar.confirmRequired, { exact: true });
    await expect(error).toBeVisible();
    await expect(confirmBox(page, "ar")).toBeFocused();
    await expect(confirmBox(page, "ar")).toHaveAttribute("aria-invalid", "true");
    await expect(confirmBox(page, "ar")).toHaveAccessibleDescription(COPY.ar.confirmRequired);
    await expect(page).toHaveURL(/\/recovery-code$/);
    await expect(dialog(page)).toHaveCount(0);
    await expect(continueButton(page, "ar")).toBeEnabled();
    expect(requests.filter((path) => path.startsWith("/api"))).toEqual([]);
    expect(await style(error, ["color"])).toEqual({ color: "rgb(168, 50, 45)" });
    // The error recipe: the 2 px error border on the drawn box.
    expect(await style(confirmRow(page, "ar").locator("span").first(), ["border-top-color", "border-top-width"])).toEqual({ "border-top-color": "rgb(192, 54, 44)", "border-top-width": "2px" });
  });

  test("the error goes when the box is checked, and comes back if Continue is pressed after unchecking", async ({ page }) => {
    await reach(page);
    await continueButton(page, "ar").click();
    await confirmBox(page, "ar").check();
    await expect(page.getByText(COPY.ar.confirmRequired)).toHaveCount(0);
    await confirmBox(page, "ar").uncheck();
    await expect(page.getByText(COPY.ar.confirmRequired)).toHaveCount(0);
    await continueButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.confirmRequired)).toBeVisible();
  });

  test("Continue with the box checked goes to the start screen without a banner, and back from there goes to the page before, never to the code", async ({ page }) => {
    await reach(page);
    await confirmBox(page, "ar").check();
    await continueButton(page, "ar").click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.startHeading })).toBeFocused();
    await expect(page.getByText(COPY.ar.unavailable)).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("0123");
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("body")).not.toContainText("0123");
    await page.goForward();
    await expect(page).toHaveURL(/\/start$/);
  });

  test("by keyboard: Space on the box, then Enter on Continue", async ({ page }) => {
    await reach(page);
    await confirmBox(page, "ar").focus();
    await page.keyboard.press("Space");
    await expect(confirmBox(page, "ar")).toBeChecked();
    await continueButton(page, "ar").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/start$/);
  });
});

test.describe("leaving without confirming (section 3, the leave dialog)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: Back opens an alert dialog, titled and described, with Stay focused; Escape closes it and focus returns to where it was`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      await copyButton(page, language).focus();
      await page.goBack();
      const modal = dialog(page);
      await expect(modal).toBeVisible();
      await expect(modal).toHaveAccessibleName(copy.leaveTitle);
      await expect(modal).toHaveAccessibleDescription(copy.leaveBody);
      await expect(modal.getByRole("button")).toHaveText([copy.stay, copy.leave]);
      await expect(modal.getByRole("button", { name: copy.stay })).toBeFocused();
      await expect(page).toHaveURL(/\/recovery-code$/);
      await expect(block(page, language)).toHaveText(MOCK_RECOVERY_CODE);
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden();
      await expect(copyButton(page, language)).toBeFocused();
      await expect(page).toHaveURL(/\/recovery-code$/);
      await expect(block(page, language)).toHaveText(MOCK_RECOVERY_CODE);
    });
  }

  test("Stay closes it, the screen is as it was, and the next Back asks again", async ({ page }) => {
    await reach(page);
    await confirmBox(page, "ar").focus();
    await page.goBack();
    await dialog(page).getByRole("button", { name: COPY.ar.stay }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(confirmBox(page, "ar")).toBeFocused();
    await expect(confirmBox(page, "ar")).not.toBeChecked();
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await expect(page).toHaveURL(/\/recovery-code$/);
  });

  test("a press on the backdrop is the safe action: it closes the dialog and leaves nothing behind", async ({ page }) => {
    await reach(page);
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/recovery-code$/);
    await expect(block(page, "ar")).toHaveText(MOCK_RECOVERY_CODE);
  });

  test("Leave without saving goes to the start screen with the Info banner, the code is gone, and back goes to the page before the registration", async ({ page }) => {
    await reach(page);
    await page.goBack();
    await dialog(page).getByRole("button", { name: COPY.ar.leave }).click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.startHeading })).toBeFocused();
    const banner = page.getByText(COPY.ar.unavailable, { exact: true });
    await expect(banner).toBeVisible();
    const box1 = banner.locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
    expect(await style(box1, ["background-color", "border-top-color", "color"])).toEqual({ "background-color": "rgb(230, 244, 253)", "border-top-color": "rgb(29, 120, 181)", color: "rgb(23, 79, 118)" });
    await expect(box1).not.toHaveAttribute("role");
    await expect(page.locator("body")).not.toContainText("0123");
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("Leave without saving in English, after a Stay: the banner is in English and the history is still clean", async ({ page }) => {
    await reach(page, { language: "en" });
    await page.goBack();
    await dialog(page).getByRole("button", { name: COPY.en.stay }).click();
    await page.goBack();
    await dialog(page).getByRole("button", { name: COPY.en.leave }).click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByText(COPY.en.unavailable, { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the banner on the start screen can be dismissed, which puts focus on the heading, and a reload does not bring it back", async ({ page }) => {
    await reach(page);
    await page.goBack();
    await dialog(page).getByRole("button", { name: COPY.ar.leave }).click();
    await expect(page.getByText(COPY.ar.unavailable)).toBeVisible();
    await page.getByRole("button", { name: COPY.ar.dismiss }).click();
    await expect(page.getByText(COPY.ar.unavailable)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.startHeading })).toBeFocused();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.startHeading })).toBeVisible();
    await expect(page.getByText(COPY.ar.unavailable)).toHaveCount(0);
  });

  test("with the box checked, Back goes straight on to the page before: no dialog", async ({ page }) => {
    await reach(page);
    await confirmBox(page, "ar").check();
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("with the box unchecked again, Back asks again", async ({ page }) => {
    await reach(page);
    await confirmBox(page, "ar").check();
    await confirmBox(page, "ar").uncheck();
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    await expect(page).toHaveURL(/\/recovery-code$/);
  });

  test("Tab stays inside the dialog and the page behind it cannot be reached; Shift+Tab goes the other way round", async ({ page }) => {
    await reach(page);
    await page.goBack();
    const modal = dialog(page);
    await expect(modal.getByRole("button", { name: COPY.ar.stay })).toBeFocused();
    const inside = async () => page.evaluate(() => Boolean(document.activeElement?.closest("dialog")));
    const names: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${index}`).toBe(true);
      names.push(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim()));
    }
    expect(names).toEqual([COPY.ar.leave, COPY.ar.stay, COPY.ar.leave, COPY.ar.stay, COPY.ar.leave, COPY.ar.stay]);
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${index}`).toBe(true);
    }
    await expect(copyButton(page, "ar")).not.toBeFocused();
  });

  test("the page behind the dialog does not scroll, and a press on it lands on the backdrop, which is the safe action", async ({ page }) => {
    await reach(page, { viewport: { width: 320, height: 420 } });
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
    // The copy button is behind the backdrop: the press closes the dialog and does not copy.
    const behind = await box(copyButton(page, "ar"));
    await page.mouse.click(behind.x + behind.width / 2, Math.min(behind.y + behind.height / 2, 60));
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText(COPY.ar.copied)).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
  });

  test("on a phone the dialog is a sheet docked to the bottom edge, full width, rounded at the top only, with the buttons stacked, the primary first", async ({ page }) => {
    await reach(page, { viewport: VIEWPORTS.phone });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goBack();
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    const rect = await box(modal);
    expect(Math.round(rect.x)).toBe(0);
    expect(Math.round(rect.width)).toBe(VIEWPORTS.phone.width);
    expect(Math.round(rect.y + rect.height)).toBe(VIEWPORTS.phone.height);
    expect(await style(modal, ["border-top-left-radius", "border-bottom-left-radius", "background-color", "padding-top"])).toEqual({ "border-top-left-radius": "12px", "border-bottom-left-radius": "0px", "background-color": "rgb(255, 255, 255)", "padding-top": "0px" });
    const stay = await box(modal.getByRole("button", { name: COPY.ar.stay }));
    const leave = await box(modal.getByRole("button", { name: COPY.ar.leave }));
    expect(stay.y).toBeLessThan(leave.y);
    expect(Math.round(stay.width)).toBe(Math.round(leave.width));
    expect(Math.round(stay.height)).toBe(48);
    expect(Math.round(leave.y - (stay.y + stay.height))).toBe(8);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("dialog") as HTMLElement, "::backdrop").backgroundColor)).toBe("rgba(24, 59, 82, 0.5)");
    expect((await style(modal.getByRole("heading", { level: 2 }), ["font-size", "font-weight"]))["font-size"]).toBe("18px");
  });

  test("from 768 px it is a centred dialog of 400 px, rounded all round, with the buttons in a row and the primary at the start edge", async ({ page }) => {
    await reach(page, { viewport: VIEWPORTS.desktop });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goBack();
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    const rect = await box(modal);
    expect(Math.round(rect.width)).toBe(400);
    expect(Math.round(rect.x)).toBe((VIEWPORTS.desktop.width - 400) / 2);
    expect(Math.abs(rect.y + rect.height / 2 - VIEWPORTS.desktop.height / 2)).toBeLessThan(2);
    expect(await style(modal, ["border-top-left-radius", "border-bottom-left-radius"])).toEqual({ "border-top-left-radius": "12px", "border-bottom-left-radius": "12px" });
    const stay = await box(modal.getByRole("button", { name: COPY.ar.stay }));
    const leave = await box(modal.getByRole("button", { name: COPY.ar.leave }));
    expect(Math.round(stay.y)).toBe(Math.round(leave.y));
    // Arabic: the start edge is the right, so Stay sits to the right of Leave.
    expect(stay.x).toBeGreaterThan(leave.x);
    expect(Math.round(stay.x - (leave.x + leave.width))).toBe(8);
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: with the text enlarged to 200 % on a 320 px screen the dialog scrolls from the top: the title is in view, and so is the focused button`, async ({ page }) => {
      await reach(page, { language, viewport: { width: 320, height: 568 } });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goBack();
      const modal = dialog(page);
      await expect(modal).toBeVisible();
      const { scrollWidth, clientWidth } = await page.evaluate(NO_OVERFLOW);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      const scroller = await modal.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop }));
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(scroller.scrollTop).toBe(0);
      const title = await box(modal.getByRole("heading", { level: 2 }));
      expect(title.y).toBeGreaterThanOrEqual(0);
      const stay = modal.getByRole("button", { name: COPY[language].stay });
      await expect(stay).toBeFocused();
      const focused = await box(stay);
      expect(focused.y).toBeGreaterThanOrEqual(0);
      expect(focused.y + focused.height).toBeLessThanOrEqual(568);
      // The other button is reached by Tab, which scrolls it into view as well.
      await page.keyboard.press("Tab");
      const leave = await box(modal.getByRole("button", { name: COPY[language].leave }));
      expect(leave.y + leave.height).toBeLessThanOrEqual(568);
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden();
    });
  }

  test("in English at 768 px the labels do not fit one row, so the second button drops to its own row without squeezing the labels", async ({ page }) => {
    await reach(page, { language: "en", viewport: { width: 768, height: 1024 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goBack();
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    const stay = await box(modal.getByRole("button", { name: COPY.en.stay }));
    const leave = await box(modal.getByRole("button", { name: COPY.en.leave }));
    expect(Math.round(stay.height)).toBe(48);
    expect(Math.round(leave.height)).toBe(48);
    expect(stay.x).toBeGreaterThanOrEqual((await box(modal)).x);
    expect(stay.x + stay.width).toBeLessThanOrEqual((await box(modal)).x + (await box(modal)).width);
  });

  test("the sheet slides up over 320 ms on a phone and the toast slides in over 200 ms, and under reduced motion neither moves", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL ?? "").origin });
    await reach(page, { viewport: VIEWPORTS.phone });
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    expect(await style(dialog(page), ["transition-property", "transition-duration"])).toEqual({ "transition-property": "translate", "transition-duration": "0.32s" });
    await page.keyboard.press("Escape");
    await copyButton(page, "ar").click();
    const pill = toastPill(page, COPY.ar.copied);
    await expect(pill).toBeVisible();
    const normal = await style(pill, ["transition-property", "transition-duration"]);
    expect(normal["transition-duration"]).toBe("0.2s");
    expect(normal["transition-property"]).toContain("translate");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Escape");
    await copyButton(page, "ar").click();
    const still = toastPill(page, COPY.ar.copied);
    await expect(still).toBeVisible();
    const reduced = await style(still, ["translate", "transition-duration"]);
    expect(reduced.translate).toBe("none");
    expect(Number.parseFloat(reduced["transition-duration"] ?? "1")).toBeLessThan(0.001);
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
    expect(await dialog(page).evaluate((element) => getComputedStyle(element).translate)).toBe("none");
  });
});

test.describe("the browser's own prompt on closing or reloading (section 3)", () => {
  // Closing with the beforeunload handlers does not wait for the page: the prompt, if there is one, arrives as an event. A page whose
  // prompt was declined is not closed again in the same test, because the browser keeps that attempt open.
  test("with the box unchecked a close asks the browser's prompt, and the page stays open when it is declined", async ({ page }) => {
    const prompts: string[] = [];
    page.on("dialog", async (prompt) => {
      prompts.push(prompt.type());
      await prompt.dismiss();
    });
    await reach(page);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => prompts).toEqual(["beforeunload"]);
    expect(page.isClosed()).toBe(false);
    await expect(block(page, "ar")).toHaveText(MOCK_RECOVERY_CODE);
  });

  test("with the box checked a close goes through without a prompt", async ({ page }) => {
    const prompts: string[] = [];
    page.on("dialog", async (prompt) => {
      prompts.push(prompt.type());
      await prompt.dismiss();
    });
    await reach(page);
    await confirmBox(page, "ar").check();
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(prompts).toEqual([]);
  });

  test("the event is cancelled only while the box is unchecked", async ({ page }) => {
    await reach(page);
    const cancelled = () => page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(await cancelled()).toBe(true);
    await confirmBox(page, "ar").check();
    expect(await cancelled()).toBe(false);
    await confirmBox(page, "ar").uncheck();
    expect(await cancelled()).toBe(true);
  });
});

test.describe("guard 9: the code is gone (section 4)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: a visitor who opens the address, or reloads, goes to the login screen with the Info banner that says to log in first`, async ({ page }) => {
      await openWithoutCode(page, { language });
      const requests: string[] = [];
      page.on("request", (request) => requests.push(new URL(request.url()).pathname));
      await page.goto("/recovery-code");
      await expect(page).toHaveURL(/\/login$/);
      const copy = COPY[language];
      await expect(page.getByRole("heading", { level: 1, name: copy.loginHeading })).toBeFocused();
      const banner = page.getByText(copy.unavailableRecovery, { exact: true });
      await expect(banner).toBeVisible();
      const boxed = banner.locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
      await expect(boxed).not.toHaveAttribute("role");
      await expect(boxed.getByRole("button", { name: copy.dismiss })).toBeVisible();
      expect(requests).toContain("/api/me");
      expect(requests).not.toContain("/api/today");
      expect(await axeViolations(page)).toEqual([]);
      // Shown once.
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: copy.loginHeading })).toBeVisible();
      await expect(page.getByText(copy.unavailableRecovery)).toHaveCount(0);
    });
  }

  test("the address is replaced, not added: Back from the login screen goes to the page before the address", async ({ page }) => {
    await openWithoutCode(page);
    await page.goto("/register");
    await page.goto("/recovery-code");
    await expect(page).toHaveURL(/\/login$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/register$/);
  });

  test("a learner without a plan goes to the start screen with the default banner", async ({ page }) => {
    await openWithoutCode(page);
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockProfile) }));
    await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTodayWithoutPlan) }));
    await page.goto("/recovery-code");
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.startHeading })).toBeFocused();
    await expect(page.getByText(COPY.ar.unavailable, { exact: true })).toBeVisible();
    await expect(page.getByText(COPY.ar.unavailableRecovery)).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("a learner without a plan, in English", async ({ page }) => {
    await openWithoutCode(page, { language: "en" });
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockProfile) }));
    await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTodayWithoutPlan) }));
    await page.goto("/recovery-code");
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByText(COPY.en.unavailable, { exact: true })).toBeVisible();
  });

  test("a learner with a plan goes to /today", async ({ page }) => {
    await openWithoutCode(page);
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockProfile) }));
    await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockToday) }));
    await page.goto("/recovery-code");
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.todayHeading })).toBeVisible();
  });

  test("while it finds out where the learner belongs the screen shows only its frame: the header, no heading, no code, no control", async ({ page }) => {
    await openWithoutCode(page);
    let release: () => void = () => undefined;
    await page.route("**/api/me", async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthenticated", message: "Authentication is required.", details: {} } }) });
    });
    await page.goto("/recovery-code");
    await expect(page.getByRole("banner")).toHaveText(COPY.ar.appName);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(page.getByRole("group")).toHaveCount(0);
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    expect(await page.title()).toBe(COPY.ar.title);
    release();
    await expect(page).toHaveURL(/\/login$/);
  });

  test.describe("with a server that is asleep", () => {
    // The browser logs each failed request on its own; the page itself logs nothing.
    test.use({ allowFailedRequests: true });

    test("a sleeping server does not strand anyone: the visitor path is taken, and the login screen asks again", async ({ page }) => {
      await openWithoutCode(page);
      await page.route("**/api/me", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" }));
      await page.goto("/recovery-code");
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByText(COPY.ar.unavailableRecovery, { exact: true })).toBeVisible();
    });
  });

  test("a reload on the screen with the code loses it: the page loads anew and meets guard 9", async ({ page }) => {
    page.on("dialog", (prompt) => void prompt.accept());
    await reach(page);
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(COPY.ar.unavailableRecovery, { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("0123");
  });
});

test.describe("the code is nowhere but on the screen (UA-06)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL ?? "").origin });
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: not in the address, the history state, the storage, the cookies, the title, a live region, a request or a log, whatever the learner does`, async ({ page }) => {
      const logs: string[] = [];
      const requested: string[] = [];
      page.on("console", (message) => logs.push(message.text()));
      page.on("request", (request) => requested.push(request.url() + (request.postData() ?? "")));
      await reach(page, { language });
      const copy = COPY[language];
      const leaks = async (label: string) => {
        const state = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          history: JSON.stringify(history.state),
          local: JSON.stringify({ ...localStorage }),
          session: JSON.stringify({ ...sessionStorage }),
          cookie: document.cookie,
          live: Array.from(document.querySelectorAll("[aria-live], [role=status], [role=alert]")).map((element) => element.textContent ?? ""),
          // Every attribute of the page except the build's own file names, which are hashes.
          attributes: Array.from(document.querySelectorAll("*")).flatMap((element) =>
            Array.from(element.attributes)
              .filter((attribute) => !["src", "href", "srcset", "integrity", "nonce"].includes(attribute.name))
              .map((attribute) => attribute.value),
          ),
          files: Array.from(document.querySelectorAll("[src], [href]")).map((element) => element.getAttribute("src") ?? element.getAttribute("href") ?? ""),
        }));
        for (const [name, value] of Object.entries({ url: state.url, title: state.title, history: state.history, local: state.local, session: state.session, cookie: state.cookie, live: state.live.join(" "), attributes: state.attributes.join(" ") })) {
          expect(value, `${label}: ${name}`).not.toMatch(SHORT_PIECES);
        }
        expect(state.files.join(" "), `${label}: file addresses`).not.toMatch(WHOLE_CODE);
      };
      await leaks("arrival");
      await copyButton(page, language).click();
      await expect(page.getByText(copy.copied)).toBeVisible();
      await leaks("copied");
      const [download] = await Promise.all([page.waitForEvent("download"), downloadButton(page, language).click()]);
      void download;
      await leaks("downloaded");
      await continueButton(page, language).click();
      await leaks("unconfirmed");
      await page.goBack();
      await expect(dialog(page)).toBeVisible();
      await leaks("dialog");
      expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["qatra.language"]);
      expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expect(logs.join("\n")).not.toMatch(SHORT_PIECES);
      // The code travels nowhere: no request carries it, in the address or the body (the download is made in the browser).
      expect(requested.join("\n")).not.toMatch(WHOLE_CODE);
      const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
      expect(resources.join("\n")).not.toMatch(WHOLE_CODE);
    });
  }

  test("the screen calls no API after it has arrived: only the page's own first request of the load is made", async ({ page }) => {
    await reach(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await copyButton(page, "ar").click();
    await continueButton(page, "ar").click();
    await confirmBox(page, "ar").check();
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    expect(requests.filter((path) => path.startsWith("/api") && path !== "/api/health" && path !== "/api/me")).toEqual([]);
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: no dash character appears on the screen, the error, the toast, the dialog or the banner`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      const text = async () => page.evaluate(() => document.body.innerText + " " + document.title);
      let seen = await text();
      await continueButton(page, language).click();
      seen += await text();
      await copyButton(page, language).click();
      seen += await text();
      await page.goBack();
      seen += await text();
      await dialog(page).getByRole("button", { name: copy.leave }).click();
      await expect(page).toHaveURL(/\/start$/);
      seen += await text();
      expect(seen).not.toContain(EM_DASH);
      expect(seen).not.toContain(EN_DASH);
      expect(seen).not.toContain(ELLIPSIS);
    });
  }
});

test.describe("keyboard and focus (section 5)", () => {
  const STOPS = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";
  const stopName = (page: Page) =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLInputElement | HTMLElement;
      return (element as HTMLInputElement).labels?.[0]?.textContent ?? (element.textContent ?? "").trim();
    });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: the stops are the skip link, Copy, Download, the box and Continue, in that order, and the block is not one; Tab walks them and nothing traps`, async ({ page }) => {
      await reach(page, { language });
      const copy = COPY[language];
      // Focus starts on the heading after the arrival, so the order is read from the page and then walked from the skip link.
      // Only what is shown counts: the buttons of the closed dialog are not stops.
      const stops = await page.evaluate(
        (selector) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter((element) => element.checkVisibility())
            .map((element) => (element as HTMLInputElement).labels?.[0]?.textContent ?? (element.textContent ?? "").trim()),
        STOPS,
      );
      expect(stops).toEqual([copy.skip, copy.copy, copy.download, copy.confirm, copy.continue]);
      await page.getByRole("link", { name: copy.skip }).focus();
      const walked: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        await page.keyboard.press("Tab");
        walked.push(await stopName(page));
      }
      expect(walked).toEqual([copy.copy, copy.download, copy.confirm, copy.continue]);
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=group]")))).toBe(false);
      // One more Tab leaves the last button: focus is not trapped.
      await page.keyboard.press("Tab");
      await expect(continueButton(page, language)).not.toBeFocused();
      // And Shift+Tab walks back the same way.
      await page.keyboard.press("Shift+Tab");
      await expect(continueButton(page, language)).toBeFocused();
    });
  }

  test("every stop shows a 2 px focus ring in the focus colour: on the buttons, and around the whole box row", async ({ page }) => {
    await reach(page);
    await page.getByRole("link", { name: COPY.ar.skip }).focus();
    const rings: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press("Tab");
      rings.push(
        await page.evaluate(() => {
          const element = document.activeElement as HTMLElement;
          const host = element instanceof HTMLInputElement ? (element.closest("label") as HTMLElement) : element;
          const computed = getComputedStyle(host);
          return `${computed.outlineStyle} ${computed.outlineWidth} ${computed.outlineColor}`;
        }),
      );
    }
    expect(rings).toEqual(Array(4).fill("solid 2px rgb(23, 79, 118)"));
  });

  test("Space toggles the box, Enter presses the buttons, and the Enter on Copy copies", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL ?? "").origin });
    await reach(page);
    await confirmBox(page, "ar").focus();
    await page.keyboard.press("Space");
    await expect(confirmBox(page, "ar")).toBeChecked();
    await page.keyboard.press("Space");
    await expect(confirmBox(page, "ar")).not.toBeChecked();
    await copyButton(page, "ar").focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MOCK_RECOVERY_CODE);
    await page.keyboard.press("Escape");
    await downloadButton(page, "ar").focus();
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
    expect(download.suggestedFilename()).toBe("qatra-recovery-code.txt");
  });

  test("the heading takes focus on arrival by navigation, and a first load of the screen does not steal it", async ({ page }) => {
    await reach(page);
    await expect(heading(page, "ar")).toBeFocused();
    await confirmBox(page, "ar").check();
    await continueButton(page, "ar").click();
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.startHeading })).toBeFocused();
  });

  test("the skip link goes to the main region and asks nothing: no dialog, and the Back after the jump back asks once", async ({ page }) => {
    await reach(page);
    await page.getByRole("link", { name: COPY.ar.skip }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/recovery-code#main$/);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("main")).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/recovery-code$/);
    await expect(dialog(page)).toHaveCount(0);
    await page.goBack();
    await expect(dialog(page)).toBeVisible();
  });
});

test.describe("axe-core: no violation (NFR-09)", () => {
  const cases = [
    { language: "ar", viewport: VIEWPORTS.phone },
    { language: "ar", viewport: VIEWPORTS.desktop },
    { language: "en", viewport: VIEWPORTS.phone },
    { language: "en", viewport: VIEWPORTS.desktop },
  ] as const;

  test.beforeEach(async ({ page }) => {
    // The dialog opens at once and the sheet would be caught mid-slide.
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const { language, viewport } of cases) {
    test(`${language} at ${viewport.width} px: the default state, the error, the toast, the notice and the dialog`, async ({ page, context, baseURL }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL ?? "").origin });
      await reach(page, { language, viewport });
      const copy = COPY[language];
      expect(await axeViolations(page), "default").toEqual([]);

      await continueButton(page, language).click();
      await expect(page.getByText(copy.confirmRequired)).toBeVisible();
      expect(await axeViolations(page), "error").toEqual([]);
      await confirmBox(page, language).check();
      await expect(page.getByText(copy.confirmRequired)).toHaveCount(0);

      await copyButton(page, language).click();
      await expect(page.getByText(copy.copied)).toBeVisible();
      expect(await axeViolations(page), "toast").toEqual([]);
      await page.keyboard.press("Escape");

      await confirmBox(page, language).uncheck();
      await page.goBack();
      await expect(dialog(page)).toBeVisible();
      expect(await axeViolations(page), "dialog").toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
    });

    test(`${language} at ${viewport.width} px: the notice when the clipboard refuses`, async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
      });
      await reach(page, { language, viewport });
      await copyButton(page, language).click();
      await expect(page.getByText(COPY[language].copyUnavailable)).toBeVisible();
      expect(await axeViolations(page), "notice").toEqual([]);
    });

    test(`${language} at ${viewport.width} px: the start screen with the banner of S-04`, async ({ page }) => {
      await reach(page, { language, viewport });
      await page.goBack();
      await dialog(page).getByRole("button", { name: COPY[language].leave }).click();
      await expect(page.getByText(COPY[language].unavailable)).toBeVisible();
      expect(await axeViolations(page), "start").toEqual([]);
    });
  }
});

test.describe("left to right in a right-to-left page, and the glyphs", () => {
  test("in Arabic the page is right to left, the text starts at the right edge, and the block keeps its groups left to right", async ({ page }) => {
    await reach(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const column = await box(block(page, "ar"));
    const lead = await box(page.getByText(COPY.ar.lead, { exact: true }));
    // The lead is right-aligned within the column; the first group of the code is at the left of the block.
    expect(Math.round(lead.x + lead.width)).toBeLessThanOrEqual(Math.round(column.x + column.width));
    const first = await box(groups(page, "ar").first());
    expect(Math.round(first.x)).toBe(Math.round(column.x + 17));
    expect(await style(block(page, "ar"), ["text-align", "direction", "unicode-bidi"])).toMatchObject({ direction: "ltr" });
  });

  test("in English the page is left to right and the block is where it is in Arabic", async ({ page }) => {
    await reach(page, { language: "en" });
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    const column = await box(block(page, "en"));
    const first = await box(groups(page, "en").first());
    expect(Math.round(first.x)).toBe(Math.round(column.x + 17));
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: the glyphs of Copy and Download are not mirrored, and sit at the start edge of their buttons`, async ({ page }) => {
      await reach(page, { language });
      for (const button of [copyButton(page, language), downloadButton(page, language)]) {
        const glyph = button.locator("svg");
        expect(await glyph.evaluate((svg) => getComputedStyle(svg).transform)).toBe("none");
        const frame = await box(button);
        const icon = await box(glyph);
        if (language === "ar") expect(icon.x + icon.width).toBeGreaterThan(frame.x + frame.width / 2);
        else expect(icon.x).toBeLessThan(frame.x + frame.width / 2);
        expect(Math.round(icon.width)).toBe(20);
      }
    });
  }
});
