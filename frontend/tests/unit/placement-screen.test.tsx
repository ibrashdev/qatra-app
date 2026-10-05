import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/placement", useRouter: () => navigation.router }));

import { PlacementScreen } from "@/components/placement/PlacementScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_CHAT_GOALS, MOCK_HADITH_EDITION_ID, MOCK_QURAN_EDITION_ID, mockHandlers } from "@/lib/api/mock";
import { MOCK_PLACEMENT_QUESTION_IDS, withPlacementMock } from "@/lib/api/mock/placement-handlers";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { getStartSelection, setStartDraft, type StartSelection } from "@/lib/plan/start-selection";
import { installDialogPolyfill } from "./dialog-polyfill";

type Handler = (real: () => Promise<Response>, body: unknown) => Response | Promise<Response>;

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

const SESSIONS = "POST /api/sessions";
const EVENTS = "POST /api/sessions/:id/events";
const COMPLETE = "POST /api/sessions/:id/complete";
const CHATS = "POST /api/plan-chats";

interface Call {
  key: string;
  path: string;
  body: unknown;
}

interface SentEvent {
  clientEventId: string;
  type: string;
  questionId: string;
  answer: Record<string, unknown>;
  hintUsed: boolean;
  occurredAt: string;
  durationMs: number;
}

function makeBackend(overrides: Record<string, Handler> = {}) {
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn: true }, handlers: withPlacementMock(mockHandlers) });
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/\/sessions\/[^/]+/, "/sessions/:id")}`;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    // The wake-up monitor probes /health on its own; it is not part of what the screen sends.
    if (url.pathname !== "/api/health") calls.push({ key, path: url.pathname, body });
    const override = overrides[key];
    return override ? override(() => mock(input, init), body) : mock(input, init);
  });
  const of = (key: string) => calls.filter((call) => call.key === key);
  const events = () => of(EVENTS).flatMap((call) => (call.body as { events: SentEvent[] }).events);
  const keys = () => calls.map((call) => call.key);
  return { fetchImpl, calls, of, events, keys };
}

let runtime: ApiRuntime;

function renderTest({ language = "ar", overrides = {} }: { language?: "ar" | "en"; overrides?: Record<string, Handler> } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const backend = makeBackend(overrides);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <PlacementScreen />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return backend;
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const radio = (name: string) => screen.getByRole("radio", { name });
const startButton = () => screen.getByRole("button", { name: /^(ابدأ الاختبار|جارٍ تجهيز الأسئلة…|Start the test|Preparing the questions…)$/ });
const nextButton = () => screen.getByRole("button", { name: /^(التالي|إنهاء الاختبار|Next|Finish the test)$/ });
const continueButton = () => screen.getByRole("button", { name: /^(متابعة إلى الخطة|جارٍ تجهيز المحادثة…|Continue to the plan|Preparing the conversation…)$/ });
const progress = () => screen.getByRole("progressbar");

const sessionIdOf = (backend: ReturnType<typeof makeBackend>) => /\/sessions\/([^/]+)\/(?:events|complete)$/.exec(backend.calls.find((call) => /\/sessions\/[^/]+\//.test(call.path))?.path ?? "")?.[1];

async function startTest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(startButton());
  await screen.findByRole("progressbar");
}

type Move = "right" | "wrong" | "skip";
const PICKS = [
  { right: "كلمة٢", wrong: "كلمة٤" },
  { right: "كلمة٨", wrong: "كلمة٩" },
  { right: "كلمة١١", wrong: "كلمة١٣" },
] as const;

// Plays the three questions of the mock: a choice, a recall and a choice, each answered rightly, wrongly or skipped.
async function play(user: ReturnType<typeof userEvent.setup>, moves: readonly Move[]) {
  for (const [position, move] of moves.entries()) {
    const pick = PICKS[position];
    if (move === "skip" || pick === undefined) {
      await user.click(button("تجاوز السؤال"));
      continue;
    }
    if (position === 1) await user.type(screen.getByRole("textbox"), pick[move]);
    else await user.click(radio(pick[move]));
    await user.click(nextButton());
  }
  await screen.findByRole("heading", { name: "انتهى الاختبار" });
}

beforeEach(() => {
  installDialogPolyfill();
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

describe("S-09 self-rating step", () => {
  it("shows the focus flow: the back control, the H1 «اختبار قصير», the intro, the optional three-segment group with its helper, the primary button and «تخطي الاختبار»", () => {
    renderTest();
    expect(screen.getByRole("heading", { level: 1, name: "اختبار قصير" })).toBeInTheDocument();
    expect(document.title).toBe("اختبار قصير · قطرة غيث");
    expect(screen.getByText("أسئلة تذكر قصيرة، وليست تقييمًا للتلاوة. لا يُحتسب وقتها في هدفك اليومي.")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "ما مقدار ما تحفظه من هذا الكتاب الآن؟ (اختياري)" });
    expect(within(group).getAllByRole("radio").map((entry) => entry.parentElement?.textContent)).toEqual(["لم أحفظ", "بعضه", "أغلبه"]);
    expect(within(group).getAllByRole("radio").every((entry) => !(entry as HTMLInputElement).checked)).toBe(true);
    expect(group).toHaveAccessibleDescription("لا يؤثر هذا الاختيار في التقدير؛ تعتمد الخطة على إجاباتك.");
    expect(button("رجوع إلى ما هي خطتك؟")).toBeInTheDocument();
    expect(startButton()).toHaveTextContent("ابدأ الاختبار");
    expect(button("تخطي الاختبار")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("renders in English", () => {
    renderTest({ language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Short test" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "How much of this book do you already know? (optional)" })).toBeInTheDocument();
    expect(startButton()).toHaveTextContent("Start the test");
    expect(button("Skip the test")).toBeInTheDocument();
    expect(button("Back to What is your plan?")).toBeInTheDocument();
  });

  it("goes back to /start when nothing is in memory (guard 5, a reload) and sends nothing", async () => {
    setStartDraft(null);
    const backend = renderTest();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/start"));
    await userEvent.setup().click(startButton());
    expect(backend.calls).toHaveLength(0);
  });

  it("creates the test with E20 from the edition and scope, and the chosen self-rating", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await user.click(radio("بعضه"));
    await startTest(user);
    expect(backend.of(SESSIONS)).toHaveLength(1);
    expect(backend.of(SESSIONS)[0]?.body).toEqual({ kind: "placement", editionId: selection.editionId, targetScope: selection.targetScope, selfRating: "some" });
  });

  it("sends no selfRating when none is chosen: the step is optional", async () => {
    const backend = renderTest();
    await startTest(userEvent.setup());
    expect(backend.of(SESSIONS)[0]?.body).toEqual({ kind: "placement", editionId: selection.editionId, targetScope: selection.targetScope });
  });

  it("is Loading while E20 runs, ignores a second press, and creates one session (P-14)", async () => {
    const gate = deferred<void>();
    const backend = renderTest({ overrides: { [SESSIONS]: async (real) => (await gate.promise, real()) } });
    const user = userEvent.setup();
    await user.click(startButton());
    expect(startButton()).toHaveAttribute("aria-busy", "true");
    expect(startButton()).toHaveTextContent("جارٍ تجهيز الأسئلة…");
    expect(button("تخطي الاختبار")).toHaveAttribute("aria-disabled", "true");
    await user.click(startButton());
    expect(backend.of(SESSIONS)).toHaveLength(1);
    gate.resolve();
    await screen.findByRole("progressbar");
    expect(backend.of(SESSIONS)).toHaveLength(1);
  });

  it("answers edition_not_available with the error banner and «تعديل الخيارات» to S-08, the selection kept", async () => {
    renderTest({ overrides: { [SESSIONS]: () => apiError(422, "validation_error", { fields: [{ field: "editionId", rule: "edition_not_available" }] }) } });
    const user = userEvent.setup();
    await user.click(startButton());
    const banner = await screen.findByText("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.");
    expect(banner.closest("[role=alert]")).not.toBeNull();
    expect(getStartSelection()).not.toBeNull();
    expect(startButton()).not.toHaveAttribute("aria-busy");
    await user.click(button("تعديل الخيارات"));
    expect(navigation.router.replace).toHaveBeenCalledWith("/start");
  });

  it("answers another rule of the options with the questions-failed banner and the same action", async () => {
    renderTest({ overrides: { [SESSIONS]: () => apiError(422, "validation_error", { fields: [{ field: "targetScope", rule: "scope_invalid" }] }) } });
    await userEvent.setup().click(startButton());
    expect(await screen.findByText("تعذّر تجهيز الأسئلة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.")).toBeInTheDocument();
    expect(button("تعديل الخيارات")).toBeInTheDocument();
  });

  it("shows the throttle wording and never retries on its own", async () => {
    const backend = renderTest({ overrides: { [SESSIONS]: () => apiError(429, "throttled", { retryAfterSec: 20 }) } });
    await userEvent.setup().click(startButton());
    expect(await screen.findByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
    expect(backend.of(SESSIONS)).toHaveLength(1);
  });

  it.each([
    [503, "unavailable", "الخدمة غير متاحة مؤقتًا. حاول بعد قليل."],
    [500, "internal", "حدث خطأ غير متوقع. حاول مرة أخرى."],
    [403, "forbidden_origin", "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى."],
  ] as const)("shows the wording of %i %s", async (status, code, text) => {
    renderTest({ overrides: { [SESSIONS]: () => apiError(status, code) } });
    await userEvent.setup().click(startButton());
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("lets the learner press again after a lost answer, and creates a second session only then (P-14)", async () => {
    let lost = true;
    const backend = renderTest({
      overrides: {
        [SESSIONS]: async (real) => {
          if (lost) throw new TypeError("network lost");
          return real();
        },
      },
    });
    const user = userEvent.setup();
    await user.click(startButton());
    await waitFor(() => expect(startButton()).not.toHaveAttribute("aria-busy"));
    expect(backend.of(SESSIONS)).toHaveLength(1);
    lost = false;
    await user.click(startButton());
    await screen.findByRole("progressbar");
    expect(backend.of(SESSIONS)).toHaveLength(2);
  });

  it("sends a signed-out visitor to S-01 with the session-ended banner and next=/start", async () => {
    renderTest({ overrides: { [SESSIONS]: () => apiError(401, "unauthenticated") } });
    await userEvent.setup().click(startButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fstart"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-09 question steps", () => {
  it("shows the count as a steps progress, the prompt as the step heading with focus, the original-text block and no hint", async () => {
    renderTest();
    await startTest(userEvent.setup());
    expect(progress()).toHaveAttribute("aria-valuetext", "السؤال ١ من ٣");
    expect(progress()).toHaveAttribute("aria-valuenow", "0");
    expect(progress()).toHaveAttribute("aria-valuemax", "3");
    const prompt = screen.getByRole("heading", { level: 2, name: "اختر الكلمة التي تكمل العبارة." });
    await waitFor(() => expect(prompt).toHaveFocus());
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /تلميح|hint/i })).not.toBeInTheDocument();
    expect(nextButton()).toHaveTextContent("التالي");
    expect(button("تجاوز السؤال")).toBeInTheDocument();
  });

  it("shows the whole passage around the blank and no source line or link, before or after an answer (D90)", async () => {
    renderTest();
    const user = userEvent.setup();
    await startTest(user);
    // The first mock passage has four words; the target is the second one, so the other three are shown around the blank.
    const blank = screen.getByRole("img", { name: "الكلمة الناقصة" });
    expect(blank.parentElement).toHaveTextContent("كلمة١ كلمة٣ كلمة٤");
    expect(document.body.textContent).not.toContain("كتاب اصطناعي");
    expect(screen.queryByRole("link", { name: /المصدر/ })).toBeNull();
    await user.click(radio("كلمة٢"));
    await user.click(nextButton());
    await screen.findByRole("heading", { level: 2, name: "اكتب الكلمة الناقصة." });
    expect(document.body.textContent).not.toContain("كتاب اصطناعي");
    expect(screen.queryByRole("link", { name: /المصدر/ })).toBeNull();
  });

  it("groups the count and the prompt as one header, apart from the question piece, without a fixed height (FC-09)", async () => {
    renderTest();
    await startTest(userEvent.setup());
    const prompt = screen.getByRole("heading", { level: 2, name: "اختر الكلمة التي تكمل العبارة." });
    const header = prompt.parentElement as HTMLElement;
    expect(header).toContainElement(progress());
    expect(header).not.toContainElement(screen.getAllByRole("radio")[0] ?? null);
    expect(header.parentElement?.className).toContain("min-w-0");
    expect(header.parentElement?.innerHTML).not.toMatch(/\b(?:h|min-h)-\[\d+px\]/);
  });

  it("announces the position politely at each step", async () => {
    renderTest();
    const user = userEvent.setup();
    await startTest(user);
    const announced = () => Array.from(document.querySelectorAll("[role=status].sr-only")).map((region) => region.textContent);
    expect(announced()).toContain("السؤال ١ من ٣");
    await user.click(button("تجاوز السؤال"));
    await waitFor(() => expect(announced()).toContain("السؤال ٢ من ٣"));
  });

  it("answers «التالي» with nothing chosen with the S-09 line, sends nothing and keeps the question", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await user.click(nextButton());
    expect(await screen.findByText("اختر إجابة أو اضغط «تجاوز السؤال».")).toBeInTheDocument();
    expect(backend.of(EVENTS)).toHaveLength(0);
    expect(progress()).toHaveAttribute("aria-valuetext", "السؤال ١ من ٣");
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-answer-target]")));
    await user.click(radio("كلمة٤"));
    expect(screen.queryByText("اختر إجابة أو اضغط «تجاوز السؤال».")).not.toBeInTheDocument();
  });

  it("sends each answer as one E21 answer event with hintUsed false and shows nothing of it: no marks, no verdict, no score", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await user.click(radio("كلمة٤")); // a wrong answer
    await user.click(nextButton());
    await waitFor(() => expect(backend.events()).toHaveLength(1));
    const [event] = backend.events();
    expect(event).toMatchObject({ type: "answer", questionId: MOCK_PLACEMENT_QUESTION_IDS.choice, answer: { optionId: "p-b" }, hintUsed: false });
    expect(event?.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(event ?? {}).sort()).toEqual(["answer", "clientEventId", "durationMs", "hintUsed", "occurredAt", "questionId", "type"]);
    expect(screen.getByRole("heading", { level: 2, name: "اكتب الكلمة الناقصة." })).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuenow", "1");
    expect(document.body.textContent).not.toMatch(/صحيح|خطأ|مراجعة|correct|wrong|score|%/i);
  });

  it("is a recall step for a word_recall question: one word, trimmed, Enter acts as «التالي»", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await user.click(button("تجاوز السؤال"));
    const input = screen.getByRole("textbox");
    await user.click(nextButton());
    expect(await screen.findByText("اختر إجابة أو اضغط «تجاوز السؤال».")).toBeInTheDocument();
    await user.type(input, "كلمة أخرى");
    await user.click(nextButton());
    expect(await screen.findByText("اكتب كلمة واحدة.")).toBeInTheDocument();
    expect(backend.of(EVENTS)).toHaveLength(0);
    await user.clear(input);
    await user.type(input, "  كلمة٨  {Enter}");
    await waitFor(() => expect(backend.events()).toHaveLength(1));
    expect(backend.events()[0]?.answer).toEqual({ text: "كلمة٨" });
    expect(progress()).toHaveAttribute("aria-valuetext", "السؤال ٣ من ٣");
    expect(nextButton()).toHaveTextContent("إنهاء الاختبار");
  });

  it("skips a question without sending an event, and all three skips reach the done step", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await user.click(button("تجاوز السؤال"));
    expect(progress()).toHaveAttribute("aria-valuetext", "السؤال ٢ من ٣");
    await play(user, ["skip", "skip"]);
    expect(backend.of(EVENTS)).toHaveLength(0);
  });

  it("keeps the same clientEventId when an answer is sent again after a lost answer", async () => {
    let attempt = 0;
    const backend = renderTest({
      overrides: {
        [EVENTS]: async (real) => {
          attempt += 1;
          if (attempt === 1) throw new TypeError("network lost");
          return real();
        },
      },
    });
    const user = userEvent.setup();
    await startTest(user);
    await user.click(radio("كلمة٢"));
    await user.click(nextButton());
    await waitFor(() => expect(backend.of(EVENTS)).toHaveLength(1));
    await user.type(screen.getByRole("textbox"), "كلمة٨");
    await user.click(nextButton());
    await waitFor(() => expect(backend.of(EVENTS)).toHaveLength(2));
    const first = (backend.of(EVENTS)[0]?.body as { events: SentEvent[] }).events.map((event) => event.clientEventId);
    const second = (backend.of(EVENTS)[1]?.body as { events: SentEvent[] }).events.map((event) => event.clientEventId);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(new Set(second).size).toBe(2);
  });

  it("sends only answers: no activity event, because the test is never counted in daily time", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["right", "right", "right"]);
    expect(backend.events().map((event) => event.type)).toEqual(["answer", "answer", "answer"]);
  });

  it("shows no rejection or pending state: a rejected answer changes nothing on the screen", async () => {
    renderTest({
      overrides: {
        [EVENTS]: async (_real, body) => {
          const ids = (body as { events: SentEvent[] }).events.map((event) => event.clientEventId);
          return jsonResponse({ acknowledged: [], duplicate: [], pending: [], rejected: ids.map((clientEventId) => ({ clientEventId, code: "session_closed" })), results: [], daily: {} }, 200);
        },
      },
    });
    const user = userEvent.setup();
    await startTest(user);
    await user.click(radio("كلمة٢"));
    await user.click(nextButton());
    expect(await screen.findByRole("heading", { level: 2, name: "اكتب الكلمة الناقصة." })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("S-09 done step and the conversation", () => {
  it("shows the finished heading and sentence with focus, the primary «متابعة إلى الخطة», and no question controls, progress or score", async () => {
    renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["right", "wrong", "skip"]);
    const heading = screen.getByRole("heading", { level: 2, name: "انتهى الاختبار" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("سنستخدم إجاباتك لتقدير نقطة البداية.")).toBeInTheDocument();
    expect(continueButton()).toHaveTextContent("متابعة إلى الخطة");
    expect(screen.queryByRole("button", { name: "تجاوز السؤال" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d\s*\/\s*\d|%|٪/);
  });

  it("flushes the answers, completes the session (E22), then opens the conversation (E31) with placementSessionId, and replaces the route", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["right", "wrong", "right"]);
    await user.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/plan\/chat\/[0-9a-f-]{36}$/)));
    const id = sessionIdOf(backend);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(backend.of(COMPLETE)).toHaveLength(1);
    expect(backend.of(COMPLETE)[0]?.path).toBe(`/api/sessions/${id}/complete`);
    expect(backend.of(CHATS)).toHaveLength(1);
    expect(backend.of(CHATS)[0]?.body).toEqual({
      editionId: selection.editionId,
      targetScope: selection.targetScope,
      paths: selection.paths,
      sessionMinutes: 10,
      placementSessionId: id,
      goalText: "Synthetic goal sentence",
      language: "ar",
    });
    const keys = backend.keys();
    expect(keys.lastIndexOf(EVENTS)).toBeLessThan(keys.indexOf(COMPLETE));
    expect(keys.indexOf(COMPLETE)).toBeLessThan(keys.indexOf(CHATS));
    expect(backend.events()).toHaveLength(3);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("sends the preferred date and the English language", async () => {
    setStartDraft({ selection: { ...selection, preferredDate: "2026-10-20" }, form: {} });
    const backend = renderTest({ language: "en" });
    const user = userEvent.setup();
    await startTest(user);
    for (let step = 0; step < 3; step += 1) await user.click(button("Skip this question"));
    await user.click(await screen.findByRole("button", { name: "Continue to the plan" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.of(CHATS)[0]?.body).toMatchObject({ preferredDate: "2026-10-20", language: "en" });
  });

  it("uses the hadith text kind for a hadith edition", async () => {
    setStartDraft({ selection: { ...selection, editionId: MOCK_HADITH_EDITION_ID, targetScope: { sectionOrdinals: [1] }, paths: ["matn"] }, form: {} });
    renderTest();
    await startTest(userEvent.setup());
    expect(document.querySelector("[lang=ar].font-hadith")).not.toBeNull();
    expect(document.querySelector(".font-quran")).toBeNull();
  });

  it("uses the Quran text kind for a Quran edition", async () => {
    renderTest();
    await startTest(userEvent.setup());
    expect(document.querySelector("[lang=ar].font-quran")).not.toBeNull();
  });

  it("is Loading while E22 and E31 run, ignores a second press, and creates one conversation", async () => {
    const gate = deferred<void>();
    const backend = renderTest({ overrides: { [CHATS]: async (real) => (await gate.promise, real()) } });
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["skip", "skip", "skip"]);
    await user.click(continueButton());
    await waitFor(() => expect(continueButton()).toHaveAttribute("aria-busy", "true"));
    expect(continueButton()).toHaveTextContent("جارٍ تجهيز المحادثة…");
    expect(button("تخطي الاختبار")).toHaveAttribute("aria-disabled", "true");
    await user.click(continueButton());
    await user.click(button("رجوع إلى ما هي خطتك؟"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    gate.resolve();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.of(CHATS)).toHaveLength(1);
    expect(continueButton()).toHaveAttribute("aria-busy", "true");
  });

  it("goes on to the conversation when E22 fails: it is best effort", async () => {
    const backend = renderTest({ overrides: { [COMPLETE]: () => apiError(500, "internal") } });
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["right", "right", "right"]);
    await user.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.of(COMPLETE)).toHaveLength(1);
    expect(backend.of(CHATS)[0]?.body).toHaveProperty("placementSessionId");
  });

  it("goes on to the conversation when the answers could not be flushed, and the same ids wait for the next flush", async () => {
    const backend = renderTest({ overrides: { [EVENTS]: () => apiError(429, "throttled", { retryAfterSec: 5 }) } });
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["right", "skip", "skip"]);
    await user.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.of(CHATS)).toHaveLength(1);
  });

  it("answers an E31 rule of the options with the conversation-failed banner and «تعديل الخيارات»; a new press sends again with the same session (P-14)", async () => {
    let refused = true;
    const backend = renderTest({
      overrides: {
        [CHATS]: async (real) => (refused ? apiError(422, "validation_error", { fields: [{ field: "goalText", rule: "goal_text_length" }] }) : real()),
      },
    });
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["right", "skip", "skip"]);
    await user.click(continueButton());
    expect(await screen.findByText("تعذّر بدء المحادثة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.")).toBeInTheDocument();
    expect(getStartSelection()).not.toBeNull();
    expect(backend.of(CHATS)).toHaveLength(1);
    expect(continueButton()).not.toHaveAttribute("aria-busy");
    refused = false;
    await user.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/plan\/chat\//)));
    const [first, second] = backend.of(CHATS).map((call) => (call.body as { placementSessionId: string }).placementSessionId);
    expect(second).toBe(first);
    expect(backend.of(COMPLETE)).toHaveLength(2);
  });

  it("answers edition_not_available of E31 with the error banner and «تعديل الخيارات»", async () => {
    setStartDraft({ selection: { ...selection, goalText: MOCK_CHAT_GOALS.editionGone }, form: {} });
    renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["skip", "skip", "skip"]);
    await user.click(continueButton());
    const banner = await screen.findByText("هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.");
    expect(banner.closest("[role=alert]")).not.toBeNull();
    await user.click(button("تعديل الخيارات"));
    expect(navigation.router.replace).toHaveBeenCalledWith("/start");
  });

  it("treats a placement session the server does not know (E31 404) as an unexpected error and keeps the learner on the done step", async () => {
    renderTest({ overrides: { [CHATS]: () => apiError(404, "not_found") } });
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["skip", "skip", "skip"]);
    await user.click(continueButton());
    expect(await screen.findByText("حدث خطأ غير متوقع. حاول مرة أخرى.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "انتهى الاختبار" })).toBeInTheDocument();
  });

  it("sends a lost login at E31 to S-01 with next=/start", async () => {
    renderTest({ overrides: { [CHATS]: () => apiError(401, "unauthenticated") } });
    const user = userEvent.setup();
    await startTest(user);
    await play(user, ["skip", "skip", "skip"]);
    await user.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fstart"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("goes straight to the done step when the snapshot holds no question, and still passes the session", async () => {
    const backend = renderTest({
      overrides: {
        [SESSIONS]: async (real) => {
          const answer = await real();
          return jsonResponse({ ...(await answer.json()), steps: [] }, 201);
        },
      },
    });
    const user = userEvent.setup();
    await user.click(startButton());
    await screen.findByRole("heading", { name: "انتهى الاختبار" });
    await user.click(continueButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalled());
    expect(backend.of(CHATS)[0]?.body).toHaveProperty("placementSessionId");
  });
});

describe("S-09 calm line", () => {
  const calm = "يعتمد التقدير على إجاباتك في الاختبار، ويمكنك تعديل الخطة في المحادثة.";

  it.each([
    ["«أغلبه» and every answer wrong", "أغلبه", ["wrong", "wrong", "wrong"], true],
    ["«أغلبه» and every question skipped", "أغلبه", ["skip", "skip", "skip"], true],
    ["«أغلبه» and one right answer", "أغلبه", ["wrong", "right", "skip"], false],
    ["«بعضه» and every answer wrong", "بعضه", ["wrong", "wrong", "wrong"], false],
    ["«لم أحفظ» and every answer wrong", "لم أحفظ", ["wrong", "wrong", "wrong"], false],
    ["no rating and every answer wrong", null, ["wrong", "wrong", "wrong"], false],
  ] as const)("%s: calm line %s", async (_name, rating, moves, shown) => {
    renderTest();
    const user = userEvent.setup();
    if (rating !== null) await user.click(radio(rating));
    await startTest(user);
    await play(user, moves);
    if (shown) expect(screen.getByText(calm)).toBeInTheDocument();
    else expect(screen.queryByText(calm)).not.toBeInTheDocument();
  });
});

describe("S-09 skip the test (UG-12) and leave (P-12)", () => {
  it("opens the skip dialog from the bar, with «متابعة الاختبار» focused, and closes it without sending anything", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await user.click(button("تخطي الاختبار"));
    const dialog = await screen.findByRole("dialog", { name: "تخطي الاختبار؟" });
    expect(within(dialog).getByText("ستُبنى الخطة دون نتيجة اختبار، فيُقدَّر الزمن على أنك تبدأ من الصفر.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "متابعة الاختبار" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "متابعة الاختبار" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "تخطي الاختبار؟" })).toBeNull());
    expect(backend.calls).toHaveLength(0);
  });

  it("skips from the self-rating step: E31 without placementSessionId, and neither E20 nor E22", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await user.click(button("تخطي الاختبار"));
    await user.click(within(await screen.findByRole("dialog", { name: "تخطي الاختبار؟" })).getByRole("button", { name: "تخطي والمتابعة إلى الخطة" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/plan\/chat\/[0-9a-f-]{36}$/)));
    expect(backend.keys()).toEqual([CHATS]);
    expect(backend.of(CHATS)[0]?.body).toEqual({
      editionId: selection.editionId,
      targetScope: selection.targetScope,
      paths: selection.paths,
      sessionMinutes: 10,
      goalText: "Synthetic goal sentence",
      language: "ar",
    });
    expect(JSON.stringify(backend.of(CHATS)[0]?.body)).not.toContain("placementSessionId");
  });

  it("skips in the middle of the test: E31 without placementSessionId, no E22, and the answers already sent stay recorded", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await user.click(radio("كلمة٢"));
    await user.click(nextButton());
    await waitFor(() => expect(backend.events()).toHaveLength(1));
    await user.click(button("تخطي الاختبار"));
    await user.click(within(await screen.findByRole("dialog", { name: "تخطي الاختبار؟" })).getByRole("button", { name: "تخطي والمتابعة إلى الخطة" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/plan\/chat\//)));
    expect(JSON.stringify(backend.of(CHATS)[0]?.body)).not.toContain("placementSessionId");
    expect(backend.of(COMPLETE)).toHaveLength(0);
  });

  it("keeps the question screen and shows the throttle when the conversation of a skip is refused", async () => {
    renderTest({ overrides: { [CHATS]: () => apiError(429, "throttled", { retryAfterSec: 20 }) } });
    const user = userEvent.setup();
    await startTest(user);
    await user.click(button("تخطي الاختبار"));
    await user.click(within(await screen.findByRole("dialog", { name: "تخطي الاختبار؟" })).getByRole("button", { name: "تخطي والمتابعة إلى الخطة" }));
    expect(await screen.findByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
    expect(progress()).toHaveAttribute("aria-valuetext", "السؤال ١ من ٣");
    expect(nextButton()).not.toHaveAttribute("aria-busy");
  });

  it("asks before leaving with the back control: «متابعة الاختبار» stays, «الخروج إلى اختيارات الخطة» goes to S-08 and sends nothing", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await user.click(button("رجوع إلى ما هي خطتك؟"));
    const dialog = await screen.findByRole("dialog", { name: "الخروج من الاختبار؟" });
    expect(within(dialog).getByText("تعود إلى اختيارات الخطة. لا يُحتسب وقت الاختبار في هدفك اليومي.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "متابعة الاختبار" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "متابعة الاختبار" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "الخروج من الاختبار؟" })).toBeNull());
    expect(navigation.router.replace).not.toHaveBeenCalled();
    await user.click(button("رجوع إلى ما هي خطتك؟"));
    await user.click(within(await screen.findByRole("dialog", { name: "الخروج من الاختبار؟" })).getByRole("button", { name: "الخروج إلى اختيارات الخطة" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/start");
    expect(backend.calls).toHaveLength(0);
    expect(getStartSelection()).not.toBeNull();
  });

  it("opens the leave dialog on Escape, and Escape inside it continues the test", async () => {
    renderTest();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("dialog", { name: "الخروج من الاختبار؟" })).toBeInTheDocument();
    fireEvent(screen.getByRole("dialog", { name: "الخروج من الاختبار؟" }), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "الخروج من الاختبار؟" })).toBeNull());
  });

  it("opens the leave dialog when the browser's back button is used, and puts its own history entry back", async () => {
    renderTest();
    expect(window.history.state).toMatchObject({ qatraSessionGuard: true });
    window.history.replaceState({ __NA: true }, "");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { __NA: true } }));
    });
    expect(await screen.findByRole("dialog", { name: "الخروج من الاختبار؟" })).toBeInTheDocument();
    expect(window.history.state).toMatchObject({ qatraSessionGuard: true });
  });

  it("leaves from a question step too, without sending an E22 or a conversation", async () => {
    const backend = renderTest();
    const user = userEvent.setup();
    await startTest(user);
    await user.click(button("رجوع إلى ما هي خطتك؟"));
    await user.click(within(await screen.findByRole("dialog", { name: "الخروج من الاختبار؟" })).getByRole("button", { name: "الخروج إلى اختيارات الخطة" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/start");
    expect(backend.of(COMPLETE)).toHaveLength(0);
    expect(backend.of(CHATS)).toHaveLength(0);
  });
});
