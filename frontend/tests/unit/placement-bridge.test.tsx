import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/placement", useRouter: () => navigation.router }));

import { PlacementBridge } from "@/components/placement/PlacementBridge";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_CHAT_GOALS, MOCK_QURAN_EDITION_ID } from "@/lib/api/mock";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { getStartSelection, setStartDraft, type StartSelection } from "@/lib/plan/start-selection";

type Handler = (real: () => Promise<Response>) => Response | Promise<Response>;

const selection: StartSelection = {
  editionId: MOCK_QURAN_EDITION_ID,
  targetScope: { sectionOrdinals: [1, 2] },
  paths: ["quran"],
  sessionMinutes: 10,
  preferredDate: null,
  goalText: "Synthetic goal sentence",
};

const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) => jsonResponse({ error: { code, message: "m", details } }, status);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeBackend(overrides: Record<string, Handler> = {}) {
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn: true } });
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    if (key === "POST /api/plan-chats") bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    const override = overrides[key];
    return override ? override(() => mock(input, init)) : mock(input, init);
  });
  return { fetchImpl, bodies };
}

let runtime: ApiRuntime;

function renderBridge({ language = "ar", overrides = {} }: { language?: "ar" | "en"; overrides?: Record<string, Handler> } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const backend = makeBackend(overrides);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <PlacementBridge />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return backend;
}

const proceed = () => screen.getByRole("button", { name: /^(متابعة إلى الخطة|جارٍ تجهيز المحادثة…|Continue to the plan|Preparing the conversation…)$/ });

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  setStartDraft({ selection, form: {} });
  navigation.router.replace.mockReset();
  navigation.router.push.mockReset();
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  setStartDraft(null);
  vi.restoreAllMocks();
});

describe("interim /placement (S-09 skip path, UG-12)", () => {
  it("shows the focus flow: back to S-08, the H1 «اختبار قصير», the line that the test is not available, the primary button", () => {
    renderBridge();
    expect(screen.getByRole("heading", { level: 1, name: "اختبار قصير" })).toBeInTheDocument();
    expect(document.title).toBe("اختبار قصير · قطرة غيث");
    expect(screen.getByText("الاختبار القصير غير متاح الآن. يمكنك المتابعة إلى الخطة مباشرة.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "رجوع إلى ما هي خطتك؟" })).toHaveAttribute("href", "/start");
    expect(proceed()).toHaveTextContent("متابعة إلى الخطة");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("renders in English", () => {
    renderBridge({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Short test" })).toBeInTheDocument();
    expect(proceed()).toHaveTextContent("Continue to the plan");
    expect(screen.getByRole("link", { name: "Back to What is your plan?" })).toBeInTheDocument();
  });

  it("goes back to /start when nothing is in memory (guard 5, a reload)", async () => {
    setStartDraft(null);
    const backend = renderBridge();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    await userEvent.setup().click(proceed());
    expect(backend.bodies).toHaveLength(0);
  });

  it("opens the conversation with E31 from the selection and the language, without a placement session, then replaces the route", async () => {
    const backend = renderBridge();
    await userEvent.setup().click(proceed());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/plan\/chat\/[0-9a-f-]{36}$/)));
    expect(backend.bodies).toEqual([
      {
        editionId: selection.editionId,
        targetScope: selection.targetScope,
        paths: selection.paths,
        sessionMinutes: 10,
        goalText: "Synthetic goal sentence",
        language: "ar",
      },
    ]);
    expect(JSON.stringify(backend.bodies[0])).not.toContain("placementSessionId");
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("sends the preferred date when there is one, and the English language", async () => {
    setStartDraft({ selection: { ...selection, preferredDate: "2026-10-20" }, form: {} });
    const backend = renderBridge({ language: "en" });
    await userEvent.setup().click(proceed());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.bodies[0]).toMatchObject({ preferredDate: "2026-10-20", language: "en" });
  });

  it("is Loading while E31 runs, ignores a second press, and creates one conversation", async () => {
    const gate = deferred<void>();
    const backend = renderBridge({ overrides: { "POST /api/plan-chats": async (real) => (await gate.promise, real()) } });
    const user = userEvent.setup();
    await user.click(proceed());
    expect(proceed()).toHaveAttribute("aria-busy", "true");
    expect(proceed()).toHaveTextContent("جارٍ تجهيز المحادثة…");
    await user.click(proceed());
    expect(backend.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    gate.resolve();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(proceed()).toHaveAttribute("aria-busy", "true"); // stays Loading while the conversation opens
  });

  it("answers edition_not_available with the error banner and «تعديل الخيارات» to S-08, the selection kept", async () => {
    setStartDraft({ selection: { ...selection, goalText: MOCK_CHAT_GOALS.editionGone }, form: {} });
    renderBridge();
    const user = userEvent.setup();
    await user.click(proceed());
    const banner = await screen.findByText("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.");
    expect(banner.closest("[role=alert]")).not.toBeNull();
    expect(getStartSelection()).not.toBeNull();
    expect(proceed()).not.toHaveAttribute("aria-busy");
    await user.click(screen.getByRole("button", { name: "تعديل الخيارات" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/start");
  });

  it("answers another rule of the options with the conversation-failed banner and the same action", async () => {
    renderBridge({ overrides: { "POST /api/plan-chats": () => apiError(422, "validation_error", { fields: [{ field: "goalText", rule: "goal_text_length" }] }) } });
    await userEvent.setup().click(proceed());
    expect(await screen.findByText("تعذّر بدء المحادثة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تعديل الخيارات" })).toBeInTheDocument();
  });

  it("shows the throttle, service and error wording and never retries on its own", async () => {
    const backend = renderBridge({ overrides: { "POST /api/plan-chats": () => apiError(429, "throttled", { retryAfterSec: 20 }) } });
    await userEvent.setup().click(proceed());
    expect(await screen.findByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
    expect(backend.bodies).toHaveLength(1);
  });

  it.each([
    [503, "unavailable", "الخدمة غير متاحة مؤقتًا. حاول بعد قليل."],
    [500, "internal", "حدث خطأ غير متوقع. حاول مرة أخرى."],
    [403, "forbidden_origin", "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى."],
  ] as const)("shows the wording of %i %s", async (status, code, text) => {
    renderBridge({ overrides: { "POST /api/plan-chats": () => apiError(status, code) } });
    await userEvent.setup().click(proceed());
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("lets the learner press again after a lost answer, and sends again only then (P-14)", async () => {
    let lost = true;
    const backend = renderBridge({
      overrides: {
        "POST /api/plan-chats": async (real) => {
          if (lost) throw new TypeError("network lost");
          return real();
        },
      },
    });
    const user = userEvent.setup();
    await user.click(proceed());
    await waitFor(() => expect(proceed()).not.toHaveAttribute("aria-busy"));
    expect(backend.bodies).toHaveLength(1);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    lost = false;
    await user.click(proceed());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/plan\/chat\//)));
    expect(backend.bodies).toHaveLength(2);
  });

  it("sends a signed-out visitor to S-01 with the session-ended banner and next=/start", async () => {
    renderBridge({ overrides: { "POST /api/plan-chats": () => apiError(401, "unauthenticated") } });
    await userEvent.setup().click(proceed());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fstart"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});
