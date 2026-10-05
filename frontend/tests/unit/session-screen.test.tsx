import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/session/55555555-5555-4555-8555-000000000001", useRouter: () => navigation.router }));

import { clearResumeForTests } from "@/components/session/resume-store";
import { SessionScreen } from "@/components/session/SessionScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { MOCK_HADITH_EDITION_ID } from "@/lib/api/mock/fixtures";
import { mockHandlers, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_RECALL_WORD, sessionMockHandlers } from "@/lib/api/mock/session-handlers";
import { MOCK_SESSION_ID, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { resetRouteHistoryForTests, noteRoute } from "@/lib/nav/route-history";
import { clearSessionResult, peekSessionResult } from "@/lib/session/result-handoff";
import { installDialogPolyfill } from "./dialog-polyfill";

const UUID = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;

type Real = () => Promise<Response>;
type Override = (real: Real, call: number) => Response | Promise<Response>;

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, code: string, details: Record<string, unknown> = {}): Response => jsonResponse({ error: { code, message: "m", details } }, status);

const E20 = "POST /api/sessions";
const E21 = "POST /api/sessions/:id/events";
const E22 = "POST /api/sessions/:id/complete";

// The mock layer answers by default (E18, E14, E20, E21 and E22); a test overrides single operations. Every call is recorded.
function makeBackend(overrides: Record<string, Override> = {}, scenario: Partial<MockScenario> = {}) {
  const mock = createMockFetch({ latencyMs: 0, handlers: { ...mockHandlers, ...todayMockHandlers, ...sessionMockHandlers }, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const calls: { key: string; body: unknown }[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(UUID, ":id")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const call = (seen.get(key) ?? 0) + 1;
    seen.set(key, call);
    const override = overrides[key];
    const real: Real = () => mock(input, init);
    return override ? override(real, call) : real();
  });
  const bodies = (key: string) => calls.filter((entry) => entry.key === key).map((entry) => entry.body);
  const events = (): SessionEvent[] => bodies(E21).flatMap((body) => (body as { events: SessionEvent[] }).events);
  return { fetchImpl, calls, count: (key: string) => bodies(key).length, bodies, events };
}
type Backend = ReturnType<typeof makeBackend>;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderSession({
  language = "en",
  backend = makeBackend(),
  routeId = MOCK_SESSION_ID,
  previous = "/today",
}: { language?: "ar" | "en"; backend?: Backend; routeId?: string; previous?: string | null } = {}) {
  setLanguage(language);
  resetRouteHistoryForTests();
  if (previous !== null) noteRoute(previous);
  const runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <SessionScreen routeId={routeId} />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, runtime, ...view };
}

type User = ReturnType<typeof userEvent.setup>;

const stepHeading = () => document.querySelector<HTMLElement>("[data-step-heading]");
const primary = () => document.querySelector<HTMLButtonElement>("[data-session-primary]");
const ready = () => screen.findByRole("heading", { level: 2 });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const radio = (name: string) => screen.getByRole("radio", { name });

// Answers the question on screen correctly and presses Check. The answers are the synthetic keys of sessionMockHandlers.
async function answerCorrectly(user: User) {
  const heading = stepHeading()?.textContent ?? "";
  if (heading === "Put the words in the order they appear in the text.") {
    for (const word of ["كلمة٢", "كلمة٣", "كلمة٤"]) await user.click(button(word));
  } else if (heading === "Type the missing word.") {
    await user.type(screen.getByRole("textbox"), MOCK_RECALL_WORD);
  } else if (heading === "Choose the correct one as it appears in the book.") {
    await user.click(radio("متشابه١"));
  } else if (heading === "Choose what comes next.") {
    await user.click(radio("كلمة٣ كلمة٤"));
  } else if (heading === "Choose the missing word.") {
    // The review is the first question and the end test the sixth; their keys differ.
    await user.click(screen.queryByText(/^Question 6 of 6/) === null ? radio("كلمة٢") : radio("كلمة٦"));
  } else {
    throw new Error(`No answer is known for the step "${heading}".`);
  }
  await user.click(button("Check"));
}

// Walks the whole session up to the last answer, leaving the button on «Finish the session».
async function walkToTheEnd(user: User) {
  await ready();
  for (let guard = 0; guard < 24; guard += 1) {
    const label = primary()?.textContent ?? "";
    if (label === "Finish the session") return;
    if (label === "Start practice" || label === "Next") await user.click(primary() as HTMLElement);
    else await answerCorrectly(user);
  }
  throw new Error("The walk did not reach the end.");
}

// Walks to the step whose heading is `heading`, answering what is in the way.
async function walkUntil(user: User, heading: string) {
  await ready();
  for (let guard = 0; guard < 24; guard += 1) {
    if (stepHeading()?.textContent === heading) return;
    const label = primary()?.textContent ?? "";
    if (label === "Start practice" || label === "Next") await user.click(primary() as HTMLElement);
    else await answerCorrectly(user);
  }
  throw new Error(`The walk did not reach "${heading}".`);
}
const clock = { now: Date.parse("2026-10-05T07:00:00Z") };

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  resetRouteHistoryForTests();
  clearLoginArrival();
  clearSessionResult();
  clearResumeForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
  clock.now = Date.parse("2026-10-05T07:00:00Z");
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("S-19 loading (E18, then E20 daily)", () => {
  it("loads today, the catalog and the daily session, then shows the first step of the focus-flow shell", async () => {
    const { backend } = renderSession();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Memorization session" })).toBeInTheDocument();
    expect(backend.calls.map((call) => call.key)).toEqual(expect.arrayContaining(["GET /api/today", "GET /api/catalog", E20]));
    expect(backend.bodies(E20)).toEqual([{ kind: "daily", planId: "44444444-4444-4444-8444-000000000001", expectedPlanVersion: 1 }]);
    expect(backend.count(E20)).toBe(1);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("starts with the due review: the step line, the stage indicator, the counter and the Check button", async () => {
    renderSession();
    await ready();
    expect(screen.getByText("We start by reviewing what you memorized.")).toBeInTheDocument();
    const stages = screen.getByRole("list", { name: "Session steps" });
    const items = within(stages).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["1Review", "2New", "3Test"]);
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Question 1 of 6")).toBeInTheDocument();
    expect(stepHeading()).toHaveTextContent("Choose the missing word.");
    expect(primary()).toHaveTextContent("Check");
    // Reviews carry no streak line.
    expect(screen.queryByText(/Correct in a row/)).toBeNull();
  });

  it("shows the compact daily bar from E18 as a progressbar with its value in words", async () => {
    renderSession();
    await ready();
    const bar = screen.getByRole("progressbar", { name: "Daily progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "70");
    expect(bar).toHaveAttribute("aria-valuetext", "7 of 10 minutes, 70 percent");
    expect(screen.getByText("7/10")).toBeInTheDocument();
  });

  it("shows a skeleton after 300 ms while the snapshot loads, then replaces it", async () => {
    const backend = makeBackend({ [E20]: async (real) => (await new Promise((resolve) => setTimeout(resolve, 600)), real()) });
    renderSession({ backend });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"] [aria-hidden="true"]')).not.toBeNull());
    await ready();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("goes to Today for an id that is not the open session (guard 8), and shows no step", async () => {
    renderSession({ routeId: "55555555-5555-4555-8555-0000000000ff" });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("goes to Today when the account has no plan to run a session for", async () => {
    renderSession({ backend: makeBackend({}, { hasPlan: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });

  it("sends a visitor to the login with next=/today and raises the session-ended banner (G-03)", async () => {
    renderSession({ backend: makeBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Ftoday"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("explains a plan that moved (G-09) and loads again with Refresh", async () => {
    const backend = makeBackend({ [E20]: (real, call) => (call === 1 ? apiError(409, "version_conflict", { reason: "plan_version" }) : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    expect(await screen.findByText("Your plan was changed elsewhere. Refresh the page and try again.")).toBeInTheDocument();
    await user.click(button("Refresh"));
    await ready();
    expect(backend.count(E20)).toBe(2);
  });

  it("shows a revoked edition without any text (G-20), with the two ways on", async () => {
    const backend = makeBackend({ [E20]: () => apiError(422, "validation_error", { fields: [{ field: "planId", rule: "edition_not_available" }] }) });
    renderSession({ backend });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unavailable");
    expect(alert).toHaveTextContent("This edition is no longer available. You can start a plan on another edition.");
    expect(within(alert).getByRole("button", { name: "Back to Today" })).toBeInTheDocument();
    expect(within(alert).getByRole("link", { name: "Start a new plan" })).toHaveAttribute("href", "/start");
    expect(screen.queryByText(/كلمة/)).toBeNull();
  });

  it("shows an empty state, and no button that finishes anything, for a snapshot with no step", async () => {
    const backend = makeBackend({
      [E20]: async (real) => {
        const snapshot = (await (await real()).json()) as { steps: unknown[] };
        return jsonResponse({ ...snapshot, steps: [] }, 201);
      },
    });
    renderSession({ backend });
    expect(await screen.findByText("There are no questions in this session today.")).toBeInTheDocument();
    expect(primary()).toBeNull();
    expect(backend.count(E21)).toBe(0);
    expect(backend.count(E22)).toBe(0);
  });
});

describe("S-19 step line after a reload and after a pause", () => {
  it("says it starts from the beginning after a reload or a direct visit", async () => {
    renderSession({ previous: null });
    await ready();
    expect(screen.getByText("We start from the beginning; your earlier answers are saved.")).toBeInTheDocument();
  });

  it("says it is a light review when the snapshot has reviews and no learn step (G-30)", async () => {
    const backend = makeBackend({
      [E20]: async (real) => {
        const snapshot = (await (await real()).json()) as { steps: { type: string }[] };
        return jsonResponse({ ...snapshot, steps: snapshot.steps.filter((step) => step.type !== "learn") }, 201);
      },
    });
    renderSession({ backend });
    await ready();
    expect(screen.getByText("Today we start with a light review.")).toBeInTheDocument();
    const stages = within(screen.getByRole("list", { name: "Session steps" })).getAllByRole("listitem");
    expect(stages.map((item) => item.textContent)).toEqual(["1Review", "2New", "3Test"]);
  });
});

describe("S-19 learn step", () => {
  async function toLearn(user: User) {
    await ready();
    await answerCorrectly(user);
    await user.click(primary() as HTMLElement);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
  }

  it("shows the passage as received with today's range marked, a legend, the source and the instruction", async () => {
    const user = userEvent.setup();
    renderSession();
    await toLearn(user);
    const text = screen.getByRole("group", { name: "Passage text" });
    expect(text).toHaveAttribute("dir", "rtl");
    expect(text).toHaveAttribute("lang", "ar");
    expect(text.textContent).toBe("كلمة١ كلمة٢ كلمة٣ كلمة٤كلمة٥ كلمة٦ كلمة٧ كلمة٨");
    expect(Array.from(text.querySelectorAll("mark")).map((mark) => mark.textContent)).toEqual(["كلمة٢ كلمة٣ كلمة٤", "كلمة٥ كلمة٦"]);
    expect(screen.getByText("The highlighted part is today's passage.")).toBeInTheDocument();
    expect(screen.getByText("Read the passage, then try to recall it.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /2:1-2/ })).toHaveAttribute("href", "https://example.invalid/ref/1");
    expect(primary()).toHaveTextContent("Start practice");
    // The learn stage is "New", and a hadith-only chip is absent for a Quran edition.
    expect(within(screen.getByRole("list", { name: "Session steps" })).getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "step");
    expect(screen.queryByText("Matn")).toBeNull();
    expect(screen.queryByText(/HadeethEnc/)).toBeNull();
  });

  it("shows a hadith with its path chip, the record block, the D50 notice when the snapshot says so, and the hadith font", async () => {
    const backend = makeBackend({
      [E20]: async (real) => {
        const snapshot = (await (await real()).json()) as { editionId: string; steps: { type: string; passage?: Record<string, unknown> }[] };
        const steps = snapshot.steps.map((step) =>
          step.type === "learn" && step.passage !== undefined ? { ...step, passage: { ...step.passage, path: "matn", takhrij: "تخريج اصطناعي", grade: null, showD50Notice: true } } : step,
        );
        return jsonResponse({ ...snapshot, editionId: MOCK_HADITH_EDITION_ID, steps }, 201);
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await toLearn(user);
    expect(screen.getByText("Matn")).toBeInTheDocument();
    expect(screen.getByText(/^Takhrij from the HadeethEnc record:/)).toHaveTextContent("Takhrij from the HadeethEnc record: تخريج اصطناعي");
    expect(screen.getByText(/^Grade from the HadeethEnc record:/)).toHaveTextContent("Grade from the HadeethEnc record: Not stated in the edition");
    expect(screen.getByText("Note: this text was transcribed verbatim from the book, and the hadith's authenticity has not been verified.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Passage text" }).className).toContain("font-hadith");
  });

  it("uses the Quran font and no D50 notice for a Quran passage", async () => {
    const user = userEvent.setup();
    renderSession();
    await toLearn(user);
    expect(screen.getByRole("group", { name: "Passage text" }).className).toContain("font-quran");
    expect(screen.queryByText(/transcribed verbatim/)).toBeNull();
  });

  it("removes the text from the page and the accessibility tree when hidden, and brings it back", async () => {
    const user = userEvent.setup();
    renderSession();
    await toLearn(user);
    const toggle = button("Hide the text");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(screen.queryByRole("group", { name: "Passage text" })).toBeNull();
    expect(screen.queryByText(/كلمة٢/)).toBeNull();
    expect(screen.getByText("The text is hidden for recall; press “Show the text” to see it again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the text" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getAllByRole("status").find((region) => region.className.includes("sr-only")) as HTMLElement).getByText("The text is hidden")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the text" }));
    expect(screen.getByRole("group", { name: "Passage text" })).toBeInTheDocument();
  });

  it("moves focus to the step heading when the step changes, and the button keeps focus when it turns into Next", async () => {
    const user = userEvent.setup();
    renderSession();
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await waitFor(() => expect(primary()).toHaveFocus());
    expect(primary()).toHaveTextContent("Next");
    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(stepHeading()).toHaveFocus());
    expect(stepHeading()).toHaveTextContent("New passage");
  });

  it("skips a question that cannot be shown, says so calmly, and sends nothing for it", async () => {
    const backend = makeBackend({
      [E20]: async (real) => {
        const snapshot = (await (await real()).json()) as { steps: { type: string; question?: Record<string, unknown> }[] };
        const steps = snapshot.steps.map((step, index) => (index === 2 && step.question !== undefined ? { ...step, question: { ...step.question, tokens: [] } } : step));
        return jsonResponse({ ...snapshot, steps }, 201);
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await toLearn(user);
    await user.click(primary() as HTMLElement);
    expect(await screen.findByText("This question could not be shown; moving on to the next one.")).toBeInTheDocument();
    expect(stepHeading()).toHaveTextContent("Choose what comes next.");
    expect(screen.getByText(/Question 2 of 5/)).toBeInTheDocument();
    expect(backend.events().filter((event) => event.type === "answer" && event.questionId.endsWith("0002"))).toEqual([]);
  });
});

describe("S-19 answers, hint and server verdict", () => {
  it("shows the feedback at once, sends one answer event, and keeps the answer final", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(screen.getByText("Correct.")).toBeInTheDocument();
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    const [event] = backend.events();
    expect(event).toMatchObject({ type: "answer", questionId: "77777777-7777-4777-8777-000000000001", answer: { optionId: "opt-a" }, hintUsed: false });
    expect(event?.clientEventId).toMatch(/^[0-9a-f]{8}-/);
    // Final: the options are read-only now.
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-readonly", "true");
    // No accuracy percentage and no streak line for a review question.
    expect(screen.queryByText(/correct answers|accuracy/i)).toBeNull();
  });

  it("asks for an answer first, sends nothing, and keeps the button enabled (P-21)", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(button("Check"));
    expect(screen.getByText("Choose an answer first.")).toBeInTheDocument();
    expect(backend.count(E21)).toBe(0);
    expect(primary()).toHaveTextContent("Check");
  });

  it("allows one hint per question: the effect is fixed, the marker stays, and the answer is sent as assisted", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    await user.click(button("Hint"));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByText("With help")).toBeInTheDocument();
    const used = button("Hint");
    expect(used).toHaveAttribute("aria-disabled", "true");
    await user.click(used);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getAllByText("With help")).toHaveLength(1);

    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(screen.getByText("An answer with help counts as practice, not as independent recall.")).toBeInTheDocument();
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    expect(backend.events()[0]).toMatchObject({ type: "answer", hintUsed: true });
  });

  it("gives the next question a fresh hint", async () => {
    const user = userEvent.setup();
    renderSession();
    await ready();
    await user.click(button("Hint"));
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await user.click(primary() as HTMLElement);
    await user.click(primary() as HTMLElement);
    await screen.findByText(/Question 2 of 6/);
    expect(button("Hint")).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("With help")).toBeNull();
  });

  it("replaces the first verdict with the server's, and says so politely (O-41)", async () => {
    const backend = makeBackend({
      [E21]: async (real) => {
        const body = (await (await real()).json()) as EventsResponse;
        return jsonResponse({ ...body, results: body.results.map((result) => ({ ...result, correct: false })) });
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This spot needs review. The original:")).toBeInTheDocument();
    expect(screen.getByText("The result of this question was updated.")).toBeInTheDocument();
    expect(screen.queryByText("Correct.")).toBeNull();
  });

  it("shows the original of a wrong recall answer at once, read from the learn passage, before the server answers", async () => {
    const gate: { release?: () => void } = {};
    const backend = makeBackend({ [E21]: async (real) => (await new Promise<void>((resolve) => (gate.release = resolve)), real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkUntil(user, "Type the missing word.");
    await user.type(screen.getByRole("textbox"), "خطأ");
    await user.click(button("Check"));
    expect(screen.getByText("This spot needs review. The original:")).toBeInTheDocument();
    expect(screen.getByText("كلمة٥ كلمة٦ كلمة٧")).toBeInTheDocument();
    gate.release?.();
  });

  it("shows the original of a wrong recall answer from the server when the passage does not hold it (a review)", async () => {
    const backend = makeBackend({
      [E20]: async (real) => {
        const snapshot = (await (await real()).json()) as { steps: { type: string; question?: { type: string } }[] };
        return jsonResponse({ ...snapshot, steps: snapshot.steps.filter((step) => step.type !== "learn") }, 201);
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkUntil(user, "Type the missing word.");
    await user.type(screen.getByRole("textbox"), "خطأ");
    await user.click(button("Check"));
    expect(await screen.findByText("كلمة٥ كلمة٦ كلمة٧")).toBeInTheDocument();
  });

  it("checks a recall answer with Enter in the input, and never moves on with Enter once it is checked", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await walkUntil(user, "Type the missing word.");
    await user.type(screen.getByRole("textbox"), `${MOCK_RECALL_WORD}{Enter}`);
    expect(screen.getByText("Correct.")).toBeInTheDocument();
    expect(primary()).toHaveTextContent("Next");
    // Focus went to the button; Enter inside the read-only input must not move on by itself.
    await waitFor(() => expect(primary()).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(stepHeading()).toHaveTextContent("Type the missing word.");
  });

  it("shows the streak line of the passage from the server's answers, for drills only", async () => {
    const user = userEvent.setup();
    renderSession();
    await ready();
    await answerCorrectly(user);
    await user.click(primary() as HTMLElement);
    await user.click(primary() as HTMLElement);
    expect(await screen.findByText("Question 2 of 6 · Correct in a row: 0 of 3")).toBeInTheDocument();
    await answerCorrectly(user);
    await user.click(primary() as HTMLElement);
    expect(await screen.findByText("Question 3 of 6 · Correct in a row: 1 of 3")).toBeInTheDocument();
  });

  it("refreshes the daily bar from E21 `daily` and shows the goal reached", async () => {
    let active = 420_000;
    const backend = makeBackend({
      [E21]: async (real) => {
        const body = (await (await real()).json()) as EventsResponse;
        active += 120_000;
        const daily = { ...body.daily, dailyActiveMs: active, dailyPercent: Math.min(100, Math.floor((active * 100) / 600_000)), dailyCompleted: active >= 600_000, extraActiveMs: Math.max(0, active - 600_000) };
        return jsonResponse({ ...body, daily });
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    const bar = () => screen.getByRole("progressbar", { name: "Daily progress" });
    expect(bar()).toHaveAttribute("aria-valuenow", "70");
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await waitFor(() => expect(bar()).toHaveAttribute("aria-valuenow", "90"));
    expect(screen.queryByText("You reached today's goal")).toBeNull();
    await user.click(primary() as HTMLElement);
    await user.click(primary() as HTMLElement);
    await answerCorrectly(user);
    await waitFor(() => expect(bar()).toHaveAttribute("aria-valuenow", "100"));
    expect(screen.getAllByText("You reached today's goal").length).toBeGreaterThan(0);
    expect(bar()).toHaveAttribute("aria-valuetext", "10 of 10 minutes, 100 percent");
  });
});

describe("S-19 connectivity and the outbox (G-02, P-22)", () => {
  it("lets the learner go on after a failed send, then resends the same event ids and clears the banner", async () => {
    const backend = makeBackend({ [E21]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(screen.getByText("Correct.")).toBeInTheDocument();
    expect(await screen.findByText("The service is temporarily unavailable. Try again shortly.")).toBeInTheDocument();
    // The learner continues with the local verdict.
    await user.click(primary() as HTMLElement);
    expect(await screen.findByRole("heading", { level: 2, name: "New passage" })).toBeInTheDocument();
    await user.click(button("Try again"));
    await waitFor(() => expect(backend.count(E21)).toBe(2));
    await waitFor(() => expect(screen.queryByText("The service is temporarily unavailable. Try again shortly.")).toBeNull());
    const [first, second] = backend.bodies(E21) as { events: SessionEvent[] }[];
    expect(second?.events[0]?.clientEventId).toBe(first?.events[0]?.clientEventId);
  });

  it("shows the offline line of the round when the browser is offline and a send fails, with a retry", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const backend = makeBackend({ [E21]: (real, call) => (call === 1 ? Promise.reject(new TypeError("offline")) : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    expect(screen.getByText("There is no network connection. We will try again automatically, or press “Try again”.")).toBeInTheDocument();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    expect(screen.getByText("Correct.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(backend.count(E21)).toBe(2));
  });

  it("shows a calm line for an event the server did not count, and a plan banner when the plan is no longer active (G-11, G-21)", async () => {
    const backend = makeBackend({
      [E21]: async (real) => {
        const body = (await (await real()).json()) as EventsResponse;
        const [event] = body.acknowledged;
        return jsonResponse({ ...body, acknowledged: [], results: [], rejected: [{ clientEventId: event ?? "", code: "plan_not_active" }] });
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This answer was not counted.")).toBeInTheDocument();
    expect(screen.getByText("This plan is not active.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Back to Today" }).at(-1) as HTMLElement);
    expect(navigation.router.replace).toHaveBeenCalledWith("/today");
  });

  it("shows a pending answer as still being verified, without resending it", async () => {
    const backend = makeBackend({
      [E21]: async (real) => {
        const body = (await (await real()).json()) as EventsResponse;
        const [event] = body.acknowledged;
        return jsonResponse({ ...body, acknowledged: [], results: [], pending: [{ clientEventId: event ?? "", reasonCode: "content_unverifiable" }] });
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This answer is still being verified.")).toBeInTheDocument();
    await user.click(primary() as HTMLElement);
    await user.click(primary() as HTMLElement);
    expect(backend.events().filter((event) => event.type === "answer")).toHaveLength(1);
  });

  it("replaces the text and the questions with the unavailable view when the server ends the session for a revoked edition (G-20)", async () => {
    const backend = makeBackend({
      [E21]: async (real) => {
        const body = (await (await real()).json()) as EventsResponse;
        const [event] = body.acknowledged;
        return jsonResponse({ ...body, acknowledged: [], results: [], rejected: [{ clientEventId: event ?? "", code: "edition_mismatch" }] });
      },
    });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This edition is no longer available. You can start a plan on another edition.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(primary()).toBeNull();
  });

  it("sends the learner to the login when an answer finds the session ended (G-03)", async () => {
    const backend = makeBackend({ [E21]: () => apiError(401, "unauthenticated") });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Ftoday"));
  });
});

describe("S-19 finishing", () => {
  it("flushes the events, then E22, hands the answer over and opens the result (S-20)", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    expect(primary()).toHaveTextContent("Finish the session");
    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}/result`));
    const order = backend.calls.map((call) => call.key).filter((key) => key === E21 || key === E22);
    expect(order[order.length - 1]).toBe(E22);
    expect(backend.count(E22)).toBe(1);
    expect(backend.events().filter((event) => event.type === "answer")).toHaveLength(6);
    const held = peekSessionResult(MOCK_SESSION_ID);
    expect(held?.complete.summary).toMatchObject({ answered: 6, correct: 6, newPassages: 1, reviewsPassed: 1, reviewsFailed: 0 });
  });

  it("keeps the button loading while it finishes, and ignores a second press", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const backend = makeBackend({ [E22]: async (real) => (await gate, real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(primary()).toHaveTextContent("Finishing the session…"));
    expect(primary()).toHaveAttribute("aria-busy", "true");
    await user.click(primary() as HTMLElement);
    release?.();
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledTimes(1));
    expect(backend.count(E22)).toBe(1);
  });

  it("offers Try again on the same button when E22 fails, and repeating it is safe (idempotent)", async () => {
    const backend = makeBackend({ [E22]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    await user.click(primary() as HTMLElement);
    expect(await screen.findByText("The service is temporarily unavailable. Try again shortly.")).toBeInTheDocument();
    await waitFor(() => expect(primary()).toHaveTextContent("Try again"));
    expect(navigation.router.push).not.toHaveBeenCalled();
    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}/result`));
    expect(backend.count(E22)).toBe(2);
  });

  it("does not call E22 while events are still unsent: the failed flush is the failure", async () => {
    const backend = makeBackend({ [E21]: () => apiError(503, "unavailable") });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(primary()).toHaveTextContent("Try again"));
    expect(backend.count(E22)).toBe(0);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });
});

describe("S-19 pause and leave (c19, UA-09)", () => {
  async function openSheet(user: User) {
    await ready();
    await user.click(button("Pause"));
    return screen.findByRole("dialog", { name: "Session paused" });
  }

  it("opens from the pause button and the back control, with Continue the session focused", async () => {
    const user = userEvent.setup();
    renderSession();
    const dialog = await openSheet(user);
    expect(within(dialog).getByText("Paused time does not count. Resume from Today whenever you like.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Continue the session" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Continue the session" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session paused" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Back to Today" }));
    expect(await screen.findByRole("dialog", { name: "Session paused" })).toBeInTheDocument();
  });

  it("opens on Escape and continues on Escape inside it", async () => {
    const user = userEvent.setup();
    renderSession();
    await ready();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("dialog", { name: "Session paused" })).toBeInTheDocument();
    fireEvent(screen.getByRole("dialog", { name: "Session paused" }), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session paused" })).toBeNull());
  });

  it("opens when the browser's back button is used, and puts its own history entry back", async () => {
    renderSession();
    await ready();
    expect(window.history.state).toMatchObject({ qatraSessionGuard: true });
    const length = window.history.length;
    window.history.replaceState({ __NA: true }, "");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { __NA: true } }));
    });
    expect(await screen.findByRole("dialog", { name: "Session paused" })).toBeInTheDocument();
    expect(window.history.state).toMatchObject({ qatraSessionGuard: true });
    expect(window.history.length).toBe(length + 1);
  });

  it("flushes the open activity interval when it opens, so the time stops", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    clock.now += 120_000;
    await user.click(button("Pause"));
    await screen.findByRole("dialog", { name: "Session paused" });
    await waitFor(() => expect(backend.events().filter((event) => event.type === "activity")).toHaveLength(1));
    const activity = backend.events().find((event) => event.type === "activity");
    expect(activity).toMatchObject({ type: "activity", activeMs: 120_000 });
  });

  it("does not count the time while the sheet is open: continuing starts a new interval", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    clock.now += 60_000;
    await user.click(button("Pause"));
    await screen.findByRole("dialog", { name: "Session paused" });
    clock.now += 600_000;
    await user.click(screen.getByRole("button", { name: "Continue the session" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Session paused" })).toBeNull());
    clock.now += 30_000;
    await user.click(button("Pause"));
    await screen.findByRole("dialog", { name: "Session paused" });
    await waitFor(() => expect(backend.events().filter((event) => event.type === "activity")).toHaveLength(2));
    expect(backend.events().filter((event) => event.type === "activity").map((event) => (event.type === "activity" ? event.activeMs : 0))).toEqual([60_000, 30_000]);
  });

  it("flushes an interval when the page is hidden", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const backend = makeBackend();
    renderSession({ backend });
    await ready();
    clock.now += 45_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(backend.events().filter((event) => event.type === "activity")).toHaveLength(1));
    expect(backend.events()[0]).toMatchObject({ type: "activity", activeMs: 45_000 });
  });

  it("leaves to Today after the flush, completes nothing, and resumes at the next step in this tab", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    const first = renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await user.click(button("Pause"));
    const dialog = await screen.findByRole("dialog", { name: "Session paused" });
    await user.click(within(dialog).getByRole("button", { name: "Pause and leave" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count(E22)).toBe(0);
    expect(backend.events().filter((event) => event.type === "answer")).toHaveLength(1);
    first.unmount();

    renderSession({ backend });
    expect(await screen.findByRole("heading", { level: 2, name: "New passage" })).toBeInTheDocument();
    expect(screen.queryByText("We start by reviewing what you memorized.")).toBeNull();
    expect(backend.count(E20)).toBe(2);
  });

  it("says it could not save, offers a retry, and still lets the learner leave", async () => {
    const backend = makeBackend({ [E21]: () => apiError(503, "unavailable") });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await user.click(button("Pause"));
    const dialog = await screen.findByRole("dialog", { name: "Session paused" });
    expect(await within(dialog).findByText("We could not save your latest activity. Try again before you leave.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Pause and leave" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/today");
  });

  it("leaves after a successful retry from the failed state", async () => {
    const backend = makeBackend({ [E21]: (real, call) => (call <= 2 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await user.click(button("Pause"));
    const dialog = await screen.findByRole("dialog", { name: "Session paused" });
    await within(dialog).findByText("We could not save your latest activity. Try again before you leave.");
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
  });
});

describe("S-19 Arabic and English", () => {
  it("is right to left in Arabic with the copy of the spec, and keeps the book text right to left in English", async () => {
    renderSession({ language: "ar" });
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "جلسة الحفظ" })).toBeInTheDocument();
    expect(screen.getByText("نبدأ بمراجعة ما حفظته.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تحقق" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "مراحل الجلسة" })).toBeInTheDocument();
    expect(screen.getByText("سؤال ١ من ٦")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "الإنجاز اليومي" })).toHaveAttribute("aria-valuenow", "70");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("keeps the passage and the question words right to left in the English interface", async () => {
    const user = userEvent.setup();
    renderSession({ language: "en" });
    await ready();
    expect(document.documentElement.dir).toBe("ltr");
    await answerCorrectly(user);
    await user.click(primary() as HTMLElement);
    const text = await screen.findByRole("group", { name: "Passage text" });
    expect(text).toHaveAttribute("dir", "rtl");
    expect(text).toHaveAttribute("lang", "ar");
  });
});
