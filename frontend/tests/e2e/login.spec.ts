import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { MOCK_PASSWORD, mockProfile, mockToday, mockTodayWithoutPlan } from "../../src/lib/api/mock";
import { axeViolations, controlHealth, expect, smallTargets, test, VIEWPORTS, waitForFirstHealthRequest, WAKE_LINE, type HealthMode } from "./fixtures";

// S-01 (UI-screens Batch 1) in a real browser, against a production build in live mode. Every API answer is route-intercepted;
// the stub backend only answers E01 and, as a visitor, E11.

type Language = "ar" | "en";

const COPY = {
  ar: {
    heading: "الدخول",
    username: "اسم المستخدم",
    password: "كلمة المرور",
    submit: "دخول",
    loading: "جارٍ الدخول…",
    show: "إظهار كلمة المرور",
    hide: "إخفاء كلمة المرور",
    forgot: "نسيت كلمة المرور",
    create: "إنشاء حساب",
    needUsername: "أدخل اسم المستخدم.",
    needPassword: "أدخل كلمة المرور.",
    summary: "يوجد خطآن في النموذج",
    invalid: "اسم المستخدم أو كلمة المرور غير صحيحة.",
    internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
    unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
    origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
    reload: "إعادة تحميل الصفحة",
    offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
    back: "عاد الاتصال.",
    throttle: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
    lock: "محاولات كثيرة. يمكنك المحاولة بعد ١٥:٠٠.",
    again: "يمكنك المحاولة الآن.",
    processing: "ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.",
    ready: "الخادم جاهز. يمكنك المحاولة الآن.",
    retry: "إعادة المحاولة",
    clock20: "٠٠:٢٠",
    clock19: "٠٠:١٩",
    todayHeading: "اليوم",
  },
  en: {
    heading: "Log in",
    username: "Username",
    password: "Password",
    submit: "Log in",
    loading: "Logging in…",
    show: "Show password",
    hide: "Hide password",
    forgot: "Forgot your password?",
    create: "Create an account",
    needUsername: "Enter your username.",
    needPassword: "Enter your password.",
    summary: "There are 2 errors in the form",
    invalid: "The username or password is not correct.",
    internal: "Something unexpected happened. Try again.",
    unavailable: "The service is temporarily unavailable. Try again shortly.",
    origin: "The request could not be completed. Reload the page and try again.",
    reload: "Reload page",
    offline: "There is no network connection. Check your connection and try again.",
    back: "The connection is back.",
    throttle: "Too many attempts. Wait 20 seconds and try again.",
    lock: "Too many attempts. You can try again in 15:00.",
    again: "You can try again now.",
    processing: "We are still processing your request; this may take a moment.",
    ready: "The server is ready. You can try again now.",
    retry: "Try again",
    clock20: "00:20",
    clock19: "00:19",
    todayHeading: "Today",
  },
} as const;

const envelope = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "Safe text.", details } });

const alerts = (page: Page) => page.locator("[role=alert]:not(#__next-route-announcer__)");
const polite = (page: Page) => page.locator("[role=status][aria-live=polite]");
const usernameField = (page: Page, language: Language) => page.getByRole("textbox", { name: COPY[language].username });
const passwordField = (page: Page, language: Language) => page.getByLabel(COPY[language].password, { exact: true });
const submitButton = (page: Page, language: Language) => page.getByRole("button", { name: new RegExp(`^(${COPY[language].submit}|${COPY[language].loading})$`) });

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// Opens /login once React has hydrated (the first health request is the sign), with E01 and the session probe under control.
async function openLogin(page: Page, { language = "ar", viewport = VIEWPORTS.phone, query = "", mode = "ok" }: { language?: Language; viewport?: { width: number; height: number }; query?: string; mode?: HealthMode } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, mode);
  await page.goto(`/login${query}`);
  await waitForFirstHealthRequest(health);
  return health;
}

// Answers E04 from `answer`, a function (so a test can change its mind mid-run), "abort" (no answer at all) or "hang" (never answers).
async function serveLogin(page: Page, answer: Answer | (() => Answer) | "abort" | "hang") {
  const sent: { username: string; password: string }[] = [];
  await page.route("**/api/auth/login", async (route: Route) => {
    sent.push(route.request().postDataJSON() as { username: string; password: string });
    if (answer === "hang") return;
    if (answer === "abort") return route.abort("failed");
    const { status, body, headers } = typeof answer === "function" ? answer() : answer;
    await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store", ...headers }, body: JSON.stringify(body) });
  });
  return sent;
}

const signedIn = (): Answer => ({ status: 200, body: { profile: mockProfile, reconsentRequired: false } });

async function serveHome(page: Page, { plan = true }: { plan?: boolean } = {}) {
  await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(plan ? mockToday : mockTodayWithoutPlan) }));
}

async function fill(page: Page, language: Language, username = "sample_user_01", password = MOCK_PASSWORD) {
  await usernameField(page, language).fill(username);
  await passwordField(page, language).fill(password);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("no bounding box");
  return result;
}

// The 2 px ring of a text field sits on its box, because the input inside has no outline of its own.
const fieldBox = (page: Page, language: Language, which: "username" | "password") => (which === "username" ? usernameField(page, language) : passwordField(page, language)).locator("xpath=..");

test.describe("layout and design (UI-screens S-01 sections 2, 5 and 6)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: the lockup, the heading, the fields, the button and the links, top to bottom, in one column`, async ({ page }) => {
      await openLogin(page, { language });
      const copy = COPY[language];
      const lockup = page.locator("main span", { hasText: language === "ar" ? "قطرة غيث" : "Qatra" }).first();
      const heading = page.getByRole("heading", { level: 1, name: copy.heading });
      const user = fieldBox(page, language, "username");
      const pass = fieldBox(page, language, "password");
      const button = submitButton(page, language);
      const forgot = page.getByRole("link", { name: copy.forgot });
      const create = page.getByRole("link", { name: copy.create });

      const ys = await Promise.all([lockup, heading, user, pass, button, forgot, create].map(async (item) => (await box(item)).y));
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
      // One column: every control starts and ends at the same two edges, except the links, which are lines of their own.
      const columns = await Promise.all([user, pass, button].map(async (item) => box(item)));
      for (const column of columns) {
        expect(Math.round(column.x)).toBe(Math.round(columns[0]?.x ?? 0));
        expect(Math.round(column.width)).toBe(Math.round(columns[0]?.width ?? 0));
      }
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.getByRole("banner")).toBeVisible();
    });

    test(`${language}: no horizontal scroll at 320, 360, 1280 px`, async ({ page }) => {
      await openLogin(page, { language });
      for (const width of [320, 360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        expect(scrollWidth, `${width} px`).toBeLessThanOrEqual(clientWidth);
      }
    });
  }

  test("the column is the viewport minus the 24 px margins on a phone, and 480 px, centred, from 560 px", async ({ page }) => {
    await openLogin(page, { viewport: { width: 360, height: 800 } });
    const phone = await box(fieldBox(page, "ar", "username"));
    expect(Math.round(phone.x)).toBe(24);
    expect(Math.round(phone.width)).toBe(360 - 48);

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = await box(fieldBox(page, "ar", "username"));
    expect(Math.round(desktop.width)).toBe(480);
    expect(Math.round(desktop.x)).toBe((1280 - 480) / 2);

    await page.setViewportSize({ width: 600, height: 800 });
    const wide = await box(fieldBox(page, "ar", "username"));
    expect(Math.round(wide.width)).toBe(480);
  });

  test("fields and button are 48 px high, the toggle is 44 by 44, each link is a 44 px line, the lockup glyph is 32 px", async ({ page }) => {
    await openLogin(page);
    expect(Math.round((await box(fieldBox(page, "ar", "username"))).height)).toBe(48);
    expect(Math.round((await box(fieldBox(page, "ar", "password"))).height)).toBe(48);
    expect(Math.round((await box(submitButton(page, "ar"))).height)).toBe(48);
    const toggle = await box(page.getByRole("button", { name: COPY.ar.show }));
    expect([Math.round(toggle.width), Math.round(toggle.height)]).toEqual([44, 44]);
    for (const name of [COPY.ar.forgot, COPY.ar.create]) expect(Math.round((await box(page.getByRole("link", { name }))).height)).toBe(44);
    const glyph = await box(page.locator("main svg.lucide-droplet"));
    expect([Math.round(glyph.width), Math.round(glyph.height)]).toEqual([32, 32]);
    expect(await smallTargets(page)).toEqual([]);
  });

  test("the two links are 8 px apart, and the button is 24 px above them", async ({ page }) => {
    await openLogin(page);
    const button = await box(submitButton(page, "ar"));
    const forgot = await box(page.getByRole("link", { name: COPY.ar.forgot }));
    const create = await box(page.getByRole("link", { name: COPY.ar.create }));
    expect(Math.round(forgot.y - (button.y + button.height))).toBe(24);
    expect(Math.round(create.y - (forgot.y + forgot.height))).toBe(8);
  });

  test("type and colour follow the tokens: title 22 px bold, labels 15 px semibold, inputs 16 px, the deep blue name and the primary glyph", async ({ page }) => {
    await openLogin(page);
    const style = (locator: Locator, properties: string[]) => locator.evaluate((element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])), properties);
    expect(await style(page.getByRole("heading", { level: 1 }), ["font-size", "font-weight", "color"])).toEqual({ "font-size": "22px", "font-weight": "700", color: "rgb(24, 59, 82)" });
    expect(await style(page.locator("label", { hasText: COPY.ar.username }), ["font-size", "font-weight"])).toEqual({ "font-size": "15px", "font-weight": "600" });
    expect((await style(usernameField(page, "ar"), ["font-size"]))["font-size"]).toBe("16px");
    expect((await style(page.locator("main span", { hasText: "قطرة غيث" }).first(), ["color", "font-size"]))).toEqual({ color: "rgb(23, 79, 118)", "font-size": "18px" });
    expect((await style(page.locator("main svg.lucide-droplet"), ["color"])).color).toBe("rgb(29, 120, 181)");
    expect(await style(submitButton(page, "ar"), ["background-color", "color", "font-weight"])).toEqual({ "background-color": "rgb(29, 120, 181)", color: "rgb(255, 255, 255)", "font-weight": "600" });
    // The links are the link colour and underlined.
    expect(await style(page.getByRole("link", { name: COPY.ar.forgot }), ["color", "text-decoration-line"])).toEqual({ color: "rgb(23, 79, 118)", "text-decoration-line": "underline" });
  });

  test("the toggle sits at the end edge inside the field: left in Arabic, right in English", async ({ page }) => {
    for (const language of ["ar", "en"] as const) {
      await openLogin(page, { language });
      const field = await box(fieldBox(page, language, "password"));
      const toggle = await box(page.getByRole("button", { name: COPY[language].show }));
      const centre = toggle.x + toggle.width / 2;
      if (language === "ar") expect(centre).toBeLessThan(field.x + field.width / 2);
      else expect(centre).toBeGreaterThan(field.x + field.width / 2);
      // Inside the border, with the input text never under it.
      expect(toggle.x).toBeGreaterThanOrEqual(field.x);
      expect(toggle.x + toggle.width).toBeLessThanOrEqual(field.x + field.width);
      const input = await box(passwordField(page, language));
      expect(input.x + input.width <= toggle.x + 1 || input.x >= toggle.x + toggle.width - 1).toBe(true);
    }
  });

  test("typed Latin text in the Arabic page does not move the toggle or run under it", async ({ page }) => {
    await openLogin(page);
    const before = await box(page.getByRole("button", { name: COPY.ar.show }));
    await passwordField(page, "ar").fill("a long latin passphrase typed here");
    const after = await box(page.getByRole("button", { name: COPY.ar.show }));
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    const input = await box(passwordField(page, "ar"));
    expect(input.x + input.width <= after.x + 1 || input.x >= after.x + after.width - 1).toBe(true);
  });

  test("the switch is at the end edge of the header and the header holds no other control", async ({ page }) => {
    await openLogin(page);
    const header = page.getByRole("banner");
    await expect(header.getByRole("link")).toHaveCount(0);
    await expect(header.getByRole("radio")).toHaveCount(2);
    const group = await box(header.getByRole("radiogroup"));
    expect(group.x).toBeLessThan(VIEWPORTS.phone.width / 2);
  });
});

test.describe("keyboard and focus (S-01 section 5)", () => {
  async function tabLabels(page: Page, count: number) {
    const labels: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press("Tab");
      labels.push(
        await page.evaluate(() => {
          const element = document.activeElement as HTMLInputElement | HTMLElement;
          return element.getAttribute("aria-label") ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? (element.textContent ?? "").trim();
        }),
      );
    }
    return labels;
  }

  for (const language of ["ar", "en"] as const) {
    test(`${language}: Tab goes skip link, switch, username, password, toggle, button, forgot, create, and nothing traps`, async ({ page }) => {
      await openLogin(page, { language });
      const copy = COPY[language];
      expect(await tabLabels(page, 8)).toEqual([
        language === "ar" ? "انتقل إلى المحتوى" : "Skip to content",
        language === "ar" ? "العربية" : "English (EN)",
        copy.username,
        copy.password,
        copy.show,
        copy.submit,
        copy.forgot,
        copy.create,
      ]);
      // One more Tab leaves the last link: focus is not trapped.
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: copy.create })).not.toBeFocused();
    });
  }

  test("every stop shows a 2 px focus ring in the focus colour: on the field box, on the buttons and on the links", async ({ page }) => {
    await openLogin(page);
    const rings: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        // A text field draws its ring on the box around it.
        const host = element instanceof HTMLInputElement && element.type !== "radio" ? (element.parentElement as HTMLElement) : element;
        const style = getComputedStyle(host);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
      });
      rings.push(ring);
    }
    // The radio of the switch draws its ring on its label (F0), the other seven stops are checked here.
    for (const [index, ring] of rings.entries()) if (index !== 1) expect(ring, `stop ${index}`).toBe("solid 2px rgb(23, 79, 118)");
  });

  test("Enter in either field sends the form", async ({ page }) => {
    await openLogin(page);
    const sent = await serveLogin(page, signedIn());
    await serveHome(page);
    await usernameField(page, "ar").fill("sample_user_01");
    await usernameField(page, "ar").press("Enter");
    // The password is still empty, so this is a field error and nothing is sent.
    await expect(passwordField(page, "ar")).toHaveAttribute("aria-invalid", "true");
    expect(sent).toHaveLength(0);
    await passwordField(page, "ar").fill(MOCK_PASSWORD);
    await passwordField(page, "ar").press("Enter");
    await expect(page).toHaveURL(/\/today$/);
    expect(sent).toHaveLength(1);
  });

  test("Space and Enter operate the toggle, which names its action, keeps focus and never sends the form", async ({ page }) => {
    await openLogin(page);
    const sent = await serveLogin(page, signedIn());
    await passwordField(page, "ar").fill("a long synthetic phrase");
    const toggle = page.getByRole("button", { name: COPY.ar.show });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(passwordField(page, "ar")).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: COPY.ar.hide })).toBeFocused();
    await expect(page.getByRole("button", { name: COPY.ar.hide })).not.toHaveAttribute("aria-pressed");
    await page.keyboard.press("Enter");
    await expect(passwordField(page, "ar")).toHaveAttribute("type", "password");
    expect(sent).toHaveLength(0);
  });

  test("moving to the login page by a link and coming back puts focus on the heading, and the first load does not", async ({ page }) => {
    await openLogin(page);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.getByRole("link", { name: COPY.ar.forgot }).click();
    await expect(page).toHaveURL(/\/recovery$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.heading })).toBeFocused();
  });

  test("the create-account link opens the register route and the focus lands on its heading", async ({ page }) => {
    await openLogin(page);
    await page.getByRole("link", { name: COPY.ar.create }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole("heading", { level: 1, name: "إنشاء الحساب" })).toBeFocused();
  });

  test("the language switch keeps what was typed and leaves focus on the switch", async ({ page }) => {
    await openLogin(page);
    await fill(page, "ar", "sample_user_01", "a synthetic phrase");
    await page.getByRole("radio", { name: "English (EN)" }).check();
    await expect(page.getByRole("heading", { level: 1, name: COPY.en.heading })).toBeVisible();
    await expect(usernameField(page, "en")).toHaveValue("sample_user_01");
    await expect(passwordField(page, "en")).toHaveValue("a synthetic phrase");
    await expect(page.getByRole("radio", { name: "English (EN)" })).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});

test.describe("validation, on submit only (P-03)", () => {
  test.use({ allowFailedRequests: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: two empty fields give a summary alert with links, focus on the username, nothing sent`, async ({ page }) => {
      await openLogin(page, { language });
      const sent = await serveLogin(page, signedIn());
      const copy = COPY[language];
      await submitButton(page, language).click();

      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(copy.summary);
      await expect(alerts(page).getByRole("link", { name: copy.needUsername })).toBeVisible();
      await expect(alerts(page).getByRole("link", { name: copy.needPassword })).toBeVisible();
      await expect(usernameField(page, language)).toBeFocused();
      await expect(usernameField(page, language)).toHaveAttribute("aria-invalid", "true");
      await expect(passwordField(page, language)).toHaveAttribute("aria-invalid", "true");
      expect(sent).toHaveLength(0);

      await alerts(page).getByRole("link", { name: copy.needPassword }).click();
      await expect(passwordField(page, language)).toBeFocused();
    });
  }

  test("one empty field gives its message under the field and no summary, with the field focused", async ({ page }) => {
    await openLogin(page);
    await usernameField(page, "ar").fill("sample_user_01");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveCount(0);
    await expect(passwordField(page, "ar")).toBeFocused();
    const described = await passwordField(page, "ar").evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent);
    expect(described).toBe(COPY.ar.needPassword);
  });

  test("the field in error has the 2 px error border and the message carries a glyph, never colour alone", async ({ page }) => {
    await openLogin(page);
    await usernameField(page, "ar").fill("sample_user_01");
    await submitButton(page, "ar").click();
    // The border fades over the fast duration; read it once it has settled.
    const readBox = () => fieldBox(page, "ar", "password").evaluate((element) => ({ border: getComputedStyle(element).borderTopColor, shadow: getComputedStyle(element).boxShadow }));
    await expect.poll(async () => (await readBox()).border).toBe("rgb(192, 54, 44)");
    expect((await readBox()).shadow).toContain("rgb(192, 54, 44)");
    const message = page.locator("p", { hasText: COPY.ar.needPassword });
    expect(await message.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(168, 50, 45)");
    await expect(message.locator("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("a press on the button straight after fixing a field is not lost, although the message above it leaves with the blur", async ({ page }) => {
    await openLogin(page);
    const sent = await serveLogin(page, { status: 401, body: envelope("invalid_credentials") });
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary);
    // fill() leaves the cursor in the field; the click then blurs it, which clears its message and would move the button.
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect.poll(() => sent.length).toBe(1);
    await expect(alerts(page)).toHaveText(COPY.ar.invalid);
    await expect(usernameField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
    await expect(passwordField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("an error clears at the field's next blur once it holds something, and an empty blur validates nothing", async ({ page }) => {
    await openLogin(page);
    await usernameField(page, "ar").click();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(usernameField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");

    await submitButton(page, "ar").click();
    await usernameField(page, "ar").fill("sample_user_01");
    await usernameField(page, "ar").blur();
    await expect(usernameField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
    await expect(alerts(page)).toHaveCount(0);
    await expect(passwordField(page, "ar")).toHaveAttribute("aria-invalid", "true");
  });
});

test.describe("sending E04 and leaving (S-01 section 1)", () => {
  test("a plan: the request is a same-origin JSON POST, the page goes to /today, its heading takes focus, and nothing is stored", async ({ page, baseURL }) => {
    await openLogin(page);
    const sent = await serveLogin(page, signedIn());
    await serveHome(page);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/login")) requests.push(`${request.method()} ${new URL(request.url()).origin} ${request.headers()["content-type"]} ${request.headers().authorization ?? "no authorization"}`);
    });
    await fill(page, "ar", "  sample_user_01  ");
    await submitButton(page, "ar").click();

    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.todayHeading })).toBeFocused();
    expect(sent).toEqual([{ username: "sample_user_01", password: MOCK_PASSWORD }]);
    expect(requests).toEqual([`POST ${new URL(baseURL ?? "").origin} application/json no authorization`]);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["qatra.language"]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("no plan: E18 says so and the page goes to /start, in the focus shell", async ({ page }) => {
    await openLogin(page);
    await serveLogin(page, signedIn());
    await serveHome(page, { plan: false });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByRole("heading", { level: 1, name: "ما هي خطتك؟" })).toBeFocused();
    await expect(page.getByRole("radiogroup", { name: "اللغة" })).toHaveCount(0);
  });

  test("?next= with a path inside the app is honoured, and E18 is not asked", async ({ page }) => {
    await openLogin(page, { query: "?next=%2Fprogress" });
    await serveLogin(page, signedIn());
    let asked = 0;
    await page.route("**/api/today", (route) => {
      asked += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockToday) });
    });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/progress$/);
    expect(asked).toBe(0);
  });

  for (const next of ["//evil.example/x", "https://evil.example/x", "javascript:alert(1)", "/login"]) {
    test(`?next=${next} is ignored and the visitor goes home`, async ({ page, baseURL }) => {
      await openLogin(page, { query: `?next=${encodeURIComponent(next)}` });
      await serveLogin(page, signedIn());
      await serveHome(page);
      await fill(page, "ar");
      await submitButton(page, "ar").click();
      await expect(page).toHaveURL(/\/today$/);
      expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? "").origin);
    });
  }

  test("reconsentRequired goes to the re-consent gate, without asking E18", async ({ page }) => {
    await openLogin(page, { query: "?next=%2Fgames" });
    await serveLogin(page, { status: 200, body: { profile: mockProfile, reconsentRequired: true } });
    let asked = 0;
    await page.route("**/api/today", (route) => {
      asked += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockToday) });
    });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/consent$/);
    await expect(page.getByRole("heading", { level: 1, name: "موافقة جديدة على الشروط" })).toBeFocused();
    expect(asked).toBe(0);
  });

  test("the profile language prevails after login", async ({ page }) => {
    await openLogin(page, { language: "ar" });
    await serveLogin(page, { status: 200, body: { profile: { ...mockProfile, language: "en" }, reconsentRequired: false } });
    await serveHome(page);
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  });

  test("a visitor with a valid session is sent away at once: to /today with a plan, to /start without one (guard 2)", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "ar"));
    const health = await controlHealth(page, "ok");
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockProfile) }));
    await serveHome(page, { plan: true });
    await page.goto("/login");
    await waitForFirstHealthRequest(health);
    await expect(page).toHaveURL(/\/today$/);

    await page.unroute("**/api/today");
    await serveHome(page, { plan: false });
    await page.goto("/login");
    await expect(page).toHaveURL(/\/start$/);
  });

  test("the first request of the page load is the health probe, and the session probe follows", async ({ page }) => {
    const seen: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) seen.push(new URL(request.url()).pathname);
    });
    await openLogin(page);
    await expect.poll(() => seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.slice(0, 2)).toEqual(["/api/health", "/api/me"]);
    // The probe runs once: typing and pressing do not start it again.
    await fill(page, "ar", "sample_user_01", "a wrong phrase");
    await page.waitForTimeout(800);
    expect(seen.filter((path) => path === "/api/me")).toHaveLength(1);
  });
});

test.describe("the loading state (S-01 section 4)", () => {
  test("the button shows its loading label and a spinner, is busy, keeps focus and the values, and a second press sends nothing", async ({ page }) => {
    await openLogin(page);
    const sent = await serveLogin(page, "hang");
    await fill(page, "ar");
    const button = submitButton(page, "ar");
    await button.click();
    await expect(page.getByRole("button", { name: COPY.ar.loading })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: COPY.ar.loading })).toBeFocused();
    await expect(usernameField(page, "ar")).toHaveValue("sample_user_01");
    await expect(passwordField(page, "ar")).toHaveValue(MOCK_PASSWORD);
    await expect(polite(page).filter({ hasText: "جارٍ الدخول" }).first()).toBeAttached();
    await button.click();
    await passwordField(page, "ar").press("Enter");
    expect(sent).toHaveLength(1);
  });

  test("the spinner turns normally and is a static ring under reduced motion", async ({ page }) => {
    await openLogin(page);
    await serveLogin(page, "hang");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    const spinner = page.getByRole("button", { name: COPY.ar.loading }).locator("span[aria-hidden=true]");
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  });

  test("after 5 s the polite line says it is still working", async ({ page }) => {
    await page.clock.install();
    await openLogin(page);
    await serveLogin(page, "hang");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await page.clock.runFor(4_500);
    await expect(page.getByText(COPY.ar.processing)).toHaveCount(0);
    await page.clock.runFor(1_000);
    await expect(polite(page).filter({ hasText: COPY.ar.processing })).toBeVisible();
  });
});

test.describe("E04 errors (P-06, P-07)", () => {
  test.use({ allowFailedRequests: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: wrong credentials give one generic alert above the button, the password cleared and focused, no field marked`, async ({ page }) => {
      await openLogin(page, { language });
      await serveLogin(page, { status: 401, body: envelope("invalid_credentials") });
      await fill(page, language, "sample_user_01", "a wrong phrase");
      await submitButton(page, language).click();

      await expect(alerts(page)).toHaveText(COPY[language].invalid);
      await expect(passwordField(page, language)).toHaveValue("");
      await expect(passwordField(page, language)).toBeFocused();
      await expect(usernameField(page, language)).toHaveValue("sample_user_01");
      await expect(usernameField(page, language)).not.toHaveAttribute("aria-invalid", "true");
      await expect(passwordField(page, language)).not.toHaveAttribute("aria-invalid", "true");
      const alertBox = await box(alerts(page));
      expect(alertBox.y + alertBox.height).toBeLessThanOrEqual((await box(submitButton(page, language))).y);
      expect(alertBox.y).toBeGreaterThanOrEqual((await box(fieldBox(page, language, "password"))).y);
    });
  }

  test("the button is the retry, and the next attempt can succeed", async ({ page }) => {
    await openLogin(page);
    let answer: Answer = { status: 401, body: envelope("invalid_credentials") };
    await serveLogin(page, () => answer);
    await serveHome(page);
    await fill(page, "ar", "sample_user_01", "a wrong phrase");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.invalid);
    answer = signedIn();
    await passwordField(page, "ar").fill(MOCK_PASSWORD);
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/today$/);
  });

  test("500 is a generic alert with the values kept and focus on the button", async ({ page }) => {
    await openLogin(page);
    await serveLogin(page, { status: 500, body: envelope("internal") });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.internal);
    await expect(usernameField(page, "ar")).toHaveValue("sample_user_01");
    await expect(passwordField(page, "ar")).toHaveValue(MOCK_PASSWORD);
    await expect(submitButton(page, "ar")).toBeFocused();
  });

  test("503 is a warning in a polite status area, not an alert", async ({ page }) => {
    await openLogin(page);
    await serveLogin(page, { status: 503, body: envelope("unavailable") });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(polite(page).filter({ hasText: COPY.ar.unavailable })).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);
    await expect(submitButton(page, "ar")).toBeFocused();
  });

  test("403 forbidden origin gives an alert with a reload button that reloads the page and loses the typed values", async ({ page }) => {
    await openLogin(page);
    await serveLogin(page, { status: 403, body: envelope("forbidden_origin") });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.origin);
    const reloaded = page.waitForEvent("load");
    await alerts(page).getByRole("button", { name: COPY.ar.reload }).click();
    await reloaded;
    await expect(usernameField(page, "ar")).toHaveValue("");
  });

  test("the message of the API, a status code and the typed values never reach the page", async ({ page }) => {
    await openLogin(page);
    await serveLogin(page, { status: 500, body: { error: { code: "internal", message: "Database exploded for sample_user_01", details: {} } } });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.internal);
    const text = await page.locator("main").innerText();
    expect(text).not.toContain("exploded");
    expect(text).not.toContain("500");
    expect(text).not.toContain(MOCK_PASSWORD);
  });
});

test.describe("throttle (P-06)", () => {
  test.use({ allowFailedRequests: true });

  test("a minute or less: warning with the wait, aria-disabled button tied to it, hidden countdown, then re-enabled with a status", async ({ page }) => {
    await page.clock.install();
    await openLogin(page);
    const sent = await serveLogin(page, { status: 429, body: envelope("throttled", { retryAfterSec: 20 }), headers: { "Retry-After": "20" } });
    await fill(page, "ar");
    const button = submitButton(page, "ar");
    await button.click();

    await expect(polite(page).filter({ hasText: COPY.ar.throttle })).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-disabled", "true");
    const describedBy = await button.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText(COPY.ar.throttle);
    const line = page.locator("p[aria-hidden=true] bdi");
    await expect(line).toHaveText(COPY.ar.clock20);
    await expect(line).toHaveAttribute("dir", "ltr");

    await page.clock.runFor(1_000);
    await expect(line).toHaveText(COPY.ar.clock19);
    // A press and Enter do nothing while it waits, and focus is not lost. Playwright treats aria-disabled as disabled, hence the force.
    await button.click({ force: true });
    await passwordField(page, "ar").press("Enter");
    expect(sent).toHaveLength(1);

    await button.focus();
    await page.clock.runFor(19_500);
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(COPY.ar.throttle)).toHaveCount(0);
    await expect(polite(page).filter({ hasText: COPY.ar.again })).toBeAttached();
    await expect(button).toBeFocused();
    await expect(page.locator("p[aria-hidden=true] bdi")).toHaveCount(0);
  });

  test("the 15-minute lock counts in mm:ss", async ({ page }) => {
    await page.clock.install();
    await openLogin(page);
    await serveLogin(page, { status: 429, body: envelope("throttled", { retryAfterSec: 900 }), headers: { "Retry-After": "900" } });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(polite(page).filter({ hasText: COPY.ar.lock })).toBeVisible();
    await expect(page.locator("p[aria-hidden=true] bdi")).toHaveText("١٥:٠٠");
  });

  test("in English the wait is worded and counted with Western digits", async ({ page }) => {
    await page.clock.install();
    await openLogin(page, { language: "en" });
    await serveLogin(page, { status: 429, body: envelope("throttled", { retryAfterSec: 20 }), headers: { "Retry-After": "20" } });
    await fill(page, "en");
    await submitButton(page, "en").click();
    await expect(polite(page).filter({ hasText: COPY.en.throttle })).toBeVisible();
    await expect(page.locator("p[aria-hidden=true] bdi")).toHaveText(COPY.en.clock20);
  });
});

test.describe("wake-up (P-04) and connectivity (P-05)", () => {
  test.use({ allowFailedRequests: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: a sleeping server shows the line above the button, inside the form column, not at the top of the page`, async ({ page }) => {
      await openLogin(page, { language, mode: "gateway" });
      const line = page.getByText(WAKE_LINE[language]);
      await expect(line).toBeVisible({ timeout: 2_000 });
      await expect(line).toHaveCount(1);
      const lineBox = await box(line);
      expect(lineBox.y).toBeGreaterThanOrEqual((await box(fieldBox(page, language, "password"))).y);
      expect(lineBox.y + lineBox.height).toBeLessThanOrEqual((await box(submitButton(page, language))).y);
      await expect(polite(page).filter({ hasText: WAKE_LINE[language] })).toBeVisible();
      await expect(alerts(page)).toHaveCount(0);
      // The form stays editable and sendable.
      await fill(page, language);
      await expect(submitButton(page, language)).toBeEnabled();
    });
  }

  test("a send that gets no answer keeps the values, sends nothing again, and announces readiness once the server answers", async ({ page }) => {
    const health = await openLogin(page, { mode: "ok" });
    const sent = await serveLogin(page, "abort");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.ready)).toBeAttached({ timeout: 6_000 });
    expect(sent).toHaveLength(1);
    await expect(usernameField(page, "ar")).toHaveValue("sample_user_01");
    await expect(passwordField(page, "ar")).toHaveValue(MOCK_PASSWORD);
    await expect(polite(page).filter({ hasText: COPY.ar.ready })).toBeAttached();
    expect(health.requests).toBeGreaterThan(1);
  });

  test("after 90 s without an answer the banner gains a retry button, which is keyboard operable", async ({ page }) => {
    await page.clock.install();
    const health = await openLogin(page, { mode: "hang" });
    await page.clock.runFor(3_500);
    await expect(page.getByText(WAKE_LINE.ar)).toBeVisible();
    await expect(page.getByRole("button", { name: COPY.ar.retry })).toHaveCount(0);
    await page.clock.runFor(90_000);
    const retry = page.getByRole("button", { name: COPY.ar.retry });
    await expect(retry).toBeVisible();
    health.mode = "ok";
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(WAKE_LINE.ar)).toHaveCount(0, { timeout: 5_000 });
  });

  test("with no connection the notice shows before any press, the button stays enabled, and the connection coming back is announced", async ({ page, context }) => {
    await openLogin(page);
    await context.setOffline(true);
    await expect(page.getByText(COPY.ar.offline)).toBeVisible();
    await expect(polite(page).filter({ hasText: COPY.ar.offline })).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);
    await expect(submitButton(page, "ar")).toBeEnabled();
    await expect(submitButton(page, "ar")).not.toHaveAttribute("aria-disabled", "true");

    await context.setOffline(false);
    await expect(page.getByText(COPY.ar.offline)).toHaveCount(0);
    await expect(polite(page).filter({ hasText: COPY.ar.back })).toBeAttached();
  });

  test("the offline notice is worded in English", async ({ page, context }) => {
    await openLogin(page, { language: "en" });
    await context.setOffline(true);
    await expect(page.getByText(COPY.en.offline)).toBeVisible();
  });
});

test.describe("axe-core on every state of S-01 (NFR-09: no violation)", () => {
  test.use({ allowFailedRequests: true });

  async function sweep(page: Page, context: BrowserContext, language: Language, viewport: { width: number; height: number }) {
    const copy = COPY[language];
    let answer: Answer | "hang" = { status: 401, body: envelope("invalid_credentials") };
    await page.route("**/api/auth/login", async (route) => {
      if (answer === "hang") return;
      await route.fulfill({ status: answer.status, contentType: "application/json", headers: { "Retry-After": "20", ...answer.headers }, body: JSON.stringify(answer.body) });
    });
    await openLogin(page, { language, viewport });
    const check = async (state: string) => {
      expect(await axeViolations(page), `${language} ${viewport.width} px: ${state}`).toEqual([]);
      expect(await smallTargets(page), `${language} ${viewport.width} px targets: ${state}`).toEqual([]);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(scrollWidth, `${language} ${viewport.width} px width: ${state}`).toBeLessThanOrEqual(clientWidth);
    };

    await check("initial");
    await submitButton(page, language).click();
    await expect(alerts(page)).toContainText(copy.summary);
    await check("summary of two errors");

    await usernameField(page, language).fill("sample_user_01");
    await usernameField(page, language).blur();
    await check("one field error");

    await page.getByRole("button", { name: copy.show }).click();
    await check("password shown");
    await page.getByRole("button", { name: copy.hide }).click();

    await passwordField(page, language).fill("a wrong phrase");
    await submitButton(page, language).click();
    await expect(alerts(page)).toHaveText(copy.invalid);
    await check("invalid credentials");

    answer = { status: 500, body: envelope("internal") };
    await passwordField(page, language).fill("x");
    await submitButton(page, language).click();
    await expect(alerts(page)).toHaveText(copy.internal);
    await check("500");

    answer = { status: 403, body: envelope("forbidden_origin") };
    await submitButton(page, language).click();
    await expect(alerts(page)).toContainText(copy.origin);
    await check("403 with reload button");

    answer = { status: 503, body: envelope("unavailable") };
    await submitButton(page, language).click();
    await expect(page.getByText(copy.unavailable)).toBeVisible();
    await check("503");

    answer = { status: 429, body: envelope("throttled", { retryAfterSec: 20 }) };
    await submitButton(page, language).click();
    await expect(page.getByText(copy.throttle)).toBeVisible();
    await check("throttled");

    await context.setOffline(true);
    await expect(page.getByText(copy.offline)).toBeVisible();
    await check("offline");
    await context.setOffline(false);
  }

  for (const language of ["ar", "en"] as const) {
    for (const [name, viewport] of [
      ["phone", VIEWPORTS.phone],
      ["floor", VIEWPORTS.floor],
      ["desktop", VIEWPORTS.desktop],
    ] as const) {
      test(`${language} at ${name}`, async ({ page, context }) => {
        await sweep(page, context, language, viewport);
      });
    }
  }

  test("the loading state and the 200 % zoom reflow at 320 px", async ({ page }) => {
    await openLogin(page, { viewport: { width: 320, height: 568 } });
    await serveLogin(page, "hang");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page.getByRole("button", { name: COPY.ar.loading })).toBeVisible();
    expect(await axeViolations(page), "loading").toEqual([]);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("the wake-up banner with its retry button, and the slow-request line", async ({ page }) => {
    await page.clock.install();
    await openLogin(page, { mode: "hang" });
    await page.clock.runFor(95_000);
    await expect(page.getByRole("button", { name: COPY.ar.retry })).toBeVisible();
    expect(await axeViolations(page), "waking with retry").toEqual([]);
    expect(await smallTargets(page), "targets").toEqual([]);
  });

  test("the wake-up banner in English", async ({ page }) => {
    await openLogin(page, { language: "en", mode: "gateway" });
    await expect(page.getByText(WAKE_LINE.en)).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
