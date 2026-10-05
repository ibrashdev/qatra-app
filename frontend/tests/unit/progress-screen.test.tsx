import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/progress", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", () => browser);

import { ProgressScreen } from "@/components/progress/ProgressScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { mockProgress, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { PlanProgress, ProgressResponse } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";

const ok = (body: unknown): MockResponse => ({ status: 200, body });
const basePlan = mockProgress.plans[0] as PlanProgress;
const planWith = (change: Partial<PlanProgress>): ProgressResponse => ({ ...mockProgress, plans: [{ ...basePlan, ...change }] });
const serve = (progress: ProgressResponse): Record<string, MockHandler> => ({ "GET /progress": () => ok(progress) });

type Section = PlanProgress["sections"][number];
const section = (ordinal: number, status: Section["status"], percent: number): Section => ({
  ordinal,
  reference: String(ordinal),
  titleAr: `اسم ${ordinal}`,
  titleEn: `Surah ${ordinal}`,
  percent,
  status,
});

function baseHandler(key: string): MockHandler {
  const handler = { ...mockHandlers, ...todayMockHandlers }[key];
  if (handler === undefined) throw new Error(`No mock handler for ${key}.`);
  return handler;
}

function renderProgress({
  language = "ar",
  handlers = {},
  scenario = {},
  latencyMs = 0,
}: { language?: "ar" | "en"; handlers?: Record<string, MockHandler>; scenario?: Partial<MockScenario>; latencyMs?: number } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({ latencyMs, handlers: { ...mockHandlers, ...todayMockHandlers, ...handlers }, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`);
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <ProgressScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { ...view, calls, count: (key: string) => calls.filter((call) => call === key).length };
}

const card = (name: string) => screen.getByRole("region", { name });
const summaryOf = (name: string) => screen.getByText(name).closest("summary") as HTMLElement;
const detailsOf = (name: string) => summaryOf(name).closest("details") as HTMLDetailsElement;

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  clearLoginArrival();
});

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  vi.restoreAllMocks();
});

describe("S-21 Results and progress: the populated screen", () => {
  it("shows the H1, the daily card and the overall card with the specified copy", async () => {
    renderProgress();
    const heading = await screen.findByRole("heading", { level: 1, name: "النتائج والتقدم" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-page-heading");

    const daily = await screen.findByRole("region", { name: "الإنجاز اليومي" });
    expect(within(daily).getByRole("heading", { level: 2, name: "الإنجاز اليومي" })).toBeInTheDocument();
    expect(daily).toHaveTextContent("٧/١٠ دقائق، ٧٠٪");
    expect(daily).toHaveTextContent("الوقت النشط مقابل هدفك اليومي. تُحسب القراءة واللعب، وإن كانت بعض الإجابات خاطئة.");
    expect(daily).toHaveTextContent("أيام متتالية بلغتَ فيها هدفك: ٣");
    expect(daily).not.toHaveTextContent("أكملت هدف اليوم");

    const overall = card("الإنجاز الكلي للخطة");
    expect(within(overall).getByRole("heading", { level: 2, name: "الإنجاز الكلي للخطة" })).toBeInTheDocument();
    expect(overall).toHaveTextContent("٢٤٪");
    expect(overall).toHaveTextContent("٢٤ من ١٠٠ كلمة مؤكدة");
    expect(overall).toHaveTextContent("٠ من ٢ قسم مؤكدة");
    expect(overall).toHaveTextContent("هذه النسبة مؤشر تقدم في خطتك، وليست شهادة حفظ.");

    expect(screen.getByText("موعد المراجعة التالي: ٦ أكتوبر ٢٠٢٦")).toBeInTheDocument();
  });

  it("draws both bars as progressbars with the value in words, fed by the server's overallPercent", async () => {
    renderProgress({ handlers: serve(planWith({ overallPercent: 27 })) });
    await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" });
    const [daily, overall] = screen.getAllByRole("progressbar");
    expect(daily).toHaveAttribute("aria-valuenow", "70");
    expect(daily).toHaveAttribute("aria-valuemin", "0");
    expect(daily).toHaveAttribute("aria-valuemax", "100");
    expect(daily).toHaveAttribute("aria-valuetext", "٧ من ١٠ دقائق، ٧٠ بالمئة");
    expect(daily).toHaveAccessibleName("الإنجاز اليومي");
    expect(overall).toHaveAttribute("aria-valuenow", "27");
    expect(overall).toHaveAttribute("aria-valuetext", "٢٧ بالمئة من الكلمات مؤكدة");
    expect(overall).toHaveAccessibleName("الإنجاز الكلي للخطة");
    expect(card("الإنجاز الكلي للخطة")).toHaveTextContent("٢٧٪");
  });

  it("keeps the two indicators independent: the daily one is not the overall one", async () => {
    renderProgress({ handlers: serve({ ...planWith({ overallPercent: 12, confirmedWords: 12 }), daily: { ...mockProgress.daily, dailyPercent: 90 } }) });
    await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" });
    const [daily, overall] = screen.getAllByRole("progressbar");
    expect(daily).toHaveAttribute("aria-valuenow", "90");
    expect(overall).toHaveAttribute("aria-valuenow", "12");
  });

  it("is read-only: no button, no certificate, no ranking, no accuracy, no calendar", async () => {
    renderProgress();
    await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("grid")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/ترتيب|المتصدر|دقة|شارك/);
    expect(text).not.toContain("استرجاع الكلمات");
  });

  it("the daily card at 100 % shows the check line, extra minutes on their own line, and the bar capped", async () => {
    renderProgress({
      handlers: serve({ ...mockProgress, daily: { ...mockProgress.daily, dailyActiveMs: 720_000, dailyPercent: 100, dailyCompleted: true, extraActiveMs: 120_000 } }),
    });
    const daily = await screen.findByRole("region", { name: "الإنجاز اليومي" });
    expect(daily).toHaveTextContent("١٠/١٠ دقائق، ١٠٠٪");
    expect(daily).toHaveTextContent("أكملت هدف اليوم");
    expect(within(daily).getByText("+ ٢ دقيقة إضافية")).toBeInTheDocument();
    expect(within(daily).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("a streak of zero shows the neutral line, and a missing next review the empty line", async () => {
    const view = renderProgress({
      handlers: { ...serve(planWith({ nextReviewDate: null })), "GET /today": (request, scenario) => ok({ ...(baseHandler("GET /today")(request, scenario).body as object), streakDays: 0 }) },
    });
    expect(await screen.findByText("لا توجد أيام متتالية بعد.")).toBeInTheDocument();
    expect(screen.getByText("لا توجد مراجعة قادمة بعد.")).toBeInTheDocument();
    expect(screen.queryByText(/موعد المراجعة التالي/)).toBeNull();
    expect(view.count("GET /today")).toBe(1);
  });

  it("zero progress shows an empty track, ٠٪ and the explanation, and no empty group", async () => {
    renderProgress({
      handlers: serve(planWith({ overallPercent: 0, confirmedWords: 0, counts: { new: 2, learning: 0, reviewing: 0, confirmed: 0, needsRefresh: 0 }, sections: [section(1, "new", 0), section(2, "new", 0)] })),
    });
    const overall = await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" });
    expect(overall).toHaveTextContent("٠٪");
    expect(within(overall).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(overall).toHaveTextContent("يظهر التقدم هنا بعد أن تؤكد أول مقطع؛ التأكيد يأتي بعد مراجعات متباعدة.");
    expect(document.querySelector("details")).toBeNull();
  });

  it("does not show the zero-progress line once something is confirmed", async () => {
    renderProgress();
    await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" });
    expect(screen.queryByText(/يظهر التقدم هنا/)).toBeNull();
  });
});

describe("S-21 the three disclosures", () => {
  const sections = [
    section(1, "needs_refresh", 55),
    section(2, "needs_refresh", 61),
    section(3, "learning", 40),
    section(4, "reviewing", 80),
    section(5, "confirmed", 100),
    section(6, "new", 0),
  ];
  const withSections = (change: Partial<PlanProgress> = {}) => serve(planWith({ confirmedSections: 1, totalSections: 6, sections, ...change }));

  it("lists needs refresh, in progress and confirmed in that order, as native disclosures with counts in their names", async () => {
    renderProgress({ handlers: withSections() });
    await screen.findByText("يحتاج تحديثًا (٢)");
    const summaries = Array.from(document.querySelectorAll("summary")).map((element) => element.textContent);
    expect(summaries).toEqual(["يحتاج تحديثًا (٢)", "قيد التقدم (٢)", "المؤكدة (١)"]);
    expect(document.querySelectorAll("details")).toHaveLength(3);
  });

  it("opens needs refresh and in progress, closes confirmed, and the summary toggles it", async () => {
    const user = userEvent.setup();
    renderProgress({ handlers: withSections() });
    await screen.findByText("المؤكدة (١)");
    expect(detailsOf("يحتاج تحديثًا (٢)").open).toBe(true);
    expect(detailsOf("قيد التقدم (٢)").open).toBe(true);
    const confirmed = detailsOf("المؤكدة (١)");
    expect(confirmed.open).toBe(false);
    await user.click(summaryOf("المؤكدة (١)"));
    expect(confirmed.open).toBe(true);
  });

  it("puts learning and reviewing in the in-progress group, each with its own badge, and leaves new sections out", async () => {
    renderProgress({ handlers: withSections() });
    await screen.findByText("قيد التقدم (٢)");
    const group = detailsOf("قيد التقدم (٢)");
    const rows = within(group).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("اسم 3");
    expect(rows[0]).toHaveTextContent("قيد التعلم");
    expect(rows[0]).toHaveTextContent("٤٠٪");
    expect(rows[1]).toHaveTextContent("قيد التقدم");
    expect(rows[1]).toHaveTextContent("٨٠٪");
    expect(screen.queryByText("اسم 6")).toBeNull();
    expect(screen.queryByText("جديد")).toBeNull();
  });

  it("shows the confirmed group with the confirmed badge and the needs-refresh group with its explanation and badges", async () => {
    renderProgress({ handlers: withSections() });
    await screen.findByText("المؤكدة (١)");
    const confirmed = detailsOf("المؤكدة (١)");
    expect(within(confirmed).getByText("مؤكد")).toBeInTheDocument();
    expect(confirmed).toHaveTextContent("١٠٠٪");
    expect(confirmed).not.toHaveTextContent("هذه المقاطع احتاجت إلى مراجعة");

    const refresh = detailsOf("يحتاج تحديثًا (٢)");
    expect(refresh).toHaveTextContent("هذه المقاطع احتاجت إلى مراجعة بعد تأكيدها، فخرجت مؤقتًا من الإنجاز الكلي حتى تجتاز مراجعاتها من جديد.");
    expect(within(refresh).getAllByText("يحتاج تحديثًا")).toHaveLength(2);
    // The badge uses warning tokens, never the error ones.
    const badge = within(refresh).getAllByText("يحتاج تحديثًا")[0] as HTMLElement;
    expect(badge.className).toContain("bg-warning-tint");
    expect(badge.className).not.toMatch(/error/);
  });

  it("each row is plain text: no link and no control inside a disclosure but its summary", async () => {
    renderProgress({ handlers: withSections() });
    await screen.findByText("المؤكدة (١)");
    for (const details of Array.from(document.querySelectorAll("details"))) {
      expect(within(details as HTMLElement).queryAllByRole("link")).toHaveLength(0);
      expect(within(details as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    }
  });

  it("rows are at least 56 px (min-h-row), and the summaries too", async () => {
    renderProgress({ handlers: withSections() });
    await screen.findByText("المؤكدة (١)");
    for (const summary of Array.from(document.querySelectorAll("summary"))) expect(summary.className).toContain("min-h-row");
    for (const row of Array.from(document.querySelectorAll("details li"))) expect(row.className).toContain("min-h-row");
  });

  it("names the sections by the interface language and isolates them for mixed direction", async () => {
    renderProgress({ language: "en", handlers: withSections() });
    await screen.findByText("Needs refresh (2)");
    const group = detailsOf("In progress (2)");
    expect(within(group).getByText("Surah 3").tagName).toBe("BDI");
    expect(within(group).queryByText("اسم 3")).toBeNull();
    expect(group).toHaveTextContent("Learning");
    expect(group).toHaveTextContent("40%");
    expect(screen.getByText("1 of 6 surahs confirmed")).toBeInTheDocument();
  });
});

describe("S-21 plan states", () => {
  it("a completed plan shows the stored values with the G-31 banner", async () => {
    renderProgress({ handlers: serve(planWith({ status: "completed", overallPercent: 100, confirmedWords: 100 })) });
    expect(await screen.findByText("اكتملت هذه الخطة، وتستمر مراجعات الصيانة.")).toBeInTheDocument();
    expect(card("الإنجاز الكلي للخطة")).toHaveTextContent("١٠٠٪");
  });

  it("an active plan wins over a completed one, and no banner is shown", async () => {
    renderProgress({ handlers: serve({ ...mockProgress, plans: [{ ...basePlan, status: "completed", overallPercent: 100 }, { ...basePlan, planId: "other", overallPercent: 24 }] }) });
    await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" });
    expect(card("الإنجاز الكلي للخطة")).toHaveTextContent("٢٤٪");
    expect(screen.queryByText("اكتملت هذه الخطة، وتستمر مراجعات الصيانة.")).toBeNull();
  });

  it("with no plan it shows the empty state with «ابدأ خطتك» and no link to previous plans", async () => {
    renderProgress({ scenario: { hasPlan: false } });
    expect(await screen.findByRole("heading", { level: 2, name: "لا توجد خطة نشطة بعد." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطتك" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("link", { name: "الخطط السابقة" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "النتائج والتقدم" })).toBeInTheDocument();
  });

  it("with only a paused plan it adds the link to previous plans", async () => {
    renderProgress({ handlers: serve(planWith({ status: "paused" })) });
    expect(await screen.findByRole("link", { name: "الخطط السابقة" })).toHaveAttribute("href", "/plan");
    expect(screen.getByRole("link", { name: "ابدأ خطتك" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("S-21 loading and failures", () => {
  it("shows no skeleton before 300 ms, then the skeleton with no numbers, then the screen", async () => {
    renderProgress({ latencyMs: 600 });
    const region = screen.getByTestId("progress-skeleton");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.querySelector("[aria-hidden='true']")).toBeNull();
    expect(screen.getByText("جارٍ التحميل")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("progress-skeleton").querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0));
    expect(document.body.textContent ?? "").not.toMatch(/[٠-٩]/);
    expect(await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" })).toBeInTheDocument();
    expect(screen.queryByTestId("progress-skeleton")).toBeNull();
  });

  it("a service error shows the warning with «إعادة المحاولة», no numbers, and a retry reads again", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const view = renderProgress({ handlers: { "GET /progress": (request, scenario) => (answers++ === 0 ? errorResponse(503, "unavailable", "Down.") : baseHandler("GET /progress")(request, scenario)) } });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "الإنجاز الكلي للخطة" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "النتائج والتقدم" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(await screen.findByRole("region", { name: "الإنجاز الكلي للخطة" })).toBeInTheDocument();
    expect(view.count("GET /progress")).toBe(2);
    expect(screen.queryByText(/الخدمة غير متاحة/)).toBeNull();
  });

  it("retry clears the old numbers while it loads", async () => {
    const user = userEvent.setup();
    renderProgress({ latencyMs: 0, handlers: { "GET /progress": () => errorResponse(500, "internal", "Boom.") } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    await user.click(within(alert).getByRole("button", { name: "إعادة المحاولة" }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("a failed E18 only leaves the streak line out", async () => {
    renderProgress({ handlers: { "GET /today": () => errorResponse(503, "unavailable", "Down.") } });
    const daily = await screen.findByRole("region", { name: "الإنجاز اليومي" });
    expect(daily).toHaveTextContent("٧/١٠ دقائق، ٧٠٪");
    expect(screen.queryByText(/أيام متتالية|لا توجد أيام متتالية/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/الخدمة غير متاحة/)).toBeNull();
  });

  it("offline shows the Info banner of P-05 with «إعادة المحاولة», and no error tone", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const lost = () => {
      throw new TypeError("The mock connection failed.");
    };
    renderProgress({ handlers: { "GET /today": lost, "GET /progress": lost, "GET /health": lost } });
    expect(await screen.findByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("revoked content is an error banner with a path to a new plan, announced as an alert", async () => {
    renderProgress({ handlers: { "GET /progress": () => errorResponse(422, "edition_not_available", "Gone.") } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("غير متاح");
    expect(within(alert).getByRole("link", { name: "ابدأ خطة جديدة" })).toHaveAttribute("href", "/start");
  });

  it("a session that ended goes to S-01 with S-21 as the return path and raises the banner", async () => {
    renderProgress({ handlers: { "GET /progress": () => errorResponse(401, "unauthenticated", "Out.") } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fprogress"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("a session that ended on E18 alone does the same", async () => {
    renderProgress({ handlers: { "GET /today": () => errorResponse(401, "unauthenticated", "Out.") } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fprogress"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-21 English", () => {
  it("shows the English copy in the same order and structure", async () => {
    renderProgress({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Results and progress" })).toBeInTheDocument();
    const daily = card("Daily progress");
    expect(daily).toHaveTextContent("7/10 minutes, 70%");
    expect(daily).toHaveTextContent("Active time against your daily goal. Reading and play both count, even with some wrong answers.");
    expect(daily).toHaveTextContent("Days in a row you reached your goal: 3");
    const overall = card("Overall plan progress");
    expect(overall).toHaveTextContent("24%");
    expect(overall).toHaveTextContent("24 of 100 words confirmed");
    expect(overall).toHaveTextContent("This percentage is a progress indicator for your plan, not a memorization certificate.");
    expect(screen.getByText("Next review: October 6, 2026")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")[1]).toHaveAttribute("aria-valuetext", "24 percent of the words confirmed");
  });
});
