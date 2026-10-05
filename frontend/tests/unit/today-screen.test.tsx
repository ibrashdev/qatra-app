import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/today", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { TodayScreen } from "@/components/today/TodayScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { MOCK_PLAN_ID, mockToday, mockTodayWithoutPlan } from "@/lib/api/mock/fixtures";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_SESSION_ID, mockProgress, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { Plan, ProgressResponse, Today } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";

// Index reads of a record may be undefined, so the base handlers are fetched through one function that says so.
function baseHandler(key: string): MockHandler {
  const handler = { ...mockHandlers, ...todayMockHandlers }[key];
  if (handler === undefined) throw new Error(`No mock handler for ${key}.`);
  return handler;
}

const ok = (body: unknown): MockResponse => ({ status: 200, body });
const todayWith = (partial: Partial<Today>): MockHandler => () => ok({ ...mockToday, ...partial });
const progressWith = (change: (progress: ProgressResponse) => ProgressResponse): MockHandler => () => ok(change(mockProgress));
const withPlan = (change: Partial<Plan>): Plan => ({ ...(mockToday.plan as Plan), ...change });

// The mock layer answers by default (E18 from mockHandlers, E19 and E20 from todayMockHandlers); a test overrides single operations.
function renderToday({
  language = "ar",
  handlers = {},
  scenario = {},
  latencyMs = 0,
}: { language?: "ar" | "en"; handlers?: Record<string, MockHandler>; scenario?: Partial<MockScenario>; latencyMs?: number } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({ latencyMs, handlers: { ...mockHandlers, ...todayMockHandlers, ...handlers }, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    calls.push({ key: `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <TodayScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, calls, count: (key: string) => calls.filter((call) => call.key === key).length };
}

const sectionLabels = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
const startButton = () => screen.getByRole("button", { name: /^(ابدأ جلسة اليوم|تابع جلسة اليوم|جارٍ تجهيز الجلسة…)$/ });

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  clearLoginArrival();
});

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("S-11 Plan and today: the five sections", () => {
  it("shows the H1 and the five sections in the fixed order with the specified copy", async () => {
    renderToday();
    expect(await screen.findByRole("heading", { level: 1, name: "خطوتك اليوم" })).toBeInTheDocument();
    await screen.findByText("الهدف الكلي");
    expect(sectionLabels()).toEqual(["الهدف الكلي", "الزمن اليومي", "المراحل", "المراجعات", "الخطوة التالية"]);

    const goal = screen.getByRole("region", { name: "الهدف الكلي" });
    expect(goal).toHaveTextContent("عنوان الكتاب (عنصر نائب) · الموعد ٢٠ أكتوبر ٢٠٢٦");

    const daily = screen.getByRole("region", { name: "الزمن اليومي" });
    expect(daily).toHaveTextContent("١٠ دقائق يوميًا، وحتى ٢٥ كلمة جديدة في اليوم");
    expect(daily).toHaveTextContent("الإنجاز اليومي");
    expect(daily).toHaveTextContent("٧/١٠ دقائق، ٧٠٪");
    expect(within(daily).getByRole("link", { name: "تعديل الوقت والهدف" })).toHaveAttribute("href", "/plan/revise");

    const stages = screen.getByRole("region", { name: "المراحل" });
    expect(stages).toHaveTextContent("اسم القسم (عنصر نائب) ١");
    expect(stages).toHaveTextContent("المرحلة الحالية");
    expect(stages).toHaveTextContent("٤٠٪");

    const reviews = screen.getByRole("region", { name: "المراجعات" });
    expect(reviews).toHaveTextContent("مراجعات مستحقة اليوم: ٢");
    expect(reviews).toHaveTextContent("موعد المراجعة التالي: ٦ أكتوبر ٢٠٢٦");

    const next = screen.getByRole("region", { name: "الخطوة التالية" });
    expect(next).toHaveTextContent("المقطع الجديد التالي: اسم القسم (عنصر نائب) ١ (1).");
    expect(within(next).getByRole("button", { name: "ابدأ جلسة اليوم" })).toBeInTheDocument();
  });

  it("links to the plan from the header, before the H1 (focus order c1, c2)", async () => {
    renderToday();
    const link = await screen.findByRole("link", { name: "عرض الخطة" });
    expect(link).toHaveAttribute("href", "/plan");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(link.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("draws the daily bar as a progressbar with the value in words, and the stage bar beside it", async () => {
    renderToday();
    await screen.findByText("الزمن اليومي");
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    const [daily, stage] = bars;
    expect(daily).toHaveAttribute("aria-valuenow", "70");
    expect(daily).toHaveAttribute("aria-valuemin", "0");
    expect(daily).toHaveAttribute("aria-valuemax", "100");
    expect(daily).toHaveAttribute("aria-valuetext", "٧ من ١٠ دقائق، ٧٠ بالمئة");
    expect(daily).toHaveAccessibleName("الإنجاز اليومي");
    expect(stage).toHaveAttribute("aria-valuenow", "40");
    expect(stage).toHaveAttribute("aria-valuetext", "٤٠ بالمئة");
  });

  it("never shows the overall percentage, a streak or a calendar", async () => {
    renderToday();
    await screen.findByText("الزمن اليومي");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("٢٤٪"); // the overall percent of the E19 plan
    expect(text).not.toMatch(/سلسلة|متتالي|streak/i);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByText("الإنجاز الكلي للخطة")).toBeNull();
  });

  it("is written in English and left to right for the English interface", async () => {
    renderToday({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Your step today" })).toBeInTheDocument();
    await screen.findByText("Overall goal");
    expect(sectionLabels()).toEqual(["Overall goal", "Daily time", "Stages", "Reviews", "Next step"]);
    expect(screen.getByRole("region", { name: "Overall goal" })).toHaveTextContent("Book title (placeholder) · Target October 20, 2026");
    expect(screen.getByRole("region", { name: "Daily time" })).toHaveTextContent("10 minutes a day, up to 25 new words a day");
    expect(screen.getByRole("region", { name: "Daily time" })).toHaveTextContent("7/10 minutes, 70%");
    expect(screen.getByRole("region", { name: "Stages" })).toHaveTextContent("Section placeholder 1");
    expect(screen.getByRole("region", { name: "Reviews" })).toHaveTextContent("Reviews due today: 2");
    expect(screen.getByRole("region", { name: "Reviews" })).toHaveTextContent("Next review: October 6, 2026");
    expect(screen.getByRole("button", { name: "Start today's session" })).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuetext", "7 of 10 minutes, 70 percent");
  });

  it("puts the button in the last section, sticky above the tab bar below 1024 px", async () => {
    renderToday();
    await screen.findByText("الخطوة التالية");
    const action = screen.getByTestId("session-action");
    expect(action.className).toContain("sticky");
    expect(action.className).toContain("bottom-[calc(var(--q-size-tabbar)");
    expect(action.className).toContain("rail:static");
    expect(within(screen.getByRole("region", { name: "الخطوة التالية" })).getByRole("button")).toBe(startButton());
    // The page order lists the reviews before the next step, and the button last.
    const headings = sectionLabels();
    expect(headings.indexOf("المراجعات")).toBeLessThan(headings.indexOf("الخطوة التالية"));
  });
});

describe("S-11 states of the data", () => {
  it("shows no reviews due, and the next review date only when it is ahead", async () => {
    renderToday({ handlers: { "GET /today": todayWith({ dueReviews: 0 }) } });
    const reviews = await screen.findByRole("region", { name: "المراجعات" });
    expect(reviews).toHaveTextContent("لا توجد مراجعات مستحقة اليوم.");
    expect(reviews).toHaveTextContent("موعد المراجعة التالي: ٦ أكتوبر ٢٠٢٦");
  });

  it("omits the goal date when there is none, and shows the goal reached with the extra minutes on a line of their own", async () => {
    renderToday({
      handlers: { "GET /today": todayWith({ plan: withPlan({ preferredDate: null }), dailyActiveMs: 780_000, dailyPercent: 100, dailyCompleted: true, extraActiveMs: 180_000 }) },
    });
    const goal = await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(goal).not.toHaveTextContent("الموعد");
    const daily = screen.getByRole("region", { name: "الزمن اليومي" });
    expect(daily).toHaveTextContent("أكملت هدف اليوم");
    expect(daily).toHaveTextContent("١٠/١٠ دقائق، ١٠٠٪");
    expect(daily).toHaveTextContent("+ ٣ دقائق إضافية");
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuenow", "100");
    expect(startButton()).toBeInTheDocument(); // the button stays
  });

  it("shows an empty bar on the first day", async () => {
    renderToday({ handlers: { "GET /today": todayWith({ dailyActiveMs: 0, dailyPercent: 0 }) } });
    await screen.findByText("الزمن اليومي");
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("region", { name: "الزمن اليومي" })).toHaveTextContent("٠/١٠ دقائق، ٠٪");
  });

  it("near the horizon says no new passages remain and leaves the stage row out", async () => {
    renderToday({ handlers: { "GET /today": todayWith({ nextNewPassage: null }) } });
    const next = await screen.findByRole("region", { name: "الخطوة التالية" });
    expect(next).toHaveTextContent("لا توجد مقاطع جديدة؛ تتبقى المراجعات لتأكيد ما حفظته.");
    expect(screen.queryByRole("region", { name: "المراحل" })).toBeNull();
  });

  it("after an absence shows the light-review banner and line, without a count of missed days", async () => {
    renderToday({
      handlers: {
        "GET /today": todayWith({ dailyActiveMs: 0, dailyPercent: 0 }),
        "GET /progress": progressWith((progress) => ({ ...progress, history: [{ date: "2026-09-30", activeMs: 300_000, goalMs: 600_000, completed: false }] })),
      },
    });
    expect(await screen.findByText("نبدأ اليوم بمراجعة خفيفة.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "الخطوة التالية" })).toHaveTextContent("مراجعة خفيفة اليوم، دون مقاطع جديدة.");
    expect(document.body.textContent).not.toMatch(/فاتك|أيام الغياب/);
  });

  it("explains a pending change from the next learning day, and keeps the value in force", async () => {
    renderToday({ handlers: { "GET /today": todayWith({ plan: withPlan({ pendingSessionMinutes: 15 }) }) } });
    expect(await screen.findByText("يبدأ هذا التغيير من يوم التعلم التالي (٦ أكتوبر ٢٠٢٦).")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "الزمن اليومي" })).toHaveTextContent("١٠ دقائق يوميًا");
  });

  it("offers the open plan conversation", async () => {
    renderToday({ handlers: { "GET /today": todayWith({ openPlanChatId: "chat-1" }) } });
    expect(await screen.findByText("لديك محادثة خطة لم تعتمدها بعد.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "متابعة المحادثة" })).toHaveAttribute("href", "/plan/chat/chat-1");
  });

  it("shows no banner for a day without these conditions", async () => {
    renderToday();
    await screen.findByText("الزمن اليومي");
    expect(screen.queryByText("نبدأ اليوم بمراجعة خفيفة.")).toBeNull();
    expect(screen.queryByText(/لديك محادثة خطة/)).toBeNull();
    expect(screen.queryByText(/يبدأ هذا التغيير/)).toBeNull();
  });
});

describe("S-11 no plan (c8, G-24)", () => {
  it("shows the empty state with «ابدأ خطتك» to S-08, and no session button", async () => {
    renderToday({ scenario: { hasPlan: false } });
    expect(await screen.findByText("لا توجد خطة نشطة بعد.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطتك" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("link", { name: "عرض الخطة" })).toBeNull();
    expect(screen.queryByRole("button", { name: /جلسة اليوم/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "الخطط السابقة" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers «الخطط السابقة» when E19 lists a paused plan", async () => {
    renderToday({
      scenario: { hasPlan: false },
      handlers: { "GET /progress": progressWith((progress) => ({ ...progress, plans: progress.plans.map((plan) => ({ ...plan, status: "paused" as const })) })) },
    });
    expect(await screen.findByRole("link", { name: "الخطط السابقة" })).toHaveAttribute("href", "/plan");
  });

  it("shows the empty state in English", async () => {
    renderToday({ language: "en", scenario: { hasPlan: false } });
    expect(await screen.findByText("No active plan yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start your plan" })).toHaveAttribute("href", "/start");
  });

  it("a completed plan shows the completion banner, the reviews only, and the maintenance button with the plan's version (G-31)", async () => {
    const user = userEvent.setup();
    renderToday({
      scenario: { hasPlan: false },
      handlers: {
        "GET /today": () => ok(mockTodayWithoutPlan),
        "GET /progress": progressWith((progress) => ({ ...progress, plans: progress.plans.map((plan) => ({ ...plan, status: "completed" as const, currentVersion: 4 })) })),
        "POST /sessions": ({ body }) => ok({ sessionId: "maintenance-1", echoed: body }),
      },
    });
    expect(await screen.findByText("اكتملت هذه الخطة، وتستمر مراجعات الصيانة.")).toBeInTheDocument();
    expect(sectionLabels()).toEqual(["المراجعات"]);
    await user.click(startButton());
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/session/maintenance-1"));
  });
});

describe("S-11 E19 failure", () => {
  it("drops the stage percent and the review date only, and keeps everything else", async () => {
    renderToday({ handlers: { "GET /progress": () => errorResponse(500, "internal", "Unexpected error.") } });
    const stages = await screen.findByRole("region", { name: "المراحل" });
    expect(stages).toHaveTextContent("اسم القسم (عنصر نائب) ١");
    expect(stages).toHaveTextContent("المرحلة الحالية");
    expect(stages).not.toHaveTextContent("٤٠٪");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1); // only the daily bar
    expect(screen.getByRole("region", { name: "المراجعات" })).toHaveTextContent("مراجعات مستحقة اليوم: ٢");
    expect(screen.getByRole("region", { name: "المراجعات" })).not.toHaveTextContent("موعد المراجعة التالي");
    expect(screen.getByRole("region", { name: "الزمن اليومي" })).toHaveTextContent("٧/١٠ دقائق، ٧٠٪");
    expect(startButton()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the stage row is read from E18 alone, so a failed E19 never hides the screen", async () => {
    renderToday({ handlers: { "GET /progress": () => errorResponse(503, "unavailable", "Down.") } });
    expect(await screen.findByRole("region", { name: "الخطوة التالية" })).toBeInTheDocument();
  });
});

describe("S-11 loading", () => {
  it("shows the five skeleton sections only after 300 ms, in a busy region with loading text", async () => {
    renderToday({ latencyMs: 1500 });
    const region = screen.getByTestId("today-skeleton");
    const blocks = () => region.querySelectorAll(":scope > div[aria-hidden='true']");
    // The first render has the H1 and a busy region, and no skeleton yet: a fast load never flashes one.
    expect(screen.getByRole("heading", { level: 1, name: "خطوتك اليوم" })).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveTextContent("جارٍ التحميل");
    expect(blocks()).toHaveLength(0);
    await waitFor(() => expect(blocks()).toHaveLength(5), { timeout: 1200 });
  });

  it("never draws the skeleton when the answer comes at once", async () => {
    renderToday();
    expect(screen.getByTestId("today-skeleton").querySelectorAll(":scope > div[aria-hidden='true']")).toHaveLength(0);
    await screen.findByText("الزمن اليومي");
    expect(screen.queryByTestId("today-skeleton")).toBeNull();
  });
});
describe("S-11 the session button (E20 daily, P-14)", () => {
  it("calls E20 once per press with the plan id and its current version, then opens the session screen", async () => {
    const user = userEvent.setup();
    const view = renderToday();
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}`));
    expect(view.count("POST /sessions")).toBe(1);
    expect(view.calls.find((call) => call.key === "POST /sessions")?.body).toEqual({ kind: "daily", planId: MOCK_PLAN_ID, expectedPlanVersion: 1 });
  });

  it("is a loading button while the request is out, and extra presses are ignored", async () => {
    const user = userEvent.setup();
    const view = renderToday({ handlers: { "POST /sessions": () => ({ status: 201, body: { sessionId: MOCK_SESSION_ID } }) } });
    await screen.findByText("الخطوة التالية");
    const button = startButton();
    await user.click(button);
    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledTimes(1));
    expect(view.count("POST /sessions")).toBe(1);
    expect(screen.getByRole("button", { name: "جارٍ تجهيز الجلسة…" })).toHaveAttribute("aria-busy", "true"); // it keeps loading while the next screen opens
  });

  it("says «تابع جلسة اليوم» when a session is open, still calls E20, and opens the id it answers", async () => {
    const user = userEvent.setup();
    const view = renderToday({ handlers: { "GET /today": todayWith({ openSessionId: MOCK_SESSION_ID }) } });
    const button = await screen.findByRole("button", { name: "تابع جلسة اليوم" });
    expect(screen.queryByRole("button", { name: "ابدأ جلسة اليوم" })).toBeNull();
    await user.click(button);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}`));
    expect(view.count("POST /sessions")).toBe(1);
  });

  it("says «Continue today's session» in English", async () => {
    renderToday({ language: "en", handlers: { "GET /today": todayWith({ openSessionId: MOCK_SESSION_ID }) } });
    expect(await screen.findByRole("button", { name: "Continue today's session" })).toBeInTheDocument();
  });

  it("a version conflict shows the warning with «تحديث», which reloads E18 and E19 and clears the warning", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const view = renderToday({
      handlers: {
        "POST /sessions": () => (answers++ === 0 ? errorResponse(409, "version_conflict", "Changed.", { reason: "plan_version", currentVersion: 2 }) : { status: 201, body: { sessionId: "s2" } }),
      },
    });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    expect(await screen.findByText("عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.")).toBeInTheDocument();
    expect(navigation.router.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(view.count("GET /today")).toBe(2));
    expect(view.count("GET /progress")).toBe(2);
    await waitFor(() => expect(screen.queryByText(/عُدّلت خطتك/)).toBeNull());
  });

  it("a plan that is not active shows its own line", async () => {
    const user = userEvent.setup();
    renderToday({ handlers: { "POST /sessions": () => errorResponse(409, "version_conflict", "No.", { reason: "plan_not_active" }) } });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    expect(await screen.findByText("هذه الخطة غير نشطة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تحديث" })).toBeInTheDocument();
  });

  it("revoked content shows «غير متاح» with a path to S-08 and blocks the button with that reason", async () => {
    const user = userEvent.setup();
    const view = renderToday({
      handlers: { "POST /sessions": () => errorResponse(422, "validation_error", "Revoked.", { fields: [{ field: "planId", rule: "edition_not_available" }] }) },
    });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("غير متاح");
    expect(alert).toHaveTextContent("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.");
    expect(within(alert).getByRole("link", { name: "ابدأ خطة جديدة" })).toHaveAttribute("href", "/start");
    const button = startButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(/هذه النسخة لم تعد متاحة/);
    await user.click(button);
    expect(view.count("POST /sessions")).toBe(1);
  });

  it("an unexpected error is announced, never retried on its own, and the button stays the retry", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const view = renderToday({
      handlers: { "POST /sessions": () => (answers++ === 0 ? errorResponse(500, "internal", "Boom.") : { status: 201, body: { sessionId: "s3" } }) },
    });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(view.count("POST /sessions")).toBe(1);
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).toBeNull(); // a press has no retry button
    await user.click(startButton());
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/session/s3"));
    expect(view.count("POST /sessions")).toBe(2);
  });

  it("a throttled press shows the wait, disables the button and counts down in a hidden line", async () => {
    const user = userEvent.setup();
    renderToday({ handlers: { "POST /sessions": () => errorResponse(429, "throttled", "Slow.", { retryAfterSec: 20 }) } });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    expect(await screen.findByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
    expect(startButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("٠٠:٢٠").closest("p")).toHaveAttribute("aria-hidden", "true");
  });

  it("a press while the service is unavailable shows the warning in the polite area", async () => {
    const user = userEvent.setup();
    renderToday({ handlers: { "POST /sessions": () => errorResponse(503, "unavailable", "Down.") } });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    const text = await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.");
    expect(text.closest("[role=status]")).not.toBeNull();
  });

  it("a session that ended on the press goes to S-01 with the way back", async () => {
    const user = userEvent.setup();
    renderToday({ handlers: { "POST /sessions": () => errorResponse(401, "unauthenticated", "Out.") } });
    await screen.findByText("الخطوة التالية");
    await user.click(startButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Ftoday"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-11 E18 failure", () => {
  it("a service error offers «إعادة المحاولة», which reads again and shows the screen", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const view = renderToday({ handlers: { "GET /today": (request, scenario) => (answers++ === 0 ? errorResponse(503, "unavailable", "Down.") : baseHandler("GET /today")(request, scenario)) } });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "الهدف الكلي" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "خطوتك اليوم" })).toBeInTheDocument(); // focus has a place to land
    await user.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(await screen.findByRole("region", { name: "الهدف الكلي" })).toBeInTheDocument();
    expect(view.count("GET /today")).toBe(2);
    expect(screen.queryByText(/الخدمة غير متاحة/)).toBeNull();
  });

  it("an unexpected error is an alert with «إعادة المحاولة»", async () => {
    renderToday({ handlers: { "GET /today": () => errorResponse(500, "internal", "Boom.") } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    expect(within(alert).getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });

  it("while the server wakes, a lost connection leaves the wake-up line to the shell, shows no error, and reads again once health answers", async () => {
    // A sleeping server answers neither read, so both fail the first time.
    let todayAnswers = 0;
    let progressAnswers = 0;
    let healthAnswers = 0;
    const view = renderToday({
      handlers: {
        "GET /today": (request, scenario) => {
          if (todayAnswers++ === 0) throw new TypeError("The mock connection failed.");
          return baseHandler("GET /today")(request, scenario);
        },
        "GET /progress": (request, scenario) => {
          if (progressAnswers++ === 0) throw new TypeError("The mock connection failed.");
          return baseHandler("GET /progress")(request, scenario);
        },
        "GET /health": (request, scenario) => {
          if (healthAnswers++ === 0) throw new TypeError("The mock connection failed.");
          return baseHandler("GET /health")(request, scenario);
        },
      },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "خطوتك اليوم" })).toBeInTheDocument();
    await waitFor(() => expect(view.count("GET /today")).toBe(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region", { name: "الهدف الكلي" })).toBeNull();
    // The wake-up controller polls health after 1 s; its answer sends the read again (P-04).
    expect(await screen.findByRole("region", { name: "الهدف الكلي" }, { timeout: 4000 })).toBeInTheDocument();
    expect(view.count("GET /today")).toBe(2);
  }, 10_000);

  it("offline shows the Info banner of P-05 with «إعادة المحاولة», and no error tone", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    renderToday({ handlers: { "GET /today": lost, "GET /progress": lost, "GET /health": lost } });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a session that ended on load goes to S-01 and raises the banner", async () => {
    renderToday({ handlers: { "GET /today": () => errorResponse(401, "unauthenticated", "Out.") } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Ftoday"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});
