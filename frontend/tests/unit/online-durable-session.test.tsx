import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/session/55555555-5555-4555-8555-000000000001", useRouter: () => navigation.router }));

import { clearResumeForTests, rememberResume } from "@/components/session/resume-store";
import { answerEvent } from "@/components/session/session-events";
import { SessionScreen } from "@/components/session/SessionScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { mockHandlers, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { MOCK_QUESTION_IDS, MOCK_RECALL_WORD, sessionMockHandlers } from "@/lib/api/mock/session-handlers";
import { MOCK_SESSION_ID, todayMockHandlers } from "@/lib/api/mock/today-handlers";
import { createApiRuntime } from "@/lib/api/runtime";
import type { SessionEvent } from "@/lib/api/types";
import { clearLoginArrival } from "@/lib/auth/flash";
import { LOCK_MARKER_KEY } from "@/lib/offline/db";
import { logoutLocally } from "@/lib/offline/owner";
import { bindOnlineAccount, listOnlineEvents, readOnlineRun, recordOnlineEvents, requestOnlineCompletion, saveOnlineRun } from "@/lib/offline/online-journal";
import type { OnlineAnswered, OnlineBinding } from "@/lib/offline/types";
import { resetRouteHistoryForTests, noteRoute } from "@/lib/nav/route-history";
import { clearSessionResult, peekSessionResult } from "@/lib/session/result-handoff";
import { installDialogPolyfill } from "./dialog-polyfill";
import { USERNAME, resetOfflineEnvironment } from "./offline-support";

// The online daily session with the online journal behind it (PWA-design 4, offline phase 2): answers are committed to the device before they are counted,
// a reload resumes where it was, and a finish that is owed is sent with the same key until the server confirms it. The server is the mock layer of the app.

const UUID = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
const E21 = "POST /api/sessions/:id/events";
const E22 = "POST /api/sessions/:id/complete";

type Real = () => Promise<Response>;
type Override = (real: Real, call: number) => Response | Promise<Response>;

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, code: string): Response => jsonResponse({ error: { code, message: "m", details: {} } }, status);

function makeBackend(overrides: Record<string, Override> = {}, scenario: Partial<MockScenario> = {}) {
  const mock = createMockFetch({ latencyMs: 0, handlers: { ...mockHandlers, ...todayMockHandlers, ...sessionMockHandlers }, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const calls: { key: string; body: unknown; headers: Headers }[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(UUID, ":id")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) });
    const call = (seen.get(key) ?? 0) + 1;
    seen.set(key, call);
    const override = overrides[key];
    const real: Real = () => mock(input, init);
    return override ? override(real, call) : real();
  });
  const of = (key: string) => calls.filter((entry) => entry.key === key);
  const events = (): SessionEvent[] => of(E21).flatMap((entry) => (entry.body as { events: SessionEvent[] }).events);
  return { fetchImpl, calls, of, count: (key: string) => of(key).length, events, answers: () => events().filter((event) => event.type === "answer") };
}
type Backend = ReturnType<typeof makeBackend>;

function renderSession({ backend = makeBackend(), language = "en" }: { backend?: Backend; language?: "ar" | "en" } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  resetRouteHistoryForTests();
  noteRoute("/today");
  const runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <SessionScreen routeId={MOCK_SESSION_ID} />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, ...view };
}

type User = ReturnType<typeof userEvent.setup>;
const stepHeading = () => document.querySelector<HTMLElement>("[data-step-heading]");
const primary = () => document.querySelector<HTMLButtonElement>("[data-session-primary]");
const ready = () => screen.findByRole("heading", { level: 2 });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const radio = (name: string) => screen.getByRole("radio", { name });

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
    await user.click(screen.queryByText(/^Question 6 of 6/) === null ? radio("كلمة٢") : radio("كلمة٦"));
  } else {
    throw new Error(`No answer is known for the step "${heading}".`);
  }
  await user.click(button("Check"));
  // The feedback comes after the answer is committed to the device, so the button turns into Next a moment later.
  await waitFor(() => expect(primary()).not.toHaveTextContent("Check"));
}

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

const FINISH_PENDING_LINE = "The session is finished on this device. Its result will be confirmed when the connection is back.";
const OFFLINE_LINE = "There is no network connection. We will try again automatically, or press “Try again”.";
const SAVED_ON_DEVICE = "Saved on the device, waiting to sync";
const KEEP_OPEN = "Your answers are kept on this page only until they are sent. Do not reload or close it.";
const STORAGE_PROBLEM = "Saving on this device failed, so your answers are kept on this page only until they are sent.";

let binding: OnlineBinding;
let online = true;

beforeEach(async () => {
  resetOfflineEnvironment();
  localStorage.clear();
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
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
  window.history.replaceState(null, "", "/");
  binding = await bindOnlineAccount(USERNAME);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const events = (backend: Backend) => backend.answers().map((event) => event.clientEventId);
const waitForRun = (check: (run: Awaited<ReturnType<typeof readOnlineRun>>) => boolean) =>
  waitFor(async () => {
    expect(check(await readOnlineRun(binding.accountKey, MOCK_SESSION_ID))).toBe(true);
  });

describe("an online session writes to the device before it counts", () => {
  it("commits the answer to the journal, settles it when the server answers, and records where a reload resumes (never the typed answer)", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    // The server acknowledged it: the journal holds nothing for the session any more.
    await waitFor(async () => expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0));
    // The run state: resume at the learn step after the review answer, with the answer given and what the server said about it.
    await waitForRun((run) => run !== null && run.resumeIndex === 1 && MOCK_QUESTION_IDS.review in run.answered);
    const run = await readOnlineRun(binding.accountKey, MOCK_SESSION_ID);
    expect(run?.answered[MOCK_QUESTION_IDS.review]).toMatchObject({ hintUsed: false, result: { correct: true, assisted: false } });
    expect(run?.planVersion).toBe(1);
    expect(JSON.stringify(run)).not.toMatch(/"answer"|"text"/);
  });

  it("has the answer on the device while the server has not answered yet, and shows the feedback only after the commit", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const backend = makeBackend({ [E21]: async (real) => (await gate, real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    const stored = await listOnlineEvents(binding.accountKey, { sessionId: MOCK_SESSION_ID });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "queued", kind: "daily" });
    expect(stored[0]?.event).toMatchObject({ type: "answer", questionId: MOCK_QUESTION_IDS.review });
    release?.();
    await waitFor(async () => expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0));
  });

  it("keeps the answer in the journal when the send is lost, and settles it with the same id when the resend is answered duplicate", async () => {
    const backend = makeBackend({ [E21]: (real, call) => (call === 1 ? Promise.reject(new TypeError("offline")) : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    const [stored] = await listOnlineEvents(binding.accountKey);
    expect(stored).toBeDefined();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(backend.count(E21)).toBe(2));
    const [first, second] = backend.of(E21).map((entry) => (entry.body as { events: SessionEvent[] }).events[0]?.clientEventId);
    expect(second).toBe(first);
    expect(first).toBe(stored?.clientEventId);
    await waitFor(async () => expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0));
  });
});

describe("what the banners say about the answers while the connection is gone", () => {
  it("says the answers are saved on the device, instead of «kept on this page only», when the journal holds them", async () => {
    online = false;
    renderSession();
    await ready();
    expect(screen.getByText(OFFLINE_LINE)).toBeInTheDocument();
    expect(await screen.findByText(SAVED_ON_DEVICE)).toBeInTheDocument();
    expect(screen.queryByText(KEEP_OPEN)).toBeNull();
    expect(screen.queryByText(STORAGE_PROBLEM)).toBeNull();
  });

  it("says the Arabic fixed line in Arabic", async () => {
    online = false;
    renderSession({ language: "ar" });
    await screen.findByRole("heading", { level: 2 });
    expect(await screen.findByText("محفوظ على الجهاز، بانتظار المزامنة")).toBeInTheDocument();
  });

  it("keeps the page-only line when the account is not known and the server cannot say (memory mode)", async () => {
    resetOfflineEnvironment();
    localStorage.clear();
    online = false;
    renderSession({ backend: makeBackend({ "GET /api/me": () => apiError(401, "unauthenticated") }) });
    await ready();
    expect(screen.getByText(KEEP_OPEN)).toBeInTheDocument();
    expect(screen.queryByText(SAVED_ON_DEVICE)).toBeNull();
    expect(screen.queryByText(STORAGE_PROBLEM)).toBeNull();
  });

  it("says why when the device could not store an answer, keeps the run going, and still sends the answer", async () => {
    const backend = makeBackend();
    const user = userEvent.setup();
    renderSession({ backend });
    await ready();
    // The account was bound at mount; from now on the personal view is locked, so the next write is refused.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    window.localStorage.setItem(LOCK_MARKER_KEY, "1");
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    // The learner is not stopped: the verdict shows and the answer is sent from this page.
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    online = false;
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText(STORAGE_PROBLEM)).toBeInTheDocument();
    expect(screen.getByText(KEEP_OPEN)).toBeInTheDocument();
    expect(screen.queryByText(SAVED_ON_DEVICE)).toBeNull();
  });
});

describe("a session that cannot be loaded because the connection is gone", () => {
  const unreachable = () => makeBackend({ "GET /api/today": () => Promise.reject(new TypeError("offline")) });

  it("says the answers are saved on the device when it holds some of this session, and never «kept on this page only» (nothing is in the page)", async () => {
    await recordOnlineEvents(binding, MOCK_SESSION_ID, "daily", [answerEvent({ questionId: MOCK_QUESTION_IDS.review, answer: { optionId: "opt-a" }, hintUsed: false, occurredAtMs: Date.parse("2026-10-05T07:00:10Z"), durationMs: 2000 })]);
    online = false;
    renderSession({ backend: unreachable() });
    expect(await screen.findByText(OFFLINE_LINE)).toBeInTheDocument();
    expect(screen.getByText(SAVED_ON_DEVICE)).toBeInTheDocument();
    expect(screen.queryByText(KEEP_OPEN)).toBeNull();
  });

  it("says only that there is no connection when the device holds nothing of it", async () => {
    online = false;
    renderSession({ backend: unreachable() });
    expect(await screen.findByText(OFFLINE_LINE)).toBeInTheDocument();
    expect(screen.queryByText(SAVED_ON_DEVICE)).toBeNull();
    expect(screen.queryByText(KEEP_OPEN)).toBeNull();
  });
});

describe("after a reload", () => {
  async function leaveSessionOnTheDevice(): Promise<string> {
    const answer = answerEvent({ questionId: MOCK_QUESTION_IDS.review, answer: { optionId: "opt-a" }, hintUsed: false, occurredAtMs: Date.parse("2026-10-05T07:00:10Z"), durationMs: 2000 });
    await recordOnlineEvents(binding, MOCK_SESSION_ID, "daily", [answer]);
    const answered: Record<string, OnlineAnswered> = {
      [MOCK_QUESTION_IDS.review]: { clientEventId: answer.clientEventId, hintUsed: false, result: { correct: true, assisted: false, expected: { optionId: "opt-a" } } },
    };
    await saveOnlineRun(binding, MOCK_SESSION_ID, "daily", { resumeIndex: 1, answered, planId: "44444444-4444-4444-8444-000000000001", planVersion: 1 });
    return answer.clientEventId;
  }

  it("resumes at the step after the last one finished, says nothing about starting again, and sends the unsent answer once with its own id", async () => {
    const id = await leaveSessionOnTheDevice();
    const backend = makeBackend();
    renderSession({ backend });
    expect(await screen.findByRole("heading", { level: 2, name: "New passage" })).toBeInTheDocument();
    expect(screen.queryByText("We start from the beginning; your earlier answers are saved.")).toBeNull();
    expect(screen.queryByText("We start by reviewing what you memorized.")).toBeNull();
    await waitFor(() => expect(backend.count(E21)).toBeGreaterThanOrEqual(1));
    expect(events(backend)).toEqual([id]);
    await waitFor(async () => expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0));
    // The run goes on from there: the next answers are new events, and the restored one is never sent twice.
    const user = userEvent.setup();
    await user.click(primary() as HTMLElement);
    await answerCorrectly(user);
    await waitFor(() => expect(events(backend)).toHaveLength(2));
    expect(new Set(events(backend)).size).toBe(2);
    // The answer given before the reload is still part of the run: the saved state holds both, with the restored one under its original event id.
    await waitForRun((run) => run !== null && Object.keys(run.answered).length === 2);
    const run = await readOnlineRun(binding.accountKey, MOCK_SESSION_ID);
    expect(run?.answered[MOCK_QUESTION_IDS.review]?.clientEventId).toBe(id);
  });

  it("prefers the journal's step to the position this tab remembers", async () => {
    await leaveSessionOnTheDevice();
    rememberResume(MOCK_SESSION_ID, 4);
    renderSession();
    expect(await screen.findByRole("heading", { level: 2, name: "New passage" })).toBeInTheDocument();
  });

  it("still starts at the first step, with the usual line, when the journal has nothing for the session", async () => {
    renderSession();
    await ready();
    expect(screen.getByText("We start by reviewing what you memorized.")).toBeInTheDocument();
  });

  it("does not take another account's journal: its events are never sent and its run is not restored", async () => {
    await leaveSessionOnTheDevice();
    // The first learner signs out, the device is wiped, and another learner signs in and is recorded.
    expect((await logoutLocally({ serverLogoutDone: true })).discardedEvents).toBe(1);
    await bindOnlineAccount("another.learner");
    const backend = makeBackend();
    renderSession({ backend });
    await ready();
    expect(screen.getByText("We start by reviewing what you memorized.")).toBeInTheDocument();
    expect(backend.count(E21)).toBe(0);
  });
});

describe("the finish that is owed", () => {
  it("records the finish before it sends, shows the provisional line when the server is out, retries with the identical key, and opens the confirmed result only after E22 answers", async () => {
    const backend = makeBackend({ [E22]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    await user.click(primary() as HTMLElement);
    expect(await screen.findByText(FINISH_PENDING_LINE)).toBeInTheDocument();
    // Not the plain failure, and no result yet.
    expect(screen.queryByText("The service is temporarily unavailable. Try again shortly.")).toBeNull();
    expect(navigation.router.push).not.toHaveBeenCalled();
    expect(peekSessionResult(MOCK_SESSION_ID)).toBeNull();
    await waitFor(() => expect(primary()).toHaveTextContent("Try again"));
    const run = await readOnlineRun(binding.accountKey, MOCK_SESSION_ID);
    expect(run?.completion).toMatchObject({ state: "pending" });
    const key = run?.completion?.idempotencyKey ?? "";
    expect(backend.of(E22)[0]?.headers.get("Idempotency-Key")).toBe(key);

    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}/result`));
    expect(backend.count(E22)).toBe(2);
    expect(backend.of(E22)[1]?.headers.get("Idempotency-Key")).toBe(key);
    expect(peekSessionResult(MOCK_SESSION_ID)?.complete.summary).toMatchObject({ answered: 6, correct: 6 });
    // The server holds it now: nothing is owed and no run record is left.
    expect(await readOnlineRun(binding.accountKey, MOCK_SESSION_ID)).toBeNull();
  });

  it("retries the finish by itself, with the same key, when the connection comes back", async () => {
    const backend = makeBackend({ [E22]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    await user.click(primary() as HTMLElement);
    expect(await screen.findByText(FINISH_PENDING_LINE)).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}/result`));
    const [first, second] = backend.of(E22).map((entry) => entry.headers.get("Idempotency-Key"));
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("shows the plain failure for anything that is not the connection's or the free server's own (a throttle)", async () => {
    const backend = makeBackend({ [E22]: () => apiError(429, "throttled") });
    const user = userEvent.setup();
    renderSession({ backend });
    await walkToTheEnd(user);
    await user.click(primary() as HTMLElement);
    await waitFor(() => expect(primary()).toHaveTextContent("Try again"));
    expect(screen.queryByText(FINISH_PENDING_LINE)).toBeNull();
  });

  it("sends a finish that was owed when the page was closed at once after a reload, with the stored key, then opens the result", async () => {
    // The learner answered everything, pressed finish, and the page went away before E22 answered.
    const storedKey = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const answered: Record<string, OnlineAnswered> = Object.fromEntries(
      Object.values(MOCK_QUESTION_IDS).map((questionId, position) => [
        questionId,
        { clientEventId: `bbbbbbbb-0000-4000-8000-00000000000${position}`, hintUsed: false, result: { correct: true, assisted: false, expected: {} } },
      ]),
    );
    await saveOnlineRun(binding, MOCK_SESSION_ID, "daily", { resumeIndex: 6, answered, planVersion: 1 });
    await requestOnlineCompletion(binding, MOCK_SESSION_ID, "daily", storedKey);
    const backend = makeBackend();
    renderSession({ backend });
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(`/session/${MOCK_SESSION_ID}/result`));
    expect(backend.count(E22)).toBe(1);
    expect(backend.of(E22)[0]?.headers.get("Idempotency-Key")).toBe(storedKey);
    expect(await readOnlineRun(binding.accountKey, MOCK_SESSION_ID)).toBeNull();
  });

  it("leaves the run record alone and drops what is owed when the server already shows the session as completed", async () => {
    await requestOnlineCompletion(binding, MOCK_SESSION_ID, "daily", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    const backend = makeBackend({
      "POST /api/sessions": async (real) => {
        const answer = await real();
        const body = (await answer.json()) as Record<string, unknown>;
        return jsonResponse({ ...body, status: "completed" }, answer.status);
      },
    });
    renderSession({ backend });
    await ready();
    await waitFor(async () => expect(await readOnlineRun(binding.accountKey, MOCK_SESSION_ID)).toBeNull());
    // The screen behaves as it always did for a snapshot it is given: nothing finished by itself.
    expect(backend.count(E22)).toBe(0);
  });
});
