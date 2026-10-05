import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/plan", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/browser")>()), ...browser }));

import { PlanOverviewScreen } from "@/components/plan-overview/PlanOverviewScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { MOCK_PLAN_ID, mockCatalog, mockToday } from "@/lib/api/mock/fixtures";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_PAUSED_PLAN_ID, mockProgressWithOtherPlans, planMockHandlers } from "@/lib/api/mock/plan-handlers";
import { mockProgress, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { ProgressResponse, Today } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { installDialogPolyfill } from "./dialog-polyfill";

const ok = (body: unknown): MockResponse => ({ status: 200, body });
const withToday = (partial: Partial<Today>): MockHandler => () => ok({ ...mockToday, ...partial });
const progressOf = (change: (progress: ProgressResponse) => ProgressResponse): MockHandler => () => ok(change(mockProgressWithOtherPlans));

function renderPlan({
  language = "ar",
  handlers = {},
  scenario = {},
  hold,
}: { language?: "ar" | "en"; handlers?: Record<string, MockHandler>; scenario?: Partial<MockScenario>; hold?: Promise<void> } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({
    latencyMs: 0,
    handlers: { ...mockHandlers, ...todayMockHandlers, ...planMockHandlers, "GET /progress": progressOf((progress) => progress), ...handlers },
    scenario: { signedIn: true, hasPlan: true, ...scenario },
  });
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`;
    calls.push(key);
    if (hold !== undefined && key.endsWith("/resume")) await hold;
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <PlanOverviewScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, calls, count: (key: string) => calls.filter((call) => call === key).length };
}

const sectionLabels = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);

// A plan with six sections, so the stage list starts closed.
const manySections = (progress: ProgressResponse): ProgressResponse => ({
  ...progress,
  plans: progress.plans.map((plan) =>
    plan.planId === MOCK_PLAN_ID
      ? {
          ...plan,
          sections: Array.from({ length: 6 }, (_, index) => ({
            ordinal: index + 1,
            reference: String(index + 1),
            titleAr: `اسم القسم (عنصر نائب) ${index + 1}`,
            titleEn: `Section placeholder ${index + 1}`,
            percent: index === 0 ? 40 : 0,
            status: index === 0 ? ("learning" as const) : ("new" as const),
          })),
        }
      : plan,
  ),
});

const onlyOtherPlans = (progress: ProgressResponse): ProgressResponse => ({ ...progress, plans: progress.plans.filter((plan) => plan.planId !== MOCK_PLAN_ID) });

beforeEach(() => {
  installDialogPolyfill();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  clearLoginArrival();
});

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("S-12 Plan overview: the six sections", () => {
  it("shows the H1, the back control and the six sections in the fixed order with the specified copy", async () => {
    renderPlan();
    expect(await screen.findByRole("heading", { level: 1, name: "الخطة الكبرى" })).toBeInTheDocument();
    await screen.findByText("الهدف الكلي");
    expect(sectionLabels()).toEqual(["الهدف الكلي", "الزمن الكلي", "الزمن اليومي", "المراحل", "المراجعات", "الخطوة التالية", "خطط أخرى"]);
    expect(screen.getByRole("link", { name: "رجوع إلى اليوم" })).toHaveAttribute("href", "/today");

    const goal = screen.getByRole("region", { name: "الهدف الكلي" });
    expect(goal).toHaveTextContent("عنوان الكتاب (عنصر نائب) · تسمية الطبعة (عنصر نائب)");
    expect(goal).toHaveTextContent("كل الأقسام");
    expect(goal).toHaveTextContent("ترتيب الكتاب");
    expect(goal).toHaveTextContent("الموعد المفضل: ٢٠ أكتوبر ٢٠٢٦");
    expect(goal).not.toHaveTextContent("المسارات");

    expect(screen.getByRole("region", { name: "الزمن الكلي" })).toHaveTextContent("التقدير المتفق عليه: نحو ١٦ يومًا، حتى ٢٠ أكتوبر ٢٠٢٦.");
    expect(screen.getByRole("region", { name: "الزمن اليومي" })).toHaveTextContent("١٠ دقائق يوميًا، وحتى ٢٥ كلمة جديدة في اليوم.");

    const reviews = screen.getByRole("region", { name: "المراجعات" });
    expect(reviews).toHaveTextContent("تُراجَع كل مقطع بعد يوم، ثم بعد يومين، ثم بعد ٤ أيام؛ وما فاتك يبقى مستحقًا دون عقوبة.");
    expect(reviews).toHaveTextContent("مراجعات مستحقة اليوم: ٢");
    expect(reviews).toHaveTextContent("موعد المراجعة التالي: ٦ أكتوبر ٢٠٢٦");

    expect(screen.getByRole("region", { name: "الخطوة التالية" })).toHaveTextContent("المقطع التالي: اسم القسم (عنصر نائب) ١ (1).");
  });

  it("FC-11: keeps every region 16 px apart in the natural page flow, with no clipping container", async () => {
    renderPlan();
    await screen.findByText("الهدف الكلي");
    for (const name of ["الهدف الكلي", "الزمن الكلي", "الزمن اليومي", "المراحل", "المراجعات", "الخطوة التالية"]) {
      const region = screen.getByRole("region", { name });
      expect(region.className).toContain("mt-q16");
      expect(region.className).not.toMatch(/overflow|h-\[|max-h/);
    }
    const actions = screen.getByRole("link", { name: "تعديل الوقت والهدف" }).closest("div") as HTMLElement;
    expect(actions.className).toContain("mt-q16");
  });

  it("offers «تعديل الوقت والهدف» to S-13 and «بدء خطة أخرى» to S-08", async () => {
    renderPlan();
    expect(await screen.findByRole("link", { name: "تعديل الوقت والهدف" })).toHaveAttribute("href", "/plan/revise");
    expect(screen.getByRole("link", { name: "بدء خطة أخرى" })).toHaveAttribute("href", "/start");
  });

  it("is written in English and left to right for the English interface", async () => {
    renderPlan({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Overall plan" })).toBeInTheDocument();
    await screen.findByText("Overall goal");
    expect(sectionLabels()).toEqual(["Overall goal", "Overall time", "Daily time", "Stages", "Reviews", "Next step", "Other plans"]);
    expect(screen.getByRole("link", { name: "Back to Today" })).toHaveAttribute("href", "/today");
    expect(screen.getByRole("region", { name: "Overall goal" })).toHaveTextContent("Book title (placeholder)");
    expect(screen.getByRole("region", { name: "Overall goal" })).toHaveTextContent("Preferred date: October 20, 2026");
    expect(screen.getByRole("region", { name: "Overall time" })).toHaveTextContent("Agreed estimate: about 16 days, until October 20, 2026.");
    expect(screen.getByRole("region", { name: "Daily time" })).toHaveTextContent("10 minutes a day, up to 25 new words a day.");
    expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("Next passage:");
    expect(screen.getByRole("link", { name: "Change time and goal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start another plan" })).toBeInTheDocument();
  });

  it("names the paths of a hadith plan and leaves the order line to the Quran", async () => {
    const hadith = {
      ...(mockToday.plan as NonNullable<Today["plan"]>),
      editionId: mockCatalog.editions[1]?.editionId ?? "",
      titleAr: "عنوان المجموعة (عنصر نائب)",
      paths: ["matn", "sanad"] as ("matn" | "sanad")[],
      targetScope: { sectionOrdinals: [1] },
    };
    renderPlan({ handlers: { "GET /today": withToday({ plan: hadith }) } });
    const goal = await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(goal).toHaveTextContent("المسارات: متن، سند");
    expect(goal).not.toHaveTextContent("ترتيب الكتاب");
    expect(goal).not.toHaveTextContent("من الناس رجوعًا");
  });

  it("states the scope as «n من m» when only some sections are in the plan", async () => {
    const plan = { ...(mockToday.plan as NonNullable<Today["plan"]>), targetScope: { sectionOrdinals: [1] } };
    renderPlan({ handlers: { "GET /today": withToday({ plan }) } });
    expect(await screen.findByRole("region", { name: "الهدف الكلي" })).toHaveTextContent("١ من ٢ سورة");
  });

  it("says there is no set date when the plan has no preferred date", async () => {
    const plan = { ...(mockToday.plan as NonNullable<Today["plan"]>), preferredDate: null };
    renderPlan({ handlers: { "GET /today": withToday({ plan }) } });
    expect(await screen.findByRole("region", { name: "الهدف الكلي" })).toHaveTextContent("دون موعد محدد");
  });

  it("shows the next review date when there is no new passage, and the maintenance line when there is neither", async () => {
    const first = renderPlan({ handlers: { "GET /today": withToday({ nextNewPassage: null }) } });
    expect(await screen.findByRole("region", { name: "الخطوة التالية" })).toHaveTextContent("المراجعة التالية: ٦ أكتوبر ٢٠٢٦.");
    first.unmount();
    renderPlan({
      handlers: {
        "GET /today": withToday({ nextNewPassage: null }),
        "GET /progress": progressOf((progress) => ({ ...progress, plans: progress.plans.map((plan) => ({ ...plan, nextReviewDate: null })) })),
      },
    });
    expect(await screen.findByText("لا مقاطع جديدة؛ تستمر مراجعات الصيانة.")).toBeInTheDocument();
  });
});

describe("S-12 Plan overview: the stages", () => {
  it("opens the disclosure for five stages or fewer, marks the current stage and prints badge, name and percent", async () => {
    renderPlan();
    const summary = await screen.findByText("المراحل (٢)");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(within(details).getByText(/المرحلة الحالية/)).toHaveTextContent("اسم القسم (عنصر نائب) ١");

    const items = within(details).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(items[0]).toHaveTextContent("قيد التعلم");
    expect(items[0]).toHaveTextContent("٤٠٪");
    expect(items[1]).toHaveTextContent("جديد");
  });

  it("starts closed with six stages, and the summary names the count", async () => {
    renderPlan({ handlers: { "GET /progress": progressOf(manySections) } });
    const summary = await screen.findByText("المراحل (٦)");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("lists the stages in reverse for the reverse plan order (Quran only)", async () => {
    const plan = { ...(mockToday.plan as NonNullable<Today["plan"]>), order: "reverse" as const };
    renderPlan({ handlers: { "GET /today": withToday({ plan }) } });
    const summary = await screen.findByText("المراحل (٢)");
    const items = within(summary.closest("details") as HTMLElement).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("اسم القسم (عنصر نائب) ٢");
    expect(items[1]).toHaveTextContent("اسم القسم (عنصر نائب) ١");
    const goal = screen.getByRole("region", { name: "الهدف الكلي" });
    expect(goal).toHaveTextContent("من الناس رجوعًا");
  });

  it("opens and closes from the summary row, which is a native disclosure", async () => {
    const user = userEvent.setup();
    renderPlan({ handlers: { "GET /progress": progressOf(manySections) } });
    const summary = await screen.findByText("المراحل (٦)");
    const details = summary.closest("details") as HTMLDetailsElement;
    await user.click(summary);
    expect(details.open).toBe(true);
    await user.click(summary);
    expect(details.open).toBe(false);
  });
});

describe("S-12 Plan overview: pending setting and revoked content", () => {
  it("shows the G-32 line in an Info banner and under the daily time", async () => {
    const plan = { ...(mockToday.plan as NonNullable<Today["plan"]>), pendingSessionMinutes: 15 as const };
    renderPlan({ handlers: { "GET /today": withToday({ plan }) } });
    await screen.findByRole("region", { name: "الزمن اليومي" });
    expect(screen.getAllByText("يبدأ هذا التغيير من يوم التعلم التالي (٦ أكتوبر ٢٠٢٦).")).toHaveLength(2);
  });

  it("shows the G-20 banner with a path to S-08 when the edition left the catalog, and the sections keep their text", async () => {
    renderPlan({ handlers: { "GET /catalog": () => ok({ editions: [mockCatalog.editions[1]] }) } });
    expect(await screen.findByText("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.")).toBeInTheDocument();
    expect(screen.getByText("غير متاح")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطة جديدة" })).toHaveAttribute("href", "/start");
    expect(screen.getByRole("region", { name: "الزمن الكلي" })).toBeInTheDocument();
  });
});

describe("S-12 Plan overview: other plans", () => {
  it("lists the paused plan with «استئناف» and the completed plan with no action, each with its G-31 line", async () => {
    renderPlan();
    const heading = await screen.findByRole("heading", { level: 2, name: "خطط أخرى" });
    const list = within(heading.closest("section") as HTMLElement).getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("عنوان المجموعة (عنصر نائب)");
    expect(rows[0]).toHaveTextContent("متوقفة مؤقتًا");
    expect(rows[0]).toHaveTextContent("١٠٪");
    expect(rows[0]).toHaveTextContent("هذه الخطة متوقفة مؤقتًا، وتقدمها محفوظ.");
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "استئناف" })).toHaveAccessibleDescription("عنوان المجموعة (عنصر نائب)");
    expect(rows[1]).toHaveTextContent("مكتملة");
    expect(rows[1]).toHaveTextContent("اكتملت هذه الخطة، وتستمر مراجعات الصيانة.");
    expect(within(rows[1] as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("shows no list when the account has only the active plan", async () => {
    renderPlan({ handlers: { "GET /progress": () => ok(mockProgress) } });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(screen.queryByRole("heading", { name: "خطط أخرى" })).toBeNull();
  });

  it("never offers «استئناف» to a demo account", async () => {
    renderPlan({ scenario: { isDemo: true } });
    await screen.findByRole("heading", { level: 2, name: "خطط أخرى" });
    expect(screen.queryByRole("button", { name: "استئناف" })).toBeNull();
    expect(screen.getByText("هذه الخطة متوقفة مؤقتًا، وتقدمها محفوظ.")).toBeInTheDocument();
  });

  it("does not offer «استئناف» while the account type is unknown (E11 failed)", async () => {
    renderPlan({ handlers: { "GET /me": () => errorResponse(500, "internal", "Unexpected error.") } });
    await screen.findByRole("heading", { level: 2, name: "خطط أخرى" });
    expect(screen.queryByRole("button", { name: "استئناف" })).toBeNull();
  });

  it("asks first when another plan is active, and sends nothing on «إلغاء»", async () => {
    const user = userEvent.setup();
    const view = renderPlan();
    await user.click(await screen.findByRole("button", { name: "استئناف" }));
    const dialog = await screen.findByRole("dialog", { name: "استئناف هذه الخطة؟" });
    expect(dialog).toHaveTextContent("ستتوقف خطتك الحالية «عنوان الكتاب (عنصر نائب)» مؤقتًا ويبقى تقدمها محفوظًا، وتستأنف هذه الخطة من حيث توقفت.");
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    expect(view.count(`POST /plans/${MOCK_PAUSED_PLAN_ID}/resume`)).toBe(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("resumes with E30 once after the dialog, then reads the lists again and confirms with a toast", async () => {
    const user = userEvent.setup();
    const view = renderPlan();
    await user.click(await screen.findByRole("button", { name: "استئناف" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "استئناف الخطة" }));
    await waitFor(() => expect(view.count(`POST /plans/${MOCK_PAUSED_PLAN_ID}/resume`)).toBe(1));
    expect(await screen.findByText("تم استئناف الخطة.", { selector: "span" })).toBeInTheDocument();
    await waitFor(() => expect(view.count("GET /today")).toBe(2));
    expect(view.count("GET /progress")).toBe(2);
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("resumes at once when no plan is active, and offers «ابدأ خطتك» with the list below", async () => {
    const user = userEvent.setup();
    const view = renderPlan({ scenario: { hasPlan: false }, handlers: { "GET /progress": progressOf(onlyOtherPlans) } });
    expect(await screen.findByText("لا توجد خطة نشطة بعد.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطتك" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("link", { name: "تعديل الوقت والهدف" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "استئناف" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(view.count(`POST /plans/${MOCK_PAUSED_PLAN_ID}/resume`)).toBe(1));
  });

  it("shows the loading state of the button while E30 is pending, and a second press sends nothing", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = renderPlan({ scenario: { hasPlan: false }, handlers: { "GET /progress": progressOf(onlyOtherPlans) }, hold });
    await user.click(await screen.findByRole("button", { name: "استئناف" }));
    const busy = await screen.findByRole("button", { name: "جارٍ الاستئناف…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    await user.click(busy);
    expect(view.count(`POST /plans/${MOCK_PAUSED_PLAN_ID}/resume`)).toBe(1);
    release();
    expect(await screen.findByText("تم استئناف الخطة.", { selector: "span" })).toBeInTheDocument();
  });
});
describe("S-12 Plan overview: a resume that is refused", () => {
  async function pressResume(handler: MockHandler) {
    const user = userEvent.setup();
    const view = renderPlan({ scenario: { hasPlan: false }, handlers: { "GET /progress": progressOf(onlyOtherPlans), "POST /plans/:id/resume": handler } });
    await user.click(await screen.findByRole("button", { name: "استئناف" }));
    return view;
  }

  it("409 plan_not_active shows the G-11 completed line as a warning and reads the lists again", async () => {
    const view = await pressResume(() => errorResponse(409, "version_conflict", "Conflict.", { reason: "plan_not_active" }));
    expect(await screen.findByText("اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.")).toBeInTheDocument();
    await waitFor(() => expect(view.count("GET /today")).toBe(2));
  });

  it("403 forbidden shows the G-06 line", async () => {
    await pressResume(() => errorResponse(403, "forbidden", "No."));
    expect(await screen.findByText("هذا الإجراء غير متاح لحساب العرض.")).toBeInTheDocument();
  });

  it("404 shows the G-07 line", async () => {
    await pressResume(() => errorResponse(404, "not_found", "Gone."));
    expect(await screen.findByText("لم نعثر على هذا العنصر.")).toBeInTheDocument();
  });

  it("401 sends the visitor to the login screen with the return path, and raises the session-ended note", async () => {
    await pressResume(() => errorResponse(401, "unauthenticated", "No session."));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fplan"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("503 shows the unavailable warning with no retry button (pressing again is the retry)", async () => {
    await pressResume(() => errorResponse(503, "unavailable", "Down."));
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).toBeNull();
  });
});

describe("S-12 Plan overview: loading and read failures", () => {
  it("shows a skeleton region that is busy while E18 and E19 load", async () => {
    renderPlan();
    expect(screen.getByTestId("today-skeleton")).toHaveAttribute("aria-busy", "true");
    await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(screen.queryByTestId("today-skeleton")).toBeNull();
  });

  it("sends a 401 on the first read to the login screen with next=/plan", async () => {
    renderPlan({ scenario: { signedIn: false } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fplan"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("shows the unavailable warning with a retry that reads again", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const flaky: MockHandler = (request, scenario) => {
      attempts += 1;
      return attempts === 1 ? errorResponse(503, "unavailable", "Down.") : (mockHandlers["GET /today"] as MockHandler)(request, scenario);
    };
    renderPlan({ handlers: { "GET /today": flaky } });
    const retry = await screen.findByRole("button", { name: "إعادة المحاولة" });
    await user.click(retry);
    expect(await screen.findByRole("region", { name: "الهدف الكلي" })).toBeInTheDocument();
  });

  it("shows the internal error as an alert", async () => {
    renderPlan({ handlers: { "GET /progress": () => errorResponse(500, "internal", "Unexpected error.") } });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("keeps the screen when only E14 fails: the title stays and the edition label and scope are left out", async () => {
    renderPlan({ handlers: { "GET /catalog": () => errorResponse(503, "unavailable", "Down.") } });
    const goal = await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(goal).toHaveTextContent("عنوان الكتاب (عنصر نائب)");
    expect(goal).not.toHaveTextContent("تسمية الطبعة");
    expect(goal).not.toHaveTextContent("كل الأقسام");
  });
});

describe("S-12 Plan overview: accessibility semantics", () => {
  it("sets the document title and makes the H1 focusable for the route change", async () => {
    renderPlan();
    const heading = await screen.findByRole("heading", { level: 1, name: "الخطة الكبرى" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-page-heading");
    await waitFor(() => expect(document.title).toBe("الخطة الكبرى · قطرة غيث"));
  });

  it("puts the back control before the H1 and every section label in an h2 of a labelled region", async () => {
    renderPlan();
    const back = await screen.findByRole("link", { name: "رجوع إلى اليوم" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const label of ["الهدف الكلي", "الزمن الكلي", "الزمن اليومي", "المراحل", "المراجعات", "الخطوة التالية"]) {
      expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    }
  });

  it("isolates Arabic titles inside an English line", async () => {
    renderPlan({ language: "en", handlers: { "GET /today": withToday({ nextNewPassage: { reference: "2", sectionTitleAr: "اسم القسم (عنصر نائب) ٢" } }) } });
    const next = await screen.findByRole("region", { name: "Next step" });
    const isolated = next.querySelector("bdi[lang='ar']");
    expect(isolated).toHaveTextContent("اسم القسم (عنصر نائب) ٢");
  });

  it("never shows a certificate, an overall percentage or a promise beyond the agreed estimate", async () => {
    renderPlan();
    await screen.findByRole("region", { name: "الهدف الكلي" });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/شهادة|certificate/i);
    expect(text).not.toContain("٢٤٪");
  });
});
