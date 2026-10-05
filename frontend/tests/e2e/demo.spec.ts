import type { Page } from "@playwright/test";
import {
  createMockFetch,
  errorResponse,
  MOCK_DEMO_SCENARIOS,
  MOCK_PASSWORD,
  mockHandlers,
  type MockHandler,
  type MockScenario,
} from "../../src/lib/api/mock";
import { axeViolations, axeViolationsAtRest, controlHealth, expect, smallTargets, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// The demo path (option C, F12) in a real browser, against a production build in live mode: S-01's demo link, S-28 (E26), S-04, S-29 (E27, E28)
// and S-30 (E29). Every /api/* answer comes from the app's own mock handlers (synthetic data only) run in the test process, so the flow keeps its
// state; only E01 is left to the stub backend. Names and roles are used, never CSS.

type Language = "ar" | "en";

const COPY = {
  ar: {
    loginLink: "رابط عرض تجريبي",
    entry: "رابط العرض التجريبي",
    username: "اسم المستخدم",
    password: "كلمة المرور",
    confirmation: "تأكيد كلمة المرور",
    consent: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
    submit: "إنشاء حساب العرض",
    recoveryHeading: "حفظ رمز الاسترجاع",
    savedCode: "حفظت الرمز في مكان آمن خارج التطبيق",
    continue: "متابعة",
    scenarios: "قائمة سيناريوهات أهداف اصطناعية",
    group: "السيناريوهات",
    build: "ابنِ الخطة",
    built: "تم بناء خطتك",
    byRules: "بُنيت هذه الخطة بمحرك القواعد داخل التطبيق.",
    byPlanner: "بُنيت هذه الخطة بواسطة «المخطط المقيد».",
    toPlan: "المتابعة إلى خطتك",
    simulations: "محاكاة عدة أيام للقراءة فقط",
    label: "محسوبة سلفًا لا تشغيلًا حيًا",
    unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
    today: "خطوتك اليوم",
  },
  en: {
    loginLink: "Try the demo",
    entry: "Try the demo",
    username: "Username",
    password: "Password",
    confirmation: "Confirm password",
    consent: "I have read the terms of use and privacy statement and I agree to them.",
    submit: "Create demo account",
    recoveryHeading: "Save your recovery code",
    savedCode: "I have saved the code in a safe place outside the app",
    continue: "Continue",
    scenarios: "Synthetic goal scenarios",
    group: "Scenarios",
    build: "Build the plan",
    built: "Your plan is built",
    byRules: "This plan was built by the rules engine inside the app.",
    byPlanner: "This plan was built by the constrained planner.",
    toPlan: "Continue to your plan",
    simulations: "Multi-day read-only simulation",
    label: "Precomputed, not a live run",
    unavailable: "The service is temporarily unavailable. Try again shortly.",
    today: "Your step today",
  },
} as const;

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

// Serves every /api/* call except E01 from the mock handlers, remembering what the page sent.
async function serveMockBackend(page: Page, scenario: Partial<MockScenario>, overrides: Record<string, MockHandler> = {}): Promise<Seen[]> {
  const mockFetch = createMockFetch({ latencyMs: 0, scenario: { signedIn: false, ...scenario }, handlers: { ...mockHandlers, ...overrides } });
  const seen: Seen[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health") return route.fallback();
    const raw = request.postData();
    seen.push({ method: request.method(), path, body: raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>) });
    const answer = await mockFetch(request.url(), { method: request.method(), body: raw ?? undefined });
    const body = await answer.text();
    await route.fulfill({ status: answer.status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, ...(body === "" ? {} : { body }) });
  });
  return seen;
}

async function open(page: Page, path: string, { language = "ar", viewport = VIEWPORTS.phone }: { language?: Language; viewport?: { width: number; height: number } } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, "ok");
  return { health, go: async () => { await page.goto(path); await waitForFirstHealthRequest(health); } };
}

const demoAccount = { signedIn: true, isDemo: true, hasPlan: false } as const;

async function register(page: Page, language: Language) {
  const copy = COPY[language];
  await page.getByRole("textbox", { name: copy.username }).fill("fresh_demo_01");
  await page.getByLabel(copy.password, { exact: true }).fill(MOCK_PASSWORD);
  await page.getByLabel(copy.confirmation, { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole("checkbox", { name: copy.consent }).check();
  await page.getByRole("button", { name: copy.submit }).click();
}

// The page does not scroll sideways. A failure names the first elements that stick out, so the cause is in the message.
const noHorizontalScroll = async (page: Page) => {
  const { scrollWidth, clientWidth, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const outside = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return element.checkVisibility() && !element.closest(".sr-only") && rect.width > 0 && (rect.right > width + 0.5 || rect.left < -0.5);
      })
      .slice(0, 8)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} "${(element.textContent ?? "").trim().slice(0, 30)}" [${Math.round(rect.left)}..${Math.round(rect.right)}]`;
      });
    // A box whose own content is wider than the box (text that cannot break) also widens the page without sticking out itself.
    const spills = [...document.querySelectorAll<HTMLElement>("body, body *")].filter(
      (element) => element.checkVisibility() && !element.closest(".sr-only") && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible",
    );
    // Only the innermost boxes: the ones above them spill because of them.
    const spilling = spills
      .filter((element) => !spills.some((other) => other !== element && element.contains(other)))
      .slice(0, 8)
      .map((element) => `spill ${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} "${(element.textContent ?? "").trim().slice(0, 40)}" [${element.clientWidth}<${element.scrollWidth}]`);
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: width, offenders: [...outside, ...spilling] };
  });
  expect(scrollWidth, offenders.join(" | ")).toBeLessThanOrEqual(clientWidth);
};

test.describe("the committee journey from S-01 to today", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: the demo link, S-28, S-04, S-29 and today, with no demo flag ever sent`, async ({ page }) => {
      const copy = COPY[language];
      const seen = await serveMockBackend(page, { signedIn: false });
      const { go } = await open(page, "/login", { language });
      await go();

      await page.getByRole("link", { name: copy.loginLink }).click();
      await expect(page).toHaveURL(/\/demo$/);
      await expect(page.getByRole("heading", { level: 1, name: copy.entry })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await register(page, language);

      await expect(page).toHaveURL(/\/recovery-code$/);
      await expect(page.getByRole("heading", { level: 1, name: copy.recoveryHeading })).toBeVisible();
      await page.getByRole("checkbox", { name: copy.savedCode }).check();
      await page.getByRole("button", { name: copy.continue, exact: true }).click();

      await expect(page).toHaveURL(/\/demo\/scenario$/);
      await expect(page.getByRole("heading", { level: 1, name: copy.scenarios })).toBeVisible();
      const group = page.getByRole("radiogroup", { name: copy.group });
      await expect(group.getByRole("radio")).toHaveCount(MOCK_DEMO_SCENARIOS.length);
      expect(await axeViolations(page)).toEqual([]);
      const build = page.getByRole("button", { name: copy.build });
      await expect(build).toHaveAttribute("aria-disabled", "true");
      await group.getByRole("radio").first().check();
      await expect(build).toHaveAttribute("aria-disabled", "false");
      await build.click();

      await expect(page.getByRole("heading", { level: 2, name: copy.built })).toBeFocused();
      await expect(page.getByText(copy.byRules)).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.getByRole("button", { name: copy.toPlan }).click();
      await expect(page).toHaveURL(/\/today$/);
      await expect(page.getByRole("heading", { level: 1, name: copy.today })).toBeVisible();

      const registration = seen.find((call) => call.path === "/api/demo/accounts");
      expect(Object.keys(registration?.body ?? {}).sort()).toEqual(["language", "password", "termsAccepted", "termsVersion", "timeZone", "username"]);
      expect(seen.some((call) => call.path === "/api/auth/register")).toBe(false);
      const plan = seen.filter((call) => call.path === "/api/demo/plans");
      expect(plan).toHaveLength(1);
      expect(plan[0]?.body).toEqual({ scenarioId: MOCK_DEMO_SCENARIOS[0]?.scenarioId });
      for (const call of seen) {
        expect(JSON.stringify(call.body ?? {}), `${call.method} ${call.path}`).not.toMatch(/isDemo|"mode"/);
      }
    });
  }

  test("the constrained planner is named when it built the plan", async ({ page }) => {
    await serveMockBackend(page, demoAccount);
    const { go } = await open(page, "/demo/scenario");
    await go();
    await page.getByRole("radiogroup", { name: COPY.ar.group }).getByRole("radio").nth(1).check();
    await page.getByRole("button", { name: COPY.ar.build }).click();
    await expect(page.getByText(COPY.ar.byPlanner)).toBeVisible();
  });
});

test.describe("the guards", () => {
  for (const path of ["/demo/scenario", "/demo/simulations"]) {
    test(`a visitor on ${path} goes to the login screen with the return path`, async ({ page }) => {
      await serveMockBackend(page, { signedIn: false });
      const { go } = await open(page, path);
      await go();
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path)}$`));
      await expect(page.getByRole("heading", { level: 1, name: "الدخول" })).toBeVisible();
      // The visitor never had a session, so the login screen does not say that one ended.
      await expect(page.getByText("انتهت جلستك")).toHaveCount(0);
    });

    test(`an account that is not a demo account on ${path} goes to today`, async ({ page }) => {
      await serveMockBackend(page, { signedIn: true, isDemo: false, hasPlan: true });
      const { go } = await open(page, path);
      await go();
      await expect(page).toHaveURL(/\/today$/);
    });
  }

  test("a signed-in visitor on S-28 is sent home", async ({ page }) => {
    await serveMockBackend(page, { signedIn: true, isDemo: true, hasPlan: true });
    const { go } = await open(page, "/demo");
    await go();
    await expect(page).toHaveURL(/\/today$/);
  });
});

test.describe("S-30 read-only simulations", () => {
  test("shows the label, the synthetic profile and the days as a table on desktop and as cards on a phone", async ({ page }) => {
    await serveMockBackend(page, demoAccount);
    const { go } = await open(page, "/demo/simulations", { viewport: VIEWPORTS.desktop });
    await go();
    await expect(page.getByRole("heading", { level: 1, name: COPY.ar.simulations })).toBeVisible();
    await expect(page.getByText(COPY.ar.label).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "الملف الاصطناعي" }).first()).toBeVisible();
    await expect(page.getByRole("table").first()).toBeVisible();
    expect(await axeViolationsAtRest(page)).toEqual([]);

    await page.setViewportSize(VIEWPORTS.phone);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("list", { name: /أيام المحاكاة/ }).first()).toBeVisible();
    expect(await axeViolationsAtRest(page)).toEqual([]);
  });

  for (const language of ["ar", "en"] as const) {
    test(`${language}: S-28 fits 320 px, has no small target, and does not scroll sideways even at 200 % text`, async ({ page }) => {
      await serveMockBackend(page, { signedIn: false });
      const { go } = await open(page, "/demo", { language, viewport: VIEWPORTS.floor });
      await go();
      await expect(page.getByRole("heading", { level: 1, name: COPY[language].entry })).toBeVisible();
      await noHorizontalScroll(page);
      expect(await smallTargets(page)).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await noHorizontalScroll(page);
    });

    test(`${language}: S-29 and S-30 fit 320 px with every target reachable, and the page direction follows the language`, async ({ page }) => {
      const copy = COPY[language];
      await serveMockBackend(page, demoAccount);
      const { go } = await open(page, "/demo/scenario", { language, viewport: VIEWPORTS.floor });
      await go();
      await expect(page.getByRole("radiogroup", { name: copy.group })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dir)).toBe(language === "ar" ? "rtl" : "ltr");
      await noHorizontalScroll(page);
      expect(await smallTargets(page)).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await noHorizontalScroll(page);
      // The result of a build is the widest state of S-29 at large text.
      await page.getByRole("radiogroup", { name: copy.group }).getByRole("radio").first().check();
      await page.getByRole("button", { name: copy.build }).click();
      await expect(page.getByRole("heading", { level: 2, name: copy.built })).toBeVisible();
      await noHorizontalScroll(page);

      await page.goto("/demo/simulations");
      await expect(page.getByText(copy.label).first()).toBeVisible();
      await noHorizontalScroll(page);
      expect(await axeViolationsAtRest(page)).toEqual([]);
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await noHorizontalScroll(page);
    });
  }
});

test.describe("states of S-29", () => {
  test.use({ allowFailedRequests: true });

  test("an unavailable service on E28 shows the banner and sends nothing again by itself", async ({ page }) => {
    const seen = await serveMockBackend(page, demoAccount, { "POST /demo/plans": () => errorResponse(503, "unavailable", "Down.") });
    const { go } = await open(page, "/demo/scenario");
    await go();
    await page.getByRole("radiogroup", { name: COPY.ar.group }).getByRole("radio").first().check();
    await page.getByRole("button", { name: COPY.ar.build }).click();
    await expect(page.getByText(COPY.ar.unavailable)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(seen.filter((call) => call.path === "/api/demo/plans")).toHaveLength(1);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("an empty list shows the calm notice with the way to S-08", async ({ page }) => {
    await serveMockBackend(page, demoAccount, { "GET /demo/scenarios": () => ({ status: 200, body: { scenarios: [] } }) });
    const { go } = await open(page, "/demo/scenario");
    await go();
    await expect(page.getByText("لا توجد سيناريوهات جاهزة الآن. يمكنك بدء خطة بنفسك.")).toBeVisible();
    await expect(page.getByRole("link", { name: "ابدأ خطتك" })).toHaveAttribute("href", "/start");
    expect(await axeViolations(page)).toEqual([]);
  });

  test("reduced motion: the waiting spinner does not turn", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = await serveMockBackend(page, demoAccount);
    await page.route("**/api/demo/plans", async (route) => {
      await held;
      await route.fallback();
    });
    const { go } = await open(page, "/demo/scenario");
    await go();
    await page.getByRole("radiogroup", { name: COPY.ar.group }).getByRole("radio").first().check();
    await page.getByRole("button", { name: COPY.ar.build }).click();
    await expect(page.getByRole("button", { name: "جارٍ بناء الخطة…" })).toHaveAttribute("aria-busy", "true");
    const animation = await page.getByRole("button", { name: "جارٍ بناء الخطة…" }).locator("span").first().evaluate((element) => getComputedStyle(element).animationName);
    expect(animation).toBe("none");
    release();
    await expect(page.getByRole("heading", { level: 2, name: COPY.ar.built })).toBeVisible();
    expect(mock.filter((call) => call.path === "/api/demo/plans")).toHaveLength(1);
  });
});

test.describe("the demo link on S-01", () => {
  test("is reachable by Tab right after the create-account link, and every target is still 44 px", async ({ page }) => {
    await serveMockBackend(page, { signedIn: false });
    const { go } = await open(page, "/login");
    await go();
    const names: string[] = [];
    await page.getByRole("link", { name: "إنشاء حساب" }).focus();
    await page.keyboard.press("Tab");
    names.push(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    expect(names).toEqual([COPY.ar.loginLink]);
    expect(await smallTargets(page)).toEqual([]);
  });
});
