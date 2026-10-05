import type { Locator, Page } from "@playwright/test";
import { mockProfile } from "../../src/lib/api/mock";
import { axeViolations, controlHealth, expect, smallTargets, termsChunk, test, VIEWPORTS, waitForFirstHealthRequest, WAKE_LINE, type HealthMode } from "./fixtures";

// S-03 (UI-screens Batch 1) in a real browser, against a production build in live mode. Every API answer is route-intercepted;
// the stub backend only answers E01 and, as a visitor, E11. The page itself calls no API.

type Language = "ar" | "en";

const COPY = {
  ar: {
    title: "شروط الاستخدام وبيان الخصوصية",
    version: "إصدار الشروط: 2026-10-04",
    termsHeading: "شروط الاستخدام",
    privacyHeading: "بيان الخصوصية",
    topics: ["الكتاب كما هو", "صحة المراجع", "لا فتوى ولا شرح", "البيانات التي نجمعها", "بيانات الحساب والنموذج الخارجي", "الحذف والاحتفاظ", "ما لا نستنتجه عنك"],
    backHome: "رجوع إلى الصفحة الرئيسية",
    backRegister: "رجوع إلى إنشاء الحساب",
    returnHome: "العودة إلى الصفحة الرئيسية",
    returnRegister: "العودة إلى إنشاء الحساب",
    notice: "تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.",
    transparency: "تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك",
    conversation: "عند بناء خطتك أو تعديلها في المحادثة يُرسل نص هدفك",
    unavailable: "تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.",
    retry: "إعادة المحاولة",
    loading: "جارٍ التحميل",
    languageChanged: "تم تغيير اللغة إلى العربية",
    registerHeading: "إنشاء الحساب",
    username: "اسم المستخدم",
    password: "كلمة المرور",
    confirmation: "تأكيد كلمة المرور",
    consent: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
    registerLinks: { all: "شروط الاستخدام وبيان الخصوصية", terms: "شروط الاستخدام", privacy: "بيان الخصوصية" },
  },
  en: {
    title: "Terms of use and privacy statement",
    version: "Terms version: 2026-10-04",
    termsHeading: "Terms of use",
    privacyHeading: "Privacy statement",
    topics: ["The book as it is", "Accuracy of references", "No fatwa or explanation", "Data we collect", "Account data and external models", "Deletion and retention", "What we do not infer"],
    backHome: "Back to Home",
    backRegister: "Back to Create account",
    returnHome: "Back to home",
    returnRegister: "Back to create account",
    notice: "Note: this text was transcribed verbatim from the book, and the hadith's authenticity has not been verified.",
    transparency: "Your plan is built and revised in a conversation with an AI assistant",
    conversation: "When you build or revise your plan in the conversation",
    unavailable: "The terms of use and privacy statement could not be opened. Check your connection and try again.",
    retry: "Try again",
    loading: "Loading",
    languageChanged: "Language changed to English",
    registerHeading: "Create an account",
    username: "Username",
    password: "Password",
    confirmation: "Confirm password",
    consent: "I have read the terms of use and privacy statement and I agree to them.",
    registerLinks: { all: "Terms of use and privacy statement", terms: "Terms of use", privacy: "Privacy statement" },
  },
} as const;

const INK = "rgb(24, 59, 82)";
const INK_SECONDARY = "rgb(83, 110, 130)";
const DIVIDER = "rgb(215, 230, 240)";
// The app bar is 56 px and the page keeps an anchor 8 px clear of it (html scroll-padding, and the heading's own margin from 1024 px).
const ANCHOR_TOP = 64;

// Opens /terms once React has hydrated (the first health request is the sign), with E01 and the session probe under control.
async function openTerms(page: Page, { language = "ar", viewport = VIEWPORTS.phone, hash = "", mode = "ok" }: { language?: Language; viewport?: { width: number; height: number }; hash?: string; mode?: HealthMode } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, mode);
  await page.goto(`/terms${hash}`);
  await waitForFirstHealthRequest(health);
  return health;
}

// Opens /register, the screen that opens S-03, once React has hydrated.
async function openRegister(page: Page, language: Language = "ar", viewport: { width: number; height: number } = VIEWPORTS.phone) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, "ok");
  await page.goto("/register");
  await waitForFirstHealthRequest(health);
  await expect(page.getByRole("heading", { level: 1, name: COPY[language].registerHeading })).toBeVisible();
  return health;
}

const heading = (page: Page, level: number, name: string) => page.getByRole("heading", { level, name, exact: true });
const registerLink = (page: Page, language: Language, which: keyof (typeof COPY)["ar"]["registerLinks"]) => page.getByRole("link", { name: COPY[language].registerLinks[which], exact: true });
const usernameField = (page: Page, language: Language) => page.getByRole("textbox", { name: COPY[language].username });
const passwordField = (page: Page, language: Language) => page.getByLabel(COPY[language].password, { exact: true });
const confirmationField = (page: Page, language: Language) => page.getByLabel(COPY[language].confirmation, { exact: true });
const consentBox = (page: Page, language: Language) => page.getByRole("checkbox", { name: COPY[language].consent });

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("no bounding box");
  return result;
}

const style = (locator: Locator, properties: string[]) => locator.evaluate((element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])), properties);

interface Block {
  tag: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  text: string;
}

// Every block of the page text in document order, in page coordinates.
function blocks(page: Page): Promise<Block[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("main h1, main h2, main h3, main p, main ul, main hr, main button")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName.toLowerCase(), top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, left: rect.left, right: rect.right, text: (element.textContent ?? "").slice(0, 24) };
    }),
  );
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// A visitor's click on a segment of the switch. Playwright's own click first scrolls the control into view, and for a control in a sticky
// bar that moves the page; a real press does not, so the press is made at the control's place.
async function pressSegment(page: Page, name: string) {
  const radio = await box(page.getByRole("radio", { name }));
  await page.mouse.click(radio.x + radio.width / 2, radio.y + radio.height / 2);
}

test.describe("layout and design (UI-screens S-03 sections 2, 5 and 6)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: the heading, the version line, the terms part, the divider, the privacy part and the closing button, top to bottom, in one column`, async ({ page }) => {
      await openTerms(page, { language });
      const copy = COPY[language];
      await expect(heading(page, 1, copy.title)).toBeVisible();
      const order = [
        heading(page, 1, copy.title),
        page.getByText(copy.version),
        heading(page, 2, copy.termsHeading),
        heading(page, 3, copy.topics[0] as string),
        heading(page, 3, copy.topics[2] as string),
        page.locator("main hr"),
        heading(page, 2, copy.privacyHeading),
        heading(page, 3, copy.topics[3] as string),
        heading(page, 3, copy.topics[6] as string),
        page.getByRole("button", { name: copy.returnHome, exact: true }),
      ];
      const ys = await Promise.all(order.map(async (item) => (await box(item)).y));
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
      // One column: every text block starts and ends at the same two edges.
      const text = (await blocks(page)).filter((block) => block.tag !== "button");
      expect(new Set(text.map((block) => Math.round(block.left))).size).toBe(1);
      expect(new Set(text.map((block) => Math.round(block.right))).size).toBe(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
      await expect(page.getByRole("heading", { level: 3 })).toHaveCount(7);
      await expect(page.getByRole("heading", { level: 3 })).toHaveText([...copy.topics]);
      await expect(page.getByRole("list")).toHaveCount(1);
      await expect(page.getByRole("listitem")).toHaveCount(9);
    });

    test(`${language}: 24 px between topics, 16 px between paragraphs, 8 px between list items, and the gaps around headings, the divider and the button`, async ({ page }) => {
      await openTerms(page, { language });
      await expect(heading(page, 1, COPY[language].title)).toBeVisible();
      // A heading sits 8 px above its first block, a topic 24 px below the one before, the title 8 px above the version line,
      // the version line 24 px above the first part heading, a part heading 16 px above its first topic, the divider has 32 px each side.
      const GAPS: Record<string, number> = {
        "h1>p": 8,
        "p>h2": 24,
        "h2>h3": 16,
        "h3>p": 8,
        "h3>ul": 8,
        "p>p": 16,
        "p>ul": 16,
        "p>h3": 24,
        "ul>h3": 24,
        "p>hr": 32,
        "hr>h2": 32,
        "p>button": 32,
      };
      const all = await blocks(page);
      const wrong: string[] = [];
      for (let index = 1; index < all.length; index += 1) {
        const [before, after] = [all[index - 1] as Block, all[index] as Block];
        const key = `${before.tag}>${after.tag}`;
        const gap = Math.round(after.top - before.bottom);
        if (GAPS[key] !== gap) wrong.push(`${key} ${gap} px (expected ${GAPS[key] ?? "a known pair"}): "${before.text}" then "${after.text}"`);
      }
      expect(wrong).toEqual([]);
      const items = await page.evaluate(() => [...document.querySelectorAll("main li")].map((item) => ({ top: item.getBoundingClientRect().top, bottom: item.getBoundingClientRect().bottom })));
      expect(items).toHaveLength(9);
      for (let index = 1; index < items.length; index += 1) expect(Math.round((items[index] as { top: number }).top - (items[index - 1] as { bottom: number }).bottom), `item ${index}`).toBe(8);
    });

    test(`${language}: type and colour follow the tokens: title 22 px bold, part headings 18 px semibold, topics 16 px semibold, text 16 px, version 14 px secondary, a 1 px divider`, async ({ page }) => {
      await openTerms(page, { language });
      const copy = COPY[language];
      expect(await style(heading(page, 1, copy.title), ["font-size", "font-weight", "color"])).toEqual({ "font-size": "22px", "font-weight": "700", color: INK });
      for (const name of [copy.termsHeading, copy.privacyHeading]) expect(await style(heading(page, 2, name), ["font-size", "font-weight", "color"]), name).toEqual({ "font-size": "18px", "font-weight": "600", color: INK });
      for (const name of copy.topics) expect(await style(heading(page, 3, name), ["font-size", "font-weight", "color"]), name).toEqual({ "font-size": "16px", "font-weight": "600", color: INK });
      const paragraph = page.getByText(copy.conversation);
      expect(await style(paragraph, ["font-size", "font-weight", "color", "line-height"])).toEqual({ "font-size": "16px", "font-weight": "400", color: INK, "line-height": language === "ar" ? "27.2px" : "24px" });
      expect(await style(page.getByText(copy.version), ["font-size", "color"])).toEqual({ "font-size": "14px", color: INK_SECONDARY });
      expect(await style(page.locator("main hr"), ["border-top-width", "border-top-color"])).toEqual({ "border-top-width": "1px", "border-top-color": DIVIDER });
      await expect(page.locator("main hr")).toHaveAttribute("aria-hidden", "true");
      // Page background and the button of the secondary recipe.
      expect(await style(page.locator("html"), ["background-color"])).toEqual({ "background-color": "rgb(245, 250, 254)" });
      expect(await style(page.getByRole("button", { name: copy.returnHome, exact: true }), ["background-color", "color", "border-top-width", "font-weight"])).toEqual({
        "background-color": "rgb(255, 255, 255)",
        color: "rgb(23, 79, 118)",
        "border-top-width": "1px",
        "font-weight": "600",
      });
    });

    test(`${language}: the lists are real lists with a marker at the start edge, and the markers are secondary text`, async ({ page }) => {
      await openTerms(page, { language });
      const list = page.getByRole("list");
      expect(await style(list, ["list-style-type", "padding-inline-start"])).toEqual({ "list-style-type": "disc", "padding-inline-start": "24px" });
      const marker = await list.getByRole("listitem").first().evaluate((item) => getComputedStyle(item, "::marker").color);
      expect(marker).toBe(INK_SECONDARY);
      // The marker is at the start edge: right in Arabic, left in English.
      const first = await box(list.getByRole("listitem").first());
      const listBox = await box(list);
      if (language === "ar") expect(Math.round(first.x + first.width)).toBe(Math.round(listBox.x + listBox.width - 24));
      else expect(Math.round(first.x)).toBe(Math.round(listBox.x + 24));
    });

    test(`${language}: only the fonts of the interface are used, never the fonts of the religious text`, async ({ page }) => {
      await openTerms(page, { language });
      const families = await page.evaluate(() => [...new Set([...document.querySelectorAll("main *")].map((element) => getComputedStyle(element).fontFamily))]);
      expect(families.length).toBeGreaterThan(0);
      for (const family of families) {
        expect(family).not.toMatch(/Amiri/i);
        expect(family).toMatch(language === "ar" ? /^Cairo/ : /^Inter/);
      }
    });

    test(`${language}: no horizontal scroll at 320, 360, 768 and 1280 px, and none at 200 % text on 320 px`, async ({ page }) => {
      await openTerms(page, { language });
      for (const width of [320, 360, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await horizontalOverflow(page), `${width} px`).toBeLessThanOrEqual(0);
      }
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      expect(await horizontalOverflow(page), "200 % text").toBeLessThanOrEqual(0);
    });

    test(`${language}: the text reflows under the text-spacing overrides of WCAG 1.4.12 without scrolling sideways or clipping`, async ({ page }) => {
      await openTerms(page, { language, viewport: VIEWPORTS.floor });
      await page.addStyleTag({ content: "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }" });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("main h1, main h2, main h3, main p, main li, main button")].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => (element.textContent ?? "").slice(0, 24)),
      );
      expect(clipped).toEqual([]);
    });
  }

  test("the column is the viewport minus the 24 px margins on a phone, then 640 px, centred, below 1024 px, and 720 px from 1024 px", async ({ page }) => {
    await openTerms(page);
    const title = (width: number) => page.setViewportSize({ width, height: 800 }).then(() => box(page.locator("main h1")));
    const phone = await title(360);
    expect([Math.round(phone.x), Math.round(phone.width)]).toEqual([24, 312]);
    const wide = await title(600);
    expect([Math.round(wide.x), Math.round(wide.width)]).toEqual([24, 552]);
    for (const [width, margin] of [
      [700, 30],
      [768, 64],
      [1023, 191.5],
    ] as const) {
      const column = await title(width);
      expect(Math.round(column.width), `${width} px`).toBe(640);
      expect(Math.round(column.x * 2) / 2, `${width} px`).toBe(margin);
    }
    for (const width of [1024, 1280, 1600]) {
      const column = await title(width);
      expect(Math.round(column.width), `${width} px`).toBe(720);
      expect(Math.round(column.x), `${width} px`).toBe(Math.round((width - 720) / 2));
    }
  });

  test("the closing button is 48 px high, the back control 44 by 44, and every target is reachable, in both languages", async ({ page }) => {
    for (const language of ["ar", "en"] as const) {
      await openTerms(page, { language });
      const button = await box(page.getByRole("button", { name: COPY[language].returnHome, exact: true }));
      expect(Math.round(button.height)).toBe(48);
      const back = await box(page.getByRole("link", { name: COPY[language].backHome, exact: true }));
      expect([Math.round(back.width), Math.round(back.height)]).toEqual([44, 44]);
      expect(await smallTargets(page)).toEqual([]);
    }
  });

  test("the header holds the back control at the start edge and the switch at the end edge, with no lockup, and the text holds nothing to press", async ({ page }) => {
    for (const language of ["ar", "en"] as const) {
      await openTerms(page, { language });
      const header = page.getByRole("banner");
      await expect(header.getByRole("link")).toHaveCount(1);
      await expect(header.getByRole("radio")).toHaveCount(2);
      const back = await box(page.getByRole("link", { name: COPY[language].backHome, exact: true }));
      const group = await box(header.getByRole("radiogroup"));
      if (language === "ar") {
        expect(back.x).toBeGreaterThan(VIEWPORTS.phone.width / 2);
        expect(group.x).toBeLessThan(VIEWPORTS.phone.width / 2);
      } else {
        expect(back.x).toBeLessThan(VIEWPORTS.phone.width / 2);
        expect(group.x).toBeGreaterThan(VIEWPORTS.phone.width / 2);
      }
      const main = page.locator("main");
      await expect(main.getByRole("link")).toHaveCount(0);
      await expect(main.getByRole("button")).toHaveCount(1);
      await expect(page.getByRole("checkbox")).toHaveCount(0);
      await expect(page.getByRole("textbox")).toHaveCount(0);
    }
  });

  test("the back arrow points the way back in each direction: mirrored in Arabic, not in English", async ({ page }) => {
    const arrows: Record<string, string> = {};
    for (const language of ["ar", "en"] as const) {
      await openTerms(page, { language });
      arrows[language] = await page.getByRole("link", { name: COPY[language].backHome, exact: true }).locator("svg").evaluate((svg) => getComputedStyle(svg).scale);
    }
    expect(arrows["ar"]).toBe("-1 1");
    expect(arrows["en"]).toBe("none");
  });

  test("shows the fixed sentences in quotation marks: the notice of the book and the transparency line of P-15, and the plan-conversation paragraph", async ({ page }) => {
    for (const language of ["ar", "en"] as const) {
      await openTerms(page, { language });
      const copy = COPY[language];
      await expect(page.getByText(copy.notice)).toBeVisible();
      await expect(page.getByText(copy.transparency)).toBeVisible();
      await expect(page.getByText(copy.conversation)).toBeVisible();
    }
  });

  test("the page title follows the language", async ({ page }) => {
    await openTerms(page, { language: "ar" });
    await expect(page).toHaveTitle("شروط الاستخدام وبيان الخصوصية · قطرة غيث");
    await openTerms(page, { language: "en" });
    await expect(page).toHaveTitle("Terms of use and privacy statement · Qatra");
  });
});

test.describe("anchors and focus (S-03 section 4, P-01)", () => {
  for (const viewport of [VIEWPORTS.phone, VIEWPORTS.desktop]) {
    for (const [hash, name, language] of [
      ["#terms", COPY.ar.termsHeading, "ar"],
      ["#privacy", COPY.ar.privacyHeading, "ar"],
      ["#privacy", COPY.en.privacyHeading, "en"],
    ] as const) {
      test(`${language} ${viewport.width} px: /terms${hash} opened directly puts the heading in focus, just under the app bar, with the page heading left alone`, async ({ page }) => {
        await openTerms(page, { language, viewport, hash });
        const anchor = heading(page, 2, name);
        await expect(anchor).toBeFocused();
        await expect(anchor).toHaveAttribute("tabindex", "-1");
        const bar = await box(page.getByRole("banner"));
        const target = await box(anchor);
        expect(target.y, "not under the bar").toBeGreaterThanOrEqual(bar.y + bar.height);
        expect(Math.round(target.y)).toBe(ANCHOR_TOP);
        await expect(heading(page, 1, COPY[language].title)).not.toBeFocused();
      });
    }
  }

  test("an English visit lands on its heading even where the browser has no scroll anchoring: the text changes length once the saved language is applied", async ({ page }) => {
    // Chromium keeps a heading in place when the text above it grows, which would hide a missing scroll; Safari does not do that.
    await page.addInitScript(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("html, body, main, main * { overflow-anchor: none !important; }");
      document.adoptedStyleSheets = [sheet];
    });
    await openTerms(page, { language: "en", hash: "#privacy" });
    const anchor = heading(page, 2, COPY.en.privacyHeading);
    await expect(anchor).toBeFocused();
    await expect.poll(async () => Math.round((await box(anchor)).y), { message: "the heading's place under the app bar" }).toBe(ANCHOR_TOP);
  });

  test("without an anchor the first load leaves focus where it was (on the page, not on a heading), and the skip link is the first stop", async ({ page }) => {
    await openTerms(page);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "انتقل إلى المحتوى" })).toBeFocused();
  });

  test("the three links of S-02 open the page at the right place: no anchor on the heading, #terms on its part, #privacy on its part", async ({ page }) => {
    await openRegister(page);
    for (const [which, url, focused] of [
      ["all", /\/terms$/, heading(page, 1, COPY.ar.title)],
      ["terms", /\/terms#terms$/, heading(page, 2, COPY.ar.termsHeading)],
      ["privacy", /\/terms#privacy$/, heading(page, 2, COPY.ar.privacyHeading)],
    ] as const) {
      await registerLink(page, "ar", which).click();
      await expect(page).toHaveURL(url);
      await expect(focused).toBeFocused();
      if (which !== "all") expect(Math.round((await box(focused)).y)).toBe(ANCHOR_TOP);
      await page.getByRole("button", { name: COPY.ar.backRegister, exact: true }).click();
      await expect(page).toHaveURL(/\/register$/);
      await expect(heading(page, 1, COPY.ar.registerHeading)).toBeFocused();
    }
  });

  test("Tab goes skip link, back control, switch, closing button, and nothing in the text takes a stop", async ({ page }) => {
    await openTerms(page);
    const stops: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press("Tab");
      stops.push(await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute("aria-label") ?? (document.activeElement?.textContent ?? "").trim()));
    }
    expect(stops).toEqual(["انتقل إلى المحتوى", COPY.ar.backHome, "العربية", COPY.ar.returnHome]);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: COPY.ar.returnHome, exact: true })).not.toBeFocused();
  });

  test("Escape does nothing", async ({ page }) => {
    await openTerms(page);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/terms$/);
    await expect(heading(page, 1, COPY.ar.title)).toBeVisible();
  });
});

test.describe("the way back (S-03 section 1: back to the opener with its state kept, or / when opened directly)", () => {
  async function fillRegister(page: Page, language: Language) {
    await usernameField(page, language).fill("sample_user");
    await passwordField(page, language).fill("first synthetic phrase");
    await confirmationField(page, language).fill("second synthetic phrase");
    await consentBox(page, language).check();
  }

  async function expectFormKept(page: Page, language: Language) {
    await expect(page).toHaveURL(/\/register$/);
    await expect(usernameField(page, language)).toHaveValue("sample_user");
    await expect(passwordField(page, language)).toHaveValue("first synthetic phrase");
    await expect(passwordField(page, language)).toHaveAttribute("type", "password");
    await expect(confirmationField(page, language)).toHaveValue("second synthetic phrase");
    await expect(consentBox(page, language)).toBeChecked();
  }

  for (const language of ["ar", "en"] as const) {
    test(`${language}: opened from S-02, the back control names it and returns to it with every typed value, the passwords and the box kept`, async ({ page }) => {
      await openRegister(page, language);
      await fillRegister(page, language);
      await registerLink(page, language, "privacy").click();
      await expect(page).toHaveURL(/\/terms#privacy$/);
      const back = page.getByRole("button", { name: COPY[language].backRegister, exact: true });
      await expect(back).toBeVisible();
      await expect(page.getByRole("link", { name: COPY[language].backHome, exact: true })).toHaveCount(0);
      await back.click();
      await expectFormKept(page, language);
    });

    test(`${language}: opened from S-02, the closing button does the same`, async ({ page }) => {
      await openRegister(page, language);
      await fillRegister(page, language);
      await registerLink(page, language, "all").click();
      await expect(page).toHaveURL(/\/terms$/);
      await page.getByRole("button", { name: COPY[language].returnRegister, exact: true }).click();
      await expectFormKept(page, language);
    });
  }

  test("going back adds nothing to the history: the step before S-02 is still the step before it", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "إنشاء حساب" }).click();
    await expect(page).toHaveURL(/\/register$/);
    await registerLink(page, "ar", "terms").click();
    await expect(page).toHaveURL(/\/terms#terms$/);
    await page.getByRole("button", { name: COPY.ar.backRegister, exact: true }).click();
    await expect(page).toHaveURL(/\/register$/);
    // Had the control pushed S-02 again, the browser's back would land on S-03 here and not on the screen before S-02.
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("opened directly, the back control is a link to / and the closing button goes to / too, the public catalog (S-07)", async ({ page }) => {
    await openTerms(page);
    const back = page.getByRole("link", { name: COPY.ar.backHome, exact: true });
    await expect(back).toHaveAttribute("href", "/");
    await back.click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(heading(page, 1, "تصفّح الكتب")).toBeVisible();

    await openTerms(page);
    await page.getByRole("button", { name: COPY.ar.returnHome, exact: true }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
    await expect(heading(page, 1, "تصفّح الكتب")).toBeVisible();
  });

  test("a reload on S-03 forgets the opener, as it forgets the form: the controls then name the home page", async ({ page }) => {
    await openRegister(page);
    await fillRegister(page, "ar");
    await registerLink(page, "ar", "terms").click();
    await expect(page.getByRole("button", { name: COPY.ar.backRegister, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: COPY.ar.backHome, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: COPY.ar.backRegister, exact: true })).toHaveCount(0);
  });

  test("a link opened in a new tab has no opener in that tab, so it names the home page", async ({ page, context }) => {
    await openRegister(page);
    const [tab] = await Promise.all([context.waitForEvent("page"), registerLink(page, "ar", "terms").click({ modifiers: ["ControlOrMeta"] })]);
    await tab.waitForLoadState();
    await expect(tab.getByRole("link", { name: COPY.ar.backHome, exact: true })).toBeVisible();
  });

  test("the browser's own back button also returns to S-02 with its form", async ({ page }) => {
    await openRegister(page);
    await fillRegister(page, "ar");
    await registerLink(page, "ar", "terms").click();
    await expect(page).toHaveURL(/\/terms#terms$/);
    await page.goBack();
    await expectFormKept(page, "ar");
  });

  test("the controls follow a language switch: the opener is named in the new language", async ({ page }) => {
    await openRegister(page);
    await registerLink(page, "ar", "all").click();
    await expect(page.getByRole("button", { name: COPY.ar.backRegister, exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "English (EN)" }).check();
    await expect(page.getByRole("button", { name: COPY.en.backRegister, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: COPY.en.returnRegister, exact: true })).toBeVisible();
  });
});

test.describe("language switched on the page (S-03 section 4)", () => {
  test("the text re-renders in the other language at once, the scroll is kept, focus stays on the switch, and the change is announced", async ({ page }) => {
    await openTerms(page);
    await page.evaluate(() => window.scrollTo(0, 1500));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBe(1500);
    await pressSegment(page, "English (EN)");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(heading(page, 1, COPY.en.title)).toBeAttached();
    await expect(page.getByRole("radio", { name: "English (EN)" })).toBeFocused();
    await expect(page.getByText(COPY.en.languageChanged)).toBeAttached();
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([...COPY.en.topics]);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);

    await pressSegment(page, "العربية");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([...COPY.ar.topics]);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(page.getByRole("radio", { name: "العربية" })).toBeFocused();
  });

  test("an anchored visit keeps its place when the language changes: the heading stays where it was in the window and the page does not jump to the top", async ({ page }) => {
    await openTerms(page, { hash: "#privacy" });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    await pressSegment(page, "English (EN)");
    const anchor = heading(page, 2, COPY.en.privacyHeading);
    await expect(anchor).toBeAttached();
    // The text above it is longer in English, so the browser moves the scroll to keep the heading about where it was in the window:
    // below the bar and near the top, not scrolled away.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    const bar = await box(page.getByRole("banner"));
    const top = (await box(anchor)).y;
    expect(top).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    expect(top).toBeLessThanOrEqual(ANCHOR_TOP + 40);
  });
});

test.describe("no API call, no session (S-03 sections 1 and 4: guard 13, always open)", () => {
  test("nothing but the first health request goes out", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) requested.push(`${request.method()} ${url.pathname}`);
    });
    await openTerms(page);
    await expect(heading(page, 1, COPY.ar.title)).toBeVisible();
    await page.getByRole("radio", { name: "English (EN)" }).check();
    await page.getByRole("button", { name: COPY.en.returnHome, exact: true }).waitFor();
    await page.waitForTimeout(600);
    expect(requested).toEqual(["GET /api/health"]);
  });

  test("a visitor who is signed in stays on the page: there is no session probe and no redirect", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) requested.push(url.pathname);
    });
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockProfile) }));
    await openTerms(page);
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/terms$/);
    await expect(heading(page, 1, COPY.ar.title)).toBeVisible();
    expect(requested).not.toContain("/api/me");
  });

  test("keeps nothing of the visit in the browser's storage but the language, and no cookie", async ({ page }) => {
    await openRegister(page);
    await usernameField(page, "ar").fill("sample_user");
    await passwordField(page, "ar").fill("first synthetic secret");
    await registerLink(page, "ar", "terms").click();
    await expect(page).toHaveURL(/\/terms#terms$/);
    const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    expect(kept).not.toContain("secret");
    expect(kept).not.toContain("sample_user");
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["qatra.language"]);
  });
});

test.describe("a sleeping server (S-03 section 4: wake-up is not applicable, the page calls no API)", () => {
  // The browser logs the answers of a sleeping server as failed requests; any other console error still fails the test.
  test.use({ allowFailedRequests: true });

  test("shows no wake-up line on this page, for it has nothing to wait for", async ({ page }) => {
    await openTerms(page, { mode: "gateway" });
    await page.waitForTimeout(500);
    await expect(page.getByText(WAKE_LINE.ar)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toHaveCount(0);
    await expect(heading(page, 1, COPY.ar.title)).toBeVisible();
  });
});

test.describe("route loading (S-03 section 4)", () => {
  test("keeps the header and the heading, shows a skeleton after 300 ms with «جارٍ التحميل» announced, moves nothing, and lands on the heading of the anchor when the page arrives", async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/_next/static/chunks/${termsChunk()}`, async (route) => {
      await gate;
      await route.continue();
    });
    await openRegister(page);
    await registerLink(page, "ar", "privacy").click();
    await expect(page).toHaveURL(/\/terms#privacy$/);

    const busy = page.locator("[aria-busy=true]");
    await expect(busy).toHaveCount(1);
    await expect(heading(page, 1, COPY.ar.title)).toBeVisible();
    await expect(page.getByRole("link", { name: COPY.ar.backHome, exact: true }).or(page.getByRole("button", { name: COPY.ar.backRegister, exact: true }))).toBeVisible();
    await expect(busy.getByRole("status")).toHaveText(COPY.ar.loading);
    // Skeleton blocks stand in for the text: decorative, in the disabled fill, and no real text is shown besides the heading.
    const blocksInView = busy.locator("[aria-hidden=true] > div, div[aria-hidden=true]");
    expect(await blocksInView.count()).toBeGreaterThan(5);
    expect(await style(blocksInView.first(), ["background-color", "border-top-left-radius"])).toEqual({ "background-color": "rgb(223, 234, 242)", "border-top-left-radius": "8px" });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await axeViolations(page), "loading state").toEqual([]);
    // Focus has not been moved to the heading by the loading view.
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-page-heading"))).toBe(false);

    release();
    await expect(heading(page, 2, COPY.ar.privacyHeading)).toBeFocused();
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: COPY.ar.backRegister, exact: true })).toBeVisible();
    expect(Math.round((await box(heading(page, 2, COPY.ar.privacyHeading))).y)).toBe(ANCHOR_TOP);
  });

  test("announces «Loading» in English, and the page that follows moves focus to its own heading when there is no anchor", async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/_next/static/chunks/${termsChunk()}`, async (route) => {
      await gate;
      await route.continue();
    });
    await openRegister(page, "en");
    await registerLink(page, "en", "all").click();
    await expect(page.locator("[aria-busy=true]").getByRole("status")).toHaveText(COPY.en.loading);
    release();
    await expect(heading(page, 1, COPY.en.title)).toBeFocused();
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  });
});

test.describe("text unavailable (S-03 section 4)", () => {
  // The browser logs a failed request and the failed chunk load; nothing else may be logged.
  test.use({ allowConsoleErrors: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: when the route cannot load, an error banner with a retry button takes its place, focus goes to the button, and a retry brings the page`, async ({ page, consoleErrors }) => {
      let blocked = true;
      await page.route(`**/_next/static/chunks/${termsChunk()}`, (route) => (blocked ? route.abort("failed") : route.continue()));
      await openRegister(page, language);
      await registerLink(page, language, "privacy").click();
      await expect(page).toHaveURL(/\/terms#privacy$/);

      const copy = COPY[language];
      const alert = page.locator("[role=alert]:not(#__next-route-announcer__)");
      await expect(alert).toHaveCount(1);
      await expect(alert).toContainText(copy.unavailable);
      const retry = alert.getByRole("button", { name: copy.retry, exact: true });
      await expect(retry).toBeFocused();
      await expect(heading(page, 1, copy.title)).toBeVisible();
      await expect(heading(page, 1, copy.title)).not.toBeFocused();
      // The header is still there, with its switch and the way back; the banner has its own icon next to the text, never colour alone.
      await expect(page.getByRole("radiogroup")).toBeVisible();
      await expect(page.getByRole("button", { name: copy.backRegister, exact: true })).toBeVisible();
      await expect(alert.locator("svg[aria-hidden=true]")).toHaveCount(1);
      expect(await style(alert, ["background-color", "border-top-color"])).toEqual({ "background-color": "rgb(253, 236, 234)", "border-top-color": "rgb(192, 54, 44)" });
      expect(await axeViolations(page), "error state").toEqual([]);
      expect(await smallTargets(page), "targets").toEqual([]);

      blocked = false;
      await retry.click();
      await expect(heading(page, 2, copy.privacyHeading)).toBeFocused();
      await expect(alert).toHaveCount(0);
      await expect(heading(page, 3, copy.topics[3] as string)).toBeVisible();
      expect(consoleErrors.filter((message) => !/Failed to load resource|ChunkLoadError/.test(message))).toEqual([]);
    });
  }
});

test.describe("accessibility checks with axe (NFR-09)", () => {
  for (const language of ["ar", "en"] as const) {
    for (const [name, viewport] of [
      ["phone", VIEWPORTS.phone],
      ["floor", VIEWPORTS.floor],
      ["desktop", VIEWPORTS.desktop],
    ] as const) {
      test(`${language} ${name}: the page has no violations, with the text-secondary version line, the lists and the divider`, async ({ page }) => {
        await openTerms(page, { language, viewport });
        await expect(heading(page, 1, COPY[language].title)).toBeVisible();
        expect(await axeViolations(page)).toEqual([]);
      });
    }

    test(`${language}: no violations with an anchor in focus and with the switch changed`, async ({ page }) => {
      await openTerms(page, { language, hash: "#privacy" });
      await expect(heading(page, 2, COPY[language].privacyHeading)).toBeFocused();
      expect(await axeViolations(page), "anchor in focus").toEqual([]);
      await page.getByRole("radio", { name: language === "ar" ? "English (EN)" : "العربية" }).check();
      expect(await axeViolations(page), "after the switch").toEqual([]);
    });
  }

  test("no violations at 200 % text on 320 px", async ({ page }) => {
    await openTerms(page, { viewport: { width: 320, height: 568 } });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await axeViolations(page)).toEqual([]);
  });
});
