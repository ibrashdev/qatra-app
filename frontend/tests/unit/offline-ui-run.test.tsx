import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/offline", useRouter: () => navigation.router }));

// The outbox is the real one (fake IndexedDB). Its enqueue is wrapped so a test can hold a write back, to show that no feedback appears before the commit,
// or make it fail, to show that a failed write is never presented as an answer that was recorded.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, fail: false }));
vi.mock("@/lib/offline/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offline/outbox")>();
  return {
    ...actual,
    enqueueEvent: async (...args: Parameters<typeof actual.enqueueEvent>) => {
      if (gate.hold !== null) await gate.hold;
      if (gate.fail) throw new Error("QuotaExceededError");
      return actual.enqueueEvent(...args);
    },
  };
});

import { DurableRunQueue, OfflineGameRun, OfflineSessionRun, type OfflineRunCallbacks } from "@/components/pwa/offline-run";
import { provisionalDaily } from "@/components/pwa/offline-model";
import { clearResumeForTests } from "@/components/session/resume-store";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime } from "@/lib/api/runtime";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { listPendingEvents } from "@/lib/offline/outbox";
import { EnvelopeStamper, isFullEnvelope } from "@/lib/offline/envelope";
import { listRuns } from "@/lib/offline/run-store";
import { installDialogPolyfill } from "./dialog-polyfill";
import { DAILY_SESSION, GAME_SESSION, OWNER_ID, USERNAME, activityAt, makeSnapshot, resetOfflineEnvironment, uuid } from "./offline-support";

const snapshot = makeSnapshot();
const daily = snapshot.preparedSessions[0]!;
const game = snapshot.preparedSessions[1]!;

function callbacks() {
  return {
    onFinished: vi.fn<OfflineRunCallbacks["onFinished"]>(),
    onLeave: vi.fn<OfflineRunCallbacks["onLeave"]>(),
    onSessionEnded: vi.fn<OfflineRunCallbacks["onSessionEnded"]>(),
  };
}

// Every request of the API client is recorded: an offline run must make none (the answers wait in the outbox, nothing is graded by the server).
function renderRun(node: (api: ReturnType<typeof callbacks>) => React.ReactNode, language: "ar" | "en" = "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const api = callbacks();
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{node(api)}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { api, fetchImpl, ...view };
}

const primary = () => document.querySelector<HTMLButtonElement>("[data-session-primary]");
const roundPrimary = () => document.querySelector<HTMLButtonElement>("[data-round-primary]");

beforeEach(async () => {
  resetOfflineEnvironment();
  gate.hold = null;
  gate.fail = false;
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearResumeForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
  window.history.replaceState(null, "", "/");
  // The browser says there is no connection: the runtime sends no first probe, and an offline run must send nothing at all.
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
  // The device holds a ready plan of this owner, as after a download.
  const result = await cacheActivePlan(snapshot, { username: USERNAME });
  expect(result.ready).toBe(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the durable queue of an offline run", () => {
  it("gives each event the full envelope in call order and keeps what the outbox committed", async () => {
    const stored: { sessionId: string; localSequence: number; full: boolean }[] = [];
    const stamper = new EnvelopeStamper(snapshot, uuid(), 0);
    const queue = new DurableRunQueue(OWNER_ID, DAILY_SESSION, stamper, async (_owner, sessionId, event) => {
      stored.push({ sessionId, localSequence: event.localSequence, full: isFullEnvelope(event) });
    });
    await queue.enqueue(activityAt(snapshot, stamper.clientRunId, 0, 0));
    await queue.enqueue(activityAt(snapshot, stamper.clientRunId, 0, 10_000));
    expect(stored).toEqual([
      { sessionId: DAILY_SESSION, localSequence: 0, full: true },
      { sessionId: DAILY_SESSION, localSequence: 1, full: true },
    ]);
    expect(queue.committed).toHaveLength(2);
    expect(queue.size).toBe(0);
    await expect(queue.flush()).resolves.toEqual({ ok: true });
  });

  it("waits for the writes in flight when flushed, and rejects the enqueue (not the flush) when a write fails", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stamper = new EnvelopeStamper(snapshot, uuid(), 0);
    let done = false;
    const queue = new DurableRunQueue(OWNER_ID, DAILY_SESSION, stamper, async () => {
      await blocked;
      done = true;
    });
    void queue.enqueue(activityAt(snapshot, stamper.clientRunId, 0, 0));
    const flushed = queue.flush();
    expect(done).toBe(false);
    release();
    await flushed;
    expect(done).toBe(true);

    const failing = new DurableRunQueue(OWNER_ID, DAILY_SESSION, new EnvelopeStamper(snapshot, uuid(), 0), async () => {
      throw new Error("QuotaExceededError");
    });
    await expect(failing.enqueue(activityAt(snapshot, uuid(), 0, 0))).rejects.toThrow("QuotaExceededError");
    expect(failing.committed).toHaveLength(0);
    await expect(failing.flush()).resolves.toEqual({ ok: true });
  });
});

describe("the daily descriptor in S-19 (offline)", () => {
  const dailyFigures = provisionalDaily("2026-10-06", 600_000, 0);

  it("shows the fixed offline line instead of the retry promise, and starts a run record with a lock", async () => {
    renderRun((api) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={api} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    expect(screen.getByText("Offline. Results are waiting to be verified.")).toBeInTheDocument();
    expect(screen.queryByText(/We will try again automatically/)).toBeNull();
    const runs = await listRuns(OWNER_ID, "active");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ snapshotId: snapshot.snapshotId, sessionId: DAILY_SESSION, kind: "daily" });
  });

  it("commits the enveloped answer to the outbox before it shows the feedback, and sends no request", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const { fetchImpl } = renderRun((api) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={api} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    await user.click(primary() as HTMLElement); // start practice
    await user.click(await screen.findByRole("radio", { name: "alpha" }));

    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.click(screen.getByRole("button", { name: "Check" }));
    // The write is held back: the answer is not recorded, so the screen shows no verdict and keeps the button on Check.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByText("Correct")).toBeNull();
    expect(primary()).toHaveTextContent("Check");
    expect((await listPendingEvents(OWNER_ID)).filter((entry) => entry.event.type === "answer")).toHaveLength(0);

    await act(async () => {
      release();
    });
    await waitFor(() => expect(primary()).toHaveTextContent("Next"));
    const answers = (await listPendingEvents(OWNER_ID)).filter((entry) => entry.event.type === "answer");
    expect(answers).toHaveLength(1);
    const [stored] = answers;
    expect(stored?.sessionId).toBe(DAILY_SESSION);
    expect(stored?.state).toBe("queued");
    expect(stored?.event).toMatchObject({ type: "answer", questionId: "q-choice", answer: { optionId: "q-choice-a" }, snapshotId: snapshot.snapshotId, planVersion: 1, localSequence: expect.any(Number) });
    expect(isFullEnvelope(stored!.event)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shows no verdict and a warning when the write fails, and accepts the answer when the learner tries again", async () => {
    const user = userEvent.setup();
    renderRun((api) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={api} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    await user.click(primary() as HTMLElement);
    await user.click(await screen.findByRole("radio", { name: "alpha" }));
    gate.fail = true;
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/could not be saved on this device/)).toBeInTheDocument();
    expect(primary()).toHaveTextContent("Check");
    expect((await listPendingEvents(OWNER_ID)).filter((entry) => entry.event.type === "answer")).toHaveLength(0);
    gate.fail = false;
    await user.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(primary()).toHaveTextContent("Next"));
    expect((await listPendingEvents(OWNER_ID)).filter((entry) => entry.event.type === "answer")).toHaveLength(1);
  });

  it("ends on the device: the run is closed, the summary is local, and neither E21 nor E22 is called", async () => {
    const user = userEvent.setup();
    const { api, fetchImpl } = renderRun((callbacksOfRun) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={callbacksOfRun} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    await user.click(primary() as HTMLElement);
    await user.click(await screen.findByRole("radio", { name: "alpha" }));
    await user.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(primary()).toHaveTextContent("Next"));
    await user.click(primary() as HTMLElement);
    await user.type(await screen.findByRole("textbox"), "alpha");
    await user.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(primary()).toHaveTextContent("Finish the session"));
    await user.click(primary() as HTMLElement);

    await waitFor(() => expect(api.onFinished).toHaveBeenCalledTimes(1));
    expect(api.onFinished.mock.calls[0]?.[0]).toMatchObject({ answered: 2, correct: 2, total: 2 });
    expect(await listRuns(OWNER_ID, "finished")).toHaveLength(1);
    expect(await listRuns(OWNER_ID, "active")).toHaveLength(0);
    const events = await listPendingEvents(OWNER_ID);
    expect(events.filter((entry) => entry.event.type === "answer")).toHaveLength(2);
    // The recall answer text waits in the outbox until the server has it (Authentication-and-privacy), and nowhere else.
    expect(events.find((entry) => entry.event.type === "answer" && "text" in entry.event.answer)?.event).toMatchObject({ answer: { text: "alpha" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("leaves through the sheet without completing the descriptor: no E22, the run is abandoned, the shell takes over", async () => {
    const user = userEvent.setup();
    const { api, fetchImpl } = renderRun((callbacksOfRun) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={callbacksOfRun} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(await screen.findByRole("button", { name: "Pause and leave" }));
    await waitFor(() => expect(api.onLeave).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await listRuns(OWNER_ID, "abandoned")).toHaveLength(1));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("starts a new run record, with its own run id, each time the descriptor is run again", async () => {
    const first = renderRun((api) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={api} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    first.unmount();
    renderRun((api) => <OfflineSessionRun ownerId={OWNER_ID} snapshot={snapshot} session={daily} daily={dailyFigures} callbacks={api} />);
    await screen.findByRole("heading", { level: 2, name: "New passage" });
    const runs = await listRuns(OWNER_ID);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.clientRunId)).size).toBe(2);
  });
});

describe("a game descriptor in the round screen (offline)", () => {
  it("runs the word order round on the device and ends with a local summary instead of the result screen", async () => {
    const user = userEvent.setup();
    const { api, fetchImpl } = renderRun((callbacksOfRun) => <OfflineGameRun ownerId={OWNER_ID} snapshot={snapshot} session={game} gameType="word_order" callbacks={callbacksOfRun} />);
    await screen.findByRole("heading", { level: 2 });
    expect(screen.getByText("Offline. Results are waiting to be verified.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "zero" }));
    await user.click(screen.getByRole("button", { name: "one" }));
    await user.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(roundPrimary()).toHaveTextContent("Finish the round"));
    await user.click(roundPrimary() as HTMLElement);
    await waitFor(() => expect(api.onFinished).toHaveBeenCalledTimes(1));
    expect(api.onFinished.mock.calls[0]?.[0]).toMatchObject({ answered: 1, correct: 1, total: 1 });
    const answers = (await listPendingEvents(OWNER_ID)).filter((entry) => entry.event.type === "answer");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.sessionId).toBe(GAME_SESSION);
    expect(isFullEnvelope(answers[0]!.event)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a round through the sheet without E22", async () => {
    const user = userEvent.setup();
    const { api, fetchImpl } = renderRun((callbacksOfRun) => <OfflineGameRun ownerId={OWNER_ID} snapshot={snapshot} session={game} gameType="word_order" callbacks={callbacksOfRun} />);
    await screen.findByRole("heading", { level: 2 });
    await user.click(screen.getByRole("button", { name: "Leave the round" }));
    await user.click(await screen.findByRole("button", { name: "End the round and leave" }));
    await waitFor(() => expect(api.onLeave).toHaveBeenCalledTimes(1));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
