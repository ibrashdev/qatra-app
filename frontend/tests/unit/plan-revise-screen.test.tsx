import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/plan/revise", useRouter: () => navigation.router }));

import { peekPlanConfirmed, takePlanConfirmed } from "@/components/plan-chat/confirmed-flash";
import { PlanReviseScreen } from "@/components/plan-revise/PlanReviseScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { MOCK_HADITH_EDITION_ID, MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockCatalog, mockToday } from "@/lib/api/mock/fixtures";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { mockProgressWithOtherPlans, planMockHandlers } from "@/lib/api/mock/plan-handlers";
import { todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { Plan, ProgressResponse, Today } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { installDialogPolyfill } from "./dialog-polyfill";

const basePlan = mockToday.plan as Plan;
const ok = (body: unknown): MockResponse => ({ status: 200, body });
const withToday = (partial: Partial<Today>): MockHandler => () => ok({ ...mockToday, ...partial });
const withPlan = (change: Partial<Plan>): MockHandler => withToday({ plan: { ...basePlan, ...change } });
const conflict = (reason: string, details: Record<string, unknown> = {}): MockResponse => errorResponse(409, "version_conflict", "Conflict.", { reason, ...details });

function renderRevise({
  language = "ar",
  handlers = {},
  scenario = {},
  revealForm = false,
  hold,
}: { language?: "ar" | "en"; handlers?: Record<string, MockHandler>; scenario?: Partial<MockScenario>; revealForm?: boolean; hold?: Promise<void> } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({
    latencyMs: 0,
    handlers: { ...mockHandlers, ...todayMockHandlers, ...planMockHandlers, ...handlers },
    scenario: { signedIn: true, hasPlan: true, ...scenario },
  });
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (hold !== undefined && key === "POST /plan-chats") await hold;
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <PlanReviseScreen revealForm={revealForm} />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  const sent = (key: string) => calls.filter((call) => call.key === key);
  return { ...view, calls, sent, count: (key: string) => sent(key).length };
}

const startButton = () => screen.getByRole("button", { name: /^(ابدأ التعديل مع المساعد|جارٍ تجهيز المحادثة…|Start the revision with the assistant|Preparing the conversation…)$/ });
const calculateButton = () => screen.getByRole("button", { name: /^(احسب التقدير|جارٍ الحساب…|Calculate the estimate|Calculating…)$/ });
const MINUTES_15 = { name: "١٥ دقيقة" };

beforeEach(() => {
  installDialogPolyfill();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  clearLoginArrival();
  takePlanConfirmed();
});

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("S-13 Plan revision: the entry", () => {
  it("shows the back control, the H1, the summary, the explanation, the helper, the transparency line and the primary button", async () => {
    renderRevise();
    expect(await screen.findByRole("heading", { level: 1, name: "تعديل الوقت والهدف" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "رجوع إلى الخطة الكبرى" })).toHaveAttribute("href", "/plan");

    const goal = await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(goal).toHaveTextContent("عنوان الكتاب (عنصر نائب) · تسمية الطبعة (عنصر نائب)");
    expect(screen.getByRole("region", { name: "الزمن اليومي" })).toHaveTextContent("١٠ دقائق يوميًا، ونحو ٣ آيات جديدة في اليوم.");

    expect(screen.getByText(/^تُعدَّل الخطة بالحديث مع المساعد: أقل دقائق، موعد أبعد، مسارات الحديث، أو ترتيب جزء عم\./)).toBeInTheDocument();
    expect(screen.getByText("يمكنك التعديل بالاختصارات وحدها دون كتابة نص حر.")).toBeInTheDocument();
    expect(screen.getByText(/^تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي/)).toBeInTheDocument();
    expect(startButton()).toHaveAccessibleName("ابدأ التعديل مع المساعد");
    // The form is not shown by default, and there is no scope or edition picker.
    expect(screen.queryByRole("heading", { name: "تعديل بالنموذج" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("FC-05: the primary action sits in an 80 px action area in the flow, and S-13 has no step indicator", async () => {
    const { container } = renderRevise();
    const button = await screen.findByRole("button", { name: "ابدأ التعديل مع المساعد" });
    const area = container.querySelector<HTMLElement>("[data-action-area]");
    expect(area).not.toBeNull();
    expect(area).toContainElement(button);
    expect(area?.className).toContain("min-h-[5rem]");
    expect(area?.className).toContain("py-q16");
    // Normal reflow, not pinned to the screen.
    expect(area?.className).not.toMatch(/\b(sticky|fixed|absolute)\b/);
    // The approved S-13 specification has no step indicator, so none is shown.
    expect(screen.queryByRole("list", { name: /step|خطو/i })).toBeNull();
  });

  it("shows the second sentence of the helper to a demo account", async () => {
    renderRevise({ scenario: { isDemo: true } });
    expect(await screen.findByText("في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط.")).toBeInTheDocument();
    expect(screen.queryByText("يمكنك التعديل بالاختصارات وحدها دون كتابة نص حر.")).toBeNull();
    expect(startButton()).toBeInTheDocument();
  });

  it("is written in English and left to right for the English interface", async () => {
    renderRevise({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Change time and goal" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Back to Overall plan" })).toHaveAttribute("href", "/plan");
    expect(screen.getByText(/^You change the plan by talking to the assistant/)).toBeInTheDocument();
    expect(screen.getByText("You can make the change with the shortcuts alone, without typing free text.")).toBeInTheDocument();
    expect(startButton()).toHaveAccessibleName("Start the revision with the assistant");
  });

  it("shows the pending-setting line of G-32 in the summary", async () => {
    renderRevise({ handlers: { "GET /today": withPlan({ pendingSessionMinutes: 15 }) } });
    expect(await screen.findByText("يبدأ هذا التغيير من يوم التعلم التالي (٦ أكتوبر ٢٠٢٦).")).toBeInTheDocument();
  });

  it("adds the paused note for a paused plan", async () => {
    renderRevise({ handlers: { "GET /today": withPlan({ status: "paused" }) } });
    expect(await screen.findByText("تبقى الخطة متوقفة مؤقتًا بعد التعديل.")).toBeInTheDocument();
  });

  it("shows a skeleton that is busy while the plan loads", async () => {
    renderRevise();
    expect(screen.getByTestId("today-skeleton")).toHaveAttribute("aria-busy", "true");
    await screen.findByRole("region", { name: "الهدف الكلي" });
    expect(screen.queryByTestId("today-skeleton")).toBeNull();
  });
});

describe("S-13 Plan revision: starting the conversation (E31 with the plan id)", () => {
  it("sends the plan's own parameters with the composed sentence once, then replaces the route with the conversation", async () => {
    const user = userEvent.setup();
    const view = renderRevise();
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/plan/chat/66666666-6666-4666-8666-000000000001"));
    const calls = view.sent("POST /plan-chats");
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      editionId: MOCK_QURAN_EDITION_ID,
      targetScope: { sectionOrdinals: [1, 2] },
      paths: ["quran"],
      sessionMinutes: 10,
      preferredDate: "2026-10-20",
      language: "ar",
      planId: MOCK_PLAN_ID,
    });
    expect(body.goalText).toEqual(expect.stringContaining("كل الأقسام"));
    expect(Object.keys(body).sort()).toEqual(["editionId", "goalText", "language", "paths", "planId", "preferredDate", "sessionMinutes", "targetScope"]);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("sends the English interface language with an English sentence", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ language: "en" });
    await screen.findByRole("region", { name: "Overall goal" });
    await user.click(startButton());
    await waitFor(() => expect(view.count("POST /plan-chats")).toBe(1));
    const body = view.sent("POST /plan-chats")[0]?.body as { language: string; goalText: string };
    expect(body.language).toBe("en");
    expect(body.goalText).toContain("all sections");
  });

  it("keeps the button loading and ignores a second press while the call is pending", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = renderRevise({ hold });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    const busy = await screen.findByRole("button", { name: "جارٍ تجهيز المحادثة…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    await user.click(busy);
    expect(view.count("POST /plan-chats")).toBe(1);
    release();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledTimes(1));
    // On success the button keeps its loading state while the conversation opens.
    expect(screen.getByRole("button", { name: "جارٍ تجهيز المحادثة…" })).toBeInTheDocument();
  });

  it("sends a plan with a date that has passed without the date, so E31 does not refuse it", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ handlers: { "GET /today": withPlan({ preferredDate: "2026-10-01" }) } });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    await waitFor(() => expect(view.count("POST /plan-chats")).toBe(1));
    expect(view.sent("POST /plan-chats")[0]?.body).not.toHaveProperty("preferredDate");
  });
});

describe("S-13 Plan revision: start failures", () => {
  const failing = (response: MockResponse): Record<string, MockHandler> => ({ "POST /plan-chats": () => response });

  it("503 shows the unavailable warning with «إعادة المحاولة» and «تعديل بالنموذج», and never retries by itself", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ handlers: failing(errorResponse(503, "unavailable", "Down.")) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تعديل بالنموذج" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.count("POST /plan-chats")).toBe(1);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    // A press on «إعادة المحاولة» sends exactly one more.
    await user.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    await waitFor(() => expect(view.count("POST /plan-chats")).toBe(2));
  });

  it("shows the same two actions when no answer arrives at all, and sends nothing again by itself", async () => {
    const user = userEvent.setup();
    const view = renderRevise({
      handlers: {
        "POST /plan-chats": () => {
          throw new TypeError("The mock connection failed.");
        },
      },
    });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    expect(await screen.findByRole("button", { name: "تعديل بالنموذج" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.count("POST /plan-chats")).toBe(1);
  });

  it("500 shows the generic error as an alert with the same two actions", async () => {
    const user = userEvent.setup();
    renderRevise({ handlers: failing(errorResponse(500, "internal", "Unexpected error.")) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
    expect(within(alert).getByRole("button", { name: "تعديل بالنموذج" })).toBeInTheDocument();
  });

  it("reveals the structured form from the banner and moves focus to its heading", async () => {
    const user = userEvent.setup();
    renderRevise({ handlers: failing(errorResponse(503, "unavailable", "Down.")) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    await user.click(await screen.findByRole("button", { name: "تعديل بالنموذج" }));
    const heading = await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    expect(heading).toHaveFocus();
    expect(screen.getByText("المساعد غير متاح الآن. عدّل الخيارات هنا ثم راجع التقدير الجديد.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "تعديل بالنموذج" })).toBeNull();
  });

  it("429 shows the throttle warning and keeps the button inert until the wait is over", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ handlers: failing(errorResponse(429, "throttled", "Slow down.", { retryAfterSec: 20 })) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    await waitFor(() => expect(startButton()).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByText(/٢٠/, { selector: "div" })).toBeInTheDocument();
    await user.click(startButton());
    expect(view.count("POST /plan-chats")).toBe(1);
    expect(screen.queryByRole("button", { name: "تعديل بالنموذج" })).toBeNull();
  });

  it("401 sends the visitor to the login screen with next=/plan/revise", async () => {
    const user = userEvent.setup();
    renderRevise({ handlers: failing(errorResponse(401, "unauthenticated", "No session.")) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fplan%2Frevise"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("409 plan_not_active removes the button and the form and says the plan is completed", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true, handlers: failing(conflict("plan_not_active")) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    expect(await screen.findByText("اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "تعديل بالنموذج" })).toBeNull();
    expect(screen.getByRole("link", { name: "العودة إلى الخطة الكبرى" })).toHaveAttribute("href", "/plan");
  });

  it("404 says «لم نعثر على هذا العنصر.» with a button to S-12", async () => {
    const user = userEvent.setup();
    renderRevise({ handlers: failing(errorResponse(404, "not_found", "Gone.")) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    expect(await screen.findByText("لم نعثر على هذا العنصر.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "العودة إلى الخطة الكبرى" })).toHaveAttribute("href", "/plan");
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
  });

  it("422 edition_not_available shows «غير متاح» with the G-20 line and a path to S-08", async () => {
    const user = userEvent.setup();
    renderRevise({ handlers: failing(errorResponse(422, "validation_error", "Invalid.", { fields: [{ field: "editionId", rule: "edition_not_available" }] })) });
    await screen.findByRole("region", { name: "الهدف الكلي" });
    await user.click(startButton());
    expect(await screen.findByText("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.")).toBeInTheDocument();
    expect(screen.getByText("غير متاح")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطة جديدة" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
  });

  it("shows the G-20 banner on arrival when the edition left the catalog", async () => {
    renderRevise({ handlers: { "GET /catalog": () => ok({ editions: [mockCatalog.editions[1]] }) } });
    expect(await screen.findByText("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
  });

  it("shows a banner when the first read fails, with a retry that reads again", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const flaky: MockHandler = (request, scenario) => {
      attempts += 1;
      return attempts === 1 ? errorResponse(503, "unavailable", "Down.") : (mockHandlers["GET /today"] as MockHandler)(request, scenario);
    };
    renderRevise({ handlers: { "GET /today": flaky } });
    await user.click(await screen.findByRole("button", { name: "إعادة المحاولة" }));
    expect(await screen.findByRole("region", { name: "الهدف الكلي" })).toBeInTheDocument();
  });

  it("sends a 401 on the first read to the login screen", async () => {
    renderRevise({ scenario: { signedIn: false } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fplan%2Frevise"));
  });
});

describe("S-13 Plan revision: a plan that cannot be revised", () => {
  const completedOnly = (progress: ProgressResponse): ProgressResponse => ({ ...progress, plans: progress.plans.filter((plan) => plan.status === "completed") });
  const pausedOnly = (progress: ProgressResponse): ProgressResponse => ({ ...progress, plans: progress.plans.filter((plan) => plan.status === "paused") });

  it("shows the G-11 completed line and no button or form for a completed plan", async () => {
    renderRevise({ scenario: { hasPlan: false }, handlers: { "GET /progress": () => ok(completedOnly(mockProgressWithOtherPlans)) } });
    expect(await screen.findByText("اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
    expect(screen.getByRole("link", { name: "العودة إلى الخطة الكبرى" })).toHaveAttribute("href", "/plan");
  });

  it("shows the G-11 line for a paused plan whose details E18 does not carry, with a way to S-12 where it is resumed", async () => {
    renderRevise({ scenario: { hasPlan: false }, handlers: { "GET /progress": () => ok(pausedOnly(mockProgressWithOtherPlans)) } });
    expect(await screen.findByText("هذه الخطة غير نشطة.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
    expect(screen.getByRole("link", { name: "العودة إلى الخطة الكبرى" })).toHaveAttribute("href", "/plan");
  });

  it("shows the empty state of G-24 when the account has no plan at all", async () => {
    renderRevise({ scenario: { hasPlan: false } });
    expect(await screen.findByText("لا توجد خطة نشطة بعد.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ابدأ خطتك" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("button", { name: "ابدأ التعديل مع المساعد" })).toBeNull();
  });
});

describe("S-13 Plan revision: the structured form (E15 and E17)", () => {
  it("opens at once when the page says so, with the fields of a Quran plan and the button inert until something changes", async () => {
    renderRevise({ revealForm: true });
    expect(await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "وقتك اليومي" })).toBeInTheDocument();
    expect(screen.getByLabelText("الموعد المفضل (اختياري)")).toHaveValue("2026-10-20");
    expect(screen.getByRole("radiogroup", { name: "ترتيب الخطة" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ما تريد تعلمه" })).toBeNull();
    expect(screen.getByRole("radio", { name: "ترتيب الكتاب" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "من الناس رجوعًا" })).not.toBeChecked();
    const calculate = calculateButton();
    expect(calculate).toHaveAttribute("aria-disabled", "true");
    expect(calculate).toHaveAccessibleDescription("لم يتغير شيء بعد.");
  });

  it("does not send E15 while nothing has changed", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(calculateButton());
    expect(view.count("POST /plans/estimate")).toBe(0);
  });

  it("calculates the estimate with E15 and shows it with the three labels, the reason line and the confirm button", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    expect(calculateButton()).not.toHaveAttribute("aria-disabled");
    await user.click(calculateButton());

    const heading = await screen.findByRole("heading", { level: 2, name: "التقدير الجديد" });
    expect(heading).toHaveFocus();
    expect(view.sent("POST /plans/estimate")[0]?.body).toEqual({
      editionId: MOCK_QURAN_EDITION_ID,
      targetScope: { sectionOrdinals: [1, 2] },
      paths: ["quran"],
      sessionMinutes: 15,
      preferredDate: "2026-10-20",
      order: "book",
    });
    const preview = screen.getByRole("region", { name: "التقدير الجديد" });
    expect(preview).toHaveTextContent("نحو ٣ أيام، حتى ٨ أكتوبر ٢٠٢٦");
    expect(preview).toHaveTextContent("١٥ دقيقة يوميًا، ونحو ٧ آيات جديدة في اليوم");
    expect(preview).toHaveTextContent("عند الاعتماد يسري التعديل من يوم التعلم التالي.");
    expect(preview).toHaveTextContent("يناسب هذا التقدير موعدك المفضل.");
    expect(within(preview).getByText("الزمن الكلي")).toBeInTheDocument();
    expect(within(preview).getByText("الزمن اليومي")).toBeInTheDocument();
    expect(within(preview).getByText("الخطوة التالية")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "اعتماد التعديل" })).toBeInTheDocument();
    expect(screen.getByText("ظهر التقدير الجديد")).toBeInTheDocument();
  });

  it("shows the exceeds-date line when the server says the estimate goes past the preferred date", async () => {
    const user = userEvent.setup();
    const answer = { estimate: { ...basePlan.agreedEstimate, days: 40, endDate: "2026-11-14" }, alternatives: [], reasonCode: "exceeds_preferred_date" };
    renderRevise({ revealForm: true, handlers: { "POST /plans/estimate": () => ok(answer) } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", { name: "٥ دقائق" }));
    await user.click(calculateButton());
    expect(await screen.findByText("يتجاوز هذا التقدير موعدك المفضل. يمكنك اختيار وقت يومي أطول أو موعد أبعد.")).toBeInTheDocument();
    expect(screen.queryByText("يناسب هذا التقدير موعدك المفضل.")).toBeNull();
  });

  it("shows no reason line when the plan has no preferred date", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true, handlers: { "GET /today": withPlan({ preferredDate: null }) } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    const preview = await screen.findByRole("region", { name: "التقدير الجديد" });
    expect(preview).not.toHaveTextContent("موعدك المفضل");
  });

  it("hides the estimate again when a field changes after it, so it is never confirmed for other values", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await screen.findByRole("heading", { level: 2, name: "التقدير الجديد" });
    await user.click(screen.getByRole("radio", { name: "٥ دقائق" }));
    expect(screen.queryByRole("heading", { name: "التقدير الجديد" })).toBeNull();
    expect(screen.queryByRole("button", { name: "اعتماد التعديل" })).toBeNull();
  });

  it("confirms through the dialog: E17 gets the version, the changed fields and the confirmed estimate, then S-11 follows with the toast flag", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));

    const dialog = await screen.findByRole("dialog", { name: "اعتماد التعديل؟" });
    expect(dialog).toHaveTextContent("يسري هذا التعديل من يوم التعلم التالي. ما أنجزته اليوم يبقى كما هو، وتبقى أدلة الخطة السابقة محفوظة.");
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    expect(view.count(`POST /plans/${MOCK_PLAN_ID}/revise`)).toBe(0);

    await user.click(screen.getByRole("button", { name: "اعتماد التعديل" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    const revise = view.sent(`POST /plans/${MOCK_PLAN_ID}/revise`);
    expect(revise).toHaveLength(1);
    expect(revise[0]?.body).toMatchObject({ expectedVersion: 1, sessionMinutes: 15, confirmedEstimate: { sessionMinutes: 15, newWordsPerDay: 40, days: 3 } });
    expect(Object.keys(revise[0]?.body as object).sort()).toEqual(["confirmedEstimate", "expectedVersion", "sessionMinutes"]);
    expect(peekPlanConfirmed()).toBe("revised");
  });

  it("adds the paused sentence to the dialog of a paused plan", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true, handlers: { "GET /today": withPlan({ status: "paused" }) } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("وتبقى الخطة متوقفة مؤقتًا.");
  });

  it("refuses a past date at the field without sending E15, and puts focus on the field", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true });
    const date = await screen.findByLabelText("الموعد المفضل (اختياري)");
    fireEvent.change(date, { target: { value: "2020-01-01" } });
    await user.click(calculateButton());
    expect(await screen.findByText("اختر موعدًا من اليوم فصاعدًا.")).toBeInTheDocument();
    expect(date).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(date).toHaveFocus());
    expect(view.count("POST /plans/estimate")).toBe(0);
  });

  it("sends a changed date as `preferredDate` and not the minutes that stayed", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true });
    const date = await screen.findByLabelText("الموعد المفضل (اختياري)");
    fireEvent.change(date, { target: { value: "2099-01-01" } });
    await user.click(calculateButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
    await waitFor(() => expect(view.count(`POST /plans/${MOCK_PLAN_ID}/revise`)).toBe(1));
    const body = view.sent(`POST /plans/${MOCK_PLAN_ID}/revise`)[0]?.body as Record<string, unknown>;
    expect(body.preferredDate).toBe("2099-01-01");
    expect(body).not.toHaveProperty("sessionMinutes");
  });

  it("changes the Juz' Amma order with the order control and sends it", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", { name: "من الناس رجوعًا" }));
    await user.click(calculateButton());
    await screen.findByRole("heading", { level: 2, name: "التقدير الجديد" });
    expect((view.sent("POST /plans/estimate")[0]?.body as { order: string }).order).toBe("reverse");
    await user.click(screen.getByRole("button", { name: "اعتماد التعديل" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
    await waitFor(() => expect(view.count(`POST /plans/${MOCK_PLAN_ID}/revise`)).toBe(1));
    expect(view.sent(`POST /plans/${MOCK_PLAN_ID}/revise`)[0]?.body).toMatchObject({ order: "reverse" });
  });

  describe("for a hadith plan", () => {
    const hadithToday = withPlan({
      editionId: MOCK_HADITH_EDITION_ID,
      titleAr: "عنوان المجموعة (عنصر نائب)",
      titleEn: "Collection title (placeholder)",
      paths: ["matn"],
      targetScope: { sectionOrdinals: [1] },
    });

    it("shows the three path boxes instead of the order, and never lets the last one be unchecked", async () => {
      const user = userEvent.setup();
      renderRevise({ revealForm: true, handlers: { "GET /today": hadithToday } });
      const group = await screen.findByRole("group", { name: "ما تريد تعلمه" });
      expect(screen.queryByRole("radiogroup", { name: "ترتيب الخطة" })).toBeNull();
      const matn = within(group).getByRole("checkbox", { name: "متن" });
      expect(matn).toBeChecked();
      expect(matn).toHaveAttribute("aria-disabled", "true");
      expect(within(group).getByRole("checkbox", { name: "سند" })).not.toBeChecked();
      expect(within(group).getByRole("checkbox", { name: "الدرجة" })).not.toBeChecked();
      expect(group).toHaveAccessibleDescription("يبقى مسار واحد على الأقل.");
      await user.click(matn);
      expect(matn).toBeChecked();
    });

    it("sends the chosen paths in the fixed order to E15 and E17", async () => {
      const user = userEvent.setup();
      const view = renderRevise({ revealForm: true, handlers: { "GET /today": hadithToday } });
      const group = await screen.findByRole("group", { name: "ما تريد تعلمه" });
      await user.click(within(group).getByRole("checkbox", { name: "الدرجة" }));
      await user.click(within(group).getByRole("checkbox", { name: "سند" }));
      await user.click(calculateButton());
      await screen.findByRole("heading", { level: 2, name: "التقدير الجديد" });
      expect((view.sent("POST /plans/estimate")[0]?.body as { paths: string[] }).paths).toEqual(["matn", "sanad", "grade"]);
      await user.click(screen.getByRole("button", { name: "اعتماد التعديل" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
      await waitFor(() => expect(view.count(`POST /plans/${MOCK_PLAN_ID}/revise`)).toBe(1));
      expect(view.sent(`POST /plans/${MOCK_PLAN_ID}/revise`)[0]?.body).toMatchObject({ paths: ["matn", "sanad", "grade"] });
    });
  });
});

describe("S-13 Plan revision: the form refused", () => {
  it("shows the fresh estimate and a warning when E17 answers `estimate_changed`, and saves nothing", async () => {
    const user = userEvent.setup();
    const fresh = { ...basePlan.agreedEstimate, days: 9, endDate: "2026-10-14", newWordsPerDay: 40, sessionMinutes: 15 as const };
    const view = renderRevise({ revealForm: true, handlers: { "POST /plans/:id/revise": () => conflict("estimate_changed", { estimate: fresh }) } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
    expect(await screen.findByText("تغيّر التقدير. راجع التقدير الجديد ثم أكّد.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "التقدير الجديد" })).toHaveTextContent("نحو ٩ أيام، حتى ١٤ أكتوبر ٢٠٢٦");
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(peekPlanConfirmed()).toBeNull();
    expect(view.count(`POST /plans/${MOCK_PLAN_ID}/revise`)).toBe(1);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "التقدير الجديد" })).toHaveFocus());
    // The learner can confirm again from here.
    expect(screen.getByRole("button", { name: "اعتماد التعديل" })).toBeInTheDocument();
  });

  it("shows the plan-moved warning with «تحديث», which reads the plan again and keeps the learner's input", async () => {
    const user = userEvent.setup();
    const view = renderRevise({ revealForm: true, handlers: { "POST /plans/:id/revise": () => conflict("plan_version", { currentVersion: 2 }) } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
    expect(await screen.findByText("عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "التقدير الجديد" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(view.count("GET /today")).toBe(2));
    await waitFor(() => expect(screen.queryByText("عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.")).toBeNull());
    expect(screen.getByRole("radio", MINUTES_15)).toBeChecked();
  });

  it("shows the field message of a 422 at its field and moves focus there", async () => {
    const user = userEvent.setup();
    renderRevise({
      revealForm: true,
      handlers: { "POST /plans/estimate": () => errorResponse(422, "validation_error", "Invalid.", { fields: [{ field: "order", rule: "order_not_available" }] }) },
    });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", { name: "من الناس رجوعًا" }));
    await user.click(calculateButton());
    expect(await screen.findByText("هذا الترتيب غير متاح لهذا الكتاب.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: "من الناس رجوعًا" })).toHaveFocus());
  });

  it("shows the date message of a 422 under the date field", async () => {
    const user = userEvent.setup();
    renderRevise({
      revealForm: true,
      handlers: { "POST /plans/estimate": () => errorResponse(422, "validation_error", "Invalid.", { fields: [{ field: "preferredDate", rule: "date_invalid" }] }) },
    });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    expect(await screen.findByText("اختر موعدًا من اليوم فصاعدًا.")).toBeInTheDocument();
    expect(screen.getByLabelText("الموعد المفضل (اختياري)")).toHaveAttribute("aria-invalid", "true");
  });

  it("closes the screen when E17 answers `plan_not_active`", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true, handlers: { "POST /plans/:id/revise": () => conflict("plan_not_active") } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "اعتماد التعديل" }));
    expect(await screen.findByText("اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "تعديل بالنموذج" })).toBeNull();
  });

  it("shows the service banner when E15 is unavailable, without closing the form", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true, handlers: { "POST /plans/estimate": () => errorResponse(503, "unavailable", "Down.") } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "تعديل بالنموذج" })).toBeInTheDocument();
  });

  it("sends a 401 from E17 to the login screen", async () => {
    const user = userEvent.setup();
    renderRevise({ revealForm: true, handlers: { "POST /plans/estimate": () => errorResponse(401, "unauthenticated", "No session.") } });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    await user.click(screen.getByRole("radio", MINUTES_15));
    await user.click(calculateButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fplan%2Frevise"));
  });
});

describe("S-13 Plan revision: the form in English", () => {
  it("is left to right with the English labels, the estimate and the dialog", async () => {
    const user = userEvent.setup();
    renderRevise({ language: "en", revealForm: true });
    expect(await screen.findByRole("heading", { level: 2, name: "Change with the form" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Daily time" })).toBeInTheDocument();
    expect(screen.getByLabelText("Preferred date (optional)")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Plan order" })).toBeInTheDocument();
    expect(calculateButton()).toHaveAccessibleDescription("Nothing has changed yet.");
    await user.click(screen.getByRole("radio", { name: "15 minutes" }));
    await user.click(calculateButton());
    const preview = await screen.findByRole("region", { name: "New estimate" });
    expect(preview).toHaveTextContent("about 3 days, until October 8, 2026");
    expect(preview).toHaveTextContent("15 minutes a day, about 7 new ayat a day");
    expect(preview).toHaveTextContent("This estimate fits your preferred date.");
    await user.click(screen.getByRole("button", { name: "Confirm the change" }));
    expect(await screen.findByRole("dialog", { name: "Confirm the change?" })).toHaveTextContent("It takes effect from the next learning day.");
  });
});

describe("S-13 Plan revision: semantics", () => {
  it("sets the document title and makes the H1 focusable for the route change", async () => {
    renderRevise();
    const heading = await screen.findByRole("heading", { level: 1, name: "تعديل الوقت والهدف" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-page-heading");
    await waitFor(() => expect(document.title).toBe("تعديل الوقت والهدف · قطرة غيث"));
  });

  it("puts the back control before the H1 and the primary button after the transparency line", async () => {
    renderRevise();
    const back = await screen.findByRole("link", { name: "رجوع إلى الخطة الكبرى" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const notice = screen.getByText(/^تُبنى خطتك وتُعدَّل في محادثة/);
    expect(notice.compareDocumentPosition(startButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("never shows a scope or edition picker, or a free text box", async () => {
    renderRevise({ revealForm: true });
    await screen.findByRole("heading", { level: 2, name: "تعديل بالنموذج" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
