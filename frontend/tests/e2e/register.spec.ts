import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import { MOCK_PASSWORD, MOCK_RECOVERY_CODE, mockProfile } from "../../src/lib/api/mock";
import { axeViolations, controlHealth, expect, smallTargets, test, VIEWPORTS, waitForFirstHealthRequest, WAKE_LINE, type HealthMode } from "./fixtures";

// S-02 (UI-screens Batch 1) in a real browser, against a production build in live mode. Every API answer is route-intercepted;
// the stub backend only answers E01 and, as a visitor, E11.

type Language = "ar" | "en";

const COPY = {
  ar: {
    heading: "إنشاء الحساب",
    username: "اسم المستخدم",
    password: "كلمة المرور",
    confirmation: "تأكيد كلمة المرور",
    consent: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
    submit: "إنشاء الحساب",
    loading: "جارٍ إنشاء الحساب…",
    show: "إظهار كلمة المرور",
    hide: "إخفاء كلمة المرور",
    termsLink: "شروط الاستخدام وبيان الخصوصية",
    termsOfUse: "شروط الاستخدام",
    privacy: "بيان الخصوصية",
    login: "تسجيل الدخول",
    back: "رجوع إلى تصفّح الكتب",
    lead: "لا نطلب بريدًا إلكترونيًا ولا رقم هاتف ولا تاريخ ميلاد؛ اسم مستخدم وكلمة مرور فقط. جميع الحقول مطلوبة.",
    notice: "بعد إنشاء الحساب نعرض لك رمز استرجاع مرة واحدة. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.",
    needUsername: "أدخل اسم المستخدم.",
    needPassword: "أدخل كلمة المرور.",
    needConfirmation: "أكّد كلمة المرور.",
    consentRequired: "يلزم الموافقة على شروط الاستخدام وبيان الخصوصية لإنشاء الحساب.",
    chars: "يقبل اسم المستخدم حروفًا عربية أو إنجليزية وأرقامًا وشرطة سفلية فقط.",
    length: "اسم المستخدم من ٣ إلى ٢٤ حرفًا.",
    passwordMin: "كلمة المرور ١٥ حرفًا على الأقل.",
    mismatch: "كلمتا المرور غير متطابقتين.",
    summary4: "يوجد ٤ أخطاء في النموذج",
    summary2: "يوجد خطآن في النموذج",
    summary3: "يوجد ٣ أخطاء في النموذج",
    taken: "اسم المستخدم غير متاح. اختر اسمًا آخر.",
    takenHint: "إن كنت قد أنشأت هذا الحساب قبل لحظات فسجّل الدخول بدل ذلك.",
    uncertain: "تعذّر تأكيد إنشاء الحساب. إن كان قد أُنشئ فسجّل الدخول بالاسم وكلمة المرور ثم أنشئ رمز استرجاع جديدًا من الإعدادات؛ وإلا أعد المحاولة.",
    termsUpdated: "تحدّثت الشروط. أعد تحميل الصفحة لقراءة الإصدار الأحدث.",
    internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
    unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
    origin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
    reload: "إعادة تحميل الصفحة",
    offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
    backOnline: "عاد الاتصال.",
    throttle: "محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.",
    lock: "محاولات كثيرة. يمكنك المحاولة بعد ١٥:٠٠.",
    again: "يمكنك المحاولة الآن.",
    processing: "ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.",
    ready: "الخادم جاهز. يمكنك المحاولة الآن.",
    clock20: "٠٠:٢٠",
    clock19: "٠٠:١٩",
    recoveryHeading: "حفظ رمز الاسترجاع",
    loginHeading: "الدخول",
  },
  en: {
    heading: "Create an account",
    username: "Username",
    password: "Password",
    confirmation: "Confirm password",
    consent: "I have read the terms of use and privacy statement and I agree to them.",
    submit: "Create account",
    loading: "Creating your account…",
    show: "Show password",
    hide: "Hide password",
    termsLink: "Terms of use and privacy statement",
    termsOfUse: "Terms of use",
    privacy: "Privacy statement",
    login: "Log in",
    back: "Back to Browse books",
    lead: "We do not ask for an email address, phone number or date of birth; only a username and a password. All fields are required.",
    notice: "After you create the account we show you a recovery code once. If you lose both your password and the code, we cannot recover your account.",
    needUsername: "Enter a username.",
    needPassword: "Enter a password.",
    needConfirmation: "Confirm the password.",
    consentRequired: "You must agree to the terms of use and privacy statement to create an account.",
    chars: "A username can contain only Arabic or English letters, digits and underscore.",
    length: "The username must be 3 to 24 characters.",
    passwordMin: "The password must be at least 15 characters.",
    mismatch: "The two passwords do not match.",
    summary4: "There are 4 errors in the form",
    summary2: "There are 2 errors in the form",
    summary3: "There are 3 errors in the form",
    taken: "This username is not available. Choose another.",
    takenHint: "If you created this account a moment ago, log in instead.",
    uncertain: "We could not confirm that the account was created. If it was, log in with your username and password and create a new recovery code in Settings; otherwise try again.",
    termsUpdated: "The terms were updated. Reload the page to read the latest version.",
    internal: "Something unexpected happened. Try again.",
    unavailable: "The service is temporarily unavailable. Try again shortly.",
    origin: "The request could not be completed. Reload the page and try again.",
    reload: "Reload page",
    offline: "There is no network connection. Check your connection and try again.",
    backOnline: "The connection is back.",
    throttle: "Too many attempts. Wait 20 seconds and try again.",
    lock: "Too many attempts. You can try again in 15:00.",
    again: "You can try again now.",
    processing: "We are still processing your request; this may take a moment.",
    ready: "The server is ready. You can try again now.",
    clock20: "00:20",
    clock19: "00:19",
    recoveryHeading: "Save your recovery code",
    loginHeading: "Log in",
  },
} as const;

const envelope = (code: string, details: Record<string, unknown> = {}) => ({ error: { code, message: "Safe text.", details } });

const alerts = (page: Page) => page.locator("[role=alert]:not(#__next-route-announcer__)");
const polite = (page: Page) => page.locator("[role=status][aria-live=polite]");
const usernameField = (page: Page, language: Language) => page.getByRole("textbox", { name: COPY[language].username });
const passwordField = (page: Page, language: Language) => page.getByLabel(COPY[language].password, { exact: true });
const confirmationField = (page: Page, language: Language) => page.getByLabel(COPY[language].confirmation, { exact: true });
const consentBox = (page: Page, language: Language) => page.getByRole("checkbox", { name: COPY[language].consent });
const submitButton = (page: Page, language: Language) => page.getByRole("button", { name: new RegExp(`^(${COPY[language].submit}|${COPY[language].loading})$`) });
const backControl = (page: Page, language: Language) => page.getByRole("link", { name: COPY[language].back });

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// Opens /register once React has hydrated (the first health request is the sign), with E01 and the session probe under control.
async function openRegister(page: Page, { language = "ar", viewport = VIEWPORTS.phone, mode = "ok" }: { language?: Language; viewport?: { width: number; height: number }; mode?: HealthMode } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, mode);
  await page.goto("/register");
  await waitForFirstHealthRequest(health);
  return health;
}

// Opens /login, then goes to /register by the link of S-01, so the history holds both and the visit is a client navigation.
async function openFromLogin(page: Page) {
  const health = await controlHealth(page, "ok");
  await page.goto("/login");
  await waitForFirstHealthRequest(health);
  await page.getByRole("link", { name: "إنشاء حساب" }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole("heading", { level: 1, name: COPY.ar.heading })).toBeVisible();
}

// Answers E03 from `answer`, a function (so a test can change its mind mid-run), "abort" (no answer at all) or "hang" (never answers).
async function serveRegister(page: Page, answer: Answer | (() => Answer) | "abort" | "hang") {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/auth/register", async (route: Route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    if (answer === "hang") return;
    if (answer === "abort") return route.abort("failed");
    const { status, body, headers } = typeof answer === "function" ? answer() : answer;
    await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store", ...headers }, body: JSON.stringify(body) });
  });
  return sent;
}

const created = (): Answer => ({ status: 201, body: { profile: mockProfile, recoveryCode: MOCK_RECOVERY_CODE } });

interface Values {
  username?: string;
  password?: string;
  confirmation?: string;
  consent?: boolean;
}

async function fill(page: Page, language: Language, { username = "fresh_user_01", password = MOCK_PASSWORD, confirmation = password, consent = true }: Values = {}) {
  await usernameField(page, language).fill(username);
  await passwordField(page, language).fill(password);
  await confirmationField(page, language).fill(confirmation);
  if (consent) await consentBox(page, language).check();
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("no bounding box");
  return result;
}

// The 2 px ring and the border of a text field sit on its box, because the input inside has no outline of its own.
const fieldBox = (page: Page, language: Language, which: "username" | "password" | "confirmation") =>
  (which === "username" ? usernameField(page, language) : which === "password" ? passwordField(page, language) : confirmationField(page, language)).locator("xpath=..");

// The drawn 24 px box of the consent checkbox: the native input lies over it.
const drawnBox = (page: Page, language: Language) => consentBox(page, language).locator("xpath=..");

const style = (locator: Locator, properties: string[]) => locator.evaluate((element, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])), properties);

test.describe("layout and design (UI-screens S-02 sections 2, 5 and 6)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: the heading, the lead, the terms link, the fields, the notice, the consent block, the button and the login line, top to bottom, in one column`, async ({ page }) => {
      await openRegister(page, { language });
      const copy = COPY[language];
      const order = [
        page.getByRole("heading", { level: 1, name: copy.heading }),
        page.getByText(copy.lead),
        page.getByRole("link", { name: copy.termsLink, exact: true }),
        fieldBox(page, language, "username"),
        fieldBox(page, language, "password"),
        fieldBox(page, language, "confirmation"),
        page.getByText(copy.notice),
        consentBox(page, language).locator("xpath=ancestor::label"),
        page.getByRole("link", { name: copy.termsOfUse, exact: true }),
        page.getByRole("link", { name: copy.privacy, exact: true }),
        submitButton(page, language),
        page.getByRole("link", { name: copy.login, exact: true }),
      ];
      const ys = await Promise.all(order.map(async (item) => (await box(item)).y));
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
      // One column: the three fields and the button start and end at the same two edges.
      const columns = await Promise.all([fieldBox(page, language, "username"), fieldBox(page, language, "password"), fieldBox(page, language, "confirmation"), submitButton(page, language)].map((item) => box(item)));
      for (const column of columns) {
        expect(Math.round(column.x)).toBe(Math.round(columns[0]?.x ?? 0));
        expect(Math.round(column.width)).toBe(Math.round(columns[0]?.width ?? 0));
      }
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.getByRole("banner")).toBeVisible();
    });

    test(`${language}: no horizontal scroll at 320, 360, 1280 px, and none at 200 % text zoom on 320 px`, async ({ page }) => {
      await openRegister(page, { language });
      for (const width of [320, 360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        expect(scrollWidth, `${width} px`).toBeLessThanOrEqual(clientWidth);
      }
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });
  }

  test("the column is the viewport minus the 24 px margins on a phone, and 480 px, centred, from 560 px", async ({ page }) => {
    await openRegister(page, { viewport: { width: 360, height: 800 } });
    const phone = await box(fieldBox(page, "ar", "username"));
    expect(Math.round(phone.x)).toBe(24);
    expect(Math.round(phone.width)).toBe(360 - 48);
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = await box(fieldBox(page, "ar", "username"));
    expect(Math.round(desktop.width)).toBe(480);
    expect(Math.round(desktop.x)).toBe((1280 - 480) / 2);
    await page.setViewportSize({ width: 600, height: 800 });
    expect(Math.round((await box(fieldBox(page, "ar", "username"))).width)).toBe(480);
  });

  test("fields and button are 48 px high, the toggles are 44 by 44, the box row and each link are at least 44 px, and every target is reachable", async ({ page }) => {
    await openRegister(page);
    for (const which of ["username", "password", "confirmation"] as const) expect(Math.round((await box(fieldBox(page, "ar", which))).height), which).toBe(48);
    expect(Math.round((await box(submitButton(page, "ar"))).height)).toBe(48);
    for (const toggle of await page.getByRole("button", { name: COPY.ar.show }).all()) {
      const size = await box(toggle);
      expect([Math.round(size.width), Math.round(size.height)]).toEqual([44, 44]);
    }
    expect((await box(consentBox(page, "ar").locator("xpath=ancestor::label"))).height).toBeGreaterThanOrEqual(44);
    for (const name of [COPY.ar.termsLink, COPY.ar.termsOfUse, COPY.ar.privacy, COPY.ar.login]) {
      expect((await box(page.getByRole("link", { name, exact: true }))).height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await smallTargets(page)).toEqual([]);
  });

  test("the box row and the two link lines are 8 px apart, and the fields are 16 px apart", async ({ page }) => {
    await openRegister(page);
    const row = await box(consentBox(page, "ar").locator("xpath=ancestor::label"));
    const termsOfUse = await box(page.getByRole("link", { name: COPY.ar.termsOfUse, exact: true }));
    const privacy = await box(page.getByRole("link", { name: COPY.ar.privacy, exact: true }));
    expect(Math.round(termsOfUse.y - (row.y + row.height))).toBe(8);
    expect(Math.round(privacy.y - (termsOfUse.y + termsOfUse.height))).toBe(8);
    // The label above a field belongs to it; the helper sits under the box; the next label follows 16 px below the helper.
    const username = await box(fieldBox(page, "ar", "username"));
    const usernameHelper = await box(page.getByText("من ٣ إلى ٢٤ حرفًا: حروف عربية أو إنجليزية وأرقام وشرطة سفلية (_)."));
    const passwordLabel = await box(page.locator("label", { hasText: COPY.ar.password }).first());
    expect(Math.round(usernameHelper.y - (username.y + username.height))).toBe(8);
    expect(Math.round(passwordLabel.y - (usernameHelper.y + usernameHelper.height))).toBe(16);
  });

  test("type and colour follow the tokens: title 22 px bold, labels 15 px semibold, helpers and the notice 14 px secondary, inputs 16 px, the box label 16 px", async ({ page }) => {
    await openRegister(page);
    expect(await style(page.getByRole("heading", { level: 1 }), ["font-size", "font-weight", "color"])).toEqual({ "font-size": "22px", "font-weight": "700", color: "rgb(24, 59, 82)" });
    expect(await style(page.locator("label", { hasText: COPY.ar.username }).first(), ["font-size", "font-weight"])).toEqual({ "font-size": "15px", "font-weight": "600" });
    for (const text of ["من ٣ إلى ٢٤ حرفًا: حروف عربية أو إنجليزية وأرقام وشرطة سفلية (_).", "١٥ حرفًا على الأقل. يمكنك استخدام عبارة طويلة، ومدير كلمات المرور مقبول.", COPY.ar.notice]) {
      expect(await style(page.getByText(text), ["font-size", "color"]), text).toEqual({ "font-size": "14px", color: "rgb(83, 110, 130)" });
    }
    expect((await style(usernameField(page, "ar"), ["font-size"]))["font-size"]).toBe("16px");
    expect((await style(page.getByText(COPY.ar.lead), ["font-size", "color"]))).toEqual({ "font-size": "16px", color: "rgb(24, 59, 82)" });
    expect((await style(page.getByText(COPY.ar.consent, { exact: true }), ["font-size", "color"]))).toEqual({ "font-size": "16px", color: "rgb(24, 59, 82)" });
    expect(await style(submitButton(page, "ar"), ["background-color", "color", "font-weight"])).toEqual({ "background-color": "rgb(29, 120, 181)", color: "rgb(255, 255, 255)", "font-weight": "600" });
    expect(await style(page.getByRole("link", { name: COPY.ar.termsOfUse, exact: true }), ["color", "text-decoration-line"])).toEqual({ color: "rgb(23, 79, 118)", "text-decoration-line": "underline" });
  });

  test("the toggles sit at the end edge inside their fields: left in Arabic, right in English, and typed Latin text never runs under them", async ({ page }) => {
    for (const language of ["ar", "en"] as const) {
      await openRegister(page, { language });
      await passwordField(page, language).fill("a long latin passphrase typed here");
      const toggles = await page.getByRole("button", { name: new RegExp(`^(${COPY[language].show}|${COPY[language].hide})$`) }).all();
      expect(toggles).toHaveLength(2);
      for (const [index, which] of (["password", "confirmation"] as const).entries()) {
        const field = await box(fieldBox(page, language, which));
        const toggle = await box(toggles[index] as Locator);
        const centre = toggle.x + toggle.width / 2;
        if (language === "ar") expect(centre).toBeLessThan(field.x + field.width / 2);
        else expect(centre).toBeGreaterThan(field.x + field.width / 2);
        expect(toggle.x).toBeGreaterThanOrEqual(field.x);
        expect(toggle.x + toggle.width).toBeLessThanOrEqual(field.x + field.width);
        const input = await box(which === "password" ? passwordField(page, language) : confirmationField(page, language));
        expect(input.x + input.width <= toggle.x + 1 || input.x >= toggle.x + toggle.width - 1).toBe(true);
      }
    }
  });

  test("the header holds the back control at the start edge and the switch at the end edge, and no lockup", async ({ page }) => {
    for (const language of ["ar", "en"] as const) {
      await openRegister(page, { language });
      const header = page.getByRole("banner");
      await expect(header.getByRole("link")).toHaveCount(1);
      await expect(header.getByRole("radio")).toHaveCount(2);
      const back = await box(backControl(page, language));
      const group = await box(header.getByRole("radiogroup"));
      expect([Math.round(back.width), Math.round(back.height)]).toEqual([44, 44]);
      if (language === "ar") {
        expect(back.x).toBeGreaterThan(VIEWPORTS.phone.width / 2);
        expect(group.x).toBeLessThan(VIEWPORTS.phone.width / 2);
      } else {
        expect(back.x).toBeLessThan(VIEWPORTS.phone.width / 2);
        expect(group.x).toBeGreaterThan(VIEWPORTS.phone.width / 2);
      }
    }
  });

  test("the back arrow mirrors in right-to-left and not in left-to-right, and the droplet and the check do not mirror", async ({ page }) => {
    await openRegister(page, { language: "ar" });
    expect((await style(backControl(page, "ar").locator("svg"), ["scale"])).scale).toMatch(/^-1/);
    await page.getByRole("radio", { name: "English (EN)" }).check();
    await expect(page.getByRole("heading", { level: 1, name: COPY.en.heading })).toBeVisible();
    expect((await style(backControl(page, "en").locator("svg"), ["scale"])).scale).toBe("none");
    await expect(page.getByText(COPY.en.consent, { exact: true })).toBeVisible();
    expect((await style(drawnBox(page, "en").locator("svg"), ["scale"])).scale).toBe("none");
  });

  test("the recovery-code notice has a glyph at the start edge and no fill", async ({ page }) => {
    await openRegister(page);
    const notice = page.getByText(COPY.ar.notice).locator("xpath=ancestor::p");
    expect((await style(notice, ["background-color"]))["background-color"]).toBe("rgba(0, 0, 0, 0)");
    const glyph = await box(notice.locator("svg"));
    const text = await box(page.getByText(COPY.ar.notice));
    // In Arabic the start edge is the right one.
    expect(glyph.x).toBeGreaterThan(text.x);
    await expect(notice.locator("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

test.describe("the consent box (UI-tokens 6.3, D52)", () => {
  test("is 24 px with a 2 px border, unchecked at first, in a row that is the target, and its label is exactly the sentence", async ({ page }) => {
    await openRegister(page);
    const input = consentBox(page, "ar");
    await expect(input).not.toBeChecked();
    await expect(input).toHaveAttribute("aria-required", "true");
    const drawn = drawnBox(page, "ar");
    const size = await box(drawn);
    expect([Math.round(size.width), Math.round(size.height)]).toEqual([24, 24]);
    expect(await style(drawn, ["border-top-width", "border-top-color", "background-color", "border-top-left-radius"])).toEqual({
      "border-top-width": "2px",
      "border-top-color": "rgb(120, 144, 163)",
      "background-color": "rgb(255, 255, 255)",
      "border-top-left-radius": "4px",
    });
    expect((await style(drawn.locator("svg"), ["opacity"])).opacity).toBe("0");
    // The two links are outside the label.
    await expect(consentBox(page, "ar").locator("xpath=ancestor::label").getByRole("link")).toHaveCount(0);
    // A press on the sentence ticks it: the label is part of the target.
    await page.getByText(COPY.ar.consent, { exact: true }).click();
    await expect(input).toBeChecked();
  });

  test("checked, it fills with the primary colour and shows a white check; Space toggles it and Enter sends the form", async ({ page }) => {
    await openRegister(page);
    const input = consentBox(page, "ar");
    await input.focus();
    await page.keyboard.press("Space");
    await expect(input).toBeChecked();
    const drawn = drawnBox(page, "ar");
    await expect.poll(async () => (await style(drawn, ["background-color", "border-top-color"]))["background-color"]).toBe("rgb(29, 120, 181)");
    expect((await style(drawn, ["border-top-color"]))["border-top-color"]).toBe("rgb(29, 120, 181)");
    expect((await style(drawn.locator("svg"), ["opacity", "color"]))).toEqual({ opacity: "1", color: "rgb(255, 255, 255)" });
    await page.keyboard.press("Space");
    await expect(input).not.toBeChecked();

    // Enter on the box sends the form: here nothing is typed, so the answer is the field errors.
    await page.keyboard.press("Enter");
    await expect(alerts(page)).toContainText(COPY.ar.summary4);
  });

  test("unticked at submit it shows the error recipe, takes focus, and the request is not sent", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, created());
    await fill(page, "ar", { consent: false });
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveCount(0);
    await expect(consentBox(page, "ar")).toBeFocused();
    await expect(consentBox(page, "ar")).toHaveAttribute("aria-invalid", "true");
    await expect.poll(async () => (await style(drawnBox(page, "ar"), ["border-top-color"]))["border-top-color"]).toBe("rgb(192, 54, 44)");
    const message = page.locator("p", { hasText: COPY.ar.consentRequired });
    expect((await style(message, ["color"])).color).toBe("rgb(168, 50, 45)");
    await expect(message.locator("svg")).toHaveAttribute("aria-hidden", "true");
    expect(sent).toHaveLength(0);

    await consentBox(page, "ar").check();
    await expect(page.getByText(COPY.ar.consentRequired)).toHaveCount(0);
  });

  test("the focus ring goes around the whole row: 2 px in the focus colour, 2 px away", async ({ page }) => {
    await openRegister(page);
    await consentBox(page, "ar").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const ring = await consentBox(page, "ar").evaluate((input) => {
      const row = input.closest("label") as HTMLElement;
      const computed = getComputedStyle(row);
      return `${computed.outlineStyle} ${computed.outlineWidth} ${computed.outlineColor} ${computed.outlineOffset}`;
    });
    expect(ring).toBe("solid 2px rgb(23, 79, 118) 2px");
  });
});

test.describe("keyboard and focus (S-02 section 5)", () => {
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
    test(`${language}: Tab goes skip link, back, switch, terms link, the three fields with their toggles, the box, the two links, the button, the login link, and nothing traps`, async ({ page }) => {
      await openRegister(page, { language });
      const copy = COPY[language];
      expect(await tabLabels(page, 14)).toEqual([
        language === "ar" ? "انتقل إلى المحتوى" : "Skip to content",
        copy.back,
        language === "ar" ? "العربية" : "English (EN)",
        copy.termsLink,
        copy.username,
        copy.password,
        copy.show,
        copy.confirmation,
        copy.show,
        copy.consent,
        copy.termsOfUse,
        copy.privacy,
        copy.submit,
        copy.login,
      ]);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: copy.login, exact: true })).not.toBeFocused();
    });
  }

  test("every stop shows a 2 px focus ring in the focus colour: on the field boxes, the box row, the buttons and the links", async ({ page }) => {
    await openRegister(page);
    const rings: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      await page.keyboard.press("Tab");
      rings.push(
        await page.evaluate(() => {
          const element = document.activeElement as HTMLElement;
          // A text field draws its ring on the box around it, a checkbox on its row.
          const host =
            element instanceof HTMLInputElement && element.type === "checkbox"
              ? (element.closest("label") as HTMLElement)
              : element instanceof HTMLInputElement && element.type !== "radio"
                ? (element.parentElement as HTMLElement)
                : element;
          const computed = getComputedStyle(host);
          return `${computed.outlineStyle} ${computed.outlineWidth} ${computed.outlineColor}`;
        }),
      );
    }
    // The radio of the switch draws its ring on its label (F0); the other thirteen stops are checked here.
    for (const [index, ring] of rings.entries()) if (index !== 2) expect(ring, `stop ${index}`).toBe("solid 2px rgb(23, 79, 118)");
  });

  test("the toggles operate by Space and Enter, name their action, keep focus and never send the form", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, created());
    await passwordField(page, "ar").fill("a long synthetic phrase");
    const first = page.getByRole("button", { name: COPY.ar.show }).first();
    await first.focus();
    await page.keyboard.press("Space");
    await expect(passwordField(page, "ar")).toHaveAttribute("type", "text");
    await expect(confirmationField(page, "ar")).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: COPY.ar.hide })).toBeFocused();
    await expect(page.getByRole("button", { name: COPY.ar.hide })).not.toHaveAttribute("aria-pressed");
    await page.keyboard.press("Enter");
    await expect(passwordField(page, "ar")).toHaveAttribute("type", "password");
    expect(sent).toHaveLength(0);
  });

  test("there is no autofocus on the first load, and a link to /register puts focus on the heading", async ({ page }) => {
    await openRegister(page);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");

    await page.goto("/login");
    await page.getByRole("link", { name: "إنشاء حساب" }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.heading })).toBeFocused();
  });

  test("the back control goes to /login and the focus lands on its heading", async ({ page }) => {
    await openRegister(page);
    await backControl(page, "ar").click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.loginHeading })).toBeFocused();
  });

  test("the login link goes to /login too", async ({ page }) => {
    await openRegister(page);
    await page.getByRole("link", { name: COPY.ar.login, exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the language switch keeps what was typed, the box and the errors, rewords them and leaves focus on the switch", async ({ page }) => {
    await openRegister(page);
    await fill(page, "ar", { username: "fresh_user_01", password: "short", confirmation: "", consent: false });
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary3);
    await page.getByRole("radio", { name: "English (EN)" }).check();
    await expect(page.getByRole("heading", { level: 1, name: COPY.en.heading })).toBeVisible();
    await expect(usernameField(page, "en")).toHaveValue("fresh_user_01");
    await expect(passwordField(page, "en")).toHaveValue("short");
    await expect(alerts(page)).toContainText(COPY.en.summary3);
    await expect(page.getByText(COPY.en.passwordMin, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("radio", { name: "English (EN)" })).toBeFocused();
    expect(await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir])).toEqual(["en", "ltr"]);
  });
});

test.describe("validation (P-03)", () => {
  test.use({ allowFailedRequests: true });

  test("nothing is checked while typing; a field is checked when it loses focus, and an empty one is not", async ({ page }) => {
    await openRegister(page);
    await usernameField(page, "ar").pressSequentially("a-");
    await page.waitForTimeout(150);
    await expect(usernameField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Tab");
    await expect(usernameField(page, "ar")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(COPY.ar.chars)).toBeVisible();
    // An empty field that loses focus says nothing.
    await passwordField(page, "ar").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    await expect(passwordField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("blur errors never raise the summary, and the next blur clears an error that is fixed", async ({ page }) => {
    await openRegister(page);
    await usernameField(page, "ar").fill("ab");
    await passwordField(page, "ar").fill("short");
    await confirmationField(page, "ar").fill("short");
    await confirmationField(page, "ar").blur();
    await expect(page.getByText(COPY.ar.length)).toBeVisible();
    await expect(page.getByText(COPY.ar.passwordMin, { exact: true }).first()).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);

    await usernameField(page, "ar").fill("abc");
    await usernameField(page, "ar").blur();
    await expect(page.getByText(COPY.ar.length)).toHaveCount(0);
    await expect(usernameField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
  });

  test("the confirmation is compared when either password field loses focus", async ({ page }) => {
    await openRegister(page);
    await passwordField(page, "ar").fill(MOCK_PASSWORD);
    await confirmationField(page, "ar").fill(`${MOCK_PASSWORD}!`);
    await confirmationField(page, "ar").blur();
    await expect(page.getByText(COPY.ar.mismatch)).toBeVisible();
    await passwordField(page, "ar").fill(`${MOCK_PASSWORD}!`);
    await passwordField(page, "ar").blur();
    await expect(page.getByText(COPY.ar.mismatch)).toHaveCount(0);
    await passwordField(page, "ar").fill(`${MOCK_PASSWORD}?`);
    await passwordField(page, "ar").blur();
    await expect(page.getByText(COPY.ar.mismatch)).toBeVisible();
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: an empty form gives a summary alert with four links, focus on the username, nothing sent`, async ({ page }) => {
      await openRegister(page, { language });
      const sent = await serveRegister(page, created());
      const copy = COPY[language];
      await submitButton(page, language).click();

      await expect(alerts(page)).toHaveCount(1);
      await expect(alerts(page)).toContainText(copy.summary4);
      for (const name of [copy.needUsername, copy.needPassword, copy.needConfirmation, copy.consentRequired]) {
        await expect(alerts(page).getByRole("link", { name })).toBeVisible();
      }
      await expect(usernameField(page, language)).toBeFocused();
      for (const field of [usernameField(page, language), passwordField(page, language), confirmationField(page, language), consentBox(page, language)]) {
        await expect(field).toHaveAttribute("aria-invalid", "true");
      }
      expect(sent).toHaveLength(0);
      await alerts(page).getByRole("link", { name: copy.needConfirmation }).click();
      await expect(confirmationField(page, language)).toBeFocused();
      await alerts(page).getByRole("link", { name: copy.consentRequired }).click();
      await expect(consentBox(page, language)).toBeFocused();
    });
  }

  test("the summary names the number in Arabic: the dual for two, the plural for three", async ({ page }) => {
    await openRegister(page);
    await fill(page, "ar", { username: "ab", consent: false });
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary2);
    await fill(page, "ar", { username: "ab", password: "short", confirmation: "short", consent: false });
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary3);
  });

  test("one error gives its message under the field and no summary, with the field focused", async ({ page }) => {
    await openRegister(page);
    await fill(page, "ar", { consent: false });
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveCount(0);
    await expect(consentBox(page, "ar")).toBeFocused();
    const described = await consentBox(page, "ar").evaluate((input) => document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent);
    expect(described).toBe(COPY.ar.consentRequired);
  });

  test("a field in error has the 2 px error border and its message carries a glyph, never colour alone", async ({ page }) => {
    await openRegister(page);
    await fill(page, "ar", { username: "ab" });
    await submitButton(page, "ar").click();
    const readBox = () => fieldBox(page, "ar", "username").evaluate((element) => ({ border: getComputedStyle(element).borderTopColor, shadow: getComputedStyle(element).boxShadow }));
    await expect.poll(async () => (await readBox()).border).toBe("rgb(192, 54, 44)");
    expect((await readBox()).shadow).toContain("rgb(192, 54, 44)");
    const message = page.locator("p", { hasText: COPY.ar.length });
    expect((await style(message, ["color"])).color).toBe("rgb(168, 50, 45)");
    await expect(message.locator("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("a press on the button straight after editing a field is not lost, although the message under the field appears with the blur", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, created());
    await fill(page, "ar");
    // fill() leaves the cursor in the field; the click then blurs it, which adds its message and would move the button.
    await passwordField(page, "ar").fill("short phrase");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary2);
    await expect(passwordField(page, "ar")).toBeFocused();
    await expect(page.getByText(COPY.ar.passwordMin, { exact: true }).first()).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  test("a press on the button straight after fixing a field is not lost, although the message above it leaves with the blur", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, created());
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary4);
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect.poll(() => sent.length).toBe(1);
  });

  test("a password of fifteen spaces is accepted and goes as typed; a username with a space is an error and is not trimmed", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, created());
    await fill(page, "ar", { username: "fresh user", password: " ".repeat(15) });
    await submitButton(page, "ar").click();
    await expect(usernameField(page, "ar")).toHaveAttribute("aria-invalid", "true");
    await expect(passwordField(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
    expect(sent).toHaveLength(0);
    await usernameField(page, "ar").fill("fresh_user");
    await submitButton(page, "ar").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ username: "fresh_user", password: " ".repeat(15) });
  });
});

test.describe("sending E03 and leaving (S-02 section 1)", () => {
  test("the request is a same-origin JSON POST with the contract's six fields, and the page goes to the recovery-code screen by replace, with nothing stored", async ({ page }) => {
    await openFromLogin(page);
    const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/register")) requests.push({ method: request.method(), url: request.url(), headers: request.headers() });
    });
    const sent = await serveRegister(page, created());
    await page.evaluate(() => localStorage.clear());
    await fill(page, "ar");
    await submitButton(page, "ar").click();

    await expect(page).toHaveURL(/\/recovery-code$/);
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.recoveryHeading })).toBeFocused();
    expect(sent).toEqual([{ username: "fresh_user_01", password: MOCK_PASSWORD, timeZone: expect.any(String), language: "ar", termsAccepted: true, termsVersion: "2026-10-04" }]);
    expect((sent[0] as { timeZone: string }).timeZone).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").origin).toBe(new URL(page.url()).origin);
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(Object.keys(requests[0]?.headers ?? {})).not.toContain("authorization");
    expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)])).toEqual([[], []]);
    // The code is in memory only: not in the page, the address or the history state.
    expect(await page.locator("body").innerText()).not.toContain(MOCK_RECOVERY_CODE.slice(0, 9));
    expect(page.url()).not.toContain("0123");
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain("0123");
  });

  test("the form is replaced in the history: back from the next screen goes to the page before it, never to the filled form", async ({ page }) => {
    await openFromLogin(page);
    await serveRegister(page, created());
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/recovery-code$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the language of the page and the zone of the browser are what is sent", async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: "Asia/Dubai", locale: "en-US" });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    const health = await controlHealth(page, "ok");
    await page.goto("/register");
    await waitForFirstHealthRequest(health);
    const sent = await serveRegister(page, created());
    await fill(page, "en");
    await submitButton(page, "en").click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ language: "en", timeZone: "Asia/Dubai" });
    await context.close();
  });

  test("a visitor with a valid session is sent away at once: to /today with a plan, to /start without one (guard 2)", async ({ page }) => {
    await page.route("**/api/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockProfile) }));
    await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: null, learningDate: "2026-10-05", dailyActiveMs: 0, dailyGoalMs: 600000, dailyPercent: 0, dailyCompleted: false, extraActiveMs: 0, dueReviews: 0, nextNewPassage: null, openSessionId: null, streakDays: 0 }) }));
    await page.goto("/register");
    await expect(page).toHaveURL(/\/start$/);
  });
});

test.describe("the terms screen and the form (S-02 Dialogs)", () => {
  test("opening S-03 and coming back brings every typed value, the passwords and the box back; a reload does not", async ({ page }) => {
    await openRegister(page);
    await fill(page, "ar", { username: "sample_user", password: "first synthetic phrase", confirmation: "second synthetic phrase" });
    await page.getByRole("link", { name: COPY.ar.privacy, exact: true }).click();
    await expect(page).toHaveURL(/\/terms#privacy$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/register$/);
    await expect(usernameField(page, "ar")).toHaveValue("sample_user");
    await expect(passwordField(page, "ar")).toHaveValue("first synthetic phrase");
    await expect(passwordField(page, "ar")).toHaveAttribute("type", "password");
    await expect(confirmationField(page, "ar")).toHaveValue("second synthetic phrase");
    await expect(consentBox(page, "ar")).toBeChecked();

    await page.reload();
    await expect(usernameField(page, "ar")).toHaveValue("");
    await expect(passwordField(page, "ar")).toHaveValue("");
    await expect(consentBox(page, "ar")).not.toBeChecked();
  });

  test("each of the three links opens /terms, two with their anchor, and each keeps the form", async ({ page }) => {
    await openRegister(page);
    for (const [name, url] of [
      [COPY.ar.termsLink, /\/terms$/],
      [COPY.ar.termsOfUse, /\/terms#terms$/],
      [COPY.ar.privacy, /\/terms#privacy$/],
    ] as const) {
      await usernameField(page, "ar").fill("sample_user");
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(url);
      await page.goBack();
      await expect(usernameField(page, "ar")).toHaveValue("sample_user");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
  });

  test("nothing of the form is kept in the browser's storage while S-03 is open", async ({ page }) => {
    await openRegister(page);
    await fill(page, "ar", { password: "first synthetic secret" });
    await page.getByRole("link", { name: COPY.ar.termsOfUse, exact: true }).click();
    await expect(page).toHaveURL(/\/terms#terms$/);
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, history.state, document.cookie]))).not.toContain("secret");
  });

  test("the register screen loads the terms route ahead of the press", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("terms")) requested.push(`${request.resourceType()} ${url.pathname}${url.search}`);
    });
    await openRegister(page);
    await expect.poll(() => requested.length, { message: "a request for the terms route before any press", timeout: 8_000 }).toBeGreaterThan(0);
  });
});

test.describe("the loading state (S-02 section 4)", () => {
  test("the button shows its loading label and a spinner, is busy, keeps focus and the values, and a second press sends nothing", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, "hang");
    await fill(page, "ar");
    const button = submitButton(page, "ar");
    await button.click();
    await expect(page.getByRole("button", { name: COPY.ar.loading })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: COPY.ar.loading })).toBeFocused();
    await expect(usernameField(page, "ar")).toHaveValue("fresh_user_01");
    await expect(passwordField(page, "ar")).toHaveValue(MOCK_PASSWORD);
    await expect(confirmationField(page, "ar")).toHaveValue(MOCK_PASSWORD);
    await expect(consentBox(page, "ar")).toBeChecked();
    await expect(polite(page).filter({ hasText: "جارٍ إنشاء الحساب" }).first()).toBeAttached();
    await button.click();
    await confirmationField(page, "ar").press("Enter");
    expect(sent).toHaveLength(1);
  });

  test("the spinner turns normally and is a static ring under reduced motion", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, "hang");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    const spinner = page.getByRole("button", { name: COPY.ar.loading }).locator("span[aria-hidden=true]");
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("spin");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  });

  test("after 5 s the polite line says it is still working", async ({ page }) => {
    await page.clock.install();
    await openRegister(page);
    await serveRegister(page, "hang");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await page.clock.runFor(4_500);
    await expect(page.getByText(COPY.ar.processing)).toHaveCount(0);
    await page.clock.runFor(1_000);
    await expect(polite(page).filter({ hasText: COPY.ar.processing })).toBeVisible();
  });
});

test.describe("E03 errors (P-06, P-07, P-10)", () => {
  test.use({ allowFailedRequests: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: a taken name is a field error at the username with the values kept and the username focused`, async ({ page }) => {
      await openRegister(page, { language });
      await serveRegister(page, { status: 409, body: envelope("username_taken") });
      await fill(page, language);
      await submitButton(page, language).click();
      await expect(page.getByText(COPY[language].taken)).toBeVisible();
      await expect(usernameField(page, language)).toBeFocused();
      await expect(usernameField(page, language)).toHaveAttribute("aria-invalid", "true");
      await expect(usernameField(page, language)).toHaveValue("fresh_user_01");
      await expect(passwordField(page, language)).toHaveValue(MOCK_PASSWORD);
      await expect(consentBox(page, language)).toBeChecked();
      await expect(alerts(page)).toHaveCount(0);
      await expect(page.getByText(COPY[language].takenHint)).toHaveCount(0);

      // It goes when the name is edited, and not before.
      await usernameField(page, language).blur();
      await page.waitForTimeout(100);
      await expect(page.getByText(COPY[language].taken)).toBeVisible();
      await usernameField(page, language).pressSequentially("2");
      await expect(page.getByText(COPY[language].taken)).toHaveCount(0);
    });
  }

  test("a taken name after an answer that never came carries the hint and a link to the login screen", async ({ page }) => {
    await openRegister(page);
    // The first attempt gets no answer at all; every later one is answered: the name is taken.
    let first = true;
    await page.route("**/api/auth/register", async (route) => {
      if (first) {
        first = false;
        return route.abort("failed");
      }
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(envelope("username_taken")) });
    });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(polite(page).filter({ hasText: COPY.ar.uncertain })).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);

    await submitButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.takenHint)).toBeVisible();
    await expect(page.getByText(COPY.ar.taken)).toBeVisible();
    const hintLink = page.getByText(COPY.ar.takenHint).locator("xpath=..").getByRole("link", { name: COPY.ar.login });
    await expect(hintLink).toHaveAttribute("href", "/login");
    expect((await box(hintLink)).height).toBeGreaterThanOrEqual(44);
    await expect(page.getByText(COPY.ar.uncertain)).toHaveCount(0);

    await submitButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.takenHint)).toHaveCount(0);
    await expect(page.getByText(COPY.ar.taken)).toBeVisible();
  });

  test("an answer that never comes is a warning that says so, with the values kept, focus on the button and nothing resent", async ({ page }) => {
    await openRegister(page);
    const sent = await serveRegister(page, "abort");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    const banner = polite(page).filter({ hasText: COPY.ar.uncertain });
    await expect(banner).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);
    expect((await box(banner)).y).toBeLessThan((await box(submitButton(page, "ar"))).y);
    await expect(submitButton(page, "ar")).toBeFocused();
    await expect(usernameField(page, "ar")).toHaveValue("fresh_user_01");
    await expect(passwordField(page, "ar")).toHaveValue(MOCK_PASSWORD);
    await page.waitForTimeout(3_500);
    expect(sent).toHaveLength(1);
  });

  test("a terms version this build has not shown is an alert with a reload button that reloads the page and loses the typed values", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 400, body: envelope("terms_required", { requiredVersion: "2099-01-01" }) });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.termsUpdated);
    await expect(consentBox(page, "ar")).not.toHaveAttribute("aria-invalid", "true");
    const reloaded = page.waitForEvent("load");
    await alerts(page).getByRole("button", { name: COPY.ar.reload }).click();
    await reloaded;
    await expect(usernameField(page, "ar")).toHaveValue("");
  });

  test("the version this build shows puts the error at the box", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 400, body: envelope("terms_required", { requiredVersion: "2026-10-04" }) });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.consentRequired)).toBeVisible();
    await expect(consentBox(page, "ar")).toBeFocused();
    await expect(alerts(page)).toHaveCount(0);
  });

  test("validation_error from the server puts the username and password rules at their fields, with the summary from two", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, {
      status: 422,
      body: envelope("validation_error", {
        fields: [
          { field: "username", rule: "username_chars" },
          { field: "password", rule: "password_min_chars" },
        ],
      }),
    });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.summary2);
    await expect(usernameField(page, "ar")).toBeFocused();
    await expect(page.getByText(COPY.ar.chars, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(COPY.ar.passwordMin, { exact: true }).first()).toBeVisible();
  });

  test("a validation_error the learner cannot fix is an unexpected error", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 422, body: envelope("validation_error", { fields: [{ field: "timeZone", rule: "time_zone_invalid" }] }) });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.internal);
  });

  test("500 is a generic alert with the values kept and focus on the button", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 500, body: envelope("internal") });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.internal);
    await expect(usernameField(page, "ar")).toHaveValue("fresh_user_01");
    await expect(submitButton(page, "ar")).toBeFocused();
    const alertBox = await box(alerts(page));
    expect(alertBox.y + alertBox.height).toBeLessThanOrEqual((await box(submitButton(page, "ar"))).y);
    expect(alertBox.y).toBeGreaterThanOrEqual((await box(page.getByText(COPY.ar.notice))).y);
  });

  test("503 is a warning in a polite status area, not an alert", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 503, body: envelope("unavailable") });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(polite(page).filter({ hasText: COPY.ar.unavailable })).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);
    await expect(submitButton(page, "ar")).toBeFocused();
  });

  test("403 forbidden origin gives an alert with a reload button", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 403, body: envelope("forbidden_origin") });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toContainText(COPY.ar.origin);
    await expect(alerts(page).getByRole("button", { name: COPY.ar.reload })).toBeVisible();
  });

  test("the message of the API, a status code and the typed values never reach the page", async ({ page }) => {
    await openRegister(page);
    await serveRegister(page, { status: 500, body: { error: { code: "internal", message: "Database exploded for fresh_user_01", details: {} } } });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.internal);
    const text = await page.locator("main").innerText();
    expect(text).not.toContain("exploded");
    expect(text).not.toContain("500");
    expect(text).not.toContain(MOCK_PASSWORD);
  });

  test("the button is the retry, and the next attempt can succeed", async ({ page }) => {
    await openRegister(page);
    let answer: Answer = { status: 500, body: envelope("internal") };
    await serveRegister(page, () => answer);
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(alerts(page)).toHaveText(COPY.ar.internal);
    answer = created();
    await submitButton(page, "ar").click();
    await expect(page).toHaveURL(/\/recovery-code$/);
  });
});

test.describe("throttle (P-06)", () => {
  test.use({ allowFailedRequests: true });

  test("a minute or less: warning with the wait, aria-disabled button tied to it, hidden countdown, then re-enabled with a status", async ({ page }) => {
    await page.clock.install();
    await openRegister(page);
    const sent = await serveRegister(page, { status: 429, body: envelope("throttled", { retryAfterSec: 20 }), headers: { "Retry-After": "20" } });
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
    await confirmationField(page, "ar").press("Enter");
    expect(sent).toHaveLength(1);

    await button.focus();
    await page.clock.runFor(19_500);
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(COPY.ar.throttle)).toHaveCount(0);
    await expect(polite(page).filter({ hasText: COPY.ar.again })).toBeAttached();
    await expect(button).toBeFocused();
    await expect(page.locator("p[aria-hidden=true] bdi")).toHaveCount(0);
  });

  test("the 15-minute lock counts in mm:ss, and in English the wait is worded with Western digits", async ({ page }) => {
    await page.clock.install();
    await openRegister(page);
    await serveRegister(page, { status: 429, body: envelope("throttled", { retryAfterSec: 900 }), headers: { "Retry-After": "900" } });
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(polite(page).filter({ hasText: COPY.ar.lock })).toBeVisible();
    await expect(page.locator("p[aria-hidden=true] bdi")).toHaveText("١٥:٠٠");

    const english = await page.context().newPage();
    await english.clock.install();
    await openRegister(english, { language: "en" });
    await serveRegister(english, { status: 429, body: envelope("throttled", { retryAfterSec: 20 }), headers: { "Retry-After": "20" } });
    await fill(english, "en");
    await submitButton(english, "en").click();
    await expect(polite(english).filter({ hasText: COPY.en.throttle })).toBeVisible();
    await expect(english.locator("p[aria-hidden=true] bdi")).toHaveText(COPY.en.clock20);
  });
});

test.describe("wake-up (P-04) and connectivity (P-05)", () => {
  test.use({ allowFailedRequests: true });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: a sleeping server shows the line above the button, inside the form column, not at the top of the page`, async ({ page }) => {
      await openRegister(page, { language, mode: "gateway" });
      const line = page.getByText(WAKE_LINE[language]);
      await expect(line).toBeVisible({ timeout: 2_000 });
      await expect(line).toHaveCount(1);
      const lineBox = await box(line);
      expect(lineBox.y).toBeGreaterThanOrEqual((await box(page.getByText(COPY[language].notice))).y);
      expect(lineBox.y + lineBox.height).toBeLessThanOrEqual((await box(submitButton(page, language))).y);
      await expect(polite(page).filter({ hasText: WAKE_LINE[language] })).toBeVisible();
      await expect(alerts(page)).toHaveCount(0);
      await fill(page, language);
      await expect(submitButton(page, language)).toBeEnabled();
    });
  }

  test("a send that gets no answer keeps the values, sends nothing again, and announces readiness once the server answers", async ({ page }) => {
    const health = await openRegister(page, { mode: "ok" });
    const sent = await serveRegister(page, "abort");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.ready)).toBeAttached({ timeout: 6_000 });
    expect(sent).toHaveLength(1);
    await expect(usernameField(page, "ar")).toHaveValue("fresh_user_01");
    await expect(polite(page).filter({ hasText: COPY.ar.ready })).toBeAttached();
    expect(health.requests).toBeGreaterThan(1);
  });

  test("with no connection the notice shows before any press, the button stays enabled, and the connection coming back is announced", async ({ page, context }) => {
    await openRegister(page);
    await context.setOffline(true);
    await expect(page.getByText(COPY.ar.offline)).toBeVisible();
    await expect(polite(page).filter({ hasText: COPY.ar.offline })).toBeVisible();
    await expect(alerts(page)).toHaveCount(0);
    await expect(submitButton(page, "ar")).toBeEnabled();
    await expect(submitButton(page, "ar")).not.toHaveAttribute("aria-disabled", "true");

    await context.setOffline(false);
    await expect(page.getByText(COPY.ar.offline)).toHaveCount(0);
    await expect(polite(page).filter({ hasText: COPY.ar.backOnline })).toBeAttached();
  });

  test("a send while offline gives the uncertain warning beside the offline notice, the notice first", async ({ page, context }) => {
    await openRegister(page);
    await serveRegister(page, "abort");
    await fill(page, "ar");
    await context.setOffline(true);
    await submitButton(page, "ar").click();
    await expect(page.getByText(COPY.ar.uncertain)).toBeVisible();
    await expect(page.getByText(COPY.ar.offline)).toBeVisible();
    expect((await box(page.getByText(COPY.ar.offline))).y).toBeLessThan((await box(page.getByText(COPY.ar.uncertain))).y);
    await context.setOffline(false);
  });

  test("the offline notice is worded in English", async ({ page, context }) => {
    await openRegister(page, { language: "en" });
    await context.setOffline(true);
    await expect(page.getByText(COPY.en.offline)).toBeVisible();
  });
});

test.describe("axe-core on every state of S-02 (NFR-09: no violation)", () => {
  test.use({ allowFailedRequests: true });

  async function sweep(page: Page, context: BrowserContext, language: Language, viewport: { width: number; height: number }) {
    const copy = COPY[language];
    let mode: "abort" | Answer = { status: 409, body: envelope("username_taken") };
    await page.route("**/api/auth/register", async (route) => {
      if (mode === "abort") return route.abort("failed");
      await route.fulfill({ status: mode.status, contentType: "application/json", headers: { "Retry-After": "20", ...mode.headers }, body: JSON.stringify(mode.body) });
    });
    await openRegister(page, { language, viewport });
    const check = async (state: string) => {
      expect(await axeViolations(page), `${language} ${viewport.width} px: ${state}`).toEqual([]);
      expect(await smallTargets(page), `${language} ${viewport.width} px targets: ${state}`).toEqual([]);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(scrollWidth, `${language} ${viewport.width} px width: ${state}`).toBeLessThanOrEqual(clientWidth);
    };

    await check("initial");
    await submitButton(page, language).click();
    await expect(alerts(page)).toContainText(copy.summary4);
    await check("summary of four errors");

    await fill(page, language, { username: "ab", password: "short", confirmation: "other", consent: false });
    await confirmationField(page, language).blur();
    await check("blur errors, summary still showing");

    await consentBox(page, language).check();
    await check("box ticked");
    await page.getByRole("button", { name: copy.show }).first().click();
    await check("password shown");
    await page.getByRole("button", { name: copy.hide }).click();

    await fill(page, language);
    await submitButton(page, language).click();
    await expect(page.getByText(copy.taken)).toBeVisible();
    await check("taken name");

    mode = "abort";
    await usernameField(page, language).fill("fresh_user_02");
    await submitButton(page, language).click();
    await expect(page.getByText(copy.uncertain)).toBeVisible();
    await check("uncertain outcome");

    mode = { status: 409, body: envelope("username_taken") };
    await submitButton(page, language).click();
    await expect(page.getByText(copy.takenHint)).toBeVisible();
    await check("taken name after an uncertain outcome, with the hint and its link");

    mode = { status: 400, body: envelope("terms_required", { requiredVersion: "2099-01-01" }) };
    await usernameField(page, language).fill("fresh_user_03");
    await submitButton(page, language).click();
    await expect(alerts(page)).toContainText(copy.termsUpdated);
    await check("terms updated, with the reload button");

    mode = { status: 422, body: envelope("validation_error", { fields: [{ field: "username", rule: "username_chars" }, { field: "password", rule: "password_min_chars" }] }) };
    await submitButton(page, language).click();
    await expect(alerts(page)).toContainText(copy.summary2);
    await check("two field errors from the server");

    mode = { status: 500, body: envelope("internal") };
    await submitButton(page, language).click();
    await expect(alerts(page)).toHaveText(copy.internal);
    await check("500");

    mode = { status: 403, body: envelope("forbidden_origin") };
    await submitButton(page, language).click();
    await expect(alerts(page)).toContainText(copy.origin);
    await check("403 with reload button");

    mode = { status: 503, body: envelope("unavailable") };
    await submitButton(page, language).click();
    await expect(page.getByText(copy.unavailable)).toBeVisible();
    await check("503");

    mode = { status: 429, body: envelope("throttled", { retryAfterSec: 20 }) };
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

  test("the loading state at 320 px", async ({ page }) => {
    await openRegister(page, { viewport: { width: 320, height: 568 } });
    await serveRegister(page, "hang");
    await fill(page, "ar");
    await submitButton(page, "ar").click();
    await expect(page.getByRole("button", { name: COPY.ar.loading })).toBeVisible();
    expect(await axeViolations(page), "loading").toEqual([]);
  });

  test("the wake-up banner with its retry button", async ({ page }) => {
    await page.clock.install();
    await openRegister(page, { mode: "hang" });
    await page.clock.runFor(95_000);
    await expect(page.getByRole("button", { name: "إعادة المحاولة" })).toBeVisible();
    expect(await axeViolations(page), "waking with retry").toEqual([]);
    expect(await smallTargets(page), "targets").toEqual([]);
  });

  test("the wake-up banner in English", async ({ page }) => {
    await openRegister(page, { language: "en", mode: "gateway" });
    await expect(page.getByText(WAKE_LINE.en)).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test("the placeholder routes that S-02 opens pass axe too", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("heading", { level: 1, name: "شروط الاستخدام وبيان الخصوصية" })).toBeVisible();
    expect(await axeViolations(page), "/terms").toEqual([]);
    await page.goto("/recovery-code");
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.recoveryHeading })).toBeVisible();
    expect(await axeViolations(page), "/recovery-code").toEqual([]);
  });
});
